export const APP_NAME = 'Transub 译流';
export const SETTINGS_KEY = 'settings';
export const SESSION_KEY = 'currentSession';

export const ASR_LANGUAGES = [
  { code: 'auto', label: '自动检测' },
  { code: 'zh', label: '中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'ru', label: '俄语' },
  { code: 'it', label: '意大利语' },
  { code: 'pt', label: '葡萄牙语' },
];

export const TARGET_LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
  { code: 'auto-zh-en', label: '自动 · 中英互译' },
  { code: 'custom', label: '自定义…' },
];

export const WHISPER_MODELS = [
  {
    id: 'tiny' as const,
    label: 'Tiny',
    params: '39M',
    download: '约 40–75 MB',
    description: '最快，适合实时字幕；复杂场景准确率一般',
  },
  {
    id: 'base' as const,
    label: 'Base',
    params: '74M',
    download: '约 80–150 MB',
    description: '速度与准确率平衡，推荐日常使用',
  },
  {
    id: 'small' as const,
    label: 'Small',
    params: '244M',
    download: '约 250–500 MB',
    description: '更准确，但需要更强的 CPU / GPU',
  },
];

export const WHISPER_REPOS: Record<string, string> = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
};

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  hint: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '需要可访问 OpenAI 的网络环境',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '国内直连，性价比高',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    hint: '支持多种开源模型',
  },
  {
    id: 'moonshot',
    label: '月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    hint: 'Kimi 开放平台',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.1-8b-instant',
    hint: '推理速度非常快',
  },
  {
    id: 'ollama',
    label: 'Ollama 本地',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    hint: '本地模型，API Key 可留空',
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    model: '',
    hint: '任何 OpenAI 兼容接口',
  },
];

export const ASR_LANGUAGE_LABELS: Record<string, string> = Object.fromEntries(
  ASR_LANGUAGES.map((item) => [item.code, item.label]),
);

export const TARGET_LANGUAGE_LABELS: Record<string, string> = Object.fromEntries(
  TARGET_LANGUAGES.map((item) => [item.code, item.label]),
);

/** 送给翻译模型的自然语言目标描述 */
export function getTargetInstruction(
  targetLanguage: string,
  customTarget: string,
): { label: string; instruction: string } {
  if (targetLanguage === 'auto-zh-en') {
    return {
      label: '自动 · 中英互译',
      instruction:
        '如果原文以中文为主，翻译成自然、地道的英文；否则翻译成简体中文',
    };
  }
  if (targetLanguage === 'custom') {
    const custom = customTarget.trim() || '简体中文';
    return { label: custom, instruction: custom };
  }
  const label = TARGET_LANGUAGE_LABELS[targetLanguage] || targetLanguage;
  return { label, instruction: label };
}

export function isLocalEndpoint(url: string): boolean {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url.trim());
}
