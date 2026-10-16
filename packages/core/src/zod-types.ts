// `@remotion/zod-types`: `zColor`, `zMatrix` and `zTextarea`, zod schemas for the props a Composition's `schema` can
// describe. Each is an ordinary zod type with a marker in its description, which is how Remotion's Studio picks the
// editor for a field; nothing here renders, so the schemas only validate. Checked against the published package
// (test/fixtures/zod-types.json). `zod` is the project's: the core takes it as a peer dependency.

import { z } from 'zod';
import { processColor } from './process-color.js';

const REMOTION_COLOR_BRAND = '__remotion-color';
const REMOTION_MATRIX_BRAND = '__remotion-matrix';
const REMOTION_TEXTAREA_BRAND = '__remotion-textarea';

/** The channels of a colour string, each 0..255 (`a` too), as Remotion reads one; throws for an invalid string. */
const parseColor = (value: string): { a: number; r: number; g: number; b: number } => {
  const argb = processColor(value);
  return { a: argb >>> 24, r: (argb >>> 16) & 255, g: (argb >>> 8) & 255, b: argb & 255 };
};

/** A string that is a colour: a name, hex, `rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()` or `oklch()`. */
export const zColor = (): z.ZodString =>
  z
    .string()
    .refine(
      (value) => {
        try {
          parseColor(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Invalid color' },
    )
    .describe(REMOTION_COLOR_BRAND);

/** An array of numbers (multiples of 0.01) whose length is a square: 1, 4, 9, 16, … */
export const zMatrix = (): z.ZodArray<z.ZodNumber> =>
  z
    .array(z.number().step(0.01))
    .refine(
      (value) => {
        const root = Math.sqrt(value.length);
        return Number.isInteger(root) && root > 0;
      },
      { message: 'Invalid matrix, must be a square matrix' },
    )
    .describe(REMOTION_MATRIX_BRAND);

/** A string, edited as several lines of text. */
export const zTextarea = (): z.ZodString => z.string().describe(REMOTION_TEXTAREA_BRAND);

/** Not part of Remotion's documented API; the Studio reads these. */
export const ZodZypesInternals = { parseColor, REMOTION_COLOR_BRAND, REMOTION_TEXTAREA_BRAND, REMOTION_MATRIX_BRAND };
