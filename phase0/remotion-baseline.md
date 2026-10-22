# Remotion baseline: papercut episode 13, scene S04Meter

Measured 2026-10-14. This is the speed a new engine has to beat by 5x (HANDOFF.md §8, Phase 0 step 3).

## Machine

| Item | Value |
|---|---|
| CPU | Apple M4 (`machdep.cpu.brand_string`) |
| Logical CPUs | 10 (`hw.ncpu`) |
| RAM | 25,769,803,776 bytes (24 GiB) |
| macOS | 26.5.2 (Darwin 25.5.0) |
| Node | v26.7.0 |
| Remotion | 4.0.530 (`@remotion/cli`, bundler, renderer; rspack enabled in `remotion.config.ts`) |
| Background load | Not an idle machine: Chrome, the Claude CLI and other apps were open. Load average was 1.9 to 2.1 before the runs and 5.3 right after them. |

## What was rendered

- Project: `$KINETOGRAPH_CORPUS/tiny-agent/episodes/13-mods/papercut/` (composition id `ModsPapercut`, from `episode.json`).
- Scene S04 is `S04Meter` ("A BAND DRAWN ABOVE THE PROMPT"). The episode is one composition; scenes are not separate compositions. `src/plan.json` puts S04Meter at **frame 317, 89 frames long**. The render therefore uses `--frames=317-405`.
- The frame range renders the whole composition for those frames, not just the scene component: the scene, the taped banner, word-tag captions, the grain overlay and the hook/cut layers, all through `CutSeries`.
- Composition: 1080x1920 (vertical), 30 fps. Episode total 988 frames (32.93 s).
- Scene length: 89 frames = **2.967 s**.
- Audio was not rendered (`--muted`), as in the pipeline's per-segment renders.

## Settings (copied from the pipeline)

