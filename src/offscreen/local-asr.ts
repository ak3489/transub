import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from '@huggingface/transformers';
import { WHISPER_REPOS } from '../shared/constants';
import type { AsrSettings, InferenceDevice } from '../shared/types';

export type ProgressHandler = (progress: number | undefined, message: string) => void;

let configuredHost: string | null = null;

function configureTransformers(modelHost: AsrSettings['modelHost']): void {
  const remoteHost =
    modelHost === 'hf-mirror' ? 'https://hf-mirror.com/' : 'https://huggingface.co/';
  if (configuredHost !== remoteHost) {
    env.remoteHost = remoteHost;
    configuredHost = remoteHost;
  }
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  const wasm = (
    env.backends.onnx as {
      wasm?: { wasmPaths?: string; numThreads?: number };
    }
  )?.wasm;
  if (wasm) {
    wasm.wasmPaths = chrome.runtime.getURL('ort/');
    wasm.numThreads = globalThis.crossOriginIsolated
      ? Math.min(4, Math.max(1, navigator.hardwareConcurrency || 1))
      : 1;
  }
}

export class LocalWhisper {
  private pipe: AutomaticSpeechRecognitionPipeline | null = null;
  private loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
  private deviceUsed = '';

  get ready(): boolean {
    return this.pipe !== null;
  }

  get device(): string {
    return this.deviceUsed;
  }

  async ensureLoaded(
    asr: AsrSettings,
    onProgress?: ProgressHandler,
  ): Promise<AutomaticSpeechRecognitionPipeline> {
    if (this.pipe) return this.pipe;
    if (this.loading) return this.loading;
    this.loading = this.load(asr, onProgress).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(
    asr: AsrSettings,
    onProgress?: ProgressHandler,
  ): Promise<AutomaticSpeechRecognitionPipeline> {
    configureTransformers(asr.modelHost);
    const modelId = WHISPER_REPOS[asr.localModel] || WHISPER_REPOS.tiny;
    const requested: Exclude<InferenceDevice, 'auto'> =
      asr.localDevice === 'auto'
        ? typeof navigator !== 'undefined' && 'gpu' in navigator
          ? 'webgpu'
          : 'wasm'
        : asr.localDevice;

    const progressCallback = (info: {
      status?: string;
      progress?: number;
      file?: string;
    }) => {
      if (info.status === 'progress' && typeof info.progress === 'number') {
        onProgress?.(
          info.progress,
          `正在下载模型 ${Math.round(info.progress)}%`,
        );
      } else if (info.status === 'initiate') {
        onProgress?.(0, '正在准备本地模型…');
      }
    };

    const heavy =
      asr.localModel === 'medium' || asr.localModel === 'large-v3-turbo';
    const create = async (
      device: 'webgpu' | 'wasm',
    ): Promise<AutomaticSpeechRecognitionPipeline> => {
      // 重型模型的 fp32 编码器可达 1–3 GB，WebGPU 改用 q4 控制显存和下载体积。
      const dtype =
        device === 'webgpu'
          ? heavy
            ? { encoder_model: 'q4', decoder_model_merged: 'q4' }
            : { encoder_model: 'fp32', decoder_model_merged: 'q4' }
          : 'q8';
      const pipe = await pipeline('automatic-speech-recognition', modelId, {
        device,
        dtype,
        progress_callback: progressCallback,
      } as Parameters<typeof pipeline>[2]);
      return pipe as AutomaticSpeechRecognitionPipeline;
    };

    try {
      this.pipe = await create(requested);
      this.deviceUsed = requested === 'webgpu' ? 'WebGPU' : 'CPU (WASM)';
      return this.pipe;
    } catch (error) {
      if (requested !== 'webgpu') throw error;
      onProgress?.(0, 'WebGPU 不可用，回退到 CPU…');
      this.pipe = await create('wasm');
      this.deviceUsed = 'CPU (WASM)';
      return this.pipe;
    }
  }

  async transcribe(audio: Float32Array, language: string): Promise<string> {
    if (!this.pipe) throw new Error('本地 Whisper 尚未加载');
    const options: Record<string, unknown> = {
      task: 'transcribe',
      return_timestamps: false,
    };
    if (language && language !== 'auto') options.language = language;
    const result = await this.pipe(audio, options as never);
    const output = Array.isArray(result) ? result : [result];
    return output
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join(' ')
      .trim();
  }
}
