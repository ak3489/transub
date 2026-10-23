import type { AiProfile, AsrSettings } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface StreamChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (textSoFar: string) => void;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

function normalizeBase(baseUrl: string): string {
  let base = baseUrl.trim();
  if (!base) throw new Error('请填写 API Base URL');
  if (!/^https?:\/\//i.test(base)) {
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(base);
    base = `${local ? 'http' : 'https'}://${base}`;
  }
  base = base.replace(/\/+$/, '');
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('只支持 http/https 地址');
    }
  } catch {
    throw new Error('Base URL 格式不正确');
  }
  return base;
}

export function resolveEndpoint(
  baseUrl: string,
  kind: 'chat' | 'transcription',
): string {
  let base = normalizeBase(baseUrl);
  const target = kind === 'chat' ? '/chat/completions' : '/audio/transcriptions';
  const other = kind === 'chat' ? '/audio/transcriptions' : '/chat/completions';

  if (base.toLowerCase().endsWith(other.toLowerCase())) {
    base = base.slice(0, -other.length);
  }
  if (base.toLowerCase().endsWith(target.toLowerCase())) return base;
  if (/\/v\d+$/i.test(base)) return `${base}${target}`;
  return `${base}/v1${target}`;
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

function extractMessageText(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const choices = (json as { choices?: unknown[] }).choices;
  if (!Array.isArray(choices) || !choices.length) return '';
  const choice = choices[0] as Record<string, unknown>;
  const message = choice.message as Record<string, unknown> | undefined;
  const delta = choice.delta as Record<string, unknown> | undefined;
  return (
    contentToString(message?.content) ||
    contentToString(delta?.content) ||
    contentToString(choice.text)
  );
}

function formatHttpError(status: number, detail: string): string {
  const clean = detail.replace(/\s+/g, ' ').trim().slice(0, 360);
  const suffix = clean ? `：${clean}` : '';
  if (status === 401 || status === 403) return `鉴权失败（${status}），请检查 API Key${suffix}`;
  if (status === 404) return `接口或模型不存在（404），请检查 Base URL / 模型名${suffix}`;
  if (status === 429) return `请求被限流或额度不足（429）${suffix}`;
  if (status >= 500) return `服务端错误（${status}）${suffix}`;
  return `请求失败（${status}）${suffix}`;
}

async function readApiError(response: Response): Promise<string> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    // ignore unreadable error body
  }
  let detail = raw;
  try {
    const data = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (data && typeof data.error === 'object' && data.error?.message) {
      detail = data.error.message;
    } else if (typeof data.error === 'string') {
      detail = data.error;
    } else if (typeof data.message === 'string') {
      detail = data.message;
    }
  } catch {
    // keep plain text
  }
  return formatHttpError(response.status, detail);
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

function handleSseEvent(rawEvent: string, emit: (text: string) => void): boolean {
  let done = false;
  for (const rawLine of rawEvent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    try {
      const json = JSON.parse(payload) as unknown;
      const text = extractMessageText(json);
      if (text) emit(text);
    } catch {
      // Some compatible providers emit keep-alive lines; ignore them.
    }
  }
  return done;
}

