// COMPAT.md §4.4: a text block is one text layer with chars.

import { describe, expect, it } from 'vitest';
import { buildText } from '../../src/dom/text.js';
import { div, el, find, FONT_FILE, hasAddon, px, rgb, run, sides } from './helpers.js';

const black = rgb(0, 0, 0);
const block = { color: black, opacity: 1 };

describe('buildText', () => {
  const item = (text: string, style = block) => ({ kind: 'text' as const, text, style });
  const opts = { transform: 'none' as const, preLine: false, block };

  it('collapses white space as white-space: normal does', () => {
    expect(buildText([item('  Hello \n\t  world  ')], opts).text).toBe('Hello world');
    expect(buildText([item('a '), item(' b')], opts).text).toBe('a b');
  });

  it('makes br a line break and trims the spaces around it', () => {
    expect(buildText([item('one '), { kind: 'br' }, item(' two'), { kind: 'br' }], opts).text).toBe('one\ntwo');
  });

  it('keeps newlines with pre-line', () => {
    expect(buildText([item('a  \n  b\n\nc')], { ...opts, preLine: true }).text).toBe('a\nb\n\nc');
  });

  it('applies text-transform, one character at a time', () => {
    expect(buildText([item('straße')], { ...opts, transform: 'uppercase' }).text).toBe('STRASSE');
    expect(buildText([item('hello big world')], { ...opts, transform: 'capitalize' }).text).toBe('Hello Big World');
    expect(buildText([item('ABC')], { ...opts, transform: 'lowercase' }).text).toBe('abc');
  });

  it('keeps colour and opacity of inline elements per code point', () => {
    const red = { color: rgb(255, 0, 0), opacity: 1 };
    const faint = { color: black, opacity: 0.5 };
    const built = buildText([item('ab '), item('cd', red), item(' e'), item('é', faint)], opts);
    expect(built.text).toBe('ab cd eé');
    expect(built.chars).toEqual([null, null, null, { color: '#ff0000' }, { color: '#ff0000' }, null, null, { opacity: 0.5 }]);
    expect(buildText([item('plain')], opts).chars).toBeUndefined();
  });
});

