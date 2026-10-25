// The coding agents the studio can talk to. Each is started as a subprocess that speaks ACP on stdin and stdout; the
// Claude Code and Codex adapters are fetched by `npx` on first use, so nothing is installed globally.

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentPreset } from './protocol.js';

interface Preset {
  id: string;
  name: string;
  /** The program the user must already have; the preset is offered only when it is on PATH. */
  needs: string;
  command: string;
}

export const PRESETS: Preset[] = [
  { id: 'claude', name: 'Claude Code', needs: 'claude', command: 'npx -y @agentclientprotocol/claude-agent-acp' },
  { id: 'codex', name: 'Codex', needs: 'codex', command: 'npx -y @zed-industries/codex-acp' },
  { id: 'gemini', name: 'Gemini CLI', needs: 'gemini', command: 'gemini --acp' },
];

/** Whether an executable called `name` is in a directory of `pathVar`. */
export function onPath(name: string, pathVar: string | undefined = process.env.PATH): boolean {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/** The presets found on this machine, plus the `--agent` command when there is one. */
export function availableAgents(custom: string | undefined, pathVar?: string): AgentPreset[] {
  const found: AgentPreset[] = PRESETS.filter((p) => onPath(p.needs, pathVar)).map(({ id, name, command }) => ({ id, name, command }));
  if (custom !== undefined && !found.some((p) => p.command === custom)) found.unshift({ id: 'custom', name: 'Custom agent', command: custom });
  return found;
}
