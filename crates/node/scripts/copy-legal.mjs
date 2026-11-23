// Copies the third-party notices into every platform package directory (npm/*), and adds them to its `files`.
// The package's LICENSE.md starts with a note that the package holds two works under different licences (the addon,
// Apache-2.0; `bin/ffmpeg`, GPL), followed by the repository's LICENSE.md. NOTICE is copied beside it. A package that
// carries the ANGLE libraries (`angle/`, scripts/fetch-angle.mjs) or Dawn (`dawn/`, scripts/fetch-dawn.mjs) gets them listed in `files` and named in the note.
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.join(here, '..');
const legal = fs.readdirSync(path.join(root, 'legal'));
const note = (angle, dawn) => `# Licences in this package

This package holds ${['two', 'three', 'four'][(angle ? 1 : 0) + (dawn ? 1 : 0)]} separate works:

- The native addon (\`kinetograph.*.node\`) is licensed under the Apache License 2.0, which follows.
  It links an FFmpeg built as LGPL 2.1 or later (see THIRD-PARTY-NOTICES.md).
- The stand-alone program \`bin/ffmpeg\` (\`bin/ffmpeg.exe\` on Windows) is licensed under the GNU General Public License,
  version 2 or later (COPYING.GPLv2). The addon runs it as a child process and never links it. See FFMPEG-LICENSE.md.
${angle ? `- The libraries in \`angle/\` are Google's ANGLE (BSD-3-Clause, \`angle/ANGLE-LICENSE\`), taken unchanged from a prebuilt ANGLE
  (angle/SOURCE.txt says whose). The addon opens them at run time and does not link them. On Linux and Windows the folder also
  holds SwiftShader (Apache-2.0) and the Khronos Vulkan loader (Apache-2.0), ANGLE's software Vulkan driver. See THIRD-PARTY-NOTICES.md.
` : ''}${dawn ? `- \`dawn/dawn.node\` is Dawn, Chrome's WebGPU library, in the build of the \`webgpu\` npm package (MIT, \`dawn/DAWN-LICENSE\`; \`dawn/SOURCE.txt\` says
  which release), taken unchanged. Node opens it at run time; the addon does not link it. It contains third-party code (abseil, SPIRV-Tools and
  others; see THIRD-PARTY-NOTICES.md). The Windows package also holds Microsoft's DirectX Shader Compiler (\`dxcompiler.dll\`, \`dawn/dxcompiler-LICENSE.TXT\`)
  and FXC (\`d3dcompiler_47.dll\`) beside it. On Linux and Windows \`dawn/\` also holds a copy of the Khronos Vulkan loader of \`angle/\` (Apache-2.0).
` : ''}
---

`;
for (const dir of fs.readdirSync(path.join(root, 'npm'))) {
  const target = path.join(root, 'npm', dir);
  const angleDir = path.join(target, 'angle');
  const angle = fs.existsSync(angleDir) ? fs.readdirSync(angleDir).map((f) => `angle/${f}`) : [];
  // Our own ANGLE build (SOURCE.txt names its repository) must come with its credits file for the code compiled into it.
  if (angle.length && fs.readFileSync(path.join(angleDir, 'SOURCE.txt'), 'utf8').includes('kinetograph-angle') && !angle.includes('angle/THIRD-PARTY-NOTICES.txt')) {
    throw new Error(`${dir}: angle/THIRD-PARTY-NOTICES.txt is missing (our ANGLE build ships it)`);
  }
  const dawnDir = path.join(target, 'dawn');
  const dawn = fs.existsSync(dawnDir) ? fs.readdirSync(dawnDir).map((f) => `dawn/${f}`) : [];
  if (dawn.length && !dawn.includes('dawn/DAWN-LICENSE')) throw new Error(`${dir}: dawn/DAWN-LICENSE is missing`);
  for (const f of legal) fs.copyFileSync(path.join(root, 'legal', f), path.join(target, f));
  const apache = fs.readFileSync(path.join(root, '..', '..', 'LICENSE.md'), 'utf8');
  fs.writeFileSync(path.join(target, 'LICENSE.md'), note(angle.length > 0, dawn.length > 0) + apache);
  fs.copyFileSync(path.join(root, '..', '..', 'NOTICE'), path.join(target, 'NOTICE'));
  const file = path.join(target, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  // napi pre-publish wants every `files` entry to be a file, so the ffmpeg program, its sources and the ANGLE files are named, not their folders.
  const bin = [dir.startsWith('win32') ? 'bin/ffmpeg.exe' : 'bin/ffmpeg', 'bin/SOURCES.txt'];
  pkg.files = [...new Set([...pkg.files.filter((f) => f !== 'bin/'), ...legal, 'NOTICE', ...bin, ...angle, ...dawn])];
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
