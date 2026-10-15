import { describe, expect, it } from 'vitest';
import { createTikTokStyleCaptions, parseSrt, serializeSrt } from '../src/captions.js';
import { fixture } from './helpers.js';

const data = fixture('captions.json');

describe('parseSrt', () => {
  it('matches the recorded captions', () => {
    for (const c of data.parse) expect(parseSrt({ input: c.input }), JSON.stringify(c.input)).toEqual(c.result.value);
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
});
