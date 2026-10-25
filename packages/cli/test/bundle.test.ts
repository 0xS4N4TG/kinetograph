import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleProject, cacheDir, type UnsupportedImport, familyFromModule, resolveSpecifier, syntheticEntry } from '../src/bundle.js';
import { CliError } from '../src/errors.js';
import { publicDirOf } from '../src/source.js';

describe('resolveSpecifier', () => {
  it('maps remotion to the core', () => {
    expect(resolveSpecifier('remotion')).toEqual({ kind: 'path', target: '@kinetographdev/core' });
  });

  it('maps @remotion/<pkg>[/sub] to the core subpath', () => {
    expect(resolveSpecifier('@remotion/transitions')).toEqual({ kind: 'path', target: '@kinetographdev/core/transitions' });
    expect(resolveSpecifier('@remotion/transitions/book-flip')).toEqual({ kind: 'path', target: '@kinetographdev/core/transitions/book-flip' });
    expect(resolveSpecifier('@remotion/transitions/fade')).toEqual({ kind: 'path', target: '@kinetographdev/core/transitions/fade' });
    for (const pkg of ['motion-blur', 'noise', 'paths', 'shapes', 'layout-utils', 'animation-utils', 'captions', 'fonts', 'lottie', 'gif', 'media-utils', 'media', 'light-leaks', 'starburst']) {
      expect(resolveSpecifier(`@remotion/${pkg}`)).toEqual({ kind: 'path', target: `@kinetographdev/core/${pkg}` });
    }
    expect(resolveSpecifier('@remotion/sfx')).toEqual({ kind: 'path', target: '@kinetographdev/core/sfx' });
    expect(resolveSpecifier('@remotion/zod-types')).toEqual({ kind: 'path', target: '@kinetographdev/core/zod-types' });
    expect(resolveSpecifier('@remotion/timeline-utils')).toEqual({ kind: 'path', target: '@kinetographdev/core/timeline-utils' });
    expect(resolveSpecifier('@remotion/timeline-utils/audio-waveform-worker')).toEqual({
      kind: 'path',
      target: '@kinetographdev/core/timeline-utils/audio-waveform-worker',
    });
    expect(resolveSpecifier('@remotion/webcodecs/web-fs')).toEqual({ kind: 'path', target: '@kinetographdev/core/webcodecs/web-fs' });
    expect(resolveSpecifier('@remotion/canvas')).toEqual({ kind: 'path', target: '@kinetographdev/core/canvas' });
    expect(resolveSpecifier('@remotion/media-parser')).toEqual({ kind: 'path', target: '@kinetographdev/core/media-parser' });
    for (const sub of ['node', 'web', 'universal', 'node-writer', 'worker', 'server-worker', 'worker-web-entry', 'worker-server-entry']) {
      expect(resolveSpecifier(`@remotion/media-parser/${sub}`)).toEqual({ kind: 'path', target: `@kinetographdev/core/media-parser/${sub}` });
    }
    expect(resolveSpecifier('@remotion/google-fonts')).toEqual({ kind: 'path', target: '@kinetographdev/core/google-fonts' });
  });

  it('turns @remotion/google-fonts/<Family> into a font module with the family name', () => {
    expect(resolveSpecifier('@remotion/google-fonts/Inter')).toEqual({ kind: 'font', family: 'Inter' });
    expect(resolveSpecifier('@remotion/google-fonts/DMSans')).toEqual({ kind: 'font', family: 'DM Sans' });
    expect(resolveSpecifier('@remotion/google-fonts/BebasNeue')).toEqual({ kind: 'font', family: 'Bebas Neue' });
    // Names the capitals-and-digits rule gets wrong come from the core's exception list.
    expect(resolveSpecifier('@remotion/google-fonts/JetBrainsMono')).toEqual({ kind: 'font', family: 'JetBrains Mono' });
    expect(familyFromModule('PressStart2P')).toBe('Press Start 2P');
  });

  it('refuses the Remotion packages it has no equivalent for, pointing at doctor', () => {
    const r = resolveSpecifier('@remotion/three');
    expect(r?.kind).toBe('unsupported');
    expect((r as { message: string }).message).toContain('doctor');
  });

  it('re-resolves the @kinetographdev packages from the CLI and leaves everything else alone', () => {
    expect(resolveSpecifier('@kinetographdev/react')).toEqual({ kind: 'path', target: '@kinetographdev/react' });
    expect(resolveSpecifier('@kinetographdev/audio')).toEqual({ kind: 'path', target: '@kinetographdev/audio' });
    expect(resolveSpecifier('@kinetographdev/native')).toBeNull();
    expect(resolveSpecifier('./local')).toBeNull();
    expect(resolveSpecifier('react-dom')).toBeNull();
  });

  it('re-resolves React from the CLI so a project has one React', () => {
    expect(resolveSpecifier('react')).toEqual({ kind: 'path', target: 'react' });
    expect(resolveSpecifier('react/jsx-runtime')).toEqual({ kind: 'path', target: 'react/jsx-runtime' });
    expect(resolveSpecifier('react-reconciler')).toEqual({ kind: 'path', target: 'react-reconciler' });
  });

  it('humanises module names', () => {
    expect(familyFromModule('PlayfairDisplay')).toBe('Playfair Display');
    expect(familyFromModule('NotoSansJP')).toBe('Noto Sans JP');
    expect(familyFromModule('Exo2')).toBe('Exo 2');
    expect(familyFromModule('IBMPlexSans')).toBe('IBM Plex Sans');
  });
});

