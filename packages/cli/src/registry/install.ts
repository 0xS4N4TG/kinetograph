// `kinetograph add`: resolve registry items, check everything, then write. Nothing is written until every item is
// loaded, valid and allowed, and every download has arrived. Nothing from an item is executed; its npm packages are
// installed only when the person agreed (or passed --yes).

import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { CliError } from '../errors.js';
import { compareVersions } from '../update-notice.js';
import { cliVersion } from '../version.js';
import { itemProblem, registryIndexSchema, registryItemSchema, TYPE_FOLDERS, type ItemType, type RegistryIndex, type RegistryItem } from './item.js';
import {
  detectPackageManager,
  installCommand,
  missingPackages,
  runInstall as defaultRunInstall,
  showCommand,
  type InstallCommand,
  type PackageManager,
} from './packages.js';
import { MAX_FILE_BYTES, sha256, type Registry } from './source.js';

const MAX_ITEMS = 50;

export type InstallStatus = 'none' | 'installed' | 'declined' | 'not-run' | 'failed';

export interface AddOptions {
  names: string[];
  /** Where to look for the project (the nearest package.json at or above it). */
  dir: string;
  registry: Registry;
  overwrite: boolean;
  /** Install missing npm packages without asking. */
  yes: boolean;
  /** Asks a yes/no question; absent when there is nobody to ask (not a terminal, or `--json`). */
  confirm?: (question: string) => Promise<boolean>;
  /** Runs the install command; for tests. */
  runInstall?: (command: InstallCommand, cwd: string) => Promise<void>;
  progress?: (message: string) => void;
}

export interface AddedItem {
  name: string;
  type: ItemType;
  title: string;
  written: string[];
  skipped: string[];
}

export interface AddResult {
  project: string;
  added: AddedItem[];
  dependencies: {
    missing: Record<string, string>;
    manager: PackageManager;
    /** The command that installs `missing`; undefined when nothing is missing. */
    command?: string;
    status: InstallStatus;
    error?: string;
  };
  warnings: string[];
  next: string[];
}

/** The folder of the nearest package.json at or above `dir`. */
export function findProject(dir: string): string {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current;
    if (dirname(current) === current) throw new CliError('NOT_A_PROJECT', `${resolve(dir)} is not inside a project (no package.json). Run \`npx kinetograph init\` first.`);
  }
}

function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0]!;
  return `${issue.path.map(String).join('.') || 'the file'}: ${issue.message}`;
}

/** The item `name`, checked: a paid one is refused before anything else, then the schema, the name and the CLI version. */
async function loadItem(registry: Registry, name: string): Promise<RegistryItem> {
  const raw = await registry.readJson(name);
  // The seam for licence keys: today every paid item is refused here, before any of its files are looked at.
  if (typeof raw === 'object' && raw !== null && (raw as { access?: unknown }).access === 'paid') {
    const title = (raw as { title?: unknown }).title;
    throw new CliError('NOT_PUBLISHED', `${typeof title === 'string' && title !== '' ? title : name} is not published yet.`);
  }
  const parsed = registryItemSchema.safeParse(raw);
  if (!parsed.success) throw new CliError('INVALID_ITEM', `${name} is not a valid registry item: ${firstIssue(parsed.error)}`);
  const item = parsed.data;
  if (item.name !== name) throw new CliError('INVALID_ITEM', `${name}.json describes an item named "${item.name}"`);
  const problem = itemProblem(item);
  if (problem !== undefined) throw new CliError('UNSAFE_TARGET', problem);
  if (compareVersions(cliVersion(), item.kinetograph) < 0) {
    throw new CliError('CLI_TOO_OLD', `${item.title} needs kinetograph ${item.kinetograph} or newer (this is ${cliVersion()}). Update with \`npm install kinetograph@latest\`.`);
  }
  return item;
}

