# studio

**Status:** active
**Paths:** `packages/studio/**`, `packages/cli/src/commands/studio*`
**Last touched:** 2026-10-30

## What this is
`kinetograph studio`: the local web UI (preview, timeline, scene tree, props, renders) that the addon renders frames for. Goal set 2026-10-25: an agentic editor a Canva-video user can drive (point at something, ask their own coding agent to change it) without losing pro control.

## Current state
- Redesign on feat/studio-redesign (53 commits over main, contains feat/plugin-ui + docs/migrate-hyperframes; tip 078b20fc, local, unpushed; checked out at ../kinetograph-redesign). Ships as 0.3.0.
- Editor: floating panel shell (resizable/collapsible), top bar, Cmd+K command menu (every menu action, agent switch/restart), shortcuts dialog, large preview with floating transport + view menu, timeline with type-coded clips, mm:ss.ff ruler/timecode, film strip for video and waveforms for audio, virtualised layer rows, trim bar, range selection (agent gets the span, its context and a contact sheet), export dialog (whole/custom range), audio playback with the audio clock leading (/api/audio, /api/waveform).
- Props tab: schema forms (propsSchema, zod 4), presets (/api/presets), plugin cards (title/icon/description/components, selectable with their layers), per-panel preview overlay, edited props + panel state survive a reload. Agent chat is markdown (Streamdown, tight CSP); the agent gets studio_get_props/studio_set_props via `kinetograph mcp --studio`. Plugin contract: scratchpad/plugin-ui/CONTRACT.md (v1 + addenda 2-4).
- Docs done 2026-10-30 on the branch: CHANGELOG (dcb0921a), README (95483a00), site guides/studio.mdx + cli/plugins/first-video/agents/skill/llms (078b20fc). docs/readme/studio.webp is still the OLD screenshot: re-capture on power.
- Test Studio on :4621 (redesign build; token in scratchpad/plugin-ui/url.txt); plugin demo project scratchpad/plugin-ui/proj.

## Open threads
- [ ] Re-capture docs/readme/studio.webp with the new editor (showcase project), then push the stack as PRs: feat/plugin-ui, fix/canvas-source-reuse, feat/studio-redesign
- [ ] Two nits: one time format everywhere; stray "- / 30 fps" in the header
- [ ] Undo, direct manipulation on the preview; tracking UI; Codex/Gemini presets untested; chat lost on reload
- [ ] Same-name siblings not numbered; root-level layers' Sequence ownership is heuristic

## Key files
- `packages/studio/src/server.ts` (token/origin, agent.* messages), `packages/studio/src/agent-fs.ts` (scoping)
- `packages/studio/ui/src/lib/names.ts`, `lib/selection.ts`, timeline components
- `packages/react/src/origin.ts`, `packages/cli/src/bundle.ts` (jsxDev shim)

## Recent sessions
- 2026-10-30-redesign-docs — docs for the redesigned editor (changelog, README, site guide, recall); plugin cards + reload state finished
- 2026-10-25-pipeline-expansion — names + ACP chat + Canva-simple timeline built on branches; user reviewing on :3300
