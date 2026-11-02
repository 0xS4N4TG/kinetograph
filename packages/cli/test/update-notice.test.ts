import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';
import { createMcpServer } from '../src/mcp.js';
import { setNativeForTests } from '../src/native.js';
import { compareVersions, findInstalledSkills, isNewer, skillVersion, updateCachePath } from '../src/update-notice.js';
import { cliVersion } from '../src/version.js';
import { fakeNative } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const VERSION = cliVersion();
const SKILLS_LINE = (oldest: string | null) =>
  `Your Kinetograph agent skills ${oldest === null ? 'have no version stamp' : `are ${oldest}`} and the CLI is ${VERSION}: update them with npx skills add 0xS4N4TG/kinetograph`;
const CLI_LINE = `kinetograph 99.0.0 is out (you have ${VERSION}): npm install kinetograph@latest`;

const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-update-test-'));

function writeSkill(root: string, name: string, version: string | null, extra = ''): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const meta = version === null ? '' : `metadata:\n  version: "${version}"\n`;
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n${meta}${extra}---\n# ${name}\n`);
  return dir;
}

let home: string;
let project: string;
let fetchMock: ReturnType<typeof vi.fn>;

const registry = (version: string) => async () => new Response(JSON.stringify({ name: 'kinetograph', version }), { status: 200 });
const writeCache = (cache: object): void => {
  mkdirSync(dirname(updateCachePath()), { recursive: true });
  writeFileSync(updateCachePath(), JSON.stringify(cache));
};
const readCache = (): any => JSON.parse(readFileSync(updateCachePath(), 'utf8'));

