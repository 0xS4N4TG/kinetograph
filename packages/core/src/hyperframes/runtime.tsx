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
import { Audio, createSceneRoot } from '@kinetographdev/react';
import { noteStylesheetProblem, registerStylesheet } from '@kinetographdev/compat/dom';
import { setRefusedFetchHandler, setRemoteFiles, whenFetchesSettle } from '@kinetographdev/compat/shim';
import { continueRender, delayRender } from '../assets.js';
import { Composition, registerRoot } from '../compositions.js';
import { Sequence, useCurrentFrame, useVideoConfig } from '../timeline.js';
import { finishFontLoadsSync, getFonts } from '../font-registry.js';
import { makeGoogleFont } from '../google-fonts.js';
import { reportUnsupported } from '../unsupported.js';
import type { HfNode, HfPlan } from './plan.js';
import { runGlobalScript, runScopedScript, type ScopeEnv } from './scope.js';
import { laneGain, MAX_GAIN, parseAutomation, sourceTimeAt, type AutomationLane } from './automation.js';
import { ANIMATED_EFFECT_LIMITS, gradeAttribute, gradeNotDrawn, normalizeGrade, seedOf } from './grading.js';
import {
  cutToSlots,
  isMedia,
  parseNumeric,
  rateSpecOf,
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
 * The rules every HyperFrames page gets before its own: what a browser's default stylesheet says of `<body>`, except its 8px margin (HyperFrames renders pages flush) (the
 * wrapper elements stand in for `<html>` and `<body>`, which fill the picture so that a background on either paints it; `:where` gives it no specificity, so any rule of the page wins), and the hidden clips' contents.
 */
const baseCss = (plan: HfPlan): string => `
:where(.kg-hf-html) { display: block; width: ${plan.width}px; height: ${plan.height}px; }
:where(.kg-hf-body) { display: block; margin: 0; min-height: 100%; }
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
  if (node.content !== undefined) defineTemplateContent(el, node.content);
  parent.appendChild(el);
}

/**
 * `template.content`: the nodes of the template, kept out of the document. A browser's `DocumentFragment` has no
 * counterpart in the DOM shim, so `content.cloneNode(true)` is an `hf-fragment` element with `display: contents`
 * holding the clones, which lays out as its children do, and `content` itself is a detached holder with the nodes.
 */
function defineTemplateContent(template: AnyRecord, nodes: HfNode[]): void {
  const holder = doc().createElement('div');
  for (const child of nodes) buildNode(child, holder);
  holder.cloneNode = (deep = true): AnyRecord => {
    const fragment = doc().createElement('hf-fragment');
    fragment.style.setProperty('display', 'contents');
    for (const child of Array.from(holder.childNodes) as AnyRecord[]) fragment.appendChild(child.cloneNode(deep));
    return fragment;
  };
  Object.defineProperty(template, 'content', { configurable: true, get: () => holder });
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
export function fontRequests(plan: HfPlan): { family: string; style: 'normal' | 'italic'; weights: string[]; as: string[]; cacheOnly: boolean }[] {
  const out: { family: string; style: 'normal' | 'italic'; weights: string[]; as: string[]; cacheOnly: boolean }[] = [];
  for (const font of plan.googleFonts) {
    for (const style of ['normal', 'italic'] as const) {
      const weights = font.variants
        .filter((v) => (v.endsWith('i') ? 'italic' : 'normal') === style)
        .map((v) => v.replace(/i$/, ''));
      if (weights.length > 0) out.push({ family: font.family, style, weights: [...new Set(weights)], as: font.as ?? [], cacheOnly: font.cacheOnly === true });
    }
  }
  return out;
}

/** The download of a family that is read from the cache only: a miss says what to run. */
const cacheOnlyFetch = (family: string) => (): never => {
  throw new Error(`the font ${family} is not in the font cache; run \`kinetograph fetch-deps\` on the project once (fonts are never downloaded while rendering)`);
};

