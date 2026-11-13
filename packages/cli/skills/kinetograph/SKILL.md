---
name: kinetograph
description: Entry point for making videos and motion graphics with Kinetograph, a video engine with no browser in it. Use first when asked to build, edit, preview or render a video, animation, title card or sound design with Kinetograph, or to run any `kinetograph` command; it says which kinetograph-* skill to load next.
metadata:
  version: "0.4.0-rc.1"
---

# Kinetograph

Kinetograph renders video without a browser. You write TypeScript with the Remotion API and a few native elements (or an
HTML page with GSAP, and HyperFrames projects render as they are); Node runs it; a GPU compositor draws it. You cannot
watch a video, so you look at single frames and read the scene graph.

Run everything as `npx kinetograph <command>`. Add `--json` to get one JSON object you can parse; a failure is
`{ "error": { "code", "message" } }` with exit code 1. Over MCP (`kinetograph mcp`) there is one tool per command except
`studio`, named like the command (`audio analyze` is `audio_analyze`), with the same arguments; `still`, `strip` and `onion`
return the image itself.

## Which skill

Load the one that fits the step, and read its SKILL.md before you act. They are installed together.

| When | Skill |
|---|---|
| Start a project or a composition, add a component, template or taste | `kinetograph-create` |
| Write or change a composition: layout, text, media, effects, sound, fonts, timing, plugins, what the engine draws | `kinetograph-markup` |
| Look at frames, check, export (`still`, `strip`, `onion`, `inspect`, `lint`, `render`, `doctor`) | `kinetograph-render` |
| The person wants to preview, mark up, tune props or answer a panel in Studio | `kinetograph-studio` |
| Look something up in the Kinetograph docs | `kinetograph-docs` |
| Update `kinetograph`, its packages and these skills | `kinetograph-upgrade` |
| Move an existing Remotion project onto Kinetograph | `kinetograph-migrate` |

## The loop

1. **Create** the project once (`kinetograph-create`).
2. **Write** the composition (`kinetograph-markup`).
3. **Look and check**: `strip` first, then `lint` and `inspect` (`kinetograph-render`). Fix and repeat; a still takes well
   under a second.
4. **Render** to a file (`kinetograph-render`).

Rendering is a pure function of the frame number: nothing reads the clock, and `random(seed)` is Remotion's.

## Out-of-date notices

If a Kinetograph command prints that the CLI or the skills are out of date (a line on stderr, a `notices` field in
`--json`, or an extra text part on the first MCP tool result), tell the user and ask whether to update. Don't update
without a yes; then use `kinetograph-upgrade`.
