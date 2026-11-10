import { describe, expect, it } from 'vitest';
import { extractGoogleFontImports } from '../src/hyperframes/css.js';

const CSS_URL = 'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Instrument+Serif:ital@0;1&display=swap';

describe('the @import of Google Fonts the engine reads', () => {
  it('takes out an import whose URL has semicolons, quoted or not', () => {
    const quoted = extractGoogleFontImports(`@import url("${CSS_URL}");\nbody{}`);
    expect(quoted.css.trim()).toBe('body{}');
    expect(quoted.fonts.map((f) => [f.family, f.variants])).toEqual([
      ['Space Mono', ['400', '700']],
      ['Instrument Serif', ['400', '400i']],
    ]);
    expect(extractGoogleFontImports(`@import '${CSS_URL}';`).fonts).toHaveLength(2);
    expect(extractGoogleFontImports('@import url(https://fonts.googleapis.com/css?family=Lato:400,700);').fonts).toEqual([{ family: 'Lato', variants: ['400', '700'] }]);
  });
});
