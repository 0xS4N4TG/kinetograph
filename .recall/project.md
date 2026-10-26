# kinetograph

## Stack
- Language: Rust (core renderer: crates/core, CLI: crates/cli, N-API addon: crates/node) and TypeScript (npm workspaces under packages/: scene, react, core, audio, cli; contract in packages/cli/skills/kinetograph/references/AUTHORING.md)
- Render backend: Skia (Graphite on Metal/Vulkan/D3D12, CPU fallback) is the only renderer (Vello is gone); `KINETOGRAPH_SKIA_CPU=1` forces the CPU. `render`, `still` and `doctor` print which one runs. DOM islands via vendored blitz-dom/stylo/taffy.
- npm: CLI `kinetograph`, libraries `@kinetographdev/*` (0.1.0 published 2026-10-24). Site kinetograph.dev on Vercel (packages/site, auto-deploy from main).
- Repo: github.com/0xS4N4TG/kinetograph (public), branch main; PRs merge after native.yml CI is green on macOS/Linux/Windows + smoke
- Licence: PolyForm Small Business 1.0.0 (LICENSE.md); commercial licence for larger companies (COMMERCIAL.md)

## Entry points
- `cargo build --release`; `./target/release/kinetograph still <scene.json> <frame> -o out.png`; `bench <scene.json> --frame N --runs K`.
- `npm ci && npm run build && npm test`; `npx kinetograph still|render|inspect|lint <project.tsx|scene.json>`.
- Scenes are JSON (packages/cli/skills/kinetograph/references/SCENE.md). Tests: `cargo test` (goldens in crates/core/tests/golden, regenerate with UPDATE_GOLDEN=1 after an eye check).

## Conventions
- One Conventional Commit per logical change; push only when asked.
- Branches `feat/<work>`, phase in the PR title, merge commits, no session links in commits/PRs (HANDOFF §8). PR bodies do NOT end with "🤖 Generated with Claude Code" (user, 2026-10-25); commits keep "Co-Authored-By: Claude Opus 5.5".
- Coding happens in Claude Code cloud sessions; the M4 does rendering, goldens, benchmarks and ideation.
- docs/reference/ (third-party reference video and stills) was deleted 2026-10-25; do not bring it back.
- Subagents: Sonnet 5.5 medium implements, Haiku 5.5 helpers run renders/benchmarks/test material; ask before using Opus. Give each agent one scoped task, its own worktree, a shared CARGO_TARGET_DIR (disk is tight) and NAPI_RS_NATIVE_LIBRARY_PATH to test its addon without touching crates/node/*.node.
- Determinism checks: lossless render (--encoder libx264 --crf 0 --pixel-format yuv444p) + ffmpeg framemd5.
- Memory: .recall/ (this) is the primary memory base since 2026-10-25.
- Speed claims need a benchmark; rendering is a pure function of (project, frame).

## Machine
- Apple M4, 10 CPU, 24 GiB, macOS 26.5.2. Node v26.7.0. Remotion 4.0.530 in the papercut project.
- Rust: use rustup (Homebrew `rustup` formula, stable 1.99.0). ~/.zshrc puts ~/.cargo/bin and /opt/homebrew/opt/rustup/bin ahead of /opt/homebrew/bin. Homebrew `rust` 1.97.1 is still installed but broken (llvm wants libz3.4.15, z3 is 5.1.0); never use /opt/homebrew/bin/rustc.

## External corpora
- Papercut Remotion kit: $KINETOGRAPH_CORPUS/lib/papercut/
- Ep 13 papercut: .../tiny-agent/episodes/13-mods/papercut/src/ (composition ModsPapercut, S04Meter = frames 317–405, 1080x1920@30)
- SFX corpus: $KINETOGRAPH_CORPUS/lib/audio/sfx/
