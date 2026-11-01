import { describe, expect, it } from 'vitest';

import type { ToolItem } from '../src/lib/tool-summary';
import { commandLine, displayPath, formatDuration, groupLabel, middleTruncate, stripAnsi, stripCd, summarize } from '../src/lib/tool-summary';

const ctx = { cwd: '/Users/me/proj', home: '/Users/me' };
let n = 0;
const tool = (over: Partial<ToolItem>): ToolItem => ({ kind: 'tool', id: ++n, toolId: `t${n}`, title: '', toolKind: 'other', status: 'completed', files: [], ...over });

describe('commands', () => {
  it('drops a leading cd with && or ;, however it is quoted, and keeps the rest', () => {
    expect(stripCd('cd /Users/me/proj && npm test')).toBe('npm test');
    expect(stripCd('cd "/Users/me/my proj"; ls -la')).toBe('ls -la');
    expect(stripCd("cd '/a' && cd /b && git status")).toBe('git status');
    expect(stripCd('cd /a')).toBe('cd /a');
    expect(stripCd('echo cd /a && ls')).toBe('echo cd /a && ls');
  });

  it('writes the project as . and the home directory as ~, but not a sibling that shares the prefix', () => {
    expect(commandLine('cd /Users/me/proj && cat /Users/me/proj/src/a.ts /Users/me/.zshrc /Users/me/proj2/x', ctx)).toBe('cat ./src/a.ts ~/.zshrc ~/proj2/x');
    expect(commandLine('ls /Users/me/proj', ctx)).toBe('ls .');
    expect(commandLine('git -C "/Users/me/proj" log\n  --oneline', ctx)).toBe('git -C "." log --oneline');
  });

  it('shows a path relative to the project, or from ~, or as it is', () => {
    expect(displayPath('/Users/me/proj/src/a.ts', ctx)).toBe('src/a.ts');
    expect(displayPath('/Users/me/notes.md', ctx)).toBe('~/notes.md');
    expect(displayPath('src/a.ts', ctx)).toBe('src/a.ts');
    expect(displayPath('/etc/hosts', ctx)).toBe('/etc/hosts');
  });

  it('strips colour and cursor codes from output', () => {
    expect(stripAnsi('\u001b[31mfail\u001b[0m \u001b[2K\u001b[1Gok \u001b]0;title\u0007done')).toBe('fail ok done');
  });

  it('shortens a path in the middle and keeps the file name', () => {
    const long = '/Users/me/proj/packages/studio/ui/src/components/agent/agent-panel.tsx';
    const short = middleTruncate(long, 40);
    expect(short).toHaveLength(40);
    expect(short).toContain('…');
    expect(short.endsWith('agent-panel.tsx')).toBe(true);
    expect(short.startsWith('/Users/')).toBe(true);
    expect(middleTruncate('src/a.ts', 40)).toBe('src/a.ts');
  });

  it('formats durations', () => {
    expect(formatDuration(340)).toBe('340ms');
    expect(formatDuration(1234)).toBe('1.2s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});

describe('the one-line summary of each kind', () => {
  it('execute: the command without cd, in monospace', () => {
    const s = summarize(tool({ toolKind: 'execute', title: 'cd /Users/me/proj && npm test', input: { command: 'cd /Users/me/proj && npm test' } }), ctx);
    expect(s).toMatchObject({ verb: '', text: 'npm test', mono: true });
  });

  it('execute: the agent\'s description when the title says more than the command', () => {
    const s = summarize(tool({ toolKind: 'execute', title: 'Run the unit tests', input: { command: 'cd /Users/me/proj && npm test' } }), ctx);
    expect(s).toMatchObject({ text: 'Run the unit tests', mono: false });
    expect(summarize(tool({ toolKind: 'execute', title: 'x', input: { command: 'npm test', description: 'Run tests in ~/proj' } }), ctx).text).toBe('Run tests in ~/proj');
  });

  it('execute without input falls back to the title as a command', () => {
    expect(summarize(tool({ toolKind: 'execute', title: 'cd /Users/me/proj; ls /Users/me/proj/src' }), ctx)).toMatchObject({ text: 'ls ./src', mono: true });
  });

  it('read and edit: the relative path; an edit adds the line counts', () => {
    expect(summarize(tool({ toolKind: 'read', title: 'Read /Users/me/proj/src/a.ts', files: ['src/a.ts'] }), ctx)).toMatchObject({ verb: 'Read', text: 'src/a.ts', isPath: true });
    const edit = summarize(tool({ toolKind: 'edit', files: ['src/a.ts'], diffs: [{ path: 'src/a.ts', added: 4, removed: 1, lines: [] }, { path: 'src/b.ts', added: 2, removed: 0, lines: [] }] }), ctx);
    expect(edit).toMatchObject({ verb: 'Edit', text: 'src/a.ts', added: 6, removed: 1 });
    expect(summarize(tool({ toolKind: 'delete', files: ['a.txt', 'b.txt'] }), ctx).text).toBe('a.txt +1 more');
    expect(summarize(tool({ toolKind: 'move', files: ['/Users/me/proj/a', '/Users/me/proj/b'] }), ctx).text).toBe('a → b');
  });

  it('search, fetch, think and other', () => {
    expect(summarize(tool({ toolKind: 'search', title: 'grep', input: { pattern: 'TODO\\(' } }), ctx)).toMatchObject({ verb: 'Search', text: 'TODO\\(', mono: true });
    expect(summarize(tool({ toolKind: 'fetch', input: { url: 'https://example.com/docs' } }), ctx)).toMatchObject({ verb: 'Fetch', text: 'example.com/docs' });
    expect(summarize(tool({ toolKind: 'think', title: '' }), ctx).text).toBe('Thinking');
    expect(summarize(tool({ toolKind: 'other', title: 'Use skill in /Users/me/proj/x' }), ctx).text).toBe('Use skill in ./x');
    expect(summarize(tool({ toolKind: 'other', title: '' }), ctx).text).toBe('Working');
  });
});

describe('the label of a group', () => {
  it('counts by kind in the order they appear', () => {
    const t = (toolKind: string) => tool({ toolKind });
    expect(groupLabel([t('execute'), t('read'), t('execute'), t('execute'), t('read')])).toBe('Ran 3 commands · read 2 files');
    expect(groupLabel([t('read')])).toBe('Read 1 file');
    expect(groupLabel([t('edit'), t('search'), t('other')])).toBe('Edited 1 file · ran 1 search · used 1 tool');
  });
});
