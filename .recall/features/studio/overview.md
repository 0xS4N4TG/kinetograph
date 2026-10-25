# studio

**Status:** active
**Paths:** `packages/studio/**`, `packages/cli/src/commands/studio*`
**Last touched:** 2026-10-25

## What this is
`kinetograph studio`: the local web UI (preview, timeline, scene tree, props, renders) that the addon renders frames for. Goal set 2026-10-25: an agentic editor a Canva-video user can drive (point at something, ask their own coding agent to change it) without losing pro control.

## Current state
- MERGED to main as PR #11 (df04aa4e, 2026-10-25): readable names, ACP agent chat (Claude Code tested; Codex/Gemini presets untested), Canva-simple timeline, token + Origin + loopback security. README has "The editor" section with docs/readme/studio.webp.
- Studio still served on :3300 from worktree .claude/worktrees/agent-a97b644e766f89f43 (token in scratchpad/studio-3300.log).

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
