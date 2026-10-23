export interface AudioChunk {
  pcm: Float32Array;
  startMs: number;
  endMs: number;
  sampleRate: number;
}

export interface CaptureCallbacks {
  onChunk: (chunk: AudioChunk) => void;
  onEnded: (reason: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TabAudioCapture {
  private stream: MediaStream | null = null;
  private playbackCtx: AudioContext | null = null;
  private captureCtx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private ended = false;

  async start(streamId: string, callbacks: CaptureCallbacks): Promise<void> {
    try {
      const constraints = {
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      } as unknown as MediaStreamConstraints;

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = this.stream.getAudioTracks()[0];
      if (!track) throw new Error('没有捕获到标签页音频轨道');
      track.addEventListener('ended', () => {
        this.ended = true;
        callbacks.onEnded('标签页音频已结束');
      });

      // tabCapture 会静音原标签页，必须把捕获流接回扬声器，用户才能继续听到声音。
      this.playbackCtx = new AudioContext({ latencyHint: 'interactive' });
      const playbackSource = this.playbackCtx.createMediaStreamSource(this.stream);
      playbackSource.connect(this.playbackCtx.destination);
      await this.playbackCtx.resume().catch(() => undefined);

      try {
        this.captureCtx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
      } catch {
        this.captureCtx = new AudioContext({ latencyHint: 'interactive' });
      }
      await this.captureCtx.audioWorklet.addModule(
        chrome.runtime.getURL('audio-processor.js'),
      );

      const source = this.captureCtx.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.captureCtx, 'transub-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      this.worklet.port.onmessage = (event: MessageEvent) => {
        const msg = event.data as {
          type?: string;
          pcm?: ArrayBuffer;
          startMs?: number;
          endMs?: number;
          sampleRate?: number;
        };
        if (msg?.type !== 'chunk' || !(msg.pcm instanceof ArrayBuffer)) return;
        callbacks.onChunk({
          pcm: new Float32Array(msg.pcm),
          startMs: Number(msg.startMs) || 0,
          endMs: Number(msg.endMs) || 0,
          sampleRate: Number(msg.sampleRate) || this.captureCtx?.sampleRate || 16000,
        });
      };

      this.sink = this.captureCtx.createGain();
      this.sink.gain.value = 0;
      source.connect(this.worklet);
      this.worklet.connect(this.sink).connect(this.captureCtx.destination);
      await this.captureCtx.resume().catch(() => undefined);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  get endedUnexpectedly(): boolean {
    return this.ended;
  }

  async stop(): Promise<void> {
    const worklet = this.worklet;
    this.worklet = null;
    if (worklet) {
      try {
        worklet.port.postMessage({ type: 'flush' });
      } catch {
        // worklet may already be detached
      }
      await sleep(140);
      try {
        worklet.port.onmessage = null;
        worklet.disconnect();
      } catch {
        // ignore
      }
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.sink) {
      try {
        this.sink.disconnect();
      } catch {
        // ignore
      }
      this.sink = null;
    }
    for (const ctx of [this.captureCtx, this.playbackCtx]) {
      if (!ctx) continue;
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }
    this.captureCtx = null;
    this.playbackCtx = null;
  }
}

export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  targetRate = 16000,
): Float32Array {
  if (!input.length || inputRate === targetRate) return input;
  const ratio = inputRate / targetRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

export function encodeWav(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
