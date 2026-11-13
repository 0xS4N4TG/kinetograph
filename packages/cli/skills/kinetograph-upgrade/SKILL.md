---
name: kinetograph-upgrade
description: Upgrade Kinetograph in a project: the `kinetograph` CLI, its `@kinetographdev/*` packages and plugins together, and the installed agent skills. Use when a command says the CLI or the skills are out of date, when asked to update or bump Kinetograph, or after a version mismatch error.
metadata:
  version: "0.4.0-rc.1"
---

# Upgrade Kinetograph

Ask the user before you change anything: the CLI only prints a notice (once a day, off in CI and with
`KINETOGRAPH_NO_UPDATE_CHECK=1`) and never installs. Go ahead on a yes.

## How the versions fit

- `kinetograph` pins each of its `@kinetographdev/*` dependencies (`core`, `audio`, `compat`, `scene`, `native`, `studio`) to
  its own exact version. Upgrading `kinetograph` moves them all; never pin one of them separately.
- A plugin (`@kinetographdev/gsap`, `anime`, `motion`, `p5-brush`, or one from elsewhere) is its own package with a peer
  range on `@kinetographdev/core`, such as `^0.2.0 || ^0.3.0`. While the version is 0.x, `^0.3.0` means 0.3.x only, so a new
  minor of `kinetograph` needs a plugin release that lists it. `@kinetographdev/studio` peers on the exact `kinetograph`.
- The agent skills carry `metadata.version` in their SKILL.md. A skill is current when it is at least the CLI's version.

## Steps

1. **Look.** `npx kinetograph doctor` prints the CLI against the latest on npm and each installed skill with its version and
   whether it is current. `npm outdated kinetograph` and `npm ls kinetograph` show what the project has; check the
   project's `package.json` for `@kinetographdev/*` entries.
2. **Read what changed.** The changelog is `CHANGELOG.md` in the repository and `https://kinetograph.dev/llms.mdx/changelog.md`
   (see `kinetograph-docs`). Note any renamed flag or API.
3. **Upgrade the packages in one command**, so npm resolves them together: `npm install kinetograph@latest` plus every
   `@kinetographdev/*` plugin the project lists, each at `@latest`. Then `npm ls @kinetographdev/core` must show one version;
   a second copy means a plugin is behind (install its newer release, or hold `kinetograph` back).
4. **Refresh the skills.** `npx skills add 0xS4N4TG/kinetograph` (it asks which agents; `--list` shows what it found). It
   installs them from the GitHub repo (`packages/cli/skills/`). Install all of them: the skills point to each
   other. Then `npx kinetograph doctor` again; every skill should say `current`.
5. **Check the project.** `npx kinetograph check <entry>` (TSX), `lint`, `doctor <entry>` and `strip` (see
   `kinetograph-render`); `snapshot <entry>` if approved frames exist, to see what moved. Fix what the changelog says
   changed.

Skills from other repos, such as `kinetograph-taste-clone`, update with their own `npx skills add`.
