// `@remotion/webcodecs`: the decisions it makes about containers, codecs and tracks against values recorded from the
// published package (test/fixtures/webcodecs.json), the WAV conversion on a stub addon, and what throws as unsupported.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setMediaParserAddon, type MediaParserVideoTrack } from '../src/media-parser/index.js';
import { UnsupportedApiError } from '../src/unsupported.js';
import * as wc from '../src/webcodecs/index.js';
import { encodeWav } from '../src/webcodecs/convert-media.js';
import { bufferWriter } from '../src/webcodecs/writers.js';
import { fixture } from './helpers.js';

const data = fixture('webcodecs.json');

// parseMedia checks the file is there; what is in it is the addon's to read, and a stub stands in for that.
const dir = mkdtempSync(join(tmpdir(), 'kinetograph-webcodecs-test-'));
const clip = join(dir, 'clip.mp4');
writeFileSync(clip, 'not really media');

afterEach(() => setMediaParserAddon(null));

describe('exports', () => {
  it('are the published package\'s', () => {
    expect(Object.keys(wc).sort()).toEqual(data.exports);
  });
});

describe('containers and codecs', () => {
  it('lists what the published package offers for each container, and the defaults', () => {
    expect(wc.getAvailableContainers()).toEqual(data.containers);
    for (const t of data.tables) {
      expect(wc.getAvailableVideoCodecs({ container: t.container })).toEqual(t.video);
      expect(wc.getAvailableAudioCodecs({ container: t.container })).toEqual(t.audio);
      expect(wc.getDefaultVideoCodec({ container: t.container })).toBe(t.defaultVideo);
      expect(wc.getDefaultAudioCodec({ container: t.container })).toBe(t.defaultAudio);
    }
  });

  it('refuses a container it does not know, with the published messages', () => {
    const avi = { container: 'avi' as never };
    expect(() => wc.getAvailableVideoCodecs(avi)).toThrow(data.tableErrors.video);
    expect(() => wc.getAvailableAudioCodecs(avi)).toThrow(data.tableErrors.audio);
    expect(() => wc.getDefaultVideoCodec(avi)).toThrow(data.tableErrors.defaultVideo);
    expect(() => wc.getDefaultAudioCodec(avi)).toThrow(data.tableErrors.defaultAudio);
  });
});

describe('copying tracks', () => {
  it('canCopyAudioTrack decides as the published function does for every pairing', () => {
    expect(data.copyAudio.length).toBeGreaterThan(1000);
    for (const [inputCodec, inputContainer, outputContainer, outputAudioCodec, result] of data.copyAudio) {
      expect(wc.canCopyAudioTrack({ inputCodec, inputContainer, outputContainer, outputAudioCodec }), `${inputCodec} ${inputContainer} to ${outputContainer} ${outputAudioCodec}`).toBe(result);
    }
  });

  it('canCopyVideoTrack decides as the published function does: rotation, codec, resizing, container', () => {
    expect(data.copyVideo.filter((c: unknown[]) => c[10] === true).length).toBeGreaterThan(30);
    for (const c of data.copyVideo) {
      const [inputContainer, codecEnum, rotation, width, height, m3uStreamFormat, rotationToApply, outputContainer, outputVideoCodec, resizeOperation, result] = c;
      const inputTrack = { type: 'video', codecEnum, rotation, width, height, m3uStreamFormat } as unknown as MediaParserVideoTrack;
      const args = { inputContainer, inputTrack, rotationToApply, outputContainer, outputVideoCodec, resizeOperation };
      expect(wc.canCopyVideoTrack(args), JSON.stringify(c)).toBe(result);
    }
  });

  it('turns a rotation into 0 up to 360', () => {
    for (const { r, result } of data.rotation) expect(wc.WebCodecsInternals.normalizeVideoRotation(r)).toBe(result);
  });
});

