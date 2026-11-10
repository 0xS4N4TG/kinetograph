// "Remove background": the studio's side of video matting. The work is `@kinetographdev/video-matting` (the functions
// Remotion's `@remotion/video-matting` documents, run natively); this file loads it when asked, runs a download or a
// separation as a job whose progress goes to the window, and writes the transparent WebM into the project's public/.
// Matting is a preparation step: it writes a file once, and a render only reads that file.

import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveInside } from './agent-fs.js';
import type { MattingJob, MattingModelInfo, MattingQuality, MattingRequest, MattingStatus, StudioError } from './protocol.js';
import { StudioFailure, toStudioError } from './util.js';

/** The package, as far as the studio uses it (Remotion's documented shapes). */
export interface MattingModule {
  canUseVideoMatting(options?: { model?: string }): Promise<{ supported: boolean; reason?: string; detailedReason?: string }>;
  getAvailableModels(): { name: string; modelId: string; purpose: string; webGpuDownloadSize?: number; downloadSize?: number }[];
  isVideoMattingModelCached(options: { model: string }): Promise<boolean>;
  downloadVideoMattingModel(options: {
    model: string;
    signal?: AbortSignal;
    onProgress?: (progress: { file: string | null; progress: number; loadedBytes: number; totalBytes: number }) => void;
  }): Promise<{ alreadyDownloaded: boolean }>;
  removeVideoMattingModel(options: { model: string }): Promise<unknown>;
  separateVideoLayers(options: {
    src: string;
    model?: string;
    audio?: 'base' | 'foreground' | 'both' | 'none';
    videoBitrate?: MattingQuality | number;
    signal?: AbortSignal;
    onProgress?: (progress: { stage: 'processing' | 'finalizing'; progress: number | null }) => void;
  }): Promise<{
    foreground: { getBlob(): Promise<Blob>; dispose(): void | Promise<void> };
    base: { dispose(): void | Promise<void> };
  }>;
}

/** Loads the package; rejects when this build does not have it. Tests pass their own. */
export type MattingLoader = () => Promise<MattingModule>;

const PACKAGE = '@kinetographdev/video-matting';

/** The package from the studio's own place, else from where `kinetograph` is installed (which depends on it). */
export const loadMattingPackage: MattingLoader = async () => {
  try {
    return (await import(/* @vite-ignore */ PACKAGE)) as MattingModule;
  } catch (first) {
    try {
      const file = createRequire(createRequire(import.meta.url).resolve('kinetograph')).resolve(PACKAGE);
      return (await import(pathToFileURL(file).href)) as MattingModule;
    } catch {
      throw first;
    }
  }
};

const REASONS: Record<string, string> = {
  'window-undefined': 'Background removal needs a different environment than this one.',
  'webgpu-unavailable': 'This computer has no GPU the background-removal model can run on.',
  'webgpu-requires-secure-context': 'Background removal needs a secure context.',
  'shader-f16-unavailable': 'This GPU cannot run the model: it lacks half-precision support.',
};
const NOT_IN_BUILD = 'Background removal is not in this build of Kinetograph. Update `kinetograph` to a version that includes @kinetographdev/video-matting.';

const KEEP_JOBS = 20;
const QUALITIES = new Set<string>(['very-low', 'low', 'medium', 'high', 'very-high']);
/** The characters an output name may use: a plain file name or folders under public/, ending in `.webm`. */
const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ \-/]*\.webm$/;

export interface MattingOptions {
  /** The folder that holds the entry: `public/` is inside it, and so is every file written. */
  projectDir: string;
  load: MattingLoader;
  /** Called with a copy of a job each time it changes. */
  onJob(job: MattingJob): void;
}

interface Running {
  job: MattingJob;
  abort: AbortController;
}

const invalid = (message: string) => new StudioFailure('INVALID_ARG', message);

function messageOf(error: unknown): StudioError {
  const e = toStudioError(error);
  return e.code === 'INTERNAL' ? { code: 'MATTING', message: e.message } : e;
}

export class Matting {
  private readonly jobs: Running[] = [];
  private nextId = 1;
  private module: MattingModule | null = null;

  constructor(private readonly options: MattingOptions) {}

