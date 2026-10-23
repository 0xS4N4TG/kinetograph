---
name: kinetograph-migrate
description: Move an existing Remotion project onto Kinetograph so it renders without a browser. Use when the user has a Remotion project (remotion or @remotion/* imports, `remotion render` scripts, @remotion/three, @remotion/player) and wants it to run, preview or render with Kinetograph, or asks what in a Remotion project will not work there.
---

# Migrate a Remotion project to Kinetograph

Most of a Remotion project runs unchanged. `remotion` and 24 `@remotion/*` packages are mapped onto Kinetograph's core
by the CLI, so the video code does not change. What changes is the tooling around it, and a few packages that have no
equivalent. There is no browser anywhere in the render path. Never add one: no Chrome, Puppeteer, Playwright or iframe
as a stopgap, for any reason.

Run commands as `npx kinetograph <command>`. Add `--json` to get one JSON object. For the other commands and the
project API, use the `kinetograph` skill.

## The loop

1. **Find the entry and the compositions.** Read `package.json` (scripts, dependencies) and any `remotion.config.ts`
   too: `doctor` only sees files the entry imports, so a player page, a render script or a config file never shows up in
   its report. Search the project for `@remotion/(player|renderer|bundler|lambda|cloudrun|cli|three)`, `from 'three'` and
   `IFrame`, and treat each hit as a finding. The entry is the file that calls `registerRoot` (often `src/index.ts`;
   `package.json` scripts or `remotion.config.ts` name it). Run `kinetograph compositions <entry>`. If it fails with
   `... is not supported by Kinetograph yet`, that import is the first finding. (The message says to run `doctor`, but
   `doctor` stops on the same import until you fix it.)
2. **Doctor.** `kinetograph doctor <entry>` (add `--comp <id>` for one composition). It reports every element,
   property and reason the engine cannot draw, with frame ranges. An import that cannot be bundled stops the command
   before any report, with the package named; fix that first and run `doctor` again. Keep the report; work from it.
3. **Fix each finding.** Pick by kind:
   - `@remotion/three` or `three` imports: read `references/three.md`.
   - `@remotion/player`, `@remotion/renderer`, `@remotion/bundler`, `@remotion/lambda`, `@remotion/cloudrun`, `@remotion/cli`,
     `remotion.config.ts`, `npm run` scripts, webpack overrides: read `references/tooling.md`.
   - `IFrame`, `@remotion/webcodecs`, `@remotion/media-parser` sample callbacks, `@remotion/rive`, `@remotion/skia`,
     Canvas, WebGL or CSS issues in the report: read `references/unsupported.md`.
   - Anything else: the property or element is named in the report. Change it to one the engine draws, or leave it
     out. Do not guess; run `doctor` again.
4. **Lint.** `kinetograph lint <entry>` and `kinetograph check <entry>` (type errors). Fix every error. Errors that say
   "no declaration file" for `react` mean `@types/react` is not installed: add it as a dev dependency at the project's
   React version and tell the user. That is not a migration problem and does not block `render`.
5. **Look.** `kinetograph strip <entry> -n 12 -o out/strip.png`, then open the PNG. Use `still <entry> <frame>` for one
   frame. Compare with what the project was meant to show (a Remotion render, a screenshot, the user's description; if
   you have none, check against the code and say that you could not compare). `doctor` and `lint` can both be clean
   while text is missing, so check that every title and caption is on screen (see Fonts).
6. **Render.** `kinetograph render <entry> --comp <id> -o out/video.mp4 --strict` (`--range 0..30` first for a quick
   test; `a..b` stops at b-1, `a..=b` includes b). `--strict` fails on the first frame
   with anything unsupported, so no video leaves with something missing.

If `--strict` still fails after the fixes, a left-over is real. Either approximate it (say how) or remove it, then say
so in step 7. Do not hide it by dropping `--strict` for the final render.

7. **Report to the user.** List what was ported as is, what was replaced (and with what), what was left out or
   approximated, and the commands to run the project now. Say plainly when the result differs from Remotion's.

## Rules

- A `remotion` import needs no edit. Do not rewrite `remotion` or `@remotion/*` imports to `@kinetographdev/core`.
- Never remove a feature silently. Every omission or approximation goes in the report from step 7.
- **Fonts.** Text in a font that is not registered may be drawn as nothing, with no warning from `doctor`. A
  `fontFamily` that names only system fonts (`Helvetica, Arial, sans-serif`) is the usual cause. Register a font file
  the user is allowed to use: `@remotion/google-fonts/<Family>` (`loadFont()`), `registerFont({ family, path:
  staticFile('F.ttf') })` from `@kinetographdev/core`, or `@font-face { src: url(...) }` in an imported `.css` file. Do not
  copy system fonts into the project.
- Rendering is a pure function of the frame. Replace `Date.now()`, `Math.random()` and timers with frame maths and
  `random(seed)`.
- There is no network. `fetch` reads project files only. Copy remote assets into `public/` and use `staticFile`.
- Do not add dependencies for the render path, except `kinetograph` itself as a dev dependency (it brings
  `@kinetographdev/core`, which the 3D elements import from). If it is not on npm yet, ask the user where to install it
  from. Packages for the studio or tests are fine.

## Coverage in one line

Core `remotion` and these `@remotion/*` packages are mapped: transitions, motion-blur, noise, paths, shapes,
layout-utils, animation-utils, captions, google-fonts, fonts, lottie, gif, media-utils, media, light-leaks, starburst,
sfx, zod-types, timeline-utils, media-parser, webcodecs, canvas, rive, skia. Not ported on purpose: three, player,
renderer, bundler, cli, lambda, cloudrun, tailwind, tailwind-v4 (Tailwind itself works). The full table is on the docs
site at `/docs/guides/migrate/`.
