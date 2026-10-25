# studio

**Status:** active
**Paths:** `packages/studio/**`, `packages/cli/src/commands/studio*`
**Last touched:** 2026-10-25

## What this is
`kinetograph studio`: the local web UI (preview, timeline, scene tree, props, renders) that the addon renders frames for. Goal set 2026-10-25: an agentic editor a Canva-video user can drive (point at something, ask their own coding agent to change it) without losing pro control.

## Current state
- main has PR #6: "Copy for agent" message + timeline loading progress.
- Branch feat/studio-agentic (worktree scratchpad/wt-agentic, 21b227d2) = feat/studio-names + feat/studio-chat, not pushed:
  - names: every layer/Sequence gets label, component, source {file,line,column} via esbuild jsxDev shim (bundle.ts) + fiber _debugOwner (packages/react/src/origin.ts); studio-only, renders byte-identical. Contract: scratchpad/studio-agentic/CONTRACT.md.
  - chat: Agent tab over ACP (@agentclientprotocol/sdk 2.0.2; Claude via npx @agentclientprotocol/claude-agent-acp, Codex via @zed-industries/codex-acp, Gemini `gemini --acp`); click/marquee/shift selection with outlines; context = agent-message + PNG crop; never auto-approves; fs scoped with lstat + O_NOFOLLOW; per-launch 32-byte token in URL (?token=), Origin check, agent off on non-loopback unless --allow-remote-agent.
- Branch feat/studio-timeline (8df8be8a, on top of studio-agentic): Sequences-only top level, component instances folded "Name ×N", generic shapes/groups hidden, one bar per row (gap > fps frames splits), click seeks + selects, "Show details" toggle (localStorage), scene tree folds repeats. Showcase: 19 top rows. Launch: 18 collapsed. Tests: studio 85, ui 130.
- User is reviewing it live: studio running detached on port 3300 from the timeline worktree (.claude/worktrees/agent-a97b644e766f89f43); link token printed in scratchpad/studio-3300.log.

## Open threads
- [ ] User feedback on the timeline redesign, then merge studio-agentic + timeline into main (PR)
- [ ] Clip thumbnails (skipped: GPU contention with playback)
- [ ] Chat lost on tab reload (lives in tab; reload kills agent); Codex/Gemini presets untested; no terminal capability
- [ ] Same-name siblings not numbered; root-level layers' Sequence ownership is heuristic

## Key files
- `packages/studio/src/server.ts` (token/origin, agent.* messages), `packages/studio/src/agent-fs.ts` (scoping)
- `packages/studio/ui/src/lib/names.ts`, `lib/selection.ts`, timeline components
- `packages/react/src/origin.ts`, `packages/cli/src/bundle.ts` (jsxDev shim)

## Recent sessions
- 2026-10-25-pipeline-expansion — names + ACP chat + Canva-simple timeline built on branches; user reviewing on :3300