  private async pkg(): Promise<MattingModule> {
    if (this.module) return this.module;
    try {
      this.module = await this.options.load();
    } catch (error) {
      throw new StudioFailure('UNAVAILABLE', `${NOT_IN_BUILD} (${(error as Error).message})`);
    }
    return this.module;
  }

  /** What the dialog needs: whether matting works here, the models and whether each is cached, and the jobs so far. */
  async status(): Promise<MattingStatus> {
    const jobs = this.jobs.map((r) => ({ ...r.job }));
    let pkg: MattingModule;
    try {
      pkg = await this.pkg();
    } catch (error) {
      return { available: false, message: NOT_IN_BUILD, models: [], jobs };
    }
    const models: MattingModelInfo[] = [];
    for (const m of pkg.getAvailableModels()) {
      models.push({
        name: m.name,
        modelId: m.modelId,
        purpose: m.purpose,
        size: m.webGpuDownloadSize ?? m.downloadSize ?? null,
        cached: await pkg.isVideoMattingModelCached({ model: m.name }).catch(() => false),
      });
    }
    try {
      const can = await pkg.canUseVideoMatting();
      if (!can.supported) return { available: false, message: this.why(can), models, jobs };
    } catch (error) {
      return { available: false, message: (error as Error).message, models, jobs };
    }
    return { available: true, models, jobs };
  }

  private why(can: { reason?: string; detailedReason?: string }): string {
    const known = can.reason ? REASONS[can.reason] : undefined;
    return [known ?? 'Background removal cannot run on this computer.', can.detailedReason].filter(Boolean).join(' ');
  }

  private async knownModel(pkg: MattingModule, model: string): Promise<void> {
    if (!pkg.getAvailableModels().some((m) => m.name === model)) {
      throw invalid(`no model "${model}"; the models are: ${pkg.getAvailableModels().map((m) => m.name).join(', ')}`);
    }
  }

  private busy(model: string): Running | undefined {
    return this.jobs.find((r) => r.job.status === 'running' && r.job.model === model);
  }

  private start(job: Omit<MattingJob, 'id' | 'status' | 'error'>): Running {
    const running: Running = { job: { ...job, id: String(this.nextId++), status: 'running', error: null }, abort: new AbortController() };
    this.jobs.push(running);
    // Finished jobs are kept for a reloaded window, but not for ever.
    for (let i = 0; this.jobs.length > KEEP_JOBS && i < this.jobs.length; ) {
      if (this.jobs[i]!.job.status === 'running') i++;
      else this.jobs.splice(i, 1);
    }
    this.emit(running);
    return running;
  }

  private emit(r: Running): void {
    this.options.onJob({ ...r.job });
  }

  private update(r: Running, change: Partial<MattingJob>): void {
    if (r.job.status !== 'running') return;
    Object.assign(r.job, change);
    this.emit(r);
  }

  private finish(r: Running, outcome: { error: unknown } | null, cancelled: boolean): void {
    if (r.job.status !== 'running') return;
    if (cancelled || r.abort.signal.aborted) {
      r.job.status = 'cancelled';
    } else if (outcome) {
      r.job.status = 'failed';
      r.job.error = messageOf(outcome.error);
    } else {
      r.job.status = 'done';
      r.job.progress = 1;
    }
    this.emit(r);
  }

  private async download(pkg: MattingModule, r: Running): Promise<void> {
    await pkg.downloadVideoMattingModel({
      model: r.job.model,
      signal: r.abort.signal,
      onProgress: (p) => this.update(r, { progress: Math.min(1, Math.max(0, p.progress)) }),
    });
  }

  /** Downloads a model (which finishes at once when it is cached). */
  async downloadModel(model: string): Promise<MattingJob> {
    const pkg = await this.pkg();
    await this.knownModel(pkg, model);
    if (this.busy(model)) throw invalid(`"${model}" is already being downloaded or used`);
    const r = this.start({ kind: 'download', model, stage: 'downloading', progress: 0 });
    void this.download(pkg, r).then(
      () => this.finish(r, null, false),
      (error: unknown) => this.finish(r, { error }, false),
    );
    return { ...r.job };
  }

