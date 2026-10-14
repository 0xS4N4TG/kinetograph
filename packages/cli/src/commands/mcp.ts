import type { Command } from './types.js';

export const mcp: Command = {
  name: 'mcp',
  summary: 'Run the MCP server on stdio: one tool per command',
  project: false,
  positionals: [],
  options: [],
  async run() {
    // Loaded here so that no other command pays for the SDK, and because the server lists the commands.
    const { startMcpServer } = await import('../mcp.js');
    await startMcpServer();
    return { data: {}, text: '' };
  },
};