describe('syntheticEntry', () => {
  it('imports the determinism shim before the project, then re-exports the core', () => {
    const lines = syntheticEntry('/p/index.tsx').trim().split('\n');
    expect(lines).toEqual([
      `import '@kinetographdev/core/determinism/install';`,
      `import '@kinetographdev/core/web/install';`,
      `import "/p/index.tsx";`,
      `export * from '@kinetographdev/core';`,
      `export { setLayoutText } from '@kinetographdev/core/layout-utils';`,
      `export { setAudioDecoder, setMediaProbe } from '@kinetographdev/core/media-utils';`,
      `export { setMediaParserAddon } from '@kinetographdev/core/media-parser';`,
      `export { setDomAddon, setDomEnvironment, stylesheetNotes } from '@kinetographdev/compat/dom';`,
    ]);
  });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-bundle-test-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe('publicDirOf', () => {
  it('is public/ beside the entry, else beside the nearest package.json (Remotion keeps the entry in src/)', () => {
    const remotion = project({ 'src/index.ts': '', 'public/a.png': '' });
    expect(publicDirOf(join(remotion, 'src', 'index.ts'))).toBe(join(remotion, 'public'));
    const flat = project({ 'index.tsx': '', 'public/a.png': '' });
    expect(publicDirOf(join(flat, 'index.tsx'))).toBe(join(flat, 'public'));
    const none = project({ 'src/index.ts': '' });
    expect(publicDirOf(join(none, 'src', 'index.ts'))).toBe(join(none, 'src', 'public'));
  });
});

describe('bundleProject', () => {
  it('bundles a project with the aliases resolved, the shim first, and the output under node_modules/.cache', async () => {
    const dir = project({
      'index.ts': [
        `import { registerRoot, interpolate } from 'remotion';`,
        `import { fade } from '@remotion/transitions/fade';`,
        `import { noise2D } from '@remotion/noise';`,
        `import { loadFont } from '@remotion/google-fonts/DMSans';`,
        `import { onFrame } from '@kinetographdev/audio';`,
        `import { helper } from './helper';`,
        `registerRoot(() => null); loadFont(); onFrame(0, () => {});`,
        `console.log(interpolate, fade, noise2D, helper);`,
      ].join('\n'),
      'helper.ts': `export const helper = 'PROJECT-HELPER';`,
    });
    const { file } = await bundleProject(join(dir, 'index.ts'));
    expect(file.startsWith(join(dir, 'node_modules', '.cache', 'kinetograph'))).toBe(true);
    expect(cacheDir(join(dir, 'index.ts'))).toBe(join(dir, 'node_modules', '.cache', 'kinetograph'));

    const code = readFileSync(file, 'utf8');
    // The shim's module is evaluated before the project's.
    const shim = code.indexOf('determinism-install');
    const projectAt = code.indexOf('PROJECT-HELPER');
    expect(shim).toBeGreaterThan(-1);
    expect(projectAt).toBeGreaterThan(shim);
    // The aliases reached the core, not Remotion.
    expect(code).toContain('packages/core/dist/index.js');
    expect(code).toContain('packages/core/dist/transitions/fade.js');
    expect(code).toContain('packages/core/dist/noise.js');
    // The font module calls makeGoogleFont with the family name.
    expect(code).toMatch(/makeGoogleFont\("DM Sans"\)/);
    // The native audio library is never bundled (the render code that imports it is not even reached).
    expect(code).not.toContain('NapiOfflineAudioContext');
  });

  it('resolves Video, OffthreadVideo, @remotion/gif and @remotion/media-utils to the one copy of the core, probe included', async () => {
    const dir = project({
      'index.ts': [
        `import { Video, OffthreadVideo, registerRoot } from 'remotion';`,
        `import { Gif, getGifDurationInSeconds } from '@remotion/gif';`,
        `import { getVideoMetadata } from '@remotion/media-utils';`,
        `registerRoot(() => null);`,
        `console.log(Video, OffthreadVideo, Gif, getGifDurationInSeconds, getVideoMetadata);`,
      ].join('\n'),
    });
    const { file } = await bundleProject(join(dir, 'index.ts'));
    const code = readFileSync(file, 'utf8');
    expect(code).toContain('packages/core/dist/gif.js');
    expect(code).toContain('packages/core/dist/media-utils.js');
    // `setMediaProbe` (re-exported by the synthetic entry) and `getVideoMetadata` (the project's) share one module.
    expect(code.match(/function setMediaProbe\(/g)).toHaveLength(1);
    expect(code).toMatch(/export \{[^}]*setMediaProbe[^}]*\}/);
    // And the module's state, the probe, is declared once.
    expect(code.match(/^(?:var|let) probeOverride\b/gm)).toHaveLength(1);
  });

  it('maps @remotion/media, registers stylesheets (Tailwind that cannot be built is warned about), and keeps an entry a package.json says has no side effects', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', sideEffects: ['*.css'] }),
      'src/index.ts': [
        `import './index.css';`,
        `import { registerRoot } from 'remotion';`,
        `import { Audio, Video } from '@remotion/media';`,
        `registerRoot(() => null);`,
        `console.log('ENTRY-RAN', Audio, Video);`,
      ].join('\n'),
      'src/index.css': `@import 'tailwindcss';`,
    });
    const { file, warnings } = await bundleProject(join(dir, 'src', 'index.ts'));
    const code = readFileSync(file, 'utf8');
    expect(code).toContain('ENTRY-RAN');
    // No Tailwind in this project: the file is registered as it is, and the problem is reported (doctor prints it).
    expect(code).toContain('noteStylesheetProblem(');
    expect(warnings.join('\n')).toContain('uses Tailwind, but the project has none that can build it');
  });

  it('bundles @remotion/sfx onto the core, and the sounds are the URLs the mix downloads', async () => {
    const dir = project({
      'index.ts': [
        `import { registerRoot, Audio } from 'remotion';`,
        `import { whip, vineBoom } from '@remotion/sfx';`,
        `registerRoot(() => null);`,
        `console.log(Audio, whip, vineBoom);`,
      ].join('\n'),
    });
    const { file } = await bundleProject(join(dir, 'index.ts'));
    const code = readFileSync(file, 'utf8');
    expect(code).toContain('packages/core/dist/sfx.js');
    expect(code).toContain('https://remotion.media/whip.wav');
  });

  it('bundles @remotion/zod-types onto the core, with the zod it resolves, for a <Composition schema>', async () => {
    const dir = project({
      'index.tsx': [
        `import { Composition, registerRoot } from 'remotion';`,
        `import { zColor, zMatrix, zTextarea } from '@remotion/zod-types';`,
        `const schema = [zColor(), zMatrix(), zTextarea()];`,
        `registerRoot(() => <Composition id="A" component={() => null} width={10} height={10} fps={30} durationInFrames={1} schema={schema} />);`,
      ].join('\n'),
    });
    const { file } = await bundleProject(join(dir, 'index.tsx'));
    const code = readFileSync(file, 'utf8');
    expect(code).toContain('packages/core/dist/zod-types.js');
    expect(code).toContain('__remotion-color');
  });

  it('bundles @remotion/timeline-utils and its waveform worker module onto the core', async () => {
    const dir = project({
      'index.ts': [
        `import { registerRoot } from 'remotion';`,
        `import { loadWaveformPeaks, sliceWaveformPeaks, extractFrames } from '@remotion/timeline-utils';`,
        `import '@remotion/timeline-utils/audio-waveform-worker';`,
        `registerRoot(() => null);`,
        `console.log(loadWaveformPeaks, sliceWaveformPeaks, extractFrames);`,
      ].join('\n'),
    });
    const { file } = await bundleProject(join(dir, 'index.ts'));
    const code = readFileSync(file, 'utf8');
    expect(code).toContain('packages/core/dist/timeline-utils/waveform.js');
    // The worker module has no code to carry; that it resolved is the point.
  });

  it('bundles @remotion/media-parser with every subpath onto the core, and the host can hand its addon over', async () => {
    const dir = project({
      'index.ts': [
        `import { registerRoot } from 'remotion';`,
        `import { parseMedia, mediaParserController } from '@remotion/media-parser';`,
        `import { nodeReader } from '@remotion/media-parser/node';`,
        `import { webReader } from '@remotion/media-parser/web';`,
        `import { universalReader } from '@remotion/media-parser/universal';`,
        `import { nodeWriter } from '@remotion/media-parser/node-writer';`,
        `import { parseMediaOnWebWorker } from '@remotion/media-parser/worker';`,
        `import { parseMediaOnServerWorker } from '@remotion/media-parser/server-worker';`,
        `import '@remotion/media-parser/worker-web-entry';`,
        `import '@remotion/media-parser/worker-server-entry';`,
        `registerRoot(() => null);`,
        `console.log(parseMedia, mediaParserController, nodeReader, webReader, universalReader, nodeWriter, parseMediaOnWebWorker, parseMediaOnServerWorker);`,
      ].join('\n'),
    });
    const { file } = await bundleProject(join(dir, 'index.ts'));
    const code = readFileSync(file, 'utf8');
    expect(code).toContain('packages/core/dist/media-parser/parse-media.js');
    expect(code).toContain('packages/core/dist/media-parser/readers.js');
    // `setMediaParserAddon` (re-exported by the synthetic entry) and the project's `parseMedia` share one module.
    expect(code.match(/function setMediaParserAddon\(/g)).toHaveLength(1);
    expect(code).toMatch(/export \{[^}]*setMediaParserAddon[^}]*\}/);
  });

  it('bundles @remotion/webcodecs with its subpaths and @remotion/canvas onto the core', async () => {
    const dir = project({
      'index.ts': [
        `import { registerRoot } from 'remotion';`,
        `import { convertMedia, createVideoDecoder, webcodecsController } from '@remotion/webcodecs';`,
        `import { bufferWriter } from '@remotion/webcodecs/buffer';`,
        `import { webFsWriter } from '@remotion/webcodecs/web-fs';`,
        `import { extractFramesOnWebWorker } from '@remotion/webcodecs/worker';`,
        `import { Canvas, createCanvasController } from '@remotion/canvas';`,
        `registerRoot(() => null);`,
        `console.log(convertMedia, createVideoDecoder, webcodecsController, bufferWriter, webFsWriter, extractFramesOnWebWorker, Canvas, createCanvasController);`,
      ].join('\n'),
    });
    const { file } = await bundleProject(join(dir, 'index.ts'));
    const code = readFileSync(file, 'utf8');
    expect(code).toContain('packages/core/dist/webcodecs/convert-media.js');
    expect(code).toContain('packages/core/dist/canvas.js');
  });

  it('bundles @remotion/rive onto the core', async () => {
    const dir = project({
      'index.tsx': [
        `import { registerRoot } from 'remotion';`,
        `import { RemotionRiveCanvas } from '@remotion/rive';`,
        `registerRoot(() => <RemotionRiveCanvas src="a.riv" />);`,
      ].join('\n'),
    });
    const { file } = await bundleProject(join(dir, 'index.tsx'));
    expect(readFileSync(file, 'utf8')).toContain('packages/core/dist/rive.js');
  });

  it('bundles @remotion/skia and @shopify/react-native-skia onto the core, and Skia is not loaded by bundling', async () => {
    const dir = project({
      'index.tsx': [
        `import { registerRoot } from 'remotion';`,
        `import { SkiaCanvas } from '@remotion/skia';`,
        `import { enableSkia } from '@remotion/skia/enable';`,
        `import { Rect, Skia } from '@shopify/react-native-skia';`,
        `registerRoot(() => <SkiaCanvas width={10} height={10}><Rect x={0} y={0} width={5} height={5} /></SkiaCanvas>);`,
        `console.log(enableSkia, Skia);`,
      ].join('\n'),
    });
    const { file } = await bundleProject(join(dir, 'index.tsx'));
    const code = readFileSync(file, 'utf8');
    expect(code).toContain('packages/core/dist/skia/canvas.js');
    // One copy of the module serves both import names.
    expect(code.match(/function SkiaCanvas\(/g)).toHaveLength(1);
  });

  it('says where a React Native Skia internal import should come from', async () => {
    expect(resolveSpecifier('@shopify/react-native-skia/lib/module/skia')).toMatchObject({ kind: 'unsupported' });
    expect(resolveSpecifier('@shopify/react-native-skia')).toEqual({ kind: 'path', target: '@kinetographdev/core/skia' });
    expect(resolveSpecifier('@remotion/skia/enable')).toEqual({ kind: 'path', target: '@kinetographdev/core/skia/enable' });
  });


  it('leaves one file per entry, replaced when the code changes', async () => {
    const dir = project({ 'index.ts': `console.log('v1');` });
    const first = await bundleProject(join(dir, 'index.ts'));
    writeFileSync(join(dir, 'index.ts'), `console.log('v2');`);
    const second = await bundleProject(join(dir, 'index.ts'));
    expect(second.file).not.toBe(first.file);
    expect(readdirSync(join(dir, 'node_modules', '.cache', 'kinetograph'))).toHaveLength(1);
    const same = await bundleProject(join(dir, 'index.ts'));
    expect(same.file).toBe(second.file);
  });

  it('fails with BUNDLE_FAILED and the location for a syntax error', async () => {
    const dir = project({ 'index.ts': `export const = ;` });
    await expect(bundleProject(join(dir, 'index.ts'))).rejects.toMatchObject({ code: 'BUNDLE_FAILED' });
  });

  it('fails with BUNDLE_FAILED naming the unsupported package', async () => {
    const dir = project({ 'index.ts': `import '@remotion/three';` });
    const error = (await bundleProject(join(dir, 'index.ts')).catch((e: unknown) => e)) as CliError;
    expect(error.code).toBe('BUNDLE_FAILED');
    expect(error.message).toContain('@remotion/three');
    expect(error.message).toContain('doctor');
  });

  it('lists every unsupported import with its file, and bundles a stub, when asked to', async () => {
    const dir = project({
      'index.ts': `import { ThreeCanvas } from '@remotion/three';\nimport './other';\nexport const x = ThreeCanvas;`,
      'other.ts': `import '@remotion/three';\nimport { Player } from '@remotion/player';\nexport const y = Player;`,
    });
    const unsupported: UnsupportedImport[] = [];
    const result = await bundleProject(join(dir, 'index.ts'), { unsupported });
    expect(result.file).toMatch(/\.mjs$/);
    expect(unsupported.map((u) => [u.specifier, basename(u.file ?? '')])).toEqual([
      ['@remotion/three', 'index.ts'],
      ['@remotion/three', 'other.ts'],
      ['@remotion/player', 'other.ts'],
    ]);
  });

  it('reads a package\'s browser map for an import that does not resolve: false is an empty module, a string its replacement', async () => {
    const dir = project({
      'index.ts': `import { v } from 'lib';\nexport const x = v;`,
      'node_modules/lib/package.json': JSON.stringify({
        name: 'lib',
        main: 'index.js',
        browser: { './node-only.js': false, 'missing-pkg': false, 'nope/sub': false, './other.js': './browser.js', 'gone': './browser.js' },
      }),
      'node_modules/lib/index.js': `const a = require('missing-pkg');\nconst b = require('./node-only.js');\nconst c = require('gone');\nexports.v = [typeof a, typeof b, c.tag].join();`,
      'node_modules/lib/node-only.js': `module.exports = 'real';`,
      'node_modules/lib/browser.js': `module.exports = { tag: 'browser' };`,
    });
    const { file } = await bundleProject(join(dir, 'index.ts'));
    const code = readFileSync(file, 'utf8');
    // `./node-only.js` exists, so it is bundled as it is; the missing ones are stubbed or replaced.
    expect(code).toMatch(/module\.exports = ["']real["']/);
    expect(code).toMatch(/tag: ["']browser["']/);
    expect(code).toContain('kinetograph-browser-empty');
  });

  it('still fails for an import that is not in the map', async () => {
    const dir = project({
      'index.ts': `import { v } from 'lib';\nexport const x = v;`,
      'node_modules/lib/package.json': JSON.stringify({ name: 'lib', main: 'index.js', browser: { other: false } }),
      'node_modules/lib/index.js': `exports.v = require('not-installed');`,
    });
    await expect(bundleProject(join(dir, 'index.ts'))).rejects.toMatchObject({ code: 'BUNDLE_FAILED' });
  });
});
