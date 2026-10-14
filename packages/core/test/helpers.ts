import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { Easing, type EasingFunction } from '../src/easing.js';

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

/** Builds an easing from the spec strings the fixtures use: `inOut(elastic(2))`, `bezier(0.25,0.1,0.25,1)`. */
export function easingFromSpec(spec: string): EasingFunction {
  const match = /^(\w+)(?:\((.*)\))?$/.exec(spec);
  if (!match) throw new Error(`bad easing spec ${spec}`);
  const [, name, argText] = match;
  const make = (Easing as any)[name!];
  if (argText === undefined) return make;
  if (argText === '') return make();
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of argText) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
    } else current += ch;
  }
  args.push(current);
  return make(...args.map((a) => (/^-?[\d.]+$/.test(a) ? Number(a) : easingFromSpec(a))));
}

/** Equal to `digits` decimal places, treating NaN as equal to a JSON `null`. */
export function expectClose(actual: number, expected: number | null, tolerance = 1e-9, context = ''): void {
  if (expected === null) {
    expect(Number.isFinite(actual), context).toBe(false);
    return;
  }
  const scale = Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected) / scale, `${context}: got ${actual}, expected ${expected}`).toBeLessThanOrEqual(
    tolerance,
  );
}
