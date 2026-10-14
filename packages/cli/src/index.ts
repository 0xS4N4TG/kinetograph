// kinetograph: the agent CLI and MCP server (docs/AUTHORING.md §9).
//
// Orchestrator scaffolding. Stream 5 (`feat/cli-audio-mcp`) implements the
// commands; `run` is what `cli.ts` calls.

/** Runs the CLI with `argv` (without `node` and the script) and returns the exit code. */
export async function run(argv: string[]): Promise<number> {
  const command = argv[0] ?? '';
  process.stderr.write(`kinetograph: not implemented yet: ${command}\n`);
  return 1;
}
