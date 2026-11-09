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

test('validateScene takes a data: URL as the picture itself, not a file to look for', () => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const info = native.validateScene(
    JSON.stringify({ width: 8, height: 8, fps: 30, durationInFrames: 1, layers: [{ id: 'p', type: 'image', src: png, width: 8, height: 8 }] }),
    repo,
  );
  assert.equal(info.width, 8);
});

test('sceneUnknownKeys names each key the format does not read by its JSON path', () => {
  assert.deepEqual(native.sceneUnknownKeys(scene()), []);
  assert.deepEqual(native.sceneUnknownKeys(scene({ bogusTop: 1 })), ['bogusTop']);
  const typo = JSON.parse(scene());
  typo.layers[0].opacty = 0.5;
  typo.layers[0].effects[0].blurr = 2;
  assert.deepEqual(native.sceneUnknownKeys(JSON.stringify(typo)), ['layers[0].effects[0].blurr', 'layers[0].opacty']);
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

test('probeStreams reads every stream of a container, with or without video', () => {
  const talking = native.probeStreams(`${media}/with-audio.mp4`, repo);
  assert.match(talking.format, /mp4/);
  assert.ok(talking.durationInSeconds > 0.9 && talking.durationInSeconds < 1.1);
  const [video, audio] = talking.streams;
  assert.equal(video.kind, 'video');
  assert.equal(video.codec, 'h264');
  assert.ok(video.width > 0 && video.height > 0);
  assert.equal(video.rotation, 0);
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.codec, 'aac');
  assert.ok(audio.sampleRate > 0 && audio.channels > 0);
  assert.ok(audio.extradata instanceof Uint8Array && audio.extradata.length >= 2);

  // A sound alone is a container too (probeMedia refuses it).
  const wav = native.probeStreams(`${media}/tone-mono.wav`, repo);
  assert.equal(wav.format, 'wav');
  assert.equal(wav.streams.length, 1);
  assert.deepEqual([wav.streams[0].kind, wav.streams[0].channels], ['audio', 1]);

  rejects(() => native.probeStreams(`${media}/nope.mp4`, repo), 'IO', /nope\.mp4/);
  rejects(() => native.probeStreams(`${media}/make_gif.py`, repo), 'INVALID_ARG', /make_gif\.py/);
});

test('scanStreams totals the packets of each stream and lists the keyframes', () => {
  const scans = native.scanStreams(`${media}/clip.mp4`, repo);
  assert.equal(scans.length, 1);
  assert.equal(scans[0].packets, 48);
  assert.ok(scans[0].bytes > 0);
  assert.ok(scans[0].keyframes.length >= 1);
  assert.ok(Math.abs(scans[0].endInSeconds - 2) < 0.1, scans[0].endInSeconds);
});

const peak = (samples) =>samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

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

test('decodeAudio reads an MP4 whose moov atom is at the end as well as one with faststart', () => {
  const at = (name) => native.decodeAudio(`${media}/${name}`, 48000, repo);
  const end = at('tone-moov-end.mp4');
  const front = at('tone-faststart.mp4');
  assert.equal(end.channels.length, 1);
  assert.ok(Math.abs(end.channels[0].length - 48000) <= 2048, end.channels[0].length);
  assert.ok(peak(end.channels[0]) > 0.03);
  assert.deepEqual(end.channels[0], front.channels[0]);
});

test('decodeAudio returns null without an audio stream, and errors', () => {
  assert.equal(native.decodeAudio(`${media}/clip.mp4`, 48000, repo), null);
  rejects(() => native.decodeAudio(`${media}/nope.wav`, 48000, repo), 'IO', /nope\.wav/);
  rejects(() => native.decodeAudio(`${media}/make_gif.py`, 48000, repo), 'INVALID_ARG', /make_gif\.py/);
  rejects(() => native.decodeAudio(`${media}/tone-mono.wav`, 0, repo), 'INVALID_ARG', /sampleRate/);
});

// ---- layoutDom ----

const domRequest = (root, extra = {}) =>
  JSON.stringify({
    root,
    available: { width: 400, height: 300 },
    fonts: { 'DM Sans': font },
    baseDir: repo,
    ...extra,
  });

test('layoutDom lays out blocks, flex and absolute boxes', () => {
  const box = JSON.parse(
    native.layoutDom(
      domRequest({
        style: { display: 'flex', flexDirection: 'column', padding: [10, 10, 10, 10], position: 'relative', height: 300, boxSizing: 'border-box' },
        children: [
          { style: { height: 40, margin: [0, 'auto', 0, 'auto'], width: { percent: 50 } } },
          { style: { flexGrow: 1 } },
          { style: { position: 'absolute', inset: [0, 0, 'auto', 'auto'], width: 20, height: 20 } },
        ],
      }),
    ),
  );
  assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 400, 300]);
  assert.deepEqual(box.padding, [10, 10, 10, 10]);
  assert.equal(box.children.length, 3);
  // 50% of the 380 px content box, centred by its auto margins.
  assert.deepEqual(
    [box.children[0].x, box.children[0].y, box.children[0].width, box.children[0].height],
    [105, 10, 190, 40],
  );
  assert.equal(box.children[1].height, 300 - 20 - 40);
  // Absolute: against the padding box, out of the flow.
  assert.deepEqual(
    [box.children[2].x, box.children[2].y, box.children[2].width, box.children[2].height],
    [380, 0, 20, 20],
  );
});

