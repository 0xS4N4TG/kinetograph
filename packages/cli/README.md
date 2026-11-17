# kinetograph

The `kinetograph` command line, MCP server and agent skill: render a Remotion-shaped project, an HTML page or a HyperFrames project to video without a browser.

Part of [Kinetograph](https://github.com/0xS4N4TG/kinetograph), a programmatic video engine with no browser in it. See the repository for the documentation.

Once a day the CLI checks npm for a newer version and looks for out-of-date agent skills (update them with `npx kinetograph skills update`, which installs them, and the taste skill, for Claude Code, Codex and Cursor), and says so in one line on stderr. It never installs anything. `KINETOGRAPH_NO_UPDATE_CHECK=1` or `CI` turns it off; `kinetograph doctor` always reports both.

Licensed under the Apache License 2.0, see `LICENSE.md`.
