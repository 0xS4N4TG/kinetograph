// The Skia addon on its own: what it answers for each call, without React (`npm run test:addon -w crates/skia/node`).

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const skia = require('..');

const out = () => mkdtempSync(join(tmpdir(), 'kinetograph-skia-'));
const rect = (x, color = [1, 0, 0, 1]) => ({ type: 'Rect', props: { x, y: 0, width: 4, height: 4, color }, children: [] });
const render = (nodes, outDir, size = 8) =>
  JSON.parse(skia.renderSkia(JSON.stringify({ width: size, height: size, nodes, baseDir: '', outDir })));

test('a frame is a PNG named by its pixels: equal frames share a file, different ones do not', () => {
  const dir = out();
  const a = render([rect(0)], dir);
  assert.equal(render([rect(0)], dir).path, a.path);
  assert.notEqual(render([rect(2)], dir).path, a.path);
  assert.deepEqual([a.width, a.height, a.unsupported], [8, 8, []]);
  assert.equal(readdirSync(dir).length, 2);
});

test('what is not drawn is reported, and a bad tree is an error naming the node', () => {
  const dir = out();
  assert.deepEqual(render([{ type: 'Hologram', props: {}, children: [] }], dir).unsupported.map((u) => u.element), ['Hologram']);
  assert.throws(() => render([{ type: 'Rect', props: { x: 0 }, children: [] }], dir), /Rect needs/);
  assert.throws(() => skia.renderSkia('{"width":0,"height":4,"nodes":[],"outDir":"/tmp"}'), /pixels/);
});

test('path calls: bounds, boolean ops, and a hit test', () => {
  const call = (request) => JSON.parse(skia.pathCall(JSON.stringify(request)));
  const square = 'M0 0H10V10H0Z';
  assert.deepEqual(call({ call: 'bounds', path: square }).bounds, { x: 0, y: 0, width: 10, height: 10 });
  assert.deepEqual(call({ call: 'op', op: 'union', path: square, other: 'M5 5H15V15H5Z' }).bounds, { x: 0, y: 0, width: 15, height: 15 });
  assert.equal(call({ call: 'contains', path: square, point: { x: 5, y: 5 } }).contains, true);
  assert.equal(call({ call: 'contains', path: square, point: { x: 15, y: 5 } }).contains, false);
  assert.throws(() => call({ call: 'nope', path: square }), /unknown path call/);
});

test('SkSL: uniforms are listed, and a program that does not compile is an error with Skia\'s message', () => {
  const info = JSON.parse(skia.compileEffect('uniform float t; uniform float2 size; half4 main(float2 p) { return half4(t); }'));
  assert.deepEqual(info.uniforms, [['t', 1], ['size', 2]]);
  assert.throws(() => skia.compileEffect('half4 main(float2 p) { return nope; }'), /nope/);
});

test('the pictures kept are bounded: the oldest are removed past 600', () => {
  const dir = out();
  for (let i = 0; i < 640; i += 1) render([rect(0, [i / 640, (i % 7) / 7, 0, 1])], dir, 4);
  const kept = readdirSync(dir).filter((name) => name.endsWith('.png')).length;
  assert.ok(kept <= 600 && kept >= 400, `${kept} files kept`);
});

test('svgSize answers the size an SVG declares and fails on one that does not parse', () => {
  const size = JSON.parse(skia.svgSize(JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="12"/>' })));
  assert.deepEqual(size, { width: 30, height: 12 });
  assert.throws(() => skia.svgSize(JSON.stringify({ svg: 'nope' })), /could not be parsed/);
});

test('data is kept by its content: a picture made from it has a size, pixels and a PNG', () => {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255]);
  const id = skia.putData(pixels);
  assert.equal(skia.putData(Buffer.from(pixels)), id);
  const image = { pixels: id, width: 2, height: 2 };
  assert.deepEqual(JSON.parse(skia.imageCall(JSON.stringify({ image, call: 'size' }))), { width: 2, height: 2 });
  assert.deepEqual([...skia.imageBytes(JSON.stringify({ image, format: 'rgba' }))], [...pixels]);
  const png = skia.imageBytes(JSON.stringify({ image, format: 'png' }));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const decoded = { data: skia.putData(png) };
  assert.deepEqual([...skia.imageBytes(JSON.stringify({ image: decoded, format: 'rgba' }))], [...pixels]);
});

test('measureParagraph answers the sizes and lines of a paragraph at a width', () => {
  const font = join(__dirname, '../../../../assets/fonts/DMSans-Medium.ttf');
  const text = [{ type: 'addText', text: 'a few words to wrap' }];
  const paragraph = { fonts: [{ family: 'DM Sans', file: font }], style: { textStyle: { fontSize: 16 } }, ops: text };
  const measure = (width) => JSON.parse(skia.measureParagraph(JSON.stringify({ paragraph, width })));
  assert.equal(measure(1000).lines.length, 1);
  assert.ok(measure(40).lines.length > 2);
});
