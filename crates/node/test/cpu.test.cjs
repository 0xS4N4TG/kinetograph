// CPU only: nothing here opens a GPU device.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require('..');

const repo = path.join(__dirname, '..', '..', '..');
const font = 'assets/fonts/DMSans-Medium.ttf';

const scene = (extra = {}) =>
  JSON.stringify({
    width: 320,
    height: 180,
    fps: 30,
    durationInFrames: 60,
    fonts: { 'DM Sans': font },
    layers: [
      {
        id: 'card',
        type: 'shape',
        shape: { kind: 'rect', width: 100, height: 50 },
        fill: '#ffffff',
        transform: { x: [{ frame: 0, value: 0 }, { frame: 30, value: 90 }], scale: 2 },
        effects: [{ type: 'dropShadow', x: 0, y: 8, blur: 6, color: '#00000080' }],
      },
      { id: 'title', type: 'text', text: 'hello\nworld', font: 'DM Sans', size: 24, color: '#fff' },
    ],
    ...extra,
  });

// An error thrown by the addon is an Error with a `code`.
const rejects = (fn, code, message) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof Error, 'an Error');
    assert.equal(e.code, code, e.message);
    if (message) assert.match(e.message, message);
    return true;
  });

test('validateScene reports the scene', () => {
  const info = native.validateScene(scene(), repo);
  assert.deepEqual(info, { width: 320, height: 180, fps: 30, durationInFrames: 60, margin: info.margin });
  // The drop shadow's reach is the margin.
  assert.ok(info.margin > 0);
});

test('validateScene errors are SCENE_INVALID or IO, with the Rust text', () => {
  rejects(() => native.validateScene('{ nope', repo), 'SCENE_INVALID', /invalid scene/);
  rejects(
    () => native.validateScene(scene({ width: 0 }), repo),
    'SCENE_INVALID',
    /width and height must be/,
  );
  const dup = JSON.stringify({
    width: 8, height: 8, fps: 30, durationInFrames: 1,
    layers: [
      { id: 'a', type: 'group', children: [] },
      { id: 'a', type: 'group', children: [] },
    ],
  });
  rejects(() => native.validateScene(dup), 'SCENE_INVALID', /duplicate layer id "a"/);
  // A file the scene names that is not there.
  rejects(
    () => native.validateScene(scene({ fonts: { 'DM Sans': 'assets/fonts/nope.ttf' } }), repo),
    'IO',
    /nope\.ttf/,
  );
  const image = JSON.stringify({
    width: 8, height: 8, fps: 30, durationInFrames: 1,
    layers: [{ id: 'p', type: 'image', src: 'missing/pic.png', width: 8, height: 8 }],
  });
  rejects(() => native.validateScene(image, repo), 'IO', /missing[\\/]pic\.png/);
  // The same scene is fine where the file is.
  assert.equal(
    native.validateScene(
      JSON.stringify({
        width: 8, height: 8, fps: 30, durationInFrames: 1,
        layers: [{ id: 'p', type: 'image', src: 'examples/card-art.png', width: 8, height: 8 }],
      }),
      repo,
    ).width,
    8,
  );
});

test('inspect returns the resolved scene as JSON', () => {
  const result = JSON.parse(native.inspect(scene(), 15, repo));
  assert.equal(result.frame, 15);
  assert.equal(result.durationInFrames, 60);
  assert.equal(result.camera, null);
  assert.deepEqual(result.layers.map((l) => [l.id, l.type]), [['card', 'shape'], ['title', 'text']]);
  const [card, title] = result.layers;
  // Halfway through the keyframes, scaled by two.
  assert.equal(card.transform.x, 45);
  assert.deepEqual(card.matrix, [2, 0, 0, 2, 45, 0]);
  assert.deepEqual(card.box, { x: 0, y: 0, width: 100, height: 50 });
  assert.deepEqual(card.effects, ['dropShadow']);
  // The shadow reaches below the card.
  assert.ok(card.bounds.y + card.bounds.height > 100);
  assert.equal(title.text.text, 'hello\nworld');
  assert.deepEqual(title.text.lines.map((l) => l.text), ['hello', 'world']);
  assert.ok(title.text.lines[1].top >= title.text.lines[0].bottom - 0.001);
});

