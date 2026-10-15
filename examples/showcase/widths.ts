// Text widths in pixels, measured with the addon's layoutText (tools/measure.mjs),
// for the places that lay words out by arithmetic. Re-measure if a font or size changes.
export const WIDTHS = {
  // shot 2, Inter at 84 px: braces 400, words 500
  brace: 35.8,
  space: 22.4,
  rendered: 364.2,
  without: 299.9,
  a: 47.7,
  browser: 328.9,
  kine: 179.9,
  tograph: 312.8,
  // shot 10, Inter 600 at 168 px
  title: 1000.2,
};

/** Pen position before each character, then the end, for Inter 500 at 100 px (scale by size / 100): the caret of shot 4. */
export const CARET_X = {
  render: [0, 55.9, 81.1, 141.3, 200, 233.1, 293.5, 355.4, 393.7, 450.4, 512.3, 572.4, 599.1, 635.8, 694.6, 754.7, 816.6, 875.3, 914],
  looks: [
    0, 61.8, 87, 147.2, 179.6, 208.9, 235.5, 297.4, 322.6, 381.3, 441.5, 503.3, 557.1, 586.4, 613.1, 675, 713.3, 770.1,
    795.3, 855.4, 884.7, 911.4, 936.6, 961.8, 1023.7, 1083.9, 1117.9,
  ],
};
