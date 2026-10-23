import { describeError, translateText } from '../shared/api';
import { SESSION_KEY, getTargetInstruction } from '../shared/constants';
import { createId, getActiveProfile, loadSettings, updateSettings } from '../shared/settings';
import {
  MIME_TYPES,
  buildExportFilename,
  buildSubtitleFile,
  countExportableSegments,
} from '../shared/subtitles';
import type {
  BackgroundRequest,
  CaptionSegment,
  ContentEvent,
  ExportOptions,
  ExportResponse,
  OffscreenEvent,
  OffscreenRequest,
  OffscreenResponse,
  SessionSnapshot,
  SessionStatus,
  SessionView,
  StartCaptureResponse,
  StateResponse,
  TranslationJob,
} from '../shared/types';

const OFFSCREEN_URL = 'offscreen.html';
const MAX_SEGMENTS = 5000;
const HANDLED_TYPES = new Set<string>([
  'START_CAPTURE',
  'STOP_CAPTURE',
  'GET_STATE',
  'CONTENT_READY',
  'VIDEO_ANCHOR',
  'STOP_SESSION',
  'EXPORT',
  'SET_ACTIVE_PROFILE',
  'OPEN_OPTIONS',
  'CAPTURE_STARTED',
  'CAPTURE_ENDED',
  'ASR_STATUS',
  'ASR_ERROR',
  'ASR_SEGMENT',
]);

let session: SessionSnapshot | null = null;
let hydrated = false;
let hydrateTask: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let jobs: TranslationJob[] = [];
let pumping = false;
let currentAbort: AbortController | null = null;
let startGeneration = 0;
let lastStatusPersistAt = 0;
let lastStatusPhase = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeStatus(raw: unknown): SessionStatus {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<SessionStatus>;
  const valid = [
    'idle',
    'starting',
    'loading-model',
    'listening',
    'transcribing',
    'error',
  ];
  return {
    phase: valid.includes(value.phase || '') ? (value.phase as SessionStatus['phase']) : 'idle',
    message: typeof value.message === 'string' ? value.message : '',
    progress:
      typeof value.progress === 'number' && Number.isFinite(value.progress)
        ? Math.min(100, Math.max(0, value.progress))
        : undefined,
  };
}

function normalizeStoredSession(raw: unknown): SessionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<SessionSnapshot> & { segments?: unknown };
  const tabId = Number(value.tabId);
  if (!Number.isFinite(tabId) || tabId < 0) return null;
  const segments: CaptionSegment[] = Array.isArray(value.segments)
    ? value.segments
        .filter((item): item is CaptionSegment => !!item && typeof item === 'object')
        .map((item) => {
          const seg = item as Partial<CaptionSegment>;
          const start = Math.max(0, Number(seg.start) || 0);
          return {
            id: typeof seg.id === 'string' ? seg.id : createId('seg'),
            start,
            end: Math.max(start + 0.4, Number(seg.end) || start + 1),
            original: typeof seg.original === 'string' ? seg.original : '',
            translation: typeof seg.translation === 'string' ? seg.translation : '',
            status: ['pending', 'translating', 'done', 'error'].includes(seg.status || '')
              ? (seg.status as CaptionSegment['status'])
              : 'done',
            error: typeof seg.error === 'string' ? seg.error : undefined,
          };
        })
    : [];
  return {
    tabId,
    startedAt: Number(value.startedAt) || Date.now(),
    active: !!value.active,
    title: typeof value.title === 'string' ? value.title : '未命名页面',
    baseTime: Math.max(0, Number(value.baseTime) || 0),
    baseTimeSet: !!value.baseTimeSet,
    status: normalizeStatus(value.status),
    segments,
    asrEngine: value.asrEngine === 'remote' ? 'remote' : 'local',
  };
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (hydrateTask) return hydrateTask;
  hydrateTask = (async () => {
    try {
      const stored = await chrome.storage.session.get(SESSION_KEY);
      session = normalizeStoredSession(stored[SESSION_KEY]);
    } catch {
      session = null;
    }
    hydrated = true;
    if (!session) return;
    let changed = false;
    if (session.active && !(await offscreenExists())) {
      session.active = false;
      session.status = { phase: 'idle', message: '上一次音频捕获已结束' };
      changed = true;
    }
    for (const segment of session.segments) {
      if (segment.status === 'pending' || segment.status === 'translating') {
        segment.status = 'error';
        segment.error = segment.error || '后台休眠导致翻译中断';
        changed = true;
      }
    }
    if (changed) persistSession();
  })().finally(() => {
    hydrateTask = null;
  });
  return hydrateTask;
}

