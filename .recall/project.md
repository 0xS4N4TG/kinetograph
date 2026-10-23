# kinetograph

## Stack
- Language: Rust (core renderer: crates/core, CLI: crates/cli, N-API addon: crates/node) and TypeScript (npm workspaces under packages/: scene, react, core, audio, cli; contract in packages/cli/skills/kinetograph/references/AUTHORING.md)
- Planned crates: wgpu, vello, parley/swash/fontique, taffy, usvg/vello_svg, ffmpeg-next, web-audio-api-rs, rmcp (see docs/HANDOFF.md §4)
- Repo: github.com/0xS4N4TG/kinetograph (private, to be public), branch main
- Licence: PolyForm Small Business 1.0.0 (LICENSE.md); commercial licence for larger companies (COMMERCIAL.md)

## Entry points
- `cargo build --release`; `./target/release/kinetograph still <scene.json> <frame> -o out.png`; `bench <scene.json> --frame N --runs K`.
- `npm ci && npm run build && npm test`; `npx kinetograph still|render|inspect|lint <project.tsx|scene.json>`.
- Scenes are JSON (packages/cli/skills/kinetograph/references/SCENE.md). Tests: `cargo test` (goldens in crates/core/tests/golden, regenerate with UPDATE_GOLDEN=1 after an eye check).

## Conventions
- One Conventional Commit per logical change; push only when asked.
- Branches `feat/<work>`, phase in the PR title, merge commits, no session links in commits/PRs (HANDOFF §8).
- Coding happens in Claude Code cloud sessions; the M4 does rendering, goldens, benchmarks and ideation.
- docs/reference/rajz-reference.mp4 is third-party and gitignored (local only).
- Subagents: Sonnet 5.5 at high effort (global env CLAUDE_CODE_SUBAGENT_MODEL + project .claude/settings.json). Ask before using Opus. Don't stop/relaunch running agents without asking.
- Speed claims need a benchmark; rendering is a pure function of (project, frame).

## Machine
- Apple M4, 10 CPU, 24 GiB, macOS 26.5.2. Node v26.7.0. Remotion 4.0.530 in the papercut project.
- Rust: use rustup (Homebrew `rustup` formula, stable 1.99.0). ~/.zshrc puts ~/.cargo/bin and /opt/homebrew/opt/rustup/bin ahead of /opt/homebrew/bin. Homebrew `rust` 1.97.1 is still installed but broken (llvm wants libz3.4.15, z3 is 5.1.0); never use /opt/homebrew/bin/rustc.

## External corpora
- Papercut Remotion kit: $KINETOGRAPH_CORPUS/lib/papercut/
- Ep 13 papercut: .../tiny-agent/episodes/13-mods/papercut/src/ (composition ModsPapercut, S04Meter = frames 317–405, 1080x1920@30)
- SFX corpus: $KINETOGRAPH_CORPUS/lib/audio/sfx/
