import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneJson } from '@kinetographdev/scene';
import { effectsReport, parityStatus, parsePreferredEffectBackend, setPreferredEffectBackend } from '../src/effects.js';
import { run } from '../src/index.js';
import { setNativeForTests } from '../src/native.js';
import type { Source } from '../src/source.js';
import { fakeNative } from './helpers.js';

// `openSource` is the seam to a project's bundle: a stand-in `Source` that records the backend the global held when it was opened.
const seam = vi.hoisted(() => ({ source: undefined as undefined | (() => unknown), backend: [] as unknown[] }));
vi.mock('../src/source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/source.js')>();
  return {
    ...actual,
    openSource: (entry: string, options: object) => {
      seam.backend.push((globalThis as { remotion_preferredEffectBackend?: string }).remotion_preferredEffectBackend);
      return seam.source?.() ?? actual.openSource(entry, options);
    },
  };
});

const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-effects-test-'));
const global = globalThis as { remotion_preferredEffectBackend?: string };

async function cli(...argv: string[]): Promise<{ code: number; json: any; text: string }> {
  const out: string[] = [];
  const code = await run(argv, { out: (s) => void out.push(s), err: () => undefined });
  const text = out.join('');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { code, json, text };
}

/** A project in a folder with `@remotion/effects` at `version`, whose bundle names `subs`. */
function project(version: string, subs: string[]): Source {
  const dir = scratch();
  mkdirSync(join(dir, 'node_modules', '@remotion', 'effects'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@remotion', 'effects', 'package.json'), JSON.stringify({ name: '@remotion/effects', version }));
  const bundleFile = join(dir, 'bundle.mjs');
  writeFileSync(bundleFile, subs.map((s) => `// ../node_modules/@remotion/effects/dist/esm/${s}.mjs\nvar x = 1;`).join('\n'));
  const scene: SceneJson = { width: 4, height: 4, fps: 30, durationInFrames: 2, background: '#000', fonts: {}, layers: [] };
  return {
    kind: 'project',
    entry: join(dir, 'index.tsx'),
    baseDir: dir,
    composition: { id: 'Main', width: 4, height: 4, fps: 30, durationInFrames: 2, defaultProps: {} },
    frame: async () => ({ sceneJson: JSON.stringify(scene), audio: [], sequences: [], unsupported: [], jsMs: 1, stringifyMs: 0 }),
    worker: { entry: join(dir, 'index.tsx'), comp: 'Main', bundleFile },
    dispose: () => undefined,
  };
}

beforeEach(() => {
  setNativeForTests(fakeNative().native);
  seam.source = undefined;
  seam.backend = [];
  delete global.remotion_preferredEffectBackend;
});
afterEach(() => {
  setNativeForTests(undefined);
  delete global.remotion_preferredEffectBackend;
});

describe('--preferred-effect-backend', () => {
  it('takes a backend, or auto, and refuses anything else', () => {
    expect(['webgpu', 'webgl2', '2d', 'auto'].map(parsePreferredEffectBackend)).toEqual(['webgpu', 'webgl2', '2d', 'auto']);
    expect(parsePreferredEffectBackend(undefined)).toBeUndefined();
    expect(() => parsePreferredEffectBackend('metal')).toThrow(/must be "auto", "webgpu", "webgl2" or "2d", got metal/);
  });

  it('sets window.remotion_preferredEffectBackend before the project opens, and clears it for the next command', async () => {
    seam.source = () => project('4.0.540', []);
    for (const command of [['still', 'index.tsx', '0'], ['strip', 'index.tsx'], ['onion', 'index.tsx', '0..2']]) {
      await cli(...command, '--preferred-effect-backend', 'webgl2', '-o', join(scratch(), 'o.png'));
    }
    await cli('still', 'index.tsx', '0', '-o', join(scratch(), 'o.png'));
    expect(seam.backend).toEqual(['webgl2', 'webgl2', 'webgl2', undefined]);
  });

  it('is refused with INVALID_ARG when it is not a backend', async () => {
    seam.source = () => project('4.0.540', []);
    const r = await cli('still', 'index.tsx', '0', '--preferred-effect-backend', 'metal', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('INVALID_ARG');
  });

  it('is an option of render, still, strip and onion', async () => {
    for (const command of ['render', 'still', 'strip', 'onion']) {
      const r = await cli(command, '--help');
      expect(r.text, command).toContain('--preferred-effect-backend');
    }
  });
});

describe('doctor and @remotion/effects', () => {
  it('has the version and statuses of the last parity run', () => {
    const parity = parityStatus();
    expect(parity.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(parity.effects.blur).toEqual({ sub: 'blur', status: 'supported' });
  });

  it('names nothing when the project does not use the package', () => {
    expect(effectsReport(scratch(), 'var x = 1;')).toBeNull();
  });

  it('warns when the installed version is not the one the parity run used, and lists effects that are not supported', () => {
    const parity = { version: '4.0.540', effects: { blur: { sub: 'blur', status: 'supported' }, tear: { sub: 'tear', status: 'approximated' }, tile: { sub: 'tile', status: 'not yet' }, shatter: { sub: 'shatter', status: 'approximated' } } };
    const { entry, worker } = project('4.0.541', ['blur', 'tear', 'tile']);
    const dir = entry.slice(0, entry.lastIndexOf('/'));
    const bundle = readFileSync(worker!.bundleFile, 'utf8');
    const report = effectsReport(dir, bundle, parity)!;
    expect(report.installed).toBe('4.0.541');
    expect(report.lines[0]).toBe('@remotion/effects 4.0.541 (the parity run was against 4.0.540: effects may differ)');
    expect(report.gaps).toEqual([{ name: 'tear', status: 'approximated' }, { name: 'tile', status: 'not yet' }]);
    expect(effectsReport(dir, bundle, { ...parity, version: '4.0.541' })!.lines[0]).toBe('@remotion/effects 4.0.541');
  });

  it('adds the lines to the report of a project', async () => {
    seam.source = () => project('4.0.540', ['blur', 'tile']);
    const r = await cli('doctor', 'index.tsx');
    expect(r.text).toContain('@remotion/effects 4.0.540');
    expect(r.text).toContain('tile(): not yet');
    expect(r.text).not.toContain('blur(): ');
    const json = (await cli('doctor', 'index.tsx', '--json')).json;
    expect(json.effects).toMatchObject({ installed: '4.0.540', tested: '4.0.540', gaps: [{ name: 'tile', status: 'not yet' }] });
  });
});