describe('what to do with a track', () => {
  const video = { trackId: 3, type: 'video', codecEnum: 'h264', rotation: 0, width: 640, height: 360, m3uStreamFormat: null } as unknown as MediaParserVideoTrack;

  it('copies a track that can be copied, and drops one for a container that has none of its kind', async () => {
    const options = { track: video, logLevel: 'error' as const, rotate: 0, resizeOperation: null };
    for (const h of data.videoHandler) {
      expect(await wc.defaultOnVideoTrackHandler({ ...options, defaultVideoCodec: h.defaultVideoCodec, canCopyTrack: h.canCopyTrack } as never)).toEqual(h.result);
    }
    const sound = { trackId: 4, type: 'audio', codecEnum: 'aac', sampleRate: 48000, numberOfChannels: 2 } as never;
    for (const h of data.audioHandler) {
      expect(await wc.defaultOnAudioTrackHandler({ track: sound, defaultAudioCodec: h.defaultAudioCodec, logLevel: 'error', canCopyTrack: h.canCopyTrack } as never)).toEqual(h.result);
    }
  });

  it('can re-encode sound to WAV and nothing else, and no video: that is all the addon can write', async () => {
    const sound = { trackId: 4, type: 'audio', codecEnum: 'aac', sampleRate: 48000, numberOfChannels: 2 } as never;
    expect(await wc.canReencodeAudioTrack({ track: sound, audioCodec: 'wav', bitrate: 128000, sampleRate: null })).toBe(true);
    expect(await wc.canReencodeAudioTrack({ track: sound, audioCodec: 'aac', bitrate: 128000, sampleRate: null })).toBe(false);
    expect(await wc.canReencodeVideoTrack({ videoCodec: 'h264', track: video, resizeOperation: null, rotate: null })).toBe(false);
    // So a track that cannot be copied and has a codec to be written in is a failure, not a pretence.
    expect(
      await wc.defaultOnVideoTrackHandler({ track: video, defaultVideoCodec: 'h264', logLevel: 'error', rotate: 0, canCopyTrack: false, resizeOperation: null } as never),
    ).toEqual({ type: 'fail' });
    expect(
      await wc.defaultOnAudioTrackHandler({ track: sound, defaultAudioCodec: 'wav', logLevel: 'error', canCopyTrack: false } as never),
    ).toEqual({ type: 'reencode', bitrate: 128000, audioCodec: 'wav', sampleRate: null });
  });
});

describe('rotateAndResizeVideoFrame', () => {
  const frame = (extra: object = {}) => ({ displayWidth: 640, displayHeight: 360, timestamp: 5, duration: 10, close() {}, ...extra });

  it('returns the frame itself where it would come out unchanged, as the published function does', () => {
    for (const c of data.rotateTrivial) {
      const f = frame(c.extra);
      expect(wc.rotateAndResizeVideoFrame({ frame: f, rotation: c.rotation, resizeOperation: c.resizeOperation }) === f).toBe(c.same);
    }
    expect(() => wc.rotateAndResizeVideoFrame({ frame: frame(), rotation: 45, resizeOperation: null })).toThrow(data.rotateOdd);
  });

  it('cannot draw a new frame', () => {
    expect(() => wc.rotateAndResizeVideoFrame({ frame: frame(), rotation: 90, resizeOperation: null })).toThrow(UnsupportedApiError);
    expect(() => wc.rotateAndResizeVideoFrame({ frame: frame(), rotation: 0, resizeOperation: { mode: 'scale', scale: 0.5 } })).toThrow(UnsupportedApiError);
  });
});

describe('controller and errors', () => {
  it('has the controller the published package has, wired to a media parser controller', () => {
    const controller = wc.webcodecsController();
    expect(Object.keys(controller).sort()).toEqual(data.controllerKeys);
    const seen: string[] = [];
    controller.addEventListener('abort', () => seen.push('abort'));
    controller.abort();
    expect(seen).toEqual(['abort']);
    expect(controller._internals._mediaParserController._internals.signal.aborted).toBe(true);
  });

  it('has the undecodable errors', () => {
    const video = new wc.VideoUndecodableError({ message: 'm', config: { codec: 'avc1' } });
    const audio = new wc.AudioUndecodableError({ message: 'm', config: { codec: 'opus' } });
    expect([video.name, video.message, video.config, video instanceof Error]).toEqual(data.errors.video);
    expect([audio.name, audio.message, audio.config, audio instanceof Error]).toEqual(data.errors.audio);
  });
});

