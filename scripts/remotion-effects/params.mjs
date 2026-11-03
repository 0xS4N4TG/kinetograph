// The parameters each @remotion/effects effect is run with: its defaults, except where those do nothing or the effect
// needs some. One place, so the project the oracle renders and the one Kinetograph renders are the same.

const LUT = 'TITLE "swap"\nLUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n';

export const PARAMS = {
  blur: { radius: 12 }, lut: { content: LUT }, noiseDisplacement: { center: [0.5, 0.5], radius: 0.5 },
  regionBlur: { topLeft: [0.2, 0.2], bottomRight: [0.8, 0.8], blurRadius: 20 }, scale: { scale: 1.3 },
  starburst: { rays: 12, colors: ['#ff0000', '#0000ff'] }, tint: { color: '#ff0000' },
  brightness: { amount: 0.3 }, contrast: { amount: 1.6 }, saturation: { amount: 0.2 }, hue: { degrees: 90 },
  exposure: { stops: 1 }, vibrance: { amount: 0.8 }, shadowsHighlights: { shadows: 0.5, highlights: -0.5 },
  whiteBalance: { temperature: 0.4, tint: 0.2 }, levels: { blackPoint: 0.1, whitePoint: 0.9, gamma: 1.4 },
  colorCorrection: { exposure: 0.3, contrast: 1.2, saturation: 1.3, temperature: 0.2 },
  curves: { points: [[0, 0], [0.5, 0.3], [1, 1]] }, uvTranslate: { u: 0.1, v: 0.1 }, xyTranslate: { x: 40, y: 30 },
  filmBurn: { progress: 0.5 }, radialWipe: { progress: 0.5 }, irisWipe: { outerRadius: 0.6 }, rainFall: { time: 1 }, snowFall: { time: 1 },
  chromaticAberration: { amount: 12 },
  // With an edge simplification the outline polygonizes the source's alpha, which reads its pixels on the CPU.
  outline: { edgeSimplification: 6 },
};

/** Effects whose picture depends on the source's alpha: they run on a shape on a transparent canvas. */
export const ALPHA = new Set(['dropShadow', 'outline', 'longShadows', 'bevelAlpha', 'roughenEdges', 'tile', 'pattern', 'shatter', 'pageTurn', 'glow', 'shrinkwrap', 'tear']);
