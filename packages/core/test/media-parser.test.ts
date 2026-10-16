// `@remotion/media-parser`: parseMedia's fields, errors, callbacks and controller on a stand-in addon, the readers and
// writers, and (where the addon is built) the answers for real files against the published package's
// (test/fixtures/media-parser.json, recorded from the files in test/fixtures/media).

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaStreams, StreamDetails, StreamScan } from '@kinetograph/native';
import * as mp from '../src/media-parser/index.js';
import { setMediaParserAddon } from '../src/media-parser/index.js';
import { nodeReader, universalReader, webReader } from '../src/media-parser/readers.js';
import * as nodeEntry from '../src/media-parser/node.js';
import * as workerEntry from '../src/media-parser/worker.js';
import * as serverWorkerEntry from '../src/media-parser/server-worker.js';
import { nodeWriter } from '../src/media-parser/writers.js';
import { UnsupportedApiError } from '../src/unsupported.js';
import { fixture } from './helpers.js';

const media = (name: string) => fileURLToPath(new URL(`./fixtures/media/${name}`, import.meta.url));
const recorded = fixture('media-parser.json');
const scratch = mkdtempSync(join(tmpdir(), 'kinetograph-media-parser-test-'));

afterEach(() => setMediaParserAddon(null));

// ---- a stand-in addon ----

function stream(over: Partial<StreamDetails>): StreamDetails {
  return {
    index: 0, id: 1, kind: 'video', codec: 'h264', timeBaseNumerator: 1, timeBaseDenominator: 15360, width: 160, height: 90,
    sampleAspectRatioNumerator: 1, sampleAspectRatioDenominator: 1, rotation: 0, colorRange: 0, colorPrimaries: 2, colorTransfer: 2,
    colorSpace: 2, sampleRate: 0, channels: 0, bitsPerSample: 0, ...over,
  };
}

const MP4: MediaStreams = {
  format: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationInSeconds: 2,
  tags: [
    { key: 'major_brand', value: 'isom' },
    { key: 'encoder', value: 'Lavf' },
    { stream: 0, key: 'handler_name', value: 'VideoHandler' },
    { stream: 0, key: 'language', value: 'und' },
    { key: 'location', value: '+37.5090-122.3322+016.000/' },
  ],
  streams: [
    stream({ extradata: Uint8Array.from([1, 0x64, 0, 0x1f, 0xff]) as never, frameRate: 30, rotation: 90, profile: 100, level: 31 }),
    stream({ index: 1, id: 2, kind: 'audio', codec: 'aac', timeBaseDenominator: 44100, width: 0, height: 0, sampleRate: 44100, channels: 2, extradata: Uint8Array.from([0x12, 0x10]) as never }),
  ],
};

function scansFor(): StreamScan[] {
  return [
    { index: 0, packets: 60, bytes: 60000, startInSeconds: 0, endInSeconds: 2, keyframes: [{ position: 40, size: 5000, ptsInSeconds: 0.1, dtsInSeconds: 0 }, { position: 9000, size: 4000, ptsInSeconds: 1, dtsInSeconds: 0.9 }] },
    { index: 1, packets: 90, bytes: 10000, startInSeconds: 0, endInSeconds: 2.1, keyframes: [] },
  ];
}

function stub(streams: MediaStreams = MP4) {
  const calls = { probe: 0, scan: 0 };
  setMediaParserAddon({
    probeStreams: () => (calls.probe++, streams),
    scanStreams: () => (calls.scan++, scansFor()),
    decodeAudio: () => null,
  });
  return calls;
}

const file = (name: string, bytes: string | Uint8Array = 'not really media') => {
  const path = join(scratch, name);
  writeFileSync(path, bytes);
  return path;
};

