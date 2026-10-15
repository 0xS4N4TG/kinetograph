import { audioAnalyze } from './audio.js';
import { bench } from './bench.js';
import { compositions, effects } from './basic.js';
import { doctor } from './doctor.js';
import { inspect, lint } from './check.js';
import { mcp } from './mcp.js';
import { render, still } from './render.js';
import { onion, strip } from './sheets.js';
import { snapshot } from './snapshot.js';
import { studio } from './studio.js';
import type { Command } from './types.js';

/** Every command, in the order of docs/AUTHORING.md §9. */
export const commands: Command[] = [
  compositions,
  still,
  render,
  strip,
  onion,
  inspect,
  lint,
  bench,
  audioAnalyze,
  snapshot,
  effects,
  doctor,
  studio,
  mcp,
];

export function findCommand(argv: string[]): { command: Command; rest: string[] } | undefined {
  const [first, second] = argv;
  if (first === undefined) return undefined;
  const two = commands.find((c) => c.name === `${first} ${second}`);
  if (two) return { command: two, rest: argv.slice(2) };
  const one = commands.find((c) => c.name === first);
  return one ? { command: one, rest: argv.slice(1) } : undefined;
}

export type { Command } from './types.js';