test('layoutDom measures text with the renderer engine, at the width on offer', () => {
  const text = 'alpha beta gamma delta';
  const leaf = (width) => ({
    style: width === undefined ? {} : { width },
    measure: { text: { text, font: 'DM Sans', size: 24 } },
  });
  const wide = JSON.parse(native.layoutDom(domRequest({ children: [leaf()] })));
  const narrow = JSON.parse(native.layoutDom(domRequest({ children: [leaf(150)] })));
  // The same lines layoutText makes at that width.
  const one = native.layoutText({ text, font: 'DM Sans', size: 24, fonts: { 'DM Sans': font }, baseDir: repo });
  const wrapped = native.layoutText({
    text,
    font: 'DM Sans',
    size: 24,
    maxWidth: 150,
    fonts: { 'DM Sans': font },
    baseDir: repo,
  });
  assert.equal(wide.children[0].width, 400);
  assert.ok(Math.abs(wide.children[0].height - one.height) < 1e-3);
  assert.ok(wrapped.lines.length > 1);
  assert.ok(Math.abs(narrow.children[0].height - wrapped.height) < 1e-3);
});

test('layoutDom errors', () => {
  rejects(() => native.layoutDom('{ nope'), 'INVALID_ARG', /layoutDom request/);
  rejects(() => native.layoutDom(domRequest({ style: { colour: 'red' } })), 'INVALID_ARG', /unknown style property/);
  rejects(
    () => native.layoutDom(domRequest({ measure: { text: { text: 'a', font: 'Nope', size: 10 } } })),
    'INVALID_ARG',
    /Nope/,
  );
  rejects(
    () => native.layoutDom(domRequest({}, { available: { width: -1, height: 10 } })),
    'INVALID_ARG',
    /available width/,
  );
});

// ---- DOM islands (packages/cli/skills/kinetograph/references/ENGINE.md §2) ----

const el = (tag, p, style = '', children = [], attrs = {}) => ({ kind: 'element', tag, path: p, attrs, style, children });
const txt = (text) => ({ kind: 'text', text });
const island = (root, extra = {}) =>
  JSON.stringify({
    root,
    viewport: { width: 400, height: 300 },
    fonts: { 'DM Sans': font },
    baseDir: repo,
    time: 0,
    path: '$0',
    ...extra,
  });

