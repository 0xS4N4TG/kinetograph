import { describe, expect, it } from 'vitest';

import type { MattingJob } from '../src/api';
import {
  defaultOutputName,
  downloadOf,
  formatSize,
  isLocalFile,
  jobLine,
  modelLabel,
  outputProblem,
  sourceChange,
  swapRequest,
  upsertMattingJob,
  videoLayerOf,
} from '../src/lib/matting';
import { inspectFor, intro, layer } from './fixtures';

const job = (extra: Partial<MattingJob> = {}): MattingJob => ({ id: '1', kind: 'matte', model: 'modnet', status: 'running', stage: 'processing', progress: 0.42, error: null, ...extra });

describe('matting names', () => {
  it('names the output after the video, as Remotion does', () => {
    expect(defaultOutputName('/work/public/person.mp4')).toBe('person-no-background.webm');
    expect(defaultOutputName('C:\\clips\\talk head.final.mov')).toBe('talk head.final-no-background.webm');
    expect(defaultOutputName('/a/b/ünï.mp4')).toBe('n-no-background.webm');
    expect(defaultOutputName('/a/b/.mp4')).toBe('video-no-background.webm');
  });

  it('accepts a .webm path inside public/ and says what is wrong with anything else', () => {
    expect(outputProblem('a.webm')).toBeNull();
    expect(outputProblem('cutouts/a b.webm')).toBeNull();
    expect(outputProblem('')).toMatch(/name/);
    expect(outputProblem('a.mp4')).toMatch(/\.webm/);
    expect(outputProblem('../a.webm')).toMatch(/inside public/);
    expect(outputProblem('/a.webm')).toMatch(/inside public/);
    expect(outputProblem('a//b.webm')).toMatch(/inside public/);
    expect(outputProblem("a'b.webm")).toMatch(/letters/);
  });

  it('shows sizes in decimal megabytes, and the model as "name · size"', () => {
    expect(formatSize(25_900_000)).toBe('25.9 MB');
    expect(formatSize(1_500_000_000)).toBe('1.5 GB');
    expect(formatSize(40_000)).toBe('40 kB');
    expect(formatSize(null)).toBe('size unknown');
    expect(modelLabel({ name: 'modnet', size: 25_900_000 })).toBe('modnet · 25.9 MB');
  });

  it('knows a file on this computer from a URL', () => {
    expect(isLocalFile('/work/public/a.mp4')).toBe(true);
    expect(isLocalFile('https://example.com/a.mp4')).toBe(false);
    expect(isLocalFile('blob:abc')).toBe(false);
    expect(isLocalFile('data:video/mp4;base64,AA')).toBe(false);
  });
});

describe('videoLayerOf', () => {
  const video = layer('clip', 'video', { src: '/work/public/person.mp4' });
  const result = { ...inspectFor(intro, 0), layers: [layer('bg', 'shape'), layer('group', 'group', { children: [video] })] };

  it('is the one selected layer when it is a video with a file, at any depth', () => {
    expect(videoLayerOf(result, ['clip'])).toBe(video);
  });

  it('is nothing for no selection, several, a layer that is not a video, or a video without a file', () => {
    expect(videoLayerOf(result, [])).toBeNull();
    expect(videoLayerOf(result, ['clip', 'bg'])).toBeNull();
    expect(videoLayerOf(result, ['bg'])).toBeNull();
    expect(videoLayerOf(result, ['group'])).toBeNull();
    expect(videoLayerOf(result, ['gone'])).toBeNull();
    expect(videoLayerOf(null, ['clip'])).toBeNull();
    expect(videoLayerOf({ ...result, layers: [layer('clip', 'video')] }, ['clip'])).toBeNull();
  });
});

describe('jobs', () => {
  it('says what a job is doing', () => {
    expect(jobLine(job())).toBe('Removing the background 42%');
    expect(jobLine(job({ stage: 'downloading', progress: 0.5 }))).toBe('Downloading modnet 50%');
    expect(jobLine(job({ stage: 'finalizing', progress: null }))).toBe('Finishing the file');
    expect(jobLine(job({ status: 'done' }))).toBe('Done');
    expect(jobLine(job({ kind: 'download', status: 'done' }))).toBe('Downloaded');
    expect(jobLine(job({ status: 'cancelled' }))).toBe('Cancelled');
    expect(jobLine(job({ status: 'failed', error: { code: 'MATTING', message: 'the decoder gave up' } }))).toBe('the decoder gave up');
  });

  it('keeps one entry per job, in order', () => {
    const a = job({ id: '1' });
    const b = job({ id: '2' });
    expect(upsertMattingJob([a], b)).toEqual([a, b]);
    expect(upsertMattingJob([a, b], { ...a, progress: 1 })).toEqual([{ ...a, progress: 1 }, b]);
  });

  it('finds the running download of a model', () => {
    const d = job({ id: '3', kind: 'download', model: 'ben2-base' });
    expect(downloadOf([job(), d], 'ben2-base')).toBe(d);
    expect(downloadOf([job(), d], 'modnet')).toBeUndefined();
    expect(downloadOf([{ ...d, status: 'done' }], 'ben2-base')).toBeUndefined();
  });
});

describe('the source swap', () => {
  const video = layer('clip', 'video', { src: '/work/public/person.mp4', source: { file: 'src/Scene.tsx', line: 42, column: 5 } });

  it('is one line of code', () => {
    expect(sourceChange('person-no-background.webm')).toBe("src={staticFile('person-no-background.webm')}");
  });

  it('asks the agent for that one line, naming the JSX and the file the video plays now', () => {
    const text = swapRequest(video, 'person-no-background.webm', '/work/src/index.tsx', '/work');
    expect(text).toContain('public/person-no-background.webm');
    expect(text).toContain('src/Scene.tsx:42');
    expect(text).toContain('/work/public/person.mp4');
    expect(text).toContain("`staticFile('person-no-background.webm')`");
    expect(text).toContain('Change only that one line');
  });

  it('names the layer when the JSX is not known', () => {
    const text = swapRequest(layer('clip', 'video', { src: '/work/public/person.mp4' }), 'a.webm', '/work/src/index.tsx', '/work');
    expect(text).toContain('the video layer');
    expect(text).toContain('person.mp4');
  });
});
