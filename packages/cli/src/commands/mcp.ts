import type { Command } from './types.js';

export const mcp: Command = {
  name: 'mcp',
  summary: 'Run the MCP server on stdio: one tool per command',
  project: false,
  positionals: [],
  options: [
    {
      name: 'studio',
      type: 'string',
      description: 'The address of a running studio (http://127.0.0.1:3000); adds the tools studio_get_props, studio_set_props, studio_open_panel and studio_panel_result. The studio token goes in the environment variable KINETOGRAPH_STUDIO_TOKEN',
    },
  ],
  async run(args) {
    // Loaded here so that no other command pays for the SDK, and because the server lists the commands.
    const { startMcpServer } = await import('../mcp.js');
    await startMcpServer(args.options.studio as string | undefined);
    return { data: {}, text: '' };
  },
};
