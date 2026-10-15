// Text blocks (docs/COMPAT.md §4.4): the characters of a run of text and inline elements, with whitespace collapsed
// as `white-space: normal` does, `text-transform` applied, and the colour and opacity inline elements set kept per
// character.

import type { CharStyle } from '@kinetograph/scene';
import type { Rgba } from '../css/types.js';
import { hex } from './util.js';

/** What an inline element contributes to the characters inside it. */
export interface InlineStyle {
  color: Rgba;
  opacity: number;
}

export type RunItem = { kind: 'text'; text: string; style: InlineStyle } | { kind: 'br' };

export interface BuiltText {
  text: string;
  /** One entry per code point of `text`; absent when no character differs from the block. */
  chars: (CharStyle | null)[] | undefined;
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';

function transformed(ch: string, how: 'none' | 'uppercase' | 'lowercase' | 'capitalize', wordStart: boolean): string {
  if (how === 'uppercase') return ch.toUpperCase();
  if (how === 'lowercase') return ch.toLowerCase();
  if (how === 'capitalize' && wordStart) return ch.toUpperCase();
  return ch;
}

/**
 * The text of a run. `preLine` keeps newlines as line breaks (`white-space: pre-line`); otherwise every white space
 * character, newlines included, collapses. `block` is the style of the block itself: a character whose style is the
 * block's gets no entry in `chars`.
 */
export function buildText(
  items: readonly RunItem[],
  options: { transform: 'none' | 'uppercase' | 'lowercase' | 'capitalize'; preLine: boolean; block: InlineStyle },
): BuiltText {
  const out: { ch: string; style: InlineStyle }[] = [];
  let lineStart = true;
  const stripSpace = (): void => {
    while (out.length > 0 && out[out.length - 1]!.ch === ' ') out.pop();
  };
  const sameStyle = (a: InlineStyle, b: InlineStyle): boolean =>
    a.opacity === b.opacity && a.color.r === b.color.r && a.color.g === b.color.g && a.color.b === b.color.b && a.color.a === b.color.a;
  let wordStart = true;

  for (const item of items) {
    if (item.kind === 'br') {
      stripSpace();
      out.push({ ch: '\n', style: options.block });
      lineStart = true;
      wordStart = true;
      continue;
    }
    for (const ch of Array.from(item.text)) {
      if (ch === '\n' && options.preLine) {
        stripSpace();
        out.push({ ch: '\n', style: item.style });
        lineStart = true;
        wordStart = true;
      } else if (isSpace(ch)) {
        if (!lineStart && out[out.length - 1]!.ch !== ' ') out.push({ ch: ' ', style: item.style });
        wordStart = true;
      } else {
        // Upper-casing can make several characters of one (ß -> SS); each keeps the style.
        for (const piece of Array.from(transformed(ch, options.transform, wordStart))) {
          out.push({ ch: piece, style: item.style });
        }
        lineStart = false;
        wordStart = false;
      }
    }
  }
  stripSpace();
  while (out.length > 0 && out[out.length - 1]!.ch === '\n') out.pop();
  stripSpace();

  const text = out.map((entry) => entry.ch).join('');
  if (out.every((entry) => sameStyle(entry.style, options.block))) return { text, chars: undefined };
  return {
    text,
    chars: out.map(({ style }) => {
      if (sameStyle(style, options.block)) return null;
      const entry: CharStyle = {};
      if (style.color.r !== options.block.color.r || style.color.g !== options.block.color.g || style.color.b !== options.block.color.b || style.color.a !== options.block.color.a) {
        entry.color = hex(style.color);
      }
      if (style.opacity !== options.block.opacity) entry.opacity = style.opacity;
      return entry;
    }),
  };
}

/** Whether a run holds anything to draw: a character, or a line break between characters. */
export function hasContent(items: readonly RunItem[]): boolean {
  return items.some((item) => (item.kind === 'br' ? false : /\S/.test(item.text)));
}
