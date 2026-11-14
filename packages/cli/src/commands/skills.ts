import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from '../errors.js';
import { resolveItems } from '../registry/install.js';
import { MAX_FILE_BYTES, openRegistry, sha256, type Registry } from '../registry/source.js';
import type { Command } from './types.js';

/** The skills that ship in the package (packages/cli/skills). */
const BUNDLED = fileURLToPath(new URL('../../skills', import.meta.url));
/** The taste skill is a `skill` item of the registry, so only its own files are fetched, never the kinetograph-ui repo. */
const TASTE_SKILL = 'kinetograph-taste-clone';

type SkillFiles = Map<string, Uint8Array>;

/** The global skills folders of Claude Code, Codex and Cursor, plus the shared `.agents/skills` that Codex and Cursor also read. */
export function globalSkillFolders(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills'),
    join(env.CODEX_HOME || join(home, '.codex'), 'skills'),
    join(home, '.cursor', 'skills'),
    join(home, '.agents', 'skills'),
  ];
}

function bundledSkills(root: string): Map<string, SkillFiles> {
  const skills = new Map<string, SkillFiles>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(root, entry.name, 'SKILL.md'))) continue;
    const files: SkillFiles = new Map();
    for (const file of readdirSync(join(root, entry.name), { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || file.name.startsWith('.')) continue;
      const path = join(file.parentPath, file.name);
      files.set(path.slice(join(root, entry.name).length + 1).replaceAll('\\', '/'), readFileSync(path));
    }
    skills.set(entry.name, files);
  }
  return skills;
}

/** The files of the registry's skill item, by path inside the skill. */
async function registrySkill(registry: Registry, name: string): Promise<SkillFiles> {
  const item = (await resolveItems(registry, [name])).find((i) => i.name === name)!;
  if (item.type !== 'skill') throw new CliError('INVALID_ITEM', `${name} in the registry is a ${item.type}, not a skill`);
  const files: SkillFiles = new Map();
  for (const file of item.files) {
    const data = 'content' in file ? Buffer.from(file.content, 'utf8') : await registry.readFile(item.name, file.url);
    if ('url' in file && file.sha256 !== undefined && sha256(data) !== file.sha256) throw new CliError('CHECKSUM', `${item.name}/${file.path} does not match its sha256`);
    if (data.length > MAX_FILE_BYTES) throw new CliError('TOO_LARGE', `${item.name}/${file.path} is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`);
    files.set(file.path, data);
  }
  return files;
}

/** Writes one skill under `folder`. A symlinked skill (say, a link to a checkout) is left alone. Returns the folder, or undefined when skipped. */
function writeSkill(folder: string, name: string, files: SkillFiles): string | undefined {
  const dir = join(folder, name);
  try {
    if (lstatSync(dir).isSymbolicLink()) return undefined;
  } catch {
    // Not there yet.
  }
  for (const [path, data] of files) {
    const target = join(dir, path);
    try {
      if (lstatSync(target).isSymbolicLink()) continue;
    } catch {
      // Not there yet.
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    if (/\.(sh|py)$/.test(path)) chmodSync(target, 0o755);
  }
  return dir;
}

export interface SkillsUpdate {
  skills: string[];
  folders: string[];
  written: string[];
  skipped: string[];
  /** Why the taste skill is missing, when the registry could not be reached. */
  failed?: string;
}

export async function updateSkills(options: { folders: string[]; registry: Registry; bundled?: string; progress?: (message: string) => void }): Promise<SkillsUpdate> {
  const progress = options.progress ?? (() => undefined);
  const skills = bundledSkills(options.bundled ?? BUNDLED);
  let failed: string | undefined;
  try {
    progress(`fetching ${TASTE_SKILL} from ${options.registry.location}`);
    skills.set(TASTE_SKILL, await registrySkill(options.registry, TASTE_SKILL));
  } catch (error) {
    failed = `${TASTE_SKILL} not installed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const written: string[] = [];
  const skipped: string[] = [];
  for (const folder of options.folders) {
    for (const [name, files] of skills) {
      const dir = writeSkill(folder, name, files);
      if (dir === undefined) skipped.push(join(folder, name));
      else written.push(dir);
    }
  }
  return { skills: [...skills.keys()], folders: options.folders, written, skipped, ...(failed ? { failed } : {}) };
}

export const skills: Command = {
  name: 'skills update',
  summary: 'Install or update the Kinetograph agent skills (the bundled ones and kinetograph-taste-clone) for Claude Code, Codex and Cursor, user-wide, without questions',
  project: false,
  positionals: [],
  options: [],
  async run(_args, context) {
    const result = await updateSkills({ folders: globalSkillFolders(), registry: openRegistry(), progress: context.progress });
    const lines = [`installed ${result.skills.join(', ')} into:`, ...result.folders.map((folder) => `  ${folder}`)];
    for (const path of result.skipped) lines.push(`skipped ${path} (a symbolic link; left as it is)`);
    if (result.failed) lines.push(`warning: ${result.failed}`);
    return { data: result, text: lines.join('\n'), exitCode: result.failed ? 1 : 0 };
  },
};
