import type { VideoAnchor } from './types';

const ANCHOR_LIMIT = 4000;

function sanitizeRate(rate: unknown): number {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(16, Math.max(0.1, value));
}

export function normalizeAnchor(raw: unknown): VideoAnchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<VideoAnchor>;
  const at = Number(value.at);
  const videoTime = Number(value.videoTime);
  if (!Number.isFinite(at) || at <= 0) return null;
  if (!Number.isFinite(videoTime) || videoTime < 0) return null;
  return {
    at,
    videoTime,
    paused: !!value.paused,
    rate: sanitizeRate(value.rate),
    ...(value.seek ? { seek: true } : {}),
  };
}

/** 按时间插入锚点，超出上限时稀释较早的采样而不是直接丢弃历史 */
export function pushAnchor(
  anchors: VideoAnchor[],
  anchor: VideoAnchor,
  limit = ANCHOR_LIMIT,
): void {
  if (!anchors.length || anchor.at >= anchors[anchors.length - 1].at) {
    anchors.push(anchor);
  } else {
    let index = anchors.length - 1;
    while (index >= 0 && anchors[index].at > anchor.at) index--;
    anchors.splice(index + 1, 0, anchor);
  }
  if (anchors.length > limit) {
    const recentCount = Math.floor(limit * 0.75);
    const oldCount = anchors.length - recentCount;
    const stride = Math.ceil(oldCount / (limit - recentCount));
    const thinned = anchors.slice(0, oldCount).filter((_, index) => index % stride === 0);
    anchors.splice(0, anchors.length, ...thinned, ...anchors.slice(oldCount));
  }
}

/**
 * 把捕获时间轴上的毫秒数映射为视频媒体时间。
 * 取目标时刻之前最近的锚点向后推算；暂停时媒体时间不前进，seek 后从新位置重新开始。
 */
export function mapCaptureMsToMedia(
  captureMs: number,
  captureEpoch: number,
  anchors: VideoAnchor[],
): number | null {
  if (!Number.isFinite(captureMs) || captureMs < 0) return null;
  if (!Number.isFinite(captureEpoch) || captureEpoch <= 0) return null;
  if (!anchors.length) return null;

  const wall = captureEpoch + captureMs;
  let low = 0;
  let high = anchors.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (anchors[mid].at <= wall) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const anchor = index >= 0 ? anchors[index] : anchors[0];
  const deltaMs = wall - anchor.at;
  // 早于第一个锚点太多时，视频位置完全没有参照，放弃映射
  if (index < 0 && deltaMs < -5000) return null;
  // 超出最后一个锚点太久说明锚点已中断，继续外推不可靠
  if (index >= 0 && deltaMs > 20_000) return null;

  const rate = sanitizeRate(anchor.rate);
  const media = anchor.paused
    ? anchor.videoTime
    : anchor.videoTime + (deltaMs / 1000) * rate;
  if (!Number.isFinite(media) || media < 0) return null;
  return media;
}

/** 导出与回放统一使用的时间范围；优先媒体时间，旧会话回退到 baseTime */
export function segmentRange(
  segment: { start: number; end: number; mediaStart?: number; mediaEnd?: number },
  baseTime = 0,
): { start: number; end: number } {
  const base = Math.max(0, Number(baseTime) || 0);
  const start = Math.max(0, Number(segment.start) || 0);
  const end = Math.max(start, Number(segment.end) || 0);
  const hasMediaStart =
    typeof segment.mediaStart === 'number' && Number.isFinite(segment.mediaStart);
  if (!hasMediaStart) {
    return { start: base + start, end: Math.max(base + start + 0.4, base + end) };
  }
  const mediaStart = Math.max(0, segment.mediaStart as number);
  const hasMediaEnd =
    typeof segment.mediaEnd === 'number' && Number.isFinite(segment.mediaEnd);
  const mediaEnd = hasMediaEnd
    ? Math.max(mediaStart, segment.mediaEnd as number)
    : mediaStart + (end - start);
  return { start: mediaStart, end: Math.max(mediaStart + 0.4, mediaEnd) };
}
