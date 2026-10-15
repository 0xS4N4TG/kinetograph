import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { typeCheck } from '../src/typecheck.js';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-typecheck-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const bad = 'const x: number = "a";\nexport default x;\n';

describe('typeCheck', () => {
  it('reports a type error with file, line, column and code', () => {
    const dir = project({ 'index.ts': bad });
    const r = typeCheck(join(dir, 'index.ts'), dir);
    expect(r.checked).toBe(true);
    expect(r.tsconfig).toBeNull();
    expect(r.diagnostics).toEqual([
      { file: 'index.ts', line: 1, column: 7, code: 2322, message: "Type 'string' is not assignable to type 'number'." },
    ]);
  });

  it('has nothing to say about a project that type-checks', () => {
    const dir = project({ 'index.ts': 'export const x: number = 1;\n' });
    expect(typeCheck(join(dir, 'index.ts'), dir)).toMatchObject({ checked: true, diagnostics: [] });
  });

  it('checks the files of the nearest tsconfig, not only the entry', () => {
    const dir = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }),
      'index.ts': 'export const x = 1;\n',
      'other.ts': bad,
    });
    const r = typeCheck(join(dir, 'index.ts'), dir);
    expect(r.tsconfig).toBe(join(dir, 'tsconfig.json'));
    expect(r.diagnostics.map((d) => d.file)).toEqual(['other.ts']);
  });

  it('catches a misspelled JSX prop', () => {
    const dir = project({
      'index.tsx':
        'declare global { namespace JSX { interface IntrinsicElements { box: { opacity?: number } } } }\n' +
        'export const a = <box opactiy={0.5} />;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'preserve', strict: true }, include: ['index.tsx'] }),
    });
    const r = typeCheck(join(dir, 'index.tsx'), dir);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.message).toContain('opactiy');
  });

  it('skips scene files and JavaScript without a tsconfig', () => {
    const dir = project({ 'scene.json': '{}', 'index.js': 'export default 1;\n' });
    expect(typeCheck(join(dir, 'scene.json'), dir).checked).toBe(false);
    expect(typeCheck(join(dir, 'index.js'), dir).checked).toBe(false);
  });
});
