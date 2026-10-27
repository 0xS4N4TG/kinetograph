import { describe, expect, it } from 'vitest';

import { buildChatContext } from '../src/lib/chat-context';
import { emptyChat, reduceChat, addUserMessage, answerPermission } from '../src/lib/chat';
import { hitTest, type InspectLayer } from '../src/lib/inspect';
import {
  boxResult,
  boxSelect,
  chipText,
  clickSelection,
  layerName,
  layerSource,
  rectFrom,
  remapSelection,
  unionRect,
} from '../src/lib/selection';
import { intro, introTimeline, layer } from './fixtures';

const at = (id: string, type: string, x: number, y: number, w: number, h: number, extra: Partial<InspectLayer> = {}) =>
  layer(id, type, { bounds: { x, y, width: w, height: h }, box: { x, y, width: w, height: h }, ...extra });

const scene: InspectLayer[] = [
  at('bg', 'shape', 0, 0, 1000, 1000),
  at('$0.1', 'group', 0, 0, 600, 300, {
    children: [at('$0.1.0', 'text', 100, 100, 200, 50, { text: { text: 'Headline', font: 'Inter', size: 40, width: 200, height: 50, maxWidth: null, lines: [] } }), at('$0.1.1', 'image', 400, 100, 150, 150, { src: 'img/logo.png' })],
  }),
  at('far', 'shape', 800, 800, 100, 100),
];