  async removeModel(model: string): Promise<void> {
    const pkg = await this.pkg();
    await this.knownModel(pkg, model);
    if (this.busy(model)) throw invalid(`"${model}" is in use: cancel its job first`);
    await pkg.removeVideoMattingModel({ model });
  }

  /** Where `output` goes: inside `public/` of the project, never over an existing file. */
  outputFile(output: unknown): { file: string; staticName: string } {
    if (typeof output !== 'string' || !OUTPUT_NAME.test(output) || output.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw invalid('output must be a name for a .webm file in public/, such as clip-no-background.webm');
    }
    const publicDir = join(this.options.projectDir, 'public');
    // A link in public/ must not lead the file out of the project.
    const file = resolveInside(this.options.projectDir, join('public', output));
    if (relative(publicDir, file).startsWith('..')) throw invalid('output must stay inside public/');
    if (existsSync(file)) throw invalid(`public/${output} already exists: pick another name`);
    return { file, staticName: output };
  }

  /** Removes the background of `request.input` and writes the foreground (a WebM with alpha) to public/. */
  async separate(request: MattingRequest): Promise<MattingJob> {
    if (typeof request !== 'object' || request === null) throw invalid('the body must be a MattingRequest object');
    const { input } = request;
    if (typeof input !== 'string' || !isAbsolute(input)) throw invalid('input must be the absolute path of a video file');
    if (!existsSync(input) || !statSync(input).isFile()) throw invalid(`no such video file: ${input}`);
    const model = request.model ?? 'modnet';
    const audio = request.audio ?? 'keep';
    const quality = request.quality ?? 'very-high';
    if (audio !== 'keep' && audio !== 'drop') throw invalid('audio must be "keep" or "drop"');
    if (!QUALITIES.has(quality)) throw invalid(`quality must be one of ${[...QUALITIES].join(', ')}`);
    const { file, staticName } = this.outputFile(request.output);

    const pkg = await this.pkg();
    await this.knownModel(pkg, model);
    if (this.jobs.some((r) => r.job.status === 'running' && r.job.kind === 'matte')) {
      throw invalid('a background is already being removed: wait for it or cancel it');
    }
    if (this.busy(model)) throw invalid(`"${model}" is being downloaded: wait for it to finish`);
    const cached = await pkg.isVideoMattingModelCached({ model }).catch(() => false);
    const r = this.start({
      kind: 'matte',
      model,
      stage: cached ? 'processing' : 'downloading',
      progress: 0,
      output: `public/${staticName}`,
      staticName,
    });
    void (async () => {
      if (!cached) {
        await this.download(pkg, r);
        this.update(r, { stage: 'processing', progress: 0 });
      }
      const layers = await pkg.separateVideoLayers({
        src: input,
        model,
        audio: audio === 'keep' ? 'foreground' : 'none',
        videoBitrate: quality,
        signal: r.abort.signal,
        onProgress: (p) => this.update(r, { stage: p.stage, progress: p.progress }),
      });
      try {
        const blob = await layers.foreground.getBlob();
        if (r.abort.signal.aborted) return;
        await mkdir(dirname(file), { recursive: true });
        // A half-written file must never be named like the finished one: write beside it, then move it into place.
        const partial = `${file}.${r.job.id}.part`;
        try {
          await writeFile(partial, new Uint8Array(await blob.arrayBuffer()));
          await rename(partial, file);
        } finally {
          await rm(partial, { force: true });
        }
      } finally {
        await layers.foreground.dispose();
        await layers.base.dispose();
      }
    })().then(
      () => this.finish(r, null, false),
      (error: unknown) => this.finish(r, { error }, false),
    );
    return { ...r.job };
  }

  /** Stops a running job; a download that was cancelled keeps the files it finished. */
  cancel(id: string): MattingJob {
    const r = this.jobs.find((j) => j.job.id === id);
    if (!r) throw new StudioFailure('NOT_FOUND', `no matting job "${id}"`);
    if (r.job.status === 'running') {
      r.abort.abort();
      this.finish(r, null, true);
    }
    return { ...r.job };
  }

  /** Stops every running job (the studio is closing). */
  close(): void {
    for (const r of this.jobs) if (r.job.status === 'running') this.cancel(r.job.id);
  }
}
