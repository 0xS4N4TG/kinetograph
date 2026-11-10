// The logic behind the "Remove background" dialog: names, labels, the options the server takes, and the message that
// asks the agent to point the video layer at the new file. No React, so it is tested on its own.

import type { InspectResult, MattingJob, MattingModelInfo, MattingQuality } from '@/api';
import { layerName, layerSource } from '@/lib/selection';
import type { InspectLayer } from '@/lib/inspect';
import { relativePath } from '@/lib/agent-message';

export const QUALITIES: { value: MattingQuality; label: string }[] = [
  { value: 'very-high', label: 'Very High' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'very-low', label: 'Very Low' },
];

export const DEFAULT_MODEL = 'modnet';
export const DEFAULT_QUALITY: MattingQuality = 'very-high';

/** The video layer a command should act on: exactly one layer is selected, it is a video, and it has a file. */
export function videoLayerOf(inspect: InspectResult | null, selected: string[]): InspectLayer | null {
  if (inspect === null || selected.length !== 1) return null;
  const find = (layers: InspectLayer[]): InspectLayer | null => {
    for (const layer of layers) {
      if (layer.id === selected[0]) return layer;
      const inside = layer.children ? find(layer.children) : null;
      if (inside) return inside;
    }
    return null;
  };
  const layer = find(inspect.layers);
  return layer !== null && layer.type === 'video' && typeof layer.src === 'string' && layer.src !== '' ? layer : null;
}

/** Whether the layer's file is on this computer (a URL cannot be matted: the file has to be read from disk). */
export function isLocalFile(src: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(src) && !src.startsWith('data:') && !src.startsWith('blob:');
}

/** `clip.mp4` for `/work/public/clip.mp4`. */
export function fileNameOf(src: string): string {
  return src.split(/[\\/]/).pop() ?? src;
}

/** Remotion's default: `clip-no-background.webm` for `clip.mp4`. */
export function defaultOutputName(src: string): string {
  const name = fileNameOf(src).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._ -]/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+$/, '');
  return `${name === '' ? 'video' : name}-no-background.webm`;
}

/** Whether `output` is a name the server takes: a `.webm` path inside public/. */
export function outputProblem(output: string): string | null {
  const name = output.trim();
  if (name === '') return 'Give the file a name.';
  if (!name.toLowerCase().endsWith('.webm')) return 'The file must end in .webm.';
  if (name.startsWith('/') || name.split('/').some((part) => part === '' || part === '.' || part === '..')) return 'Use a path inside public/.';
  if (!/^[A-Za-z0-9][A-Za-z0-9._ \-/]*\.webm$/i.test(name)) return 'Use letters, numbers, spaces, dots, dashes and underscores.';
  return null;
}

/** `25.9 MB`; decimal megabytes, as the model hosts show them. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return 'size unknown';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** `modnet · 25.9 MB`, as the dialog's Model field shows it. */
export function modelLabel(model: Pick<MattingModelInfo, 'name' | 'size'>): string {
  return `${model.name} · ${formatSize(model.size)}`;
}

export const percent = (progress: number | null): number | null => (progress === null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100));

/** What a running job is doing, in a few words. */
export function jobLine(job: MattingJob): string {
  const pct = percent(job.progress);
  const suffix = pct === null ? '' : ` ${pct}%`;
  if (job.status === 'cancelled') return 'Cancelled';
  if (job.status === 'failed') return job.error?.message ?? 'Failed';
  if (job.status === 'done') return job.kind === 'download' ? 'Downloaded' : 'Done';
  if (job.stage === 'downloading') return `Downloading ${job.model}${suffix}`;
  if (job.stage === 'finalizing') return 'Finishing the file';
  return `Removing the background${suffix}`;
}

/** The running download of `model`, if any. */
export function downloadOf(jobs: MattingJob[], model: string): MattingJob | undefined {
  return [...jobs].reverse().find((job) => job.kind === 'download' && job.model === model && job.status === 'running');
}

/** A job `next` in place of the one with its id, or added. */
export function upsertMattingJob(jobs: MattingJob[], next: MattingJob): MattingJob[] {
  const at = jobs.findIndex((job) => job.id === next.id);
  if (at < 0) return [...jobs, next];
  const copy = jobs.slice();
  copy[at] = next;
  return copy;
}

/** `staticFile('clip-no-background.webm')`. The names the server takes hold no quote. */
export const staticFileCall = (staticName: string): string => `staticFile('${staticName}')`;

/** `src={staticFile('clip-no-background.webm')}`: the one-line change, as it reads in the code. */
export const sourceChange = (staticName: string): string => `src={${staticFileCall(staticName)}}`;

/**
 * The request for the agent that swaps the video's source. Studio does not edit project code itself, so the agent
 * does, through the same permission prompt as any edit; the message says exactly which line and what it becomes.
 */
export function swapRequest(layer: InspectLayer, staticName: string, entry: string, cwd: string): string {
  const source = layerSource(layer);
  const where = source ? `the video written at ${relativePath(source.file, cwd)}:${source.line}` : `the video layer ${layerName(layer)}`;
  return [
    `Remove background finished: public/${staticName} is the same video with a transparent background (a VP9 WebM with alpha).`,
    `Point ${where} (project entry ${relativePath(entry, cwd)}) at it: change the \`src\` of that <Video> or <OffthreadVideo>, which plays ${layer.src}, to \`${staticFileCall(staticName)}\`.`,
    'Change only that one line. Do not touch the original file.',
  ].join('\n');
}
