# fframes Phase 0 log

Agent: Claude (Sonnet 5.5), acting as test subject and recorder. Machine: Apple M4, 24 GiB, macOS 26.5.2.

## 2026-10-14 08:19:08 Setup
- Started. System rustc is broken out of the box: `rustc --version` dies with "Library not loaded: libz3.4.15.dylib" (Homebrew llvm 22.1.5 linked against an older z3; z3 is now 5.1.0). Not fframes' fault, but a first-minute wall. Workaround: symlink libz3.5.1.dylib as libz3.4.15.dylib in a scratch dir and export DYLD_FALLBACK_LIBRARY_PATH to it. rustc 1.97.1 / cargo 1.97.1 then work.
- 08:19:59 `npx skills add https://fframes.studio` (cwd phase0/fframes): 1.9 s, no friction. It installed .agents/skills/fframes-video (SKILL.md 16.6 KB + api/audio/design refs) and symlinks/dirs for Claude Code, .hermes, .kiro, .zcode (clutter in the work dir).
- `cargo install --locked cargo-fframes`: 22 s. Not on PATH by default (needed ~/.cargo/bin).
- Skill's brew line lists nasm/ninja; not installed here (nasm, ninja absent). Proceeding without to see if prebuilt ffmpeg/skia path works as the skill claims.
- `cargo fframes new reference --format landscape --fps 25 --yes` and `papercut --format portrait --fps 30 --yes`: instant.
- 08:20-08:27 First `cargo build --release` of `reference` (template + my first lib.rs, deps cold, prebuilt Skia/ffmpeg downloaded): **7 min 23 s** wall (user 678 s). nasm/ninja not needed. Shared CARGO_TARGET_DIR in scratchpad so the papercut project reuses compiled deps.
- Reference analysis during that build: ffmpeg frame dumps (5 fps over 20-26 s, 0.2 s sheets), 10 stand-in card photos cropped from video frames into reference/media/. Note: media/ files are compiled into the binary (include_media_dir! proc macro), so each photo change recompiles the crate.

### Iteration log (reference) -- type: C = Rust compile error, A = fframes API misuse, V = visual issue
| # | change | build | render | type |
| 1 | first full draft (card rail by vertical-strip fake perspective, words, whip, text) | fail after 7m23s cold | - | C: E0597 `shown` does not live long enough: `frame.text_width(ctx, font, &shown)` requires the text to be borrowed for the scene lifetime 'a (ctx caches it). Fix: pass a `&'static str` slice |
| 2 | fix lifetime (&'static str slice) -> builds; first build/render ever: `timeline`, `inspect`, `strip` all OK; first strip already shows the rail, words and whip | 16.8 s (link) | strip 1.0 s wall | - (first successful render of a frame set at ~08:40, ~20 min after start, 7 of them the cold build) |
| 3 | pop entering cards (no ghost alpha), hide "you/create" until 23.3 s, 16 strips per big card, rewrote whip (blur + feComponentTransfer gradient map + feComposite mix), full-frame rising gradient, tail text | 14.5 s | strip ~1 s | V (ghosting, words visible too early, gradient only bottom third, stair-steps in strips) |
- 08:31 (before scope change arrived) ran full 125-frame renders of the reference as a speed probe: 3.5-3.9 s wall (Skia Metal, libx264, 1920x1080), ~28-31 ms/frame, RSS 1.3 GB; `frame` still 0.09-0.24 s wall. Recorded for completeness; no further video renders per the new scope (single still only; papercut target dropped).
| 4 | wider card overlap (seams between strips: clip overlap 0.004 -> 0.03), rail spacing/scale decay tuned, gradient hidden before whip, typing speed | 13.6 s | strip ~1 s | V (hairline seams between strips; gradient visible at t=0; rail collapsed too much) |
| 5 | rail params tuned again, 8-frame side-by-side vs reference | 14.4 s | frames 0.1-0.2 s | V (card sizes/positions roughly right) |

**Scope change received here:** one still only. Papercut target (S04Meter), full-length renders, whip refinement and render-speed benchmarks dropped. Target now: the 3D card-stack moment ~22.0 s = clip t 1.0 s.

| 6 | frame at 22.0 s: entering card now comes in from lower right (y offset), slower spacing/scale decay (r 0.95, s 0.93) so cards overlap like the reference | 16.5 s | `frame 1.0s` 0.09 s | V (reference front card is a *different, newer* photo than mine at this instant: timing of the card sequence off) |
| 7 | shift appearance times of cards 4-6 earlier by 0.25-0.35 s; 32 strips per big card to kill the staircase on trapezoid edges | 16.5 s | `frame 1.0s` 0.09 s (first run after relink 1.6 s) | V (staircase edge fixed; layout now close) |

### Totals (reference target)
- Builds: 7 (1 cold 7 m 23 s with compile error, then 6 incremental). Incremental `cargo build --release`: 16.8, 14.5, 13.6, 14.4, 16.5, 16.5 s -> median 15.5 s, max 16.8 s (this project's own crate + link only; deps cached).
- Failures: 1 Rust compile error (E0597 lifetime: text passed to `frame.text_width` must live for the scene lifetime 'a), 0 fframes-API misuse errors, 6 visual-tuning iterations.
- Single still (`reference frame 1.0s`, 1920x1080, Skia Metal): 0.09-0.11 s wall, steady state (5 runs); 0.235 s the first time; 1.6-1.8 s on the first run right after a relink (cold binary pages). `inspect 1.0s`: no problems.
- Agent CLI used: `timeline` (said "no scenes" for a scene-less video), `inspect` (caught my intentional off-canvas "you" entrance as a warning, nothing else), `strip` (most useful: one image to check the whole 5 s), `frame` (full-size check of detail). Not used: `onion`, `snapshot` (skipped by scope), `preview` (needs a window).
- Friction: system rustc was broken (Homebrew LLVM wants libz3.4.15, z3 is 5.1); worked around with a DYLD_FALLBACK_LIBRARY_PATH shim. `npx skills add` also writes .hermes/.kiro/.zcode/.claude/.agents dirs and skills-lock.json into the work dir. Template ships tests/frames.rs although the skill says write no tests (not run).