describe('picking by click', () => {
  it('finds the topmost layer under a point, children above their group', () => {
    expect(hitTest(scene, 150, 120)?.id).toBe('$0.1.0');
    expect(hitTest(scene, 450, 120)?.id).toBe('$0.1.1');
    expect(hitTest(scene, 500, 700)?.id).toBe('bg');
    expect(hitTest(scene, 850, 850)?.id).toBe('far');
    expect(hitTest(scene, 1200, 50)).toBeNull();
  });

  it('shift toggles, a plain click replaces, empty space clears (shift keeps)', () => {
    expect(clickSelection(['a'], 'b', false)).toEqual(['b']);
    expect(clickSelection(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(clickSelection(['a', 'b'], 'b', true)).toEqual(['a']);
    expect(clickSelection(['a'], null, false)).toEqual([]);
    expect(clickSelection(['a'], null, true)).toEqual(['a']);
  });
});

describe('picking by box', () => {
  it('picks the layers with at least half their area inside, skipping groups, topmost first', () => {
    expect(boxSelect(scene, rectFrom({ x: 50, y: 50 }, { x: 600, y: 300 }))).toEqual(['$0.1.1', '$0.1.0']);
    // half of the headline is inside: still picked; a corner of the background is not enough
    expect(boxSelect(scene, rectFrom({ x: 200, y: 90 }, { x: 260, y: 160 }))).toEqual([]);
    expect(boxSelect(scene, rectFrom({ x: 150, y: 90 }, { x: 260, y: 160 }))).toEqual(['$0.1.0']);
    expect(boxSelect(scene, rectFrom({ x: 790, y: 790 }, { x: 910, y: 910 }))).toEqual(['far']);
    expect(boxSelect(scene, rectFrom({ x: 2000, y: 0 }, { x: 2100, y: 10 }))).toEqual([]);
  });

  it('works from any corner, and shift adds to the selection without repeats', () => {
    expect(rectFrom({ x: 10, y: 20 }, { x: 4, y: 2 })).toEqual({ x: 4, y: 2, width: 6, height: 18 });
    expect(boxResult(['a', 'b'], ['b', 'c'], true)).toEqual(['a', 'b', 'c']);
    expect(boxResult(['a', 'b'], ['c'], false)).toEqual(['c']);
  });
});

describe('names', () => {
  it('uses the label, else the text, file or chosen id, and never a tree path', () => {
    expect(layerName({ ...scene[1]!.children![0]!, label: 'Headline text' } as InspectLayer)).toBe('Headline text');
    expect(layerName(scene[1]!.children![0]!)).toBe('Text “Headline”');
    expect(layerName(scene[1]!.children![1]!)).toBe('Image logo.png');
    expect(layerName(scene[0]!)).toBe('bg');
    expect(layerName(scene[1]!)).toBe('Group');
    expect(layerName({ ...scene[1]!, ordinal: 2 } as InspectLayer)).toBe('Group 2');
    expect(layerName({ ...scene[1]!.children![0]!, label: 'Card', ordinal: 3 } as InspectLayer)).toBe('Card 3');
  });

  it('writes a chip with the frame and the source position when it is known', () => {
    const headline = { ...scene[1]!.children![0]!, label: 'Headline text', source: { file: 'src/shots-a.tsx', line: 48, column: 3 } } as InspectLayer;
    expect(chipText(headline, 120, '/repo')).toBe('Headline text · frame 120 · shots-a.tsx:48');
    expect(chipText(scene[0]!, 5)).toBe('bg · frame 5');
    expect(layerSource({ ...headline, source: 'src/x.tsx:9:2' } as unknown as InspectLayer)).toEqual({ file: 'src/x.tsx', line: 9 });
    expect(layerSource(headline)).toEqual({ file: 'src/shots-a.tsx', line: 48 });
    expect(layerSource(scene[0]!)).toBeNull();
  });

  it('finds the picked layers again by name after the ids moved, when the name is unique', () => {
    const after: InspectLayer[] = [at('$0.2', 'text', 0, 0, 10, 10, { label: 'Headline text' } as Partial<InspectLayer>), at('$0.3', 'shape', 0, 0, 5, 5), at('$0.4', 'shape', 0, 0, 5, 5)];
    const names = new Map([['$0.1', 'Headline text'], ['$0.9', 'Shape'], ['$0.3', 'Shape']]);
    // $0.1 moved to $0.2; $0.9 is gone and "Shape" is not unique; $0.3 is still there
    expect(remapSelection(['$0.1', '$0.9', '$0.3'], names, after)).toEqual(['$0.2', '$0.9', '$0.3']);
  });

  it('grows the picture around the selection and keeps it inside the frame', () => {
    expect(unionRect([{ x: 10, y: 10, width: 20, height: 20 }, { x: 100, y: 50, width: 10, height: 10 }], 5, 1920, 1080)).toEqual({ x: 5, y: 5, width: 110, height: 60 });
    expect(unionRect([{ x: 0, y: 0, width: 4000, height: 10 }], 50, 1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 60 });
    expect(unionRect([], 5, 10, 10)).toBeNull();
    expect(unionRect([{ x: 5000, y: 5000, width: 10, height: 10 }], 0, 1920, 1080)).toBeNull();
  });
});

describe('the context for the agent', () => {
  const base = { entry: '/repo/examples/launch/index.tsx', cwd: '/repo', comp: intro, frame: 120, timeline: introTimeline };
  const headline = { ...at('title', 'text', 100, 100, 200, 50, { text: { text: 'Hello', font: 'Inter', size: 64, width: 200, height: 50, maxWidth: null, lines: [] }, opacity: 0.5 }), label: 'Headline text', component: 'Opening', source: { file: 'examples/launch/shots-a.tsx', line: 48, column: 5 } } as InspectLayer;

  it('names the file, composition, frame, label, component, source, place and current values', () => {
    const text = buildChatContext({ ...base, layers: [headline] });
    expect(text).toContain('examples/launch/index.tsx');
    expect(text).toContain('composition `Intro`, frame 120 (00:04:00)');
    expect(text).toContain('"Headline text"');
    expect(text).toContain('text layer');
    expect(text).toContain('component Opening');
    expect(text).toContain('examples/launch/shots-a.tsx:48');
    expect(text).toContain('text "Hello"');
    expect(text).toContain('at 100,100, 200×50');
    expect(text).toContain('opacity 0.5');
  });

  it('leaves tree paths out, keeps an id the author chose, lists several layers, and copes with none', () => {
    const anon = at('$0.4.1', 'shape', 0, 0, 10, 10);
    const text = buildChatContext({ ...base, layers: [anon, headline] });
    expect(text).not.toContain('$0.4.1');
    expect(text).toContain('id "title"');
    expect(text).toContain('Selected layers (2)');
    expect(text).toContain('2. ');
    const none = buildChatContext({ ...base, layers: [] });
    expect(none).toContain('frame 120');
    expect(none).not.toContain('Selected');
  });
});

describe('the chat list', () => {
  it('joins streamed text, updates a tool call in place and keeps its title, and records answers', () => {
    let s = addUserMessage(emptyChat, 'make it red', ['Headline · frame 1']);
    s = reduceChat(s, { kind: 'message', text: 'Sure' });
    s = reduceChat(s, { kind: 'message', text: ', ok.' });
    s = reduceChat(s, { kind: 'tool', id: 't', title: 'Edit a.tsx', toolKind: 'edit', status: 'pending', files: ['a.tsx'] });
    s = reduceChat(s, { kind: 'tool', id: 't', title: '', toolKind: 'edit', status: 'completed', files: [] });
    s = reduceChat(s, { kind: 'permission', id: '1', title: 'Write', files: [], options: [{ id: 'y', name: 'Allow', kind: 'allow_once' }] });
    s = answerPermission(s, '1', 'y');
    s = reduceChat(s, { kind: 'error', message: 'It stopped.' });
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'agent', 'tool', 'permission', 'error']);
    expect(s.items[1]).toMatchObject({ text: 'Sure, ok.' });
    expect(s.items[2]).toMatchObject({ title: 'Edit a.tsx', status: 'completed', files: ['a.tsx'] });
    expect(s.items[3]).toMatchObject({ answered: 'y' });
    // text after a tool starts a new paragraph
    s = reduceChat(s, { kind: 'message', text: 'Done' });
    expect(s.items.at(-1)).toMatchObject({ kind: 'agent', text: 'Done' });
    s = reduceChat(s, { kind: 'status', status: 'busy', command: 'x', image: true });
    expect(s).toMatchObject({ status: 'busy', command: 'x', image: true });
  });
});
