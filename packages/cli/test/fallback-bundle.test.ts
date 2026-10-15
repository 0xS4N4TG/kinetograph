import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserBundleOptions, browserEntry, buildBrowserBundle, resolveBrowserSpecifier } from '../src/fallback/bundle.js';

const settings = { composition: 'Main', inputProps: { title: 'hi' }, cwd: '/work', publicDir: '/work/public' };

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-browser-bundle-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return join(dir, 'index.tsx');
}

const main = (imports = '', body = ''): string => `
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'remotion';
${imports}
const Main = () => {
  const frame = useCurrentFrame();
  ${body}
  return (
    <AbsoluteFill style={{ backgroundColor: '#336699' }}>
      <img src={staticFile('a.png')} />
      <div style={{ width: 100, height: 50, background: 'red' }}>{frame}</div>
    </AbsoluteFill>
  );
};
registerRoot(() => <Composition id="Main" component={Main} width={320} height={180} fps={30} durationInFrames={10} />);
`;
const MAIN = main();

describe('the browser entry', () => {
  it('installs the prelude and the determinism shim before the project, and the runtime after it', () => {
    const entry = browserEntry('/work/index.tsx', settings);
    const order = ['compat/browser/prelude', 'core/determinism/install', '"/work/index.tsx"', 'installBrowserRuntime(createFrameRenderer'].map((s) => entry.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The composition and its props are the Node side's.
    expect(entry).toContain('createFrameRenderer("Main", { inputProps: {"title":"hi"} })');
  });
});

describe('resolveBrowserSpecifier', () => {
  it('points @kinetograph/react at the DOM elements', () => {
    expect(resolveBrowserSpecifier('@kinetograph/react')).toEqual({ kind: 'path', target: '@kinetograph/compat/browser' });
    expect(resolveBrowserSpecifier('@kinetograph/compat/browser/prelude')).toEqual({ kind: 'path', target: '@kinetograph/compat/browser/prelude' });
  });

  it('resolves remotion and @remotion/* as the Node bundle does', () => {
    expect(resolveBrowserSpecifier('remotion')).toEqual({ kind: 'path', target: '@kinetograph/core' });
    expect(resolveBrowserSpecifier('@remotion/shapes')).toEqual({ kind: 'path', target: '@kinetograph/core/shapes' });
    expect(resolveBrowserSpecifier('@remotion/transitions/fade')).toEqual({ kind: 'path', target: '@kinetograph/core/transitions/fade' });
    expect(resolveBrowserSpecifier('@remotion/google-fonts/DMSans')).toEqual({ kind: 'font', family: 'DM Sans' });
    expect(resolveBrowserSpecifier('@remotion/three')).toMatchObject({ kind: 'unsupported' });
  });

  it('shares one React and one React DOM with the CLI', () => {
    for (const name of ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']) {
      expect(resolveBrowserSpecifier(name)).toEqual({ kind: 'path', target: name });
    }
    expect(resolveBrowserSpecifier('left-pad')).toBeNull();
  });

  it('replaces what needs Node with stand-ins that fail when called, and the sound with ones that do nothing', () => {
    expect(resolveBrowserSpecifier('node:fs')).toMatchObject({ kind: 'stub', silent: false });
    expect(resolveBrowserSpecifier('crypto')).toMatchObject({ kind: 'stub', silent: false });
    expect(resolveBrowserSpecifier('@kinetograph/native')).toMatchObject({ kind: 'stub', silent: false });
    expect(resolveBrowserSpecifier('@kinetograph/audio')).toMatchObject({ kind: 'stub', silent: true });
    expect(resolveBrowserSpecifier('node:path')).toEqual({ kind: 'node-path' });
  });
});

describe('browserBundleOptions', () => {
  it('bundles for the browser as one ES module, with production React and the public folder fixed', () => {
    const options = browserBundleOptions('/work/index.tsx', settings);
    expect(options).toMatchObject({ bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', write: false });
    expect(options.define).toMatchObject({
      'process.env.NODE_ENV': '"production"',
      'process.env.KINETOGRAPH_PUBLIC_DIR': '"/work/public"',
    });
    expect(options.stdin?.contents).toContain('/work/index.tsx');
  });
});

describe('buildBrowserBundle', () => {
  it('bundles a Remotion project with the shim first and the DOM elements in place of the reconciler', async () => {
    const entry = project({ 'index.tsx': MAIN });
    const { code } = await buildBrowserBundle(entry, settings);
    const shim = code.indexOf('VIRTUAL_EPOCH_MS');
    const projectCode = code.indexOf('#336699');
    expect(shim).toBeGreaterThan(-1);
    expect(projectCode).toBeGreaterThan(shim);
    // The DOM elements and the runtime are in; the reconciler and the addon are not.
    expect(code).toContain('kg-layer');
    expect(code).toContain('__kinetograph');
    expect(code).not.toContain('react-reconciler');
    expect(code).not.toContain('node-web-audio-api');
    // A page-side `process` and `setImmediate` come before the shim captures the real timers.
    expect(code.indexOf('MessageChannel')).toBeLessThan(shim);
    // The paths of this machine reached the page only through the settings.
    expect(code).toContain('"/work/public"');
  });

  it('bundles the Remotion packages, Google Fonts and Node-only imports a project may use', async () => {
    const entry = project({
      'index.tsx': main(
        `import fs from 'node:fs';
         import path from 'node:path';
         import { readFileSync } from 'fs';
         import { makeStar } from '@remotion/shapes';
         import { loadFont } from '@remotion/google-fonts/Inter';
         import { onFrame } from '@kinetograph/audio';`,
        `loadFont();
         onFrame(0, () => {});
         console.log(fs, path, readFileSync, makeStar({ points: 5, innerRadius: 4, outerRadius: 8 }));`,
      ),
    });
    const { code } = await buildBrowserBundle(entry, settings);
    expect(code).toContain('makeStar');
    // Google Fonts are not downloaded by the page: the Node side registered them.
    expect(code).not.toContain('fonts.googleapis');
    expect(code).toContain('"Inter"');
  });

  it('fails with the esbuild message for a package that is not supported', async () => {
    const entry = project({ 'index.tsx': `import '@remotion/three';\n${MAIN}` });
    await expect(buildBrowserBundle(entry, settings)).rejects.toMatchObject({
      code: 'BUNDLE_FAILED',
      message: expect.stringContaining('"@remotion/three" is not supported'),
    });
  });
});
