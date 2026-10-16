import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { processColor } from '../src/process-color.js';
import * as zodTypes from '../src/zod-types.js';
import { zColor, zMatrix, zTextarea, ZodZypesInternals } from '../src/zod-types.js';
import { fixture } from './helpers.js';

const data = fixture('zod-types.json');

const messages = (schema: z.ZodType, input: unknown): string[] | null => {
  const result = schema.safeParse(input);
  return result.success ? null : result.error.issues.map((issue) => issue.message);
};

describe('@remotion/zod-types', () => {
  it('exports what the published package does, with its brands', () => {
    expect(Object.keys(zodTypes).sort()).toEqual(data.exports);
    expect(Object.keys(ZodZypesInternals).sort()).toEqual(data.internalsKeys);
    expect(ZodZypesInternals.REMOTION_COLOR_BRAND).toBe(data.brands.color);
    expect(ZodZypesInternals.REMOTION_MATRIX_BRAND).toBe(data.brands.matrix);
    expect(ZodZypesInternals.REMOTION_TEXTAREA_BRAND).toBe(data.brands.textarea);
  });

  it('describes each schema with its brand and keeps zod\'s own types', () => {
    expect(zColor().description).toBe(data.descriptions.color);
    expect(zMatrix().description).toBe(data.descriptions.matrix);
    expect(zTextarea().description).toBe(data.descriptions.textarea);
    expect(zColor().def.type).toBe(data.typeNames.color);
    expect(zMatrix().def.type).toBe(data.typeNames.matrix);
    expect(zTextarea().def.type).toBe(data.typeNames.textarea);
  });
});

describe('zColor', () => {
  it('accepts and refuses the same strings as the published schema, with its message', () => {
    for (const c of data.parse) {
      expect(messages(zColor(), c.input), JSON.stringify(c.input)).toEqual(c.message);
    }
  });

  it('parses to the same channels as the published parseColor, and fails with the same error', () => {
    for (const c of data.parse) {
      if (c.parsed) expect(ZodZypesInternals.parseColor(c.input), JSON.stringify(c.input)).toEqual(c.parsed);
      else expect(() => ZodZypesInternals.parseColor(c.input), JSON.stringify(c.input)).toThrow(c.error);
    }
  });

  it('gives the 0xAARRGGBB the published processColor gives, over many strings', () => {
    expect(data.processColor.length).toBeGreaterThan(300);
    for (const [input, value] of data.processColor) {
      if (value === null) expect(() => processColor(input), JSON.stringify(input)).toThrow(/invalid color string/);
      else expect(processColor(input), JSON.stringify(input)).toBe(value);
    }
  });

  it('works inside an object schema, as a Composition schema uses it', () => {
    const schema = z.object({ title: zTextarea(), tint: zColor(), skew: zMatrix() });
    const props = { title: 'a\nb', tint: '#0b84f3', skew: [1, 0, 0, 1] };
    expect(schema.parse(props)).toEqual(props);
    expect(messages(schema, { ...props, tint: 'bluish' })).toEqual(['Invalid color']);
  });
});

describe('zMatrix', () => {
  it('accepts and refuses the same arrays as the published schema, with its messages', () => {
    for (const m of data.matrix) expect(messages(zMatrix(), m.input), JSON.stringify(m.input)).toEqual(m.messages);
  });
});

describe('zTextarea', () => {
  it('is a string, empty included, and nothing else', () => {
    for (const t of data.textareas) {
      const input = t.input === '__undefined__' ? undefined : t.input;
      expect(messages(zTextarea(), input), JSON.stringify(t.input)).toEqual(t.messages);
      if (t.success) expect(zTextarea().parse(input)).toBe(t.data);
    }
  });
});
