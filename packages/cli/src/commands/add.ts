import { createInterface } from 'node:readline/promises';
import { CliError } from '../errors.js';
import { ITEM_TYPES, isItemName, type ItemType } from '../registry/item.js';
import { addItems, describeAdd, listItems } from '../registry/install.js';
import { openRegistry } from '../registry/source.js';
import type { Command } from './types.js';

/** A yes/no question on the terminal (stderr, so `--json` output stays clean); the answer is no unless it starts with y. */
async function ask(question: string): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y/i.test((await lines.question(`${question} [y/N] `)).trim());
  } finally {
    lines.close();
  }
}

export const add: Command = {
  name: 'add',
  summary: 'Install components, templates and tastes from the Kinetograph registry into this project (add --list shows them)',
  project: false,
  positionals: [{ name: 'name', description: 'One or more item names, e.g. title-card', optional: true, variadic: true }],
  options: [
    { name: 'list', type: 'boolean', description: 'List the registry instead of installing' },
    { name: 'type', type: 'string', description: `With --list, only this type: ${ITEM_TYPES.join(', ')}` },
    { name: 'overwrite', type: 'boolean', description: 'Replace files that already exist (by default they are skipped and reported)' },
    { name: 'yes', short: 'y', type: 'boolean', description: 'Install missing npm packages without asking. Without it, a terminal asks first; with --json it only prints the command' },
    { name: 'dir', type: 'string', description: 'The project folder (default: the current folder, or the nearest one above it with a package.json)' },
  ],
  async run(args, context) {
    const registry = openRegistry();
    const type = args.options.type;
    if (type !== undefined && !(ITEM_TYPES as readonly string[]).includes(String(type))) {
      throw new CliError('INVALID_ARG', `--type must be one of ${ITEM_TYPES.join(', ')}, got "${type}"`);
    }

    if (args.options.list === true) {
      const items = await listItems(registry, type as ItemType | undefined);
      const width = Math.max(0, ...items.map((i) => i.name.length));
      const text = items.length === 0 ? 'no items' : items.map((i) => `${i.name.padEnd(width)}  ${i.type.padEnd(9)}  ${i.title}${i.access === 'paid' ? '  (not published yet)' : ''}`).join('\n');
      return { data: { registry: registry.location, items }, text };
    }
    if (type !== undefined) throw new CliError('INVALID_ARG', '--type is for --list');

    const names = [...new Set(args.lists.name ?? [])];
    if (names.length === 0) throw new CliError('INVALID_ARG', 'give the name of an item to add, e.g. `kinetograph add title-card`, or --list to see them');
    for (const name of names) {
      if (!isItemName(name)) throw new CliError('INVALID_ARG', `"${name}" is not an item name (lowercase letters, digits and hyphens)`);
    }

    const interactive = !args.json && process.stdin.isTTY === true && process.stderr.isTTY === true;
    const result = await addItems({
      names,
      dir: String(args.options.dir ?? '.'),
      registry,
      overwrite: args.options.overwrite === true,
      yes: args.options.yes === true,
      ...(interactive ? { confirm: ask } : {}),
      progress: context.progress,
    });
    return { data: result, text: describeAdd(result), exitCode: result.dependencies.status === 'failed' ? 1 : 0 };
  },
};