describe('convertMedia to WAV', () => {
  const stub = (channels: Float32Array[], rate = 8000) => {
    const decoded: [string, number][] = [];
    setMediaParserAddon({
      probeStreams: () => ({
        format: 'mov,mp4,m4a,3gp,3g2,mj2',
        durationInSeconds: 1,
        tags: [],
        streams: [
          { index: 0, id: 1, kind: 'video', codec: 'h264', timeBaseNumerator: 1, timeBaseDenominator: 15360, width: 64, height: 48, sampleAspectRatioNumerator: 1, sampleAspectRatioDenominator: 1, rotation: 0, colorRange: 0, colorPrimaries: 2, colorTransfer: 2, colorSpace: 2, sampleRate: 0, channels: 0, bitsPerSample: 0 },
          { index: 1, id: 2, kind: 'audio', codec: 'aac', timeBaseNumerator: 1, timeBaseDenominator: rate, width: 0, height: 0, sampleAspectRatioNumerator: 0, sampleAspectRatioDenominator: 1, rotation: 0, colorRange: 0, colorPrimaries: 2, colorTransfer: 2, colorSpace: 2, sampleRate: rate, channels: channels.length, bitsPerSample: 0 },
        ],
      }),
      scanStreams: () => [],
      decodeAudio: (path, sampleRate) => {
        decoded.push([path, sampleRate]);
        return { sampleRate, channels };
      },
    });
    return decoded;
  };

  it('writes the decoded sound as 16-bit PCM at the track\'s rate, dropping the video, and reports it', async () => {
    const left = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const right = Float32Array.from([0.25, -0.25, 0, 0, 0]);
    const decoded = stub([left, right]);
    const progress: number[] = [];
    const result = await wc.convertMedia({
      src: clip,
      container: 'wav',
      onProgress: (state) => progress.push(state.encodedAudioFrames),
    });
    expect(decoded).toEqual([[clip, 8000]]);
    const bytes = new Uint8Array(await (await result.save()).arrayBuffer());
    expect(bytes).toEqual(encodeWav([left, right], 8000));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getInt16(44 + 3 * 4, true)).toBe(32767);
    expect(view.getInt16(44 + 4 * 4, true)).toBe(-32768);
    expect(result.finalState).toMatchObject({ encodedAudioFrames: 5, decodedVideoFrames: 0, bytesWritten: bytes.length, overallProgress: 1 });
    expect(progress).toEqual([5]);
  });

  it('asks the decoder for the rate a custom handler names, and writes through the writer it is given', async () => {
    const decoded = stub([Float32Array.from([0.1, 0.2])]);
    let wrote = 0;
    const writer = {
      createContent: async (options: Parameters<typeof bufferWriter.createContent>[0]) => {
        const content = await bufferWriter.createContent(options);
        return { ...content, write: async (data: Uint8Array) => (wrote += data.length, content.write(data)) };
      },
    };
    await wc.convertMedia({
      src: clip,
      container: 'wav',
      writer,
      onAudioTrack: async ({ track }) => ({ type: 'reencode', audioCodec: 'wav', bitrate: 1, sampleRate: track.sampleRate / 2 }),
    });
    expect(decoded).toEqual([[clip, 4000]]);
    expect(wrote).toBe(44 + 4);
  });

  it('says what it cannot write', async () => {
    stub([Float32Array.of(0)]);
    await expect(wc.convertMedia({ src: clip, container: 'mp4' })).rejects.toThrow(/convertMedia\(\) to mp4 is not supported/);
    await expect(wc.convertMedia({ src: clip, container: 'wav', onVideoFrame: (o) => o.frame })).rejects.toBeInstanceOf(UnsupportedApiError);
    await expect(
      wc.convertMedia({ src: clip, container: 'wav', onVideoTrack: async () => ({ type: 'copy' }) }),
    ).rejects.toBeInstanceOf(UnsupportedApiError);
    await expect(
      wc.convertMedia({ src: clip, container: 'wav', onAudioTrack: async () => ({ type: 'fail' }) }),
    ).rejects.toThrow(/could neither be copied nor re-encoded/);
  });
});

describe('getPartialAudioData', () => {
  it('returns the samples of one channel between two times, at the track\'s rate', async () => {
    const rate = 100;
    const left = Float32Array.from({ length: 300 }, (_, i) => i);
    const right = Float32Array.from({ length: 300 }, (_, i) => -i);
    setMediaParserAddon({
      probeStreams: () => ({ format: 'wav', tags: [], streams: [{ index: 0, id: 0, kind: 'audio', codec: 'pcm_s16le', sampleRate: rate, channels: 2 } as never] }),
      scanStreams: () => [],
      decodeAudio: (_path, sampleRate) => ({ sampleRate, channels: [left, right] }),
    });
    const part = await wc.getPartialAudioData({ src: clip, fromSeconds: 1, toSeconds: 1.5, channelIndex: 1, signal: new AbortController().signal });
    expect(Array.from(part)).toEqual(Array.from({ length: 50 }, (_, i) => -(100 + i)));
    const controller = new AbortController();
    controller.abort();
    await expect(wc.getPartialAudioData({ src: clip, fromSeconds: 0, toSeconds: 1, channelIndex: 0, signal: controller.signal })).rejects.toThrow(/aborted/);
  });
});

describe('what needs a browser', () => {
  it('is exported and says so when called', async () => {
    const callers: [string, () => unknown][] = [
      ['createVideoDecoder', () => wc.createVideoDecoder({ track: { codec: 'avc1' }, onFrame: () => {}, onError: () => {} })],
      ['createAudioDecoder', () => wc.createAudioDecoder({ track: { codec: 'opus' }, onFrame: () => {}, onError: () => {} })],
      ['createVideoEncoder', () => wc.createVideoEncoder({} as never)],
      ['createAudioEncoder', () => wc.createAudioEncoder({} as never)],
      ['convertAudioData', () => wc.convertAudioData({} as never)],
      ['extractFrames', () => wc.extractFrames({ src: 'a.mp4', timestampsInSeconds: [0], onFrame: () => {} })],
    ];
    for (const [name, call] of callers) {
      let thrown: unknown;
      try {
        await call();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(UnsupportedApiError);
      expect((thrown as Error).message).toContain(`@remotion/webcodecs: ${name}() is not supported by Kinetograph`);
    }
  });
});

