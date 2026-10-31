import { findPlugins, pluginToolNames } from '../plugins.js';
import type { Command } from './types.js';

export const plugins: Command = {
  name: 'plugins',
  summary: "List the Kinetograph plugins the project depends on, with the path of each one's SKILL.md",
  project: false,
  positionals: [{ name: 'project', description: 'A project file or directory (default: the current directory)', optional: true }],
  options: [],
  async run(args) {
    const list = [];
    for (const p of findPlugins(String(args.positionals.project ?? '.'))) {
      const tools = await pluginToolNames(p, (message) => process.stderr.write(`${message}\n`));
      list.push({ name: p.name, version: p.version, title: p.title, description: p.description, icon: p.iconFile, components: p.components, skill: p.skill, hasPanel: p.panelFile !== null, tools });
    }
    const text = list
      .map((p) => `${p.name}@${p.version}  skill: ${p.skill ?? 'none'}  panel: ${p.hasPanel ? 'yes' : 'no'}  tools: ${p.tools.join(', ') || 'none'}`)
      .join('\n');
    return { data: { plugins: list }, text: text || '(no Kinetograph plugins installed)' };
  },
};
