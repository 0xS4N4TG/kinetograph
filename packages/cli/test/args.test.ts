import { describe, expect, it } from 'vitest';
import { parseCommandArgs, parseFrameList, whole } from '../src/args.js';
import { CliError } from '../src/errors.js';
import { findCommand } from '../src/commands/index.js';
import { allOptions } from '../src/commands/types.js';

function spec(name: string) {
  const { command } = findCommand(name.split(' '))!;
  return { name: command.name, positionals: command.positionals, options: allOptions(command) };
}

describe('parseCommandArgs', () => {
  it('reads positionals, numbers, short and long options and --json', () => {
    const args = parseCommandArgs(spec('strip'), ['proj.tsx', '-n', '8', '-o', 'sheet.png', '--comp', 'Main', '--json']);
    expect(args.positionals).toEqual({ entry: 'proj.tsx' });
    expect(args.options).toEqual({ count: 8, output: 'sheet.png', comp: 'Main' });
    expect(args.json).toBe(true);
  });

  it('converts a numeric positional', () => {
    const args = parseCommandArgs(spec('still'), ['proj.tsx', '30', '-o', 'a.png']);
    expect(args.positionals.frame).toBe(30);
    expect(args.json).toBe(false);
  });

  it('keeps a negative number as a positional instead of an unknown option', () => {
    const args = parseCommandArgs(spec('still'), ['proj.tsx', '-1', '-o', 'a.png']);
    expect(args.positionals.frame).toBe(-1);
  });

  it('refuses a positional that is not a number', () => {
    expect(() => parseCommandArgs(spec('still'), ['proj.tsx', 'soon'])).toThrow(/frame must be a number/);
  });

  it('refuses unknown options, missing and extra positionals with INVALID_ARG and the usage', () => {
    for (const argv of [['x.json', '3', '--bogus'], ['x.json'], ['x.json', '3', 'extra']]) {
      try {
        parseCommandArgs(spec('still'), argv);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).code).toBe('INVALID_ARG');
        expect((error as CliError).message).toContain('usage: kinetograph still <entry> <frame>');
      }
    }
  });

  it('collects a repeated option into a list (track --point)', () => {
    const args = parseCommandArgs(spec('track'), ['clip.mp4', '--point', '10,20', '--point', 'b=30,40', '--pattern', '31']);
    expect(args.positionals.video).toBe('clip.mp4');
    expect(args.options.point).toEqual(['10,20', 'b=30,40']);
    expect(args.options.pattern).toBe(31);
  });

  it('takes the two-word audio analyze command', () => {
    const found = findCommand(['audio', 'analyze', 'p.tsx', '--scenes', '0..30']);
    expect(found?.command.name).toBe('audio analyze');
    expect(found?.rest).toEqual(['p.tsx', '--scenes', '0..30']);
    expect(findCommand(['audio'])).toBeUndefined();
  });

  it('gives every project command --comp and --props, and no other command', () => {
    for (const name of ['compositions', 'still', 'render', 'strip', 'onion', 'inspect', 'lint', 'bench', 'audio analyze', 'snapshot']) {
      const options = spec(name).options.map((o) => o.name);
      if (name === 'compositions') expect(options).not.toContain('comp');
      else expect(options).toEqual(expect.arrayContaining(['comp', 'props']));
    }
    expect(spec('effects').options).toEqual([]);
  });
});

describe('whole and parseFrameList', () => {
  it('checks whole numbers', () => {
    expect(whole('-n', undefined, 1, 12)).toBe(12);
    expect(() => whole('-n', 0, 1)).toThrow(/at least 1/);
    expect(() => whole('-n', 2.5, 1)).toThrow(/whole number/);
  });
  it('parses frame lists', () => {
    expect(parseFrameList('--frames', '0,30, 60')).toEqual([0, 30, 60]);
    expect(() => parseFrameList('--frames', '0,x')).toThrow(/comma-separated/);
    expect(() => parseFrameList('--frames', '-3')).toThrow(/comma-separated/);
  });
});
