// Imported by the CLI's Node bundle entry right after the determinism shim (docs/ENGINE.md §10): the browser globals a
// project commonly touches (`window` sizes, `matchMedia`, `new Image()`, `fetch` of project files, observers,
// `getComputedStyle`), `@font-face` rules of imported stylesheets, and SVG measurement.

import { hasAddonFunction, measureSpan, resolveProjectFile, setCssFontFaceHandler, type CssFontFace } from '@kinetograph/compat/dom';
import { installDomGlobals, setCanvasFonts, setPathMeasure } from '@kinetograph/compat/shim';
import { addFace, NodeFontFace } from './font-face.js';
import { getFonts } from './font-registry.js';
import { setDomTextMeasure } from './layout-utils.js';
import { getBoundingBox, getLength, getPointAtLength } from './paths.js';

/** An `@font-face` rule of a stylesheet (a `.css` import, a `<style>` element): its file is registered like a `FontFace`. */
export function registerCssFontFace(face: CssFontFace): void {
  const file = resolveProjectFile(face.url);
  if (file === null) {
    console.warn(`@font-face "${face.family}": ${face.url} was not found beside the entry or in public/`);
    return;
  }
  addFace(
    new NodeFontFace(face.family, `url("${file}")`, {
      weight: face.weight,
      style: face.style,
      ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
    }),
  );
}

installDomGlobals();
setCssFontFaceHandler(registerCssFontFace);
setPathMeasure({ getLength, getPointAtLength, getBoundingBox });
// A canvas's `font` is matched against the registered fonts.
setCanvasFonts(getFonts);

// `measureText` and `fitText` ask the DOM engine for the box of a `span`, as Remotion asks Chrome.
setDomTextMeasure((options, fonts) => {
  if (!hasAddonFunction('domLayoutBoxes')) return null;
  const style: Record<string, unknown> = {
    fontFamily: `"${options.fontFamily}"`,
    fontSize: options.fontSize,
    ...(options.fontWeight !== undefined ? { fontWeight: options.fontWeight } : {}),
    ...(options.fontStyle !== undefined ? { fontStyle: options.fontStyle } : {}),
    ...(options.letterSpacing !== undefined ? { letterSpacing: options.letterSpacing } : {}),
    ...(options.textTransform !== undefined ? { textTransform: options.textTransform } : {}),
    ...(options.fontVariantNumeric !== undefined ? { fontVariantNumeric: options.fontVariantNumeric } : {}),
    ...options.additionalStyles,
  };
  return measureSpan(options.text, style, fonts);
});
