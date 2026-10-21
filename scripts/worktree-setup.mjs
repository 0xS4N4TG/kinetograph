// Makes a fresh git worktree usable without a network install: `node scripts/worktree-setup.mjs`.
//
// A new worktree has no node_modules, so `@kinetograph/*` (and every other dependency) resolves to the main checkout's
// built packages instead of the worktree's. This links the third-party packages from the main checkout's node_modules
// (and each workspace's own node_modules) and links every workspace package from this worktree as `@kinetograph/<name>`,
// so tests and builds in the worktree use the worktree's code. Build the packages afterwards (`npm run build`).
// Run `npm install` instead when a dependency changed.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const common = resolve(here, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: here, encoding: 'utf8' }).trim(), '..');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const workspaces = readJson(join(here, 'package.json')).workspaces;

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) || isLink(path)) return false;
  symlinkSync(target, path, 'dir');
  return true;
}
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

if (common === here) {
  console.log('This is the main checkout: nothing to do (run npm install here).');
  process.exit(0);
}

let made = 0;
// Third-party packages: each top-level entry of the main checkout's node_modules, except our own scope.
const mainModules = join(common, 'node_modules');
if (existsSync(mainModules)) {
  for (const entry of readdirSync(mainModules)) {
    if (entry === '@kinetograph') continue;
    if (link(join(mainModules, entry), join(here, 'node_modules', entry))) made++;
  }
}
// Each workspace's own node_modules (nested versions).
for (const dir of workspaces) {
  const theirs = join(common, dir, 'node_modules');
  if (existsSync(theirs) && link(theirs, join(here, dir, 'node_modules'))) made++;
}
// Our packages, from this worktree.
for (const dir of workspaces) {
  const manifest = join(here, dir, 'package.json');
  if (!existsSync(manifest)) continue;
  const name = readJson(manifest).name;
  if (typeof name !== 'string') continue;
  const path = join(here, 'node_modules', name);
  if (link(relative(dirname(path), join(here, dir)), path)) made++;
}
console.log(`linked ${made} entries in ${here}`);
