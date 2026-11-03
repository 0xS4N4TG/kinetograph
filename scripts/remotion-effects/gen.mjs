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
// Components: the same three effects (and rainFall, the heaviest WebGPU one) on <Img>, a <Video> frame and two shapes.
// Each is run on both backends it has; <dir>/public/test.mp4 is test.png as a one second video, tagged BT.709 (an untagged one is read with another colour matrix by each side):
// ffmpeg -loop 1 -i test.png -t 1 -r 30 -vf scale=out_color_matrix=bt709:out_range=tv,format=yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -c:v libx264 -crf 12 test.mp4
const FX3 = CHAIN.map(([n, p]) => `${n}(${JSON.stringify(p)})`).join(', ');
const COMPONENTS = {
  'img-fx3': { label: '<Img>', effects: FX3, render: `<Img src={staticFile('test.png')} width={960} height={540} effects={[EFFECTS]} />` },
  'video-fx3': { label: '<Video>', effects: FX3, render: `<Video src={staticFile('test.mp4')} muted effects={[EFFECTS]} />` },
  'rect-fx3': { label: '<Rect>', effects: FX3, render: `<AbsoluteFill style={{ backgroundColor: '#1d3557' }}><Rect width={600} height={360} fill="#e63946" effects={[EFFECTS]} /></AbsoluteFill>` },
  'star-fx3': { label: '<Star>', effects: FX3, render: `<AbsoluteFill style={{ backgroundColor: '#1d3557' }}><Star points={5} innerRadius={130} outerRadius={260} fill="#ffd166" effects={[EFFECTS]} /></AbsoluteFill>` },
  'img-rainFall': { label: '<Img>', effects: `rainFall(${JSON.stringify(PARAMS.rainFall)})`, render: `<Img src={staticFile('test.png')} width={960} height={540} effects={[EFFECTS]} />` },
};
for (const [id, c] of Object.entries(COMPONENTS)) {
  const used = [...c.effects.matchAll(/(\w+)\(/g)].map((m) => m[1]);
  info[id] = { sub: `(${c.label} with ${used.join(', ')})`, type: 'component', impls: ['webgl2', 'webgpu'].filter((b) => used.every((n) => info[n]?.impls.includes(b))) };
}
writeFileSync(join(dir, 'effects.json'), JSON.stringify({ version: pkg.version, effects: info }, null, 1));
const names = Object.keys(info).filter((n) => !info[n].error && n !== 'chain' && info[n].type !== 'component');
const lines = [`  chain: { effects: () => [${CHAIN.map(([n, p]) => `${n}(${JSON.stringify(p)})`).join(', ')}] },`, ...names.map((n) => `  ${n}: { ${ALPHA.has(n) ? "src: 'alpha.png', " : ''}effects: () => [${n}(${JSON.stringify(PARAMS[n] ?? {})})] },`)];
mkdirSync(join(dir, 'src'), { recursive: true });
writeFileSync(join(dir, 'src', 'index.tsx'), `import React from 'react';
import { AbsoluteFill, CanvasImage, Composition, Img, registerRoot, staticFile } from 'remotion';\nimport { Video } from '@remotion/media';\nimport { Rect, Star } from '@remotion/shapes';
${names.map((n) => `import { ${n} } from '@remotion/effects/${info[n].sub}';`).join('\n')}

const cases: Record<string, { src?: string; effects: () => any[] }> = {
  none: { effects: () => [] },
${lines.join('\n')}
};

const components: Record<string, () => React.ReactElement> = {
${Object.entries(COMPONENTS).map(([id, c]) => `  '${id}': () => ${c.render.replace('EFFECTS', c.effects)},`).join('\n')}
};

const Scene: React.FC<{ id: string }> = ({ id }) => components[id] ? components[id]!() : <CanvasImage src={staticFile(cases[id]!.src ?? 'test.png')} width={960} height={540} effects={cases[id]!.effects()} />;

registerRoot(() => (
  <>
    {[...Object.keys(cases), ...Object.keys(components)].map((id) => (
      <Composition key={id} id={id} component={Scene} durationInFrames={30} fps={30} width={960} height={540} defaultProps={{ id }} />
    ))}
  </>
));
`);
console.log(`${names.length} effects and a chain of three; ${Object.values(info).filter((e) => e.error).length} the params table does not satisfy`);
