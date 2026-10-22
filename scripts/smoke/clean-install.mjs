// Packs the built packages and the native addon, installs the tarballs into an empty project outside the repository and
// renders a small project there, the way a user would. Run after the addon is built into crates/node and the TS
// packages are built (scene, compat, react, core, audio, cli). Prints which backend drew and which encoder wrote the
// file; exits 1 if the render fails or the frame count is wrong. Falling back from Skia to Vello is reported, not failed.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const win = process.platform === 'win32';
const platform = { 'darwin-arm64': 'darwin-arm64', 'linux-x64': 'linux-x64-gnu', 'win32-x64': 'win32-x64-msvc' }[`${process.platform}-${process.arch}`];
if (!platform) throw new Error(`no platform package for ${process.platform}-${process.arch}`);

const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', shell: win, stdio: ['ignore', 'pipe', 'inherit'] });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetograph-smoke-'));
const tarballs = path.join(tmp, 'tarballs');
fs.mkdirSync(tarballs);

const pack = (dir) => npm(['pack', '--pack-destination', tarballs, '--silent'], dir).trim().split('\n').pop();
const files = [];

// The platform package: crates/node/npm/<platform> plus the built binary.
const nodeFile = `kinetograph.${platform}.node`;
const built = path.join(root, 'crates/node', nodeFile);
if (!fs.existsSync(built)) throw new Error(`${built} is not built`);
const platformDir = path.join(tmp, 'platform');
fs.cpSync(path.join(root, 'crates/node/npm', platform), platformDir, { recursive: true });
fs.copyFileSync(built, path.join(platformDir, nodeFile));
files.push(pack(platformDir));
for (const dir of ['crates/node', 'packages/scene', 'packages/compat', 'packages/react', 'packages/core', 'packages/audio', 'packages/cli']) {
  files.push(pack(path.join(root, dir)));
}

const project = path.join(tmp, 'project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
npm(['install', '--no-audit', '--no-fund', ...files.map((f) => path.join(tarballs, f)), 'react@19.3.1', 'react-dom@19.3.1'], project);
fs.copyFileSync(path.join(root, 'scripts/smoke/index.tsx'), path.join(project, 'index.tsx'));

const out = path.join(project, 'out.mp4');
const run = spawnSync(process.execPath, [path.join(project, 'node_modules/kinetograph/dist/cli.js'), 'render', 'index.tsx', '--comp', 'box', '-o', out, '--json'], {
  cwd: project,
  encoding: 'utf8',
});
process.stderr.write(run.stderr ?? '');
const backend = /kinetograph: drawing with (\w+)/.exec(run.stderr ?? '')?.[1] ?? 'unknown';
let result = {};
try {
  result = JSON.parse(run.stdout);
} catch {
  console.error(`render printed no JSON:\n${run.stdout}`);
}
const lines = [
  `backend: ${backend}`,
  `encoder: ${result.encoder ?? 'unknown'}`,
  `frames: ${result.frames ?? 'unknown'} (want 30)`,
  `file: ${fs.existsSync(out) ? fs.statSync(out).size + ' bytes' : 'missing'}`,
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Clean install, ${platform}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
}
const ok = run.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0 && Number(result.frames) === 30;
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
