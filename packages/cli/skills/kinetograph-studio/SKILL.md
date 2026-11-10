---
name: kinetograph-studio
description: Open Kinetograph Studio, the local editor with a live preview, timeline, props and presets, export and a chat with the coding agent, and work with the person in it. Use when the person wants to preview or tune a video, mark up frames, give you a span of time, answer a brief, storyboard or review panel, or when a message starts with "Markup notes on".
metadata:
  version: "0.3.0"
---

# Work in Studio

`npx kinetograph studio <entry>` starts the local studio (a preview that plays sound, a timeline you can drag a span on,
props and presets, plugin cards, a scene tree, an export dialog, a render queue and a chat with the person's coding agent)
at `http://127.0.0.1:3000` and opens a browser. The entry is a project file, a `.json` scene, or a HyperFrames page. It
rebuilds when a file changes and runs until stopped. It is for the person at the screen and is not an MCP tool.

Options: `--port N` (0 picks a free one), `--host`, `--no-open` (use it when you start Studio yourself), `--agent <command>`
(the coding agent for the chat; default Claude Code, Codex or Gemini CLI, whichever is installed), `--allow-remote-agent`,
`--props <json>`, `--offline`. With `--host` set so other computers can reach Studio, the agent is off unless
`--allow-remote-agent` is passed.

## What the person has

- **Preview and timeline.** Click a layer to select it. Drag across the timeline ruler or a clip to pick a span of time. Each
  message you receive carries the selection: the project file, the composition, the frame or span, and for each layer its
  name, kind, source file and line, position, size, look and plugin. For a span you get the Sequences that overlap it and a
  contact sheet of up to eight frames.
- **Props tab.** A form drawn from the composition's zod `schema`; edits re-render the preview. **Presets** save the props as
  `presets/<composition id>/<name>.json` beside the entry, and `--props` renders one from the command line.
- **Markup mode** (`M`): the person pins a spot, boxes a region, draws, or marks a range, with a comment on each.
- **Export** (top bar): a range, a `.mp4` or `.mov` path and Draft; it joins the Renders queue.

## Tools

Over MCP, with the studio open (`kinetograph mcp --studio <address>`, the token in `KINETOGRAPH_STUDIO_TOKEN`; Studio's own
chat agent has them already):

- `studio_get_props` reads the props the preview shows; `studio_set_props` changes them, and the person watches the preview
  change. Try values this way, then write the ones you choose into the code or a preset.
- `studio_open_panel` and `studio_panel_result` ask the person for a decision in a panel (below).

The chat agent also gets every `kinetograph` command and the tools of the project's plugins (`<plugin>_<tool>`).

## Markup notes

A message that starts `Markup notes on <comp>` is the person's notes drawn on the preview: a numbered list in time order
(frame, time, the mark in composition pixels, the layers under it, their comment), with each distinct frame attached as a
picture that has the marks drawn on it (`public/refs/markup-<stamp>-<n>.png`, the path is in the message). Fix the notes in
order, and end with a numbered list saying which you did and which you skipped and why. Frames over the cap come without a
picture: use the frame number and the coordinates. Images the person attaches are stored in `public/refs/` too; use one
with `staticFile('refs/name.png')`.

## Panels for a new video

Settle the decisions in order before you animate, using `studio_open_panel`: a **brief** first (pre-fill what you know
from the chat), then the script or track, then a **storyboard**, then the look (`styleframes`). Build an animatic and ask
for a **review** before animating; animate the hook and the reveal first and ask for a review again. Skip stages that
don't fit the job (a caption fix needs no brief). Never animate against an unapproved storyboard without saying so.

- `studio_open_panel({ panel, data, message?, placement? })` opens `brief`, `script`, `storyboard`, `styleframes`, `review` or
  `custom` and returns `{ id, status: 'open' }` at once. `data` is what the panel starts from: a partial `Brief`; a
  `Storyboard` (`comp` and `shots`); a `ReviewRequest` (`comp`, `range?`, `ask?`). `message` is one line shown at the top.
  Opening a second panel of the same kind replaces the first.
- `studio_panel_result({ id })` returns `{ status: 'open' | 'submitted' | 'dismissed', answer? }`. Use it only when the
  person tells you in a terminal that they answered.

After you open a panel, end your turn with one line saying what you are waiting for. Do not start the next stage and do not
call the tool again to check. The answer arrives as a message starting `[panel <kind> <id> submitted]`, or `dismissed` if
the person closed it. Read `plan/<panel>.json` before you build from it.

For a one-off question the built-in panels do not fit, use `panel: 'custom'`; the block types and the answer shape are in
`references/panels.md`.
