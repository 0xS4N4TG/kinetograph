import { describe, expect, it } from 'vitest';
import { withConsoleOnStderr } from '../src/json-console.js';

describe('a --json command', () => {
  it('has what the page logs on stderr, so stdout holds the JSON alone, and puts console back', async () => {
    const err: string[] = [];
    const before = console.log;
    const result = await withConsoleOnStderr({ err: (text) => err.push(text) }, async () => {
      console.log('LiquidGlass: WebGPU renderer initialized');
      console.info('a %s', 'note');
      console.debug({ a: 1 });
      return 7;
    });
    expect(result).toBe(7);
    expect(err).toEqual(['LiquidGlass: WebGPU renderer initialized\n', 'a note\n', '{ a: 1 }\n']);
    expect(console.log).toBe(before);
  });

  it('puts console back when the work throws', async () => {
    const before = console.log;
    await expect(
      withConsoleOnStderr({ err: () => {} }, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(console.log).toBe(before);
  });
});
