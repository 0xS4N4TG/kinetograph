// Update notices: a newer `kinetograph` on npm, and agent skills installed by `npx kinetograph skills update` (or `npx skills add`) that are older than the CLI.
// The only network request is one GET of the registry's `latest` for this package, at most once a day, with no data of
// the user's. Nothing is ever installed or updated from here. The result and the times notices were shown are kept in
// `~/.cache/kinetograph/update-check.json`. Quiet when `CI` is set or `KINETOGRAPH_NO_UPDATE_CHECK=1`.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = 'https://registry.npmjs.org/kinetograph/latest';
const TIMEOUT_MS = 1500;
/** The skills in packages/cli/skills; packages/cli/test/skill-stamp.test.ts keeps this equal to the folders. */
export const SKILL_NAMES = [
  'kinetograph',
  'kinetograph-create',
  'kinetograph-markup',
  'kinetograph-studio',
  'kinetograph-render',
  'kinetograph-docs',
  'kinetograph-upgrade',
  'kinetograph-migrate',
];
export const SKILLS_UPDATE_COMMAND = 'npx kinetograph skills update';
/** Ends each notice, so an agent whose skills predate the notice rule still asks the user. */
export const AGENT_HINT = ' (coding agents: tell the user and ask first)';

interface Version {
  core: [number, number, number];
  pre: string[];
}

export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] === undefined ? [] : match[4].split('.') };
}

/** Semver order: negative when `a` is older than `b`. Throws on text that is not a version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1;
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether `latest` is an update for `current`. A prerelease is ignored unless `current` is one too. */
export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  if (l.pre.length > 0 && c.pre.length === 0) return false;
  return compareVersions(latest, current) > 0;
}

/** True when no notice may be shown or checked for: `CI` set (other than 0 or false) or `KINETOGRAPH_NO_UPDATE_CHECK=1`. */
export function updateChecksOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI;
  return env.KINETOGRAPH_NO_UPDATE_CHECK === '1' || (ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false');
}

// ---- the cache file ----

interface UpdateCache {
  /** When the registry was last asked (ms), whether or not it answered. */
  checkedAt?: number;
  /** The newest version the registry has answered with. */
  latest?: string;
  /** When the CLI notice was last shown. */
  notifiedAt?: number;
  /** When the skills notice was last shown, per install location. */
  skillNotified?: Record<string, number>;
}

/** `~/.cache/kinetograph/update-check.json`, beside the font and sound caches. */
export function updateCachePath(): string {
  return join(homedir(), '.cache', 'kinetograph', 'update-check.json');
}

function readCache(): UpdateCache {
  try {
    const parsed: unknown = JSON.parse(readFileSync(updateCachePath(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as UpdateCache) : {};
  } catch {
    return {};
  }
}

function writeCache(patch: UpdateCache): void {
  try {
    const file = updateCachePath();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...readCache(), ...patch }));
    renameSync(tmp, file);
  } catch {
    // A cache that cannot be written only means the next command asks again.
  }
}

const isFresh = (checkedAt: number | undefined, now: number): boolean => checkedAt !== undefined && now - checkedAt >= 0 && now - checkedAt < DAY_MS;

// ---- the registry ----

let inflight: Promise<string | null> | undefined;

