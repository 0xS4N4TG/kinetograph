# Proposal: panels the agent opens in Studio

Status: not built. This page describes panels that a coding agent opens inside Studio to ask the person it works with
for a decision, and the order of work they support. The first three are Brief, Storyboard and Review.

## Why

An agent can write a whole video before anyone has said what it is for, how long it runs or what it should look like.
The expensive mistakes come from that: the wrong aspect ratio, a script that overruns, a look nobody wanted, found
after the animation is done. Motion designers avoid them by settling decisions in order, each one cheap when it is
made and expensive later:

1. Brief: what it is for, who watches it, where it runs, how long it is, the one thing a viewer takes away, and 3 to 5
   reference videos.
2. Script or voiceover, or the track for a music-led piece. Its timing drives everything after it.
3. Storyboard: one rough frame per shot, with what moves, the line that plays over it, its length and the transition
   into the next shot.
4. Styleframes: 2 to 4 finished-looking stills of key moments in the real fonts, colours and textures.
5. Animatic: the board frames held on a timeline against the voiceover or music, to check the pacing.
6. Build, animate (hero moments first), polish, deliver.

The panels put each decision in front of the person at the point where it is cheap, in a form that is quicker to
answer than a chat message, and keep the answer in the project so later steps read it.

## The flow

- Studio shows the stages as a small stepper over the preview: Brief, Script, Board, Style, Animatic, Build, Deliver.
  A stage is empty, open (a panel is waiting), or approved. Clicking a stage opens its panel with the saved answer.
- Nothing is locked. The person can skip a stage, and a small job (a caption fix) needs none of them. The skill
  (below) tells the agent which stages to ask for, and not to start animating before the board and the style are
  approved.
- Polish is not a stage with a panel. Readability checks (seconds per word on screen, platform UI zones, legibility at
  phone size) run as warnings in the existing safe-zone view.
- Deliver is the existing export dialog.

## Mechanism

### One tool, async