test('inspect errors', () => {
  rejects(() => native.inspect(scene(), 60, repo), 'FRAME_OUT_OF_RANGE', /frame 60 is out of range/);
  rejects(() => native.inspect(scene(), -1, repo), 'INVALID_ARG', /frame must be/);
  rejects(() => native.inspect(scene(), 1.5, repo), 'INVALID_ARG', /frame must be/);
  rejects(() => native.inspect('[]', 0, repo), 'SCENE_INVALID');
  rejects(
    () => native.inspect(scene({ fonts: { 'DM Sans': 'assets/fonts/nope.ttf' } }), 0, repo),
    'IO',
    /nope\.ttf/,
  );
});

test('layoutText shapes text with the renderer engine', () => {
  const fonts = { 'DM Sans': font };
  const request = { text: 'Hello\nwörld', font: 'DM Sans', size: 32, fonts, baseDir: repo };
  const layout = native.layoutText(request);
  assert.equal(layout.lines.length, 2);
  assert.deepEqual([layout.lines[0].start, layout.lines[1].end], [0, 11]);
  // One glyph per letter, indexed in code points; the newline has none.
  assert.deepEqual(layout.glyphs.map((g) => g.charIndex), [0, 1, 2, 3, 4, 6, 7, 8, 9, 10]);
  assert.deepEqual(layout.glyphs.map((g) => g.line), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  const xs = layout.glyphs.slice(0, 5).map((g) => g.x);
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]));
  assert.ok(layout.glyphs[0].advance > 0 && layout.width > 0 && layout.height > 0);
  // The same engine measures the same text the same way, and wraps.
  assert.deepEqual(native.layoutText(request), layout);
  const wrapped = native.layoutText({ ...request, text: 'alpha beta gamma', maxWidth: 150 });
  assert.ok(wrapped.lines.length > 1 && wrapped.width <= 150);
  const centred = native.layoutText({ ...request, text: 'hi', maxWidth: 300, align: 'center' });
  const left = native.layoutText({ ...request, text: 'hi', maxWidth: 300 });
  assert.ok(centred.glyphs[0].x > left.glyphs[0].x + 100);
});

test('layoutText errors', () => {
  const fonts = { 'DM Sans': font };
  const base = { text: 'a', font: 'DM Sans', size: 32, fonts, baseDir: repo };
  rejects(() => native.layoutText({ ...base, size: 0 }), 'INVALID_ARG', /size/);
  rejects(() => native.layoutText({ ...base, align: 'justify' }), 'INVALID_ARG', /align/);
  rejects(() => native.layoutText({ ...base, font: 'Other' }), 'INVALID_ARG', /"Other"/);
  rejects(
    () => native.layoutText({ ...base, fonts: { 'DM Sans': 'assets/fonts/nope.ttf' } }),
    'IO',
    /nope\.ttf/,
  );
});

test('parseRange follows the Rust CLI', () => {
  assert.deepEqual(native.parseRange('10..40', 90), [10, 39]);
  assert.deepEqual(native.parseRange('10..=40', 90), [10, 40]);
  assert.deepEqual(native.parseRange('..30', 90), [0, 29]);
  assert.deepEqual(native.parseRange('60..', 90), [60, 89]);
  rejects(() => native.parseRange('10', 90), 'INVALID_ARG', /should look like/);
  rejects(() => native.parseRange('80..91', 90), 'INVALID_ARG', /runs past the scene/);
  rejects(() => native.parseRange('5..5', 90), 'INVALID_ARG', /no frames/);
  rejects(() => native.parseRange('1..2', -1), 'INVALID_ARG', /durationInFrames/);
});

const media = 'crates/core/tests/scenes/media';

