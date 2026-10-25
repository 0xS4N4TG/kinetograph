// A HyperFrames project as a composition (README of the loader: `kinetograph render <dir or index.html>`). The CLI reads
// the HTML into a plan (`plan.ts`); this builds the document in the DOM shim, runs the scripts in order, and each frame
//
//   1. seeks the root timeline and every other registered `window.__timelines` entry to its local time,
//   2. shows the clips whose `data-start` window holds the time and hides the others,
//   3. sets the clock of each `<video>` (the engine decodes and draws it) and plays each `<audio>` and audible
//      `<video>` through `<Audio>`.
//
// Nothing here reads a clock: a frame is a function of its number. The document is built once, on the first frame
// (the scripts see layout, as they do in a browser); a render that starts again from an earlier frame builds the
// composition's scene again but not the document, and every frame seeks everything, so the order frames were drawn in
// does not show.

import { type ReactNode } from 'react';
import { Audio } from '@kinetographdev/react';
import { noteStylesheetProblem, registerStylesheet } from '@kinetographdev/compat/dom';
import { Composition, registerRoot } from '../compositions.js';
import { Sequence, useCurrentFrame, useVideoConfig } from '../timeline.js';
import { makeGoogleFont } from '../google-fonts.js';
import { reportUnsupported } from '../unsupported.js';
import type { HfNode, HfPlan } from './plan.js';
import { runGlobalScript, runScopedScript, type ScopeEnv } from './scope.js';
import { applySvgRules, pinSvgFonts } from './svg-style.js';
import {
  isMedia,
  parseNumeric,
  playbackRateOf,
  seekTimelines,
  sourceOffsetOf,
  timelineDuration,
  TimingResolver,
  type SceneClock,
  type TimedElement,
  type TimelineLike,
} from './timing.js';

// The DOM shim has no types here: elements are what a browser script would hold.
type AnyRecord = any;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** What HyperFrames' runtime hides a clip's contents with (a descendant's own `visibility: visible` would escape the clip's). */
const HIDDEN_ATTR = 'data-hf-clip-hidden';

const g = globalThis as AnyRecord;
const doc = (): AnyRecord => g.document;

/**
 * The rules every HyperFrames page gets before its own: what a browser's default stylesheet says of `<body>` (the
 * wrapper elements stand in for `<html>` and `<body>`, which fill the picture so that a background on either paints it; `:where` gives it no specificity, so any rule of the page wins), and the hidden clips' contents.
 */
const baseCss = (plan: HfPlan): string => `
:where(.kg-hf-html) { display: block; width: ${plan.width}px; height: ${plan.height}px; }
:where(.kg-hf-body) { display: block; margin: 8px; min-height: 100%; }
[${HIDDEN_ATTR}], [${HIDDEN_ATTR}] * { visibility: hidden !important; }
`;

/** Declarations of a `style` attribute: split on `;` outside quotes and parentheses. */
export function styleDeclarations(text: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  const flush = (to: number): void => {
    const part = text.slice(from, to);
    const colon = part.indexOf(':');
    if (colon > 0) {
      const name = part.slice(0, colon).trim();
      const value = part.slice(colon + 1).trim();
      if (name !== '' && value !== '') out.push([name, value]);
    }
    from = to + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== '') {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) flush(i);
  }
  flush(text.length);
  return out;
}

function buildNode(node: HfNode, parent: AnyRecord): void {
  if (node.t === 'text') {
    parent.appendChild(doc().createTextNode(node.text));
    return;
  }
  const el = node.svg ? doc().createElementNS(SVG_NS, node.tag) : doc().createElement(node.tag);
  for (const [name, value] of node.attrs) {
    if (name === 'style') {
      for (const [property, v] of styleDeclarations(value)) el.style.setProperty(property, v);
    } else el.setAttribute(name, value);
  }
  for (const child of node.children) buildNode(child, el);
  parent.appendChild(el);
}

function applyAttrs(el: AnyRecord, attrs: [string, string][], extraClass: string): void {
  let classes = extraClass;
  for (const [name, value] of attrs) {
    if (name === 'class') classes = `${extraClass} ${value}`;
    else if (name === 'style') for (const [property, v] of styleDeclarations(value)) el.style.setProperty(property, v);
    else el.setAttribute(name, value);
  }
  el.setAttribute('class', classes);
}