test('domLayoutBoxes gives the offset box, the transformed rect and the client and scroll sizes', () => {
  const boxes = JSON.parse(
    native.domLayoutBoxes(
      island(
        el('div', '$0', 'display: flex; gap: 10px; padding: 5px', [
          el('div', '$0.0', 'width: 100px; height: 40px; transform: translate(7px, 3px) scale(2); transform-origin: 0 0'),
          el('div', '$0.1', 'flex: 1; height: 20px; overflow: hidden', [el('div', '$0.1.0', 'width: 500px; height: 10px')]),
          { kind: 'native', path: '$0.2', width: 30, height: 15 },
        ]),
      ),
    ),
  );
  assert.deepEqual(boxes['$0.0'].rect, { x: 12, y: 8, width: 200, height: 80 });
  assert.deepEqual(
    [boxes['$0.0'].x, boxes['$0.0'].y, boxes['$0.0'].width, boxes['$0.0'].height],
    [5, 5, 100, 40],
  );
  // 400 - 2 * 5 padding - 100 - 30 - 2 * 10 gap.
  assert.equal(boxes['$0.1'].width, 240);
  assert.deepEqual(boxes['$0.1'].client, { width: 240, height: 20 });
  assert.ok(boxes['$0.1'].scroll.width >= 500);
  assert.deepEqual([boxes['$0.2'].width, boxes['$0.2'].height], [30, 15]);
});

test('domLayoutBoxes needs the registered fonts to measure text, and wraps at the viewport', () => {
  const root = el('div', '$0', 'font-family: "DM Sans"; font-size: 32px; line-height: 40px', [
    txt('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'),
  ]);
  const boxes = JSON.parse(native.domLayoutBoxes(island(root)));
  assert.equal(boxes['$0'].width, 400);
  assert.ok(boxes['$0'].height >= 80 && boxes['$0'].height % 40 === 0, boxes['$0'].height);
});

test('domComputedStyle gives resolved values for CSS and camelCase names', () => {
  const root = el('div', '$0', 'width: 50%; font-size: 20px; color: red; transform: translate(10px, 5px)');
  const values = native.domComputedStyle(island(root), '$0', ['width', 'fontSize', 'color', 'transform', 'nonsense']);
  assert.deepEqual(values, ['200px', '20px', 'rgb(255, 0, 0)', 'matrix(1, 0, 0, 1, 10, 5)', '']);
});

test('renderDomIsland returns an IslandOutput and reports files it cannot read', () => {
  const root = el('div', '$0', '', [el('img', '$0.0', 'width: 10px; height: 10px', [], { src: 'nope.png' })]);
  const out = JSON.parse(native.renderDomIsland(island(root)));
  assert.ok(Array.isArray(out.layers));
  assert.ok(Array.isArray(out.unsupported));
  assert.ok(out.unsupported.some((u) => /nope\.png/.test(u.reason)));
  assert.equal(out.camera, null);
});

test('renderDomIsland is a pure function of the request, animations included', () => {
  const sheet = '@keyframes w { from { width: 100px } to { width: 300px } } .a { height: 10px; animation: w 2s linear both }';
  const at = (time) => island(el('div', '$0', '', [], { class: 'a' }), { stylesheets: [sheet], time });
  const width = (time) => JSON.parse(native.domLayoutBoxes(at(time)))['$0'].width;
  assert.equal(width(1), 200);
  assert.equal(width(0.5), 150);
  assert.equal(width(1), 200);
  assert.equal(native.renderDomIsland(at(0.7)), native.renderDomIsland(at(0.7)));
});

test('a DOM tree thousands of levels deep lays out (the island thread has a large stack)', () => {
  const depth = 3000;
  let node = el('div', `$0.${depth}`, 'width: 10px; height: 10px');
  for (let d = depth - 1; d >= 0; d--) node = el('div', `$0.${d}`, 'padding-left: 1px', [node]);
  const boxes = JSON.parse(native.domLayoutBoxes(island(el('div', '$0', '', [node]))));
  assert.equal(boxes[`$0.${depth}`].x, depth);
  // And a second call on the same thread still works.
  assert.equal(JSON.parse(native.domLayoutBoxes(island(el('div', '$0', 'height: 7px'))))['$0'].height, 7);
});

