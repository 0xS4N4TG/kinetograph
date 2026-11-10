# Custom panels

Use `studio_open_panel({ panel: 'custom', data, placement?, message? })` for a one-off question the five built-in panels do
not fit (rate each shot, pick between two end cards, fill in a list), or when the person asks you for a panel ("let me rate
each shot"). Use a built-in panel when one fits: its answer has a fixed shape and a stage. A custom panel is data, not code;
nothing you send runs.

`data` is `{ name, title, blocks, submitLabel? }`. `name` is a slug (`a-z`, `0-9`, `-`, 40 at most) that names the plan file,
`plan/custom-<name>.json`; opening a panel with the name of an open one replaces it, and panels with different names can be
open at once. Every block has an `id` (a letter first, unique) and may have `label`, `help` and `required` (the button waits
for it). 40 blocks and 24 options per choice at most.

- Show: `heading {text}`, `text {text}` (paragraphs and `**bold**` only), `still {comp, frame, caption?}`,
  `clip {comp, from, to, caption?}` (plays in place).
- Ask (the answer holds a value for each of these, by block `id`):
  `choice {options: [{id, label?, still?, text?}], multiple?, value?}` gives a string, or a string list with `multiple`;
  `slider {min, max, step?, value?, unit?}` a number; `input {multiline?, placeholder?, value?}` a string;
  `list {items, editable?}` a string list (the person adds, removes and reorders when `editable`);
  `table {columns, rows, editable?}` rows of strings; `notes {still: {comp, frame}}` a list of `{ text, box? }` drawn on the
  picture; `compare {a: {comp, frame, label?}, b: {...}}` `'a'`, `'b'` or `null`.

```ts
studio_open_panel({ panel: 'custom', placement: 'right', message: 'Two end cards', data: {
  name: 'end-card', title: 'Pick the end card',
  blocks: [
    { id: 'pick', type: 'choice', required: true, options: [
      { id: 'a', label: 'Plain', still: { comp: 'End', frame: 40 } },
      { id: 'b', label: 'Loud', still: { comp: 'End', frame: 90 } } ] },
    { id: 'speed', type: 'slider', label: 'Logo speed', min: 0.5, max: 2, value: 1, unit: 'x' },
    { id: 'why', type: 'input', label: 'Anything else?', multiline: true },
  ] } })
// answer (in plan/custom-end-card.json under `answer`): { values: { pick: 'b', speed: 1.2, why: '...' } }
```

`placement` works on every panel: `'sheet'` (over the preview and timeline; the default), `'beside-preview'` (a column that
keeps the preview in view; a review's default), `'left'` (a tab beside the agent chat) or `'right'` (a tab beside the
inspector's). Put a panel in a column when the person should keep looking at the preview or the chat while they answer.

The answer arrives like any other: end your turn, then read the message
`[panel custom:<name> <id> submitted] <block id>=<value>, ...; see plan/custom-<name>.json`, or `dismissed`. The file holds
`{ draft, answer }`: `draft` is the `{ name, title, blocks, submitLabel? }` you sent, and `answer` is `{ values }` keyed by
block id. Read `answer.values` before you build from it; `draft` is there so you can see which block each value belongs to.
Studio keeps the file, and after a restart shows the panel again as answered. A file from before this, holding only
`{ values }`, is read as it was but not shown again.
