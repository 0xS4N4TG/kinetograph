// The engine styles an `<svg>`'s subtree on its own: a rule whose selector needs an element above the `<svg>`
// (`[data-composition-id="x"] .bar { fill: … }`, which is how HyperFrames scopes every composition's CSS) does not reach
// the shapes inside. This writes what such rules say onto the shapes as inline style, once the scripts have built them,
// so a chart reads as it does in a browser. It goes when the SVG painter takes its styles from the page's cascade.
//
// A rule is written onto an element only if it matches there in the whole page and not in the `<svg>` alone (what
// the engine already matches is left to it), never over a property the element's own style or a script has set, and in
// the cascade's order: specificity, then position.

import { hostOf, matches } from '@kinetographdev/compat/shim';
import type { HfSvgRule } from './plan.js';

type AnyRecord = any;
/** What `element.selectorContext()` answers: parent, children and attribute lookups over the host tree. */
type SelectorContext = ReturnType<typeof import('@kinetographdev/compat/shim').selectorContextOf>;

const byCascade = (a: HfSvgRule, b: HfSvgRule): number =>
  a.specificity[0] - b.specificity[0] || a.specificity[1] - b.specificity[1] || a.specificity[2] - b.specificity[2] || a.order - b.order;

/** Applies `rules` to the shapes inside every `<svg>` of the document; returns how many properties it wrote. */
export function applySvgRules(rules: readonly HfSvgRule[], svgs: readonly AnyRecord[]): number {
  if (rules.length === 0) return 0;
  const query = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  const holds = (rule: HfSvgRule): boolean => (rule.media ?? []).every((q) => (typeof query === 'function' ? query(q).matches : true));
  const sorted = rules.filter(holds).sort(byCascade);
  let written = 0;
  for (const svg of svgs) {
    const svgHost = hostOf(svg);
    if (svgHost === null) continue;
    const full: SelectorContext = svg.selectorContext();
    const alone: SelectorContext = { ...full, parent: (host: AnyRecord) => (host === svgHost ? null : full.parent(host)) };
    for (const element of Array.from(svg.querySelectorAll('*')) as AnyRecord[]) {
      const host = hostOf(element);
      if (host === null) continue;
      const winning = new Map<string, string>();
      for (const rule of sorted) {
        let reaches = false;
        try {
          reaches = matches(host, rule.selector, full) && !matches(host, rule.selector, alone);
        } catch {
          // a selector the matcher does not know (a pseudo-class): the engine's own match stands
        }
        if (reaches) for (const [property, value] of rule.declarations) winning.set(property, value);
      }
      for (const [property, value] of winning) {
        if (element.style.getPropertyValue(property) !== '') continue;
        element.style.setProperty(property, value);
        written++;
      }
    }
  }
  return written;
}

/**
 * The `font-family` the page's text around an `<svg>` gives it, written on the `<svg>` itself: the engine's own
 * inheritance does not find a font loaded from a stylesheet's `@font-face` or Google Fonts for the text inside.
 */
export function pinSvgFonts(svgs: readonly AnyRecord[], computed: (element: AnyRecord) => AnyRecord): void {
  for (const svg of svgs) {
    if (svg.style.getPropertyValue('font-family') !== '') continue;
    const family = computed(svg).getPropertyValue('font-family');
    if (typeof family === 'string' && family !== '') svg.style.setProperty('font-family', family.replace(/&quot;|"/g, "'"));
  }
}