describe('exports', () => {
  it('are the published package\'s, and of its subpaths', () => {
    // Everything the published index exports at run time but the byte parser's internals.
    expect(Object.keys(mp).sort()).toEqual(
      [...recorded.exports].filter((name: string) => name !== 'MediaParserInternals').concat(['MediaParserInternals', 'setMediaParserAddon']).sort(),
    );
    expect(Object.keys(mp.MediaParserInternals).sort()).toEqual(['Log', 'createAacCodecPrivate', 'fieldsNeedSamplesMap', 'internalParseMedia']);
    expect(Object.keys(nodeEntry).sort()).toEqual(recorded.subpaths['/node']);
    expect(Object.keys(workerEntry).sort()).toEqual(recorded.subpaths['/worker']);
    expect(Object.keys(serverWorkerEntry).sort()).toEqual(recorded.subpaths['/server-worker']);
    expect(mp.VERSION).toBe(recorded.VERSION);
    expect(mp.WEBCODECS_TIMESCALE).toBe(recorded.WEBCODECS_TIMESCALE);
  });
});

describe('parseMedia fields on a stand-in addon', () => {
  it('answers the fields asked for and no others, reading the packets only for the slow ones', async () => {
    const calls = stub();
    const clip = file('a.mp4');
    const fast = await mp.parseMedia({ src: clip, fields: { container: true, name: true, size: true, dimensions: true }, acknowledgeRemotionLicense: true });
    expect(fast).toEqual({ container: 'mp4', name: 'a.mp4', size: 16, dimensions: { width: 90, height: 160 } });
    expect(calls).toEqual({ probe: 1, scan: 0 });
    const slow = await mp.parseMedia({ src: clip, fields: { slowNumberOfFrames: true, slowFps: true, slowDurationInSeconds: true, slowVideoBitrate: true, slowAudioBitrate: true }, acknowledgeRemotionLicense: true });
    expect(slow).toEqual({ slowNumberOfFrames: 60, slowFps: 30, slowDurationInSeconds: 2.1, slowVideoBitrate: 240000, slowAudioBitrate: (10000 * 8) / 2.1 });
    expect(calls.scan).toBe(1);
  });

  it('makes the tracks, rotated size, codecs, metadata and location of an MP4', async () => {
    stub();
    const result = await mp.parseMedia({
      src: file('b.mp4'),
      fields: { tracks: true, unrotatedDimensions: true, rotation: true, videoCodec: true, audioCodec: true, sampleRate: true, numberOfAudioChannels: true, fps: true, metadata: true, location: true, durationInSeconds: true, isHdr: true },
      acknowledgeRemotionLicense: true,
    });
    expect(result).toMatchObject({
      unrotatedDimensions: { width: 160, height: 90 },
      rotation: 90,
      videoCodec: 'h264',
      audioCodec: 'aac',
      sampleRate: 44100,
      numberOfAudioChannels: 2,
      fps: 30,
      durationInSeconds: 2,
      isHdr: false,
      // What FFmpeg makes up is not metadata of the file.
      metadata: [{ trackId: null, key: 'encoder', value: 'Lavf' }, { trackId: null, key: 'location', value: '+37.5090-122.3322+016.000/' }],
      location: { latitude: 37.509, longitude: -122.3322, altitude: 16, horizontalAccuracy: null },
    });
    const [video, audio] = result.tracks;
    expect(video).toMatchObject({ type: 'video', trackId: 1, codec: 'avc1.64001f', codecEnum: 'h264', width: 90, height: 160, codedWidth: 160, codedHeight: 90, rotation: 90, originalTimescale: 15360, timescale: 1000000 });
    expect(audio).toMatchObject({ type: 'audio', trackId: 2, codec: 'mp4a.40.02', codecEnum: 'aac', sampleRate: 44100, numberOfChannels: 2, originalTimescale: 44100 });
  });

  it('calls the callbacks with the values, which asks for those fields too', async () => {
    stub();
    const onContainer = vi.fn();
    const onDurationInSeconds = vi.fn();
    const onParseProgress = vi.fn();
    const result = await mp.parseMedia({ src: file('c.mp4'), onContainer, onDurationInSeconds, onParseProgress, fields: { name: true }, acknowledgeRemotionLicense: true });
    expect(result).toEqual({ name: 'c.mp4', container: 'mp4', durationInSeconds: 2 });
    expect(onContainer).toHaveBeenCalledWith('mp4');
    expect(onDurationInSeconds).toHaveBeenCalledWith(2);
    expect(onParseProgress).toHaveBeenCalledWith({ bytes: 16, percentage: 1, totalBytes: 16 });
  });

  it('gives no frame rate for a container that keeps none, no duration for a raw AAC stream, and HDR for BT.2020 PQ', async () => {
    stub({ ...MP4, format: 'matroska,webm', streams: [stream({ colorSpace: 9, colorPrimaries: 9, colorTransfer: 16, frameRate: 25, codec: 'hevc' })] });
    const webm = await mp.parseMedia({ src: file('d.webm'), fields: { fps: true, isHdr: true, container: true, tracks: true }, acknowledgeRemotionLicense: true });
    expect(webm).toMatchObject({ fps: null, isHdr: true, container: 'webm' });
    expect(webm.tracks[0]).toMatchObject({ codecEnum: 'h265', fps: null, advancedColor: { matrix: 'bt2020-ncl', transfer: 'pq', primaries: 'bt2020' } });
    stub({ format: 'aac', durationInSeconds: 1, tags: [], streams: [stream({ kind: 'audio', codec: 'aac', sampleRate: 44100, channels: 1, extradata: Uint8Array.of(0x12, 0x08) as never })] });
    const aac = await mp.parseMedia({ src: file('e.aac'), fields: { durationInSeconds: true, dimensions: true, videoCodec: true, rotation: true, fps: true, keyframes: true }, acknowledgeRemotionLicense: true });
    expect(aac).toEqual({ durationInSeconds: null, dimensions: null, videoCodec: null, rotation: 0, fps: null, keyframes: null });
  });

  it('lists the keyframes of an MP4 and of every file with the slow field', async () => {
    stub();
    const result = await mp.parseMedia({ src: file('f.mp4'), fields: { keyframes: true, slowKeyframes: true }, acknowledgeRemotionLicense: true });
    expect(result.keyframes).toEqual(result.slowKeyframes);
    expect(result.slowKeyframes[1]).toEqual({ trackId: 1, positionInBytes: 9000, sizeInBytes: 4000, presentationTimeInSeconds: 1, decodingTimeInSeconds: 0.9 });
  });

  it('turns a cover picture into an image and leaves it out of the tracks', async () => {
    stub({ format: 'mp3', durationInSeconds: 1, tags: [], streams: [stream({ kind: 'audio', codec: 'mp3', sampleRate: 44100, channels: 2 }), stream({ index: 1, id: 1, kind: 'other', codec: 'mjpeg', attachedPicture: Uint8Array.of(0xff, 0xd8) as never })] });
    const result = await mp.parseMedia({ src: file('g.mp3'), fields: { images: true, tracks: true }, acknowledgeRemotionLicense: true });
    expect(result.images).toEqual([{ description: null, mimeType: 'image/jpeg', data: Uint8Array.of(0xff, 0xd8) }]);
    expect(result.tracks).toHaveLength(1);
  });
});

