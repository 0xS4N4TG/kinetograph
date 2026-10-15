// `@kinetograph/compat/css` (docs/COMPAT.md §3): inline style values parsed into typed values, and a `Diagnostic` for
// anything that cannot be. Pure functions, no dependencies. Stream 1.

import { imageListOf, positionListOf, repeatListOf, sizeListOf } from './background.js';
import { boxShadowOf, filterOf, textShadowOf } from './effects.js';
import { clipPathOf } from './shape.js';
import { CssError, lex } from './tokens.js';
import type { Tok } from './tokens.js';
import { transformOf } from './transform.js';
import type {
  BackgroundImage,
  BackgroundSize,
  BoxShadow,
  ClipShape,
  Diagnostic,
  FilterOp,
  Length,
  TextShadow,
  TransformOp,
} from './types.js';

export type * from './types.js';
export { parseStyle } from './style.js';
export { parseColor, parseRgba } from './color.js';
export { parseLength, resolveLength } from './values.js';

/** Runs `parse` over the lexed value, turning a parse failure into a `Diagnostic` for `property`. */
function diagnose<T>(property: string, value: string, parse: (toks: Tok[]) => T): T | Diagnostic {
  try {
    return parse(lex(value));
  } catch (e) {
    if (e instanceof CssError) return { property, value, reason: e.message };
    throw e;
  }
}

export function parseTransform(value: string): TransformOp[] | Diagnostic {
  return diagnose('transform', value, transformOf);
}
export function parseBoxShadow(value: string): BoxShadow[] | Diagnostic {
  return diagnose('boxShadow', value, boxShadowOf);
}
export function parseTextShadow(value: string): TextShadow[] | Diagnostic {
  return diagnose('textShadow', value, textShadowOf);
}
export function parseFilter(value: string): FilterOp[] | Diagnostic {
  return diagnose('filter', value, filterOf);
}
/** A basic shape. `none` is not a shape: it is a Diagnostic here, and `'none'` in `parseStyle`'s `clipPath`. */
export function parseClipPath(value: string): ClipShape | Diagnostic {
  return diagnose('clipPath', value, (toks) => {
    const shape = clipPathOf(toks);
    if (shape === 'none') throw new CssError('`none` is not a shape');
    return shape;
  });
}
export function parseBackgroundImage(value: string): BackgroundImage[] | Diagnostic {
  return diagnose('backgroundImage', value, imageListOf);
}
export function parseBackgroundSize(value: string): BackgroundSize[] | Diagnostic {
  return diagnose('backgroundSize', value, sizeListOf);
}
export function parseBackgroundPosition(value: string): [Length, Length][] | Diagnostic {
  return diagnose('backgroundPosition', value, positionListOf);
}
export function parseBackgroundRepeat(value: string): string[] | Diagnostic {
  return diagnose('backgroundRepeat', value, repeatListOf);
}
