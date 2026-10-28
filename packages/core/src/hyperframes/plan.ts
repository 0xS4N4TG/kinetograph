// What the CLI's HyperFrames loader hands the runtime (`runtime.tsx`): an HTML project (an index.html and the
// compositions it mounts) read into plain data, so the bundle holds no HTML parser and no file reads. The loader
// is `packages/cli/src/hyperframes/plan.ts`; the contract it follows is HyperFrames' (Apache-2.0, heygen-com/hyperframes).

/** One node of the document: an element with its attributes, or text. Comments, `<script>`, `<style>` and `<link>` are not nodes. */
export type HfNode =
  | { t: 'text'; text: string }
  | {
      t: 'el';
      tag: string;
      svg?: boolean;
      attrs: [name: string, value: string][];
      children: HfNode[];
      /** A `<template>`'s content: inert, outside the document, reached by a script as `template.content`. */
      content?: HfNode[];
    };

/** A script, run in document order once the document is built. */
export interface HfScript {
  code: string;
  /** Where it came from, for messages: a file, or a URL for a library. */
  file: string;
  /** The composition it belongs to (its `document`, `gsap` and `window.__timelines` are scoped to it); null for the page's own. */
  scope: string | null;
  /** The composition's file, for `assetUrl`; null for the page's. */
  sourceFile: string | null;
}

export interface HfStylesheet {
  css: string;
  file: string;
}

export interface HfGoogleFont {
  family: string;
  /** Variants as the CSS API names them: `400`, `700`, `400i`. */
  variants: string[];
  /** Other names the faces are registered under: the families a page names that HyperFrames draws in this one (`Arial` is Inter). */
  as?: string[];
  /** A family the page does not ask for by a link but names in its CSS: read from the font cache only (`fetch-deps` fills it), never downloaded while rendering. */
  cacheOnly?: boolean;
}

export interface HfPlan {
  /** The index.html. */
  file: string;
  /** The project's directory: asset paths resolve from here. */
  baseDir: string;
  /** The root composition's `data-composition-id` (the timeline registry key). */
  compositionId: string;
  width: number;
  height: number;
  fps: number;
  /** The root's `data-duration` in seconds, or null: then the timelines and the media say. */
  durationSeconds: number | null;
  /** Attributes of `<html>` and `<body>`, which the runtime gives the page's own `html` and `body` (`setPageDocument`). */
  htmlAttrs: [string, string][];
  bodyAttrs: [string, string][];
  body: HfNode[];
  /** Stylesheets in the order the document has them: `<style>`, `<link rel=stylesheet>`, those of mounted compositions (already scoped). */
  stylesheets: HfStylesheet[];
  scripts: HfScript[];
  googleFonts: HfGoogleFont[];
  /** The declared defaults and the host's values of each composition's variables (`getVariables()`), by composition id. */
  variables: Record<string, Record<string, unknown>>;
  /** Remote files the page fetches that `fetch-deps` has cached: URL to the cached file's path. `fetch(url)` of one reads it. */
  remoteData: Record<string, string>;
  /** Natural duration in seconds of each media file (absolute path), probed by the CLI. */
  mediaDurations: Record<string, number>;
  /** Things the loader saw and the engine cannot do (Three.js, an import map), shown by `doctor`. */
  notes: string[];
  /** Whether a script of the project is Three.js: every frame reports it. */
  usesThree: boolean;
}
