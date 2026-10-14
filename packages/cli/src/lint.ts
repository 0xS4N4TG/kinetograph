import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AudioClipJson, LayerJson, SceneJson } from '@kinetograph/scene';
import type { InspectLayer, InspectResult } from './native.js';

export interface Finding {
  rule: string;
  severity: 'error' | 'warning';
  /** The layer's id, or null for a finding about the scene or an audio clip. */
  layer: string | null;
  message: string;
}

export interface LintIssue extends Finding {
  /** Every checked frame the finding holds at. */
  frames: number[];
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const TOLERANCE = 1; // px: anti-aliasing and rounding

/** The box of a layer on the canvas: its own box through its matrix, or its bounds if it has no box. */
function canvasRect(layer: InspectLayer): Rect | null {
  if (layer.box) {
    const [a, b, c, d, e, f] = layer.matrix;
    const { x, y, width, height } = layer.box;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [px, py] of [[x, y], [x + width, y], [x, y + height], [x + width, y + height]] as const) {
      xs.push(a * px + c * py + e);
      ys.push(b * px + d * py + f);
    }
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  }
  if (layer.bounds) {
    const { x, y, width, height } = layer.bounds;
    return { left: x, top: y, right: x + width, bottom: y + height };
  }
  return null;
}

const area = (r: Rect): number => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

function overlapArea(a: Rect, b: Rect): number {
  return area({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
}

function flatten(layers: InspectLayer[], into: InspectLayer[] = []): InspectLayer[] {
  for (const layer of layers) {
    into.push(layer);
    if (layer.children) flatten(layer.children, into);
  }
  return into;
}

/** The findings that one frame's `InspectResult` shows: text that overflows, layers off the canvas, overlapping text. */
export function lintInspect(result: InspectResult): Finding[] {
  const findings: Finding[] = [];
  const canvas: Rect = { left: 0, top: 0, right: result.width, bottom: result.height };
  const layers = flatten(result.layers).filter((l) => l.opacity > 0 && !l.matteSource);
  const texts: { layer: InspectLayer; rect: Rect }[] = [];

  for (const layer of layers) {
    if (layer.type === 'group') continue;
    const rect = canvasRect(layer);

    if (layer.type === 'text' && layer.text) {
      const { maxWidth, width, lines } = layer.text;
      if (maxWidth !== null && width > maxWidth + TOLERANCE) {
        findings.push({
          rule: 'text-overflow-box',
          severity: 'error',
          layer: layer.id,
          message: `text is ${Math.round(width)} px wide but its maxWidth is ${maxWidth} (a word is too long to wrap)`,
        });
      }
      if (rect && lines.length > 0) {
        const beyond: string[] = [];
        if (rect.left < canvas.left - TOLERANCE) beyond.push(`${Math.round(canvas.left - rect.left)} px past the left edge`);
        if (rect.right > canvas.right + TOLERANCE) beyond.push(`${Math.round(rect.right - canvas.right)} px past the right edge`);
        if (rect.top < canvas.top - TOLERANCE) beyond.push(`${Math.round(canvas.top - rect.top)} px past the top edge`);
        if (rect.bottom > canvas.bottom + TOLERANCE) beyond.push(`${Math.round(rect.bottom - canvas.bottom)} px past the bottom edge`);
        if (beyond.length > 0 && overlapArea(rect, canvas) > 0) {
          findings.push({
            rule: 'text-overflow-canvas',
            severity: 'error',
            layer: layer.id,
            message: `text runs ${beyond.join(', ')}`,
          });
        }
      }
      if (rect) texts.push({ layer, rect });
    }

    // Where its pixels can be, as the renderer places them (3D turns, the turn of a group it is inside, effects),
    // which the flat box through the 2D matrix does not know.
    const seen = layer.bounds
      ? { left: layer.bounds.x, top: layer.bounds.y, right: layer.bounds.x + layer.bounds.width, bottom: layer.bounds.y + layer.bounds.height }
      : rect;
    if (seen && overlapArea(seen, canvas) === 0) {
      findings.push({
        rule: 'off-canvas',
        severity: 'warning',
        layer: layer.id,
        message: `${layer.type} layer is completely outside the ${result.width}x${result.height} canvas`,
      });
    }
  }

  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;
      const smaller = Math.min(area(a.rect), area(b.rect));
      if (smaller > 0 && overlapArea(a.rect, b.rect) > 0.25 * smaller) {
        findings.push({
          rule: 'text-overlap',
          severity: 'warning',
          layer: a.layer.id,
          message: `text overlaps the text of "${b.layer.id}"`,
        });
      }
    }
  }
  return findings;
}

function walk(layers: LayerJson[], visit: (layer: LayerJson) => void): void {
  for (const layer of layers) {
    visit(layer);
    if (layer.type === 'group') walk(layer.children, visit);
  }
}

/** Missing fonts and assets in a frame's scene: what the scene names that is not there. */
export function lintScene(scene: SceneJson, baseDir: string, exists: (path: string) => boolean = existsSync): Finding[] {
  const findings: Finding[] = [];
  const fonts = scene.fonts ?? {};
  for (const [key, path] of Object.entries(fonts)) {
    if (!exists(resolve(baseDir, path))) {
      findings.push({ rule: 'missing-font', severity: 'error', layer: null, message: `font "${key}": no file at ${path}` });
    }
  }
  const asset = (layer: string, kind: string, src: string): void => {
    if (!exists(resolve(baseDir, src))) {
      findings.push({ rule: 'missing-asset', severity: 'error', layer, message: `${kind} file not found: ${src}` });
    }
  };
  walk(scene.layers, (layer) => {
    if (layer.type === 'text' && !(layer.font in fonts)) {
      findings.push({
        rule: 'missing-font',
        severity: 'error',
        layer: layer.id,
        message: `font "${layer.font}" is not registered (registered: ${Object.keys(fonts).join(', ') || 'none'})`,
      });
    }
    if (layer.type === 'image' || layer.type === 'lottie') asset(layer.id, layer.type, layer.src);
    for (const effect of layer.effects ?? []) {
      if (effect.type === 'lut' && typeof effect.src === 'string') asset(layer.id, 'lut', effect.src);
    }
  });
  return findings;
}

/** `<Audio>` clips whose file is missing. */
export function lintAudio(clips: AudioClipJson[], baseDir: string, exists: (path: string) => boolean = existsSync): Finding[] {
  return clips
    .filter((clip) => !exists(resolve(baseDir, clip.src)))
    .map((clip) => ({
      rule: 'missing-asset',
      severity: 'error' as const,
      layer: clip.id,
      message: `audio file not found: ${clip.src}`,
    }));
}

/** One issue per distinct finding, with every frame it was seen at; errors first. */
export function mergeFindings(perFrame: { frame: number; findings: Finding[] }[]): LintIssue[] {
  const issues = new Map<string, LintIssue>();
  for (const { frame, findings } of perFrame) {
    for (const f of findings) {
      const key = JSON.stringify([f.rule, f.layer, f.message]);
      const issue = issues.get(key) ?? { ...f, frames: [] };
      if (!issue.frames.includes(frame)) issue.frames.push(frame);
      issues.set(key, issue);
    }
  }
  return [...issues.values()].sort(
    (a, b) => Number(b.severity === 'error') - Number(a.severity === 'error') || (a.frames[0]! - b.frames[0]!),
  );
}
