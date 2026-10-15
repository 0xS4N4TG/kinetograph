import { readFileSync } from 'node:fs';
import * as P from './dist/paths.js';
const data = JSON.parse(readFileSync('./test/fixtures/paths.json', 'utf8'));
for (const idx of [10, 13, 14]) {
  const p = data.paths[idx];
  console.log(p.d);
  for (const s of p.points) {
    const m = P.getTangentAtLength(p.d, s.at);
    const q = P.getPointAtLength(p.d, s.at);
    console.log(s.at.toFixed(2).padStart(8), 'tan theirs', s.tangent.value.x.toFixed(3), s.tangent.value.y.toFixed(3), 'mine', m.x.toFixed(3), m.y.toFixed(3), 'pt', s.point.value.x.toFixed(2), s.point.value.y.toFixed(2), q.x.toFixed(2), q.y.toFixed(2), 'idx', JSON.stringify(s.index.value), JSON.stringify(P.getInstructionIndexAtLength(p.d, s.at)));
  }
}
