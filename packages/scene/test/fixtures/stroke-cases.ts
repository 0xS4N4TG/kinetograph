// Cases for `isPointInStroke`: each draws a path and sets the line state on a 2D context, and the test asks every
// pixel centre of a 100 x 80 canvas whether it is in the stroke. `stroke-chrome.json` holds Chrome's answers, made by
// `node packages/scene/test/fixtures/stroke-chrome.mjs` (Chrome for Testing is an oracle here and nowhere else).

export const WIDTH = 100;
export const HEIGHT = 80;

/** What a case needs of a 2D context: Chrome's, or the recording one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;
/** `Path2D`: the page's in Chrome, the package's in the test. */
type Path2DClass = new () => unknown;

/** Each case sets up `ctx` and returns the Path2D to ask about, or null for the current path. */
export const cases: [string, (ctx: Ctx, Path2D: Path2DClass) => unknown][] = [
  ['miter join, butt caps', (ctx: Ctx) => {
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(10, 70);
    ctx.lineTo(50, 15);
    ctx.lineTo(90, 70);
    return null;
  }],
  ['bevel join', (ctx: Ctx) => {
    ctx.lineWidth = 12;
    ctx.lineJoin = 'bevel';
    ctx.beginPath();
    ctx.moveTo(10, 70);
    ctx.lineTo(50, 15);
    ctx.lineTo(90, 70);
    return null;
  }],
  ['round join, round caps', (ctx: Ctx) => {
    ctx.lineWidth = 14;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(15, 20);
    ctx.lineTo(80, 25);
    ctx.lineTo(30, 65);
    return null;
  }],
  ['square caps', (ctx: Ctx) => {
    ctx.lineWidth = 16;
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(20, 40);
    ctx.lineTo(75, 30);
    return null;
  }],
  ['a sharp miter past the limit is a bevel', (ctx: Ctx) => {
    ctx.lineWidth = 10;
    ctx.miterLimit = 4;
    ctx.beginPath();
    ctx.moveTo(10, 75);
    ctx.lineTo(90, 40);
    ctx.lineTo(10, 55);
    return null;
  }],
  ['a sharp miter within the limit', (ctx: Ctx) => {
    ctx.lineWidth = 6;
    ctx.miterLimit = 20;
    ctx.beginPath();
    ctx.moveTo(10, 75);
    ctx.lineTo(90, 40);
    ctx.lineTo(10, 55);
    return null;
  }],
  ['dashes with an offset and square caps', (ctx: Ctx) => {
    ctx.lineWidth = 8;
    ctx.lineCap = 'square';
    ctx.setLineDash([12, 6, 3]);
    ctx.lineDashOffset = 5;
    ctx.beginPath();
    ctx.moveTo(10, 20);
    ctx.lineTo(90, 20);
    ctx.lineTo(90, 70);
    ctx.lineTo(10, 60);
    return null;
  }],
  ['a closed rectangle', (ctx: Ctx) => {
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.rect(20, 15, 60, 45);
    return null;
  }],
  ['a curve', (ctx: Ctx) => {
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(10, 70);
    ctx.bezierCurveTo(20, -10, 80, 100, 90, 15);
    return null;
  }],
  ['an arc under a stretched, turned transform', (ctx: Ctx) => {
    ctx.translate(50, 40);
    ctx.rotate(0.4);
    ctx.scale(2, 0.8);
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0.3, 4.5);
    return null;
  }],
  ['a Path2D under a transform', (ctx, Path2D) => {
    const p = new Path2D() as Ctx;
    p.moveTo(0, 0);
    p.lineTo(30, 10);
    p.quadraticCurveTo(40, 40, 10, 30);
    p.closePath();
    ctx.translate(20, 10);
    ctx.scale(1.5, 1.5);
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    return p;
  }],
  ['dashes too fine for Skia to make: a solid line', (ctx: Ctx) => {
    // 160 px of 1e-5 px dashes are 8 million dashes; Skia makes at most a million and strokes the path solid.
    ctx.lineWidth = 10;
    ctx.setLineDash([1e-5, 1e-5]);
    ctx.beginPath();
    ctx.moveTo(10, 40);
    ctx.lineTo(90, 40);
    ctx.lineTo(90, 70);
    ctx.lineTo(40, 70);
    return null;
  }],
  ['dots: subpaths of no length', (ctx: Ctx) => {
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(30, 40);
    ctx.lineTo(30, 40);
    ctx.moveTo(70, 40);
    ctx.closePath();
    return null;
  }],
];

/** The answers for every pixel centre, as a string of 0 and 1, row by row. */
export function answers(ctx: Ctx, path: unknown): string {
  let out = '';
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const hit = path === null ? ctx.isPointInStroke(x + 0.5, y + 0.5) : ctx.isPointInStroke(path, x + 0.5, y + 0.5);
      out += hit ? '1' : '0';
    }
  }
  return out;
}
