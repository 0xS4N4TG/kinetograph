import { existsSync } from 'node:fs';
import type { SceneJson, Unsupported } from '@kinetograph/scene';
import { parseFrameList } from '../args.js';
import { toErrorObject } from '../errors.js';
import { lintAudio, lintCompat, lintInspect, lintNotes, lintScene, mergeFindings, sortIssues, textInsideCanvas, type Finding } from '../lint.js';
import { native, type InspectLayer, type InspectResult } from '../native.js';
import { checkFrame, evenFrames } from '../source.js';
import { typeCheck, type TypeDiagnostic } from '../typecheck.js';
import { ENTRY, openFromArgs, type Command } from './types.js';

const describeDiagnostic = (d: TypeDiagnostic): string =>
  `${d.file ? `${d.file}${d.line ? `:${d.line}:${d.column}` : ''}: ` : ''}TS${d.code}: ${d.message}`;

export const check: Command = {
  name: 'check',
  summary: 'Type errors in the project (tsc --noEmit), such as a misspelled prop that renders without an error',
  project: false,
  positionals: [ENTRY],
  options: [],
  async run(args) {
    const result = typeCheck(String(args.positionals.entry));
    const errors = result.diagnostics.length;
    const text = !result.checked
      ? 'nothing to type-check (a scene file, or JavaScript with no tsconfig.json)'
      : errors
        ? result.diagnostics.map(describeDiagnostic).join('\n') + `\n${errors} type errors`
        : 'no type errors';
    return { data: { ok: errors === 0, ...result, errors }, text, exitCode: errors > 0 ? 1 : 0 };
  },
};

export const inspect: Command = {
  name: 'inspect',
  summary: 'The scene graph at a frame: layers, bounds and resolved styles',
  project: true,
  positionals: [ENTRY],
  options: [{ name: 'frame', type: 'number', description: 'Frame number (default 0)' }],
  async run(args) {
    const source = await openFromArgs(args);
    try {
      const frame = checkFrame((args.options.frame as number | undefined) ?? 0, source.composition.durationInFrames);
      const { sceneJson } = await source.frame(frame);
      const result = JSON.parse(native().inspect(sceneJson, frame, source.baseDir)) as InspectResult;
      return { data: result, text: describe(result) };
    } finally {
      source.dispose();
    }
  },
};

function describe(result: InspectResult): string {
  const lines = [
    `${result.width}x${result.height}  ${result.fps} fps  frame ${result.frame}/${result.durationInFrames}` +
      (result.camera ? `  camera perspective ${result.camera.perspective}` : ''),
  ];
  const walk = (layers: InspectLayer[], depth: number): void => {
    for (const layer of layers) {
      const b = layer.bounds;
      const at = b ? ` [${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}]` : '';
      const extra = [
        layer.opacity !== 1 ? `opacity ${layer.opacity}` : '',
        layer.blendMode !== 'normal' ? layer.blendMode : '',
        layer.effects.length ? `effects ${layer.effects.join('+')}` : '',
        layer.text ? `"${layer.text.text.replace(/\n/g, '\\n')}" ${layer.text.font} ${layer.text.size}px` : '',
        layer.src ? layer.src : '',
      ].filter(Boolean);
      lines.push(`${'  '.repeat(depth + 1)}${layer.id} (${layer.type})${at}${extra.length ? '  ' + extra.join('  ') : ''}`);
      if (layer.children) walk(layer.children, depth + 1);
    }
  };
  walk(result.layers, 0);
  return lines.join('\n');
}

export const lint: Command = {
  name: 'lint',
  summary: 'Text overflowing its box or the canvas, layers off the canvas, overlapping text, missing fonts and assets, type errors, and what compat mode cannot draw',
  project: true,
  positionals: [ENTRY],
  options: [{ name: 'frames', type: 'string', description: 'Frames to check, comma separated (default 8 spread over the composition)' }],
  async run(args) {
    const source = await openFromArgs(args);
    try {
      const { durationInFrames } = source.composition;
      const frames = (
        args.options.frames === undefined
          ? evenFrames(0, durationInFrames - 1, 8)
          : parseFrameList('--frames', String(args.options.frames))
      )
        .map((f) => checkFrame(f, durationInFrames))
        .sort((a, b) => a - b);

      const perFrame: { frame: number; findings: Finding[]; inside: string[] }[] = [];
      const unsupportedFrames: { frame: number; unsupported: Unsupported[] }[] = [];
      for (const frame of frames) {
        const { sceneJson, audio, unsupported } = await source.frame(frame);
        unsupportedFrames.push({ frame, unsupported: unsupported ?? [] });
        const findings = [
          ...lintScene(JSON.parse(sceneJson) as SceneJson, source.baseDir),
          ...lintAudio(audio, source.baseDir),
        ];
        let inside: string[] = [];
        try {
          const inspected = JSON.parse(native().inspect(sceneJson, frame, source.baseDir)) as InspectResult;
          findings.push(...lintInspect(inspected));
          inside = textInsideCanvas(inspected);
        } catch (error) {
          // Usually the missing font or file already found above; the addon's text says where it stopped.
          findings.push({ rule: 'inspect-failed', severity: 'error', layer: null, message: toErrorObject(error).message });
        }
        perFrame.push({ frame, findings, inside });
      }
      // The entry can be a stand-in (tests); a file that is not there has no types to check.
      const entry = String(args.positionals.entry);
      const types = existsSync(entry) ? typeCheck(entry).diagnostics : [];
      const typeIssues = types.map((d) => ({
        rule: 'type-error',
        severity: 'error' as const,
        layer: null,
        message: describeDiagnostic(d),
        frames: [],
      }));
      const issues = sortIssues([...mergeFindings(perFrame), ...lintCompat(unsupportedFrames), ...lintNotes(source.notes?.() ?? []), ...typeIssues]);
      const errors = issues.filter((i) => i.severity === 'error').length;
      const warnings = issues.length - errors;
      const text = issues.length
        ? issues
            .map((i) => {
              const at = i.frames.length ? ` at frame${i.frames.length > 1 ? 's' : ''} ${i.frames.join(', ')}` : '';
              return `${i.severity} ${i.rule}${i.layer ? ` [${i.layer}]` : ''}${at}: ${i.message}`;
            })
            .join('\n') + `\n${errors} errors, ${warnings} warnings`
        : `no issues (frames ${frames.join(', ')})`;
      return {
        data: { ok: errors === 0, errors, warnings, framesChecked: frames, issues },
        text,
        exitCode: errors > 0 ? 1 : 0,
      };
    } finally {
      source.dispose();
    }
  },
};