async function getSession(): Promise<SessionSnapshot | null> {
  await hydrate();
  return session;
}

function persistSession(): Promise<void> {
  if (!session) return writeQueue;
  const snapshot = structuredClone(session);
  writeQueue = writeQueue
    .then(() => chrome.storage.session.set({ [SESSION_KEY]: snapshot }))
    .catch((error) => console.warn('[Transub] 保存会话失败', error));
  return writeQueue;
}

function toSessionView(snapshot: SessionSnapshot): SessionView {
  const copy = structuredClone(snapshot);
  const latestSegment = copy.segments.length
    ? copy.segments[copy.segments.length - 1]
    : null;
  return {
    ...copy,
    segments: copy.segments.slice(-3),
    segmentCount: copy.segments.length,
    latestSegment,
  };
}

function sendToTab(tabId: number, message: ContentEvent): void {
  chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

function notifyCaption(tabId: number, segment: CaptionSegment): void {
  sendToTab(tabId, { type: 'CAPTION', segment: structuredClone(segment) });
}

function setStatus(status: SessionStatus, forcePersist = false): void {
  if (!session) return;
  session.status = status;
  sendToTab(session.tabId, {
    type: 'SESSION_STATUS',
    status,
    active: session.active,
  });
  const now = Date.now();
  const phaseChanged = status.phase !== lastStatusPhase;
  lastStatusPhase = status.phase;
  if (forcePersist || phaseChanged || now - lastStatusPersistAt > 2500) {
    lastStatusPersistAt = now;
    persistSession();
  }
}

async function setBadge(tabId: number, text: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0f7b6c' });
      await chrome.action.setTitle({ tabId, title: 'Transub 正在生成双语字幕' });
    } else {
      await chrome.action.setTitle({ tabId, title: 'Transub 译流' });
    }
  } catch {
    // badge is cosmetic
  }
}

async function offscreenExists(): Promise<boolean> {
  try {
    if (typeof chrome.runtime.getContexts === 'function') {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
      });
      return contexts.length > 0;
    }
  } catch {
    // fall through to hasDocument
  }
  try {
    return await chrome.offscreen.hasDocument();
  } catch {
    return false;
  }
}

async function ensureOffscreen(): Promise<void> {
  if (!(await offscreenExists())) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [
          chrome.offscreen.Reason.USER_MEDIA,
          chrome.offscreen.Reason.AUDIO_PLAYBACK,
        ],
        justification:
          '捕获当前标签页音频用于本地或用户自有接口的语音识别，并保持标签页声音正常播放',
      });
    } catch (error) {
      if (!(await offscreenExists())) throw error;
    }
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = (await chrome.runtime.sendMessage({
        to: 'offscreen',
        type: 'PING',
      })) as { ok?: boolean } | undefined;
      if (response?.ok) return;
    } catch {
      // offscreen page still loading
    }
    await sleep(120);
  }
  throw new Error('音频处理模块启动超时，请重试');
}

async function closeOffscreen(): Promise<void> {
  try {
    if (await offscreenExists()) await chrome.offscreen.closeDocument();
  } catch {
    // already closed
  }
}

