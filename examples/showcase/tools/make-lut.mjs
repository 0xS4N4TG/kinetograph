// Writes public/luts/teal-orange.cube, the colour grade of shot 6:
//   node examples/showcase/tools/make-lut.mjs > examples/showcase/public/luts/teal-orange.cube
// A 17x17x17 table, red varying fastest: shadows lean teal, highlights orange,
// with a little extra contrast.
const N = 17;
const lines = ['TITLE "Teal and orange"', `LUT_3D_SIZE ${N}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
const clamp = (v) => Math.min(1, Math.max(0, v));
const contrast = (v) => clamp((v - 0.5) * 1.12 + 0.5);
for (let b = 0; b < N; b++) {
  for (let g = 0; g < N; g++) {
    for (let r = 0; r < N; r++) {
      let R = r / (N - 1);
      let G = g / (N - 1);
      let B = b / (N - 1);
      const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const shadow = Math.max(0, 0.5 - l) * 2;
      const high = Math.max(0, l - 0.45) * 1.8;
      R += high * 0.14 - shadow * 0.12;
      G += high * 0.03 + shadow * 0.05;
      B += -high * 0.16 + shadow * 0.12;
      lines.push(`${contrast(R).toFixed(5)} ${contrast(G).toFixed(5)} ${contrast(B).toFixed(5)}`);
    }
  }
}
console.log(lines.join('\n'));
