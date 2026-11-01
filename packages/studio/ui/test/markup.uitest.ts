import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COLORS,
  MarkupStore,
  boundsOf,
  composeNotes,
  describeMark,
  inTimeOrder,
  layersUnder,
  nearStroke,
  numberOf,
  pictureFrames,
  pictureName,
  simplify,
  timecode,
  toSend,
  visibleAt,
  type Note,
  type Point,
} from '../src/lib/markup';
import { annotatedFrame, drawMarks, pictureScale, type Ctx } from '../src/lib/markup-image';
import { sendMarkup } from '../src/lib/use-markup-send';
import { inspectFor, intro } from './fixtures';

const RED = COLORS[0].hex;
const BLUE = COLORS[3].hex;

let store: MarkupStore;
beforeEach(() => {
  store = new MarkupStore();
});

const pin = (frame: number, x = 10, y = 10) => store.add({ comp: 'Intro', frame, geom: { type: 'pin', x, y } });

describe('the geometry of a mark', () => {
  it('simplifies a stroke to the points that matter, keeping the ends and the corners', () => {
    const line: Point[] = Array.from({ length: 50 }, (_, i) => [i * 4, 0.2 * Math.sin(i)]);
    expect(simplify(line, 1)).toHaveLength(2);
    const corner: Point[] = [[0, 0], [10, 0], [20, 0], [30, 0], [30, 10], [30, 20], [30, 30]];
    expect(simplify(corner, 1)).toEqual([[0, 0], [30, 0], [30, 30]]);
    expect(simplify([[1, 1]], 1)).toEqual([[1, 1]]);
  });

  it('finds the bounds of a stroke and which strokes a point is near (the eraser)', () => {
    const stroke: Point[] = [[10, 10], [110, 10], [110, 60]];
    expect(boundsOf(stroke)).toEqual({ x: 10, y: 10, width: 100, height: 50 });
    expect(nearStroke(stroke, 60, 14, 6)).toBe(true);
    expect(nearStroke(stroke, 60, 30, 6)).toBe(false);
    expect(nearStroke([[5, 5]], 7, 5, 3)).toBe(true);
  });

  it('names the layers under a pin (the topmost), a box (those mostly inside, plus the one at its centre) and a stroke', () => {
    const { layers } = inspectFor(intro, 0);
    expect(layersUnder(layers, { type: 'pin', x: 40, y: 20 })).toEqual(['Text “Hello”']);
    expect(layersUnder(layers, { type: 'pin', x: 900, y: 900 })).toEqual([]);
    const names = layersUnder(layers, { type: 'box', x: 0, y: 0, width: 300, height: 200 });
    expect(names).toContain('Text “Hello”');
    expect(names.length).toBeGreaterThan(1);
    expect(layersUnder(layers, { type: 'pen', points: [[5, 5], [60, 30]] })).toContain('Text “Hello”');
    expect(layersUnder(layers, { type: 'range' })).toEqual([]);
  });
});

describe('the notes', () => {
  it('keeps notes in time order, numbered by their place among those still to send', () => {
    const a = pin(40);
    store.commit(a.id, 'late');
    const b = pin(5);
    store.commit(b.id, 'early');
    const c = pin(12);
    store.commit(c.id, 'middle');
    const notes = store.getState().notes;
    expect(inTimeOrder(notes, 'Intro').map((n) => n.text)).toEqual(['early', 'middle', 'late']);
    expect(notes.map((n) => numberOf(n, notes))).toEqual([3, 1, 2]);
    // resolving one takes it out of the numbers and out of the message
    store.toggleResolved(b.id);
    const after = store.getState().notes;
    expect(toSend(after, 'Intro').map((n) => n.text)).toEqual(['middle', 'late']);
    expect(numberOf(after.find((n) => n.id === c.id)!, after)).toBe(1);
    expect(numberOf(after.find((n) => n.id === b.id)!, after)).toBeNull();
  });

  it('adds a note with its bubble open; Enter keeps it, Esc drops a new one but only closes an old one', () => {
    const a = pin(3);
    expect(store.getState().openId).toBe(a.id);
    expect(store.get(a.id)!.status).toBe('draft');
    store.commit(a.id, '  make it bigger  ');
    expect(store.get(a.id)).toMatchObject({ text: 'make it bigger', status: 'queued' });
    expect(store.getState().openId).toBeNull();
    const b = pin(4);
    store.dismiss(b.id);
    expect(store.get(b.id)).toBeUndefined();
    store.open(a.id);
    store.dismiss(a.id);
    expect(store.get(a.id)).toBeDefined();
    expect(store.getState().openId).toBeNull();
  });

  it('keeps a comment that was typed when the next mark starts', () => {
    const a = pin(3);
    store.setText(a.id, 'typed, not entered');
    pin(4);
    expect(store.get(a.id)).toMatchObject({ text: 'typed, not entered', status: 'queued' });
  });

  it('leaving markup mode drops the mark whose bubble is open and keeps the notes', () => {
    store.setActive(true);
    const a = pin(1);
    store.commit(a.id, 'kept');
    pin(2);
    store.setActive(false);
    expect(store.getState().notes.map((n) => n.text)).toEqual(['kept']);
  });

  it('shows a marker on its frame, and a range on every frame inside it', () => {
    const a = pin(10);
    const r = store.add({ comp: 'Intro', frame: 20, endFrame: 30, geom: { type: 'range' } });
    expect(visibleAt(a, 10)).toBe(true);
    expect(visibleAt(a, 11)).toBe(false);
    const range = store.get(r.id)!;
    expect([19, 20, 25, 30, 31].map((f) => visibleAt(range, f))).toEqual([false, true, true, true, false]);
  });

  it('marks notes as sent with the numbers they had, and clears them on request', () => {
    const a = pin(1);
    store.commit(a.id, 'x');
    const b = pin(2);
    store.commit(b.id, 'y');
    store.markSent([{ id: a.id, no: 1 }]);
    const notes = store.getState().notes;
    expect(notes.find((n) => n.id === a.id)).toMatchObject({ status: 'sent', sentNo: 1 });
    expect(toSend(notes, 'Intro').map((n) => n.text)).toEqual(['y']);
    // the one still to send is number 1 of the next message; the sent one keeps its own
    expect(numberOf(notes.find((n) => n.id === b.id)!, notes)).toBe(1);
    store.clearSent();
    expect(store.getState().notes.map((n) => n.text)).toEqual(['y']);
  });
});