class Runtime {
  private built = false;
  private html!: AnyRecord;
  private root: TimedElement | null = null;
  private readonly timing: TimingResolver;
  private readonly clocks = new Map<string, SceneClock | null>();
  private totalSeconds = 0;
  /** Why a page's own drawing failed (a rejected `hf-seek` promise or `__hf.buildReady` entry), reported with every frame. */
  private readonly failures = new Set<string>();
  /** What `display` a `[data-hidden]` clip had before the runtime hid it (HyperFrames' displayBeforeHide). */
  private readonly displayBeforeHide = new WeakMap<AnyRecord, string>();
  /** What the grades of the frame ask for and are not drawn. */
  private gradingNotes: string[] = [];
  private seekFailures: string[] = [];
  private readonly scriptFailures: string[] = [];
  /** Done when what the scripts fetched has been drawn. */
  private settling: Promise<void> | null = null;
  private held = false;

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
    // A script that failed, or a handler that threw, is a note in `doctor` and a report on every frame (`--strict` fails on it).
    const report = (message: string): void => {
      noteStylesheetProblem(message);
      this.scriptFailures.push(message);
    };
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
    for (const [name, ready] of Object.entries((g.__hf?.buildReady ?? {}) as Record<string, unknown>)) {
      if (ready && typeof (ready as Promise<unknown>).then === 'function') {
        (ready as Promise<unknown>).then(undefined, (error: unknown) => {
          this.failures.add(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
    this.afterScripts();
    // A page that draws from what it fetched (`d3.json(url).then(...)`) is not done when its scripts return.
    this.settling = whenFetchesSettle().then(() => this.afterScripts());
  }

  /** What follows the scripts, run again once what they fetched has been drawn. */
  private afterScripts(): void {
    const { plan } = this;
    this.root = doc().querySelector(`[data-composition-id="${attrValue(plan.compositionId)}"]`);
    this.timing.reset();
    this.clocks.clear();
  }

  /** The variables of the composition `el` is in (the root's, outside any). */
  private variablesFor(el: AnyRecord): Record<string, unknown> {
    const variables = this.plan.variables;
    for (let p = el; p; p = p.parentElement) {
      const id = p.getAttribute?.('data-composition-id');
      if (id && variables[id]) return variables[id]!;
    }
    return variables[this.plan.compositionId] ?? {};
  }

  /** The frame waits for what the page fetched at load (once). */
  holdForPage(): void {
    if (this.settling === null || this.held) return;
    this.held = true;
    const handle = delayRender('HyperFrames page scripts');
    void this.settling.then(
      () => continueRender(handle),
      () => continueRender(handle),
    );
  }

  /**
   * `data-var-text` and `data-var-src` (HyperFrames' bindings that need no script), and each scalar variable as a CSS
   * custom property on its composition (`var(--accent)`), with the values of the composition the element is in.
   */
  private bindVariables(): void {
    const variables = this.plan.variables;
    const valuesOf = (el: AnyRecord): Record<string, unknown> => this.variablesFor(el);
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

  /**
   * The project's length in seconds: `data-duration` of the root, else the longest timeline or clip. Without a
   * `data-duration` the scripts run here, before any frame: in a root of their own that has layout, so that a script
   * that measures (`getBoundingClientRect`, `getComputedStyle`) finds what it would in a browser. The document goes to
   * the frames' root on the first frame (`mount`).
   */
  async seconds(): Promise<number> {
    if (this.plan.durationSeconds !== null) return this.plan.durationSeconds;
    if (!this.built) {
      const root = createSceneRoot({ viewport: { width: this.plan.width, height: this.plan.height }, fonts: () => getFonts(), time: () => 0 });
      try {
        // Text is not measured before its fonts are registered.
        finishFontLoadsSync();
        this.setup();
        this.html.parentNode?.removeChild(this.html);
      } finally {
        root.unmount();
      }
    }
    this.setup();
    await this.settling;
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
        rate: rateSpecOf(host),
      };
    }
    this.clocks.set(id, clock);
    return clock;
  }

  /** `display: none` for a clip with `data-hidden`, remembering the author's value (runtime/init.ts: hideByDisplay). */
  private hideByDisplay(el: AnyRecord): void {
    if (!this.displayBeforeHide.has(el)) this.displayBeforeHide.set(el, el.style.getPropertyValue('display'));
    if (el.style.getPropertyValue('display') !== 'none') el.style.setProperty('display', 'none');
  }

  /** The author's `display` back once the flag is gone (runtime/init.ts: restoreDisplay). */
  private restoreDisplay(el: AnyRecord): void {
    const before = this.displayBeforeHide.get(el);
    if (before === undefined) return;
    this.displayBeforeHide.delete(el);
    if (before !== '') el.style.setProperty('display', before);
    else el.style.removeProperty('display');
  }

  /** Brings the document to `time` seconds. */
  seek(time: number, total: number, fps: number): void {
    // Clips first: a hidden clip's contents stay hidden whatever a tween writes (the rule above is `!important`).
    for (const el of Array.from(doc().querySelectorAll('[data-start]')) as AnyRecord[]) {
      // `data-hidden` takes the clip out of the picture and leaves the rest of the pass to a clip that is not (runtime/init.ts:3094).
      if (el.hasAttribute('data-hidden')) {
        this.hideByDisplay(el);
        continue;
      }
      this.restoreDisplay(el);
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
    this.seekFailures = [];
    seekTimelines(g.__timelines ?? {}, this.plan.compositionId, time, (id) => this.clockOf(id), false, (message) => this.seekFailures.push(message));
    this.announceSeek(time);
    for (const el of Array.from(doc().querySelectorAll('video')) as AnyRecord[]) {
      const start = this.timing.start(el);
      const rate = rateSpecOf(el);
      const clock: Record<string, number> = { from: start * fps, trimBefore: sourceOffsetOf(el) * fps };
      if (typeof rate === 'number') {
        if (rate !== 1) clock.playbackRate = rate;
      } else {
        // A speed ramp: the file's time is the integral of the rate over the clip's own time (frameSources.ts:142). The
        // engine's clock is linear, so it is handed the frame at which a plain clip would show that time.
        clock.frame = start * fps + sourceTimeAt(rate, Math.max(0, time - start)) * fps;
      }
      el.setAttribute('data-kg-video', JSON.stringify(clock));
      // The file's time at this instant, as a browser's seek leaves it: `drawImage(video)` reads the frame it names.
      const into = Math.max(0, time - start);
      el.currentTime = sourceOffsetOf(el) + (typeof rate === 'number' ? into * rate : sourceTimeAt(rate, into));
    }
    this.applyGrading(time);
  }

  /** The animated values a tween leaves on an element (`--hf-color-grading-intensity`, `-lut-intensity`, `-exposure`). */
  private animatedGrade(el: AnyRecord): {
    intensity: number | null;
    lutIntensity: number | null;
    exposure: number | null;
    effects: Record<string, number | null>;
  } {
    const read = (name: string, lo: number, hi: number): number | null => {
      const text = String(el.style.getPropertyValue(name)).trim();
      const n = Number(text);
      return text !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
    };
    return {
      intensity: read('--hf-color-grading-intensity', 0, 1),
      lutIntensity: read('--hf-color-grading-lut-intensity', 0, 1),
      exposure: read('--hf-color-grading-exposure', -2, 2),
      effects: Object.fromEntries(
        Object.entries(ANIMATED_EFFECT_LIMITS).map(([key, hi]) => [key, read(`--hf-color-grading-${key}`, 0, hi)]),
      ),
    };
  }

  /**
   * `data-color-grading` of a `<video>`, `<img>` or `<canvas>` as the `data-kg-grade` attribute the DOM painter turns into a
   * `colorGrade` effect on the element (see `grading.ts`). The grain is seeded as HyperFrames seeds it: by the element
   * (its id, else its `src`, else its place among its siblings) and the whole 60ths of a second of the time, so a frame
   * is the same alone or in a sequence.
   */
  private applyGrading(time: number): void {
    this.gradingNotes = [];
    for (const el of Array.from(doc().querySelectorAll('video[data-color-grading], img[data-color-grading], canvas[data-color-grading]')) as AnyRecord[]) {
      const grade = normalizeGrade(el.getAttribute('data-color-grading'), this.variablesFor(el), this.animatedGrade(el));
      const siblings = Array.from(el.parentNode?.children ?? []);
      const key = el.id || el.getAttribute('src') || `${String(el.tagName).toUpperCase()}:${siblings.indexOf(el)}`;
      const wanted = grade === null ? null : gradeAttribute(grade, seedOf(key) + Math.floor(Math.max(0, time) * 60), Math.max(0, time));
      if (grade !== null) for (const name of gradeNotDrawn(grade)) this.gradingNotes.push(`${name} is not drawn`);
      if (wanted === null) {
        if (el.hasAttribute('data-kg-grade')) el.removeAttribute('data-kg-grade');
      } else if (el.getAttribute('data-kg-grade') !== wanted) el.setAttribute('data-kg-grade', wanted);
    }
  }

  /**
   * HyperFrames' `hf-seek` event: pages that draw by themselves (the WebGPU shader blocks) redraw for `detail.time`, and
   * hand `detail.waitUntil` the promise of their drawing. The frame waits for it as for a `delayRender`.
   */
  private announceSeek(time: number): void {
    const waits: Promise<unknown>[] = [];
    const detail = { time, waitUntil: (promise: Promise<unknown>) => void waits.push(Promise.resolve(promise)) };
    try {
      g.dispatchEvent(new CustomEvent('hf-seek', { detail }));
    } catch (error) {
      noteStylesheetProblem(`hf-seek handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (waits.length === 0) return;
    const handle = delayRender('hf-seek');
    Promise.allSettled(waits).then((results) => {
      for (const r of results) if (r.status === 'rejected') this.failures.add(`hf-seek: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      continueRender(handle);
    });
  }

  /** The group a member `<audio>` belongs to: its `<hf-audio-group>` element (audioGroups.ts: resolveGroupElement), or null. */
  private audioGroupOf(el: AnyRecord): AnyRecord | null {
    const id = el.getAttribute('data-audio-group');
    if (!id) return null;
    const group = doc().getElementById(id);
    return group && String(group.tagName).toLowerCase() === 'hf-audio-group' ? group : null;
  }

  /** Whether the clip or an ancestor has `data-hidden`, or its group does: the mix drops it (engine/mediaHidden.ts). */
  private silencedByHidden(el: AnyRecord): boolean {
    for (let node = el; node; node = node.parentElement) if (node.hasAttribute?.('data-hidden')) return true;
    return this.audioGroupOf(el)?.hasAttribute('data-hidden') ?? false;
  }

  /**
   * `<audio>` and the audible `<video>`s as `<Audio>` in a `<Sequence>` over their window. The window is the clip's,
   * cut to the hosts that start their composition part-way in. The level is `data-volume` times the `volume` lane
   * (capped at +12 dB), times the fades, times the group's `data-volume` and `volume` lane. A `rate` lane plays the file
   * in quarter-second slices, each at the mean rate of its slice, as HyperFrames bakes it (engine/audioMixer.ts).
   */
  sounds(fps: number, totalFrames: number): ReactNode[] {
    const out: ReactNode[] = [];
    const media = Array.from(doc().querySelectorAll('audio[data-start], video[data-start]')) as AnyRecord[];
    media.forEach((el, index) => {
      if (!isMedia(el as TimedElement)) return;
      if (el.tagName.toLowerCase() === 'video') {
        const declared = el.getAttribute('data-has-audio');
        if (el.hasAttribute('muted') || (declared !== null && declared !== 'true')) return;
      }
      if (this.silencedByHidden(el)) return;
      const src = this.mediaSource(el);
      if (src === null) return;
      const origin = this.timing.start(el);
      const duration = this.timing.duration(el);
      const end = duration === null ? Infinity : origin + duration;
      const cut = cutToSlots({ start: origin, end }, this.timing.hostSlots(el));
      const from = Math.max(0, Math.round(cut.start * fps));
      const to = Number.isFinite(cut.end) ? Math.max(from + 1, Math.round(cut.end * fps)) : totalFrames;
      if (to <= from || from >= totalFrames) return;
      const automation = parseAutomation(el.getAttribute('data-automation'));
      const lane = automation?.volume ?? null;
      const gain = Math.min(MAX_GAIN, Math.max(0, parseNumeric(el.getAttribute('data-volume')) ?? 1));
      const fadeIn = Math.max(0, parseNumeric(el.getAttribute('data-fade-in')) ?? 0);
      const fadeOut = Math.max(0, parseNumeric(el.getAttribute('data-fade-out')) ?? 0);
      // Fades that together exceed the clip are scaled to meet inside it.
      const span = Number.isFinite(end) ? end - origin : Infinity;
      const scale = Number.isFinite(span) && span > 0 && fadeIn + fadeOut > span ? span / (fadeIn + fadeOut) : 1;
      const group = this.audioGroupOf(el);
      const groupNumber = group === null ? 1 : Number.parseFloat(group.getAttribute('data-volume') ?? '');
      const groupGain = Number.isFinite(groupNumber) ? groupNumber : 1;
      const groupLane: AutomationLane | null = group === null ? null : (parseAutomation(group.getAttribute('data-automation'))?.volume ?? null);
      const level = (frame: number): number => {
        const t = frame / fps;
        const local = t - origin;
        let v = lane !== null ? laneGain(lane, gain, local) : gain;
        if (fadeIn > 0) v *= Math.min(1, Math.max(0, local / (fadeIn * scale)));
        if (fadeOut > 0 && Number.isFinite(span)) v *= Math.min(1, Math.max(0, (span - local) / (fadeOut * scale)));
        if (group !== null) v *= groupLane !== null ? laneGain(groupLane, groupGain, t) : groupGain;
        return Math.max(0, v);
      };
      const mediaStart = sourceOffsetOf(el);
      const rate = rateSpecOf(el);
      const key = `${el.id || el.tagName.toLowerCase()}-${index}`;
      // [first frame, end frame, file seconds at the first frame, rate] of each Sequence.
      const parts: [number, number, number, number][] = [];
      if (typeof rate === 'number') {
        parts.push([from, to, mediaStart + rate * Math.max(0, from / fps - origin), rate]);
      } else {
        const slice = Math.max(1, Math.ceil(0.25 * fps));
        for (let f = from; f < to; f += slice) {
          const f1 = Math.min(to, f + slice);
          const s0 = mediaStart + sourceTimeAt(rate, Math.max(0, f / fps - origin));
          const s1 = mediaStart + sourceTimeAt(rate, Math.max(0, f1 / fps - origin));
          parts.push([f, f1, s0, Math.max(0.01, (s1 - s0) / ((f1 - f) / fps))]);
        }
      }
      parts.forEach(([f0, f1, seconds, partRate], i) => {
        out.push(
          <Sequence key={`${key}-${i}`} layout="none" from={f0} durationInFrames={f1 - f0} name={`hf-${key}-${i}`}>
            <Audio src={src} volume={(frame: number) => level(f0 + frame)} trimBefore={Math.round(seconds * fps)} playbackRate={partRate} />
          </Sequence>,
        );
      });
    });
    return out;
  }

  /** What the page needs that the engine cannot do, once per frame. */
  reportUnsupported(): void {
    if (this.plan.usesThree) reportUnsupported('three.js', null, null, 'Three.js scenes are not drawn (WebGL is not supported in a HyperFrames project)');
    for (const note of this.plan.notes) reportUnsupported('HyperFrames', null, null, note);
    for (const failure of this.failures) reportUnsupported('HyperFrames', 'script', failure, 'a script that draws by itself failed, so its canvas is not drawn');
    for (const note of this.gradingNotes) reportUnsupported('data-color-grading', null, null, note);
    for (const failure of this.seekFailures) reportUnsupported('HyperFrames', null, null, failure);
    for (const failure of this.scriptFailures) reportUnsupported('HyperFrames', null, null, failure);
  }
}

export function defineHyperframes(plan: HfPlan): void {
  registerStylesheet(baseCss(plan), 'hyperframes');
  for (const sheet of plan.stylesheets) registerStylesheet(sheet.css, sheet.file);
  for (const request of fontRequests(plan)) {
    try {
      makeGoogleFont(request.family, request.cacheOnly ? { fetch: cacheOnlyFetch(request.family) } : {}).loadFont(request.style, {
        weights: request.weights,
        ...(request.as.length > 0 ? { registerAs: request.as } : {}),
      });
    } catch (error) {
      noteStylesheetProblem(`font ${request.family}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const runtime = new Runtime(plan);
  setRemoteFiles(plan.remoteData ?? {});
  setRefusedFetchHandler((url) =>
    noteStylesheetProblem(`fetch("${url}") was refused: the file is not cached. Run \`kinetograph fetch-deps <entry> --url ${url}\` once; a render never downloads it`),
  );

  function HyperframesProject(): ReactNode {
    const frame = useCurrentFrame();
    const { fps, durationInFrames } = useVideoConfig();
    runtime.setup();
    runtime.holdForPage();
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
      calculateMetadata={plan.durationSeconds === null ? async () => ({ durationInFrames: frames(await runtime.seconds()) }) : undefined}
    />
  ));
}
