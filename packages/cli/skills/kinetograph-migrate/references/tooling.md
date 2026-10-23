# Tooling: player, renderer, bundler, cli, lambda

These packages run or serve Remotion, not the video code. Kinetograph's CLI replaces them. Delete the imports; keep
the compositions. The video entry (the file with `registerRoot`) stays.

## Mapping

| Remotion | Kinetograph |
|---|---|
| `npx remotion studio <entry>` | `npx kinetograph studio <entry>` (add `--no-open` when you start it yourself; it runs until stopped) |
| `npx remotion render <entry> <id> out.mp4` | `npx kinetograph render <entry> --comp <id> -o out.mp4` |
| `npx remotion still <entry> <id> out.png --frame=45` | `npx kinetograph still <entry> 45 --comp <id> -o out.png` |
| `npx remotion compositions <entry>` | `npx kinetograph compositions <entry>` |
| `--props='{"a":1}'` | `--props '{"a":1}'` (a JSON string; a file path is not read) |
| `--frames=10-40` | `--range 10..=40` (`10..40` stops at 39) |
| `--codec`, `--crf`, `--scale`, `--concurrency`, `--audio-codec`, `--pixel-format`, `--prores-profile` | the same flag names |
| `--gif-every-nth-frame` | `--every-nth-frame` |
| `--log`, `--public-dir`, `--browser-executable`, `--gl`, `--chrome-mode` | not needed: no browser. `staticFile` reads `public/` next to the entry |
| `remotion.config.ts` (`Config.setCodec(...)`, `setCrf`) | put the options on the `render` command (in `package.json` scripts) |
| `remotion.config.ts` `overrideWebpackConfig` | drop it. CSS, Tailwind and CSS modules are handled by the CLI |
| `@remotion/tailwind`, `@remotion/tailwind-v4` `enableTailwind` | drop it. Tailwind itself works; the CLI builds it with the project's Tailwind setup |
| `@remotion/renderer` `selectComposition` + `renderMedia({ composition, inputProps })` | shell out to `kinetograph render --comp --props`, or call `npx kinetograph render ... --json` and parse the one JSON object |
| `renderStill` | `kinetograph still` |
| `getCompositions` | `kinetograph compositions <entry> --json` |
| `@remotion/bundler` `bundle()` | nothing: `render` bundles the entry itself |
| `@remotion/lambda`, `@remotion/cloudrun` | there is no cloud renderer. Run `kinetograph render` on any machine with a GPU wgpu supports (Metal on macOS, Vulkan or DX12 elsewhere). For a long film use `--concurrency 4`. Tell the user this is a real change |
| `@remotion/player` `<Player>` in a web page | the studio: `kinetograph studio <entry>`. There is no embeddable player. Tell the user |
| `@remotion/cli` | `kinetograph` |

## Typical edits

1. `package.json` scripts: replace `remotion studio` and `remotion render` with the Kinetograph commands above. Keep
   the old ones out; two ways to render confuse the next reader.
2. Add `kinetograph` as a dev dependency (`npm install -D kinetograph`). Remove `@remotion/cli`, `@remotion/renderer`, `@remotion/bundler`,
   `@remotion/lambda`, `@remotion/player` and tailwind config packages from `package.json` once nothing imports them.
   Remove `@remotion/three`, `three` and `@react-three/fiber` once the 3D is ported. Keep `remotion` and the video's `@remotion/*` packages if the project's own type checking needs their types; the
   CLI does not read them at render time.
3. A render script such as `scripts/render.ts` that calls `renderMedia` becomes a `package.json` script or a shell
   script. If it loops over many compositions or props, loop over `kinetograph render --comp ... --props ...` calls.
4. A page that embeds `<Player>` is not part of the video. Leave the page and keep `@remotion/player` in
   `package.json` while it imports it. Tell the user it keeps using Remotion's player unless they drop it, and that
   Kinetograph's preview is the studio. Do not port it. Remove `@remotion/player` only if you delete the page.
   Other scripts in `package.json` (`vite`, `next`, deploy scripts) belong to that page; leave them and mention them.
5. `inputProps` read through `getInputProps()` still work: `--props` feeds them.

## Check

`kinetograph compositions <entry>` lists the compositions; `kinetograph render <entry> --comp <id> -o out/a.mp4
--strict --range 0..30` renders a short part first.