describe('the message for the agent', () => {
  const note = (over: Partial<Note>): Note => ({ id: 1, comp: 'Intro', frame: 120, endFrame: 120, geom: { type: 'pin', x: 1, y: 2 }, color: RED, text: 'x', layers: [], status: 'queued', resolved: false, ...over });

  it('writes the time as mm:ss.cc', () => {
    expect(timecode(120, 30)).toBe('00:04.00');
    expect(timecode(0, 30)).toBe('00:00.00');
    expect(timecode(1815, 30)).toBe('01:00.50');
  });

  it('describes each kind of mark in composition pixels', () => {
    expect(describeMark(note({ geom: { type: 'pin', x: 410.4, y: 220.6 } }))).toBe('pin 410,221');
    expect(describeMark(note({ geom: { type: 'box', x: 640, y: 320, width: 420, height: 180 } }))).toBe('box 640,320 420x180');
    expect(describeMark(note({ color: BLUE, geom: { type: 'pen', points: [[100, 80], [400, 120]] } }))).toBe('blue pen stroke around 100,80 300x40');
    expect(describeMark(note({ geom: { type: 'range' } }))).toBe('range');
  });

  it('lists the notes in time order with their frame, mark, layers and comment, and names the pictures', () => {
    const notes = [
      note({ id: 1, frame: 120, endFrame: 120, geom: { type: 'box', x: 640, y: 320, width: 420, height: 180 }, layers: ['Title'], text: 'make this bigger' }),
      note({ id: 2, frame: 150, endFrame: 150, geom: { type: 'pin', x: 10, y: 20 }, text: 'wrong colour' }),
      note({ id: 3, frame: 60, endFrame: 90, geom: { type: 'range' }, text: 'too slow here' }),
    ].sort((a, b) => a.frame - b.frame);
    const text = composeNotes('Intro', 30, notes, new Map([[120, 'markup-1-1.png']]));
    expect(text).toContain('Markup notes on Intro: 3 in time order.');
    expect(text).toContain('1. frames 60-90 (00:02.00-00:03.00), range: too slow here');
    expect(text).toContain('2. frame 120 (00:04.00), box 640,320 420x180 over Title: make this bigger [markup-1-1.png]');
    expect(text).toContain('3. frame 150 (00:05.00), pin 10,20: wrong colour');
    expect(text).toContain('Each frame with a mark is attached');
  });

  it('says what has no picture when there are more frames than pictures', () => {
    const text = composeNotes('Intro', 30, [note({})], new Map([[120, 'a.png']]), [200, 210]);
    expect(text).toContain('Only the first 1 frames come with a picture; frames 200, 210 have none.');
  });

  it('caps the pictures at six distinct frames, in time order, and counts the rest', () => {
    const notes = Array.from({ length: 10 }, (_, i) => note({ id: i + 1, frame: i * 10 }));
    const twice = [...notes, note({ id: 99, frame: 0 })];
    expect(pictureFrames(twice)).toEqual({ shown: [0, 10, 20, 30, 40, 50], left: [60, 70, 80, 90] });
    expect(pictureFrames(notes, 8).shown).toHaveLength(8);
    expect(pictureName(17, 3)).toBe('markup-17-3.png');
  });
});