beforeEach(() => {
  home = scratch();
  project = scratch();
  // The notices are on for these tests (the suite turns them off), against an empty home and a fake registry.
  vi.stubEnv('KINETOGRAPH_NO_UPDATE_CHECK', '');
  vi.stubEnv('CI', '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  vi.stubEnv('CODEX_HOME', '');
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  fetchMock = vi.fn(registry(VERSION));
  vi.stubGlobal('fetch', fetchMock);
  setNativeForTests(fakeNative().native);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function cli(...argv: string[]): Promise<{ code: number; json: any; text: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (s) => void out.push(s), err: (s) => void err.push(s) });
  const text = out.join('');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { code, json, text, err: err.join('') };
}

describe('versions', () => {
  it('compares by semver', () => {
    expect(compareVersions('0.2.5', '0.2.5')).toBe(0);
    expect(compareVersions('0.2.5', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('1.0.0+build', '1.0.0')).toBe(0);
    expect(() => compareVersions('latest', '1.0.0')).toThrow();
  });

  it('ignores a prerelease unless the running version is one', () => {
    expect(isNewer('0.3.1', '0.3.0')).toBe(true);
    expect(isNewer('0.3.0', '0.3.0')).toBe(false);
    expect(isNewer('0.2.9', '0.3.0')).toBe(false);
    expect(isNewer('0.4.0-beta.1', '0.3.0')).toBe(false);
    expect(isNewer('0.4.0-beta.2', '0.4.0-beta.1')).toBe(true);
    expect(isNewer('0.4.0', '0.4.0-beta.1')).toBe(true);
    expect(isNewer('nonsense', '0.3.0')).toBe(false);
  });
});

describe('the skill version stamp', () => {
  it('reads metadata.version from the frontmatter', () => {
    expect(skillVersion('---\nname: a\nmetadata:\n  version: "1.2.3"\n---\nbody')).toBe('1.2.3');
    expect(skillVersion("---\nname: a\nmetadata:\n  author: me\n  version: '1.2.3'\n---\n")).toBe('1.2.3');
    expect(skillVersion('---\nname: a\n---\nmetadata:\n  version: "9.9.9"\n')).toBeNull();
    expect(skillVersion('---\nname: a\nmetadata:\n  author: me\n---\n')).toBeNull();
    expect(skillVersion('no frontmatter')).toBeNull();
  });
});

describe('finding installed skills', () => {
  it('finds user and project installs, follows symlinks once, and reads a missing stamp as null', () => {
    const canonical = join(home, '.agents', 'skills');
    writeSkill(canonical, 'kinetograph', '0.1.0');
    // Another agent's folder links to the canonical copy: one skill, not two.
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(canonical, 'kinetograph'), join(home, '.claude', 'skills', 'kinetograph'));
    writeSkill(join(home, '.codex', 'skills'), 'kinetograph-migrate', null);
    writeSkill(join(project, '.claude', 'skills'), 'kinetograph', VERSION);
    writeSkill(join(project, '.claude', 'skills'), 'unrelated', '0.0.1');

    const found = findInstalledSkills(project);
    expect(found.map((s) => [s.name, s.version]).sort()).toEqual([
      ['kinetograph', '0.1.0'],
      ['kinetograph', VERSION],
      ['kinetograph-migrate', null],
    ]);
  });

  it('looks in the folders above the working directory, and finds nothing in an empty home', () => {
    expect(findInstalledSkills(project)).toEqual([]);
    const nested = join(project, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeSkill(join(project, '.agents', 'skills'), 'kinetograph', '0.0.1');
    expect(findInstalledSkills(nested).map((s) => s.version)).toEqual(['0.0.1']);
  });
});

describe('the CLI notice', () => {
  it('asks the registry once, with nothing but the URL, and prints one stderr line', async () => {
    fetchMock.mockImplementation(registry('99.0.0'));
    const r = await cli('effects');
    expect(r.code).toBe(0);
    expect(r.text).toContain('dropShadow:');
    expect(r.err).toBe(`${CLI_LINE}\n`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://registry.npmjs.org/kinetograph/latest');
    expect(Object.keys(init).sort()).toEqual(['signal']);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(readCache()).toMatchObject({ latest: '99.0.0' });
  });

  it('does not ask again within a day, and does not repeat the notice', async () => {
    fetchMock.mockImplementation(registry('99.0.0'));
    expect((await cli('effects')).err).toBe(`${CLI_LINE}\n`);
    expect((await cli('effects')).err).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a cached answer without asking, and asks again after a day', async () => {
    writeCache({ checkedAt: Date.now() - 3600_000, latest: '99.0.0' });
    expect((await cli('effects')).err).toBe(`${CLI_LINE}\n`);
    expect(fetchMock).not.toHaveBeenCalled();

    writeCache({ checkedAt: Date.now() - DAY - 1000, latest: '99.0.0', notifiedAt: Date.now() - DAY - 1000 });
    fetchMock.mockImplementation(registry('98.0.0'));
    const r = await cli('effects');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.err).toBe(`kinetograph 98.0.0 is out (you have ${VERSION}): npm install kinetograph@latest\n`);
  });

  it('is silent when the latest is not newer', async () => {
    expect((await cli('effects')).err).toBe('');
    fetchMock.mockImplementation(registry('0.0.1'));
    writeCache({});
    expect((await cli('effects')).err).toBe('');
  });

  it('is silent when the registry fails, answers badly or is slow, and the command is not held up', async () => {
    for (const failing of [
      async () => {
        throw new TypeError('fetch failed');
      },
      async () => new Response('nope', { status: 503 }),
      async () => new Response('<html>', { status: 200 }),
      async () => new Response(JSON.stringify({ version: 'latest' }), { status: 200 }),
      () => new Promise<Response>(() => undefined), // never answers; the 1.5 s timeout would end it
    ]) {
      writeCache({});
      fetchMock.mockImplementation(failing);
      const r = await cli('effects', '--json');
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      expect(r.json.effects.length).toBeGreaterThan(0);
      expect(r.json.notices).toBeUndefined();
    }
    // The last one never answered: let the 1.5 s timeout end it before the next test.
    await new Promise((done) => setTimeout(done, 1700));
  });

  it('remembers a failed try, so a down registry is not asked on every command', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    await cli('effects');
    await cli('effects');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(updateCachePath())).toBe(true);
  });

  it('shows the line and a notices field with --json, and keeps stdout one JSON object', async () => {
    fetchMock.mockImplementation(registry('99.0.0'));
    const r = await cli('effects', '--json');
    expect(r.json.notices).toEqual([CLI_LINE]);
    expect(r.json.effects.length).toBeGreaterThan(0);
    expect(r.err).toBe(`${CLI_LINE}\n`);
    expect(r.text.trim().split('\n')).toHaveLength(1);
  });

  it('also reaches an agent that reads a failed command', async () => {
    fetchMock.mockImplementation(registry('99.0.0'));
    const r = await cli('effects', '--bogus', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('INVALID_ARG');
    expect(r.json.notices).toEqual([CLI_LINE]);
  });

  it('shows it with stderr captured: no TTY is needed', async () => {
    fetchMock.mockImplementation(registry('99.0.0'));
    expect(process.stderr.isTTY).not.toBe(true);
    expect((await cli('effects')).err).toBe(`${CLI_LINE}\n`);
  });
});

describe('the skills notice', () => {
  it('names the oldest stamp, then stays quiet for that folder for a day', async () => {
    writeSkill(join(home, '.agents', 'skills'), 'kinetograph', '0.1.0');
    writeSkill(join(home, '.agents', 'skills'), 'kinetograph-migrate', '0.2.0');
    const r = await cli('effects');
    expect(r.err).toBe(`${SKILLS_LINE('0.1.0')}\n`);
    expect((await cli('effects')).err).toBe('');

    // A day on, it is shown again.
    const cache = readCache();
    writeCache({ ...cache, skillNotified: { [join(home, '.agents', 'skills')]: Date.now() - DAY - 1000 } });
    expect((await cli('effects')).err).toBe(`${SKILLS_LINE('0.1.0')}\n`);
  });

  it('says so when a skill has no version stamp', async () => {
    writeSkill(join(project, '.claude', 'skills'), 'kinetograph', null);
    expect((await cli('effects')).err).toBe(`${SKILLS_LINE(null)}\n`);
  });

  it('counts each folder on its own', async () => {
    writeSkill(join(home, '.agents', 'skills'), 'kinetograph', '0.1.0');
    expect((await cli('effects')).err).toBe(`${SKILLS_LINE('0.1.0')}\n`);
    writeSkill(join(project, '.claude', 'skills'), 'kinetograph', '0.1.5');
    expect((await cli('effects')).err).toBe(`${SKILLS_LINE('0.1.5')}\n`);
  });

  it('is silent for current skills, and for newer ones', async () => {
    writeSkill(join(home, '.agents', 'skills'), 'kinetograph', VERSION);
    writeSkill(join(home, '.claude', 'skills'), 'kinetograph-migrate', '99.0.0');
    expect((await cli('effects')).err).toBe('');
  });

  it('adds both notices to the --json result', async () => {
    fetchMock.mockImplementation(registry('99.0.0'));
    writeSkill(join(home, '.agents', 'skills'), 'kinetograph', '0.1.0');
    const r = await cli('effects', '--json');
    expect(r.json.notices).toEqual([CLI_LINE, SKILLS_LINE('0.1.0')]);
    expect(r.err).toBe(`${CLI_LINE}\n${SKILLS_LINE('0.1.0')}\n`);
  });
});

describe('when to stay quiet', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(registry('99.0.0'));
    writeSkill(join(home, '.agents', 'skills'), 'kinetograph', '0.1.0');
  });

  const silent = async (): Promise<void> => {
    for (const argv of [['effects'], ['effects', '--json']]) {
      const r = await cli(...argv);
      expect(r.err, argv.join(' ')).toBe('');
      expect(r.json?.notices).toBeUndefined();
      expect(r.code).toBe(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(updateCachePath())).toBe(false);
  };

  it('when CI is set', async () => {
    vi.stubEnv('CI', 'true');
    await silent();
    vi.stubEnv('CI', '1');
    await silent();
  });

  it('when CI is 0, false or empty, it is not CI', async () => {
    for (const value of ['0', 'false', '']) {
      vi.stubEnv('CI', value);
      expect((await cli('effects')).err).not.toBe('');
      writeCache({});
    }
  });

  it('with KINETOGRAPH_NO_UPDATE_CHECK=1', async () => {
    vi.stubEnv('KINETOGRAPH_NO_UPDATE_CHECK', '1');
    await silent();
  });

  it('for --help, --version and help', async () => {
    for (const argv of [['effects', '--help'], ['--version'], ['--help'], ['help']]) expect((await cli(...argv)).err).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the MCP server', () => {
  async function connect(notices?: { collect(): Promise<string[]> }): Promise<Client> {
    const server = createMcpServer(async () => ({ stdout: '{"ok":true}', stderr: '', code: 0 }), [], undefined, notices);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }
  const parts = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { type: string; text: string }[]).map((c) => c.text);

  it('puts the notices in the first tool result only', async () => {
    const collect = vi.fn(async () => ['one', 'two']);
    const client = await connect({ collect });
    const first = parts(await client.callTool({ name: 'effects', arguments: {} }));
    expect(first).toHaveLength(2);
    expect(JSON.parse(first[0]!)).toEqual({ ok: true });
    expect(first[1]).toBe('one\ntwo');
    expect(parts(await client.callTool({ name: 'effects', arguments: {} }))).toHaveLength(1);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('adds nothing when there is no notice or no session', async () => {
    expect(parts(await (await connect({ collect: async () => [] })).callTool({ name: 'effects', arguments: {} }))).toHaveLength(1);
    expect(parts(await (await connect()).callTool({ name: 'effects', arguments: {} }))).toHaveLength(1);
  });
});

describe('doctor', () => {
  it('reports the CLI and every installed skill, in --json and in text', async () => {
    fetchMock.mockImplementation(registry('99.0.0'));
    writeSkill(join(home, '.agents', 'skills'), 'kinetograph', '0.1.0');
    writeSkill(join(project, '.claude', 'skills'), 'kinetograph-migrate', VERSION);
    const r = await cli('doctor', '--json');
    expect(r.json.cli).toEqual({ version: VERSION, latest: '99.0.0', current: false, checkedAt: expect.any(Number) });
    expect(r.json.skills).toEqual(
      expect.arrayContaining([
        { name: 'kinetograph', path: join(home, '.agents', 'skills', 'kinetograph'), version: '0.1.0', current: false },
        { name: 'kinetograph-migrate', path: join(project, '.claude', 'skills', 'kinetograph-migrate'), version: VERSION, current: true },
      ]),
    );
    expect(r.json.skills).toHaveLength(2);

    const text = await cli('doctor');
    expect(text.text).toContain(CLI_LINE);
    expect(text.text).toContain('skill kinetograph: 0.1.0, out of date');
    expect(text.text).toContain(`skill kinetograph-migrate: ${VERSION}, current`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports with the notices off: no request, the cached latest, and the skills', async () => {
    vi.stubEnv('KINETOGRAPH_NO_UPDATE_CHECK', '1');
    vi.stubEnv('CI', 'true');
    writeCache({ checkedAt: Date.now() - 5 * DAY, latest: VERSION });
    const r = await cli('doctor', '--json');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.json.cli).toMatchObject({ version: VERSION, latest: VERSION, current: true });
    expect(r.json.skills).toEqual([]);
    expect(r.err).toBe('');
  });

  it('says the latest is unknown when nothing is cached and the registry is down', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    const r = await cli('doctor', '--json');
    expect(r.json.cli).toMatchObject({ version: VERSION, latest: null, current: null });
    expect((await cli('doctor')).text).toContain('latest version unknown');
  });
});
