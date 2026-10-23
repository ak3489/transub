import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, patchOverlay } from '../shared/settings';
import type {
  AppSettings,
  CaptionSegment,
  ContentEvent,
  OverlaySettings,
  SessionStatus,
  StateResponse,
} from '../shared/types';

declare global {
  interface Window {
    __transubLoaded?: boolean;
  }
}

const HOST_ID = 'transub-dual-subtitle-host';

const SHADOW_STYLE = `
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; }
  .stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    font-family: var(--font-family);
    pointer-events: none;
    opacity: 1;
    transition: opacity .22s ease;
  }
  .stage.is-hidden { display: none; }
  .bar {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 5px;
    max-width: min(92vw, 540px);
    padding: 3px 7px 3px 5px;
    border-radius: 999px;
    background: rgba(9, 15, 13, .58);
    border: 1px solid rgba(255, 255, 255, .12);
    color: rgba(240, 247, 244, .72);
    font-size: 11px;
    line-height: 1;
    box-shadow: 0 6px 18px rgba(0, 0, 0, .22);
    backdrop-filter: blur(12px) saturate(1.15);
    -webkit-backdrop-filter: blur(12px) saturate(1.15);
    opacity: .5;
    transition: opacity .18s ease, background .18s ease;
    user-select: none;
    cursor: grab;
    touch-action: none;
  }
  .stage:hover .bar, .bar:focus-within, .bar.dragging { opacity: 1; }
  .bar.dragging { cursor: grabbing; background: rgba(9, 15, 13, .8); }
  .grip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 22px;
    border-radius: 6px;
    color: rgba(255, 255, 255, .45);
    cursor: grab;
    font-size: 13px;
    line-height: 1;
    letter-spacing: -1px;
    flex: 0 0 auto;
    outline: none;
  }
  .grip:hover { color: rgba(255, 255, 255, .85); background: rgba(255,255,255,.08); }
  .grip:focus-visible { outline: 2px solid #8de8d3; outline-offset: 1px; }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    max-width: 280px;
    height: 22px;
    flex: 0 1 auto;
  }
  .status-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: .01em;
  }
  .dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #6f7b76;
  }
  .dot[data-phase="live"] {
    background: #8de8d3;
    box-shadow: 0 0 0 0 rgba(141, 232, 211, .55);
    animation: pulse 2s ease-out infinite;
  }
  .dot[data-phase="busy"] {
    background: #f4c66b;
    animation: blink 1.1s ease-in-out infinite;
  }
  .dot[data-phase="error"] { background: #f0857b; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(141, 232, 211, .45); }
    70% { box-shadow: 0 0 0 6px rgba(141, 232, 211, 0); }
    100% { box-shadow: 0 0 0 0 rgba(141, 232, 211, 0); }
  }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .28; } }
  .spacer { flex: 1 1 0; min-width: 2px; }
  .mini {
    appearance: none;
    border: 0;
    background: transparent;
    color: rgba(240, 247, 244, .6);
    width: 24px;
    height: 22px;
    border-radius: 6px;
    font-family: inherit;
    font-size: 11px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    transition: background .15s ease, color .15s ease;
    flex: 0 0 auto;
  }
  .mini:hover { background: rgba(255, 255, 255, .12); color: #fff; }
  .mini:focus-visible { outline: 2px solid #8de8d3; outline-offset: 1px; }
  .mini.close:hover { background: rgba(240, 133, 123, .2); color: #ffd7d2; }
  .caps {
    max-width: var(--max-width);
    padding: 10px 18px 11px;
    border-radius: 14px;
    background: var(--bg-color);
    border: 1px solid rgba(255, 255, 255, .11);
    box-shadow: 0 12px 38px rgba(0, 0, 0, .26);
    backdrop-filter: blur(14px) saturate(1.08);
    -webkit-backdrop-filter: blur(14px) saturate(1.08);
    text-align: center;
    pointer-events: none;
    opacity: 1;
    transform: translateY(0);
    transition: opacity .25s ease, transform .25s ease;
  }
  .caps.is-hidden { opacity: 0; transform: translateY(4px); }
  .caps.no-lines { display: none; }
  .original {
    color: var(--orig-color);
    font-size: var(--orig-size);
    line-height: 1.36;
    font-weight: 640;
    letter-spacing: .005em;
    text-shadow: 0 1px 2px rgba(0, 0, 0, .42);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .translation {
    margin-top: 2px;
    color: var(--trans-color);
    font-size: var(--trans-size);
    line-height: 1.36;
    font-weight: 560;
    letter-spacing: .005em;
    text-shadow: 0 1px 2px rgba(0, 0, 0, .42);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .original.is-hidden, .translation.is-hidden { display: none; }
  .translation.placeholder { opacity: .55; font-weight: 480; }
  .translation.warning { color: #ffc9a8; opacity: .9; font-size: calc(var(--trans-size) * .82); }
  @media (max-width: 600px) {
    .bar { font-size: 10px; }
    .status { max-width: 150px; }
  }
`;

