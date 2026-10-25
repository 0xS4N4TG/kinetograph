# @kinetographdev/studio

The local studio: a web server and browser UI whose preview frames the native addon renders.

## Chat with your coding agent

Click a layer in the preview (or drag a box around several, Shift adds), open the Agent tab and say what to change. The studio is an [ACP](https://agentclientprotocol.com) client: it starts your agent in the project directory and sends the selection as context. Claude Code, Codex and Gemini CLI are offered when found on PATH; use `--agent "<command>"` for another agent that speaks ACP on stdio. The agent may read and write files only inside the project, and every permission request waits for your answer. Open the address the studio prints (it carries a per-launch token); on a `--host` that other computers can reach the agent stays off unless you pass `--allow-remote-agent`.

Part of [Kinetograph](https://github.com/0xS4N4TG/kinetograph), a programmatic video engine with no browser in it. See the repository for the documentation.

Licensed under the PolyForm Small Business License 1.0.0, see `LICENSE.md`.
