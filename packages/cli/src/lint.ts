import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeIssue, summarize } from '@kinetographdev/compat/doctor';
import { isSfxUrl } from '@kinetographdev/core/sound-source';
import type { AudioClipJson, LayerJson, SceneJson, Unsupported } from '@kinetographdev/scene';
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

const intersect = (a: Rect | null, b: Rect | null): Rect | null =>
  !a ? b : !b ? a : {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };

/** A layer a frame can show, with what bounds it: its opacity through its ancestors and the clips of all of them. */
interface Seen {
  layer: InspectLayer;
  opacity: number;
  clip: Rect | null;
}

/**
 * The layers a frame can show, in tree order. A layer at opacity 0 is skipped with its subtree, which is the same as
 * its opacity times its ancestors' being 0. A layer whose pixels all fall outside its own clip and its ancestors' is
 * skipped too: nothing of it is drawn. Matte sources are not drawn, so they are left out as well.
 */
function visibleLayers(layers: InspectLayer[], clip: Rect | null = null, opacity = 1, into: Seen[] = []): Seen[] {
  for (const layer of layers) {
    if (layer.opacity <= 0) continue;
    const c = layer.clipBounds;
    const within = intersect(clip, c && { left: c.x, top: c.y, right: c.x + c.width, bottom: c.y + c.height });
    if (layer.type !== 'group') {
      const b = layer.bounds;
      const seen = b ? { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height } : canvasRect(layer);
      if (within && seen && overlapArea(seen, within) === 0) continue;
    }
    const effective = opacity * layer.opacity;
    if (!layer.matteSource) into.push({ layer, opacity: effective, clip: within });
    if (layer.children) visibleLayers(layer.children, within, effective, into);
  }
  return into;
}

/** How far text may run past the canvas, per side, before it is reported (anti-aliasing and rounding). */
function beyondCanvas(rect: Rect, canvas: Rect): string[] {
  const beyond: string[] = [];
  if (rect.left < canvas.left - TOLERANCE) beyond.push(`${Math.round(canvas.left - rect.left)} px past the left edge`);
  if (rect.right > canvas.right + TOLERANCE) beyond.push(`${Math.round(rect.right - canvas.right)} px past the right edge`);
  if (rect.top < canvas.top - TOLERANCE) beyond.push(`${Math.round(canvas.top - rect.top)} px past the top edge`);
  if (rect.bottom > canvas.bottom + TOLERANCE) beyond.push(`${Math.round(rect.bottom - canvas.bottom)} px past the bottom edge`);
  return beyond;
}

/** The part of a text's box that is drawn: its own box through its matrix, cut by the clips around it. Null: none of it. */
function shownRect(entry: Seen): Rect | null {
  const rect = canvasRect(entry.layer);
  if (!rect) return null;
  const shown = intersect(rect, entry.clip);
  return shown && area(shown) > 0 ? shown : null;
}

/** Text under this opacity (through its ancestors) is fading in or out: layered with other text on purpose. */
const SETTLED = 0.99;

const sameText = (a: InspectLayer, b: InspectLayer): boolean =>
  a.text !== undefined && b.text !== undefined && a.text.text.trim() === b.text.text.trim();

/** The findings that one frame's `InspectResult` shows: text that overflows, layers off the canvas, overlapping text. */
export function lintInspect(result: InspectResult): Finding[] {
  const findings: Finding[] = [];
  const canvas: Rect = { left: 0, top: 0, right: result.width, bottom: result.height };
  const seen = visibleLayers(result.layers);
  const texts: { entry: Seen; rect: Rect }[] = [];

  for (const entry of seen) {
    const { layer } = entry;
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
      // Only what is drawn counts: text clipped by a box around it (a ticker, a scroller) does not run past anything.
      const shown = lines.length > 0 ? shownRect(entry) : null;
      if (shown) {
        const beyond = beyondCanvas(shown, canvas);
        if (beyond.length > 0 && overlapArea(shown, canvas) > 0) {
          findings.push({
            rule: 'text-overflow-canvas',
            severity: 'error',
            layer: layer.id,
            message: `text runs ${beyond.join(', ')}`,
          });
        }
      }
      const drawn = shownRect(entry);
      if (drawn) texts.push({ entry, rect: drawn });
    }

    // Where its pixels can be, as the renderer places them (3D turns, the turn of a group it is inside, effects),
    // which the flat box through the 2D matrix does not know.
    const placed = layer.bounds
      ? { left: layer.bounds.x, top: layer.bounds.y, right: layer.bounds.x + layer.bounds.width, bottom: layer.bounds.y + layer.bounds.height }
      : rect;
    const where = intersect(placed, entry.clip);
    if (where && overlapArea(where, canvas) === 0) {
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
      // Text layered on purpose: fading in or out (a cross-fade, a swap), blended, or the same words twice (an outline,
      // a shadow, a glitch). Only settled, plain, different text on top of each other is a mistake.
      if (a.entry.opacity < SETTLED || b.entry.opacity < SETTLED) continue;
      if (a.entry.layer.blendMode !== 'normal' || b.entry.layer.blendMode !== 'normal') continue;
      if (sameText(a.entry.layer, b.entry.layer)) continue;
      const smaller = Math.min(area(a.rect), area(b.rect));
      if (smaller > 0 && overlapArea(a.rect, b.rect) > 0.25 * smaller) {
        findings.push({
          rule: 'text-overlap',
          severity: 'warning',
          layer: a.entry.layer.id,
          message: `text overlaps the text of "${b.entry.layer.id}"`,
        });
      }
    }
  }
  return findings;
}