describe('parseMedia refusals', () => {
  it('says what is not media: images with their size, PDFs, and other files', async () => {
    stub();
    for (const [name, error] of Object.entries(recorded.errors) as [string, Record<string, any>][]) {
      let thrown: any;
      try {
        await mp.parseMedia({ src: media(name), fields: { container: true }, acknowledgeRemotionLicense: true });
      } catch (e) {
        thrown = e;
      }
      if (name === 'notes.txt') {
        // The addon's refusal to open a file is what makes it an unsupported file type.
        expect(thrown).toBeUndefined();
        setMediaParserAddon({
          probeStreams: () => {
            throw Object.assign(new Error('cannot open'), { code: 'INVALID_ARG' });
          },
          scanStreams: () => [],
          decodeAudio: () => null,
        });
        thrown = await mp.parseMedia({ src: media(name), fields: { container: true }, acknowledgeRemotionLicense: true }).catch((e) => e);
      }
      expect(thrown, name).toBeInstanceOf(Error);
      expect(thrown.name, name).toBe(error.name);
      expect(thrown.message, name).toBe(name === 'doc.pdf' ? 'PDF files are not supported' : error.message);
      expect(thrown.sizeInBytes).toBe(error.sizeInBytes);
      expect(thrown.fileName).toBe(error.fileName);
      expect(thrown.mimeType).toBe(error.mimeType);
      if (error.imageType) expect([thrown.imageType, thrown.dimensions]).toEqual([error.imageType, error.dimensions]);
    }
    expect(new mp.IsAnImageError({ message: 'm', imageType: 'png', dimensions: null, mimeType: null, sizeInBytes: 1, fileName: 'a' })).toBeInstanceOf(Error);
  });

  it('refuses a missing file, a URL, a Blob, sample callbacks and the box tree', async () => {
    stub();
    const ack = { acknowledgeRemotionLicense: true, fields: { container: true } };
    await expect(mp.parseMedia({ src: join(scratch, 'nope.mp4'), ...ack })).rejects.toThrow(/File does not exist/);
    await expect(mp.parseMedia({ src: 'https://example.com/a.mp4', ...ack })).rejects.toThrow(/remote URLs are not available/);
    await expect(mp.parseMedia({ src: new URL('https://example.com/a.mp4'), ...ack })).rejects.toThrow(/remote URLs are not available/);
    await expect(mp.parseMedia({ src: new Blob(['x']), ...ack })).rejects.toBeInstanceOf(UnsupportedApiError);
    const path = file('h.mp4');
    await expect(mp.parseMedia({ src: path, onVideoTrack: () => null, ...ack })).rejects.toThrow(/onVideoTrack is not supported/);
    await expect(mp.parseMedia({ src: path, onAudioTrack: () => null, ...ack })).rejects.toThrow(/onAudioTrack is not supported/);
    await expect(mp.parseMedia({ src: path, fields: { slowStructure: true }, acknowledgeRemotionLicense: true })).rejects.toThrow(/slowStructure field is not supported/);
    await expect(mp.parseMedia(undefined as never)).rejects.toThrow(/No options provided/);
  });

  it('opens a file: URL, and says an M3U playlist cannot be read offline', async () => {
    stub();
    const path = file('i.mp4');
    const result = await mp.parseMedia({ src: new URL(`file://${path}`), fields: { name: true }, acknowledgeRemotionLicense: true });
    expect(result).toEqual({ name: 'i.mp4' });
    stub({ ...MP4, format: 'hls,applehttp' });
    await expect(mp.parseMedia({ src: path, fields: { container: true }, acknowledgeRemotionLicense: true })).rejects.toBeInstanceOf(UnsupportedApiError);
    stub({ ...MP4, format: 'ogg' });
    await expect(mp.parseMedia({ src: path, fields: { container: true }, acknowledgeRemotionLicense: true })).rejects.toBeInstanceOf(mp.IsAnUnsupportedFileTypeError);
  });

  it('notes the licence once, unless it is acknowledged', async () => {
    stub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = file('j.mp4');
    await mp.parseMedia({ src: path, fields: { name: true } });
    await mp.parseMedia({ src: path, fields: { name: true } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('acknowledgeRemotionLicense: true');
    warn.mockRestore();
  });
});

describe('the controller', () => {
  it('aborts a parse with a MediaParserAbortError, and tells its listeners', async () => {
    stub();
    const controller = mp.mediaParserController();
    const heard: string[] = [];
    controller.addEventListener('abort', () => heard.push('abort'));
    controller.addEventListener('pause', () => heard.push('pause'));
    controller.addEventListener('resume', () => heard.push('resume'));
    controller.addEventListener('seek', ({ detail }) => heard.push(`seek ${detail.seek}`));
    controller.pause();
    controller.pause();
    controller.resume();
    controller.seek(2);
    expect(heard).toEqual(['pause', 'resume', 'seek 2']);
    controller.abort();
    expect(heard.at(-1)).toBe('abort');
    const error = await mp.parseMedia({ src: file('k.mp4'), controller, fields: { name: true }, acknowledgeRemotionLicense: true }).catch((e) => e);
    expect(mp.hasBeenAborted(error)).toBe(true);
    expect(error).toBeInstanceOf(mp.MediaParserAbortError);
    await expect(controller.simulateSeek(1)).rejects.toBeInstanceOf(UnsupportedApiError);
    expect(await controller.getSeekingHints()).toBeNull();
  });

  it('holds a parse that is paused until it is resumed', async () => {
    stub();
    const controller = mp.mediaParserController();
    controller.pause();
    let done = false;
    const parsing = mp.parseMedia({ src: file('l.mp4'), controller, fields: { name: true }, acknowledgeRemotionLicense: true }).then((r) => ((done = true), r));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    controller.resume();
    expect(await parsing).toEqual({ name: 'l.mp4' });
  });
});

describe('readers and writers', () => {
  it('reads a file whole, in a range, and as text, with its size and name', async () => {
    const path = file('m.txt', 'hello world');
    const controller = mp.mediaParserController();
    const read = async (range: number | [number, number] | null) => {
      const result = await nodeReader.read({ src: path, range, controller, logLevel: 'error', prefetchCache: new Map() });
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await result.reader.reader.read();
        if (done) break;
        chunks.push(value);
      }
      return { text: Buffer.concat(chunks).toString(), result };
    };
    const whole = await read(null);
    expect(whole.text).toBe('hello world');
    expect(whole.result).toMatchObject({ contentLength: 11, contentType: null, name: 'm.txt', supportsContentRange: true });
    expect((await read([6, 10])).text).toBe('world');
    expect((await read(6)).text).toBe('world');
    expect(await nodeReader.readWholeAsText(path)).toBe('hello world');
    expect(nodeReader.createAdjacentFileSource('seg.ts', path)).toBe(join(scratch, 'seg.ts'));
    expect(() => nodeReader.createAdjacentFileSource('../x', path)).toThrow(/outside of the parent directory/);
    expect(webReader).toBe(universalReader);
    await expect(nodeReader.read({ src: 'https://example.com/a', range: null, controller, logLevel: 'error', prefetchCache: new Map() })).rejects.toThrow(/offline/);
  });

  it('writes bytes in order, updates them in place, and gives them back as a Blob', async () => {
    const path = join(scratch, 'out.bin');
    const writer = await nodeWriter(path).createContent({ filename: 'x', mimeType: 'video/mp4', logLevel: 'error' });
    await Promise.all([writer.write(Uint8Array.of(1, 2, 3)), writer.write(Uint8Array.of(4, 5))]);
    await writer.updateDataAt(1, Uint8Array.of(9));
    expect(writer.getWrittenByteCount()).toBe(5);
    await writer.finish();
    expect([...readFileSync(path)]).toEqual([1, 9, 3, 4, 5]);
    expect(new Uint8Array(await (await writer.getBlob()).arrayBuffer())).toEqual(Uint8Array.of(1, 9, 3, 4, 5));
    await writer.remove();
    expect(() => readFileSync(path)).toThrow();
  });

  it('downloadAndParseMedia gives the answer of parseMedia and copies the file through the writer', async () => {
    stub();
    const source = file('n.mp4', 'twelve bytes');
    const target = join(scratch, 'copy.mp4');
    const result = await mp.downloadAndParseMedia({ src: source, writer: nodeWriter(target), fields: { container: true }, acknowledgeRemotionLicense: true });
    expect(result).toEqual({ container: 'mp4' });
    expect(readFileSync(target, 'utf8')).toBe('twelve bytes');
    // A failed parse leaves no copy behind.
    stub({ ...MP4, format: 'ogg' });
    const failed = join(scratch, 'failed.mp4');
    await expect(mp.downloadAndParseMedia({ src: source, writer: nodeWriter(failed), fields: { container: true }, acknowledgeRemotionLicense: true })).rejects.toThrow();
    expect(() => readFileSync(failed)).toThrow();
  });
});

describe('the small exports', () => {
  it('createAacCodecPrivate builds the config the published function does, and refuses what it refuses', () => {
    expect(recorded.aac.length).toBeGreaterThan(300);
    for (const [audioObjectType, sampleRate, channelConfiguration, expected] of recorded.aac) {
      const args = { audioObjectType, sampleRate, channelConfiguration, codecPrivate: null };
      if (Array.isArray(expected)) expect(Array.from(mp.MediaParserInternals.createAacCodecPrivate(args)), JSON.stringify(args)).toEqual(expected);
      else expect(() => mp.MediaParserInternals.createAacCodecPrivate(args), JSON.stringify(args)).toThrow(expected.error);
    }
    const kept = Uint8Array.of(1, 2, 3);
    expect(mp.MediaParserInternals.createAacCodecPrivate({ audioObjectType: 2, sampleRate: 44100, channelConfiguration: 2, codecPrivate: kept })).toBe(kept);
  });

  it('chooses the first M3U stream, and the default or only associated playlists', async () => {
    const stream = (id: number) => ({ id }) as never;
    expect(await mp.defaultSelectM3uStreamFn({ streams: [stream(7), stream(8)] })).toBe(7);
    const playlist = (id: number, isDefault: boolean) => ({ id, default: isDefault }) as never;
    expect(await mp.defaultSelectM3uAssociatedPlaylists({ associatedPlaylists: [playlist(1, false)] })).toEqual([playlist(1, false)]);
    expect(await mp.defaultSelectM3uAssociatedPlaylists({ associatedPlaylists: [playlist(1, false), playlist(2, true)] })).toEqual([playlist(2, true)]);
  });

  it('marks the fields that need every packet', () => {
    expect(mp.MediaParserInternals.fieldsNeedSamplesMap).toEqual(recorded.fieldsNeedSamplesMap);
  });
});

// ---- real files, through the addon ----

function loadAddon(): Record<string, unknown> | null {
  try {
    const native = createRequire(import.meta.url)('@kinetograph/native') as Record<string, unknown>;
    return typeof native.probeStreams === 'function' ? native : null;
  } catch {
    return null;
  }
}
const addon = loadAddon();

const revive = (v: any): any => {
  if (v && typeof v === 'object' && '__bytes__' in v) return Uint8Array.from(Buffer.from(v.__bytes__, 'hex'));
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
  return v;
};

/** Numbers to nine decimals, so that 0.4 and 0.39999999999999997 are the same time. */
const rounded = (v: any): any =>
  typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : Array.isArray(v) ? v.map(rounded) : v && typeof v === 'object' && !(v instanceof Uint8Array) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rounded(x)])) : v;