export async function streamChatCompletion(options: StreamChatOptions): Promise<string> {
  const { baseUrl, apiKey, model, messages, onText } = options;
  if (!model.trim()) throw new Error('请填写模型名称');
  const endpoint = resolveEndpoint(baseUrl, 'chat');
  const body: Record<string, unknown> = {
    model: model.trim(),
    messages,
    stream: true,
    temperature: Math.min(2, Math.max(0, options.temperature ?? 0.2)),
  };
  if (options.maxTokens && options.maxTokens > 0) body.max_tokens = options.maxTokens;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: withTimeout(options.signal, 120_000),
    });
  } catch (error) {
    throw new Error(describeError(error));
  }
  if (!response.ok) throw new Error(await readApiError(response));

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  let fullText = '';

  if (!contentType.includes('text/event-stream')) {
    const raw = await response.text();
    if (/^\s*data:/m.test(raw)) {
      for (const part of raw.split(/\r?\n\r?\n/)) {
        const done = handleSseEvent(part, (delta) => {
          fullText += delta;
          onText?.(fullText);
        });
        if (done) break;
      }
    } else {
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error('接口返回了无法解析的内容，请确认是 OpenAI 兼容接口');
      }
      fullText = extractMessageText(data);
      if (fullText) onText?.(fullText);
    }
    const text = fullText.trim();
    if (!text) throw new Error('AI 返回了空译文');
    return text;
  }

  if (!response.body) throw new Error('接口未返回可读取的数据流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const consume = (rawEvent: string) => {
    const done = handleSseEvent(rawEvent, (delta) => {
      fullText += delta;
      onText?.(fullText);
    });
    if (done) finished = true;
  };

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match = buffer.match(/\r?\n\r?\n/);
      while (match && match.index !== undefined) {
        const event = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consume(event);
        if (finished) break;
        match = buffer.match(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (!finished && buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }

  const text = fullText.trim();
  if (!text) throw new Error('AI 返回了空译文');
  return text;
}

export interface TranslateParams {
  profile: AiProfile;
  text: string;
  targetInstruction: string;
  context: Array<{ original: string; translation: string }>;
  signal?: AbortSignal;
  onText?: (textSoFar: string) => void;
}

export function buildTranslationMessages(
  params: Pick<TranslateParams, 'text' | 'targetInstruction' | 'context'> & {
    customPrompt: string;
  },
): ChatMessage[] {
  const { text, targetInstruction, context, customPrompt } = params;
  const recent = context
    .filter((item) => item.original.trim() && item.translation.trim())
    .slice(-4)
    .map((item) => `原文：${item.original}\n译文：${item.translation}`)
    .join('\n---\n');

  let system = [
    '你是专业的影视字幕翻译引擎，正在为实时播放的视频生成双语句幕。',
    `请把用户给出的字幕翻译成：${targetInstruction}。`,
    '规则：',
    '1. 只输出译文本身，不要解释、不要加引号、不要重复原文。',
    '2. 表达自然、口语化，符合影视对白习惯；保留人名、数字和专有名词。',
    '3. 原文可能是语音识别产生的不完整句子，请按最合理的语义翻译，不要遗漏信息。',
    '4. 如果原文已经是目标语言，原样输出。',
  ].join('\n');

  if (recent) {
    system += `\n\n最近几条字幕（仅作语境参考，不要翻译它们）：\n${recent}`;
  }
  if (customPrompt.trim()) {
    system += `\n\n附加要求：${customPrompt.trim()}`;
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ];
}

export async function translateText(params: TranslateParams): Promise<string> {
  const messages = buildTranslationMessages({
    text: params.text,
    targetInstruction: params.targetInstruction,
    context: params.context,
    customPrompt: params.profile.customPrompt,
  });
  return streamChatCompletion({
    baseUrl: params.profile.baseUrl,
    apiKey: params.profile.apiKey,
    model: params.profile.model,
    temperature: params.profile.temperature,
    maxTokens: params.profile.maxTokens,
    messages,
    signal: params.signal,
    onText: params.onText,
  });
}

export interface TestProfileResult {
  latencyMs: number;
  reply: string;
}

export async function testProfile(profile: AiProfile): Promise<TestProfileResult> {
  if (!profile.baseUrl.trim()) throw new Error('请填写 API Base URL');
  if (!profile.model.trim()) throw new Error('请填写模型名称');
  const endpoint = resolveEndpoint(profile.baseUrl, 'chat');
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(profile.apiKey),
      body: JSON.stringify({
        model: profile.model.trim(),
        messages: [{ role: 'user', content: '请只回复两个字母：OK' }],
        temperature: 0,
        max_tokens: 16,
        stream: false,
      }),
      signal: withTimeout(undefined, 30_000),
    });
  } catch (error) {
    throw new Error(describeError(error));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('接口返回的不是 JSON，请确认 Base URL 指向 OpenAI 兼容接口');
  }
  const reply = extractMessageText(data).trim();
  if (!reply) throw new Error('接口连接成功，但返回内容为空');
  return { latencyMs: Date.now() - started, reply };
}

export async function transcribeRemoteAudio(
  asr: AsrSettings,
  wav: Blob,
  signal?: AbortSignal,
): Promise<string> {
  if (!asr.remoteBaseUrl.trim()) throw new Error('请先配置远程 ASR Base URL');
  if (!asr.remoteModel.trim()) throw new Error('请先配置远程 ASR 模型');
  const endpoint = resolveEndpoint(asr.remoteBaseUrl, 'transcription');
  const form = new FormData();
  form.append('file', wav, 'chunk.wav');
  form.append('model', asr.remoteModel.trim());
  form.append('response_format', 'json');
  if (asr.language && asr.language !== 'auto') form.append('language', asr.language);

  const headers: Record<string, string> = {};
  if (asr.remoteApiKey.trim()) headers.Authorization = `Bearer ${asr.remoteApiKey.trim()}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: form,
      signal: withTimeout(signal, 90_000),
    });
  } catch (error) {
    throw new Error(describeError(error));
  }
  if (!response.ok) throw new Error(await readApiError(response));

  const raw = await response.text();
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const data = JSON.parse(trimmed) as { text?: unknown; result?: unknown };
    if (typeof data.text === 'string') return data.text.trim();
    if (typeof data.result === 'string') return data.result.trim();
    return '';
  } catch {
    return trimmed;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'AbortError') return '请求已取消';
    if (error.name === 'TimeoutError') return '请求超时，请检查网络或接口地址';
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时，请检查网络或接口地址';
    if (error.message.includes('Failed to fetch')) {
      return '网络请求失败：请检查 Base URL、代理或网络连接';
    }
    return error.message.slice(0, 400);
  }
  return String(error).slice(0, 400);
}
