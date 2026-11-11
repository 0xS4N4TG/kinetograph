// Imported by the CLI's Node bundle entry right after the determinism shim (packages/cli/skills/kinetograph-markup/references/ENGINE.md §10): the browser globals a
// project commonly touches (`window` sizes, `matchMedia`, `new Image()`, `fetch` of project files, observers,
// `getComputedStyle`), `@font-face` rules of imported stylesheets, and SVG measurement.

import { hasAddonFunction, measureSpan, noteStylesheetProblem, resolveProjectFile, setCssFontFaceHandler, setRemoteAssetResolver, setRemoteStylesheetResolver, type CssFontFace } from '@kinetographdev/compat/dom';
import { installDomGlobals, setCanvasFonts, setPathMeasure, setWorkerHold } from '@kinetographdev/compat/shim';
import { continueRender, delayRender } from './assets.js';
import { addFace, NodeFontFace } from './font-face.js';
import { getFonts, setFontProblemHandler } from './font-registry.js';
import { setDomTextMeasure } from './layout-utils.js';
import { lockedFontFile, makeRemoteAssetResolver } from './remote-assets.js';
import { getBoundingBox, getLength, getPointAtLength } from './paths.js';

/** An `@font-face` rule of a stylesheet (a `.css` import, a `<style>` element): its file is registered like a `FontFace`. */
export function registerCssFontFace(face: CssFontFace): void {
  let file: string | null;
  if (face.remote) {
    // A face from a remote stylesheet is only ever read from the cache `fetch-deps` filled and locked: never downloaded
    // during a render, never a file of the project.
    file = /^https:\/\//i.test(face.url) ? lockedFontFile(face.url) : null;
    if (file === null) {
      console.warn(`@font-face "${face.family}": ${face.url} is not downloaded and locked, so the font is not loaded (run \`kinetograph fetch-deps <entry>\`)`);
      return;
    }
  } else if (/^http:/i.test(face.url)) {
    // Only https: a font over plain http is not fetched (it could be changed on the way).
    console.warn(`@font-face "${face.family}": ${face.url} is not https, so the font is not loaded`);
    return;
  } else {
    // A remote file is downloaded once into the font cache, as for `new FontFace`.
    file = /^https?:/i.test(face.url) ? face.url : resolveProjectFile(face.url);
    if (file === null) {
      console.warn(`@font-face "${face.family}": ${face.url} was not found beside the entry or in public/`);
      return;
    }
  }
  addFace(
    new NodeFontFace(face.family, `url("${file}")`, {
      weight: face.weightMax === undefined ? face.weight : `${face.weight} ${face.weightMax}`,
      style: face.style,
      ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
    }),
  );
}

installDomGlobals();
// A frame waits for the messages a worker or a MessageChannel still has in flight, as for any other `delayRender`.
setWorkerHold(() => {
  const handle = delayRender('worker messages');
  return () => continueRender(handle);
});
setCssFontFaceHandler(registerCssFontFace);
// A font that could not be had is a note in `doctor` and `lint`, like a stylesheet that could not be built.
setFontProblemHandler(noteStylesheetProblem);
// A remote image or video is downloaded once into the asset cache.
setRemoteAssetResolver(makeRemoteAssetResolver(noteStylesheetProblem));
// A remote stylesheet an `@import` names is only read from what `fetch-deps` downloaded and locked.
setRemoteStylesheetResolver(makeRemoteAssetResolver(noteStylesheetProblem, { cachedOnly: true }));
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
