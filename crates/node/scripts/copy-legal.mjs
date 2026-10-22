// Copies the third-party notices into every platform package directory (npm/*), and adds them to its `files`.
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.join(here, '..');
const legal = fs.readdirSync(path.join(root, 'legal'));
for (const dir of fs.readdirSync(path.join(root, 'npm'))) {
  const target = path.join(root, 'npm', dir);
  for (const f of legal) fs.copyFileSync(path.join(root, 'legal', f), path.join(target, f));
  fs.copyFileSync(path.join(root, '..', '..', 'LICENSE.md'), path.join(target, 'LICENSE.md'));
  const file = path.join(target, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.files = [...new Set([...pkg.files, ...legal])];
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
