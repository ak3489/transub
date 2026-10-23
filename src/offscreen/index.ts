import { describeError, transcribeRemoteAudio } from '../shared/api';
import type {
  AsrSettings,
  OffscreenEvent,
  OffscreenRequest,
  OffscreenResponse,
  SessionStatus,
} from '../shared/types';
import { TabAudioCapture, encodeWav, resampleLinear } from './audio-capture';
import { LocalWhisper } from './local-asr';

interface AudioJob {
  pcm: Float32Array;
  startMs: number;
  endMs: number;
}

const MAX_QUEUE = 6;

let active = false;
let fatal = false;
let stopping = false;
let tabId: number | null = null;
let sessionId: number | null = null;
let asrConfig: AsrSettings | null = null;
let capture: TabAudioCapture | null = null;
let whisper: LocalWhisper | null = null;
let queue: AudioJob[] = [];
let draining = false;
let lastErrorAt = 0;
let lastStatusSignature = '';
let lastStatusAt = 0;

function post(event: OffscreenEvent): void {
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

function emitStatus(status: SessionStatus, force = false): void {
  if (tabId == null || sessionId == null) return;
  const now = Date.now();
  const signature = `${status.phase}|${status.message}|${Math.round(status.progress ?? -1)}`;
  if (!force && (signature === lastStatusSignature || now - lastStatusAt < 350)) return;
  lastStatusSignature = signature;
  lastStatusAt = now;
  post({ type: 'ASR_STATUS', tabId, sessionId, status });
}

function normalizeTranscript(text: string): string {
  return text
    .replace(/\[\s*(blank[_\s]audio|music|applause|silence|inaudible)\s*\]/gi, ' ')
    .replace(/\(\s*(music|applause|laughter|silence)\s*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function prepareModel(): Promise<void> {
  if (!active || !asrConfig || asrConfig.engine !== 'local') return;
  if (!whisper) whisper = new LocalWhisper();
  emitStatus(
    {
      phase: 'loading-model',
      message: '正在加载本地 Whisper 模型（首次使用需下载）…',
      progress: 0,
    },
    true,
  );
  try {
    await whisper.ensureLoaded(asrConfig, (progress, message) => {
      if (!active) return;
      emitStatus({
        phase: 'loading-model',
        message,
        progress: typeof progress === 'number' ? Math.round(progress) : undefined,
      });
    });
    if (!active) return;
    emitStatus(
      { phase: 'listening', message: `本地识别就绪 · ${whisper.device}` },
      true,
    );
    void drainQueue();
  } catch (error) {
    if (!active) return;
    fatal = true;
    const message = `本地模型加载失败：${describeError(error)}。可在设置中切换模型镜像，或改用远程 ASR。`;
    emitStatus({ phase: 'error', message }, true);
    if (tabId != null && sessionId != null) {
      post({ type: 'ASR_ERROR', tabId, sessionId, message, fatal: true });
    }
  }
}

function enqueue(chunk: {
  pcm: Float32Array;
  startMs: number;
  endMs: number;
  sampleRate: number;
}): void {
  if (!active || fatal) return;
  const pcm = resampleLinear(chunk.pcm, chunk.sampleRate, 16000);
  if (pcm.length < 1600) return;
  queue.push({ pcm, startMs: chunk.startMs, endMs: chunk.endMs });
  if (queue.length > MAX_QUEUE) {
    queue.splice(0, queue.length - MAX_QUEUE);
    emitStatus(
      { phase: 'listening', message: '识别速度跟不上，已丢弃较早的音频' },
      true,
    );
  }
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (active && !fatal && queue.length && asrConfig) {
      const job = queue.shift();
      if (!job) break;

      if (asrConfig.engine === 'local') {
        if (!whisper) whisper = new LocalWhisper();
        try {
          await whisper.ensureLoaded(asrConfig, (progress, message) => {
            if (!active) return;
            emitStatus({
              phase: 'loading-model',
              message,
              progress:
                typeof progress === 'number' ? Math.round(progress) : undefined,
            });
          });
        } catch (error) {
          if (!active) return;
          fatal = true;
          const message = `本地模型加载失败：${describeError(error)}。可在设置中切换模型镜像，或改用远程 ASR。`;
          emitStatus({ phase: 'error', message }, true);
          if (tabId != null && sessionId != null) {
            post({ type: 'ASR_ERROR', tabId, sessionId, message, fatal: true });
          }
          return;
        }
      }

      emitStatus({ phase: 'transcribing', message: '识别中…' }, queue.length === 0);

      let text = '';
      try {
        if (asrConfig.engine === 'local') {
          text = await whisper!.transcribe(job.pcm, asrConfig.language);
        } else {
          const wav = encodeWav(job.pcm, 16000);
          text = await transcribeRemoteAudio(asrConfig, wav);
        }
      } catch (error) {
        const now = Date.now();
        if (now - lastErrorAt > 4000 && tabId != null && sessionId != null) {
          lastErrorAt = now;
          post({
            type: 'ASR_ERROR',
            tabId,
            sessionId,
            message: describeError(error),
            fatal: false,
          });
        }
        emitStatus({ phase: 'listening', message: '识别失败，继续聆听…' }, true);
        continue;
      }

      if (!active) return;
      const cleaned = normalizeTranscript(text);
      if (cleaned && tabId != null && sessionId != null) {
        post({
          type: 'ASR_SEGMENT',
          tabId,
          sessionId,
          text: cleaned,
          startMs: job.startMs,
          endMs: job.endMs,
          language: asrConfig.language,
        });
      }
      if (!queue.length) {
        emitStatus({ phase: 'listening', message: '正在聆听…' }, true);
      }
    }
  } finally {
    draining = false;
    if (active && !fatal && queue.length) void drainQueue();
  }
}

async function startCapture(
  message: Extract<OffscreenRequest, { type: 'START_CAPTURE' }>,
): Promise<void> {
  if (active || capture) await stopCapture();

  fatal = false;
  stopping = false;
  tabId = message.tabId;
  sessionId = message.sessionId;
  asrConfig = message.asr;
  whisper = null;
  queue = [];
  active = true;

  emitStatus({ phase: 'starting', message: '正在连接标签页音频…' }, true);
  const cap = new TabAudioCapture();
  try {
    await cap.start(message.streamId, {
      onChunk: enqueue,
      onEnded: (reason) => {
        if (stopping) return;
        active = false;
        if (tabId != null && sessionId != null) {
          post({ type: 'CAPTURE_ENDED', tabId, sessionId, reason });
        }
      },
    });
    capture = cap;
    if (tabId != null && sessionId != null) {
      post({ type: 'CAPTURE_STARTED', tabId, sessionId });
    }
    if (asrConfig.engine === 'local') {
      void prepareModel();
    } else {
      emitStatus({ phase: 'listening', message: '正在聆听…' }, true);
    }
  } catch (error) {
    active = false;
    capture = null;
    await cap.stop().catch(() => undefined);
    throw error;
  }
}

async function stopCapture(): Promise<void> {
  stopping = true;
  active = false;
  fatal = false;
  queue = [];
  const cap = capture;
  capture = null;
  if (cap) await cap.stop().catch(() => undefined);
  tabId = null;
  sessionId = null;
  asrConfig = null;
  whisper = null;
  stopping = false;
}

chrome.runtime.onMessage.addListener(
  (
    message: OffscreenRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: OffscreenResponse | { ok: boolean }) => void,
  ) => {
    if (!message || (message as { to?: string }).to !== 'offscreen') return;
    if (message.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'START_CAPTURE') {
      startCapture(message)
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({ ok: false, error: describeError(error) }),
        );
      return true;
    }
    if (message.type === 'STOP_CAPTURE') {
      stopCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: describeError(error) }));
      return true;
    }
  },
);

window.addEventListener('pagehide', () => {
  void stopCapture();
});
