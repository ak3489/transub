/**
 * Transub 音频切片器（AudioWorklet）
 * 输入为 16kHz 单声道标签页音频，按能量 VAD 切成 0.35s–12s 的语音段。
 * 这里只做切片与时间戳，不把音频发往网络；识别由 offscreen 决定走本地还是远程。
 */
const DEFAULTS = {
  threshold: 0.006,
  silenceMs: 700,
  maxChunkMs: 12000,
  minSpeechMs: 320,
  preRollMs: 320,
  tailMs: 160,
  overlapMs: 200,
  triggerFrames: 2,
};

class TransubCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = { ...DEFAULTS };
    this.rate = sampleRate;
    this.total = 0;
    this.preRoll = [];
    this.preRollLen = 0;
    this.active = false;
    this.chunk = [];
    this.chunkLen = 0;
    this.chunkStart = 0;
    this.speechLen = 0;
    this.silenceLen = 0;
    this.lastVoiceEnd = 0;
    this.aboveRun = 0;
    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'config') this.configure(msg.config || {});
      if (msg.type === 'flush') this.flush();
    };
  }

  configure(partial) {
    for (const key of Object.keys(DEFAULTS)) {
      const value = Number(partial[key]);
      if (Number.isFinite(value) && value > 0) this.cfg[key] = value;
    }
    this.cfg.silenceMs = Math.min(4000, Math.max(300, this.cfg.silenceMs));
    this.cfg.maxChunkMs = Math.min(28000, Math.max(3000, this.cfg.maxChunkMs));
    this.cfg.minSpeechMs = Math.min(2000, Math.max(120, this.cfg.minSpeechMs));
    this.cfg.preRollMs = Math.min(1000, Math.max(0, this.cfg.preRollMs));
    this.cfg.threshold = Math.min(0.2, Math.max(0.0005, this.cfg.threshold));
  }

  pushPreRoll(block) {
    const copy = new Float32Array(block);
    this.preRoll.push(copy);
    this.preRollLen += copy.length;
    const maxSamples = Math.round((this.cfg.preRollMs * this.rate) / 1000);
    while (this.preRollLen > maxSamples && this.preRoll.length > 1) {
      const removed = this.preRoll.shift();
      this.preRollLen -= removed.length;
    }
  }

  tailAudio(count) {
    const out = new Float32Array(count);
    let written = count;
    for (let i = this.chunk.length - 1; i >= 0 && written > 0; i--) {
      const block = this.chunk[i];
      const take = Math.min(block.length, written);
      out.set(block.subarray(block.length - take), written - take);
      written -= take;
    }
    return out;
  }

  emit(endSample) {
    if (!this.chunkLen) return;
    const flat = new Float32Array(this.chunkLen);
    let offset = 0;
    for (const block of this.chunk) {
      flat.set(block, offset);
      offset += block.length;
    }
    const startMs = Math.round((this.chunkStart / this.rate) * 1000);
    const clampedEnd = Math.min(
      this.chunkStart + this.chunkLen,
      Math.max(this.chunkStart, endSample),
    );
    const endMs = Math.round((clampedEnd / this.rate) * 1000);
    this.port.postMessage(
      { type: 'chunk', pcm: flat.buffer, startMs, endMs, sampleRate: this.rate },
      [flat.buffer],
    );
  }

  resetToIdle(keepTail) {
    const preRollSamples = Math.round((this.cfg.preRollMs * this.rate) / 1000);
    const tailCount = Math.min(this.chunkLen, preRollSamples);
    const tail = keepTail && tailCount > 0 ? this.tailAudio(tailCount) : null;
    this.active = false;
    this.chunk = [];
    this.chunkLen = 0;
    this.speechLen = 0;
    this.silenceLen = 0;
    this.aboveRun = 0;
    this.preRoll = tail ? [tail] : [];
    this.preRollLen = tail ? tail.length : 0;
  }

  finishChunk() {
    const tailSamples = Math.round((this.cfg.tailMs * this.rate) / 1000);
    const endSample = Math.min(this.lastVoiceEnd + tailSamples, this.chunkStart + this.chunkLen);
    if (this.speechLen >= Math.round((this.cfg.minSpeechMs * this.rate) / 1000)) {
      this.emit(endSample);
    }
    this.resetToIdle(true);
  }

  flush() {
    if (!this.active) return;
    const tailSamples = Math.round((this.cfg.tailMs * this.rate) / 1000);
    this.emit(Math.min(this.lastVoiceEnd + tailSamples, this.chunkStart + this.chunkLen));
    this.resetToIdle(false);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0] || !input[0].length) return true;

    const frames = input[0].length;
    let block;
    if (input.length === 1) {
      block = input[0];
    } else {
      block = new Float32Array(frames);
      for (let ch = 0; ch < input.length; ch++) {
        const channel = input[ch];
        for (let i = 0; i < frames; i++) block[i] += channel[i] / input.length;
      }
    }

    const blockStart = this.total;
    this.total += frames;

    let sum = 0;
    for (let i = 0; i < frames; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / frames);
    const voiced = rms > this.cfg.threshold;

    if (!this.active) {
      this.pushPreRoll(block);
      this.aboveRun = voiced ? this.aboveRun + 1 : 0;
      if (this.aboveRun >= this.cfg.triggerFrames) {
        this.active = true;
        this.chunk = this.preRoll.slice();
        this.chunkLen = this.preRollLen;
        this.chunkStart = Math.max(0, blockStart - this.preRollLen);
        this.speechLen = frames;
        this.silenceLen = 0;
        this.lastVoiceEnd = this.total;
        this.preRoll = [];
        this.preRollLen = 0;
      }
      return true;
    }

    this.chunk.push(new Float32Array(block));
    this.chunkLen += frames;
    if (voiced) {
      this.speechLen += frames;
      this.silenceLen = 0;
      this.lastVoiceEnd = this.total;
    } else {
      this.silenceLen += frames;
    }

    const maxSamples = Math.round((this.cfg.maxChunkMs * this.rate) / 1000);
    if (this.chunkLen >= maxSamples) {
      this.emit(this.total);
      const overlapCount = Math.min(
        Math.round((this.cfg.overlapMs * this.rate) / 1000),
        this.chunkLen,
      );
      const tail = this.tailAudio(overlapCount);
      this.chunk = [tail];
      this.chunkLen = tail.length;
      this.chunkStart = this.total - tail.length;
      this.speechLen = tail.length;
      this.silenceLen = 0;
      this.lastVoiceEnd = this.total;
      return true;
    }

    const silenceSamples = Math.round((this.cfg.silenceMs * this.rate) / 1000);
    if (this.silenceLen >= silenceSamples) {
      this.finishChunk();
    }
    return true;
  }
}

registerProcessor('transub-capture', TransubCaptureProcessor);