/** The requested items and their `registryDependencies`, each once, dependencies first. */
export async function resolveItems(registry: Registry, names: string[]): Promise<RegistryItem[]> {
  const done = new Set<string>();
  const order: RegistryItem[] = [];
  const stack: string[] = [];
  const visit = async (name: string): Promise<void> => {
    if (done.has(name)) return;
    if (stack.includes(name)) throw new CliError('INVALID_ITEM', `registryDependencies loop: ${[...stack.slice(stack.indexOf(name)), name].join(' -> ')}`);
    if (done.size >= MAX_ITEMS) throw new CliError('INVALID_ITEM', `more than ${MAX_ITEMS} items to install`);
    stack.push(name);
    const item = await loadItem(registry, name);
    for (const dependency of item.registryDependencies ?? []) await visit(dependency);
    stack.pop();
    done.add(name);
    order.push(item);
  };
  for (const name of names) await visit(name);
  return order;
}

export async function listItems(registry: Registry, type?: ItemType): Promise<RegistryIndex['items']> {
  const parsed = registryIndexSchema.safeParse(await registry.readJson('index'));
  if (!parsed.success) throw new CliError('INVALID_ITEM', `the registry index is not valid: ${firstIssue(parsed.error)}`);
  return parsed.data.items.filter((item) => type === undefined || item.type === type);
}

/** Whether `target` is already a file in the project. Refuses a link anywhere on its path, and a file where a folder is needed. */
function targetExists(root: string, target: string): boolean {
  const absolute = resolve(root, target);
  if (!absolute.startsWith(root + sep)) throw new CliError('UNSAFE_TARGET', `${target} leaves the project`);
  const parts = target.split('/');
  let current = root;
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return false;
    }
    const where = parts.slice(0, i + 1).join('/');
    if (stat.isSymbolicLink()) throw new CliError('UNSAFE_TARGET', `${where} is a symbolic link; not writing through it`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new CliError('UNSAFE_TARGET', `${where} is a file, but ${target} needs it to be a folder`);
    if (i === parts.length - 1 && stat.isDirectory()) throw new CliError('UNSAFE_TARGET', `${target} is a folder, not a file`);
  }
  return true;
}

/** The names a component's `index.tsx` exports, for the import line in the next steps. */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^export\s+(?:declare\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!);
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).at(-1)!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.add(name);
    }
  }
  return [...names];
}

function nextSteps(items: RegistryItem[], requested: string[]): string[] {
  const steps: string[] = [];
  for (const item of items.filter((i) => requested.includes(i.name))) {
    const folder = `src/${TYPE_FOLDERS[item.type]}/${item.name}`;
    if (item.type === 'component') {
      const entry = item.files.find((f) => /^index\.tsx?$/.test(f.path) && 'content' in f);
      const names = entry && 'content' in entry ? exportedNames(entry.content) : [];
      steps.push(`${item.name}: import { ${names.length > 0 ? names.join(', ') : '…'} } from '../components/${item.name}';   // from a file in src/scenes/`);
    } else if (item.type === 'template') {
      steps.push(`${item.name}: npx kinetograph still ${folder}/index.tsx 0   (then render it with \`npx kinetograph render ${folder}/index.tsx\`)`);
    } else {
      const note = item.files.find((f) => /(^|\/)TASTE\.md$/.test(f.path));
      steps.push(`${item.name}: tell your agent to read ${note ? note.target : folder} before making a video in this taste`);
    }
  }
  return steps;
}

