export interface AiProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  customPrompt: string;
}

export type AsrEngine = 'local' | 'remote';
export type LocalWhisperModel = 'tiny' | 'base' | 'small';
export type InferenceDevice = 'auto' | 'webgpu' | 'wasm';
export type ModelHost = 'huggingface' | 'hf-mirror';

export interface AsrSettings {
  engine: AsrEngine;
  localModel: LocalWhisperModel;
  localDevice: InferenceDevice;
  modelHost: ModelHost;
  /** 'auto' 或 Whisper 语言代码，如 zh / en / ja */
  language: string;
  remoteBaseUrl: string;
  remoteApiKey: string;
  remoteModel: string;
}

export interface TranslationSettings {
  enabled: boolean;
  /** zh-CN / zh-TW / en / ja / ... / auto-zh-en / custom */
  targetLanguage: string;
  customTarget: string;
}

export interface OverlaySettings {
  /** 视口百分比，字幕中心点 */
  positionX: number;
  positionY: number;
  /** 占视口宽度的百分比 */
  maxWidth: number;
  originalSize: number;
  translationSize: number;
  originalColor: string;
  translationColor: string;
  background: string;
  /** 0 – 1 */
  backgroundOpacity: number;
  fontFamily: string;
  /** 秒；0 表示不自动隐藏 */
  hideDelay: number;
  showOriginal: boolean;
  showTranslation: boolean;
}

export interface AppSettings {
  schemaVersion: number;
  profiles: AiProfile[];
  activeProfileId: string;
  asr: AsrSettings;
  translation: TranslationSettings;
  overlay: OverlaySettings;
}

export type SessionPhase =
  | 'idle'
  | 'starting'
  | 'loading-model'
  | 'listening'
  | 'transcribing'
  | 'error';

export interface SessionStatus {
  phase: SessionPhase;
  message: string;
  /** 0 – 100，模型下载进度等 */
  progress?: number;
}

export type SegmentState = 'pending' | 'translating' | 'done' | 'error';

export interface CaptionSegment {
  id: string;
  /** 相对捕获开始的秒数 */
  start: number;
  end: number;
  original: string;
  translation: string;
  status: SegmentState;
  error?: string;
}

export interface SessionSnapshot {
  tabId: number;
  startedAt: number;
  active: boolean;
  title: string;
  /** 开始捕获时视频的 currentTime，导出时用于对齐原视频时间轴 */
  baseTime: number;
  baseTimeSet: boolean;
  status: SessionStatus;
  segments: CaptionSegment[];
  asrEngine: AsrEngine;
}

export interface SessionView extends Omit<SessionSnapshot, 'segments'> {
  segments: CaptionSegment[];
  segmentCount: number;
  latestSegment: CaptionSegment | null;
}

export interface StateResponse {
  session: SessionView | null;
  isCurrentTab: boolean;
  tabId: number;
  profileNames: Array<{ id: string; name: string }>;
  activeProfileId: string;
}

export type ExportFormat = 'srt' | 'vtt' | 'txt';
export type ExportContent = 'bilingual' | 'original' | 'translation';

export interface ExportOptions {
  format: ExportFormat;
  content: ExportContent;
  timestamps: boolean;
}

export interface ExportResponse {
  ok: boolean;
  error?: string;
  filename?: string;
}

export interface StartCaptureResponse {
  ok: boolean;
  error?: string;
}

export type BackgroundRequest =
  | { type: 'START_CAPTURE'; tabId: number }
  | { type: 'STOP_CAPTURE'; tabId?: number }
  | { type: 'GET_STATE'; tabId?: number }
  | { type: 'EXPORT'; options: ExportOptions; tabId?: number }
  | { type: 'SET_ACTIVE_PROFILE'; profileId: string }
  | { type: 'OPEN_OPTIONS' }
  | { type: 'CONTENT_READY' }
  | { type: 'VIDEO_ANCHOR'; videoTime: number }
  | { type: 'STOP_SESSION' };

export type ContentEvent =
  | {
      type: 'SESSION_STARTED';
      status: SessionStatus;
      active: boolean;
    }
  | { type: 'SESSION_STOPPED' }
  | { type: 'SESSION_STATUS'; status: SessionStatus; active: boolean }
  | { type: 'CAPTION'; segment: CaptionSegment }
  | { type: 'CLEAR_CAPTION' };

export type OffscreenRequest =
  | {
      to: 'offscreen';
      type: 'START_CAPTURE';
      tabId: number;
      sessionId: number;
      streamId: string;
      asr: AsrSettings;
    }
  | { to: 'offscreen'; type: 'STOP_CAPTURE' }
  | { to: 'offscreen'; type: 'PING' };

export type OffscreenEvent =
  | { type: 'CAPTURE_STARTED'; tabId: number; sessionId: number }
  | {
      type: 'CAPTURE_ENDED';
      tabId: number;
      sessionId: number;
      reason?: string;
    }
  | {
      type: 'ASR_STATUS';
      tabId: number;
      sessionId: number;
      status: SessionStatus;
    }
  | {
      type: 'ASR_ERROR';
      tabId: number;
      sessionId: number;
      message: string;
      fatal: boolean;
    }
  | {
      type: 'ASR_SEGMENT';
      tabId: number;
      sessionId: number;
      text: string;
      startMs: number;
      endMs: number;
      language?: string;
    };

export interface OffscreenResponse {
  ok: boolean;
  error?: string;
}

export interface TranslationJob {
  sessionStartedAt: number;
  segmentId: string;
  text: string;
}
