// Imported by the CLI's Node bundle entry right after the determinism shim (docs/ENGINE.md §10): the browser globals a
// project commonly touches (`window` sizes, `matchMedia`, `new Image()`, `fetch` of project files, observers,
// `getComputedStyle`), `@font-face` rules of imported stylesheets, and SVG measurement. Not part of the Chrome
// bundle, where the page has the real ones.

import { resolveProjectFile, setCssFontFaceHandler, type CssFontFace } from '@kinetograph/compat/dom';
import { installDomGlobals, setPathMeasure } from '@kinetograph/compat/shim';
import { addFace, NodeFontFace } from './font-face.js';
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
