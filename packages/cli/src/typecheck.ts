import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';

export interface TypeDiagnostic {
  /** Relative to the directory the command ran in, or absolute if outside it. */
  file: string | null;
  line: number | null;
  column: number | null;
  /** The TypeScript error number: 2322 for `TS2322`. */
  code: number;
  message: string;
}

export interface TypeCheckResult {
  /** False for a scene file or a JavaScript project with no tsconfig: nothing to check. */
  checked: boolean;
  /** The tsconfig used, or null when the entry was checked alone with the defaults. */
  tsconfig: string | null;
  diagnostics: TypeDiagnostic[];
}

const DEFAULTS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  skipLibCheck: true,
};

/**
 * `tsc --noEmit` on a project, in-process. Like `tsc` it checks the files of the nearest `tsconfig.json` above the
 * entry; with none, the entry and what it imports, under the defaults above. The CLI never type-checks to render
 * (esbuild strips types); this is for `check` and `lint`, so that a typo such as `opactiy` is seen by an agent that
 * has no editor.
 */
export function typeCheck(entry: string, cwd: string = process.cwd()): TypeCheckResult {
  const file = resolve(entry);
  if (extname(file).toLowerCase() === '.json') return { checked: false, tsconfig: null, diagnostics: [] };

  const tsconfig = ts.findConfigFile(dirname(file), ts.sys.fileExists);
  let options: ts.CompilerOptions = { ...DEFAULTS };
  let rootNames = [file];
  const diagnostics: ts.Diagnostic[] = [];
  if (tsconfig) {
    const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
    if (read.error) diagnostics.push(read.error);
    else {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig), undefined, tsconfig);
      diagnostics.push(...parsed.errors);
      options = parsed.options;
      rootNames = parsed.fileNames;
    }
  } else if (!/\.tsx?$/i.test(file)) {
    return { checked: false, tsconfig: null, diagnostics: [] };
  }
  options = { ...options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined };

  const program = ts.createProgram({ rootNames, options });
  diagnostics.push(...ts.getPreEmitDiagnostics(program));
  return { checked: true, tsconfig: tsconfig ?? null, diagnostics: diagnostics.map((d) => toDiagnostic(d, cwd)) };
}

function toDiagnostic(d: ts.Diagnostic, cwd: string): TypeDiagnostic {
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  if (!d.file || d.start === undefined) return { file: null, line: null, column: null, code: d.code, message };
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  const rel = relative(cwd, d.file.fileName);
  return {
    file: rel.startsWith('..') || isAbsolute(rel) ? d.file.fileName : rel,
    line: line + 1,
    column: character + 1,
    code: d.code,
    message,
  };
}
