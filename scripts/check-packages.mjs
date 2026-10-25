// For every publishable package directory given (default: all): `npm pack --dry-run` must list LICENSE.md, a README and
// no source, test or source-map files, and every `@kinetographdev/*` or `kinetograph` dependency must be an exact version.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['crates/node', 'packages/scene', 'packages/compat', 'packages/react', 'packages/core', 'packages/audio', 'packages/cli', 'packages/studio', 'packages/plugins/gsap', 'packages/plugins/p5-brush', 'packages/plugins/anime', 'packages/plugins/motion'];
let bad = 0;
for (const dir of dirs) {
  const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'));
  const [entry] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }));
  const paths = entry.files.map((f) => f.path);
  const problems = [];
  for (const need of ['LICENSE.md', 'README.md', 'package.json']) if (!paths.includes(need)) problems.push(`missing ${need}`);
  for (const p of paths) if (/\.map$|(^|\/)(src|test|tests|scratch)\//.test(p)) problems.push(`should not ship ${p}`);
  if (!/^Required Notice:/m.test(fs.readFileSync(`${dir}/LICENSE.md`, 'utf8'))) problems.push('LICENSE.md has no Required Notice line');
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if ((name === 'kinetograph' || name.startsWith('@kinetographdev/')) && !/^\d+\.\d+\.\d+$/.test(range)) problems.push(`${name} is ${range}, not an exact version`);
  }
  console.log(`${pkg.name}: ${paths.length} files, ${entry.size} bytes packed${problems.length ? '\n  ' + problems.join('\n  ') : ''}`);
  bad += problems.length;
}
process.exit(bad ? 1 : 0);