test('probeMedia reads a video header without decoding', () => {
  const clip = native.probeMedia(`${media}/clip.mp4`, repo);
  assert.equal(clip.kind, 'video');
  assert.deepEqual([clip.width, clip.height], [64, 36]);
  assert.equal(clip.fps, 24);
  assert.equal(clip.frames, 48);
  assert.ok(Math.abs(clip.durationInSeconds - 2) < 1e-3, clip.durationInSeconds);
  assert.equal(clip.hasAudio, false);
  assert.equal(clip.videoCodec, 'h264');
  assert.ok(!clip.audioCodec);

  // A file with sound; the path may also be absolute (baseDir is then ignored).
  const talking = native.probeMedia(path.join(repo, media, 'with-audio.mp4'));
  assert.equal(talking.hasAudio, true);
  assert.equal(talking.audioCodec, 'aac');
  assert.ok(Math.abs(talking.durationInSeconds - 1) < 0.05, talking.durationInSeconds);

  // A WebM has no frame count; its duration is its length, not where it ends.
  const webm = native.probeMedia(`${media}/offset.webm`, repo);
  assert.equal(webm.videoCodec, 'vp9');
  assert.ok(!webm.frames);
  assert.ok(Math.abs(webm.durationInSeconds - 1.2) < 0.05, webm.durationInSeconds);
});

test('probeMedia reads a GIF: its screen, pictures and summed delays', () => {
  const gif = native.probeMedia(`${media}/spinner.gif`, repo);
  assert.equal(gif.kind, 'gif');
  assert.deepEqual([gif.width, gif.height], [32, 24]);
  assert.equal(gif.frames, 5);
  // Delays 0, 10, 40, 200 and 60 ms; a delay of 10 ms or less counts as 100.
  assert.ok(Math.abs(gif.durationInSeconds - 0.5) < 1e-9, gif.durationInSeconds);
  assert.ok(!gif.fps);
  assert.equal(gif.hasAudio, false);
  assert.equal(gif.videoCodec, 'gif');
});

test('probeMedia errors', () => {
  rejects(() => native.probeMedia(`${media}/nope.mp4`, repo), 'IO', /nope\.mp4/);
  // Neither a video nor a GIF: a sound, and a script.
  rejects(() => native.probeMedia(`${media}/tone-mono.wav`, repo), 'INVALID_ARG', /no video stream/);
  rejects(() => native.probeMedia(`${media}/make_gif.py`, repo), 'INVALID_ARG', /make_gif\.py/);
});

const peak = (samples) => samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('decodeAudio resamples and keeps mono or stereo', () => {
  // 0.25 s of a mono 8 kHz sine, to 48 kHz.
  const mono = native.decodeAudio(`${media}/tone-mono.wav`, 48000, repo);
  assert.equal(mono.sampleRate, 48000);
  assert.equal(mono.channels.length, 1);
  assert.ok(mono.channels[0] instanceof Float32Array);
  assert.ok(Math.abs(mono.channels[0].length - 12000) <= 16, mono.channels[0].length);
  assert.ok(peak(mono.channels[0]) > 0.1 && peak(mono.channels[0]) <= 1.01);
  // The same rate: the 2000 samples as they are.
  const same = native.decodeAudio(`${media}/tone-mono.wav`, 8000, repo);
  assert.equal(same.channels[0].length, 2000);

  // The stereo AAC track of an MP4, 1 s; both channels carry the tone.
  const stereo = native.decodeAudio(`${media}/with-audio.mp4`, 44100, repo);
  assert.equal(stereo.channels.length, 2);
  assert.equal(stereo.channels[0].length, stereo.channels[1].length);
  assert.ok(Math.abs(stereo.channels[0].length - 44100) <= 2048, stereo.channels[0].length);
  assert.ok(peak(stereo.channels[0]) > 0.1 && peak(stereo.channels[1]) > 0.1);

  // Six channels are downmixed to two, and the front left reaches both.
  const surround = native.decodeAudio(`${media}/surround.wav`, 8000, repo);
  assert.equal(surround.channels.length, 2);
  assert.equal(surround.channels[0].length, 800);
  assert.ok(peak(surround.channels[0]) > 0.05);
});

test('decodeAudio returns null without an audio stream, and errors', () => {
  assert.equal(native.decodeAudio(`${media}/clip.mp4`, 48000, repo), null);
  rejects(() => native.decodeAudio(`${media}/nope.wav`, 48000, repo), 'IO', /nope\.wav/);
  rejects(() => native.decodeAudio(`${media}/make_gif.py`, 48000, repo), 'INVALID_ARG', /make_gif\.py/);
  rejects(() => native.decodeAudio(`${media}/tone-mono.wav`, 0, repo), 'INVALID_ARG', /sampleRate/);
});