function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace('#', '').trim();
  let r = 8;
  let g = 19;
  let b = 16;
  if (/^[0-9a-f]{3}$/i.test(cleaned)) {
    r = parseInt(cleaned[0] + cleaned[0], 16);
    g = parseInt(cleaned[1] + cleaned[1], 16);
    b = parseInt(cleaned[2] + cleaned[2], 16);
  } else if (/^[0-9a-f]{6}$/i.test(cleaned)) {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function phaseDot(phase: SessionStatus['phase']): 'live' | 'busy' | 'error' | 'idle' {
  if (phase === 'listening') return 'live';
  if (phase === 'transcribing' || phase === 'loading-model' || phase === 'starting') {
    return 'busy';
  }
  if (phase === 'error') return 'error';
  return 'idle';
}

function statusLabel(status: SessionStatus): string {
  if (status.phase === 'loading-model') {
    return typeof status.progress === 'number' && status.progress > 0
      ? `模型加载 ${Math.round(status.progress)}%`
      : '加载本地模型…';
  }
  if (status.phase === 'starting') return '连接音频…';
  if (status.phase === 'transcribing') return '识别中…';
  if (status.phase === 'error') return status.message || '出错了';
  if (status.phase === 'idle') return status.message || '已停止';
  if (/失败|丢弃|中断|积压/.test(status.message)) return status.message;
  return '聆听中';
}

class SubtitleOverlay {
  private host: HTMLElement;
  private stage: HTMLElement;
  private bar: HTMLElement;
  private statusText: HTMLElement;
  private dot: HTMLElement;
  private caps: HTMLElement;
  private originalEl: HTMLElement;
  private translationEl: HTMLElement;
  private overlay: OverlaySettings;
  private active = false;
  private status: SessionStatus = { phase: 'idle', message: '' };
  private current: CaptionSegment | null = null;
  private hideTimer: number | null = null;
  private hideForStopTimer: number | null = null;
  private drag:
    | { startX: number; startY: number; x: number; y: number; pointerId: number }
    | null = null;
  private wheelSaveTimer: number | null = null;

  constructor(settings: AppSettings) {
    this.overlay = { ...settings.overlay };
    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.host.style.cssText = [
      'position: fixed',
      'z-index: 2147483646',
      'pointer-events: none',
      'width: max-content',
      'max-width: 96vw',
      'transform: translate(-50%, -50%)',
      'display: block',
      'margin: 0',
      'padding: 0',
      'background: transparent',
      'border: 0',
    ].join(';');

    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHADOW_STYLE;
    shadow.appendChild(style);

    this.stage = document.createElement('div');
    this.stage.className = 'stage is-hidden';
    this.stage.innerHTML = `
      <div class="bar" part="bar" title="拖动移动字幕 · Shift + 滚轮调整字号">
        <div class="grip" role="button" tabindex="0" aria-label="拖动字幕位置">⠿</div>
        <span class="status"><span class="dot" data-phase="idle"></span><span class="status-text">聆听中</span></span>
        <span class="spacer"></span>
        <button type="button" class="mini" data-act="smaller" aria-label="减小字号" title="减小字号">A−</button>
        <button type="button" class="mini" data-act="larger" aria-label="增大字号" title="增大字号">A+</button>
        <button type="button" class="mini" data-act="settings" aria-label="打开字幕设置" title="字幕设置">⚙</button>
        <button type="button" class="mini close" data-act="stop" aria-label="停止字幕" title="停止字幕">✕</button>
      </div>
      <div class="caps" aria-live="polite">
        <div class="original"></div>
        <div class="translation"></div>
      </div>
    `;
    shadow.appendChild(this.stage);

    this.bar = this.require('.bar');
    this.statusText = this.require('.status-text');
    this.dot = this.require('.dot');
    this.caps = this.require('.caps');
    this.originalEl = this.require('.original');
    this.translationEl = this.require('.translation');
    this.caps.classList.add('no-lines');

    this.bindEvents();
    this.applyOverlayStyle(this.overlay);
    this.attachToPage();
    document.addEventListener('fullscreenchange', this.handleFullscreenChange);
  }

  private require<T extends Element = HTMLElement>(selector: string): T {
    const element = this.stage.querySelector(selector);
    if (!element) throw new Error(`缺少字幕节点 ${selector}`);
    return element as T;
  }

  private attachToPage(): void {
    this.ensureAttached();
  }

  keepAttached(): void {
    if (this.active) this.ensureAttached();
  }

  private desiredParent(): Element {
    const fullscreen = document.fullscreenElement;
    if (fullscreen && fullscreen.tagName !== 'VIDEO' && fullscreen !== this.host) {
      return fullscreen;
    }
    return document.body || document.documentElement;
  }

  private ensureAttached(): void {
    if (!this.host.isConnected) {
      try {
        this.desiredParent().appendChild(this.host);
      } catch {
        document.documentElement.appendChild(this.host);
      }
      return;
    }
    const parent = this.desiredParent();
    if (this.host.parentElement !== parent && !parent.contains(this.host)) {
      try {
        parent.appendChild(this.host);
      } catch {
        // fullscreen container may reject moves; keep current parent
      }
    }
  }

  private handleFullscreenChange = (): void => {
    this.ensureAttached();
  };

  private bindEvents(): void {
    this.bar.addEventListener('pointerdown', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('button') || event.button !== 0) return;
      event.preventDefault();
      this.drag = {
        startX: event.clientX,
        startY: event.clientY,
        x: this.overlay.positionX,
        y: this.overlay.positionY,
        pointerId: event.pointerId,
      };
      this.bar.classList.add('dragging');
      try {
        this.bar.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    });

    this.bar.addEventListener('pointermove', (event) => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      const dx = ((event.clientX - this.drag.startX) / window.innerWidth) * 100;
      const dy = ((event.clientY - this.drag.startY) / window.innerHeight) * 100;
      this.overlay.positionX = clamp(this.drag.x + dx, 3, 97);
      this.overlay.positionY = clamp(this.drag.y + dy, 5, 95);
      this.applyPosition();
    });

    const finishDrag = (event: PointerEvent) => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      this.drag = null;
      this.bar.classList.remove('dragging');
      try {
        this.bar.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      void patchOverlay({
        positionX: this.overlay.positionX,
        positionY: this.overlay.positionY,
      }).catch(() => undefined);
    };
    this.bar.addEventListener('pointerup', finishDrag);
    this.bar.addEventListener('pointercancel', finishDrag);

    this.bar.addEventListener(
      'wheel',
      (event) => {
        if (!event.shiftKey) return;
        event.preventDefault();
        const delta = event.deltaY > 0 ? -1 : 1;
        this.overlay.originalSize = clamp(this.overlay.originalSize + delta, 12, 64);
        this.overlay.translationSize = clamp(
          this.overlay.translationSize + delta,
          10,
          64,
        );
        this.applyOverlayStyle(this.overlay);
        if (this.wheelSaveTimer) window.clearTimeout(this.wheelSaveTimer);
        this.wheelSaveTimer = window.setTimeout(() => {
          void patchOverlay({
            originalSize: this.overlay.originalSize,
            translationSize: this.overlay.translationSize,
          }).catch(() => undefined);
        }, 320);
      },
      { passive: false },
    );

    this.stage.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        'button[data-act]',
      );
      if (!button) return;
      const action = button.dataset.act;
      if (action === 'smaller' || action === 'larger') {
        const delta = action === 'larger' ? 2 : -2;
        this.overlay.originalSize = clamp(this.overlay.originalSize + delta, 12, 64);
        this.overlay.translationSize = clamp(
          this.overlay.translationSize + delta,
          10,
          64,
        );
        this.applyOverlayStyle(this.overlay);
        void patchOverlay({
          originalSize: this.overlay.originalSize,
          translationSize: this.overlay.translationSize,
        }).catch(() => undefined);
      } else if (action === 'settings') {
        void chrome.runtime
          .sendMessage({ type: 'OPEN_OPTIONS' })
          .catch(() => undefined);
      } else if (action === 'stop') {
        this.setStatus({ phase: 'idle', message: '正在停止…' });
        void chrome.runtime
          .sendMessage({ type: 'STOP_SESSION' })
          .catch(() => undefined);
      }
    });

    const grip = this.require('.grip');
    grip.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      const step = (event as KeyboardEvent).shiftKey ? 5 : 1;
      let dx = 0;
      let dy = 0;
      if (key === 'ArrowLeft') dx = -step;
      else if (key === 'ArrowRight') dx = step;
      else if (key === 'ArrowUp') dy = -step;
      else if (key === 'ArrowDown') dy = step;
      else return;
      event.preventDefault();
      this.overlay.positionX = clamp(this.overlay.positionX + dx, 3, 97);
      this.overlay.positionY = clamp(this.overlay.positionY + dy, 5, 95);
      this.applyPosition();
      void patchOverlay({
        positionX: this.overlay.positionX,
        positionY: this.overlay.positionY,
      }).catch(() => undefined);
    });
  }

  private applyPosition(): void {
    this.host.style.left = `${this.overlay.positionX}%`;
    this.host.style.top = `${this.overlay.positionY}%`;
  }

  applyOverlayStyle(overlay: OverlaySettings): void {
    this.overlay = { ...overlay };
    this.applyPosition();
    const style = this.stage.style;
    style.setProperty('--font-family', overlay.fontFamily);
    style.setProperty('--orig-size', `${overlay.originalSize}px`);
    style.setProperty('--trans-size', `${overlay.translationSize}px`);
    style.setProperty('--orig-color', overlay.originalColor);
    style.setProperty('--trans-color', overlay.translationColor);
    style.setProperty(
      '--bg-color',
      hexToRgba(overlay.background, overlay.backgroundOpacity),
    );
    style.setProperty('--max-width', `${clamp(overlay.maxWidth, 30, 98)}vw`);
    this.renderCurrent();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) {
      this.ensureAttached();
      this.stage.classList.remove('is-hidden');
      if (this.hideForStopTimer) {
        window.clearTimeout(this.hideForStopTimer);
        this.hideForStopTimer = null;
      }
    }
  }

  setStatus(status: SessionStatus): void {
    this.status = status;
    this.statusText.textContent = statusLabel(status);
    this.bar.title = status.message || '';
    this.dot.dataset.phase = phaseDot(status.phase);
    if (status.phase === 'error' && !this.active) {
      this.stage.classList.remove('is-hidden');
    }
  }

  showSegment(segment: CaptionSegment): void {
    if (
      this.current &&
      this.current.id !== segment.id &&
      segment.start < this.current.start - 0.01
    ) {
      return;
    }
    this.current = { ...segment };
    this.stage.classList.remove('is-hidden');
    this.renderCurrent();
    this.scheduleHide();
  }

  restoreSegment(segment: CaptionSegment | null): void {
    if (!segment) return;
    this.current = { ...segment };
    this.renderCurrent();
    this.scheduleHide();
  }

  clearSegment(): void {
    this.current = null;
    this.originalEl.textContent = '';
    this.translationEl.textContent = '';
    this.originalEl.classList.add('is-hidden');
    this.translationEl.classList.add('is-hidden');
    this.caps.classList.add('is-hidden', 'no-lines');
    if (this.hideTimer) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private renderCurrent(): void {
    if (!this.current) {
      this.originalEl.textContent = '';
      this.translationEl.textContent = '';
      this.caps.classList.add('no-lines');
      return;
    }
    const segment = this.current;
    const showOriginal = this.overlay.showOriginal && !!segment.original.trim();
    const translation = segment.translation.trim();
    const showTranslation = this.overlay.showTranslation;

    this.originalEl.textContent = segment.original;
    this.originalEl.classList.toggle('is-hidden', !showOriginal);

    let translationText = translation;
    let extraClass = '';
    let title = '';
    if (showTranslation) {
      if (!translation) {
        if (segment.status === 'error') {
          translationText = segment.error ? '翻译失败' : '翻译失败';
          extraClass = 'warning';
          title = segment.error || '翻译失败';
        } else if (segment.status === 'pending' || segment.status === 'translating') {
          translationText = '翻译中…';
          extraClass = 'placeholder';
        }
      } else if (segment.status === 'error') {
        extraClass = 'warning';
        title = segment.error || '';
      }
    }
    this.translationEl.textContent = showTranslation ? translationText : '';
    this.translationEl.title = title;
    this.translationEl.classList.toggle('is-hidden', !showTranslation || !translationText);
    this.translationEl.classList.toggle('placeholder', extraClass === 'placeholder');
    this.translationEl.classList.toggle('warning', extraClass === 'warning');

    const hasLines =
      (showOriginal && !!segment.original.trim()) ||
      (showTranslation && !!translationText);
    this.caps.classList.toggle('no-lines', !hasLines);
    if (hasLines) {
      this.caps.classList.remove('is-hidden');
    }
  }

  private scheduleHide(): void {
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (!this.active) return;
    if (!this.current || this.current.status === 'pending' || this.current.status === 'translating') {
      this.caps.classList.remove('is-hidden');
      return;
    }
    if (!this.overlay.hideDelay || this.overlay.hideDelay <= 0) return;
    this.hideTimer = window.setTimeout(() => {
      if (this.current && (this.current.status === 'done' || this.current.status === 'error')) {
        this.caps.classList.add('is-hidden');
      }
    }, this.overlay.hideDelay * 1000);
  }

  handleStopped(): void {
    const hadError = this.status.phase === 'error';
    this.active = false;
    this.clearSegment();
    if (this.hideForStopTimer) window.clearTimeout(this.hideForStopTimer);
    if (hadError) {
      this.stage.classList.remove('is-hidden');
      this.setStatus(this.status);
      this.hideForStopTimer = window.setTimeout(() => {
        this.stage.classList.add('is-hidden');
        this.hideForStopTimer = null;
      }, 7000);
    } else {
      this.stage.classList.add('is-hidden');
    }
  }

  destroy(): void {
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
    this.host.remove();
  }
}

