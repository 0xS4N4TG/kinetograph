---
name: kinetograph-docs
description: Search the Kinetograph docs at kinetograph.dev and read a page as Markdown. Use when you need a fact about Kinetograph that the other skills do not give: a CLI flag, a guide, a plugin, the compatibility list, terminology or the changelog.
metadata:
  version: "0.4.0-rc.1"
---

# Read the Kinetograph docs

The docs are at `https://kinetograph.dev/docs/`. Fetch the Markdown, not the HTML. The other kinetograph-* skills
cover the everyday commands; use the docs for the rest. A command given a bad argument prints its usage.

## A page as Markdown

Every docs page is served as Markdown at `https://kinetograph.dev/llms.mdx/<slug>.md`, where `<slug>` is the page's path
after `/docs/`:

| Page | Markdown |
|---|---|
| `/docs/guides/agents/` | `https://kinetograph.dev/llms.mdx/guides/agents.md` |
| `/docs/reference/cli/` | `https://kinetograph.dev/llms.mdx/reference/cli.md` |
| `/docs/` (the overview) | `https://kinetograph.dev/llms.mdx/index.md` |

```sh
curl -sL https://kinetograph.dev/llms.mdx/reference/cli.md
```

The same files are in the repository under `packages/site/content/docs/` as `.mdx`, if you have a clone.

## Find the page

`https://kinetograph.dev/llms.txt` is a summary for agents (install steps, the CLI, native elements); it does not list the
pages. The site's search index is at `https://kinetograph.dev/api/search` (about 2 MB of JSON; download it once per task).
List the pages:

```sh
curl -sL https://kinetograph.dev/api/search -o search.json
jq -r '.docs.docs[] | select(.type=="page") | "\(.url)\t\(.content)"' search.json
```

Search the text of every page, headings included, for the pages that match:

```sh
jq -r --arg q 'prores' '[.docs.docs[] | select(.content | test($q; "i")) | .page_id] | unique[]' search.json
```

Then fetch the page's Markdown (`/docs/reference/cli` is `reference/cli.md`) and read the section you need. Save `search.json`
outside the project.

## Where things are

- `/docs/reference/cli/`: every command and flag. `/docs/reference/scene-format/`: the `.json` scene.
- `/docs/guides/`: agents, authoring, audio, Studio, datamosh, motion tracking, migrating from Remotion or HyperFrames, taste.
- `/docs/compat/`: what is drawn, what is not, known gaps, `doctor`.
- `/docs/plugins/`: using and writing plugins. `/docs/terminology/`: one page per term.
- `/docs/changelog/`: what changed in each version.