test('in a pass, readbacks and the render share a document, and a read after a write sees the write', () => {
  const at = (width) => island(el('div', '$0', `width: ${width}px; height: 10px; transform: translateX(${width}px)`));
  const width = (json, pass) => native.domComputedStyle(json, '$0', ['width'], pass)[0];
  const box = (json, pass) => JSON.parse(native.domLayoutBoxes(json, pass))['$0'].width;
  const pass = 7000;
  assert.equal(width(at(100), pass), '100px');
  // A script writes a style, then reads: the read sees the write, the layout too.
  assert.equal(width(at(150), pass), '150px');
  assert.equal(box(at(150), pass), 150);
  // The tree as it was is not answered from the document of the tree written since.
  assert.equal(width(at(100), pass), '100px');
  assert.equal(box(at(150), pass), 150);
  // The frame draws the tree it reads, as a render of that tree alone does.
  assert.equal(native.renderDomIsland(at(150), pass), native.renderDomIsland(at(150)));
  // The next frame's scripts read and write again; its render draws what they left, not what the frame before drew.
  assert.equal(width(at(200), pass + 1), '200px');
  assert.equal(box(at(250), pass + 1), 250);
  assert.equal(native.renderDomIsland(at(250), pass + 1), native.renderDomIsland(at(250)));
  // A frame that does not follow (a jump) reads a tree of its own.
  assert.equal(width(at(100), pass + 5), '100px');
  assert.equal(native.renderDomIsland(at(100), pass + 5), native.renderDomIsland(at(100)));
  // A readback outside a pass reads the tree it is given.
  assert.equal(width(at(300)), '300px');
  assert.equal(width(at(150), pass + 6), '150px');
});

test('a render is written as changes from the layers the caller holds, in its pass and the next', () => {
  const at = (x, color) =>
    island(
      el('div', '$0', '', [
        el('div', '$0.0', `width: 20px; height: 20px; background: ${color}`),
        el('div', '$0.1', `width: 20px; height: 20px; background: blue; transform: translateX(${x}px)`),
      ]),
    );
  // `delta` of crates/dom/src/request.rs undone.
  const expand = (layers, base) =>
    layers.map((layer) => {
      if (typeof layer.$same === 'number') return base[layer.$same];
      if (typeof layer.$base !== 'number') return layer;
      const { $base, children, ...own } = layer;
      return { ...own, children: expand(children, base[$base].children) };
    });
  const fresh = (json) => JSON.parse(native.renderDomIsland(json)).layers;
  const pass = 7200;
  const first = JSON.parse(native.renderDomIsland(at(0, 'red'), pass));
  assert.equal(first.delta, undefined);
  // The next pass is written against the first; what did not change is `$same`.
  const next = JSON.parse(native.renderDomIsland(at(5, 'red'), pass + 1, pass));
  assert.equal(next.delta, pass);
  assert.ok(JSON.stringify(next.layers).includes('$same'));
  assert.deepEqual(expand(next.layers, first.layers), fresh(at(5, 'red')));
  // A later render of that pass is written against the pass's own first.
  const third = JSON.parse(native.renderDomIsland(at(9, 'green'), pass + 1, pass + 1));
  assert.equal(third.delta, pass + 1);
  const second = expand(next.layers, first.layers);
  assert.deepEqual(expand(third.layers, second), fresh(at(9, 'green')));
  // Layers the caller does not hold (another pass's) are not written against: the render comes in full.
  const stale = JSON.parse(native.renderDomIsland(at(9, 'green'), pass + 1, pass));
  assert.equal(stale.delta, undefined);
  assert.deepEqual(stale.layers, fresh(at(9, 'green')));
  // That full render is the base now.
  const after = JSON.parse(native.renderDomIsland(at(9, 'red'), pass + 1, pass + 1));
  assert.equal(after.delta, pass + 1);
  assert.deepEqual(expand(after.layers, stale.layers), fresh(at(9, 'red')));
  // A pass that does not follow keeps nothing.
  const jump = JSON.parse(native.renderDomIsland(at(9, 'red'), pass + 5, pass + 1));
  assert.equal(jump.delta, undefined);
  assert.deepEqual(jump.layers, fresh(at(9, 'red')));
});

