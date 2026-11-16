// For every publishable package directory given (default: all): `npm pack --dry-run` must list LICENSE.md (Apache-2.0), NOTICE, a README and
// no source, test or source-map files, and every `@kinetographdev/*` or `kinetograph` dependency must be an exact version.
// A platform package that has an `angle/` folder (scripts/fetch-angle.mjs) must pack both ANGLE libraries and their
// licence files, and its size is reported. ANGLE is optional: a platform package without the folder passes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['crates/node', ...fs.readdirSync('crates/node/npm').map((d) => `crates/node/npm/${d}`), 'packages/scene', 'packages/compat', 'packages/react', 'packages/core', 'packages/audio', 'packages/cli', 'packages/studio', 'packages/plugins/gsap', 'packages/plugins/p5-brush', 'packages/plugins/anime', 'packages/plugins/motion'];
// The ANGLE files a platform package must carry: libEGL and libGLESv2 under the platform's file names, and the licences.
// Chrome's credits file covers the third-party code compiled into the Chrome for Testing libraries; our own build
// (SOURCE.txt names its repository) carries its own THIRD-PARTY-NOTICES.txt instead.
const angleFiles = (dir) => {
  const name = path.basename(dir);
  const ext = name.includes('darwin') ? 'dylib' : name.includes('win32') ? 'dll' : 'so';
  const own = fs.readFileSync(`${dir}/angle/SOURCE.txt`, 'utf8').includes('kinetograph-angle');
  return [`libEGL.${ext}`, `libGLESv2.${ext}`, 'ANGLE-LICENSE', 'SOURCE.txt', ...(own ? ['THIRD-PARTY-NOTICES.txt'] : ['CHROMIUM-CREDITS.txt'])];
};
let bad = 0;
for (const dir of dirs) {
  const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'));
  const [entry] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }));
  const paths = entry.files.map((f) => f.path);
  const problems = [];
  for (const need of ['LICENSE.md', 'NOTICE', 'README.md', 'package.json']) if (!paths.includes(need)) problems.push(`missing ${need}`);
  for (const p of paths) if (/\.map$|(^|\/)(src|test|tests|scratch)\//.test(p)) problems.push(`should not ship ${p}`);
  if (!/Apache License\s+Version 2\.0/.test(fs.readFileSync(`${dir}/LICENSE.md`, 'utf8'))) problems.push('LICENSE.md is not the Apache License 2.0');
  if (pkg.license !== 'Apache-2.0' && pkg.license !== 'SEE LICENSE IN LICENSE.md') problems.push(`license is ${pkg.license}, not Apache-2.0`);
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if ((name === 'kinetograph' || name.startsWith('@kinetographdev/')) && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(range)) problems.push(`${name} is ${range}, not an exact version`);
  }
  let angle = '';
  if (fs.existsSync(`${dir}/angle`)) {
    for (const f of angleFiles(dir)) if (!paths.includes(`angle/${f}`)) problems.push(`angle/${f} is missing from the package`);
    angle = `, angle/ ${entry.files.filter((f) => f.path.startsWith('angle/')).reduce((n, f) => n + f.size, 0)} bytes unpacked`;
  }
  console.log(`${pkg.name}: ${paths.length} files, ${entry.size} bytes packed${angle}${problems.length ? '\n  ' + problems.join('\n  ') : ''}`);
  bad += problems.length;
}
process.exit(bad ? 1 : 0);
