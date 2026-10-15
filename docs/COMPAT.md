# Remotion compat mode (Phase 5)

Written 2026-10-15 by the Phase 5 orchestrator (`HANDOFF.md` §8, "Phase 5 in the same cloud session"). The Chrome
fallback this file used to define was removed on 2026-10-16 (Phase 6); §6 is now what happens to unsupported content.

**Status (2026-10-15, the full engine, `ENGINE.md`).** DOM elements are no longer mapped onto layers in TypeScript. A
DOM island is handed to the addon as an `IslandRequest` and styled, laid out and painted in Rust (Stylo, taffy,
Parley through Blitz's DOM, our compositor): `className`, stylesheets, `<style>`, Tailwind, `calc()`, `var()`, grid,
selectors and everything else the CSS engine knows are drawn or reported by it. What this file still defines is the
compat contract around that: the pipeline (§2), what happens to unsupported content (§6) and `doctor` (§7). The old §3 to §5, the
TypeScript mapping with its tables of supported properties, are **removed**: `packages/compat/src/css` and
`src/dom/{box,map,paint,svg,text,…}.ts` were deleted on `engine/runtime` (the last commit that has them is
`feat/full-engine`'s parent, `e082bad`). What the Rust side draws and what it reports is in `ENGINE.md` §4 and §5
and in the painter's own notes; how the TypeScript side builds the request, reads the answer and answers refs is
`ENGINE.md` §10.

`AUTHORING.md` §1's rules hold.

Compat mode is not a switch. The reconciler accepts DOM host elements (`div`, `span`, `svg`, …) next to the native
`kg-*` ones, so an unported Remotion project renders as it is. What the engine cannot draw is reported as
unsupported and left out or approximated; no frame is ever drawn by a browser.

## 1. Layout and ownership

| Path | Owner | What |
|---|---|---|
| `packages/compat` (`@kinetograph/compat`): `src/types.ts`, `src/index.ts` | orchestrator (complete) | `Unsupported`, `DomNode` |
| `packages/compat/src/css/` | stream 1 `feat/compat-css` | removed (the CSS parsers of the TypeScript mapping) |
| `packages/compat/src/dom/` (`/dom`), `src/request/`, `src/shim/`; the DOM parts of `packages/react/src/{root,emit,readback}.ts`; `packages/core/src/{fill,web-install}.tsx` | stream 2 `feat/compat-dom`, then `engine/runtime` | DOM host elements → `IslandRequest` → the addon (`ENGINE.md` §10); the addon's old `layoutDom` is no longer called from TypeScript |
| `packages/cli/src/compat-report.ts`; the `--strict` option of `render`, `still`, `strip` | Phase 6 | the warning for unsupported content and `--strict` (§6). The Chrome bundle and driver, `videoFrame`, `VideoWriter.pushRgba` and `--compat` of stream 3 `feat/chrome-fallback` were removed |
| `packages/compat/src/doctor.ts`; `packages/cli/src/commands/doctor.ts`; the `lint` and MCP wiring | stream 4 `feat/doctor` | `kinetograph doctor` (§7) |

Dependencies point one way: `scene` ← `compat` ← `react` ← `core`. `compat` imports no React and no addon; the
addon's `layoutDom` is handed to it with `setLayoutDom`, as `layoutText` is handed to core.

## 2. The pipeline

```
React tree with DOM host elements (div, span, svg, …) and native ones (kg-*)
  reconciler (root.ts): DOM elements become host nodes keeping their props, as kg-* ones do
  emit, per frame: each outermost run of DOM nodes is a DOM island, handed to mapDomIsland (compat/dom):
     request: DomNode tree → IslandRequest JSON (tags, attributes, style as CSS text, stylesheets, time)   (ENGINE.md §10.1)
     addon:   renderDomIsland(json): Stylo + taffy + Parley, painted as scene layers                      (Rust)
     fill:    the `native` placeholders in the answer → the kg-* elements' own layers at those boxes
     report:  what the painter could not draw → RenderedTree.unsupported
  frame loop: FrameResult.unsupported
  render: every frame → the addon, in order, one encoder; unsupported items are warned about (§6)
```

```ts
// @kinetograph/compat (types.ts)
type DomNode = { kind: 'element'; type: string; props: Record<string, any>; children: DomNode[] } | { kind: 'text'; text: string };
interface IslandContext {
  path: string;                                   // the island root's host-tree index path ($0.2)
  viewport: { width: number; height: number };    // the composition's size
  fonts: Record<string, string>;                  // getFonts()
  /** Emits a native (kg-*) element found inside the island, as the reconciler would at that path. */
  emitNative(node: DomNode, path: string): LayerJson | null;
  time?: number; baseDir?: string; publicDir?: string; stylesheets?: readonly string[];   // see ENGINE.md §10.1
}
interface IslandResult { layers: LayerJson[]; unsupported: Unsupported[]; camera: CameraJson | null; margin?: number }
function mapDomIsland(root: DomNode, context: IslandContext): IslandResult;      // compat/dom
```

- **What a project brings with it.** A Remotion project is bundled as it is, with these allowances:
  - `import './index.css'` (Tailwind's entry, say) is read: the file's text, with its local `@import`s inlined, becomes
    one of the document's stylesheets; Tailwind is built with the project's own (`ENGINE.md` §10.2); `*.module.css` files
    export their scoped class names.
  - The entry runs even when the project's package.json lists `"sideEffects"` without it, as Remotion's templates do.
  - `staticFile` reads `public/` beside the entry, else `public/` beside the nearest package.json (Remotion's place,
    with the entry in `src/`).
  - `@remotion/media`'s `<Audio>` and `<Video>` are the engine's.
  - `new FontFace(family, "url(...)", { weight, style, unicodeRange })` with `document.fonts.add(face)`, and `@font-face`
    rules of stylesheets, register the file (`registerFont`). One file is kept per family, weight and style; of a face
    split by `unicodeRange`, the one covering basic Latin. WOFF and WOFF2 files are unpacked by the text engine (`wuff`).
- **The containing box.** A DOM island is laid out as CSS would lay it out in a box the composition's size, as
  Remotion's root `div` is. An `<AbsoluteFill>` or `<Sequence>` wrapper with DOM inside it is the absolutely positioned
  column-flex `div` it is in Remotion, in the same island as the DOM around it (`ENGINE.md` §10.1). A DOM island inside
  a native `<Layer>` is laid out in the composition's box, and the layer's own layout box is not known to it.
  Every top-level layer an island emits carries `layoutItem: { position: 'absolute' }`, so a native flex parent does not
  move it again.
- **Native elements inside DOM.** A native element inside a DOM element is a replaced box of its own box's size. A
  layer without a box (a group without `layout`) is 0 × 0. It is placed by CSS and drawn as it is.
- **Constants.** DOM styles are read at the frame, so animation comes from the component re-rendering, as in Remotion;
  CSS `@keyframes` read the frame's time.
- **Ids.** The layers a DOM node expands into have ids derived from the node's id: the explicit `id` attribute if it is
  a valid layer id, else the host-tree index path (AUTHORING §6.3), with the painter's suffixes.

## 3. to 5. CSS values, elements, properties and layout (removed)

These sections described the TypeScript mapping: the CSS value parsers (`@kinetograph/compat/css`), the element and
property tables, the `layoutDom` request and the paint order rules. They are replaced by Stylo (CSS values, cascade,
selectors), taffy and Parley (layout, text) and the painter in Rust (`ENGINE.md` §1 to §5). The unsupported items of a
frame are now whatever the painter reports (`IslandOutput.unsupported`), with the same shape as before (§6.1).

## 6. Unsupported content

Phase 5 drew a frame holding an unsupported item in headless Chrome. Kinetograph ships no browser, so that fallback
is gone (`DECISION_RENDERING_CRITICAL.md`). Canvas 2D, the CSS gaps, WebGL fragment shaders and the own 3D layer are
ported, and the papercut corpus draws 988 of 988 frames with nothing unsupported. What is still missing is ported
natively, never worked around.

### 6.1 The rule

Every frame is drawn by the engine. `FrameResult.unsupported` lists what the painter could not draw as a browser
would; it is drawn without it, or approximated as the painter's notes say. The decision is never per frame or per
scene: there is only one path.

```ts
// @kinetograph/scene
interface Unsupported {
  path: string;            // the element's host-tree path and tag: '$0.2.1 <div>'
  element: string;         // 'div', 'svg > text', …
  property: string | null; // 'transform'; null for an unsupported element
  value: string | null;
  reason: string;
}
```

- **The warning.** `render`, `still` and `strip` print one line per kind of unsupported content on stderr after
  drawing (element, property, values, reason, the frames), at most 12 kinds, and nothing when there is none. `--json`
  keeps stderr quiet and puts the full list in the result: `compat: { unsupportedFrames, leftOut: [{ element,
  property, reason, values, frames, firstFrame, lastFrame }] }`. The text of `render` adds `unsupported content left
  out of N frames`.
- **`--strict`.** `render`, `still` and `strip` take `--strict`: the first frame that holds an unsupported item fails
  the command with the error code `UNSUPPORTED_CONTENT` (exit code 1, like every error), naming the frame and up to
  five items. `render` aborts the video, so no output file is left. It is off by default, because an approximate video
  is more useful than none while the port is not finished; CI and finished projects pass `--strict` to keep them
  exact. It is checked as the frames come, so a `--strict` render stops at the first bad frame, not after the last.
- **Other commands.** `bench`, `onion` and `snapshot` draw as they are and do not warn. The studio shows a frame's
  unsupported items as a warning.
- **What counts.** An unsupported item counts only on frames where its element is in the tree. Subtrees with
  `display: none` and boxes with `visibility: hidden` are not checked.

### 6.2 Chrome as a test oracle

Chrome for Testing is used only by tests and tools that check the engine, never by `render`: the golden cases of
`crates/dom/tests` (a headless Chrome whose path is in `KINETOGRAPH_CHROME`, else under `~/.cache/kinetograph/chrome/chrome`),
`crates/dom/tools/chrome-compare.mjs` (puppeteer-core, a root dev dependency) and the comparison of `scripts/corpus.mjs
--reference` with Remotion's own mp4. Get Chrome for Testing 154 (the build the goldens were made with) with
`npx @puppeteer/browsers install chrome@154.0.8037.57 --path ~/.cache/kinetograph/chrome`; nothing in the CLI downloads it any more.

## 7. `doctor` (stream 4)

`kinetograph doctor <entry> [--comp] [--props] [--range] [--json]` runs the JS stage for every frame of the range (no
GPU) and reports:

```ts
// @kinetograph/compat (doctor.ts)
interface DoctorReport {
  comp: string; first: number; last: number; frames: number;
  cleanFrames: number;          // frames with nothing unsupported: drawn in full
  unsupportedFrames: number;    // frames with at least one unsupported item
  cleanShare: number;           // 0..1
  issues: DoctorIssue[];                                              // most frames first
  notes?: string[];   // problems with the project's stylesheets that no frame shows (Tailwind that could not be built, …)
}
interface DoctorIssue {
  element: string; property: string | null; reason: string;   // the group key
  values: string[];                                          // distinct values seen, at most 5
  paths: string[];                                           // distinct element paths, at most 5
  ranges: [first: number, last: number][];                   // inclusive, ascending
  frames: number;
}
function summarize(comp: string, frames: readonly { frame: number; unsupported: readonly Unsupported[] }[]): DoctorReport;
```

- **`lint`** adds one finding per issue group, rule `compat`, severity `warning`: the frame still renders, without
  the item or approximated.
- **MCP.** The MCP server gets a `doctor` tool with the same arguments, and `still`, `strip` and `render` take
  `strict`.
- **Against a reference.** `doctor --compare` (native against Chrome) is gone with the fallback.
  `scripts/corpus.mjs` (`ENGINE.md` §10.5) reports the coverage of the papercut episode, and with `--reference` how far
  its native frames are from Remotion's own render.