let overlay: SubtitleOverlay | null = null;
let settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
let active = false;
let anchored = false;
let watchdog: number | null = null;
let retryTimer: number | null = null;

function ensureOverlay(): SubtitleOverlay {
  if (!overlay) overlay = new SubtitleOverlay(settings);
  overlay.applyOverlayStyle(settings.overlay);
  return overlay;
}

function findVideos(root: Document | ShadowRoot, depth = 0): HTMLVideoElement[] {
  const found: HTMLVideoElement[] = [];
  if (depth > 4) return found;
  root.querySelectorAll('video').forEach((video) => found.push(video));
  if (depth < 4) {
    root.querySelectorAll('*').forEach((element) => {
      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow) found.push(...findVideos(shadow, depth + 1));
    });
  }
  return found;
}

function findBestVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestScore = -1;
  for (const video of findVideos(document)) {
    const rect = video.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 90) continue;
    if (rect.bottom < 0 || rect.right < 0) continue;
    if (rect.top > window.innerHeight || rect.left > window.innerWidth) continue;
    const visible =
      Math.max(
        0,
        Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
      ) *
      Math.max(
        0,
        Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
      );
    let score = visible;
    if (!video.paused) score *= 1.5;
    if (video.readyState >= 2) score *= 1.1;
    if (score > bestScore) {
      bestScore = score;
      best = video;
    }
  }
  return best;
}