test('readbacks take edits to a numbered state, and answer as the whole request does', () => {
  const tree = (width, color, text) =>
    el('div', '$0', `width: ${width}px; height: 10px`, [txt(text), el('span', '$0.0', `color: ${color}`, [txt('x')])], { class: 'a' });
  const width = (json, pass) => native.domComputedStyle(json, '$0', ['width'], pass)[0];
  const color = (json, pass) => native.domComputedStyle(json, '$0.0', ['color'], pass)[0];
  const numbered = (stamp, json) => `{"stamp":${stamp},"request":${json}}`;
  const edits = (stamp, base, set, time = 0) => JSON.stringify({ stamp, base, path: '$0', time, set });
  // Without a pass a render keeps nothing: the whole request's pictures first.
  const drawn = native.renderDomIsland(island(tree(150, 'blue', 'b')));
  const boxes = native.domLayoutBoxes(island(tree(150, 'red', 'b')));
  const drawnWhole = native.renderDomIsland(island(tree(90, 'blue', 'b')));
  const pass = 7300;
  assert.equal(width(numbered(1, island(tree(100, 'red', 'a'))), pass), '100px');
  // Edits to state 1: a style and a text; answered as the whole request of the new tree is.
  const two = edits(2, 1, [{ path: '$0', style: 'width: 150px; height: 10px', texts: [[0, 'b']] }]);
  assert.equal(width(two, pass), '150px');
  assert.equal(width(two, pass), '150px');
  assert.equal(native.domLayoutBoxes(two, pass), boxes);
  const three = edits(3, 2, [{ path: '$0.0', style: 'color: blue' }]);
  assert.equal(color(three, pass), 'rgb(0, 0, 255)');
  // The frame draws the state the edits made, as a render of the whole request does; and keeps its number.
  assert.equal(native.renderDomIsland(island(tree(150, 'blue', 'b')), pass), drawn);
  assert.equal(width(edits(4, 3, [{ path: '$0', style: 'width: 90px; height: 10px' }]), pass + 1), '90px');
  // A render can name the state a readback left (edits that change nothing) instead of sending the request.
  assert.equal(native.renderDomIsland(edits(4, 4, []), pass + 1), drawnWhole);
  assert.equal(width(edits(4, 3, []), pass + 1), '90px');
  rejects(() => native.renderDomIsland(edits(4, 3, [{ path: '$0', style: '' }]), pass + 1), 'INVALID_ARG', /no edits/);
  rejects(() => native.renderDomIsland(edits(3, 3, []), pass + 1), 'STALE_BASE');
  // Edits to a state the addon does not hold: STALE_BASE, and the whole request is sent instead.
  rejects(() => width(edits(5, 3, []), pass + 1), 'STALE_BASE', /send the whole request/);
  rejects(() => width(edits(6, 4, []), pass + 5), 'STALE_BASE');
  // A render of another tree is another state.
  assert.equal(width(numbered(7, island(tree(70, 'red', 'a'))), pass + 6), '70px');
  native.renderDomIsland(island(tree(80, 'red', 'a')), pass + 6);
  rejects(() => width(edits(8, 7, []), pass + 6), 'STALE_BASE');
  // Edits that name what the request does not have are refused.
  assert.equal(width(numbered(9, island(tree(70, 'red', 'a'))), pass + 6), '70px');
  rejects(() => width(edits(10, 9, [{ path: '$0.4', style: '' }]), pass + 6), 'INVALID_ARG', /no element/);
  rejects(() => width('{"stamp":1,"nope":2}', pass), 'INVALID_ARG', /edits/);
  // Outside a pass too.
  assert.equal(width(numbered(11, island(tree(60, 'red', 'a')))), '60px');
  assert.equal(width(edits(12, 11, [{ path: '$0', style: 'width: 61px' }])), '61px');
  assert.equal(native.domIslandEdits(), 1);
});