The agent gets one tool, `studio_open_panel`, from `kinetograph mcp --studio` (the server Studio already gives its
agent, with the agent's own token).

```ts
studio_open_panel({
  panel: 'brief' | 'storyboard' | 'review',   // later: 'script', 'styleframes'
  data: BriefDraft | StoryboardDraft | ReviewRequest,
  message?: string,                            // one line shown at the top of the panel
}) → { id: string, status: 'open' }
```

It returns at once. The agent then ends its turn with a short line ("The board is up in Studio. I'll wait for your
notes.") and does nothing else until the answer arrives. It never blocks inside the tool call, because a person can
take minutes or a day to answer a storyboard: an open call would hit the MCP client's timeout, die with a reload or an
agent restart, and stop the person from asking the agent anything while the panel is open.

### How the answer reaches the agent

- **The agent inside Studio (ACP).** When the person submits, the server sends the answer to the agent as the next
  user message (`agent-bridge.ts` `prompt()`), as text the skill describes:
  `[panel storyboard p_3 submitted] approved 7 of 8 shots; see plan/storyboard.json`, followed by the changes in short
  form (shots removed, reordered, notes per shot). If the agent is mid-turn, the message waits in a queue and is sent
  when the turn ends.
- **An agent outside Studio (Claude Code in a terminal with `mcp --studio`).** The server cannot start that agent's
  next turn. The panel shows "Tell your agent you're done", and the agent reads the answer with
  `studio_panel_result({ id })` → `{ status: 'open' | 'submitted' | 'dismissed', answer? }`, or from the plan file.
- **Either way the answer is in the project.** Submitting writes `plan/<panel>.json` beside the entry, so a reload, a
  new conversation or another agent still has it. The agent reads it before it builds.

### Rules

- One open panel per kind. Opening a second Brief replaces the first (the first becomes `dismissed`).
- The person can dismiss a panel. The agent gets `[panel brief p_1 dismissed]` and continues without it.
- The window that owns the conversation shows the panel. A panel opened while no window is connected waits and shows
  when one connects.

### Server and protocol

- `POST /api/panels` (agent token, as `/api/live-props` takes it now) opens a panel: `{ panel, data, message }` →
  `{ id }`. `GET /api/panels/<id>` returns its status and answer.
- `ServerMessage` gains `{ type: 'panel'; panel: OpenPanel }` and `{ type: 'panel.closed'; id }`. `ClientMessage` gains
  `{ type: 'panel.submit'; id; answer }` and `{ type: 'panel.dismiss'; id }`.
- The server validates each answer against the panel's schema before it writes the plan file or tells the agent.
- Open panels are kept with the chat log, so a reload of the owning window gets them back.

## The panels

### Brief

The agent pre-fills what it knows from the conversation. The person corrects it and approves.

```ts
interface Brief {
  purpose: string;              // what it is for: "launch ad for the plugin store"
  audience: string;             // who watches it
  platform: 'reel-9x16' | 'youtube-16x9' | 'square-1x1' | 'ad-slot' | 'custom';
  size: { width: number; height: number; fps: number };  // filled from the platform, editable
  seconds: number;              // target length
  takeaway: string;             // the one thing a viewer should leave with
  references: Reference[];      // 3 to 5
  notes?: string;
}
interface Reference {
  kind: 'link' | 'file';        // a link is kept as text; a file is copied into plan/refs/
  src: string;
  like: string;                 // what the person likes about it: "the cut rhythm", "the type"
  sheet?: string;               // for a file: a contact sheet of 8 frames, made by the engine, for the agent to look at
}
```

- Platform presets set the size and fps. On approval, the agent sets the main composition's width, height, fps and
  `durationInFrames` from the brief, which removes the wrong-aspect mistake.
- References: the panel asks for 3 to 5 and for one line on each saying what to take from it. A link is only a note:
  Studio does not download it. A dropped video file is copied into `plan/refs/`, and Studio renders a contact sheet of
  it so an agent that reads pictures can see it.
- The panel warns when the takeaway is empty or the length doesn't fit the platform (a 90 s reel).

### Storyboard

The board is a composition. The agent writes a `Storyboard` composition with one rough frame per shot (boxes, stick
figures, the words, drawn quickly with the engine), and opens the panel with the shot list. The panel renders each
shot's frame with the existing still renderer, so the thumbnails are always what the code draws.

```ts
interface Storyboard {
  comp: string;                 // the composition that draws the board, "Storyboard"
  shots: Shot[];
}
interface Shot {
  id: string;                   // stable across edits: "s1"
  frame: number;                // the board composition's frame that shows this shot
  what: string;                 // what's on screen
  moves: string;                // what moves
  line?: string;                // the script line that plays over it
  seconds: number;
  transition: 'cut' | 'match-cut' | 'whip' | 'dissolve' | 'wipe' | 'other';
  transitionNote?: string;
}
interface StoryboardAnswer {
  shots: Shot[];                // in the person's order, with edits
  removed: string[];            // shot ids
  notes: { shot: string; text: string }[];
  approved: boolean;            // false: "rework and show me again"
}
```

- A grid of shot cards: thumbnail, the line, the length, the transition chip. The person drags to reorder, edits a
  card's text, length or transition, removes a shot, adds an empty one ("something here"), and comments on a card.
- A running total of the lengths against the brief's target, so an overrun shows before anything is animated.
- Approved, the shot list is what the build starts from: one `Sequence` per shot, in this order, with these lengths.

### Review

Used for the animatic, the animation checkpoints (hook and reveal first) and the final cut.

```ts
interface ReviewRequest {
  comp: string;
  range?: [number, number];     // frames; the whole composition when left out
  ask?: string;                 // "Is the pacing right before I animate?"
}
interface ReviewAnswer {
  notes: Note[];
  verdict: 'approved' | 'changes';
}
interface Note {
  frame: number;                // where the playhead was
  text: string;                 // "too long", "the hook lands late"
  box?: { x: number; y: number; w: number; h: number };  // optional area, with the existing box select
  layer?: string;               // the layer under the box, when there is one
}
```

- The preview plays the range. Pressing N (or a button) adds a note at the playhead; dragging a box ties it to an
  area. Notes show as marks on the timeline.
- The agent gets the notes in time order, each with its frame and, when there is one, the layer.

### Later: Script and Styleframes

- **Script**: the lines, an estimated read time per line (words at a set rate, or the voiceover's real length once
  there is one) and a running total against the brief. For a music-led piece, a track picker with the beats marked.
- **Styleframes**: 2 to 4 stills rendered by the engine side by side. The person picks one or mixes them ("A's type,
  B's colours") and pins notes on areas. The answer is saved as `plan/style.json` (fonts, palette, textures), which
  the build must use.

## Skill text (draft for the Kinetograph skill)

> **Working with a person in Studio.** For a new video, settle the decisions in order before you animate, using
> `studio_open_panel`: a **brief** first (pre-fill what you know from the chat), then the script or track, then a
> **storyboard**, then the look. Build an animatic and ask for a **review** before animating; animate the hook and the
> reveal first and ask for a review again.
>
> After you open a panel, end your turn with one line saying what you are waiting for. Do not start the next stage
> and do not call the tool again to check. The answer arrives as a message starting `[panel <kind> <id> submitted]`,
> or `dismissed` if the person closed it; in a terminal, the person tells you, and you read it with
> `studio_panel_result`. Read `plan/<panel>.json` before you build from it.
>
> Skip stages that don't fit the job: a caption fix needs no brief. Never animate against an unapproved storyboard
> without saying so.

## Build order

1. The mechanism: `studio_open_panel`, `studio_panel_result`, the routes, the messages, the plan files, the queue
   into the agent's next turn. Tests: open, submit, dismiss, replace, reload of the owning window, agent mid-turn.
2. Brief panel, and the composition settings it sets on approval.
3. Storyboard panel, with thumbnails from the board composition.
4. Review panel.
5. The stepper, then Script and Styleframes.

## Open questions

- Should approving a brief change the composition's size itself, or only tell the agent to? Changing it in the
  server touches the user's code; leaving it to the agent keeps one writer.
- Is a contact sheet of a dropped reference enough, or should a reference also keep a few clips the agent can scrub?
- Do the panels need to work without an agent, as plain planning tools the person fills in alone?

## Next: general-purpose panels

The five panels above are fixed kinds. The mechanism under them (open, answer as the next message, plan file) can carry
any panel, so the next step makes panels general in three parts, built in this order.

### 1. A `custom` panel made of blocks

The agent sends a layout as data, not code. Studio draws it with one generic renderer and returns an answer keyed by
block id, through the same async path.

```ts
studio_open_panel({ panel: 'custom', placement: 'right', data: {
  title: 'Pick the end card',
  blocks: [
    { id: 'pick', type: 'choice', options: [{ id: 'a', still: { comp: 'End', frame: 40 } }, { id: 'b', still: { comp: 'End', frame: 90 } }] },
    { id: 'speed', type: 'slider', min: 0.5, max: 2, value: 1, label: 'Logo speed' },
    { id: 'why', type: 'text', label: 'Anything else?' },
  ] } })
// answer: { pick: 'b', speed: 1.2, why: '...' }
```

- Block types: heading, text, still (comp and frame), clip (comp and frame range, played in place), choice (single or
  multiple, with pictures), slider, text input, editable list, table, notes on a picture, A/B compare.
- No code runs, so it is safe, and it works the same for an agent in a terminal. A person can ask the agent for a panel
  ("let me rate each shot") and the agent builds one on the spot.
- The answer is saved as `plan/custom-<name>.json`, where `name` is a slug the agent gives.

### 2. Placement and persistent panels

- `placement: 'sheet' | 'left' | 'right' | 'beside-preview' | 'bottom'` on any panel. Left and right panels are tabs
  beside the agent chat and the inspector. The person can drag a tab to another dock; the layout is kept per project.
- A persistent panel stays open and is not a question: a live shot list, a checklist, a render log. The agent changes
  its data with `studio_update_panel({ id, data })`, and closes it with `studio_close_panel({ id })`.

### 3. Code panels, sandboxed

- The agent, or the person through the agent, writes `studio/panels/<name>.ts` in the project, exporting
  `mount(el, api)`: the contract plugin panels use, with `api.data`, the playhead, `seek`, stills and
  `submit(answer)`. Studio bundles it and reloads it on save.
- It runs in a sandboxed iframe (no same-origin, no window token) and talks to Studio only through messages, because a
  panel in the Studio page could do anything Studio can. Plugin panels, which today run in the page, move to the same
  sandbox.

### Skill text

Each part adds its section to the skill when it lands, not before: an agent that reads about a panel kind that does
not exist yet calls it and gets an error.
