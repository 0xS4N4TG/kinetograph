# phase3 — decisions

## Per-frame scene JSON through one warm renderer
**Date:** 2026-10-14
**Call:** JS emits a complete SCENE.md document per frame (constant values) and the addon swaps it into one Renderer
(`set_scene`) that keeps device, pipelines, assets by file and the layer cache.
**Why:** React output is arbitrary per frame; keyframes can't express it. GPU setup is ~0.45 s, so it happens once.

## Motion blur renders the whole tree at sub-frames
**Date:** 2026-10-14
**Call:** the frame loop renders the composition at each sub-frame time and fills `motionBlur.frames` by id.
**Why:** a layer's own animated props are computed by its parent, so blurring only children would miss them.

## Transform origin is CSS transform-origin
**Date:** 2026-10-14
**Call:** origin moves the pivot, not the layer (stream 4); the contract's "added to the anchor" was changed.

## Sequence does not lay out; AbsoluteFill does
**Date:** 2026-10-14
**Call:** Sequence wraps children in a plain group; AbsoluteFill is a flex-column group, absolute in its parent.
**Why:** native elements keep their own x/y; Remotion code centring in AbsoluteFill still works.

## MCP server runs the CLI as a child process
**Date:** 2026-10-14
**Call:** the determinism shim (virtual Date, timers, Math.random) is installed only in the process that loads a project.
