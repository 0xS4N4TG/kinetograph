#!/usr/bin/env node
// Writes <dir>/src/index.tsx and <dir>/effects.json: one composition per @remotion/effects export, each a <CanvasImage>
// through that one effect, and what the installed package says about each (its backends and schema).
//
//   node scripts/remotion-effects/gen.mjs <dir>
//
// <dir> holds an install of remotion, @remotion/effects and @remotion/cli at one version (npm install --save-exact), and
// public/test.png and public/alpha.png, 960 x 540 pictures: an opaque test card and a shape on a transparent canvas.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALPHA, PARAMS } from './params.mjs';

const dir = resolve(process.argv[2] ?? '.');
const require = createRequire(join(dir, 'package.json'));
const pkgFile = require.resolve('@remotion/effects/package.json');
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
const subs = Object.keys(pkg.exports).filter((k) => k !== '.' && k !== './package.json');
const info = {};
for (const sub of subs) {
  const exports = await import(pathToFileURL(join(dirname(pkgFile), pkg.exports[sub].import)).href);
  for (const [name, factory] of Object.entries(exports)) {
    if (typeof factory !== 'function') continue;
    try {
      const { definition } = factory(PARAMS[name] ?? {});
      info[name] = { sub: sub.slice(2), type: definition.type, impls: Object.keys(definition.implementations ?? { [definition.backend]: 1 }) };
    } catch (error) {
      info[name] = { sub: sub.slice(2), error: error.message };
    }
  }
}
// Effects compose: a chain of three, run in order on one picture (all of them have WebGL 2 and WebGPU implementations).
const CHAIN = [['blur', { radius: 4 }], ['grayscale', { amount: 0.5 }], ['vignette', {}]];
info.chain = { sub: '(chain of blur, grayscale, vignette)', type: 'chain', impls: ['webgl2', 'webgpu'], chain: CHAIN.map(([n]) => n) };
writeFileSync(join(dir, 'effects.json'), JSON.stringify({ version: pkg.version, effects: info }, null, 1));
const names = Object.keys(info).filter((n) => !info[n].error && n !== 'chain');
const lines = [`  chain: { effects: () => [${CHAIN.map(([n, p]) => `${n}(${JSON.stringify(p)})`).join(', ')}] },`, ...names.map((n) => `  ${n}: { ${ALPHA.has(n) ? "src: 'alpha.png', " : ''}effects: () => [${n}(${JSON.stringify(PARAMS[n] ?? {})})] },`)];
mkdirSync(join(dir, 'src'), { recursive: true });
writeFileSync(join(dir, 'src', 'index.tsx'), `import React from 'react';
import { CanvasImage, Composition, registerRoot, staticFile } from 'remotion';
${names.map((n) => `import { ${n} } from '@remotion/effects/${info[n].sub}';`).join('\n')}

const cases: Record<string, { src?: string; effects: () => any[] }> = {
  none: { effects: () => [] },
${lines.join('\n')}
};

const Scene: React.FC<{ id: string }> = ({ id }) => <CanvasImage src={staticFile(cases[id]!.src ?? 'test.png')} width={960} height={540} effects={cases[id]!.effects()} />;

registerRoot(() => (
  <>
    {Object.keys(cases).map((id) => (
      <Composition key={id} id={id} component={Scene} durationInFrames={30} fps={30} width={960} height={540} defaultProps={{ id }} />
    ))}
  </>
));
`);
console.log(`${names.length} effects and a chain of three; ${Object.values(info).filter((e) => e.error).length} the params table does not satisfy`);
