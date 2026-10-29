import { findPlugins } from '../plugins.js';
import type { Command } from './types.js';

export const plugins: Command = {
  name: 'plugins',
  summary: "List the Kinetograph plugins the project depends on, with the path of each one's SKILL.md",
  project: false,
  positionals: [{ name: 'project', description: 'A project file or directory (default: the current directory)', optional: true }],
  options: [],
  async run(args) {
    const list = findPlugins(String(args.positionals.project ?? '.')).map(({ name, version, skill, panelFile }) => ({
      name,
      version,
      skill,
      hasPanel: panelFile !== null,
    }));
    const text = list
      .map((p) => `${p.name}@${p.version}  skill: ${p.skill ?? 'none'}  panel: ${p.hasPanel ? 'yes' : 'no'}`)
      .join('\n');
    return { data: { plugins: list }, text: text || '(no Kinetograph plugins installed)' };
  },
};