async function sendOffscreen(
  message: OffscreenRequest,
  timeoutMs = 20_000,
): Promise<OffscreenResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(message) as Promise<OffscreenResponse | undefined>,
      new Promise<OffscreenResponse>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('音频处理模块响应超时')),
          timeoutMs,
        );
      }),
    ]);
    return response || { ok: false, error: '音频处理模块没有响应' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function matchSession(message: { tabId: number; sessionId: number }): boolean {
  return (
    !!session &&
    session.tabId === message.tabId &&
    session.startedAt === message.sessionId
  );
}

async function getFreshSession(): Promise<SessionSnapshot | null> {
  const current = await getSession();
  if (current?.active) {
    const alive = await offscreenExists();
    if (!alive) {
      current.active = false;
      current.status = { phase: 'idle', message: '音频捕获已结束' };
      persistSession();
    }
  }
  return current;
}

async function startCapture(tabId: number): Promise<StartCaptureResponse> {
  if (!Number.isFinite(tabId) || tabId < 0) {
    return { ok: false, error: '找不到当前标签页' };
  }
  const settings = await loadSettings();
  if (settings.translation.enabled) {
    const profile = getActiveProfile(settings);
    if (!profile || !profile.baseUrl.trim() || !profile.model.trim()) {
      return {
        ok: false,
        error: '请先在设置中完善 AI 翻译配置（Base URL 与模型名称）',
      };
    }
  }
  if (
    settings.asr.engine === 'remote' &&
    (!settings.asr.remoteBaseUrl.trim() || !settings.asr.remoteModel.trim())
  ) {
    return { ok: false, error: '请先完善远程 ASR 的 Base URL 与模型名称' };
  }

  const existing = await getSession();
  if (existing?.active) {
    await stopSession();
  } else {
    await sendOffscreen({ to: 'offscreen', type: 'STOP_CAPTURE' }, 3000).catch(() => undefined);
    await closeOffscreen();
  }

  currentAbort?.abort();
  currentAbort = null;
  jobs = [];
  const generation = ++startGeneration;

  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) return { ok: false, error: '找不到当前标签页' };
  const url = tab.url || '';
  if (
    /^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com\//i.test(url)
  ) {
    return {
      ok: false,
      error: '浏览器内置页面或扩展商店页面不允许注入字幕层，请换一个普通网页',
    };
  }

  const startedAt = Date.now();
  const newSession: SessionSnapshot = {
    tabId,
    startedAt,
    active: false,
    title: tab.title || '未命名页面',
    baseTime: 0,
    baseTimeSet: false,
    status: { phase: 'starting', message: '正在准备音频捕获…' },
    segments: [],
    asrEngine: settings.asr.engine,
  };
  session = newSession;
  hydrated = true;
  lastStatusPhase = 'starting';
  lastStatusPersistAt = Date.now();
  persistSession();

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch {
    const message = '无法在此页面注入字幕层，请刷新页面后重试或更换普通网页';
    if (session === newSession) {
      newSession.status = { phase: 'error', message };
      persistSession();
    }
    return { ok: false, error: message };
  }

  try {
    await ensureOffscreen();
    if (generation !== startGeneration) {
      return { ok: false, error: '启动已取消' };
    }
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });
    if (generation !== startGeneration) {
      return { ok: false, error: '启动已取消' };
    }
    const response = await sendOffscreen({
      to: 'offscreen',
      type: 'START_CAPTURE',
      tabId,
      sessionId: startedAt,
      streamId,
      asr: settings.asr,
    });
    if (!response.ok) throw new Error(response.error || '音频捕获启动失败');
    if (generation !== startGeneration || session !== newSession) {
      return { ok: false, error: '启动已取消' };
    }

    newSession.active = true;
    if (newSession.status.phase === 'starting') {
      newSession.status = {
        phase: 'listening',
        message:
          settings.asr.engine === 'local'
            ? '已捕获音频，本地模型准备中…'
            : '正在聆听…',
      };
    }
    persistSession();
    await setBadge(tabId, 'CC');
    sendToTab(tabId, {
      type: 'SESSION_STARTED',
      status: newSession.status,
      active: true,
    });
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    const isCurrent = generation === startGeneration && session === newSession;
    if (isCurrent) {
      newSession.active = false;
      newSession.status = { phase: 'error', message };
      persistSession();
      await setBadge(tabId, '');
      sendToTab(tabId, {
        type: 'SESSION_STATUS',
        status: newSession.status,
        active: false,
      });
      sendToTab(tabId, { type: 'SESSION_STOPPED' });
      await sendOffscreen({ to: 'offscreen', type: 'STOP_CAPTURE' }, 3000).catch(() => undefined);
      await closeOffscreen();
    }
    return { ok: false, error: message };
  }
}