test('a document a line clamp cut is edited to the next tree as a fresh build draws it', () => {
  const sheet = '.c { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; font: 20px "DM Sans" }';
  // One box with no `style` of its own, one with one (the clamp sets its declarations, which are put back).
  const at = (text, width) =>
    island(
      el('div', '$0', '', [
        el('div', '$0.0', `width: ${width}px`, [txt(text)], { class: 'c' }),
        el('div', '$0.1', '', [txt(text)], { class: 'c' }),
      ]),
      { stylesheets: [sheet] },
    );
  const height = (json, pass) => JSON.parse(native.domLayoutBoxes(json, pass))['$0.0'].height;
  const pass = 7100;
  const one = height(at('one', 60), pass);
  const many = height(at('one two three four five six', 60), pass);
  assert.equal(many, one, 'clamped to one line');
  assert.equal(height(at('one two three four five six', 60), pass), many);
  // Frame after frame, each drawn as a fresh build of its tree draws it: the clamp is put back, then cut again.
  const frames = [
    ['one two three four five six', 60],
    ['one', 60],
    ['one two three four five six', 300],
    ['one two three four five six seven eight nine ten', 120],
    ['one two three four five six seven eight nine ten', 120],
    ['two', 40],
  ];
  frames.forEach(([text, width], i) => {
    const json = at(text, width);
    assert.equal(native.renderDomIsland(json, pass + 1 + i), native.renderDomIsland(json), `frame ${i}`);
  });
});

test('the DOM island functions throw INVALID_ARG or RENDER errors', () => {
  rejects(() => native.renderDomIsland('{ nope'), 'INVALID_ARG', /renderDomIsland request/);
  rejects(() => native.domLayoutBoxes('{}'), 'INVALID_ARG', /domLayoutBoxes request/);
  rejects(() => native.domComputedStyle(island(el('div', '$0')), '$9', ['width']), 'INVALID_ARG', /no element/);
  rejects(
    () => native.domLayoutBoxes(island(el('div', '$0'), { fonts: { Broken: '/nonexistent/font.ttf' } })),
    'RENDER',
    /font\.ttf/,
  );
});

test('mattingSupport says whether ONNX Runtime runs and what ben2-base would run on', () => {
  const support = native.mattingSupport();
  assert.equal(typeof support.available, 'boolean');
  assert.ok(['coreml', 'directml', 'cuda', 'webgpu', 'cpu'].includes(support.backend), support.backend);
});

test('matteVideo rejects, with no model run, a bad option or a missing file', async () => {
  const options = (extra) => ({
    input: path.join(repo, 'packages/core/test/fixtures/media/clip.mp4'),
    modelPath: path.join(repo, 'package.json'),
    model: 'modnet',
    foreground: path.join(require('node:os').tmpdir(), 'never-written.webm'),
    quality: 'high',
    ...extra,
  });
  await assert.rejects(native.matteVideo(options({ model: 'rvm' })), /unknown model "rvm"/);
  await assert.rejects(native.matteVideo(options({ quality: 'ultra' })), /unknown quality/);
  await assert.rejects(native.matteVideo(options({ audio: 'some' })), /unknown audio setting/);
  await assert.rejects(native.matteVideo(options({ input: '/nonexistent/clip.mp4' })), /cannot read the input/);
  await assert.rejects(native.matteVideo(options({ modelPath: '/nonexistent/model.onnx' })), /cannot read the model file/);
  await assert.rejects(native.matteVideo(options({ jobs: 0 })), /jobs must be at least 1/);
  const token = new native.MatteToken();
  assert.equal(token.cancelled, false);
  token.cancel();
  assert.equal(token.cancelled, true);
});
