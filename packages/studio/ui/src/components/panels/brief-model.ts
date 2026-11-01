import type { Brief, Platform, Reference } from './types';

export interface PlatformPreset {
  id: Platform;
  label: string;
  /** The aspect, shown beside the label. */
  ratio: string;
  size: { width: number; height: number; fps: number };
}

/** The platforms the panel offers. `custom` keeps whatever size is set. */
export const PLATFORMS: PlatformPreset[] = [
  { id: 'reel-9x16', label: 'Reel', ratio: '9:16', size: { width: 1080, height: 1920, fps: 30 } },
  { id: 'youtube-16x9', label: 'YouTube', ratio: '16:9', size: { width: 1920, height: 1080, fps: 30 } },
  { id: 'square-1x1', label: 'Square', ratio: '1:1', size: { width: 1080, height: 1080, fps: 30 } },
  { id: 'ad-slot', label: 'Ad slot', ratio: '4:5', size: { width: 1080, height: 1350, fps: 30 } },
  { id: 'custom', label: 'Custom', ratio: '', size: { width: 1920, height: 1080, fps: 30 } },
];

export const presetOf = (platform: Platform): PlatformPreset => PLATFORMS.find((p) => p.id === platform) ?? PLATFORMS[1]!;

export const DEFAULT_SECONDS = 30;
export const MIN_REFERENCES = 3;
export const MAX_REFERENCES = 5;

/** A reference row as the panel edits it: the Reference, plus what only the editor knows. */
export interface RefRow extends Reference {
  key: string;
  /** The file's name as dropped, shown while it uploads and as its label. */
  name?: string;
  uploading?: boolean;
  error?: string;
}

/** The size, length and platform as text fields, so that a half-typed number is not rewritten under the cursor. */
export interface BriefForm {
  purpose: string;
  audience: string;
  platform: Platform;
  width: string;
  height: string;
  fps: string;
  seconds: string;
  takeaway: string;
  notes: string;
  refs: RefRow[];
}

let counter = 0;
export const newKey = (): string => `ref-${++counter}`;

export function formOf(draft: Partial<Brief>): BriefForm {
  const platform = draft.platform ?? 'youtube-16x9';
  const size = draft.size ?? presetOf(platform).size;
  return {
    purpose: draft.purpose ?? '',
    audience: draft.audience ?? '',
    platform,
    width: String(size.width),
    height: String(size.height),
    fps: String(size.fps),
    seconds: String(draft.seconds ?? DEFAULT_SECONDS),
    takeaway: draft.takeaway ?? '',
    notes: draft.notes ?? '',
    refs: (draft.references ?? []).map((r) => ({ ...r, key: newKey() })),
  };
}

const num = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text));
const whole = (n: number): boolean => Number.isInteger(n) && n > 0;

/** Rows with neither a source nor a line are blank and left out of the brief. */
export const filled = (refs: RefRow[]): RefRow[] => refs.filter((r) => r.src.trim() !== '' || r.like.trim() !== '' || r.uploading || r.error);

/** What stops the brief from being sent. */
export function problems(form: BriefForm): string[] {
  const found: string[] = [];
  if (form.purpose.trim() === '') found.push('Say what the video is for.');
  if (!whole(num(form.width)) || !whole(num(form.height))) found.push('The width and height must be whole numbers above 0.');
  if (!(num(form.fps) > 0)) found.push('The frame rate must be above 0.');
  if (!(num(form.seconds) > 0)) found.push('The length must be above 0 seconds.');
  const rows = filled(form.refs);
  if (rows.some((r) => r.uploading)) found.push('A reference is still uploading.');
  else if (rows.some((r) => r.error)) found.push('A reference failed to upload: remove it or drop the file again.');
  else if (rows.some((r) => r.src.trim() === '')) found.push('Every reference needs a link or a file.');
  else if (rows.some((r) => r.like.trim() === '')) found.push('Every reference needs a line on what you like about it.');
  return found;
}

/** The longest and shortest a video usually runs on a platform, seconds. */
const LENGTHS: Partial<Record<Platform, { min?: number; max: number; what: string }>> = {
  'reel-9x16': { max: 90, what: 'a reel' },
  'square-1x1': { max: 60, what: 'a square post' },
  'ad-slot': { max: 60, what: 'an ad' },
  'youtube-16x9': { min: 10, max: 1800, what: 'a YouTube video' },
};

/** Things worth a second look; none of them stops the brief. */
export function warnings(form: BriefForm): { field: 'takeaway' | 'seconds' | 'references'; text: string }[] {
  const found: { field: 'takeaway' | 'seconds' | 'references'; text: string }[] = [];
  if (form.takeaway.trim() === '') found.push({ field: 'takeaway', text: 'No takeaway yet: say the one thing a viewer should leave with.' });
  const seconds = num(form.seconds);
  const limit = LENGTHS[form.platform];
  if (limit && seconds > 0) {
    if (seconds > limit.max) found.push({ field: 'seconds', text: `${seconds} s is long for ${limit.what} (usually up to ${limit.max} s).` });
    else if (limit.min !== undefined && seconds < limit.min) found.push({ field: 'seconds', text: `${seconds} s is short for ${limit.what} (usually at least ${limit.min} s).` });
  }
  const count = filled(form.refs).length;
  if (count < MIN_REFERENCES) found.push({ field: 'references', text: `${count} of ${MIN_REFERENCES} to ${MAX_REFERENCES} references: add a few more so the agent can see the taste.` });
  if (count > MAX_REFERENCES) found.push({ field: 'references', text: `${count} references: more than ${MAX_REFERENCES} blurs the direction; keep the best ones.` });
  return found;
}

/** The Brief to send. Call only when `problems` is empty. */
export function briefOf(form: BriefForm): Brief {
  const notes = form.notes.trim();
  return {
    purpose: form.purpose.trim(),
    audience: form.audience.trim(),
    platform: form.platform,
    size: { width: num(form.width), height: num(form.height), fps: num(form.fps) },
    seconds: num(form.seconds),
    takeaway: form.takeaway.trim(),
    references: filled(form.refs).map((r) => ({
      kind: r.kind,
      src: r.src.trim(),
      like: r.like.trim(),
      ...(r.sheet ? { sheet: r.sheet } : {}),
    })),
    ...(notes === '' ? {} : { notes }),
  };
}