/** A recording stand-in for a 2D canvas context. */
function recorder() {
  const calls: string[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, key: string) {
      if (key === 'measureText') return (text: string) => ({ width: text.length * 8 });
      if (key in t) return t[key];
      return (...args: unknown[]) => void calls.push(`${key}(${args.map((a) => (typeof a === 'number' ? Math.round(a * 100) / 100 : a)).join(',')})@${String(t.strokeStyle ?? t.fillStyle ?? '')}`);
    },
    set(t, key: string, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as Ctx;
  return { ctx, calls };
}

describe('the annotated frame', () => {
  const numbered = (over: Partial<Note>, no: number) => ({ no, note: { id: no, comp: 'Intro', frame: 5, endFrame: 5, geom: { type: 'pin', x: 100, y: 50 }, color: RED, text: '', layers: [], status: 'queued', resolved: false, ...over } as Note });

  it('draws a pin as a numbered disc, a box as an outline with its number, a stroke as a line in its colour, scaled', () => {
    const { ctx, calls } = recorder();
    drawMarks(
      ctx,
      [
        numbered({}, 1),
        numbered({ geom: { type: 'box', x: 200, y: 100, width: 400, height: 200 }, color: BLUE }, 2),
        numbered({ geom: { type: 'pen', points: [[10, 10], [20, 40], [30, 10]] } }, 3),
      ],
      0.5,
    );
    // the pin: a disc at half the composition position, with its number
    expect(calls).toContain(`arc(50,25,11,0,${Math.round(Math.PI * 2 * 100) / 100})@${RED}`);
    expect(calls.some((c) => c.startsWith('fillText(1,50,'))).toBe(true);
    // the box: an outline in blue at half size, its number at its corner
    expect(calls).toContain(`strokeRect(100,50,200,100)@${BLUE}`);
    expect(calls.some((c) => c.startsWith('fillText(2,100,'))).toBe(true);
    // the stroke: moveTo / lineTo through the scaled points
    expect(calls).toContain(`moveTo(5,5)@${RED}`);
    expect(calls).toContain(`lineTo(10,20)@${RED}`);
    expect(calls).toContain(`lineTo(15,5)@${RED}`);
    expect(calls.some((c) => c.startsWith('fillText(3,5,'))).toBe(true);
  });

  it('labels a range across the top', () => {
    const { ctx, calls } = recorder();
    drawMarks(ctx, [numbered({ frame: 5, endFrame: 9, geom: { type: 'range' } }, 4)], 1);
    expect(calls.some((c) => c.startsWith('fillText(4  frames 5-9,'))).toBe(true);
  });

  it('scales the picture down to 1280 px on its long side, never up', () => {
    expect(pictureScale(1920, 1080)).toBeCloseTo(1280 / 1920);
    expect(pictureScale(640, 360)).toBe(1);
  });

  it('makes a PNG file from the frame with the marks drawn on it (a mock canvas), and null when the frame is missing', async () => {
    const { ctx, calls } = recorder();
    (ctx as unknown as { drawImage: unknown }).drawImage = (...args: unknown[]) => void calls.push(`drawImage(${args.slice(1).join(',')})`);
    const made: HTMLCanvasElement[] = [];
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      made.push(this);
      return ctx as unknown as CanvasRenderingContext2D;
    } as never);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
    const urls: [number, number][] = [];
    const file = await annotatedFrame('markup-1-1.png', {
      frame: 5,
      marks: [numbered({}, 1)],
      compWidth: 1920,
      compHeight: 1080,
      urlFor: (frame, scale) => {
        urls.push([frame, scale]);
        return `/frame/${frame}`;
      },
      load: async () => ({}) as CanvasImageSource,
    });
    expect(file).toBeInstanceOf(File);
    expect(file!.name).toBe('markup-1-1.png');
    expect(file!.type).toBe('image/png');
    expect(urls).toEqual([[5, 1280 / 1920]]);
    expect(made[0]!.width).toBe(1280);
    expect(made[0]!.height).toBe(720);
    // the frame first, then the marks over it
    expect(calls[0]).toBe('drawImage(0,0,1280,720)');
    expect(calls.some((c) => c.startsWith('arc('))).toBe(true);

    expect(await annotatedFrame('x.png', { frame: 5, marks: [], compWidth: 100, compHeight: 100, urlFor: () => null })).toBeNull();
    expect(await annotatedFrame('x.png', { frame: 5, marks: [], compWidth: 100, compHeight: 100, urlFor: () => '/x', load: async () => null })).toBeNull();
    getContext.mockRestore();
    toBlob.mockRestore();
  });
});

