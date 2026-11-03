// The npm packages an item needs: which are missing from the project, and the command that installs them with the
// project's own package manager. The command runs only after the person agreed (install.ts).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

/** From the lockfile, else the `packageManager` field of package.json, else npm. */
export function detectPackageManager(root: string): PackageManager {
  for (const [file, manager] of LOCKFILES) if (existsSync(join(root, file))) return manager;
  const field = (readManifest(root).packageManager as string | undefined)?.split('@')[0];
  return field === 'pnpm' || field === 'yarn' || field === 'bun' ? field : 'npm';
}

export function readManifest(root: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The packages in `wanted` that the project's package.json lists in no dependency field, with the versions asked for. */
export function missingPackages(root: string, wanted: Record<string, string>): Record<string, string> {
  const manifest = readManifest(root);
  const have = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const section = manifest[field];
    if (typeof section === 'object' && section !== null) for (const name of Object.keys(section)) have.add(name);
  }
  return Object.fromEntries(Object.entries(wanted).filter(([name]) => !have.has(name)));
}

export interface InstallCommand {
  command: string;
  args: string[];
}

export function installCommand(manager: PackageManager, packages: Record<string, string>): InstallCommand {
  return { command: manager, args: [manager === 'npm' ? 'install' : 'add', ...Object.entries(packages).map(([name, version]) => `${name}@${version}`)] };
}

/** The command as a person would type it. */
export const showCommand = ({ command, args }: InstallCommand): string => [command, ...args.map((a) => (/^[\w@./^~=*-]+$/.test(a) ? a : `'${a}'`))].join(' ');

/** Runs the command in the project, its output going to stderr so that `--json` stays clean. Rejects when it fails. */
export function runInstall({ command, args }: InstallCommand, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 2, 2] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });
}
