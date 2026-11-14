// Copies the third-party notices into every platform package directory (npm/*), and adds them to its `files`.
// The package's LICENSE.md starts with a note that the package holds two works under different licences (the addon,
// Apache-2.0; `bin/ffmpeg`, GPL), followed by the repository's LICENSE.md. NOTICE is copied beside it. A package that
// carries the ANGLE libraries (`angle/`, scripts/fetch-angle.mjs) gets them listed in `files` and named in the note.
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.join(here, '..');
const legal = fs.readdirSync(path.join(root, 'legal'));
const note = (angle) => `# Licences in this package

This package holds ${angle ? 'three' : 'two'} separate works:

- The native addon (\`kinetograph.*.node\`) is licensed under the Apache License 2.0, which follows.
  It links an FFmpeg built as LGPL 2.1 or later (see THIRD-PARTY-NOTICES.md).
- The stand-alone program \`bin/ffmpeg\` (\`bin/ffmpeg.exe\` on Windows) is licensed under the GNU General Public License,
  version 2 or later (COPYING.GPLv2). The addon runs it as a child process and never links it. See FFMPEG-LICENSE.md.
${angle ? `- The libraries in \`angle/\` are Google's ANGLE (BSD-3-Clause, \`angle/ANGLE-LICENSE\`), taken unchanged from a Chrome
  for Testing build. The addon opens them at run time and does not link them. See THIRD-PARTY-NOTICES.md.
` : ''}
---

`;
for (const dir of fs.readdirSync(path.join(root, 'npm'))) {
  const target = path.join(root, 'npm', dir);
  const angleDir = path.join(target, 'angle');
  const angle = fs.existsSync(angleDir) ? fs.readdirSync(angleDir).map((f) => `angle/${f}`) : [];
  for (const f of legal) fs.copyFileSync(path.join(root, 'legal', f), path.join(target, f));
  const apache = fs.readFileSync(path.join(root, '..', '..', 'LICENSE.md'), 'utf8');
  fs.writeFileSync(path.join(target, 'LICENSE.md'), note(angle.length > 0) + apache);
  fs.copyFileSync(path.join(root, '..', '..', 'NOTICE'), path.join(target, 'NOTICE'));
  const file = path.join(target, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  // napi pre-publish wants every `files` entry to be a file, so the ffmpeg program, its sources and the ANGLE files are named, not their folders.
  const bin = [dir.startsWith('win32') ? 'bin/ffmpeg.exe' : 'bin/ffmpeg', 'bin/SOURCES.txt'];
  pkg.files = [...new Set([...pkg.files.filter((f) => f !== 'bin/'), ...legal, 'NOTICE', ...bin, ...angle])];
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