describe.skipIf(!hasAddon)('text blocks', () => {
  const font = { fontFamily: ['DM Sans'], fontSize: px(32), color: rgb(255, 255, 255) };

  it('is one text layer at the content box, wrapped at its width', () => {
    const { root, unsupported } = run(
      div({ ...font, width: px(300), padding: sides(px(10), px(20)), borderWidth: sides(px(0)), backgroundColor: black }, [
        'alpha beta gamma delta epsilon zeta',
      ]),
    );
    expect(unsupported).toEqual([]);
    const text = find(root, '$0.text');
    expect(text).toMatchObject({
      type: 'text',
      text: 'alpha beta gamma delta epsilon zeta',
      font: 'DM Sans',
      size: 32,
      color: '#ffffff',
      lineHeight: 1.2,
      maxWidth: 300,
      transform: { x: 20, y: 10 },
    });
    // The box is as tall as the lines the layer will break into.
    const bg = find(root, '$0.bg').shape;
    expect(bg.height).toBeGreaterThan(2 * 32 * 1.2);
  });

  it('inherits the font from its ancestors and uses what the style says', () => {
    const { root } = run(
      div({ ...font }, [
        div({ textAlign: 'center', lineHeight: 1.5, textTransform: 'uppercase', fontSize: px(20) }, ['hi there']),
      ]),
    );
    const text = find(root, '$0.0.text');
    expect(text).toMatchObject({ text: 'HI THERE', font: 'DM Sans', size: 20, lineHeight: 1.5, align: 'center', color: '#ffffff' });
  });

  it('puts the colour of an inline element into chars', () => {
    const { root, unsupported } = run(
      div({ ...font }, ['Hello ', el('span', { color: rgb(255, 0, 0) }, ['red']), ' world']),
    );
    expect(unsupported).toEqual([]);
    const text = find(root, '$0.text');
    expect(text.text).toBe('Hello red world');
    expect(text.chars.slice(5, 10)).toEqual([null, { color: '#ff0000' }, { color: '#ff0000' }, { color: '#ff0000' }, null]);
  });

  it('reports inline elements that change the font, and spacing and decoration anywhere', () => {
    const { unsupported } = run(
      div({ ...font, letterSpacing: px(2), textDecoration: 'underline' }, ['a ', el('b', { display: 'inline' }, ['bold']), el('span', { backgroundColor: black }, ['x'])]),
    );
    const props = unsupported.map((u) => `${u.element}:${u.property}`).sort();
    expect(props).toEqual(['b:fontWeight', 'div:letterSpacing', 'div:textDecoration', 'span:backgroundColor']);
  });

  it('reports a font family that is not registered, and other white-space values', () => {
    const { unsupported } = run(div({ fontFamily: ['Nope', 'sans-serif'], whiteSpace: 'pre', fontSize: px(20) }, ['hi']));
    expect(unsupported.map((u) => u.property).sort()).toEqual(['fontFamily', 'whiteSpace']);
  });

  it('reports justified text', () => {
    const { unsupported } = run(div({ ...font, textAlign: 'justify' }, ['hi']));
    expect(unsupported).toEqual([expect.objectContaining({ property: 'textAlign', value: 'justify' })]);
  });

  it('does not wrap with white-space: nowrap', () => {
    const { root } = run(div({ ...font, width: px(50), whiteSpace: 'nowrap' }, ['a very long line indeed']));
    expect(find(root, '$0.text').maxWidth).toBeUndefined();
  });

  it('turns text shadows into dropShadow effects, last first', () => {
    const { root } = run(
      div({ ...font, textShadow: [
        { x: px(1), y: px(2), blur: px(4), color: rgb(0, 0, 0) },
        { x: px(0), y: px(0), blur: px(10), color: rgb(255, 0, 0) },
      ] }, ['glow']),
    );
    expect(find(root, '$0.text').effects).toEqual([
      { type: 'dropShadow', x: 0, y: 0, blur: 5, color: '#ff0000' },
      { type: 'dropShadow', x: 1, y: 2, blur: 2, color: '#000000' },
    ]);
  });

  it('gives text between blocks an anonymous box, and text in a flex container its own item', () => {
    const mixed = run(
      div({ ...font, fontSize: px(20) }, ['intro', div({ height: px(30), backgroundColor: black }), 'outro']),
    );
    expect(find(mixed.root, '$0.text0')).toMatchObject({ type: 'text', text: 'intro' });
    expect(find(mixed.root, '$0.text1')).toMatchObject({ type: 'text', text: 'outro' });
    // intro, block, outro stack
    expect(find(mixed.root, '$0.0').transform.y).toBeGreaterThan(20);
    expect(find(mixed.root, '$0.text1').transform.y).toBeGreaterThan(find(mixed.root, '$0.0').transform.y);

    const flex = run(
      div({ ...font, display: 'flex', width: px(400), height: px(100), justifyContent: 'center', alignItems: 'center' }, ['centred']),
    );
    const text = find(flex.root, '$0.text0');
    expect(text.text).toBe('centred');
    expect(text.transform.x).toBeGreaterThan(100);
    expect(text.transform.y).toBeGreaterThan(20);
  });

  it('gives the headings and paragraphs the defaults of the browser', () => {
    const { root, unsupported } = run(
      div({ ...font, fontSize: px(16), padding: sides(px(1)) }, [el('h1', {}, ['Title']), el('p', {}, ['Body'])]),
      { fonts: { 'DM Sans': FONT_FILE, 'DM Sans:700': FONT_FILE } },
    );
    expect(unsupported).toEqual([]);
    const h1 = find(root, '$0.0');
    const p = find(root, '$0.1');
    // 2em = 32 px and bold; its 0.67em = 21.44 px margins.
    expect(find(root, '$0.0.text')).toMatchObject({ size: 32, font: 'DM Sans:700' });
    expect(h1.transform.y).toBeCloseTo(1 + 21.44, 2);
    // The paragraph's 1em margin collapses into the heading's larger one.
    const h1Height = 32 * 1.2;
    expect(p.transform.y).toBeCloseTo(h1.transform.y + h1Height + 21.44, 1);
  });
});
