// The files `<Artifact>` asks the render to write next to the video. The registry is on `globalThis` under a symbol that
// `Symbol.for` makes the same in every copy of this package (the project's bundle holds one, the CLI that renders has
// another), as the `onFrame` registry of `@kinetograph/audio` is.

/** What an artifact holds: text, bytes, or the picture of the frame it was rendered in. */
export type ArtifactContent = string | Uint8Array | 'thumbnail';

export interface ArtifactRecord {
  filename: string;
  content: ArtifactContent;
  /** The composition frame it was rendered in. */
  frame: number;
}

const KEY = Symbol.for('kinetograph.artifacts');

function registry(): Map<string, ArtifactRecord> {
  const holder = globalThis as unknown as Record<symbol, Map<string, ArtifactRecord> | undefined>;
  return (holder[KEY] ??= new Map());
}

/** A file name inside the output folder: relative, no `..`, no empty parts. */
export function assertValidArtifactFilename(filename: unknown): asserts filename is string {
  if (typeof filename !== 'string' || filename === '') {
    throw new Error(`<Artifact> needs a filename, a non-empty string, but got ${JSON.stringify(filename)}.`);
  }
  const parts = filename.split(/[\\/]/);
  if (/^([\\/]|[A-Za-z]:)/.test(filename) || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`<Artifact filename=${JSON.stringify(filename)}> must be a relative path inside the output folder (no "..", no absolute path).`);
  }
}

/** Records an artifact; a later record of the same file replaces it. */
export function recordArtifact(record: ArtifactRecord): void {
  assertValidArtifactFilename(record.filename);
  registry().set(record.filename, record);
}

export function getArtifacts(): ArtifactRecord[] {
  return [...registry().values()];
}

export function clearArtifacts(): void {
  registry().clear();
}
