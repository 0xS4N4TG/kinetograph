// `random(seed)`: a deterministic number in [0, 1) for a seed. The papercut
// kit seeds all its jitter with it, so the values must match Remotion's bit
// for bit (test/fixtures/random.json). A number seed is scaled by 1e10 and fed
// to Mulberry32, a public-domain 32-bit generator; a string seed is hashed to
// 32 bits first (the Java `String.hashCode` recurrence).
//
// `null` is documented as "unseeded": it returns `Math.random()`, which the
// determinism shim reseeds per frame, so it stays a pure function of the frame
// when the shim is installed.

function mulberry32(seed: number): number {
  let a = seed;
  a += 0x6d2b79f5;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hashString(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Deterministic pseudo-random number in [0, 1), bit-exact with Remotion's `random`. */
export function random(seed: number | string | null): number {
  if (seed === null) return Math.random();
  if (typeof seed === 'string') return mulberry32(hashString(seed));
  if (typeof seed === 'number') return mulberry32(seed * 10000000000);
  throw new TypeError('random() argument must be a number or a string');
}
