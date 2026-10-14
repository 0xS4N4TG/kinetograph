import type { SceneJson } from '@kinetograph/scene';
import { parseFrameList } from '../args.js';
import { toErrorObject } from '../errors.js';
import { lintAudio, lintInspect, lintScene, mergeFindings, type Finding } from '../lint.js';
import { native, type InspectLayer, type InspectResult } from '../native.js';
import { checkFrame, evenFrames } from '../source.js';
import { ENTRY, openFromArgs, type Command } from './types.js';

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
  summary: 'Text overflowing its box or the canvas, layers off the canvas, overlapping text, missing fonts and assets',
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

      const perFrame: { frame: number; findings: Finding[] }[] = [];
      for (const frame of frames) {
        const { sceneJson, audio } = await source.frame(frame);
        const findings = [
          ...lintScene(JSON.parse(sceneJson) as SceneJson, source.baseDir),
          ...lintAudio(audio, source.baseDir),
        ];
        try {
          findings.push(...lintInspect(JSON.parse(native().inspect(sceneJson, frame, source.baseDir)) as InspectResult));
        } catch (error) {
          // Usually the missing font or file already found above; the addon's text says where it stopped.
          findings.push({ rule: 'inspect-failed', severity: 'error', layer: null, message: toErrorObject(error).message });
        }
        perFrame.push({ frame, findings });
      }
      const issues = mergeFindings(perFrame);
      const errors = issues.filter((i) => i.severity === 'error').length;
      const warnings = issues.length - errors;
      const text = issues.length
        ? issues
            .map((i) => `${i.severity} ${i.rule}${i.layer ? ` [${i.layer}]` : ''} at frame${i.frames.length > 1 ? 's' : ''} ${i.frames.join(', ')}: ${i.message}`)
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