`lib/tools/render.sh` is a wrapper around `lib/tools/render.py`. That script writes into `out/cache/` inside the repo and renders every scene in grouped parallel jobs, so I did not run it. I called `npx remotion bundle` and `npx remotion render` directly with the same flags `render.py` uses for its per-segment renders (`FPS_FLAGS` plus `--concurrency=4`, the script's default `--conc`):

```
--codec=prores --prores-profile=hq --image-format=jpeg --jpeg-quality=95 --gl=angle --muted --timeout=120000 --concurrency=4
```

`remotion.config.ts` also sets rspack, JPEG frame format and overwrite. The real pipeline then joins the ProRes segments and encodes H.264 once (x264 `-preset slow -crf 16`, 1080x1920, yuv420p, BT.709, with loudnorm audio). I timed that encode for this segment separately.

To keep the repo untouched, I APFS-cloned the project (`cp -cR`, everything except `out/`, including `node_modules`) into `/private/tmp/claude-501/.../scratchpad/remotion-bench/proj/` and ran everything there. No file in `the corpus repo` was modified. All logs, bundles and outputs are in `/private/tmp/claude-501/-Users-me-Documents-Code-RustProjects-kinetograph/bfa7f096-8a5c-40d0-90e4-5577939d6352/scratchpad/remotion-bench/`. `node_modules` was already installed, so no install was run.

## Commands

Run script: `remotion-bench/run.sh <label>`. In effect:

```
cd proj
npx remotion bundle --out-dir $B/bundle-<label>
npx remotion render $B/bundle-<label> ModsPapercut $B/<label>-S04.mov --frames=317-405 \
  --codec=prores --prores-profile=hq --image-format=jpeg --jpeg-quality=95 --gl=angle --muted --timeout=120000 --concurrency=4
```

Each phase was timed with `date`-style wall clocks (Python `time.time()`) around the command, and also with `/usr/bin/time -l`.

## Results: S04Meter, 89 frames (2.967 s of video)

| Run | Bundle (s) | Render (s) | Total wall (s) | Render ms/frame (89 frames) | Output |
|---|---|---|---|---|---|
| 1, cold (first run in the clone, no rspack cache) | 4.71 | 26.50 | 31.21 | 298 | ProRes HQ .mov, 67.8 MB |
| 2, warm | 2.43 | 16.28 | 18.71 | 183 | 67.7 MB |
| 3, warm (repeat) | 2.11 | 16.39 | 18.51 | 184 | 67.8 MB |

Splitting out fixed cost from per-frame cost, warm:

| Quantity | Value |
|---|---|
| Render of a single frame (`--frames=360-360`, x3) | 2.26 s each (Chrome launch, bundle serve, composition load; this is the fixed overhead of every `remotion render`) |
| Marginal cost per frame (warm, (16.3 s - 2.3 s) / 89) | about 157 ms/frame |
| Bundle only, warm | 2.1 to 2.4 s |
| x264 final encode of this segment (video only, `-preset slow -crf 16`, from the ProRes) | 3.58 s; output 2.06 MB |
| Direct `--codec=h264` render of the same range, concurrency 4 | 15.1 s (1.76 MB); the codec is not what dominates |

`/usr/bin/time -l` for the warm render: about 32 s user and 1.7 s sys CPU in 16.3 s real (roughly 2 cores busy on average), max RSS 278 MB for the CLI process.

### Still latency (for agent fix loops)

Frame 360 (mid-scene), PNG, 1080x1920, `--gl=angle`, 3 runs each:

| Case | Wall time |
|---|---|
| `npx remotion still <existing bundle> ModsPapercut out.png --frame=360` | 1.98 to 2.01 s |
| `npx remotion still src/index.ts ...` (bundle + still, warm rspack cache) | 2.81 to 2.87 s |

PNG size about 1.5 MB. So the Remotion floor for "show me one frame" is about 2 s with a bundle, about 2.8 s from source.

### Concurrency sweep (warm, same range, ProRes)

| `--concurrency` | Render wall (s) |
|---|---|
| 1 | 16.4 |
| 2 | 16.0 |
| 4 (pipeline setting) | 16.3 |
| 5 | 16.3 |
| 10 | 17.6 |

## Odd things

1. **Concurrency does nothing for this scene.** One tab and ten tabs take the same 16 s. Something serial is the bottleneck (the Remotion CLI main process, the ProRes or JPEG handling, or the `--gl=angle` GPU path). I did not find out which. It means the 157 ms/frame figure is not CPU-parallelism-limited here, and that 5x faster needs about 31 ms/frame marginal or better.
2. **The cold run is 10 s slower than the warm ones**, and 5 of those seconds are the render, not the bundle. Likely cold file cache and first Chrome headless shell start in the fresh clone. I could not reproduce a colder state without `sudo purge`. The warm numbers are the steady-state ones.
3. **Rendering is not byte-deterministic.** The same still at frame 360 alternates between two PNG files (1,507,638 and 1,507,908 bytes); the pixel difference is at most 3 per channel, confined to one region (a box about 965x145 px). Probably GPU or compositing noise, not the kit's grain (which is seeded). Not investigated further.
4. **Comparison with the real pipeline log** (`out/render.log` in episode 13, full 988-frame cold-cache run, 3 parallel `remotion render` jobs of 4 tabs each): bundle 2 s, 988 frames in 211 s of video wall time (about 214 ms/frame across the whole episode with 3 jobs in parallel), final x264 encode of the full episode 44 s, total 257 s. Those jobs ran on a machine with other loads and render several scenes at once, so per-frame wall time is not directly comparable to the isolated single-scene run above, but it is the same order of magnitude (about 160 to 300 ms/frame).
5. The first warm and cold bundle runs print a Node deprecation warning (`module.register()`); harmless.

## Summary numbers to beat

| Metric | Remotion today | 5x target |
|---|---|---|
| S04Meter, 89 frames, warm, whole run incl. bundle | 18.5 to 18.7 s | about 3.7 s |
| S04Meter render only (warm, ProRes) | 16.3 s (183 ms/frame; 157 ms/frame marginal) | about 3.3 s (37 ms/frame) |
| S04Meter, cold first run | 31.2 s | |
| Single still, mid-scene | 2.0 s (bundle ready), 2.8 s (from source) | about 0.4 to 0.6 s |
| Full episode (988 frames, existing pipeline, 3 parallel jobs) | 257 s | about 51 s |