function sendAnchorIfPossible(): void {
  if (!active || anchored) return;
  const video = findBestVideo();
  if (!video || !Number.isFinite(video.currentTime)) return;
  anchored = true;
  void chrome.runtime
    .sendMessage({ type: 'VIDEO_ANCHOR', videoTime: video.currentTime })
    .catch(() => undefined);
}

function scheduleAnchorRetry(): void {
  if (retryTimer) window.clearInterval(retryTimer);
  let attempts = 0;
  retryTimer = window.setInterval(() => {
    attempts++;
    sendAnchorIfPossible();
    if (anchored || !active || attempts > 20) {
      if (retryTimer) window.clearInterval(retryTimer);
      retryTimer = null;
    }
  }, 1500);
  sendAnchorIfPossible();
}

function startWatchdog(): void {
  if (watchdog) return;
  watchdog = window.setInterval(() => {
    if (!overlay || !active) return;
    overlay.keepAttached();
    sendAnchorIfPossible();
  }, 2500);
}

function stopWatchdog(): void {
  if (watchdog) window.clearInterval(watchdog);
  watchdog = null;
  if (retryTimer) window.clearInterval(retryTimer);
  retryTimer = null;
}

async function refreshState(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'GET_STATE',
    })) as StateResponse | undefined;
    if (!response) return;
    active = !!response.session?.active && response.isCurrentTab;
    if (!active) return;
    const view = ensureOverlay();
    view.setActive(true);
    view.setStatus(response.session!.status);
    if (response.session!.latestSegment) {
      view.restoreSegment(response.session!.latestSegment);
    }
    anchored = false;
    startWatchdog();
    scheduleAnchorRetry();
  } catch {
    // extension context may have been reloaded
  }
}

