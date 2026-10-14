// `@remotion/noise`: seeded 2D, 3D and 4D simplex noise in [-1, 1].
//
// Simplex noise is Stefan Gustavson's public algorithm, written out here from
// its public description. Two details were fixed by probing the published
// package (test/fixtures/noise.json), not by any description of it:
//  - the output scale factors are 70, 32 and 27 (2D, 3D, 4D);
//  - the permutation table is shuffled with a generator that returns the same
//    number on every call, `random(seed)`, so a seed gives a fixed (and not very
//    mixed) table. A real PRNG here would give different noise.
// Matching it is the point: a project ported from Remotion keeps its look.

import { random } from './random.js';

const GRAD2 = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1]);
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0,
  -1, -1,
]);
const GRAD4 = new Float32Array([
  0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 1, 0,
  1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1, -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1, 1, 1, 0, 1,
  1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1, -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1, 1, 1, 1, 0, 1, 1,
  -1, 0, 1, -1, 1, 0, 1, -1, -1, 0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0,
]);

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;
const F4 = (Math.sqrt(5) - 1) / 4;
const G4 = (5 - Math.sqrt(5)) / 20;

const floor = (x: number) => Math.floor(x);

function permutationTable(random: () => number): { perm: Uint8Array; permMod12: Uint8Array } {
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 0; i < 255; i++) {
    const r = i + ~~(random() * (256 - i));
    const aux = perm[i]!;
    perm[i] = perm[r]!;
    perm[r] = aux;
  }
  for (let i = 256; i < 512; i++) perm[i] = perm[i - 256]!;
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) permMod12[i] = perm[i]! % 12;
  return { perm, permMod12 };
}

type Tables = ReturnType<typeof permutationTable>;
const tableCache = new Map<string, Tables>();

// One table per seed and dimension, as the published package keeps one generator per seed. The 3D and 4D
// tables are shuffled with `random` applied to the seed once more than the 2D one (the constant is
// random(seed) in 2D and random(random(seed)) in 3D and 4D), which is what the recorded values require.
function tablesFor(seed: string | number, depth: number): Tables {
  const key = `${depth}:${typeof seed}:${seed}`;
  let tables = tableCache.get(key);
  if (!tables) {
    let constant = random(seed);
    for (let i = 1; i < depth; i++) constant = random(constant);
    tables = permutationTable(() => constant);
    if (tableCache.size > 256) tableCache.clear();
    tableCache.set(key, tables);
  }
  return tables;
}

export function noise2D(seed: string | number, x: number, y: number): number {
  const { perm, permMod12 } = tablesFor(seed, 1);
  let n0 = 0;
  let n1 = 0;
  let n2 = 0;
  const s = (x + y) * F2;
  const i = floor(x + s);
  const j = floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  let i1: number;
  let j1: number;
  if (x0 > y0) {
    i1 = 1;
    j1 = 0;
  } else {
    i1 = 0;
    j1 = 1;
  }
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const ii = i & 255;
  const jj = j & 255;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 >= 0) {
    const gi0 = permMod12[ii + perm[jj]!]! * 2;
    t0 *= t0;
    n0 = t0 * t0 * (GRAD2[gi0]! * x0 + GRAD2[gi0 + 1]! * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 >= 0) {
    const gi1 = permMod12[ii + i1 + perm[jj + j1]!]! * 2;
    t1 *= t1;
    n1 = t1 * t1 * (GRAD2[gi1]! * x1 + GRAD2[gi1 + 1]! * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 >= 0) {
    const gi2 = permMod12[ii + 1 + perm[jj + 1]!]! * 2;
    t2 *= t2;
    n2 = t2 * t2 * (GRAD2[gi2]! * x2 + GRAD2[gi2 + 1]! * y2);
  }
  return 70 * (n0 + n1 + n2);
}

export function noise3D(seed: string | number, x: number, y: number, z: number): number {
  const { perm, permMod12 } = tablesFor(seed, 2);
  let n0: number;
  let n1: number;
  let n2: number;
  let n3: number;
  const s = (x + y + z) * F3;
  const i = floor(x + s);
  const j = floor(y + s);
  const k = floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const z0 = z - (k - t);
  let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
  if (x0 >= y0) {
    if (y0 >= z0) {
      i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    } else if (x0 >= z0) {
      i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
    } else {
      i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
    }
  } else if (y0 < z0) {
    i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
  } else if (x0 < z0) {
    i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
  } else {
    i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
  }
  const x1 = x0 - i1 + G3;
  const y1 = y0 - j1 + G3;
  const z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3;
  const y2 = y0 - j2 + 2 * G3;
  const z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3;
  const y3 = y0 - 1 + 3 * G3;
  const z3 = z0 - 1 + 3 * G3;
  const ii = i & 255;
  const jj = j & 255;
  const kk = k & 255;
  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 < 0) n0 = 0;
  else {
    const gi0 = permMod12[ii + perm[jj + perm[kk]!]!]! * 3;
    t0 *= t0;
    n0 = t0 * t0 * (GRAD3[gi0]! * x0 + GRAD3[gi0 + 1]! * y0 + GRAD3[gi0 + 2]! * z0);
  }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 < 0) n1 = 0;
  else {
    const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]!]!]! * 3;
    t1 *= t1;
    n1 = t1 * t1 * (GRAD3[gi1]! * x1 + GRAD3[gi1 + 1]! * y1 + GRAD3[gi1 + 2]! * z1);
  }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 < 0) n2 = 0;
  else {
    const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]!]!]! * 3;
    t2 *= t2;
    n2 = t2 * t2 * (GRAD3[gi2]! * x2 + GRAD3[gi2 + 1]! * y2 + GRAD3[gi2 + 2]! * z2);
  }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 < 0) n3 = 0;
  else {
    const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]!]!]! * 3;
    t3 *= t3;
    n3 = t3 * t3 * (GRAD3[gi3]! * x3 + GRAD3[gi3 + 1]! * y3 + GRAD3[gi3 + 2]! * z3);
  }
  return 32 * (n0 + n1 + n2 + n3);
}

