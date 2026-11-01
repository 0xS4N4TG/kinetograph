import type { ScriptLine } from './types';

export const DEFAULT_RATE = 2.5;

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** A line's seconds: its own when it has them, else the words at `rate` words per second. */
export function lineSeconds(line: ScriptLine, rate: number): { seconds: number; estimated: boolean } {
  if (typeof line.seconds === 'number' && Number.isFinite(line.seconds) && line.seconds >= 0) {
    return { seconds: line.seconds, estimated: false };
  }
  return { seconds: wordCount(line.text) / rate, estimated: true };
}

export function totalSeconds(lines: ScriptLine[], rate: number): number {
  return lines.reduce((sum, line) => sum + lineSeconds(line, rate).seconds, 0);
}

/** Positive when the script runs past the target. */
export function overrun(total: number, target: number | undefined): number | null {
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) return null;
  return total - target;
}

export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}