function handleContentEvent(message: ContentEvent): void {
  if (message.type === 'SESSION_STARTED') {
    const wasActive = active;
    active = true;
    if (!wasActive) {
      overlay?.clearSegment();
      anchored = false;
    }
    const view = ensureOverlay();
    view.setActive(true);
    view.setStatus(message.status);
    startWatchdog();
    scheduleAnchorRetry();
    return;
  }
  if (message.type === 'SESSION_STATUS') {
    if (!overlay) ensureOverlay();
    overlay!.setStatus(message.status);
    if (message.active) {
      active = true;
      overlay!.setActive(true);
    }
    return;
  }
  if (message.type === 'CAPTION') {
    if (!active) return;
    const view = ensureOverlay();
    view.setActive(true);
    view.showSegment(message.segment);
    return;
  }
  if (message.type === 'CLEAR_CAPTION') {
    overlay?.clearSegment();
    return;
  }
  if (message.type === 'SESSION_STOPPED') {
    active = false;
    anchored = false;
    stopWatchdog();
    overlay?.handleStopped();
  }
}

function addRuntimeListener(): void {
  chrome.runtime.onMessage.addListener((message: ContentEvent) => {
    if (!message || typeof message.type !== 'string') return;
    handleContentEvent(message);
  });
}

async function init(): Promise<void> {
  if (window.__transubLoaded) return;
  window.__transubLoaded = true;
  if (!document.documentElement) return;

  addRuntimeListener();
  try {
    settings = await loadSettings();
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }

  onSettingsChanged((next) => {
    settings = next;
    overlay?.applyOverlayStyle(next.overlay);
  });

  if (overlay) overlay.applyOverlayStyle(settings.overlay);
  await refreshState();
}

if (!window.__transubLoaded) {
  void init();
}