async function stopSession(options: { preserveStatus?: boolean } = {}): Promise<void> {
  startGeneration++;
  currentAbort?.abort();
  currentAbort = null;
  jobs = [];

  await sendOffscreen({ to: 'offscreen', type: 'STOP_CAPTURE' }, 5000).catch(() => undefined);
  await closeOffscreen();

  if (!session) return;
  session.active = false;
  if (!options.preserveStatus) {
    session.status = { phase: 'idle', message: '已停止' };
  }
  persistSession();
  const tabId = session.tabId;
  await setBadge(tabId, '');
  sendToTab(tabId, {
    type: 'SESSION_STATUS',
    status: session.status,
    active: false,
  });
  sendToTab(tabId, { type: 'SESSION_STOPPED' });
}

async function handleAsrStatus(
  message: Extract<OffscreenEvent, { type: 'ASR_STATUS' }>,
): Promise<void> {
  if (!matchSession(message)) return;
  setStatus(message.status);
}

async function handleAsrError(
  message: Extract<OffscreenEvent, { type: 'ASR_ERROR' }>,
): Promise<void> {
  if (!matchSession(message)) return;
  if (message.fatal) {
    setStatus({ phase: 'error', message: message.message }, true);
    await stopSession({ preserveStatus: true });
    return;
  }
  if (session) {
    setStatus({ phase: 'listening', message: `识别失败：${message.message}` });
  }
}

async function handleAsrSegment(
  message: Extract<OffscreenEvent, { type: 'ASR_SEGMENT' }>,
): Promise<void> {
  if (!matchSession(message)) return;
  if (!session?.active) return;
  const text = message.text.trim();
  if (!text) return;

  const start = Math.max(0, message.startMs / 1000);
  const end = Math.max(start + 0.4, message.endMs / 1000);
  const previous = session.segments[session.segments.length - 1];
  if (previous && previous.original === text && start - previous.end < 2.5) {
    return;
  }

  const settings = await loadSettings();
  if (!session?.active || !matchSession(message)) return;

  const segment: CaptionSegment = {
    id: createId('seg'),
    start,
    end,
    original: text,
    translation: '',
    status: settings.translation.enabled ? 'pending' : 'done',
  };
  session.segments.push(segment);
  if (session.segments.length > MAX_SEGMENTS) {
    session.segments.splice(0, session.segments.length - MAX_SEGMENTS);
  }
  persistSession();
  notifyCaption(session.tabId, segment);

  if (settings.translation.enabled) {
    jobs.push({
      sessionStartedAt: session.startedAt,
      segmentId: segment.id,
      text,
    });
    void pumpTranslations();
  }
}

