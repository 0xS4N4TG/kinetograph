// Opens a GPU device, so it runs only on the M4: KINETOGRAPH_GPU_TESTS=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const native = require('..');

const skip = process.env.KINETOGRAPH_GPU_TESTS === '1' ? false : 'set KINETOGRAPH_GPU_TESTS=1 (opens a GPU)';
const repo = path.join(__dirname, '..', '..', '..');
const font = 'assets/fonts/DMSans-Medium.ttf';

// A moving card with a shadow, text and an image.
const sceneA = (extra = {}) =>
  JSON.stringify({
    width: 320,
    height: 180,
    fps: 30,
    durationInFrames: 30,
    background: '#14161c',
    fonts: { 'DM Sans': font },
    layers: [
      {
        id: 'card',
        type: 'shape',
        shape: { kind: 'roundedRect', width: 120, height: 70, radius: 12 },
        fill: '#f2c14e',
        transform: { x: [{ frame: 0, value: 20 }, { frame: 29, value: 180 }], y: 40 },
        effects: [{ type: 'dropShadow', x: 0, y: 8, blur: 8, color: '#00000099' }],
      },
      { id: 'title', type: 'text', text: 'Kinetograph', font: 'DM Sans', size: 28, color: '#ffffff',
        transform: { x: 16, y: 120 } },
      { id: 'photo', type: 'image', src: 'examples/card-art.png', width: 60, height: 45,
        transform: { x: 250, y: 10 } },
    ],
    ...extra,
  });

// Another size, no text, a different look.
const sceneB = () =>
  JSON.stringify({
    width: 200,
    height: 120,
    fps: 30,
    durationInFrames: 10,
    background: '#203040',
    layers: [
      {
        id: 'disc',
        type: 'shape',
        shape: { kind: 'ellipse', width: 80, height: 80 },
        fill: { type: 'radial', cx: 40, cy: 40, r: 40,
                stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#ff3366' }] },
        transform: { x: 60, y: 20 },
        effects: [{ type: 'glow', radius: 10, intensity: 1 }],
      },
    ],
  });

const rejects = (fn, code) =>
  assert.throws(fn, (e) => {
    assert.equal(e.code, code, e.message);
    return true;
  });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kinetograph-node-'));

// One second of 440 Hz in stereo.
const tone = (seconds, rate = 48000) => {
  const n = Math.round(seconds * rate);
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) left[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / rate);
  return { sampleRate: rate, channels: [left, left.map((s) => s * 0.5)] };
};

const pngSize = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];

test('still returns a PNG', { skip }, () => {
  const renderer = new native.Renderer();
  const png = renderer.still(sceneA(), 5, repo);
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(pngSize(png), [320, 180]);
  // Same frame twice: same bytes.
  assert.ok(renderer.still(sceneA(), 5, repo).equals(png));
});

test('rgba returns straight-alpha pixels', { skip }, () => {
  const renderer = new native.Renderer();
  const frame = renderer.rgba(sceneA(), 0, repo);
  assert.equal(frame.width, 320);
  assert.equal(frame.height, 180);
  assert.equal(frame.data.length, 320 * 180 * 4);
  // The background shows in the corner.
  assert.deepEqual([...frame.data.subarray(0, 4)], [0x14, 0x16, 0x1c, 0xff]);
});

test('errors have codes', { skip }, () => {
  const renderer = new native.Renderer();
  rejects(() => renderer.still(sceneA(), 30, repo), 'FRAME_OUT_OF_RANGE');
  rejects(() => renderer.still(sceneA(), -1, repo), 'INVALID_ARG');
  rejects(() => renderer.still('{', 0, repo), 'SCENE_INVALID');
  rejects(() => renderer.still(sceneA(), 0, path.join(repo, 'nowhere')), 'IO');
  rejects(() => renderer.render(sceneA(), path.join(tmp(), 'out.mkv'), { baseDir: repo }), 'INVALID_ARG');
  // A renderer that failed is still usable.
  assert.ok(renderer.still(sceneA(), 0, repo).length > 0);
});

test('a renderer takes scenes of different sizes and gives what a new one gives', { skip }, () => {
  const reused = new native.Renderer();
  const pixels = (renderer, json, frame) => renderer.rgba(json, frame, repo).data;
  const order = [
    [sceneA(), 12], [sceneB(), 3], [sceneA(), 12], [sceneB(), 3], [sceneA(), 13],
  ];
  for (const [json, frame] of order) {
    const got = pixels(reused, json, frame);
    const fresh = pixels(new native.Renderer(), json, frame);
    assert.ok(got.equals(fresh), `frame ${frame} of a ${JSON.parse(json).width} px wide scene`);
  }
});

