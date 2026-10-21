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

/** A frame from a frame number, or from `MM:SS:FF` or `HH:MM:SS:FF` as `formatTimecode` writes them; null when it is neither. */
export function parseTimecode(text: string, fps: number): number | null {
  const parts = text.trim().split(':');
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  if (parts.length === 1) return Number(parts[0]);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const rate = Math.max(1, Math.round(fps));
  const [frames = 0, seconds = 0, minutes = 0, hours = 0] = parts.map(Number).reverse();
  if (seconds >= 60 || frames >= rate) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * rate + frames;
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

/** The zoom levels the viewer steps through; 1 is 100%. */
const ZOOM_STEPS = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** The next zoom level above (`direction` 1) or below (-1) `scale`; `scale` itself at either end. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > scale + 1e-9) ?? scale;
  return [...ZOOM_STEPS].reverse().find((step) => step < scale - 1e-9) ?? scale;
}
