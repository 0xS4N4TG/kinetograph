// Writes the scenes of the effect goldens (crates/core/tests/scenes/effect-*.json) from examples/effects: frame 0 of
// each composition, as the addon takes it, with the picture's path made relative to the scene.
//   node scripts/effects-scenes.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openSource } from '../packages/cli/dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = `${root}examples/effects/index.tsx`;
const scenes = { 'fx-solid': 'effect-solid', 'fx-image': 'effect-image', 'fx-chain': 'effect-chain', 'fx-html': 'effect-html' };

for (const [comp, name] of Object.entries(scenes)) {
  const source = await openSource(entry, { comp });
  const frame = await source.frame(0);
  source.dispose();
  const scene = JSON.parse(frame.sceneJson);
  const relative = (layer) => {
    if (layer.type === 'image' && layer.src.endsWith('checker.png')) layer.src = 'media/checker.png';
    for (const child of layer.children ?? []) relative(child);
  };
  scene.layers.forEach(relative);
  writeFileSync(`${root}crates/core/tests/scenes/${name}.json`, `${JSON.stringify(scene)}\n`);
  console.log(`wrote ${name}.json`);
}