// Where Kinetograph's answer is known to differ from the published parser's, and why:
//  - the delay of the first picture of an MP4 (`trackMediaTimeOffsetInTrackTimescale`) is in its edit list, which FFmpeg
//    applies and does not report;
//  - the AAC config of a raw or transport-stream AAC is built with the right object type (LC is 2), where the published
//    parser writes the ADTS profile field (1) into it;
//  - Matroska's range is not said in the file; FFmpeg reads the bitstream's, the published parser says full;
//  - a transport stream's samples start at the muxer's first timestamp in the published parser, at FFmpeg's start here;
//  - the bitrates and durations "slow" fields measure are within a few percent, by how the first and last packet count;
//  - FLAC's vendor string and ENCODER comment are the same tag to FFmpeg.
const LOOSE = new Set(['slowDurationInSeconds', 'slowAudioBitrate', 'slowVideoBitrate', 'slowFps']);
const SKIP: Record<string, string[]> = {
  'clip.m2ts': ['slowKeyframes', 'slowVideoBitrate', 'slowAudioBitrate', 'slowDurationInSeconds'],
  'clip.webm': ['slowKeyframes'],
  'rotated.mp4': ['slowKeyframes'],
  'clip.mp4': ['slowKeyframes'],
  'tone.flac': ['metadata'],
};
const TRACK_SKIP: Record<string, string[]> = {
  'clip.mp4': ['trackMediaTimeOffsetInTrackTimescale'],
  'rotated.mp4': ['trackMediaTimeOffsetInTrackTimescale'],
  'clip.m2ts': ['codecData', 'description'],
  'tone.aac': ['codecData', 'description'],
  'clip.webm': ['colorSpace', 'advancedColor'],
};

