// `.css` imports (docs/ENGINE.md §1): imports inlined, urls made absolute, Tailwind built by the project's own, CSS
// modules scoped; and what the bundle does with them.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleProject } from '../src/bundle.js';
import { absolutizeUrls, buildTailwind, readStylesheet, scopeModule, usesTailwind } from '../src/css.js';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-css-test-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe('readStylesheet', () => {
  it('inlines local @imports (with media queries), skips remote ones and makes url()s absolute', () => {
    const dir = project({
      'a.css': `@import './b.css';\n@import url("c.css") screen and (min-width: 10px);\n@import "https://x.test/r.css";\n.a { background: url(img/p.png) }`,
      'b.css': `.b { color: red }`,
      'c.css': `.c { top: 1px }`,
      'img/p.png': 'x',
    });
    const { css, files, warnings } = readStylesheet(join(dir, 'a.css'));
    expect(css).toContain('.b { color: red }');
    expect(css).toContain('@media screen and (min-width: 10px) {\n.c { top: 1px }\n}');
    expect(css).toContain('@import "https://x.test/r.css";');
    expect(css).toContain(`url("${join(dir, 'img', 'p.png')}")`);
    expect(files).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  it('warns about an import that is not there and survives an import cycle', () => {
    const dir = project({ 'a.css': `@import './nope.css'; @import './b.css';`, 'b.css': `@import './a.css'; .b{}` });
    const { warnings, css } = readStylesheet(join(dir, 'a.css'));
    expect(warnings[0]).toContain('nope.css');
    expect(css).toContain('.b{}');
  });
});

describe('absolutizeUrls', () => {
  it('leaves remote, data and missing urls alone', () => {
    const dir = project({ 'f.woff2': 'x' });
    const out = absolutizeUrls(`a{src:url(f.woff2) url(data:x) url("https://x/y.png") url(missing.png) url(#frag)}`, dir);
    expect(out).toContain(`url("${join(dir, 'f.woff2')}")`);
    expect(out).toContain('url(data:x) url("https://x/y.png") url(missing.png) url(#frag)');
  });
});

describe('usesTailwind', () => {
  it('recognises v3 directives and the v4 import', () => {
    expect(usesTailwind('@tailwind base;')).toBe(true);
    expect(usesTailwind(`@import "tailwindcss";`)).toBe(true);
    expect(usesTailwind(`@import url('tailwindcss/utilities');`)).toBe(true);
    expect(usesTailwind('.a { color: red }')).toBe(false);
  });
});

describe('buildTailwind', () => {
  it('runs the project’s tailwindcss with -i and -o, in the project', () => {
    const dir = project({ 'src/index.css': '@tailwind utilities;' });
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    const bin = join(dir, 'node_modules', '.bin', 'tailwindcss');
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nconst a = process.argv; const i = a[a.indexOf('-i') + 1]; const o = a[a.indexOf('-o') + 1];\n` +
        `require('node:fs').writeFileSync(o, '/* built from ' + require('node:path').basename(i) + ' in ' + require('node:path').basename(process.cwd()) + ' */ .p-4 { padding: 1rem }');\n`,
    );
    chmodSync(bin, 0o755);
    const built = buildTailwind(join(dir, 'src', 'index.css'));
    expect(built).toMatchObject({ css: expect.stringContaining('.p-4 { padding: 1rem }') });
    expect((built as { css: string }).css).toContain(`in ${dir.split('/').at(-1)}`);
  });

  it('says what is missing when the project has no Tailwind', () => {
    const dir = project({ 'src/index.css': '@tailwind base;' });
    const built = buildTailwind(join(dir, 'src', 'index.css'));
    expect(built).toMatchObject({ error: expect.stringContaining('Install tailwindcss (v3) or @tailwindcss/cli (v4)') });
  });
});

describe('scopeModule', () => {
  it('scopes class names, not file extensions, numbers, strings or :global', () => {
    const { css, exports } = scopeModule(
      `.title { margin: 1.5em; background: url(a.png) }\n.title:hover .icon, a.link > .x { content: ".fake" }\n:global(.keep) .own { top: 0 }\n@media (min-width: 10px) { .m { top: .5px } }`,
      '/p/a.module.css',
    );
    expect(Object.keys(exports).sort()).toEqual(['icon', 'link', 'm', 'own', 'title', 'x']);
    expect(css).toContain(`.${exports.title} { margin: 1.5em; background: url(a.png) }`);
    expect(css).toContain(`.${exports.title}:hover .${exports.icon}, a.${exports.link} > .${exports.x} { content: ".fake" }`);
    expect(css).toContain(`.keep .${exports.own}`);
    expect(css).toContain(`.${exports.m} { top: .5px }`);
  });
});

describe('the bundle', () => {
  it('registers an imported stylesheet and exports a CSS module’s classes', async () => {
    const dir = project({
      'src/index.ts': `import './base.css';\nimport styles from './box.module.css';\nimport { registerRoot } from 'remotion';\nregisterRoot(() => null);\nconsole.log(styles.box);`,
      'src/base.css': `body { margin: 0 }`,
      'src/box.module.css': `.box { color: red }`,
    });
    const { file, warnings } = await bundleProject(join(dir, 'src', 'index.ts'));
    const code = readFileSync(file, 'utf8');
    expect(code).toContain('registerStylesheet(');
    expect(code).toContain('body { margin: 0 }');
    expect(code).toMatch(/\.box_[0-9a-f]{6} \{ color: red \}/);
    expect(warnings).toEqual([]);
  });
});