/** A string's quotes and backslashes escaped for an attribute selector. */
const attrValue = (value: string): string => value.replace(/["\\]/g, '\\$&');

/** `family=Name:wght@400;700` axes as the weights to load in each style. */
function fontRequests(plan: HfPlan): { family: string; style: 'normal' | 'italic'; weights: string[] }[] {
  const out: { family: string; style: 'normal' | 'italic'; weights: string[] }[] = [];
  for (const font of plan.googleFonts) {
    for (const style of ['normal', 'italic'] as const) {
      const weights = font.variants
        .filter((v) => (v.endsWith('i') ? 'italic' : 'normal') === style)
        .map((v) => v.replace(/i$/, ''));
      if (weights.length > 0) out.push({ family: font.family, style, weights: [...new Set(weights)] });
    }
  }
  return out;
}

class Runtime {
  private built = false;
  private html!: AnyRecord;
  private root: TimedElement | null = null;
  private readonly timing: TimingResolver;
  private readonly clocks = new Map<string, SceneClock | null>();
  private totalSeconds = 0;

  constructor(private readonly plan: HfPlan) {
    this.timing = new TimingResolver({
      mediaDuration: (el) => {
        const src = this.mediaSource(el as AnyRecord);
        return src === null ? null : (this.plan.mediaDurations[src] ?? null);
      },
      timelineDuration: (id) => timelineDuration((g.__timelines ?? {})[id]),
      byId: (id) => doc().getElementById(id),
      byComposition: (id) => doc().querySelector(`[data-composition-id="${attrValue(id)}"]`),
    });
  }

  private mediaSource(el: AnyRecord): string | null {
    const own = el.getAttribute('src');
    if (own) return own;
    for (const child of Array.from(el.children ?? []) as AnyRecord[]) {
      if (child.tagName.toLowerCase() === 'source' && child.getAttribute('src')) return child.getAttribute('src');
    }
    return null;
  }

  /** Builds the document and runs the scripts, once. */
  setup(): void {
    if (this.built) return;
    this.built = true;
    const { plan } = this;
    g.__timelines = g.__timelines ?? {};
    const report = (message: string): void => noteStylesheetProblem(message);
    g.__hyperframes = {
      getVariables: () => ({ ...(plan.variables[plan.compositionId] ?? {}) }),
      assetUrl: (path: string) => (path.startsWith('/') || /^[a-z]+:/i.test(path) ? path : `${plan.baseDir}/${path}`),
    };
    this.html = doc().createElement('div');
    applyAttrs(this.html, plan.htmlAttrs, 'kg-hf-html');
    const body = doc().createElement('div');
    applyAttrs(body, plan.bodyAttrs, 'kg-hf-body');
    this.html.appendChild(body);
    for (const node of plan.body) buildNode(node, body);
    this.mount();
    this.bindVariables();

    for (const script of plan.scripts) {
      if (script.scope === null) {
        runGlobalScript(script.code, script.file, report);
        continue;
      }
      const scope = script.scope;
      const sourceFile = script.sourceFile;
      const env: ScopeEnv = {
        document: doc(),
        window: g,
        gsap: () => g.gsap,
        root: () => doc().querySelector(`[data-composition-id="${attrValue(scope)}"]`),
        hyperframes: {
          getVariables: () => ({ ...(plan.variables[scope] ?? {}) }),
          assetUrl: (path: string) =>
            path.startsWith('/') || /^[a-z]+:/i.test(path) ? path : `${sourceFile === null ? plan.baseDir : sourceFile.replace(/[/\\][^/\\]*$/, '')}/${path}`,
        },
      };
      runScopedScript(script.code, script.file, env, report);
    }
    // Pages listen for these; in a browser both have fired by the time a render starts.
    for (const target of [g.document, g]) {
      for (const type of ['DOMContentLoaded', 'load']) {
        try {
          target.dispatchEvent(new Event(type));
        } catch (error) {
          report(`${type} handler failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const svgs = Array.from(doc().querySelectorAll('svg')) as AnyRecord[];
    applySvgRules(plan.svgRules, svgs);
    pinSvgFonts(svgs, (el) => g.getComputedStyle(el));
    this.root = doc().querySelector(`[data-composition-id="${attrValue(plan.compositionId)}"]`);
    this.timing.reset();
  }

  /**
   * `data-var-text` and `data-var-src` (HyperFrames' bindings that need no script), and each scalar variable as a CSS
   * custom property on its composition (`var(--accent)`), with the values of the composition the element is in.
   */
  private bindVariables(): void {
    const variables = this.plan.variables;
    const valuesOf = (el: AnyRecord): Record<string, unknown> => {
      for (let p = el; p; p = p.parentElement) {
        const id = p.getAttribute?.('data-composition-id');
        if (id && variables[id]) return variables[id]!;
      }
      return variables[this.plan.compositionId] ?? {};
    };
    const scalar = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
    for (const el of Array.from(doc().querySelectorAll('[data-composition-id]')) as AnyRecord[]) {
      const values = variables[el.getAttribute('data-composition-id')] ?? {};
      for (const [name, value] of Object.entries(values)) {
        const text = scalar(value);
        if (text !== null && /^[\w-]+$/.test(name)) el.style.setProperty(`--${name}`, text);
      }
    }
    for (const el of Array.from(doc().querySelectorAll('[data-var-text]')) as AnyRecord[]) {
      const value = scalar(valuesOf(el)[el.getAttribute('data-var-text')]);
      if (value !== null) el.textContent = value;
    }
    for (const el of Array.from(doc().querySelectorAll('[data-var-src]')) as AnyRecord[]) {
      const raw = valuesOf(el)[el.getAttribute('data-var-src')];
      const value = scalar(raw && typeof raw === 'object' ? ((raw as AnyRecord).url ?? (raw as AnyRecord).src) : raw);
      if (value !== null) el.setAttribute('src', value.startsWith('/') || /^[a-z]+:/i.test(value) ? value : `${this.plan.baseDir}/${value}`);
    }
  }

  /** Puts the document in the scene's body (a render that starts the scene again has a new one). */
  mount(): void {
    if (!this.html.isConnected) doc().body.appendChild(this.html);
  }

  /** The project's length in seconds: `data-duration` of the root, else the longest timeline or clip. */
  seconds(): number {
    if (this.plan.durationSeconds !== null) return this.plan.durationSeconds;
    this.setup();
    let end = timelineDuration((g.__timelines ?? {})[this.plan.compositionId]) ?? 0;
    for (const el of Array.from(doc().querySelectorAll('[data-start]')) as TimedElement[]) {
      const finish = this.timing.end(el);
      if (Number.isFinite(finish)) end = Math.max(end, finish);
    }
    for (const [id, timeline] of Object.entries((g.__timelines ?? {}) as Record<string, TimelineLike>)) {
      const clock = this.clockOf(id);
      const length = timelineDuration(timeline);
      if (clock !== null && length !== null) end = Math.max(end, clock.start + length);
    }
    return end > 0 ? end : 1;
  }

  private clockOf(id: string): SceneClock | null {
    if (this.clocks.has(id)) return this.clocks.get(id) ?? null;
    const host = doc().querySelector(`[data-composition-id="${attrValue(id)}"]`) as AnyRecord | null;
    let clock: SceneClock | null = null;
    if (host !== null) {
      const start = this.timing.start(host);
      const duration = this.timing.duration(host);
      clock = {
        start,
        hiddenFrom: host.hasAttribute('data-start') && duration !== null ? start + duration : Infinity,
        playbackStart: sourceOffsetOf(host),
        rate: playbackRateOf(host),
      };
    }
    this.clocks.set(id, clock);
    return clock;
  }

  /** Brings the document to `time` seconds. */
  seek(time: number, total: number, fps: number): void {
    // Clips first: a hidden clip's contents stay hidden whatever a tween writes (the rule above is `!important`).
    for (const el of Array.from(doc().querySelectorAll('[data-start]')) as AnyRecord[]) {
      const visible = this.timing.visibleAt(el, time, total, this.root);
      const hidden = el.hasAttribute(HIDDEN_ATTR);
      if (!visible) {
        el.style.setProperty('visibility', 'hidden');
        if (!hidden) el.setAttribute(HIDDEN_ATTR, '');
      } else if (hidden) {
        el.style.setProperty('visibility', '');
        el.removeAttribute(HIDDEN_ATTR);
      }
    }
    seekTimelines(g.__timelines ?? {}, this.plan.compositionId, time, (id) => this.clockOf(id));
    for (const el of Array.from(doc().querySelectorAll('video')) as AnyRecord[]) {
      const clock: Record<string, number> = {
        from: this.timing.start(el) * fps,
        trimBefore: sourceOffsetOf(el) * fps,
      };
      const rate = playbackRateOf(el);
      if (rate !== 1) clock.playbackRate = rate;
      el.setAttribute('data-kg-video', JSON.stringify(clock));
    }
  }

  /** `<audio>` and the audible `<video>`s as `<Audio>` in a `<Sequence>` over their window. */
  sounds(fps: number, totalFrames: number): ReactNode[] {
    const out: ReactNode[] = [];
    const media = Array.from(doc().querySelectorAll('audio[data-start], video[data-start]')) as AnyRecord[];
    media.forEach((el, index) => {
      if (!isMedia(el as TimedElement)) return;
      if (el.tagName.toLowerCase() === 'video') {
        const declared = el.getAttribute('data-has-audio');
        if (el.hasAttribute('muted') || (declared !== null && declared !== 'true')) return;
      }
      const src = this.mediaSource(el);
      if (src === null) return;
      const start = this.timing.start(el);
      const duration = this.timing.duration(el);
      const from = Math.max(0, Math.round(start * fps));
      const length = duration === null ? totalFrames - from : Math.max(1, Math.round(duration * fps));
      if (length <= 0 || from >= totalFrames) return;
      const gain = Math.min(3.98, Math.max(0, parseNumeric(el.getAttribute('data-volume')) ?? 1));
      const fadeIn = Math.max(0, parseNumeric(el.getAttribute('data-fade-in')) ?? 0) * fps;
      const fadeOut = Math.max(0, parseNumeric(el.getAttribute('data-fade-out')) ?? 0) * fps;
      // Fades that together exceed the clip are scaled to meet inside it.
      const scale = fadeIn + fadeOut > length ? length / (fadeIn + fadeOut) : 1;
      const volume = (frame: number): number => {
        let v = gain;
        if (fadeIn > 0) v *= Math.min(1, frame / (fadeIn * scale));
        if (fadeOut > 0) v *= Math.min(1, (length - frame) / (fadeOut * scale));
        return Math.max(0, v);
      };
      const key = `${el.id || el.tagName.toLowerCase()}-${index}`;
      out.push(
        <Sequence key={key} layout="none" from={from} durationInFrames={length} name={`hf-${key}`}>
          <Audio src={src} volume={volume} trimBefore={Math.round(sourceOffsetOf(el) * fps)} playbackRate={playbackRateOf(el)} />
        </Sequence>,
      );
    });
    return out;
  }

  /** What the page needs that the engine cannot do, once per frame. */
  reportUnsupported(): void {
    if (this.plan.usesThree) reportUnsupported('three.js', null, null, 'Three.js scenes are not drawn (WebGL is not supported in a HyperFrames project)');
    for (const note of this.plan.notes) reportUnsupported('HyperFrames', null, null, note);
  }
}

export function defineHyperframes(plan: HfPlan): void {
  registerStylesheet(baseCss(plan), 'hyperframes');
  for (const sheet of plan.stylesheets) registerStylesheet(sheet.css, sheet.file);
  for (const request of fontRequests(plan)) {
    try {
      makeGoogleFont(request.family).loadFont(request.style, { weights: request.weights });
    } catch (error) {
      noteStylesheetProblem(`font ${request.family}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const runtime = new Runtime(plan);

  function HyperframesProject(): ReactNode {
    const frame = useCurrentFrame();
    const { fps, durationInFrames } = useVideoConfig();
    runtime.setup();
    runtime.mount();
    // `frame / fps` is exact for a whole frame; a motion-blur sub-frame is fractional.
    runtime.seek(frame / fps, durationInFrames / fps, fps);
    runtime.reportUnsupported();
    return <>{runtime.sounds(fps, durationInFrames)}</>;
  }

  const id = plan.compositionId.replace(/[^a-zA-Z0-9-]/g, '-') || 'main';
  const frames = (seconds: number): number => Math.max(1, Math.ceil(seconds * plan.fps - 1e-6));
  registerRoot(() => (
    <Composition
      id={id}
      component={HyperframesProject}
      width={plan.width}
      height={plan.height}
      fps={plan.fps}
      durationInFrames={plan.durationSeconds === null ? 1 : frames(plan.durationSeconds)}
      calculateMetadata={plan.durationSeconds === null ? () => ({ durationInFrames: frames(runtime.seconds()) }) : undefined}
    />
  ));
}
