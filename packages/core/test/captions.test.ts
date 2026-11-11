import { describe, expect, it } from 'vitest';
import { createTikTokStyleCaptions, parseSrt, parseVtt, serializeSrt } from '../src/captions.js';
import { fixture } from './helpers.js';

const data = fixture('captions.json');

describe('parseSrt', () => {
  it('matches the recorded captions', () => {
    for (const c of data.parse) expect(parseSrt({ input: c.input }), JSON.stringify(c.input)).toEqual(c.result.value);
  });
});

describe('parseVtt (Remotion 4.0.540)', () => {
  const recorded = fixture('captions-vtt-4.0.540.json');

  it('matches the recorded captions and errors', () => {
    for (const c of recorded.cases) {
      if (c.result.error) expect(() => parseVtt({ input: c.input }), c.label).toThrow(c.result.error);
      else expect(parseVtt({ input: c.input }), c.label).toEqual(c.result.value);
    }
  });

  it('strips tags and decodes character references in cue text', () => {
    const cue = (text: string) => parseVtt({ input: `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${text}\n` }).captions[0]!.text;
    expect(cue('<v Bob>Hi <i>there</i></v>')).toBe('Hi there');
    expect(cue('a<00:00:01.500><c> b</c>')).toBe('a b');
    expect(cue('Tom &amp; Jerry &#65;&#x42;')).toBe('Tom & Jerry AB');
    expect(cue('&lt;i&gt;kept&lt;/i&gt; &amp;lt;')).toBe('<i>kept</i> &lt;');
    expect(cue('&#0; &#xD800;')).toBe('&#0; &#xD800;');
  });

  it('keeps the text of YouTube automatic captions, whose cues start with a line of one space', () => {
    const { captions } = parseVtt({ input: 'WEBVTT\n\n00:00:00.320 --> 00:00:03.040 align:start position:0%\n \nwelcome<00:00:00.640><c> to</c>\n' });
    expect(captions).toEqual([{ text: 'welcome to', startMs: 320, endMs: 3040, timestampMs: 1680, confidence: 1 }]);
  });
});

describe('serializeSrt', () => {
  it('matches the recorded text', () => {
    for (const c of data.serialize) expect(serializeSrt(c.args), JSON.stringify(c.args)).toBe(c.result.value);
  });

  it('round-trips what parseSrt reads', () => {
    const input = data.parse[0].input as string;
    const { captions } = parseSrt({ input });
    expect(serializeSrt({ lines: captions.map((c) => [c]) })).toBe(input.trim());
  });
});

describe('createTikTokStyleCaptions', () => {
  it('matches the recorded pages for many limits', () => {
    for (const c of data.tiktok) {
      const args: any = { captions: data.words };
      if (c.combineTokensWithinMilliseconds !== null) args.combineTokensWithinMilliseconds = c.combineTokensWithinMilliseconds;
      expect(createTikTokStyleCaptions(args), `limit ${c.combineTokensWithinMilliseconds}`).toEqual(c.result.value);
    }
  });

  it('matches the recorded edge cases', () => {
    for (const c of data.other) expect(createTikTokStyleCaptions(c.args), JSON.stringify(c.args)).toEqual(c.result.value);
  });

  it('matches Remotion 4.0.542: a break only before a word that starts with a space, pageBreakAfter, silence', () => {
    const recorded = fixture('captions-tiktok-4.0.542.json');
    for (const c of recorded.cases) expect(createTikTokStyleCaptions(c.args), c.name).toEqual(c.result);
  });
});