export function noise4D(seed: string | number, x: number, y: number, z: number, w: number): number {
  const { perm } = tablesFor(seed, 2);
  let n0: number;
  let n1: number;
  let n2: number;
  let n3: number;
  let n4: number;
  const s = (x + y + z + w) * F4;
  const i = floor(x + s);
  const j = floor(y + s);
  const k = floor(z + s);
  const l = floor(w + s);
  const t = (i + j + k + l) * G4;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const z0 = z - (k - t);
  const w0 = w - (l - t);
  let rankx = 0;
  let ranky = 0;
  let rankz = 0;
  let rankw = 0;
  if (x0 > y0) rankx++;
  else ranky++;
  if (x0 > z0) rankx++;
  else rankz++;
  if (x0 > w0) rankx++;
  else rankw++;
  if (y0 > z0) ranky++;
  else rankz++;
  if (y0 > w0) ranky++;
  else rankw++;
  if (z0 > w0) rankz++;
  else rankw++;
  const i1 = rankx >= 3 ? 1 : 0;
  const j1 = ranky >= 3 ? 1 : 0;
  const k1 = rankz >= 3 ? 1 : 0;
  const l1 = rankw >= 3 ? 1 : 0;
  const i2 = rankx >= 2 ? 1 : 0;
  const j2 = ranky >= 2 ? 1 : 0;
  const k2 = rankz >= 2 ? 1 : 0;
  const l2 = rankw >= 2 ? 1 : 0;
  const i3 = rankx >= 1 ? 1 : 0;
  const j3 = ranky >= 1 ? 1 : 0;
  const k3 = rankz >= 1 ? 1 : 0;
  const l3 = rankw >= 1 ? 1 : 0;
  const x1 = x0 - i1 + G4;
  const y1 = y0 - j1 + G4;
  const z1 = z0 - k1 + G4;
  const w1 = w0 - l1 + G4;
  const x2 = x0 - i2 + 2 * G4;
  const y2 = y0 - j2 + 2 * G4;
  const z2 = z0 - k2 + 2 * G4;
  const w2 = w0 - l2 + 2 * G4;
  const x3 = x0 - i3 + 3 * G4;
  const y3 = y0 - j3 + 3 * G4;
  const z3 = z0 - k3 + 3 * G4;
  const w3 = w0 - l3 + 3 * G4;
  const x4 = x0 - 1 + 4 * G4;
  const y4 = y0 - 1 + 4 * G4;
  const z4 = z0 - 1 + 4 * G4;
  const w4 = w0 - 1 + 4 * G4;
  const ii = i & 255;
  const jj = j & 255;
  const kk = k & 255;
  const ll = l & 255;
  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0;
  if (t0 < 0) n0 = 0;
  else {
    const gi0 = (perm[ii + perm[jj + perm[kk + perm[ll]!]!]!]! % 32) * 4;
    t0 *= t0;
    n0 = t0 * t0 * (GRAD4[gi0]! * x0 + GRAD4[gi0 + 1]! * y0 + GRAD4[gi0 + 2]! * z0 + GRAD4[gi0 + 3]! * w0);
  }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1;
  if (t1 < 0) n1 = 0;
  else {
    const gi1 = (perm[ii + i1 + perm[jj + j1 + perm[kk + k1 + perm[ll + l1]!]!]!]! % 32) * 4;
    t1 *= t1;
    n1 = t1 * t1 * (GRAD4[gi1]! * x1 + GRAD4[gi1 + 1]! * y1 + GRAD4[gi1 + 2]! * z1 + GRAD4[gi1 + 3]! * w1);
  }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2;
  if (t2 < 0) n2 = 0;
  else {
    const gi2 = (perm[ii + i2 + perm[jj + j2 + perm[kk + k2 + perm[ll + l2]!]!]!]! % 32) * 4;
    t2 *= t2;
    n2 = t2 * t2 * (GRAD4[gi2]! * x2 + GRAD4[gi2 + 1]! * y2 + GRAD4[gi2 + 2]! * z2 + GRAD4[gi2 + 3]! * w2);
  }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3;
  if (t3 < 0) n3 = 0;
  else {
    const gi3 = (perm[ii + i3 + perm[jj + j3 + perm[kk + k3 + perm[ll + l3]!]!]!]! % 32) * 4;
    t3 *= t3;
    n3 = t3 * t3 * (GRAD4[gi3]! * x3 + GRAD4[gi3 + 1]! * y3 + GRAD4[gi3 + 2]! * z3 + GRAD4[gi3 + 3]! * w3);
  }
  let t4 = 0.6 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4;
  if (t4 < 0) n4 = 0;
  else {
    const gi4 = (perm[ii + 1 + perm[jj + 1 + perm[kk + 1 + perm[ll + 1]!]!]!]! % 32) * 4;
    t4 *= t4;
    n4 = t4 * t4 * (GRAD4[gi4]! * x4 + GRAD4[gi4 + 1]! * y4 + GRAD4[gi4 + 2]! * z4 + GRAD4[gi4 + 3]! * w4);
  }
  return 27 * (n0 + n1 + n2 + n3 + n4);
}