test('the layer cache can be turned off and changes nothing', { skip }, () => {
  const cached = new native.Renderer();
  const plain = new native.Renderer({ layerCache: false });
  for (const frame of [3, 4, 4, 5, 3]) {
    assert.ok(cached.rgba(sceneA(), frame, repo).data.equals(plain.rgba(sceneA(), frame, repo).data));
  }
});

test('bench times the stages, with the handoff', { skip }, () => {
  const renderer = new native.Renderer();
  const one = renderer.bench(sceneA(), { frame: 3, runs: 4 }, repo);
  assert.equal(one.frame, 3);
  assert.equal(one.runs, 4);
  assert.equal(one.frames, undefined);
  for (const stage of ['handoff', 'resolve', 'raster', 'composite', 'readback', 'total']) {
    const s = one.stages[stage];
    assert.ok(s.min >= 0 && s.min <= s.mean && s.mean <= s.max, `${stage} ${JSON.stringify(s)}`);
  }
  assert.ok(one.stages.handoff.mean > 0 && one.stages.total.mean > 0);

  const range = renderer.bench(sceneA(), { range: '2..8' }, repo);
  assert.equal(range.frame, undefined);
  assert.equal(range.runs, 6);
  assert.deepEqual(range.frames.map((f) => f.frame), [2, 3, 4, 5, 6, 7]);
  assert.ok(range.frames.every((f) => f.totalMs > 0 && f.layersReused + f.layersDrawn > 0));

  rejects(() => renderer.bench(sceneA(), { range: '2..8', frame: 1 }, repo), 'INVALID_ARG');
  rejects(() => renderer.bench(sceneA(), { runs: 0 }, repo), 'INVALID_ARG');
  rejects(() => renderer.bench(sceneA(), { frame: 99 }, repo), 'FRAME_OUT_OF_RANGE');
});

test('render writes a video, with audio', { skip }, () => {
  const dir = tmp();
  const renderer = new native.Renderer();
  const silent = renderer.render(sceneA(), path.join(dir, 'silent.mp4'), { baseDir: repo, range: '0..12' });
  assert.equal(silent.frames, 12);
  assert.deepEqual([silent.first, silent.last, silent.width, silent.height, silent.audio], [0, 11, 320, 180, false]);
  assert.ok(fs.statSync(silent.output).size > 0);

  const out = path.join(dir, 'sound.mp4');
  const sound = renderer.render(sceneA(), out, { baseDir: repo, audio: tone(1) });
  assert.equal(sound.frames, 30);
  assert.equal(sound.audio, true);
  assert.ok(sound.ms > 0 && sound.msPerFrame > 0);
  const bytes = fs.readFileSync(out);
  assert.ok(bytes.includes(Buffer.from('mp4a')), 'an AAC audio track');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['silent.mp4', 'sound.mp4']);
});

test('beginVideo builds a video from a scene that changes every frame, with audio', { skip }, () => {
  const dir = tmp();
  const out = path.join(dir, 'frames.mp4');
  const renderer = new native.Renderer();
  const writer = renderer.beginVideo(out, { width: 320, height: 180, fps: 30 });
  // The renderer is busy while a video is open.
  rejects(() => renderer.still(sceneA(), 0, repo), 'INVALID_ARG');
  rejects(() => renderer.beginVideo(path.join(dir, 'other.mp4'), { width: 320, height: 180, fps: 30 }), 'INVALID_ARG');
  for (let frame = 0; frame < 20; frame++) {
    // A different scene each frame: the card's colour changes too.
    const scene = JSON.parse(sceneA());
    scene.layers[0].fill = `#${(0x40 + frame * 8).toString(16)}c14e`;
    scene.layers[0].transform.x = 20 + frame * 8;
    writer.pushFrame(JSON.stringify(scene), frame, repo);
  }
  rejects(() => writer.pushFrame(sceneA(), 5, repo), 'INVALID_ARG'); // out of order
  // That error ended the video.
  rejects(() => writer.finish(), 'INVALID_ARG');
  assert.deepEqual(fs.readdirSync(dir), []);

  // Again, to the end.
  const second = renderer.beginVideo(out, { width: 320, height: 180, fps: 30 });
  for (let frame = 0; frame < 15; frame++) second.pushFrame(sceneA(), frame, repo);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f === 'frames.mp4'), [], 'no file under the final name yet');
  const summary = second.finish(tone(0.5));
  assert.equal(summary.frames, 15);
  assert.equal(summary.audio, true);
  assert.deepEqual([summary.first, summary.last], [0, 14]);
  assert.ok(fs.statSync(out).size > 0);
  assert.deepEqual(fs.readdirSync(dir), ['frames.mp4']);
  rejects(() => second.finish(), 'INVALID_ARG');

  // The renderer is free again.
  assert.ok(renderer.still(sceneA(), 0, repo).length > 0);
});