async function pumpTranslations(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (jobs.length) {
      const job = jobs[0];
      const current = await getSession();
      if (!current || current.startedAt !== job.sessionStartedAt || !current.active) {
        jobs.shift();
        continue;
      }
      const segment = current.segments.find((item) => item.id === job.segmentId);
      if (!segment) {
        jobs.shift();
        continue;
      }
      if (segment.status === 'error' || segment.status === 'done') {
        jobs.shift();
        continue;
      }

      const settings = await loadSettings();
      if (!settings.translation.enabled) {
        segment.status = 'done';
        notifyCaption(current.tabId, segment);
        persistSession();
        jobs.shift();
        continue;
      }
      const profile = getActiveProfile(settings);
      if (!profile) {
        segment.status = 'error';
        segment.error = '没有可用的 AI 配置';
        notifyCaption(current.tabId, segment);
        persistSession();
        jobs.shift();
        continue;
      }

      const context = current.segments
        .filter(
          (item) =>
            item.id !== segment.id &&
            item.status === 'done' &&
            item.translation.trim(),
        )
        .slice(-4)
        .map(({ original, translation }) => ({ original, translation }));
      const target = getTargetInstruction(
        settings.translation.targetLanguage,
        settings.translation.customTarget,
      );

      segment.status = 'translating';
      delete segment.error;
      notifyCaption(current.tabId, segment);
      persistSession();

      const controller = new AbortController();
      currentAbort = controller;
      let lastUiPush = 0;
      try {
        const translated = await translateText({
          profile,
          text: job.text,
          targetInstruction: target.instruction,
          context,
          signal: controller.signal,
          onText: (textSoFar) => {
            if (!session || session.startedAt !== job.sessionStartedAt) return;
            const live = session.segments.find((item) => item.id === job.segmentId);
            if (!live) return;
            live.translation = textSoFar;
            const now = Date.now();
            if (now - lastUiPush > 120) {
              lastUiPush = now;
              notifyCaption(session.tabId, live);
            }
          },
        });

        if (session && session.startedAt === job.sessionStartedAt) {
          const live = session.segments.find((item) => item.id === job.segmentId);
          if (live) {
            live.translation = translated;
            live.status = 'done';
            delete live.error;
            notifyCaption(session.tabId, live);
            persistSession();
          }
        }
      } catch (error) {
        if (session && session.startedAt === job.sessionStartedAt) {
          const live = session.segments.find((item) => item.id === job.segmentId);
          if (live) {
            live.status = 'error';
            live.error = controller.signal.aborted
              ? '已停止'
              : describeError(error);
            notifyCaption(session.tabId, live);
            persistSession();
            if (!controller.signal.aborted && session.active) {
              setStatus({
                phase: 'listening',
                message: `翻译失败：${live.error}`,
              });
            }
          }
        }
      } finally {
        if (currentAbort === controller) currentAbort = null;
      }
      jobs.shift();
      if (!session?.active) jobs = [];
    }
  } finally {
    pumping = false;
    if (jobs.length && session?.active) void pumpTranslations();
  }
}

async function handleCaptureEnded(
  message: Extract<OffscreenEvent, { type: 'CAPTURE_ENDED' }>,
): Promise<void> {
  if (!matchSession(message)) return;
  currentAbort?.abort();
  currentAbort = null;
  jobs = [];
  if (!session) return;
  session.active = false;
  session.status = {
    phase: 'idle',
    message: message.reason || '音频捕获已结束',
  };
  persistSession();
  await setBadge(session.tabId, '');
  await closeOffscreen();
  sendToTab(session.tabId, {
    type: 'SESSION_STATUS',
    status: session.status,
    active: false,
  });
  sendToTab(session.tabId, { type: 'SESSION_STOPPED' });
}

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function handleExport(
  options: ExportOptions,
  tabId: number,
): Promise<ExportResponse> {
  const current = await getSession();
  if (!current) return { ok: false, error: '还没有任何字幕记录' };
  if (tabId >= 0 && current.tabId !== tabId) {
    return { ok: false, error: '当前标签页没有字幕记录' };
  }
  if (!['srt', 'vtt', 'txt'].includes(options.format)) {
    return { ok: false, error: '不支持的导出格式' };
  }
  if (!['bilingual', 'original', 'translation'].includes(options.content)) {
    return { ok: false, error: '不支持的导出内容' };
  }
  const count = countExportableSegments(current.segments, options.content);
  if (count === 0) {
    return {
      ok: false,
      error:
        options.content === 'translation'
          ? '暂无可导出的译文（可能还在翻译中）'
          : options.content === 'original'
            ? '暂无可导出的原文'
            : '暂无可导出的字幕',
    };
  }

  const text = buildSubtitleFile(current.segments, {
    format: options.format,
    content: options.content,
    timestamps: !!options.timestamps,
    baseTime: current.baseTimeSet ? current.baseTime : 0,
  });
  if (!text.trim()) return { ok: false, error: '字幕内容为空' };

  const filename = buildExportFilename(current.title, options.format);
  const mime = MIME_TYPES[options.format];
  const dataUrl = `data:${mime};charset=utf-8;base64,${toBase64Utf8(text)}`;
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: true,
      conflictAction: 'uniquify',
    });
  } catch (error) {
    return { ok: false, error: `创建下载失败：${describeError(error)}` };
  }
  return { ok: true, filename };
}

