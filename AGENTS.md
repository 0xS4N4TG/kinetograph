# Kinetograph: notes for coding agents

## Installing Kinetograph for a user

Most people want the prebuilt package. It installs in about a minute and needs no Rust, no FFmpeg and no compiler.
Building from source takes 15 to 30 minutes and is only needed to work on the engine itself.

1. **Ask the user which one they want**, unless they already said:
   - **Prebuilt (recommended):** `npm install kinetograph`. Covers macOS on Apple Silicon, Linux x64 (glibc) and
     Windows x64.
   - **Build from source:** only for changing the engine, or on a platform with no prebuilt package (Intel Mac,
     Linux on ARM).
2. **Prebuilt:**
   1. Check `node -v` is 22 or newer. If it isn't, tell the user and stop.
   2. In the user's project folder: `npm install kinetograph`.
   3. Run `npx kinetograph doctor` and show the user its output. `addon: loaded` means it works.
   4. For a new project, run `npx kinetograph init` (`--html` for an HTML page) in an empty folder and keep its layout.
3. **From source:** follow [Installation: From source](https://kinetograph.dev/docs/getting-started/installation/#from-source).
   Ask the user before installing Rust, Homebrew packages or anything else system-wide. Then run
   `npx kinetograph doctor` from the clone.
4. **Ask the user whether to install the agent skills and the MCP server.** They teach you how to write, check and render
   Kinetograph videos:
   - Skills: `npx skills add 0xS4N4TG/kinetograph`
   - MCP server, for Claude Code: `claude mcp add kinetograph -- npx -y kinetograph mcp`. Other agents:
     [Use with agents](https://kinetograph.dev/docs/guides/agents/).
5. Point the user to [First video](https://kinetograph.dev/docs/getting-started/first-video/).
6. If a Kinetograph command says the CLI or the skills are out of date, tell the user and ask before updating.

Don't build from source just because you are in a clone of this repository. Ask first.

## Working on this repository

Read `CLAUDE.md` for the project rules (no browser in the render path, determinism, licences) and
[Contributing](https://kinetograph.dev/docs/contributing/) for setup and tests.
