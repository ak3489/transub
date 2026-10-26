import type { CaptionSegment, ExportContent, ExportFormat, ExportOptions } from './types';
import { segmentRange } from './timeline';

function splitTime(seconds: number) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return { h, m, s, ms };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const pad3 = (n: number) => String(n).padStart(3, '0');

export function formatSrtTime(seconds: number): string {
  const { h, m, s, ms } = splitTime(seconds);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

export function formatVttTime(seconds: number): string {
  const { h, m, s, ms } = splitTime(seconds);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
}

export function formatClock(seconds: number): string {
  const { h, m, s } = splitTime(seconds);
  return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function escapeVtt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cueLines(segment: CaptionSegment, content: ExportContent): string[] {
  const original = segment.original.trim();
  const translation = segment.translation.trim();
  if (content === 'original') return original ? [original] : [];
  if (content === 'translation') return translation ? [translation] : [];
  if (!original && !translation) return [];
  return [original, translation].filter(Boolean);
}

export interface BuildSubtitleOptions extends ExportOptions {
  /** 视频时间轴偏移（秒）；捕获从视频中途开始时用于对齐 */
  baseTime?: number;
}

export function buildSubtitleFile(
  segments: CaptionSegment[],
  options: BuildSubtitleOptions,
): string {
  const usable = segments
    .filter((segment) => cueLines(segment, options.content).length > 0)
    .map((segment) => ({
      segment,
      range: segmentRange(segment, options.baseTime),
    }))
    .sort((a, b) => a.range.start - b.range.start || a.segment.start - b.segment.start);

  if (options.format === 'txt') {
    return buildTxt(usable, options);
  }

  let output = options.format === 'vtt' ? 'WEBVTT\n\n' : '';
  let index = 1;
  for (const { segment, range } of usable) {
    const lines = cueLines(segment, options.content);
    if (options.format === 'srt') {
      output += `${index}\n${formatSrtTime(range.start)} --> ${formatSrtTime(range.end)}\n`;
      output += `${lines.join('\n')}\n\n`;
    } else {
      output += `${formatVttTime(range.start)} --> ${formatVttTime(range.end)}\n`;
      output += `${lines.map(escapeVtt).join('\n')}\n\n`;
    }
    index++;
  }
  return output.trimEnd() + '\n';
}

function buildTxt(
  cues: Array<{ segment: CaptionSegment; range: { start: number; end: number } }>,
  options: BuildSubtitleOptions,
): string {
  const blocks: string[] = [];
  for (const { segment, range } of cues) {
    const lines = cueLines(segment, options.content);
    if (!lines.length) continue;
    const text = options.timestamps
      ? `[${formatClock(range.start)}] ${lines.join('\n')}`
      : lines.join('\n');
    blocks.push(text);
  }
  return blocks.join(options.timestamps ? '\n\n' : '\n') + '\n';
}

const EXTENSIONS: Record<ExportFormat, string> = {
  srt: 'srt',
  vtt: 'vtt',
  txt: 'txt',
};

export const MIME_TYPES: Record<ExportFormat, string> = {
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  txt: 'text/plain',
};

export function buildExportFilename(
  title: string,
  format: ExportFormat,
  date = new Date(),
): string {
  const cleanTitle =
    title
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48) || '字幕';
  const stamp = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    '-',
    pad2(date.getHours()),
    pad2(date.getMinutes()),
  ].join('');
  return `Transub-${cleanTitle}-${stamp}.${EXTENSIONS[format]}`;
}

export function countExportableSegments(
  segments: CaptionSegment[],
  content: ExportContent,
): number {
  return segments.filter((segment) => cueLines(segment, content).length > 0).length;
}
