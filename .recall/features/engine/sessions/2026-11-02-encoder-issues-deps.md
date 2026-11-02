# 2026-11-02 — encoder defaults, engine issues #91-#93, Rust deps, Remotion 4.0.539 (HANDOFF)

Session 5148e0af. Main at b3e19942 (untouched by this work). Everything below is on local branches in scratchpad
worktrees under /private/tmp/claude-501/-Users-sanatgupta-Documents-Code-RustProjects-kinetograph/5148e0af-5c77-4567-bffa-ed032d28ec61/scratchpad/
(wt-*). Nothing pushed unless noted.

## Issues found and what fixed them

### 1. Encoder: a friend's 1080p slide video looked jagged / jarring (Kinetograph 0.2.5 from npm)
- His command: `kinetograph render src/java-memory.tsx --strict --video-bitrate 8M` → h264_videotoolbox, got 2.06 Mbit/s (VT treats the rate as a loose average), and an I-frame every 12 frames: we never set gop_size, so FFmpeg's AVCodecContext default 12 applied. Frame-diff scan showed small jumps at frames 24, 36, 48... on static slides (edge shimmer).
- Engine is fine: our still of frame 900 vs his MP4 frame, luma PSNR 50.5 dB; VT 8M vs x264 CRF 18 on the same 300 frames: luma 50.5 vs 51.1 dB, x264 5.33 ms/frame vs VT 8.06, 0.55 MB vs 2.47 MB. RGB PSNR ~39 for every encoder = yuv420p chroma (Remotion/HF same). Jaggedness not reproduced in still frames; his code also pops elements in (no transitions) and draws elbow connectors as separate Paths meeting at corners (notches; fix with one path + round cap/join).
- Advice sent: `--encoder libx264 --crf 18`, fade things in, one Path per connector with cap/join round.
- Project copy: scratchpad/friend-src (his src only; node_modules symlinked to OUR repo). MISTAKE made: first ran his downloaded node_modules (esbuild) -> macOS Gatekeeper prompt; user told to Cancel; deleted. Rule: never run binaries from a downloaded folder.
- Remotion: default libx264 CRF 18, hardwareAcceleration 'disable', no -g unless gopSize (x264 keyint 250). HyperFrames: libx264 default, --gpu opt-in, VT bitrate from pixel rate (0.08/0.16/0.24 bpp; their comment: VT rejects FFmpeg qscale). Sources: remotion packages/renderer/src/crf.ts + ffmpeg-args.ts; HF packages/engine/src/utils/gpuEncoder.ts.
- Branch fix/encoder-defaults (wt-encoder): e53e7ab2 libx264 CRF 18 default everywhere (VT fallback on mac if no libx264, then openh264/mf/nvenc/amf), H.265 libx265 default, ProRes VT unchanged; 60d25fc9 x264/x265/vp9 keep their own keyint (user chose "their way"), explicit gop=round(fps*2) only for VT, openh264, mf, nvenc, amf, vaapi, qsv; 39281398 PATH ffmpeg lookup (KINETOGRAPH_FFMPEG, bundled bin/ffmpeg, then PATH ffmpeg for libx264 → source builds with Homebrew ffmpeg get x264). Tests: cargo encode/external 42 pass; render-export 19 pass.
- COST FOUND: x264 medium is 1.6-2x slower than VT on heavy content: showcase 24-27 s → 42-44 s (33 → 54 MB); launch 65-87 s → 124-147 s (54 → 260 MB, grain). My recommendation to user: keep VT as mac default (with 2 s keyframes) + x264 opt-in, OR x264 veryfast. User asked for a proper benchmark incl. Remotion.
- RUNNING: agent adding `--x264-preset` (Remotion's name) + matrix VT / x264 medium/fast/veryfast/superfast on showcase + launch (wall, encoder ms/frame, MB, luma PSNR/SSIM vs crf0 reference) + Remotion 4.0.539 vs Kinetograph on examples/compat (scratchpad/remotion-bench, local npm install), outputs scratchpad/encoder-bench/. DECISION PENDING on default after numbers.
- Site bento numbers were measured with VT; re-measure if default changes.

### 2. Engine issues from the effects session (verified, filed 2026-11-02)
- #91 MeshGradient under blur fades at frame edges (wgpu path cuts at canvas before blur; Rect/Skia fine). Minimal repro scratchpad/engine-issues/2-mesh-min (left edge 182,167,191 blurred vs 44,86,194 sharp).
- #92 Stroke TS type lacks cap/join/miterLimit/dashArray/dashOffset (packages/scene/src/types.ts:493 vs scene.rs:1162).
- #93 No scaleX/scaleY (elements.ts CommonProps; scene.rs:271 Transform only `scale`; passing scaleX renders unscaled silently).
- RUNNING: agent on fix/issues-91-93 (wt-issues-91), one commit per issue with Fixes #N, tests, goldens only where intended.
- Not filed (by design, error messages explain): preserve3d group can't carry effects (scene.rs:2601; DOM path flattens); clip inset on layoutless group (scene.rs:2554).
- Muted video muxed silent AAC: FIXED on fix/muted-video-audio 68d0338f (hasAudibleClip in packages/audio/src/clips.ts; render-job.ts:188). Not pushed. Effects session keeps its `ffmpeg -an` workaround until merged.

### 3. Remotion 4.0.539 parity (branch fix/remotion-4.0.539, wt-remotion-539, 8 commits, not pushed)
- Fixed: spring() falling-spring clamp; interpolateColors grad units + hue wrap (+ oklch/lch/lab/oklab/hwb with unit/alpha fallback); interpolate() wrap over multi-keyframe; translatePath leading `m` (+ quad with control at start); audioBufferToDataUrl 3+ channels. Pinned: interpolateStyles 3D, visualizeAudio. N/A: prefetch cleanup, animated-image cache, useAudioData/getAudioData leaks, transitions OffthreadVideo capture. Fixtures re-recorded from 4.0.539.
- Gaps: VERSION still '4.0.535'; new names not implemented: parseVtt (captions), preservePitch (media), 6 timeline-utils cache fns.
- MISSED PACKAGE: @remotion/effects (since 4.0.455, May 2026) is NOT mapped (REMOTION_PACKAGES in packages/cli/src/bundle.ts) → imports fail. ~95 effects (80 WebGL2, 12 canvas, 3 WebGPU). First slice ~15 effects + curves + shatter = 2-3 days; all = 2-3 weeks. Cause: compat list fixed at 24 packages; add a per-release check of Remotion's package list. User asked "how did we miss this"; before/after 0.3.0 still undecided.

### 4. Rust dependencies
- `cargo update --dry-run`: 63 semver-compatible (napi 3.14→3.16, napi-derive 3.6→3.7, napi-derive-backend 6→7, tokio 1.54, openssl 0.10.82, taffy 0.15.1, lyon, zip 2.6.1, pulldown-cmark 0.13.5). Held back (need Cargo.toml): skia-safe 0.153→0.156 (goldens), resvg/usvg 0.49, read-fonts 0.46 / skrifa 0.49, blitz-*/stylo_taffy beta.4 (vendored patches → a port), pollster 1.0.
- cargo-audit installed globally via Homebrew (user OK'd global). 4 advisories: RUSTSEC-2026-0414 pulldown-cmark (build-dep of `just` via dotlottie-rs build; fixed by update); RUSTSEC-2026-0367/0368/0369 zip <9 via dotlottie-rs v0.1.58, all in extract(); our runtime uses ZipArchive::by_name in memory (dotlottie-rs src/fms/mod.rs), extract only in its build.rs → not exploitable by a render; needs dotlottie-rs to move to zip 9 (check v0.1.60).
- RUNNING (waits for cargo + render benchmark to be idle): chore/deps-compatible (wt-deps): cargo update + pollster 1.0 + maybe dotlottie v0.1.60, full crate tests + goldens + audit. Next: Skia/resvg branch; Blitz/Stylo/fonts later.

## Site branch feat/site-new-templates (wt-site-templates; dev server :3110 restarted from it)
Merged in: 38 new components (grouped), templates→components rename + /templates redirects, Terminology (22 pages, Remotion/HyperFrames tabs), docs cut (~30k → ~19.5k words) + restructure (compat+known-issues → "What works"; scene-format under Reference; FFmpeg licence into Installation; Plugins section with per-plugin pages + library-adapters + writing-a-plugin), dark theme (docs/plugins/components; home stays light), Hairline engine figure (MIT notice in THIRD-PARTY-NOTICES), Contributing page + approved clause, llms.mdx served as <slug>.md, footer Docs links → docs site (9428567f), AGENTS.md + README/Installation/llms.txt install paths with agent prompt (2d04d24a), headline "blazingly fast programmatic video engine." + speed bento (04263dc7). Not pushed; user hasn't said push.
Open on it: Captions/Fragments on plugin pages; film-intro/grid-reel/change-reel/text-flow; 3 maps held (capture.mjs drives Chrome via puppeteer → against no-browser rule; options: leave off / label pre-captured / native tiles).

## Waiting on the user
- Encoder default after benchmark; push/PR for fix/encoder-defaults, fix/muted-video-audio, fix/remotion-4.0.539, chore/deps-compatible, fix/issues-91-93, site branch; merge #88 #89 #90 (stacked: retarget before deleting bases).
- @remotion/effects before/after 0.3.0; library adapters as manifest plugins; persistent + sandboxed panels; Rust file split; multi-agent Studio; release 0.3.0 (close #80).
- Cleanup: worktrees (~20 under scratchpad), stash@{0}, test Studio :4650, examples/launch/kinetograph.lock.json untracked.