/** The ids of the text layers drawn in this frame that are entirely inside the canvas. */
export function textInsideCanvas(result: InspectResult): string[] {
  const canvas: Rect = { left: 0, top: 0, right: result.width, bottom: result.height };
  const ids: string[] = [];
  for (const entry of visibleLayers(result.layers)) {
    if (entry.layer.type !== 'text' || !entry.layer.text || entry.layer.text.lines.length === 0) continue;
    const shown = shownRect(entry);
    if (shown && beyondCanvas(shown, canvas).length === 0) ids.push(entry.layer.id);
  }
  return ids;
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
    // A text layer of glyph runs (the DOM painter's) names font files in its runs, not a registered key.
    const runs = (layer as { runs?: { src: string }[] }).runs;
    if (layer.type === 'text' && Array.isArray(runs) && runs.length > 0) {
      for (const run of runs) asset(layer.id, 'font', run.src);
    } else if (layer.type === 'text' && !(layer.font in fonts)) {
      findings.push({
        rule: 'missing-font',
        severity: 'error',
        layer: layer.id,
        message: `font "${layer.font}" is not registered (registered: ${Object.keys(fonts).join(', ') || 'none'})`,
      });
    }
    if (layer.type === 'image' || layer.type === 'lottie' || layer.type === 'video' || layer.type === 'gif') {
      asset(layer.id, layer.type, layer.src);
    }
    for (const effect of layer.effects ?? []) {
      if (effect.type === 'lut' && typeof effect.src === 'string') asset(layer.id, 'lut', effect.src);
    }
  });
  return findings;
}

/**
 * `<Audio>` clips whose file is missing. A `<Video>`'s sound is left out: its layer reports the missing file. The URL of
 * an `@remotion/sfx` sound is not a file yet: it is downloaded when the audio is mixed.
 */
export function lintAudio(clips: AudioClipJson[], baseDir: string, exists: (path: string) => boolean = existsSync): Finding[] {
  return clips
    .filter((clip) => !clip.video && !isSfxUrl(clip.src) && !exists(resolve(baseDir, clip.src)))
    .map((clip) => ({
      rule: 'missing-asset',
      severity: 'error' as const,
      layer: clip.id,
      message: `audio file not found: ${clip.src}`,
    }));
}

/** Sorts in place: errors first, then by the first frame each was seen at. */
export function sortIssues(issues: LintIssue[]): LintIssue[] {
  return issues.sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error') || (a.frames[0]! - b.frames[0]!));
}

/**
 * One issue per distinct finding, with every frame it was seen at; errors first. How far text runs past the canvas
 * changes from frame to frame as it moves, so those are one issue per layer. `inside` lists the text layers a frame
 * draws entirely inside the canvas: a layer that overflows in some frames and is inside in others is moving in or out
 * (a slide, a pan), which is a warning and not an error.
 */
export function mergeFindings(perFrame: { frame: number; findings: Finding[]; inside?: readonly string[] }[]): LintIssue[] {
  const issues = new Map<string, LintIssue>();
  for (const { frame, findings } of perFrame) {
    for (const f of findings) {
      const shape = f.rule === 'text-overflow-canvas' ? f.message.replace(/\d+/g, '#') : f.message;
      const key = JSON.stringify([f.rule, f.layer, shape]);
      const issue = issues.get(key) ?? { ...f, frames: [] };
      if (!issue.frames.includes(frame)) issue.frames.push(frame);
      issues.set(key, issue);
    }
  }
  for (const issue of issues.values()) {
    if (issue.rule !== 'text-overflow-canvas') continue;
    const inside = perFrame.filter((f) => f.inside?.includes(issue.layer ?? '') && !issue.frames.includes(f.frame)).map((f) => f.frame);
    if (inside.length > 0) {
      issue.severity = 'warning';
      issue.message += ` (inside the canvas at frame${inside.length > 1 ? 's' : ''} ${inside.join(', ')}, so it is moving in or out)`;
    }
  }
  return sortIssues([...issues.values()]);
}

/**
 * What the engine cannot draw in the checked frames (kinetograph site, /docs/compat/): one warning per issue group of
 * `kinetograph doctor`, since the frame still renders, without it or approximated. The ranges are of the checked
 * frames only.
 */
export function lintCompat(perFrame: { frame: number; unsupported: readonly Unsupported[] }[]): LintIssue[] {
  return summarize('', perFrame).issues.map((issue) => {
    const frames = issue.ranges.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => first + i));
    const values = issue.values.length > 0 ? ` (${issue.values.join('; ')})` : '';
    return {
      rule: 'compat',
      severity: 'warning' as const,
      layer: null,
      message: `not supported, so the frame is drawn without it or approximated: ${describeIssue(issue)}${values} at ${issue.paths.join(', ')}`,
      frames,
    };
  });
}

/**
 * What the project says went wrong outside any frame: a stylesheet that could not be built, a font that did not
 * download. They are what `doctor` prints under "stylesheets"; a warning here, since the text that needed a missing
 * font is already an error (`missing-font`).
 */
export function lintNotes(notes: readonly string[]): LintIssue[] {
  return notes.map((message) => ({ rule: 'project-note', severity: 'warning' as const, layer: null, message, frames: [] }));
}
