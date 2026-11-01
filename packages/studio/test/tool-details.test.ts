import { describe, expect, it } from 'vitest';
import { cutOutput, lineDiff, toolDiffs, toolInput, toolOutput } from '../src/tool-details.js';

describe('what a tool call shows', () => {
  it('keeps the fields of the input that say what it does, whatever the agent calls them', () => {
    expect(toolInput({ command: 'ls', description: 'List', timeout: 5 })).toEqual({ command: 'ls', description: 'List' });
    expect(toolInput({ file_path: '/a/b.ts' })).toEqual({ path: '/a/b.ts' });
    expect(toolInput({ pattern: 'TODO', path: 'src' })).toEqual({ pattern: 'TODO', path: 'src' });
    expect(toolInput({ query: 'rust' })).toEqual({ pattern: 'rust' });
    expect(toolInput({ command: ['git', 'status'] })).toEqual({ command: 'git status' });
    expect(toolInput({ url: 'https://example.com' })).toEqual({ url: 'https://example.com' });
    expect(toolInput('ls')).toBeUndefined();
    expect(toolInput({})).toBeUndefined();
    expect(toolInput({ command: 'x'.repeat(9000) })!.command).toHaveLength(4000);
  });

  it('takes the output from the text content, else from the raw output, and cuts a long one in the middle', () => {
    expect(toolOutput([{ type: 'content', content: { type: 'text', text: 'hi' } }], 'ignored')).toBe('hi');
    expect(toolOutput(null, { stdout: 'out', stderr: 'err' })).toBe('out\nerr');
    expect(toolOutput(null, 'plain')).toBe('plain');
    expect(toolOutput([], null)).toBeUndefined();
    const long = `${'a'.repeat(5000)}${'b'.repeat(5000)}`;
    const cut = cutOutput(long);
    expect(cut.length).toBeLessThan(long.length);
    expect(cut).toContain('2000 characters left out');
    expect(cut.endsWith('b'.repeat(5000))).toBe(true);
  });

  it('counts a diff and keeps two lines of context around each change', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const next = old.replace('line 3', 'LINE 3').replace('line 15\n', 'line 15\nextra\n');
    const diff = lineDiff(old, next);
    expect(diff).toMatchObject({ added: 2, removed: 1 });
    expect(diff.lines).toContain('-line 3');
    expect(diff.lines).toContain('+LINE 3');
    expect(diff.lines).toContain('+extra');
    expect(diff.lines).toContain(' …');
    expect(diff.lines).not.toContain(' line 9');
    expect(lineDiff(null, 'a\nb\n')).toEqual({ added: 2, removed: 0, lines: ['+a', '+b'] });
    expect(lineDiff('same\n', 'same\n')).toMatchObject({ added: 0, removed: 0 });
  });

  it('makes diff paths relative to the project and ignores other content', () => {
    const out = toolDiffs('/proj', [
      { type: 'diff', path: '/proj/src/a.ts', oldText: 'x', newText: 'y' },
      { type: 'content', content: { type: 'text', text: 'hi' } },
    ]);
    expect(out).toEqual([{ path: 'src/a.ts', added: 1, removed: 1, lines: ['-x', '+y'] }]);
    expect(toolDiffs('/proj', undefined)).toBeUndefined();
  });
});
