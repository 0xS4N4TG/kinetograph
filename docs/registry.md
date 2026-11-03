# Registry format

`npx kinetograph add <name>` installs a component, template or taste from a registry: a folder of static JSON files.
The default registry is `https://kinetograph.dev/r/` (`<name>.json` per item, `index.json` for the list).
`KINETOGRAPH_REGISTRY` points the CLI at another `https://` registry or at a local folder. This page is for people who
write items. Code: `packages/cli/src/registry/`. Item schema: `docs/registry-item.schema.json` (also served as
`/r/schema.json`).

## What an item is

| Type | Installs to | Must contain |
|---|---|---|
| `component` | `src/components/<name>/` | `index.tsx` exporting the component and its zod schema (`export const <Name>Schema`, or a name ending in `Schema`) |
| `template` | `src/templates/<name>/` | `index.tsx` that calls `registerRoot` (renders on its own), and the scenes in `scenes/` |
| `taste` | `src/tastes/<name>/` | `TASTE.md` and whatever else the taste needs (`taste.json`, references) |

Assets install to `public/<kind>/<name>/`, where `<kind>` is `images`, `fonts`, `audio` or `video` (the folders
`kinetograph init` makes). The `<name>` folder keeps `staticFile` paths unique across items:
`staticFile('images/title-card/dot.png')`.

## Author layout

One folder per item, named after the item. The folder mirrors the project: the item's own files sit at its top level
and install under `src/<types>/<name>/`; assets go in `public/<kind>/` and the builder adds `<name>`.

```
items/title-card/
  item.json                 the metadata (below)
  index.tsx                 -> src/components/title-card/index.tsx
  helpers/ease.ts           -> src/components/title-card/helpers/ease.ts
  public/images/dot.png     -> public/images/title-card/dot.png
```

A template looks like `index.tsx`, `scenes/Intro.tsx`, `public/audio/bed.mp3`. Dot files are skipped; symbolic links
are an error.

`item.json`:

```json
{
  "name": "title-card",
  "type": "component",
  "title": "Title card",
  "description": "A title and an optional subtitle on a plain background.",
  "kinetograph": "0.2.0",
  "access": "free",
  "dependencies": { "zod": "4.6.7" },
  "registryDependencies": [],
  "props": [{ "name": "title", "type": "string", "doc": "The big line." }]
}
```

- `name`: the folder name; lowercase words joined by hyphens.
- `kinetograph`: the oldest CLI that runs the item.
- `dependencies`: npm packages the item imports, with versions or ranges (no URLs, git or file specs). Do not list
  `kinetograph` or `@kinetographdev/*`; the project has them.
- `registryDependencies`: other items by name; installed first, once each. Loops are an error.
- `access`: `free` (default) or `paid`. A paid item cannot be installed yet.
- `props`: the props summary for the catalog (`name`, `type`, `optional`, `doc`).

## Rules for the code

- Imports are relative inside the item (`./helpers/ease`) or bare packages (`@kinetographdev/core`, `zod`, anything in
  `dependencies`). No absolute paths, no `../` out of the item, no reading outside `public/`.
- Every prop in the zod schema has `.describe('...')`; Studio and agents read them. Give optional props a `.default()`.
- Rendering is a pure function of the frame: no `Date.now()`, no `Math.random()` (use `random(seed)`), no network.
- Fonts: load them with `@remotion/google-fonts/<Family>` or ship the file in `public/fonts/<name>/`.
- Text files are UTF-8. Anything else (images, fonts, audio, video) is a binary asset, served from `files/` with a
  SHA-256 that the CLI checks.
- Test it: add it to a project made by `kinetograph init`, then run `npx kinetograph check` and `still`.

## Build the registry

```sh
npm run build -w kinetograph
node packages/cli/scripts/build-registry.mjs <items-dir> <out-dir>
```

`<out-dir>` gets `<name>.json` per item, `index.json`, `schema.json` and `files/<name>/…` for the binary assets. The
output depends only on the input, so it can be committed or served as static files (`/r/`). The builder refuses an
item that breaks the rules above (no schema export, an unknown `public/` folder, a missing `registryDependencies`
target, a loop).

Try it without a network:

```sh
KINETOGRAPH_REGISTRY=<out-dir> npx kinetograph add --list
KINETOGRAPH_REGISTRY=<out-dir> npx kinetograph add title-card
```

A sample item is in `packages/cli/test/fixtures/registry-src/title-card/`.

## What the CLI checks

The CLI treats every item as untrusted data and never executes anything from it. Targets must be relative paths under
`src/` or `public/`: no absolute paths, `..`, backslashes or control characters, and no symbolic link anywhere on the
way. Files are fetched over `https` only (redirects included), a binary's `url` must be on the same origin as the item (scheme, host and port; a folder registry allows no absolute URLs), with size limits (4 MB per JSON file, 100 MB per
binary), and nothing is written until every item and download has been checked.
