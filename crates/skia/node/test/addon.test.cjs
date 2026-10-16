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
  assert.deepEqual(render([{ type: 'Atlas', props: {}, children: [] }], dir).unsupported.map((u) => u.element), ['Atlas']);
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
