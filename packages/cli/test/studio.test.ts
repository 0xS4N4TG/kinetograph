import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';
import { setStudioForTests } from '../src/commands/studio.js';
import { toolCommands, toolName } from '../src/mcp.js';

afterEach(() => setStudioForTests(undefined));

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (s) => void out.push(s), err: (s) => void err.push(s) });
  return { code, out: out.join(''), err: err.join('') };
}

/** A stand-in studio that records how it was started and stops as soon as the command waits for it. */
function stubStudio() {
  const started: unknown[] = [];
  const closed = vi.fn(async () => undefined);
  setStudioForTests({
    load: async () => ({
      startStudio: async (options) => {
        started.push(options);
        return { url: 'http://127.0.0.1:4321/', close: closed };
      },
    }),
    waitForStop: async () => undefined,
  });
  return { started, closed };
}

describe('kinetograph studio', () => {
  it('is listed, with its options, in the help', async () => {
    expect((await cli('--help')).out).toMatch(/studio\s+Open the studio/);
    const help = (await cli('studio', '--help')).out;
    for (const flag of ['--port', '--host', '--no-open', '--props']) expect(help).toContain(flag);
    expect(help).toContain('<entry>');
  });

  it('is not an MCP tool', () => {
    expect(toolCommands().map(toolName)).not.toContain('studio');
    expect(toolCommands().map(toolName)).not.toContain('mcp');
  });

  it('starts the studio on the entry with the defaults, opens the browser, says the URL and stops it at the end', async () => {
    const { started, closed } = stubStudio();
    const r = await cli('studio', 'src/index.tsx');
    expect(r.code).toBe(0);
    expect(started).toEqual([{ entry: 'src/index.tsx', port: undefined, host: undefined, open: true, props: undefined, agent: undefined, allowRemoteAgent: false, log: expect.any(Function) }]);
    // Said once, when it started; nothing more when it stops.
    expect(r.out).toBe('kinetograph studio: http://127.0.0.1:4321/ (Ctrl-C to stop)\n');
    expect(closed).toHaveBeenCalledOnce();
  });

  it('passes the port, host, props and --no-open on', async () => {
    const { started } = stubStudio();
    const r = await cli('studio', 'a.tsx', '--port', '4000', '--host', '0.0.0.0', '--no-open', '--props', '{"title":"Hi"}');
    expect(r.code).toBe(0);
    expect(started).toEqual([{ entry: 'a.tsx', port: 4000, host: '0.0.0.0', open: false, props: { title: 'Hi' }, agent: undefined, allowRemoteAgent: false, log: expect.any(Function) }]);
  });

  it('prints the URL as JSON with --json', async () => {
    stubStudio();
    const r = await cli('studio', 'a.tsx', '--no-open', '--json');
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')[0]).toBe(JSON.stringify({ url: 'http://127.0.0.1:4321/' }));
  });

  it.each([
    [['studio'], /missing <entry>/],
    [['studio', 'a.tsx', '--port', 'many'], /--port must be a number/],
    [['studio', 'a.tsx', '--port', '70000'], /--port must be a whole number from 0 to 65535/],
    [['studio', 'a.tsx', '--port', '3.5'], /--port must be a whole number/],
    [['studio', 'a.tsx', '--props', '{nope'], /--props is not valid JSON/],
    [['studio', 'a.tsx', '--props', '[1]'], /--props must be a JSON object/],
    [['studio', 'a.tsx', '--host', ''], /--host/],
    [['studio', 'a.tsx', '--bogus'], /Unknown option/i],
    [['studio', 'a.tsx', 'b.tsx'], /unexpected argument "b.tsx"/],
  ])('refuses %j before starting anything', async (argv, message) => {
    const { started } = stubStudio();
    const r = await cli(...argv);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(message);
    expect(started).toEqual([]);
  });

  it('reports INVALID_ARG as JSON, and the studio’s own failure (a taken port) as it is', async () => {
    const bad = await cli('studio', 'a.tsx', '--port', 'x', '--json');
    expect(JSON.parse(bad.out)).toEqual({ error: { code: 'INVALID_ARG', message: expect.stringContaining('--port') } });

    setStudioForTests({
      load: async () => ({
        startStudio: async () => {
          throw Object.assign(new Error('port 3000 is already in use'), { code: 'INVALID_ARG' });
        },
      }),
    });
    const r = await cli('studio', 'a.tsx', '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ error: { code: 'INVALID_ARG', message: 'port 3000 is already in use' } });
  });
});