describe.skipIf(addon === null)('real files, against the published parser', () => {
  const names = Object.keys(recorded.files);

  const parse = async (name: string, fields: Record<string, true>) => {
    setMediaParserAddon(addon as never);
    return (await mp.parseMedia({ src: media(name), fields, acknowledgeRemotionLicense: true })) as Record<string, any>;
  };

  it('has the files it compares', () => {
    expect(names).toEqual(['clip.m2ts', 'clip.mp4', 'clip.webm', 'rotated.mp4', 'tone.aac', 'tone.flac', 'tone.mp3', 'tone.wav']);
  });

  for (const name of ['clip.m2ts', 'clip.mp4', 'clip.webm', 'rotated.mp4', 'tone.aac', 'tone.flac', 'tone.mp3', 'tone.wav']) {
    it(`answers every field for ${name} as the published parser does`, async () => {
      const want = revive(recorded.files[name]);
      const got = await parse(name, Object.fromEntries(Object.keys(want).map((k) => [k, true])));
      expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
      for (const field of Object.keys(want)) {
        if (SKIP[name]?.includes(field)) continue;
        if (field === 'tracks') {
          expect(got.tracks.length).toBe(want.tracks.length);
          want.tracks.forEach((track: Record<string, unknown>, i: number) => {
            const strip = (t: Record<string, unknown>) =>
              Object.fromEntries(Object.entries(t).filter(([k, v]) => !TRACK_SKIP[name]?.includes(k) && v !== undefined));
            expect(strip(got.tracks[i]), `${name} track ${i}`).toEqual(strip(track));
          });
        } else if (LOOSE.has(field)) {
          if (want[field] !== null && want[field] !== 0) expect(Math.abs(got[field] / want[field] - 1), `${name} ${field}`).toBeLessThan(0.15);
        } else {
          expect(rounded(got[field]), `${name} ${field}`).toEqual(rounded(want[field]));
        }
      }
    });
  }

  it('answers the slow keyframes of an MP4 as the published parser does but for rounding', async () => {
    for (const name of ['clip.mp4', 'rotated.mp4']) {
      const want = revive(recorded.files[name].slowKeyframes) as any[];
      const got = (await parse(name, { slowKeyframes: true })).slowKeyframes as any[];
      expect(got).toHaveLength(want.length);
      want.forEach((k, i) => {
        expect([got[i].trackId, got[i].positionInBytes, got[i].sizeInBytes]).toEqual([k.trackId, k.positionInBytes, k.sizeInBytes]);
        expect(got[i].presentationTimeInSeconds).toBeCloseTo(k.presentationTimeInSeconds, 5);
        expect(got[i].decodingTimeInSeconds).toBeCloseTo(k.decodingTimeInSeconds, 5);
      });
    }
  });

  it('does not need the box tree for the files: slowStructure alone is what throws', async () => {
    await expect(parse('clip.mp4', { slowStructure: true })).rejects.toBeInstanceOf(UnsupportedApiError);
  });

  it('gives the right unsupported-file errors for real bytes', async () => {
    setMediaParserAddon(addon as never);
    const notes = await mp.parseMedia({ src: media('notes.txt'), fields: { container: true }, acknowledgeRemotionLicense: true }).catch((e) => e);
    expect(notes).toBeInstanceOf(mp.IsAnUnsupportedFileTypeError);
    expect(notes.message).toBe('Unknown file format');
  });

  it('copies a fixture through downloadAndParseMedia and reads the parts of a real MP4 through the reader', async () => {
    const target = join(scratch, 'real-copy.mp4');
    setMediaParserAddon(addon as never);
    const result = await mp.downloadAndParseMedia({ src: media('clip.mp4'), writer: nodeWriter(target), fields: { durationInSeconds: true }, acknowledgeRemotionLicense: true });
    expect(result).toEqual({ durationInSeconds: 0.5 });
    expect(readFileSync(target).equals(readFileSync(media('clip.mp4')))).toBe(true);
  });
});
