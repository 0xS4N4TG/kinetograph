import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/app';
import { MockServer } from './mock-server';

/** The frame is 1920x1080 and drawn at half size (960x540) from the top left of the page; `size` changes that (a zoom). */
const view = { width: 960, height: 540 };
function stubRects() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const id = (this as HTMLElement).dataset?.testid;
    const on = id === 'frame' || id === 'markup-surface' || id === 'markup-layer';
    const { width, height } = on ? view : { width: 0, height: 0 };
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  });
}

async function start() {
  const server = new MockServer();
  const user = userEvent.setup();
  render(<App api={server} />);
  await waitFor(() => expect(server.frameRequests.length).toBeGreaterThan(0));
  await screen.findByTestId('agent-panel');
  await waitFor(() => expect(screen.getByTestId('preview-canvas')).toBeInTheDocument());
  // the layers under a mark are named from the inspect result of the frame
  await waitFor(() => expect(server.inspectCalls.length).toBeGreaterThan(0));
  await act(async () => {});
  return { server, user };
}

beforeEach(() => {
  view.width = 960;
  view.height = 540;
  stubRects();
});
afterEach(() => vi.restoreAllMocks());

const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key: k, ...init });
const surface = () => screen.getByTestId('markup-surface');
/** A click on the picture at a screen point. */
function clickAt(x: number, y: number) {
  fireEvent.pointerDown(surface(), { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(surface(), { clientX: x, clientY: y, pointerId: 1 });
}
function dragTo(from: [number, number], via: [number, number][], pointerId = 1) {
  fireEvent.pointerDown(surface(), { clientX: from[0], clientY: from[1], button: 0, pointerId });
  for (const [x, y] of via) fireEvent.pointerMove(surface(), { clientX: x, clientY: y, pointerId });
  const last = via.at(-1)!;
  fireEvent.pointerUp(surface(), { clientX: last[0], clientY: last[1], pointerId });
}
const bubbleBox = () => screen.getByLabelText('Comment on this mark');

describe('markup mode', () => {
  it('opens with M or the pen button and leaves with Esc; Shift+M mutes, not M', async () => {
    const { user } = await start();
    expect(screen.queryByTestId('markup-toolbar')).toBeNull();
    key('m');
    expect(screen.getByTestId('markup-toolbar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Markup' })).toHaveAttribute('aria-pressed', 'true');
    key('Escape');
    expect(screen.queryByTestId('markup-toolbar')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Markup' }));
    expect(screen.getByTestId('markup-toolbar')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Markup' }));
    expect(screen.queryByTestId('markup-toolbar')).toBeNull();
    // Esc in markup mode leaves it first; the selection is not touched by that press
    key('m');
    key('M', { shiftKey: true });
    expect(screen.getByTestId('markup-toolbar')).toBeInTheDocument();
  });

  it('switches between the tools and the colours', async () => {
    const { user } = await start();
    key('m');
    const bar = within(screen.getByTestId('markup-toolbar'));
    expect(bar.getByRole('button', { name: 'Pin' })).toHaveAttribute('aria-pressed', 'true');
    for (const name of ['Box', 'Pen', 'Eraser', 'Range']) {
      await user.click(bar.getByRole('button', { name }));
      expect(bar.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
      expect(bar.getByRole('button', { name: 'Pin' })).toHaveAttribute('aria-pressed', 'false');
    }
    expect(bar.getAllByRole('button', { name: /^Colour / })).toHaveLength(4);
    await user.click(bar.getByRole('button', { name: 'Colour blue' }));
    expect(bar.getByRole('button', { name: 'Colour blue' })).toHaveAttribute('aria-pressed', 'true');
    expect(bar.getByRole('button', { name: 'Colour red' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a pin opens a bubble beside it; Enter adds it to the tray, with the layers under it, and the marker stays numbered', async () => {
    const { server } = await start();
    key('m');
    // (20,10) on a frame drawn at half size is composition pixel (40,20): inside the title
    clickAt(20, 10);
    expect(screen.getByTestId('markup-bubble')).toBeInTheDocument();
    fireEvent.change(bubbleBox(), { target: { value: 'make this bigger' } });
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    expect(screen.queryByTestId('markup-bubble')).toBeNull();
    // added to the tray; nothing was sent to the agent
    expect(server.agentMessages.filter((m) => m.type === 'agent.prompt')).toHaveLength(0);
    expect(screen.getByTestId('markup-marker')).toHaveTextContent('1');
    expect(screen.getByTestId('markup-marker')).toHaveAttribute('data-state', 'queued');
    await userEvent.click(screen.getByTestId('notes-toggle'));
    const card = screen.getByTestId('note-card');
    expect(card).toHaveTextContent('frame 0 · 00:00.00 · pin 40,20');
    expect(card).toHaveTextContent('over Text “Hello”');
    expect(card).toHaveTextContent('make this bigger');
    expect(screen.getByTestId('send-notes')).toHaveTextContent('Send 1 note');
  });

  it('Esc in a new bubble drops the mark; clicking a marker reopens its bubble to edit or delete the note', async () => {
    await start();
    key('m');
    clickAt(100, 100);
    fireEvent.keyDown(bubbleBox(), { key: 'Escape' });
    expect(screen.queryByTestId('markup-marker')).toBeNull();
    // still in markup mode: Esc went to the bubble only
    expect(screen.getByTestId('markup-toolbar')).toBeInTheDocument();

    clickAt(100, 100);
    fireEvent.change(bubbleBox(), { target: { value: 'first' } });
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('markup-marker'));
    expect(bubbleBox()).toHaveValue('first');
    fireEvent.change(bubbleBox(), { target: { value: 'second' } });
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    expect(screen.getByTestId('markup-marker')).toHaveAttribute('title', 'second');
    fireEvent.click(screen.getByTestId('markup-marker'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete this note' }));
    expect(screen.queryByTestId('markup-marker')).toBeNull();
  });

  it('keeps geometry in composition pixels at any zoom: the same note, and a new one at another scale', async () => {
    await start();
    key('m');
    fireEvent.click(screen.getByRole('button', { name: 'Box' }));
    // at half size: (100,50)-(300,150) is composition (200,100)-(600,300)
    dragTo([100, 50], [[200, 100], [300, 150]]);
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    const rect = screen.getByTestId('markup-box');
    expect(rect).toHaveAttribute('x', '200');
    expect(rect).toHaveAttribute('y', '100');
    expect(rect).toHaveAttribute('width', '400');
    expect(rect).toHaveAttribute('height', '200');
    // zoomed to 100%: the picture is twice as big on screen; the stored box does not change, and a new pin lands right
    view.width = 1920;
    view.height = 1080;
    key('1', {});
    expect(screen.getByTestId('markup-box')).toHaveAttribute('x', '200');
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    clickAt(500, 400);
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    await userEvent.click(screen.getByTestId('notes-toggle'));
    const cards = screen.getAllByTestId('note-card').map((c) => c.textContent);
    expect(cards.some((c) => c?.includes('box 200,100 400x200'))).toBe(true);
    expect(cards.some((c) => c?.includes('pin 500,400'))).toBe(true);
  });

  it('a freehand stroke is stored as a simplified list of points in its colour, and the eraser removes the whole stroke', async () => {
    await start();
    key('m');
    fireEvent.click(screen.getByRole('button', { name: 'Colour blue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pen' }));
    dragTo([100, 100], [[150, 100], [200, 100], [250, 100], [300, 100]]);
    expect(screen.getByTestId('markup-bubble')).toBeInTheDocument();
    fireEvent.change(bubbleBox(), { target: { value: 'underline it' } });
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    const stroke = screen.getByTestId('markup-stroke');
    // a straight line: five points became two, doubled to composition pixels
    expect(stroke).toHaveAttribute('points', '200,200 600,200');
    expect(stroke).toHaveAttribute('stroke', '#3b82f6');
    fireEvent.click(screen.getByRole('button', { name: 'Eraser' }));
    clickAt(200, 101);
    expect(screen.queryByTestId('markup-stroke')).toBeNull();
    expect(screen.queryByTestId('markup-marker')).toBeNull();
    expect(screen.queryByTestId('notes-tray')).toBeNull();
  });

  it('shows a marker only while the playhead is on its frame', async () => {
    await start();
    key('m');
    clickAt(100, 100);
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    key('Escape');
    expect(screen.getAllByTestId('markup-marker')).toHaveLength(1);
    key('ArrowRight');
    await waitFor(() => expect(screen.queryByTestId('markup-marker')).toBeNull());
    key('ArrowLeft');
    await waitFor(() => expect(screen.getAllByTestId('markup-marker')).toHaveLength(1));
  });

  it('puts a tick on the timeline ruler for every note, and a drag with the Range tool makes a range note', async () => {
    await start();
    const ruler = screen.getByTestId('timeline-ruler');
    vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 0, right: 1600, bottom: 28, width: 1500, height: 28, x: 100, y: 0, toJSON: () => ({}) });
    key('m');
    clickAt(100, 100);
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    expect(screen.getAllByTestId('markup-tick')).toHaveLength(1);
    expect(screen.getByTestId('markup-tick')).toHaveAttribute('data-state', 'queued');

    // without the Range tool a drag on the ruler is only the span it always was
    fireEvent.pointerDown(ruler, { clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(ruler, { clientX: 850, pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: 850, pointerId: 1 });
    expect(screen.getAllByTestId('markup-tick')).toHaveLength(1);
    expect(screen.getByTestId('time-range')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Range' }));
    fireEvent.pointerDown(ruler, { clientX: 400, pointerId: 1 }); // frame 30
    fireEvent.pointerMove(ruler, { clientX: 850, pointerId: 1 }); // frame 75
    fireEvent.pointerUp(ruler, { clientX: 850, pointerId: 1 });
    expect(screen.getAllByTestId('markup-tick')).toHaveLength(2);
    // its bubble is open on the preview; the span on the timeline is handed over to the note
    expect(screen.getByTestId('markup-bubble')).toHaveTextContent('frames 30-75');
    fireEvent.change(bubbleBox(), { target: { value: 'too slow' } });
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    expect(screen.queryByTestId('time-range')).toBeNull();
    await userEvent.click(screen.getByTestId('notes-toggle'));
    expect(screen.getAllByTestId('note-card').map((c) => c.textContent?.match(/frames? [\d-]+/)?.[0])).toEqual(['frame 0', 'frames 30-75']);
  });
});

describe('the notes tray', () => {
  /** Moves the playhead to a frame with the keys: Home, then ten at a time with Shift and singles. */
  async function seekTo(frame: number) {
    key('Home');
    for (let i = 0; i < Math.floor(frame / 10); i++) key('ArrowRight', { shiftKey: true });
    for (let i = 0; i < frame % 10; i++) key('ArrowRight');
    await act(async () => {});
  }
  async function three() {
    const ctx = await start();
    key('m');
    // frames 20, 5 and 12, made out of order
    for (const [frame, text, at] of [
      [20, 'late one', [100, 100]],
      [5, 'early one', [200, 100]],
      [12, 'middle one', [300, 100]],
    ] as const) {
      await seekTo(frame);
      clickAt(at[0], at[1]);
      fireEvent.change(bubbleBox(), { target: { value: text } });
      fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    }
    return ctx;
  }

  it('lists the notes in time order with the numbers the message will give them', async () => {
    const { user } = await three();
    await user.click(screen.getByTestId('notes-toggle'));
    const cards = screen.getAllByTestId('note-card');
    expect(cards).toHaveLength(3);
    const frames = cards.map((c) => Number(/frame (\d+)/.exec(c.textContent ?? '')?.[1]));
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    expect(new Set(frames).size).toBe(3);
    expect(cards.map((c) => c.querySelector('span')?.textContent)).toEqual(['1', '2', '3']);
    expect(screen.getByTestId('send-notes')).toHaveTextContent('Send 3 notes');
  });

  it('jumps to a note, resolves one (greyed, left out of the count) and deletes one', async () => {
    const { user } = await three();
    await user.click(screen.getByTestId('notes-toggle'));
    const first = () => screen.getAllByTestId('note-card')[0]!;
    await seekTo(0);
    expect(screen.queryByTestId('markup-marker')).toBeNull();
    // the last card is frame 20: going there shows its marker and only its marker
    await user.click(within(screen.getAllByTestId('note-card')[2]!).getByRole('button', { name: /^Go to frame 20/ }));
    await waitFor(() => expect(screen.getAllByTestId('markup-marker')).toHaveLength(1));
    expect(screen.getByTestId('markup-marker')).toHaveAttribute('title', 'late one');

    await user.click(within(first()).getByRole('button', { name: 'Mark as resolved' }));
    expect(first()).toHaveAttribute('data-state', 'resolved');
    expect(screen.getByTestId('send-notes')).toHaveTextContent('Send 2 notes');
    await user.click(within(first()).getByRole('button', { name: 'Mark as not resolved' }));
    expect(screen.getByTestId('send-notes')).toHaveTextContent('Send 3 notes');

    await user.click(within(first()).getByRole('button', { name: 'Delete this note' }));
    expect(screen.getAllByTestId('note-card')).toHaveLength(2);
  });
});

describe('sending the notes to the agent', () => {
  let uploads: string[];
  beforeEach(() => {
    uploads = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const name = decodeURIComponent(new URL(url, 'http://studio.test').searchParams.get('name') ?? 'x.png');
        uploads.push(name);
        return new Response(JSON.stringify({ file: name, src: `public/refs/${name}` }), { status: 201 });
      }),
    );
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        set src(_: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' }))) as never);
    vi.spyOn(Date, 'now').mockReturnValue(4242);
  });
  afterEach(() => vi.unstubAllGlobals());
  const ctxStub = () => {
    const target: Record<string, unknown> = {};
    return new Proxy(target, { get: (t, k: string) => (k === 'measureText' ? () => ({ width: 10 }) : k in t ? t[k] : () => undefined), set: (t, k: string, v) => ((t[k] = v), true) });
  };
  const prompts = (server: MockServer) => server.agentMessages.filter((m) => m.type === 'agent.prompt') as Extract<(typeof server.agentMessages)[number], { type: 'agent.prompt' }>[];

  it('Cmd+Enter in the bubble sends that one note now, with the annotated frame as an image attachment', async () => {
    const { server } = await start();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctxStub()) as never);
    key('m');
    clickAt(20, 10);
    fireEvent.change(bubbleBox(), { target: { value: 'make this bigger' } });
    fireEvent.keyDown(bubbleBox(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    const message = prompts(server)[0]!;
    expect(message.text).toContain('Markup notes on Intro: 1 in time order.');
    expect(message.text).toContain('1. frame 0 (00:00.00), pin 40,20 over Text “Hello”: make this bigger [markup-4242-1.png]');
    expect(message.attachments!.map((a) => a.name)).toEqual(['markup-4242-1.png']);
    expect(uploads).toEqual(['markup-4242-1.png']);
    // the note stays on the picture in the sent style
    await waitFor(() => expect(screen.getByTestId('markup-marker')).toHaveAttribute('data-state', 'sent'));
  });

  it('Enter only adds to the tray; "Send N notes" sends them all, in time order, as one message, and Clear sent removes them', async () => {
    const { server, user } = await start();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctxStub()) as never);
    key('m');
    clickAt(100, 100);
    fireEvent.change(bubbleBox(), { target: { value: 'one' } });
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    clickAt(200, 200);
    fireEvent.change(bubbleBox(), { target: { value: 'two' } });
    fireEvent.keyDown(bubbleBox(), { key: 'Enter' });
    expect(prompts(server)).toHaveLength(0);
    await user.click(screen.getByTestId('send-notes'));
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    const text = prompts(server)[0]!.text;
    expect(text).toContain('Markup notes on Intro: 2 in time order.');
    expect(text.indexOf('1. frame 0')).toBeLessThan(text.indexOf('2. frame 0'));
    // both are on frame 0: one picture
    expect(prompts(server)[0]!.attachments).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('send-notes')).toBeDisabled());
    expect(screen.getByTestId('send-notes')).toHaveTextContent('Send 0 notes');
    for (const m of screen.getAllByTestId('markup-marker')) expect(m).toHaveAttribute('data-state', 'sent');
    await user.click(screen.getByTestId('notes-toggle'));
    await user.click(screen.getByRole('button', { name: 'Clear sent' }));
    expect(screen.queryByTestId('markup-marker')).toBeNull();
  });
});