async function handleGetState(tabId: number): Promise<StateResponse> {
  const current = await getFreshSession();
  const settings = await loadSettings();
  return {
    session: current ? toSessionView(current) : null,
    isCurrentTab: !!current && current.tabId === tabId,
    tabId,
    profileNames: settings.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
    })),
    activeProfileId: settings.activeProfileId,
  };
}

async function handleMessage(
  message: BackgroundRequest | OffscreenEvent,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.type) {
    case 'START_CAPTURE':
      return startCapture(Number((message as { tabId?: number }).tabId));

    case 'STOP_CAPTURE': {
      const current = await getSession();
      if (current) {
        const requestedTab = (message as { tabId?: number }).tabId;
        if (requestedTab != null && requestedTab !== current.tabId) {
          return { ok: false, error: '当前标签页没有正在运行的会话' };
        }
        await stopSession();
      }
      return { ok: true };
    }

    case 'STOP_SESSION': {
      const current = await getSession();
      if (current && sender.tab?.id === current.tabId) await stopSession();
      return { ok: true };
    }

    case 'GET_STATE':
    case 'CONTENT_READY': {
      const requested = (message as { tabId?: number }).tabId;
      const tabId = Number(requested ?? sender.tab?.id ?? -1);
      return handleGetState(Number.isFinite(tabId) ? tabId : -1);
    }

    case 'VIDEO_ANCHOR': {
      const current = await getSession();
      if (!current || !current.active || sender.tab?.id !== current.tabId) {
        return { ok: false };
      }
      const videoTime = Number((message as { videoTime?: number }).videoTime);
      if (!current.baseTimeSet && Number.isFinite(videoTime) && videoTime >= 0) {
        current.baseTime = videoTime;
        current.baseTimeSet = true;
        persistSession();
      }
      return { ok: true };
    }

    case 'EXPORT': {
      const requested = Number(
        (message as { tabId?: number }).tabId ?? sender.tab?.id ?? -1,
      );
      return handleExport(
        (message as { options: ExportOptions }).options,
        Number.isFinite(requested) ? requested : -1,
      );
    }

    case 'SET_ACTIVE_PROFILE': {
      const profileId = (message as { profileId?: string }).profileId;
      const settings = await updateSettings((next) => {
        if (profileId && next.profiles.some((profile) => profile.id === profileId)) {
          next.activeProfileId = profileId;
        }
      });
      return { ok: true, activeProfileId: settings.activeProfileId };
    }

    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    case 'CAPTURE_STARTED': {
      if (!matchSession(message)) return { ok: false };
      if (session) {
        setStatus({
          phase: 'listening',
          message:
            session.asrEngine === 'local'
              ? '已捕获音频，正在准备本地模型…'
              : '已捕获音频，正在聆听…',
        });
      }
      return { ok: true };
    }

    case 'CAPTURE_ENDED':
      await handleCaptureEnded(message);
      return { ok: true };

    case 'ASR_STATUS':
      await handleAsrStatus(message);
      return { ok: true };

    case 'ASR_ERROR':
      await handleAsrError(message);
      return { ok: true };

    case 'ASR_SEGMENT':
      await handleAsrSegment(message);
      return { ok: true };

    default:
      return { ok: false, error: '未知消息' };
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; to?: string },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (!message || typeof message !== 'object') return;
    if (message.to) return;
    if (!message.type || !HANDLED_TYPES.has(message.type)) return;
    void handleMessage(message as BackgroundRequest | OffscreenEvent, sender)
      .then((response) => sendResponse(response))
      .catch((error) =>
        sendResponse({ ok: false, error: describeError(error) }),
      );
    return true;
  },
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void (async () => {
    const current = await getSession();
    if (!current?.active || current.tabId !== tabId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      sendToTab(tabId, {
        type: 'SESSION_STARTED',
        status: current.status,
        active: true,
      });
    } catch {
      // navigation to a restricted page
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const current = await getSession();
    if (!current || current.tabId !== tabId || !current.active) return;
    await handleCaptureEnded({
      type: 'CAPTURE_ENDED',
      tabId,
      sessionId: current.startedAt,
      reason: '标签页已关闭',
    });
  })();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.runtime.openOptionsPage();
  }
});