export async function addItems(options: AddOptions): Promise<AddResult> {
  const { registry, overwrite } = options;
  const progress = options.progress ?? (() => undefined);
  const root = findProject(options.dir);

  const items = await resolveItems(registry, options.names);
  const skill = items.find((item) => item.type === 'skill');
  if (skill) throw new CliError('INVALID_ARG', `${skill.name} is an agent skill, not a project item: install it with \`npx kinetograph skills update\``);

  // Every download first, so a missing or altered file stops the install before anything is written.
  const bytes = new Map<string, Uint8Array>();
  for (const item of items) {
    for (const file of item.files) {
      let data: Uint8Array;
      if ('content' in file) data = Buffer.from(file.content, 'utf8');
      else {
        progress(`downloading ${item.name}/${file.path}`);
        data = await registry.readFile(item.name, file.url);
        if (file.sha256 !== undefined && sha256(data) !== file.sha256) throw new CliError('CHECKSUM', `${item.name}/${file.path} does not match its sha256`);
      }
      if (data.length > MAX_FILE_BYTES) throw new CliError('TOO_LARGE', `${item.name}/${file.path} is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB limit`);
      bytes.set(`${item.name}\0${file.target}`, data);
    }
  }

  // Check every target before the first write; decide what is skipped.
  const planned = new Set<string>();
  const plan = items.map((item) => ({
    item,
    files: item.files.map((file) => {
      const exists = targetExists(root, file.target) || planned.has(file.target);
      planned.add(file.target);
      return { target: file.target, data: bytes.get(`${item.name}\0${file.target}`)!, write: overwrite || !exists };
    }),
  }));

  const added: AddedItem[] = [];
  for (const { item, files } of plan) {
    const entry: AddedItem = { name: item.name, type: item.type, title: item.title, written: [], skipped: [] };
    for (const file of files) {
      if (!file.write) {
        entry.skipped.push(file.target);
        continue;
      }
      const absolute = join(root, file.target);
      mkdirSync(dirname(absolute), { recursive: true });
      try {
        writeFileSync(absolute, file.data, { flag: overwrite ? 'w' : 'wx' });
        entry.written.push(file.target);
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
        entry.skipped.push(file.target);
      }
    }
    added.push(entry);
  }

  // npm packages: the first version asked for wins; a different one is a warning.
  const warnings: string[] = [];
  const wanted: Record<string, string> = {};
  for (const item of items) {
    for (const [name, version] of Object.entries(item.dependencies ?? {})) {
      if (wanted[name] === undefined) wanted[name] = version;
      else if (wanted[name] !== version) warnings.push(`${item.name} asks for ${name}@${version}, but ${name}@${wanted[name]} is being installed`);
    }
  }
  const missing = missingPackages(root, wanted);
  const manager = detectPackageManager(root);
  const dependencies: AddResult['dependencies'] = { missing, manager, status: 'none' };
  if (Object.keys(missing).length > 0) {
    const command = installCommand(manager, missing);
    dependencies.command = showCommand(command);
    const list = Object.entries(missing).map(([name, version]) => `${name}@${version}`).join(', ');
    progress(`these npm packages are not in package.json: ${list}`);
    let go = options.yes;
    if (!go && options.confirm !== undefined) {
      go = await options.confirm(`install them with \`${dependencies.command}\`?`);
      if (!go) dependencies.status = 'declined';
    }
    if (go) {
      try {
        await (options.runInstall ?? defaultRunInstall)(command, root);
        dependencies.status = 'installed';
      } catch (error) {
        dependencies.status = 'failed';
        dependencies.error = error instanceof Error ? error.message : String(error);
      }
    } else if (dependencies.status === 'none') dependencies.status = 'not-run';
  }

  return { project: root, added, dependencies, warnings, next: nextSteps(items, options.names) };
}

/** The text a person sees for an `AddResult`. */
export function describeAdd(result: AddResult): string {
  const lines: string[] = [];
  for (const item of result.added) {
    lines.push(`${item.title} (${item.name}, ${item.type}): ${item.written.length} file${item.written.length === 1 ? '' : 's'} written${item.skipped.length > 0 ? `, ${item.skipped.length} skipped` : ''}`);
    for (const file of item.written) lines.push(`  wrote    ${file}`);
    for (const file of item.skipped) lines.push(`  skipped  ${file}  (already exists; --overwrite replaces it)`);
  }
  const { dependencies: d } = result;
  if (d.command !== undefined) {
    const packages = Object.entries(d.missing).map(([name, version]) => `${name}@${version}`).join(', ');
    if (d.status === 'installed') lines.push(`installed ${packages} with ${d.manager}`);
    else if (d.status === 'failed') lines.push(`could not install ${packages}: ${d.error}\n  run it yourself: ${d.command}`);
    else lines.push(`needs npm packages that package.json lacks: ${packages}\n  not installed${d.status === 'declined' ? ' (you said no)' : ' (pass --yes to install them)'}; run: ${d.command}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (result.next.length > 0) lines.push('next:', ...result.next.map((step) => `  ${step}`));
  return lines.join('\n');
}