describe('sending the notes', () => {
  function deps(overrides: Partial<Parameters<typeof sendMarkup>[0]> = {}) {
    const sent: unknown[][] = [];
    const uploads: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const name = decodeURIComponent(new URL(url, 'http://studio.test').searchParams.get('name') ?? 'x.png');
        uploads.push(name);
        return new Response(JSON.stringify({ file: name, src: `public/refs/${name}` }), { status: 201 });
      }),
    );
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => recorder().ctx) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
    void getContext;
    return {
      sent,
      uploads,
      value: {
        store,
        chat: { send: (...args: unknown[]) => (sent.push(args), true) },
        comp: intro,
        project: null,
        timeline: null,
        player: { getState: () => ({ frame: 0 }) } as never,
        frameUrl: (frame: number) => `/frame/${frame}`,
        load: async () => ({}) as CanvasImageSource,
        now: () => 1700,
        ...overrides,
      } as Parameters<typeof sendMarkup>[0],
    };
  }

  it('sends one message, one picture per frame, and keeps the notes as sent', async () => {
    const a = store.add({ comp: 'Intro', frame: 30, geom: { type: 'box', x: 640, y: 320, width: 420, height: 180 }, layers: ['Title'] });
    store.commit(a.id, 'make this bigger');
    const b = store.add({ comp: 'Intro', frame: 30, geom: { type: 'pin', x: 5, y: 6 } });
    store.commit(b.id, 'and this');
    const c = store.add({ comp: 'Intro', frame: 90, geom: { type: 'pin', x: 7, y: 8 } });
    store.commit(c.id, 'later');
    const { value, sent, uploads } = deps();
    await sendMarkup(value, null);
    expect(uploads).toEqual(['markup-1700-1.png', 'markup-1700-2.png']);
    expect(sent).toHaveLength(1);
    const [text, , chips, image, attachments] = sent[0] as [string, string, string[], unknown, { name: string }[]];
    expect(text).toContain('1. frame 30 (00:01.00), box 640,320 420x180 over Title: make this bigger [markup-1700-1.png]');
    expect(text).toContain('2. frame 30 (00:01.00), pin 5,6: and this [markup-1700-1.png]');
    expect(text).toContain('3. frame 90 (00:03.00), pin 7,8: later [markup-1700-2.png]');
    expect(chips).toEqual(['3 markup notes']);
    expect(image).toBeUndefined();
    expect(attachments.map((x) => x.name)).toEqual(['markup-1700-1.png', 'markup-1700-2.png']);
    const state = store.getState();
    expect(state.notes.map((n) => [n.status, n.sentNo])).toEqual([['sent', 1], ['sent', 2], ['sent', 3]]);
    expect(state.busy).toBe(false);
    // nothing is left to send
    await sendMarkup(value, null);
    expect(sent).toHaveLength(1);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends only the asked note, leaves resolved ones out, and says so when there are more frames than pictures', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) {
      const n = store.add({ comp: 'Intro', frame: i * 10, geom: { type: 'pin', x: i, y: i } });
      store.commit(n.id, `note ${i}`);
      ids.push(n.id);
    }
    store.toggleResolved(ids[1]!);
    const { value, sent, uploads } = deps();
    await sendMarkup(value, [ids[0]!]);
    expect((sent[0]![0] as string)).toContain('1. frame 0 (00:00.00), pin 0,0: note 0');
    expect(sent[0]![0]).not.toContain('note 1');
    expect(uploads).toHaveLength(1);
    await sendMarkup(value, null);
    // seven left, one resolved: six unresolved, all with a picture
    const text = sent[1]![0] as string;
    expect(text).toContain('Markup notes on Intro: 6 in time order.');
    expect(text).not.toContain('note 1');
    expect(uploads).toHaveLength(7);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('caps the pictures at six frames of a longer list, and tells the agent which frames have none', async () => {
    for (let i = 0; i < 9; i++) {
      const n = store.add({ comp: 'Intro', frame: i * 5, geom: { type: 'pin', x: i, y: i } });
      store.commit(n.id, `n${i}`);
    }
    const { value, sent, uploads } = deps();
    await sendMarkup(value, null);
    expect(uploads).toHaveLength(6);
    const text = sent[0]![0] as string;
    expect(text).toContain('Only the first 6 frames come with a picture; frames 30, 35, 40 have none.');
    expect(text).toContain('9. frame 40 (00:01.33), pin 8,8: n8');
    expect(text).not.toMatch(/n8 \[markup/);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the notes when the pictures cannot be stored, and says why', async () => {
    const n = store.add({ comp: 'Intro', frame: 1, geom: { type: 'pin', x: 1, y: 1 } });
    store.commit(n.id, 'x');
    const { value, sent } = deps();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'disk full' } }), { status: 500 })));
    await sendMarkup(value, null);
    expect(sent).toHaveLength(0);
    expect(store.getState().problem).toContain('disk full');
    expect(store.getState().busy).toBe(false);
    expect(store.get(n.id)!.status).toBe('queued');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
