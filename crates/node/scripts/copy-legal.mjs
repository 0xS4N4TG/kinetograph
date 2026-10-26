// Copies the third-party notices into every platform package directory (npm/*), and adds them to its `files`.
// The package's LICENSE.md starts with a note that the package holds two works under different licences (the addon,
// PolyForm; `bin/ffmpeg`, GPL), followed by the repository's LICENSE.md.
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.join(here, '..');
const legal = fs.readdirSync(path.join(root, 'legal'));
const note = `# Licences in this package

This package holds two separate works:

- The native addon (\`kinetograph.*.node\`) is licensed under the PolyForm Small Business License 1.0.0, which follows.
  It links an FFmpeg built as LGPL 2.1 or later (see THIRD-PARTY-NOTICES.md).
- The stand-alone program \`bin/ffmpeg\` (\`bin/ffmpeg.exe\` on Windows) is licensed under the GNU General Public License,
  version 2 or later (COPYING.GPLv2). The addon runs it as a child process and never links it. See FFMPEG-LICENSE.md.

---

`;
for (const dir of fs.readdirSync(path.join(root, 'npm'))) {
  const target = path.join(root, 'npm', dir);
  for (const f of legal) fs.copyFileSync(path.join(root, 'legal', f), path.join(target, f));
  const polyform = fs.readFileSync(path.join(root, '..', '..', 'LICENSE.md'), 'utf8');
  fs.writeFileSync(path.join(target, 'LICENSE.md'), note + polyform);
  const file = path.join(target, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.files = [...new Set([...pkg.files, ...legal, 'bin/'])];
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
