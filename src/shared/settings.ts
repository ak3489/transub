import { SETTINGS_KEY } from './constants';
import type {
  AiProfile,
  AppSettings,
  AsrSettings,
  OverlaySettings,
  TranslationSettings,
} from './types';

const hasChromeStorage = () =>
  typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;

const clone = <T,>(value: T): T => structuredClone(value);

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  profiles: [
    {
      id: 'default',
      name: '我的 AI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0.2,
      maxTokens: 800,
      customPrompt: '',
    },
  ],
  activeProfileId: 'default',
  asr: {
    engine: 'local',
    localModel: 'tiny',
    localDevice: 'auto',
    modelHost: 'huggingface',
    language: 'auto',
    remoteBaseUrl: 'https://api.openai.com/v1',
    remoteApiKey: '',
    remoteModel: 'whisper-1',
  },
  translation: {
    enabled: true,
    targetLanguage: 'zh-CN',
    customTarget: '',
  },
  overlay: {
    positionX: 50,
    positionY: 84,
    maxWidth: 82,
    originalSize: 24,
    translationSize: 21,
    originalColor: '#f7faf8',
    translationColor: '#9fe8d5',
    background: '#081310',
    backgroundOpacity: 0.62,
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    hideDelay: 5,
    showOriginal: true,
    showTranslation: true,
  },
};

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeProfile(raw: unknown, index: number): AiProfile {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<AiProfile>;
  return {
    id: asString(value.id, `profile-${index}`),
    name: asString(value.name, `配置 ${index + 1}`).trim() || `配置 ${index + 1}`,
    baseUrl: asString(value.baseUrl, ''),
    apiKey: asString(value.apiKey, ''),
    model: asString(value.model, ''),
    temperature: asNumber(value.temperature, 0.2, 0, 2),
    maxTokens: Math.round(asNumber(value.maxTokens, 800, 64, 32768)),
    customPrompt: asString(value.customPrompt, ''),
  };
}

function normalizeAsr(raw: unknown): AsrSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<AsrSettings>;
  return {
    engine: value.engine === 'remote' ? 'remote' : 'local',
    localModel: ['tiny', 'base', 'small'].includes(value.localModel || '')
      ? (value.localModel as AsrSettings['localModel'])
      : 'tiny',
    localDevice: ['auto', 'webgpu', 'wasm'].includes(value.localDevice || '')
      ? (value.localDevice as AsrSettings['localDevice'])
      : 'auto',
    modelHost: value.modelHost === 'hf-mirror' ? 'hf-mirror' : 'huggingface',
    language: asString(value.language, 'auto'),
    remoteBaseUrl: asString(value.remoteBaseUrl, 'https://api.openai.com/v1'),
    remoteApiKey: asString(value.remoteApiKey, ''),
    remoteModel: asString(value.remoteModel, 'whisper-1'),
  };
}

function normalizeTranslation(raw: unknown): TranslationSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<TranslationSettings>;
  return {
    enabled: asBoolean(value.enabled, true),
    targetLanguage: asString(value.targetLanguage, 'zh-CN'),
    customTarget: asString(value.customTarget, ''),
  };
}

function normalizeOverlay(raw: unknown): OverlaySettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<OverlaySettings>;
  return {
    positionX: asNumber(value.positionX, 50, 2, 98),
    positionY: asNumber(value.positionY, 84, 2, 98),
    maxWidth: asNumber(value.maxWidth, 82, 30, 98),
    originalSize: asNumber(value.originalSize, 24, 12, 64),
    translationSize: asNumber(value.translationSize, 21, 10, 64),
    originalColor: asString(value.originalColor, '#f7faf8'),
    translationColor: asString(value.translationColor, '#9fe8d5'),
    background: asString(value.background, '#081310'),
    backgroundOpacity: asNumber(value.backgroundOpacity, 0.62, 0, 1),
    fontFamily: asString(value.fontFamily, DEFAULT_SETTINGS.overlay.fontFamily),
    hideDelay: asNumber(value.hideDelay, 5, 0, 120),
    showOriginal: asBoolean(value.showOriginal, true),
    showTranslation: asBoolean(value.showTranslation, true),
  };
}

export function normalizeSettings(raw: unknown): AppSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>;
  const profiles =
    Array.isArray(value.profiles) && value.profiles.length > 0
      ? value.profiles.map((profile, index) => normalizeProfile(profile, index))
      : clone(DEFAULT_SETTINGS.profiles);
  const activeProfileId = profiles.some((p) => p.id === value.activeProfileId)
    ? (value.activeProfileId as string)
    : profiles[0].id;
  return {
    schemaVersion: 1,
    profiles,
    activeProfileId,
    asr: normalizeAsr(value.asr),
    translation: normalizeTranslation(value.translation),
    overlay: normalizeOverlay(value.overlay),
  };
}

async function readRawSettings(): Promise<unknown> {
  if (hasChromeStorage()) {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return data[SETTINGS_KEY];
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

async function writeSettings(settings: AppSettings): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } else {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
}

export async function loadSettings(): Promise<AppSettings> {
  return normalizeSettings(await readRawSettings());
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeSettings(normalizeSettings(settings));
}

export async function updateSettings(
  mutator: (settings: AppSettings) => void | AppSettings,
): Promise<AppSettings> {
  const settings = await loadSettings();
  const result = mutator(settings);
  const next = normalizeSettings(result || settings);
  await writeSettings(next);
  return next;
}

export async function patchOverlay(patch: Partial<OverlaySettings>): Promise<AppSettings> {
  return updateSettings((settings) => {
    settings.overlay = { ...settings.overlay, ...patch };
  });
}

export async function setActiveProfile(profileId: string): Promise<AppSettings> {
  return updateSettings((settings) => {
    if (settings.profiles.some((p) => p.id === profileId)) {
      settings.activeProfileId = profileId;
    }
  });
}

export function getActiveProfile(settings: AppSettings): AiProfile | undefined {
  return (
    settings.profiles.find((p) => p.id === settings.activeProfileId) ||
    settings.profiles[0]
  );
}

export function createProfile(name?: string): AiProfile {
  return {
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: name || '新配置',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    maxTokens: 800,
    customPrompt: '',
  };
}

export function onSettingsChanged(callback: (settings: AppSettings) => void): () => void {
  if (hasChromeStorage()) {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;
      callback(normalizeSettings(changes[SETTINGS_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
  const listener = (event: StorageEvent) => {
    if (event.key !== SETTINGS_KEY || !event.newValue) return;
    try {
      callback(normalizeSettings(JSON.parse(event.newValue)));
    } catch {
      // ignore malformed local preview data
    }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

export function createId(prefix = 'seg'): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
