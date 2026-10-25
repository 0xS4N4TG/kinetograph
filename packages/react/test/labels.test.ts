import { describe, expect, it } from 'vitest';
import { layerLabel, sequenceLabel, snippet } from '../src/labels.js';

describe('snippet', () => {
  it('keeps short text, collapses whitespace and cuts long text at 30 characters', () => {
    expect(snippet('  Hello \n  world ')).toBe('Hello world');
    expect(snippet('Rewrote Remotion in Rust, from scratch')).toBe('Rewrote Remotion in Rust, fro…');
    expect(snippet('x'.repeat(30))).toBe('x'.repeat(30));
    expect([...snippet('y'.repeat(60))]).toHaveLength(30);
  });
});

describe('sequenceLabel', () => {
  it('prefers the name, then the first user component inside, then "Sequence"', () => {
    expect(sequenceLabel('Intro', 'Opening')).toBe('Intro');
    expect(sequenceLabel(null, 'Opening')).toBe('Opening');
    expect(sequenceLabel(null, undefined)).toBe('Sequence');
    expect(sequenceLabel('', undefined)).toBe('Sequence');
  });

  it('shows a library default name without its brackets', () => {
    expect(sequenceLabel('<Solid>', undefined)).toBe('Solid');
  });
});

describe('layerLabel', () => {
  it('a Sequence name beats an id, an id beats the component', () => {
    expect(layerLabel({ type: 'kg-layer', sequenceName: 'Outro', id: 'bg', component: 'Main' })).toBe('Outro');
    expect(layerLabel({ type: 'kg-layer', id: 'bg', component: 'Main' })).toBe('bg');
  });

  it('a text layer is its component and a snippet of its text', () => {
    expect(layerLabel({ type: 'kg-text', component: 'Title', owner: 'Title', text: 'Rewrote Remotion in Rust, from scratch' })).toBe(
      'Title · “Rewrote Remotion in Rust, fro…”',
    );
    // Not the first element the component draws: still told by its component.
    expect(layerLabel({ type: 'kg-text', owner: 'Title', text: 'Hi' })).toBe('Title · “Hi”');
    expect(layerLabel({ type: 'kg-text', text: 'Hi' })).toBe('Text · “Hi”');
  });

  it('the first element of a component is the component', () => {
    expect(layerLabel({ type: 'kg-layer', component: 'Card', owner: 'Card' })).toBe('Card');
    expect(layerLabel({ type: 'div', component: 'Card', owner: 'Card', className: 'frame big' })).toBe('Card');
  });

  it('an inner element is its tag and first class, or its kind of layer', () => {
    expect(layerLabel({ type: 'div', owner: 'Card', className: 'frame big' })).toBe('div.frame');
    expect(layerLabel({ type: 'div' })).toBe('div');
    expect(layerLabel({ type: 'kg-image' })).toBe('Image');
    expect(layerLabel({ type: 'kg-image', src: 'img/logo.png?v=2' })).toBe('Image · logo.png');
    expect(layerLabel({ type: 'kg-video' })).toBe('Video');
    expect(layerLabel({ type: 'kg-rect' })).toBe('Shape');
    expect(layerLabel({ type: 'kg-ellipse', owner: 'Dot' })).toBe('Shape');
    expect(layerLabel({ type: 'kg-text' })).toBe('Text');
    expect(layerLabel({ type: 'kg-layer' })).toBe('Group');
    expect(layerLabel({ type: 'img', src: 'a/b.png' })).toBe('Image · b.png');
  });

  it('never gives a path id', () => {
    for (const type of ['kg-layer', 'kg-text', 'div', 'kg-unknown']) expect(layerLabel({ type })).not.toMatch(/^\$/);
  });
});