test('a video of the wrong size, or aborted, leaves no file', { skip }, () => {
  const dir = tmp();
  const renderer = new native.Renderer();
  const writer = renderer.beginVideo(path.join(dir, 'a.mp4'), { width: 320, height: 180, fps: 30 });
  writer.pushFrame(sceneA(), 0, repo);
  rejects(() => writer.pushFrame(sceneB(), 1, repo), 'INVALID_ARG'); // 200x120
  assert.deepEqual(fs.readdirSync(dir), []);

  const aborted = renderer.beginVideo(path.join(dir, 'b.mp4'), { width: 320, height: 180, fps: 30 });
  aborted.pushFrame(sceneA(), 0, repo);
  aborted.pushFrame(sceneA(), 1, repo);
  aborted.abort();
  aborted.abort(); // idempotent
  assert.deepEqual(fs.readdirSync(dir), []);
  rejects(() => renderer.beginVideo(path.join(dir, 'c.mkv'), { width: 320, height: 180, fps: 30 }), 'INVALID_ARG');
  rejects(() => renderer.beginVideo(path.join(dir, 'c.mp4'), { width: 321, height: 180, fps: 30 }), 'INVALID_ARG');
});

test('renderCanvas draws a canvas layer on a transparent canvas, as RGBA or a PNG', { skip }, () => {
  const request = (extra = {}) =>
    JSON.stringify({
      width: 8,
      height: 4,
      commands: [{ op: 'fill', path: 'M0 0H4V4H0Z', paint: { type: 'color', color: '#ff0000' } }],
      fonts: {},
      baseDir: repo,
      ...extra,
    });
  const rgba = native.renderCanvas(request());
  assert.equal(rgba.length, 8 * 4 * 4);
  const px = (x, y) => [...rgba.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
  assert.deepEqual(px(1, 1), [255, 0, 0, 255]);
  assert.deepEqual(px(6, 1), [0, 0, 0, 0], 'the rest is transparent');
  const png = native.renderCanvas(request({ format: 'png' }));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  rejects(() => native.renderCanvas(request({ width: 0 })), 'INVALID_ARG', /width/);
  rejects(() => native.renderCanvas(request({ format: 'gif' })), 'INVALID_ARG', /format/);
  rejects(
    () => native.renderCanvas(request({ commands: [{ op: 'fill', path: 'M0 0 Q', paint: { type: 'color', color: '#fff' } }] })),
    'SCENE_INVALID',
    /bad path/,
  );
});

test('renderCanvas reuses one renderer: sizes alternate, a failed call changes nothing, and it is fast', { skip }, () => {
  const request = (width, color) =>
    JSON.stringify({
      width,
      height: 4,
      commands: [{ op: 'fill', path: 'M0 0H4V4H0Z', paint: { type: 'color', color } }],
      fonts: {},
      baseDir: repo,
    });
  const first = native.renderCanvas(request(8, '#ff0000'));
  // Another size, another colour, then the first again: byte for byte what it was.
  assert.equal(native.renderCanvas(request(16, '#00ff00')).length, 16 * 4 * 4);
  rejects(() => native.renderCanvas(request(0, '#00ff00')), 'INVALID_ARG', /width/);
  const again = native.renderCanvas(request(8, '#ff0000'));
  assert.deepEqual([...again], [...first]);
  // The device is not opened again: calls after the first take milliseconds, not the ~30 ms a fresh device took.
  const start = process.hrtime.bigint();
  for (let i = 0; i < 20; i += 1) native.renderCanvas(request(i % 2 ? 8 : 16, '#0000ff'));
  const perCall = Number(process.hrtime.bigint() - start) / 1e6 / 20;
  assert.ok(perCall < 15, `${perCall} ms a call`);
});
