import type { RenderJob } from '@/api';

const pad = (n: number, width = 2) => String(Math.floor(n)).padStart(width, '0');

/** `MM:SS:FF` (with hours in front once there are some), counting frames at the composition's nominal rate. */
export function formatTimecode(frame: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps));
  const f = Math.max(0, Math.floor(frame));
  const seconds = Math.floor(f / rate);
  const hours = Math.floor(seconds / 3600);
  const body = `${pad((seconds % 3600) / 60)}:${pad(seconds % 60)}:${pad(f % rate)}`;
  return hours > 0 ? `${pad(hours)}:${body}` : body;
}

/** `12s`, `1m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${pad(total % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

/** Time left for a job, from its mean ms per frame so far; null before the first frame. */
export function jobEta(job: RenderJob): number | null {
  if (job.msPerFrame === null) return null;
  return Math.max(0, job.framesTotal - job.framesDone) * job.msPerFrame;
}

/** Percent of a job's frames done. */
export function jobPercent(job: RenderJob): number {
  if (job.status === 'done') return 100;
  return job.framesTotal > 0 ? Math.min(100, (job.framesDone / job.framesTotal) * 100) : 0;
}

/** A number for display: at most `digits` decimals, no trailing zeros. */
export function formatNumber(n: number, digits = 3): string {
  return String(Number(n.toFixed(digits)));
}

/** The largest size with the aspect ratio of `width` x `height` that fits in `boxWidth` x `boxHeight` (never scaled up). */
export function fitSize(
  boxWidth: number,
  boxHeight: number,
  width: number,
  height: number,
): { width: number; height: number } {
  if (boxWidth <= 0 || boxHeight <= 0 || width <= 0 || height <= 0) return { width, height };
  const scale = Math.min(boxWidth / width, boxHeight / height, 1);
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}