/** Asks the registry for the latest version and caches the answer. Null when it cannot be reached; never throws. */
export function checkLatest(): Promise<string | null> {
  inflight ??= (async () => {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    // The abort ends a request that is still open; the race ends the wait even for a fetch that ignores the abort.
    const timeout = new Promise<null>((done) => {
      timer = setTimeout(() => {
        abort.abort();
        done(null);
      }, TIMEOUT_MS);
      timer.unref();
    });
    const ask = async (): Promise<string | null> => {
      try {
        const response = await globalThis.fetch(REGISTRY_URL, { signal: abort.signal });
        if (!response.ok) return null;
        const body = (await response.json()) as { version?: unknown };
        return typeof body.version === 'string' && parseVersion(body.version) ? body.version : null;
      } catch {
        return null; // Offline, slow or refused: silent.
      }
    };
    const latest = await Promise.race([ask(), timeout]);
    clearTimeout(timer);
    writeCache({ checkedAt: Date.now(), ...(latest === null ? {} : { latest }) });
    return latest;
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

// ---- installed agent skills ----

export interface InstalledSkill {
  name: string;
  /** The skill's folder, as found. */
  path: string;
  /** The `skills` folder it is in: the unit "once a day" counts by. */
  location: string;
  /** `metadata.version` of its SKILL.md, null when missing. */
  version: string | null;
}

/** `metadata: { version }` from a SKILL.md's frontmatter. */
export function skillVersion(markdown: string): string | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  if (front === undefined) return null;
  const block = /^metadata:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(front)?.[1];
  if (block === undefined) return null;
  const value = /^[ \t]+version:[ \t]*["']?([^"'\s#]+)/m.exec(block)?.[1];
  return value ?? null;
}

// Where `skills add` puts skills (https://github.com/vercel-labs/skills, docs/agents.md): the project folder of each
// agent, or the user's. The canonical copy is `.agents/skills`; the rest are symlinks to it or copies.
const PROJECT_DIRS = ['.agents/skills', '.claude/skills', '.codex/skills', '.cursor/skills', '.gemini/skills', '.github/skills'];
const GLOBAL_DIRS = [
  '.agents/skills',
  '.config/agents/skills',
  '.claude/skills',
  '.codex/skills',
  '.cursor/skills',
  '.gemini/skills',
  '.copilot/skills',
  '.config/opencode/skills',
  '.factory/skills',
];

/** The `skills` folders to look in: the project's (from `cwd` up to the home folder) and the user's. */
export function skillLocations(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const out: string[] = [];
  for (let dir = resolve(cwd), depth = 0; depth < 10 && dir !== home; dir = dirname(dir), depth++) {
    for (const rel of PROJECT_DIRS) out.push(join(dir, rel));
    if (dir === parse(dir).root) break;
  }
  for (const rel of GLOBAL_DIRS) out.push(join(home, rel));
  if (env.CLAUDE_CONFIG_DIR) out.push(join(env.CLAUDE_CONFIG_DIR, 'skills'));
  if (env.CODEX_HOME) out.push(join(env.CODEX_HOME, 'skills'));
  return out;
}

/** The Kinetograph skills installed in those folders (symlinks followed, one entry per real folder). */
export function findInstalledSkills(cwd: string = process.cwd()): InstalledSkill[] {
  const seen = new Set<string>();
  const out: InstalledSkill[] = [];
  for (const location of skillLocations(cwd)) {
    for (const name of SKILL_NAMES) {
      const path = join(location, name);
      const file = join(path, 'SKILL.md');
      if (!existsSync(file)) continue;
      let real: string;
      try {
        real = realpathSync(path);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      let version: string | null = null;
      try {
        version = skillVersion(readFileSync(file, 'utf8'));
      } catch {
        // Unreadable: counts as unstamped.
      }
      out.push({ name, path, location, version });
    }
  }
  return out;
}

/** A skill is current when it is stamped with a version at least the CLI's. */
export function skillIsCurrent(skill: InstalledSkill, cliVersion: string): boolean {
  if (skill.version === null || !parseVersion(skill.version)) return false;
  return compareVersions(skill.version, cliVersion) >= 0;
}

// ---- the notices ----

export function cliNotice(latest: string, current: string): string {
  return `kinetograph ${latest} is out (you have ${current}): npm install kinetograph@latest${AGENT_HINT}`;
}

export function skillsNotice(oldest: string | null, cliVersion: string): string {
  const have = oldest === null ? 'have no version stamp' : `are ${oldest}`;
  return `Your Kinetograph agent skills ${have} and the CLI is ${cliVersion}: update them with ${SKILLS_UPDATE_COMMAND}${AGENT_HINT}`;
}

export interface NoticeSession {
  /** The notice lines to show now (usually none), recorded as shown. Call once, after the work is done. */
  collect(): Promise<string[]>;
}

/**
 * Starts the registry check if the last one is over a day old (in the background: nothing here waits for the network)
 * and returns the session whose `collect()` gives the notices. Undefined when checks are off.
 */
export function beginNotices(cliVersion: string): NoticeSession | undefined {
  if (updateChecksOff()) return undefined;
  let answered: string | null | undefined;
  let pending: Promise<unknown> | undefined;
  if (!isFresh(readCache().checkedAt, Date.now())) pending = checkLatest().then((latest) => void (answered = latest));
  return {
    async collect() {
      // An answer that has already come is used; one still in flight is left for the next command.
      if (pending) await Promise.race([pending, new Promise((r) => setImmediate(r))]);
      const now = Date.now();
      const cache = readCache();
      const lines: string[] = [];
      const patch: UpdateCache = {};
      const latest = answered ?? cache.latest;
      if (latest && isNewer(latest, cliVersion) && !isFresh(cache.notifiedAt, now)) {
        lines.push(cliNotice(latest, cliVersion));
        patch.notifiedAt = now;
      }
      const stale = findInstalledSkills().filter((s) => !skillIsCurrent(s, cliVersion) && !isFresh(cache.skillNotified?.[s.location], now));
      if (stale.length > 0) {
        const stamped = stale.flatMap((s) => (s.version !== null && parseVersion(s.version) ? [s.version] : []));
        const oldest = stale.some((s) => s.version === null || !parseVersion(s.version)) ? null : stamped.sort(compareVersions)[0]!;
        lines.push(skillsNotice(oldest, cliVersion));
        patch.skillNotified = { ...cache.skillNotified, ...Object.fromEntries(stale.map((s) => [s.location, now])) };
      }
      if (Object.keys(patch).length > 0) writeCache(patch);
      return lines;
    },
  };
}

export interface UpdateReport {
  cli: { version: string; latest: string | null; current: boolean | null; checkedAt: number | null };
  skills: { name: string; path: string; version: string | null; current: boolean }[];
}

/** For `doctor`: the CLI against the latest (asked now if the cache is over a day old, unless checks are off) and every installed skill. */
export async function updateReport(cliVersion: string): Promise<UpdateReport> {
  if (!isFresh(readCache().checkedAt, Date.now()) && process.env.KINETOGRAPH_NO_UPDATE_CHECK !== '1') await checkLatest();
  const cache = readCache();
  const latest = cache.latest ?? null;
  return {
    cli: { version: cliVersion, latest, current: latest === null ? null : !isNewer(latest, cliVersion), checkedAt: cache.checkedAt ?? null },
    skills: findInstalledSkills().map((s) => ({ name: s.name, path: s.path, version: s.version, current: skillIsCurrent(s, cliVersion) })),
  };
}

/** `doctor`'s lines for an `UpdateReport`. */
export function formatUpdateReport(report: UpdateReport): string[] {
  const { cli, skills } = report;
  const lines = [
    cli.latest === null
      ? `kinetograph ${cli.version} (latest version unknown: not checked yet, or the registry did not answer)`
      : cli.current
        ? `kinetograph ${cli.version} is the latest`
        : cliNotice(cli.latest, cli.version),
  ];
  if (skills.length === 0) lines.push('agent skills: none installed (npx kinetograph skills update)');
  for (const s of skills) lines.push(`skill ${s.name}: ${s.version ?? 'no version stamp'}, ${s.current ? 'current' : `out of date (${SKILLS_UPDATE_COMMAND})`}  ${s.path}`);
  return lines;
}
