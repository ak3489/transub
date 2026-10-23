import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../shared/api';
import { formatClock } from '../shared/subtitles';
import type {
  ExportContent,
  ExportFormat,
  ExportResponse,
  SessionStatus,
  StartCaptureResponse,
  StateResponse,
} from '../shared/types';
import { Logo } from '../ui/brand';
import {
  CheckIcon,
  DownloadIcon,
  InfoIcon,
  PlayIcon,
  SettingsIcon,
  SparkIcon,
  StopIcon,
} from '../ui/icons';

type Tone = 'live' | 'busy' | 'error' | 'idle';

const RESTRICTED_PATTERN =
  /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension|opera):/i;
const WEBSTORE_PATTERN = /^https:\/\/chromewebstore\.google\.com\//i;

const CONTENT_OPTIONS: Array<{ value: ExportContent; label: string }> = [
  { value: 'bilingual', label: '双语字幕' },
  { value: 'translation', label: '仅译文' },
  { value: 'original', label: '仅原文' },
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function statusPresentation(status: SessionStatus): { label: string; tone: Tone } {
  let tone: Tone = 'idle';
  if (status.phase === 'error') tone = 'error';
  else if (status.phase === 'listening') tone = 'live';
  else if (
    status.phase === 'starting' ||
    status.phase === 'loading-model' ||
    status.phase === 'transcribing'
  ) {
    tone = 'busy';
  }

  let label = '聆听中';
  if (status.phase === 'loading-model') {
    label =
      typeof status.progress === 'number' && status.progress > 0
        ? `模型加载 ${Math.round(status.progress)}%`
        : '加载本地模型…';
  } else if (status.phase === 'starting') {
    label = '正在准备音频…';
  } else if (status.phase === 'transcribing') {
    label = '识别中…';
  } else if (status.phase === 'error') {
    label = status.message || '出错了';
  } else if (status.phase === 'idle') {
    label = status.message || '未运行';
  } else if (/失败|丢弃|中断|积压/.test(status.message)) {
    label = status.message;
  }
  return { label, tone };
}

export default function App() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [state, setState] = useState<StateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [format, setFormat] = useState<ExportFormat>('srt');
  const [content, setContent] = useState<ExportContent>('bilingual');
  const [timestamps, setTimestamps] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportDone, setExportDone] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const exportTimerRef = useRef<number | null>(null);

  const session = state?.session ?? null;
  const isCurrentTab = !!state?.isCurrentTab;
  const activeHere = !!session?.active && isCurrentTab;

  const refresh = useCallback(async (tabId?: number) => {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'GET_STATE',
        tabId,
      })) as StateResponse | undefined;
      if (response) setState(response);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!alive) return;
        setTab(activeTab ?? null);
        await refresh(activeTab?.id);
      } catch (err) {
        if (!alive) return;
        setError(describeError(err));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
      if (exportTimerRef.current) window.clearTimeout(exportTimerRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (!tab || tab.id == null) return;
    const timer = window.setInterval(() => {
      void refresh(tab.id);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [tab, refresh]);

  useEffect(() => {
    if (!session?.active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [session?.active]);

  const restricted = (() => {
    const url = tab?.url || '';
    if (!url) return false;
    return RESTRICTED_PATTERN.test(url) || WEBSTORE_PATTERN.test(url);
  })();

  const handleStart = async () => {
    if (!tab || tab.id == null || restricted) return;
    setBusy(true);
    setError('');
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'START_CAPTURE',
        tabId: tab.id,
      })) as StartCaptureResponse | undefined;
      if (!response?.ok) {
        setError(response?.error || '启动失败，请重试');
      }
      await refresh(tab.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const stopSession = async (tabId: number) => {
    setBusy(true);
    setError('');
    try {
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', tabId });
      await refresh(tab?.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleProfileChange = async (profileId: string) => {
    setState((prev) => (prev ? { ...prev, activeProfileId: profileId } : prev));
    try {
      await chrome.runtime.sendMessage({
        type: 'SET_ACTIVE_PROFILE',
        profileId,
      });
    } catch (err) {
      setError(describeError(err));
    }
  };

  const handleExport = async () => {
    if (!session) return;
    setExporting(true);
    setExportDone('');
    setError('');
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'EXPORT',
        tabId: session.tabId,
        options: { format, content, timestamps },
      })) as ExportResponse | undefined;
      if (!response?.ok) {
        setError(response?.error || '导出失败');
        return;
      }
      setExportDone(response.filename ? `已生成 ${response.filename}` : '已开始下载');
      if (exportTimerRef.current) window.clearTimeout(exportTimerRef.current);
      exportTimerRef.current = window.setTimeout(() => setExportDone(''), 6000);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setExporting(false);
    }
  };

  const openOptions = () => {
    void chrome.runtime.openOptionsPage();
  };

  const title = tab?.title || '当前标签页';
  const host = hostOf(tab?.url || '');
  const pageLabel = host || (tab?.url?.startsWith('file:') ? '本地文件' : '当前页面');
  const initial = Array.from(title.trim())[0]?.toUpperCase() || 'T';

  const activeSessionPresentation = session
    ? statusPresentation(session.status)
    : null;
  const displayStatus = isCurrentTab
    ? activeSessionPresentation
    : session?.active
      ? activeSessionPresentation
      : activeSessionPresentation;

  const statusLabel = displayStatus
    ? displayStatus.label
    : '播放视频后点击开始';
  const statusTone = session
    ? displayStatus?.tone ?? 'idle'
    : ('idle' as Tone);

  const pillLabel = activeHere
    ? '运行中'
    : session?.active
      ? '其他页面'
      : session?.status.phase === 'error'
        ? '异常'
        : '未运行';
  const pillTone: Tone = activeHere
    ? statusTone
    : session?.status.phase === 'error'
      ? 'error'
      : 'idle';

  const elapsedMs = activeHere && session ? now - session.startedAt : 0;
  const elapsed = elapsedMs > 0 ? formatClock(elapsedMs / 1000) : null;
  const segmentCount = session && isCurrentTab ? session.segmentCount : 0;
  const latest = session && isCurrentTab ? session.latestSegment : null;

  let translationLine = '';
  let translationTone = '';
  if (latest) {
    const translation = latest.translation.trim();
    if (translation) {
      translationLine = translation;
    } else if (latest.status === 'error') {
      translationLine = latest.error ? `翻译失败：${latest.error}` : '翻译失败';
      translationTone = 'error';
    } else if (latest.status === 'pending' || latest.status === 'translating') {
      translationLine = '翻译中…';
      translationTone = 'pending';
    }
  }

  const canExport = !!session && isCurrentTab && segmentCount > 0;
  const runningElsewhere = !!session?.active && !isCurrentTab;

  return (
    <div className="popup-shell">
      <header className="popup-head">
        <div className="pop-brand">
          <Logo size={26} />
          <span className="pop-brand-name">
            Transub <em>译流</em>
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="打开设置"
          title="打开设置"
          onClick={openOptions}
        >
          <SettingsIcon size={16} />
        </button>
      </header>

      {state && state.profileNames.length > 0 ? (
        <div className="profile-row">
          <span className="row-label">
            <SparkIcon size={13} />
            翻译引擎
          </span>
          <select
            className="profile-select"
            value={state.activeProfileId}
            aria-label="选择 AI 翻译配置"
            onChange={(event) => void handleProfileChange(event.target.value)}
          >
            {state.profileNames.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {error ? (
        <div className="pop-error">
          <InfoIcon size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      {loading && !state ? (
        <div className="pop-loading">
          <span className="spinner" />
          正在读取当前页面状态…
        </div>
      ) : (
        <>
          <section className="card player-card">
            <div className="player-head">
              <span className="site-tile">{initial}</span>
              <div className="player-copy">
                <h2 className="player-title" title={title}>
                  {title}
                </h2>
                <p className="player-host">{pageLabel}</p>
              </div>
              <span className={`live-pill ${pillTone}`}>{pillLabel}</span>
            </div>

            <div className="status-row">
              <span className={`status-dot ${session?.active ? statusTone : 'idle'}`} />
              <span className="status-text" title={statusLabel}>
                {statusLabel}
              </span>
              {session?.active ? (
                <span className="status-meta">
                  {elapsed ? <span>{elapsed}</span> : null}
                  {segmentCount > 0 ? <span>{segmentCount} 条</span> : null}
                </span>
              ) : segmentCount > 0 ? (
                <span className="status-meta">
                  <span>{segmentCount} 条</span>
                </span>
              ) : null}
            </div>

            {runningElsewhere ? (
              <div className="notice">
                <InfoIcon size={14} />
                <span>
                  另一标签页正在生成字幕：
                  <strong>{session?.title || '未命名页面'}</strong>
                </span>
                <button
                  type="button"
                  className="notice-action"
                  disabled={busy}
                  onClick={() => {
                    if (session) void stopSession(session.tabId);
                  }}
                >
                  停止
                </button>
              </div>
            ) : null}

            {activeHere ? (
              <button
                type="button"
                className="action-btn stop"
                disabled={busy}
                onClick={() => {
                  if (session) void stopSession(session.tabId);
                }}
              >
                {busy ? <span className="spinner" /> : <StopIcon size={16} />}
                {busy ? '正在停止…' : '停止字幕'}
              </button>
            ) : (
              <button
                type="button"
                className="action-btn start"
                disabled={busy || restricted || !tab || tab.id == null}
                onClick={() => void handleStart()}
              >
                {busy ? <span className="spinner" /> : <PlayIcon size={16} />}
                {busy
                  ? '正在启动…'
                  : restricted
                    ? '此页面不支持字幕'
                    : runningElsewhere
                      ? '停止并在此页开始'
                      : '开始双语字幕'}
              </button>
            )}

            {restricted ? (
              <p className="action-hint">
                浏览器内置页面与扩展商店页面无法捕获音频，请切换到普通网页或本地视频。
              </p>
            ) : null}
          </section>

          {latest ? (
            <section className="card caption-card">
              <div className="card-topline">
                <span>最新字幕</span>
                <span>{sessionCountLabel(session?.segmentCount ?? 0)}</span>
              </div>
              <p className="cap-original">{latest.original || '（空白）'}</p>
              {translationLine ? (
                <p className={`cap-translation ${translationTone}`}>
                  {translationLine}
                </p>
              ) : null}
            </section>
          ) : null}

          {!session ? (
            <section className="onboard">
              <div className="onboard-title">
                <SparkIcon size={14} />
                为这个视频生成双语字幕
              </div>
              <p>
                播放视频后点击上方按钮。扩展会捕获当前标签页的声音，自动识别并翻译，字幕会叠加在播放器上方。
              </p>
              <div className="onboard-steps">
                <span>
                  <b>1</b> 播放视频
                </span>
                <span>
                  <b>2</b> 开始字幕
                </span>
                <span>
                  <b>3</b> 导出记录
                </span>
              </div>
            </section>
          ) : null}

          {canExport ? (
            <section className="card export-card">
              <div className="card-topline">
                <span>导出字幕</span>
                <span>SRT · VTT · TXT</span>
              </div>

              <div className="export-row">
                <div className="seg" role="group" aria-label="导出格式">
                  {(['srt', 'vtt', 'txt'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={format === item ? 'on' : ''}
                      aria-pressed={format === item}
                      onClick={() => setFormat(item)}
                    >
                      {item.toUpperCase()}
                    </button>
                  ))}
                </div>
                <select
                  className="select"
                  value={content}
                  aria-label="导出内容"
                  onChange={(event) => setContent(event.target.value as ExportContent)}
                >
                  {CONTENT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <label className={`check-row ${format !== 'txt' ? 'disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={timestamps}
                  disabled={format !== 'txt'}
                  onChange={(event) => setTimestamps(event.target.checked)}
                />
                在 TXT 中包含时间戳
              </label>

              <button
                type="button"
                className="btn primary export-btn"
                disabled={exporting}
                onClick={() => void handleExport()}
              >
                {exporting ? <span className="spinner" /> : <DownloadIcon size={15} />}
                {exporting ? '正在导出…' : `导出 ${format.toUpperCase()}`}
              </button>

              {exportDone ? (
                <div className="export-done">
                  <CheckIcon size={13} />
                  <span>{exportDone}</span>
                </div>
              ) : (
                <p className="export-note">
                  SRT / VTT 会自动写入时间轴，并按视频播放进度对齐。
                </p>
              )}
            </section>
          ) : null}
        </>
      )}

      <footer className="pop-foot">
        <p>本地优先 · 所有配置仅保存在本机</p>
        <button type="button" className="link-btn" onClick={openOptions}>
          全部设置 →
        </button>
      </footer>
    </div>
  );
}

function sessionCountLabel(count: number): string {
  return count > 0 ? `${count} 条字幕` : '暂无字幕';
}
