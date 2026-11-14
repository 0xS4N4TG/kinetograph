---
name: kinetograph-create
description: Start a new Kinetograph project or add to one. Use when the folder has no Kinetograph project yet, when asked for a new video from scratch, or to install a component, template or taste from the registry with `kinetograph init` and `kinetograph add`.
metadata:
  version: "0.4.0-rc.1"
---

# Create a Kinetograph project

## A new project

Run `npx kinetograph init [dir]` in an empty folder (`--html` starts an HTML page instead of TSX), keep the layout it
makes, then `npm install`. `init` skips files that already exist.

```
src/index.tsx     registerRoot and the compositions (starter: composition "Main", 1280x720, 60 frames at 30 fps)
src/scenes/       one file per scene; reusable pieces in src/components/, helpers in src/lib/
html/index.html   with --html: a page with a GSAP timeline, instead of src/
public/           assets for staticFile(): images/, fonts/, audio/, video/
out/              everything generated: renders/, stills/, sheets/
```

It also writes `package.json` (scripts `still`, `strip`, `render`, and `check` for TSX or `lint` for HTML; `kinetograph` is
the only dependency), `tsconfig.json` (TSX) and `.gitignore`. Check it with `npx kinetograph strip src/index.tsx`, then
go on with `kinetograph-markup`.

An existing project keeps its own layout; never move its files.

- Import the API from `@kinetographdev/core`, which comes with `kinetograph`. Never install `remotion`.
- Load assets with `staticFile('images/logo.png')`.
- Never write outputs next to the code or at the project root. `still`, `strip`, `onion` and `render` write to `out/` when
  you leave out `-o`, and print the path.
- A second composition is another `<Composition id>` under `registerRoot`; pick it with `--comp <id>`.

## Components, templates and tastes

Don't rewrite what the registry has. `npx kinetograph add --list` shows it (`--type component|template|taste` narrows it);
`npx kinetograph add <name…>` installs:

- a component into `src/components/<name>/`, a template (a whole reel) into `src/templates/<name>/`, a taste (a reusable
  style) into `src/tastes/<name>/`;
- their assets into `public/<kind>/<name>/`, and the registry items they depend on.

It never overwrites a file you changed (`--overwrite` does). It installs the npm packages an item needs only with `--yes`
(or a yes at a terminal); with `--json` it prints the command and does not run it. `--dir <folder>` names the project.
Read what it prints under `next:` for the import line.

To make a taste from a reference reel, use `kinetograph-taste-clone` (from the kinetograph-ui repo, if installed).
