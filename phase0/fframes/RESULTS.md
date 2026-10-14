# fframes Phase 0 results (reduced scope: one still)

Scope: the user cut this down mid-run to a single still of the reference's 3D card-stack moment (rajz-reference.mp4 at 22.0 s). The papercut target (ep 13 S04Meter) was not attempted. Everything below is for that one still, plus a few things I measured before the scope change. Log with every iteration: `LOG.md`. Code: `reference/src/lib.rs`. Comparison: `compare/reference_still_ref_left_fframes_right.jpg` (reference left, fframes right, both 960 px wide).

## Result in one line
An agent following the fframes skill got a recognisable version of the card stack on screen in 2 builds and a close one in 7, but only by faking perspective with 32 vertical image strips per card, because fframes has no 3D or perspective transform.

## Fidelity verdict (still at 22.0 s): partial match
- Matches: an overlapped row of photo cards on a light grey ground, each card a trapezoid (left edge taller than the right, as in the reference), front card ~440x600 px at about the same screen position, older cards stepping left and down with decreasing size, entering card coming in from lower right.
- Differs: the reference's stack of thin card slivers at bottom left is missing; card sizes and spacing are approximate (eyeballed from the frames, no pixel measurement); photos are stand-ins cropped from the video; at this instant the reference front card is a newer photo than mine (card order and timing are only roughly matched). The edges of the strips are slightly softer than a true projected quad.
- Not judged: motion. I rendered a 5 s clip (cards, "gets/better", "you ... create", blur/gradient-map whip into a gradient, typed tail text) before the scope change and looked at it in contact sheets only; not part of the still verdict.

## Iterations and build times (measured, from LOG.md)
- 7 builds for the reference: 1 cold (7 m 23 s, includes all dependencies and the prebuilt Skia/ffmpeg download; failed with a compile error), then 6 incremental: 16.8, 14.5, 13.6, 14.4, 16.5, 16.5 s. Median 15.5 s, max 16.8 s. Almost all of it is linking, not compiling my 200 lines.
- Error types: 1 Rust compile error (borrow/lifetime, E0597: a `String` passed to `frame.text_width(ctx, ..)` must outlive the scene lifetime `'a`; fixed by using a `&'static str` slice). 0 fframes API misuses. 6 iterations for visual tuning. The first render (strip) worked right after the lifetime fix.
- Still latency: `frame 1.0s` 0.09-0.11 s wall steady state (5 runs, 1920x1080, Skia on Metal), 0.235 s first call, 1.6-1.8 s on the first call after a relink. For comparison Remotion needs ~2.0 s (bundle ready) / 2.8 s (from source) per still on the same machine (remotion-baseline.md, a different scene).
- Render speed (measured before the scope change, reference clip only, 125 frames at 1920x1080, libx264 CRF 20, Skia Metal): 3.5-3.9 s wall per full render, about 28-31 ms/frame, 1.3 GB RSS. Not comparable with the Remotion baseline (different, simpler scene; papercut not ported).

## Walls, ranked by severity
1. No 3D / perspective transform (blocking for fidelity). SVG gives affine transforms only. The skill itself says "SVG skew is a 2D transform" and tells you to use separate poses and perspective projection, but gives no way to draw a projected image quad. Workaround: slice each photo into N vertical strips with `clipPathUnits="objectBoundingBox"` clip paths, and scale each strip's height to the trapezoid height at its x. 8-16 strips left visible stair-steps on edges and hairline seams (fixed with 32 strips and a 3% clip overlap), which costs ~300 `<image>` draws per frame. A real vertical-edge-only yaw works this way; a card with roll or pitch would not. Depth sort is manual (draw order by age).
2. No camera or scene graph. Projection, depth ordering, and per-card poses are hand-written Rust math in `render_frame`; nothing in fframes helps here.
3. Rust-specific friction: lifetimes in `svgr!` and text measurement (one compile error here), and every photo is compiled into the binary via `include_media_dir!`, so swapping a crop recompiles the crate.
4. Environment: the system `rustc` was broken (Homebrew LLVM needs libz3.4.15; z3 is 5.1). Needed a DYLD_FALLBACK_LIBRARY_PATH shim. Not fframes' fault, but an agent would stall here. `npx skills add` also dumps .hermes/.kiro/.zcode/.claude/.agents dirs into the project.
5. Mostly worked, no wall: SVG filters (feGaussianBlur, feColorMatrix, feComponentTransfer table, feComposite arithmetic) rendered on Skia, which I used for the blur plus gradient map in the whip; blur is isotropic per filter, not motion blur. `mix-blend-mode`, feTurbulence/feDisplacementMap and grain multiply were not tried (papercut target dropped).

## Hypotheses from HANDOFF section 2
Measured here (one still, one agent):
- First-try correctness: the skill plus API docs were enough to write a ~200-line scene that compiled after one fix and produced a correct first render. The one failure was a Rust lifetime error that the compiler message explained well. The API (`svgr!`, `timeline!`, `text_width`) caused no misuse errors. Weak evidence for "a Rust authoring API is not a first-try problem", but this was one author and a scene with little text layout.
- Fix-loop speed: ~15 s per incremental build, plus ~0.1-1 s for `frame`/`strip`. So an edit-to-image loop is about 15-17 s, versus Remotion's ~2-3 s per still but no build step, versus the hot-reload target (ms) for Kinetograph. Fast enough that I did not feel blocked, but it is the dominant cost of every iteration (build 15 s vs render 0.1 s).

Inferred, not measured:
- Whether the 15 s link time grows as scenes get larger or with the papercut kit (many more `svgr!` trees). Untested.
- Whether the strip trick scales to full 3D camera moves with roll/pitch (it does not for corner-pin quads).
- Whether fframes handles the papercut grain (multiply blend) and torn edges (turbulence + displacement). Not tried.
- The real-time preview window and the other CLI commands (`onion`, `snapshot`) were not used.

Evidence for the build-vs-own decision: the visual walls (no perspective, no 3D camera, no blend modes tested) are the ones HANDOFF point 4 says need a native compositor; the authoring-loop numbers show Rust authoring is slower per edit than hot-reloaded TS but not the dominant risk.
