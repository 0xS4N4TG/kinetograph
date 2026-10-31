import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../src/app';
import { ApiError, type TimelineData } from '../src/api';
import { decode, draws } from './canvas';
import { intro, job, outro } from './fixtures';
import { MockServer } from './mock-server';

/** Starts the studio; the timeline is opened to its rows unless `slim` (it starts folded to a scrubber). */
async function start(server = new MockServer(), { slim = false } = {}) {
  const user = userEvent.setup();
  render(<App api={server} />);
  await waitFor(() => expect(server.frameRequests.length).toBeGreaterThan(0));
  if (!slim) await user.click(screen.getByRole('button', { name: 'Expand the timeline' }));
  return { server, user };
}

/** The inspector's Scene tab, opened. */
async function openScene(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'Scene' }));
  return screen.findByTestId('scene-tree');
}

const counter = () => screen.getByTestId('frame-counter');
/** Picks a layer by clicking it in the scene tree (its tooltip starts `id (type)`). */
async function pickInTree(user: ReturnType<typeof userEvent.setup>, id: string) {
  const tree = await openScene(user);
  await user.click(within(tree).getByTitle(new RegExp(`^${id} \\(`)));
}
/** A composition's button in the top bar's switcher, which is opened first. */
async function compButton(user: ReturnType<typeof userEvent.setup>, name: string) {
  const trigger = screen.getByTestId('composition-switcher');
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    // a popover that was just closed is still leaving
    await waitFor(() => expect(screen.queryByTestId('composition-list')).not.toBeInTheDocument());
    await user.click(trigger);
  }
  return within(await screen.findByTestId('composition-list')).getByRole('button', { name: new RegExp(`^${name}`) });
}

describe('composition list', () => {
  it('loads the compositions, selects the first and asks for its first frame', async () => {
    const { server, user } = await start();
    expect(await compButton(user, 'Intro')).toHaveAttribute('aria-pressed', 'true');
    expect(await compButton(user, 'Outro')).toHaveAttribute('aria-pressed', 'false');
    expect(within(await compButton(user, 'Intro')).getByText('1920x1080 · 30 fps · 150 f')).toBeInTheDocument();
    expect(server.frameRequests[0]).toMatchObject({ comp: 'Intro', frame: 0, scale: 1, format: 'png' });
    expect(server.frameRequests[0]!.props).toBeUndefined();
    expect(counter()).toHaveTextContent('0 / 150');
    expect(screen.queryByText(/connected|offline/)).not.toBeInTheDocument();
  });

  it('selects another composition on click and renders it', async () => {
    const { server, user } = await start();
    await user.click(await compButton(user, 'Outro'));
    expect(await compButton(user, 'Outro')).toHaveAttribute('aria-pressed', 'true');
    expect(await compButton(user, 'Intro')).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(server.lastFrameRequest).toMatchObject({ comp: 'Outro', frame: 0 }));
    expect(counter()).toHaveTextContent('0 / 48');
    await waitFor(() => expect(server.timelineCalls.at(-1)?.comp).toBe('Outro'));
  });
});

describe('preview', () => {
  it('draws the frame it receives on a canvas sized to the composition', async () => {
    const { server } = await start();
    await waitFor(() => expect(draws).toHaveLength(1));
    expect(draws[0]).toMatchObject({ size: server.frameRequests[0]!.requestId, type: 'image/png' });
    const canvas = screen.getByTestId('preview-canvas') as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
  });

  it('asks for scale 0.5 JPEG while playing and scale 1 PNG when paused', async () => {
    const { server, user } = await start();
    await user.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(server.lastFrameRequest).toMatchObject({ scale: 0.5, format: 'jpeg' }));
    await waitFor(() => expect(server.frameRequests.filter((r) => r.format === 'jpeg').length).toBeGreaterThan(3));
    // frames skip forward at the composition's pace
    expect(server.lastFrameRequest.frame).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(server.lastFrameRequest).toMatchObject({ scale: 1, format: 'png' }));
    expect(counter()).toHaveTextContent(`${server.lastFrameRequest.frame} / 150`);
    const paused = server.frameRequests.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.frameRequests).toHaveLength(paused);
  });

  it('shows the latest frame when replies arrive out of order', async () => {
    const server = new MockServer();
    server.auto = false;
    const { user } = await start(server);
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(server.frameRequests).toHaveLength(4));
    expect(server.frameRequests.map((r) => r.frame)).toEqual([0, 1, 2, 3]);

    server.respond(4);
    server.respond(2);
    server.respond(3);
    server.respond(1);
    await waitFor(() => expect(draws).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(draws.map((d) => d.size)).toEqual([4]);
  });

  it('does not draw a frame whose decoding finishes after a newer frame was drawn', async () => {
    const server = new MockServer();
    server.auto = false;
    const { user } = await start(server);
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(server.frameRequests).toHaveLength(2));

    decode.delay = (size) => (size === 1 ? 60 : 0);
    server.respond(1);
    server.respond(2);
    await waitFor(() => expect(draws).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(draws.map((d) => d.size)).toEqual([2]);
  });

  it('covers the preview with the build error until the next good build, then refetches and re-renders', async () => {
    const { server } = await start();
    const requests = server.frameRequests.length;
    const timelineCalls = server.timelineCalls.length;

    server.failBuild({ code: 'BUILD', message: 'scene.tsx:4:9: Unexpected token' });
    const overlay = await screen.findByRole('alertdialog', { name: 'Build error' });
    expect(overlay).toHaveTextContent('scene.tsx:4:9: Unexpected token');
    expect(server.frameRequests).toHaveLength(requests);

    server.reload([{ ...intro, durationInFrames: 200 }, outro]);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(counter()).toHaveTextContent('0 / 200'));
    await waitFor(() => expect(server.frameRequests.length).toBeGreaterThan(requests));
    expect(screen.getByText('build 2')).toBeInTheDocument();
    await waitFor(() => expect(server.timelineCalls.length).toBeGreaterThan(timelineCalls));
  });

  it('shows a build error that is already there at load, and the list once a build works', async () => {
    const server = new MockServer();
    server.noGoodBuild = true;
    server.projectInfo = { ...server.projectInfo, buildId: 0, buildError: { code: 'BUILD', message: 'cannot resolve ./missing' } };
    const user = userEvent.setup();
    render(<App api={server} />);
    expect(await screen.findByRole('alertdialog', { name: 'Build error' })).toHaveTextContent('cannot resolve ./missing');
    await user.click(screen.getByTestId('composition-switcher'));
    expect(screen.getByText('No compositions.')).toBeInTheDocument();

    server.noGoodBuild = false;
    server.reload();
    expect(await within(screen.getByTestId('composition-list')).findByRole('button', { name: /^Intro/ })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(server.frameRequests.length).toBeGreaterThan(0));
  });

  it('shows a failed frame request without hiding the preview', async () => {
    const { server } = await start();
    server.send({ type: 'error', requestId: server.lastFrameRequest.requestId + 1, error: { code: 'RENDER', message: 'font missing' } });
    expect(await screen.findByText('font missing')).toBeInTheDocument();
    expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
  });
});

describe('transport', () => {
  it('plays and pauses on space, steps on the arrow keys and by 10 with shift', async () => {
    const { server, user } = await start();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();

    const before = counter().textContent;
    await user.keyboard('{ArrowRight}');
    expect(counter()).toHaveTextContent(/^(\d+) \/ 150$/);
    const start0 = Number(before!.split(' ')[0]);
    expect(Number(counter().textContent!.split(' ')[0])).toBe(start0 + 1);

    const at = Number(counter().textContent!.split(' ')[0]);
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(counter()).toHaveTextContent(`${at + 10} / 150`);
    await user.keyboard('{ArrowLeft}');
    expect(counter()).toHaveTextContent(`${at + 9} / 150`);
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(counter()).toHaveTextContent(`${Math.max(0, at - 1)} / 150`);
    await waitFor(() => expect(server.lastFrameRequest).toMatchObject({ frame: Math.max(0, at - 1), scale: 1, format: 'png' }));
  });

  it('steps with the buttons, shows the timecode and toggles loop', async () => {
    const { user } = await start();
    await user.click(screen.getByRole('button', { name: 'Next frame' }));
    await user.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(counter()).toHaveTextContent('2 / 150');
    expect(screen.getByTestId('timecode')).toHaveTextContent('00:00.02');
    await user.click(screen.getByRole('button', { name: 'Previous frame' }));
    expect(counter()).toHaveTextContent('1 / 150');
    const loop = screen.getByRole('button', { name: 'Loop' });
    expect(loop).toHaveAttribute('aria-pressed', 'false');
    await user.click(loop);
    expect(loop).toHaveAttribute('aria-pressed', 'true');
  });

  it('leaves the keys alone while typing in a field', async () => {
    const { user } = await start();
    await user.click(screen.getByRole('tab', { name: 'Props' }));
    const title = screen.getByLabelText('title');
    await user.click(title);
    await user.keyboard(' {ArrowLeft}{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(counter()).toHaveTextContent('0 / 150');
  });
});

describe('timeline', () => {
  it('starts with the Sequences only, collapsed; a chevron opens a Sequence to its child Sequences and components', async () => {
    const { user } = await start();
    const first = await screen.findAllByTestId('sequence-row');
    expect(first.map((r) => r.getAttribute('data-testid'))).toEqual(['sequence-row']);
    expect(first[0]).toHaveTextContent('Scene');
    expect(screen.queryAllByTestId('component-row')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Expand Scene' }));
    const rows = screen.getAllByTestId(/sequence-row|component-row/);
    expect(rows.map((r) => r.querySelector('[data-testid="row-select"]')!.getAttribute('title'))).toEqual([
      'Scene\nframes 0..149',
      'Title card\nframes 10..69',
      'Sequence\nframes 80..119',
      'bg\nframes 0..149',
    ]);
    const labelOf = (row: HTMLElement) => row.firstElementChild as HTMLElement;
    expect(labelOf(rows[0]!)).toHaveClass('pl-2');
    expect(labelOf(rows[1]!)).toHaveClass('pl-5');
    expect(labelOf(rows[3]!)).toHaveClass('pl-5');

    await user.click(screen.getByRole('button', { name: 'Expand Title card' }));
    expect(screen.getAllByTestId('component-row').map((r) => r.querySelector('[data-testid="row-select"]')!.textContent)).toContain('title-group');
  });

  it('shows a picture of the first frame on clips wide enough for one, from the build it was drawn for', async () => {
    const { user } = await start();
    await user.click(await screen.findByRole('button', { name: 'Expand Scene' }));
    const thumbs = within(screen.getByTestId('timeline')).getAllByTestId('bar-thumbnail');
    expect(thumbs.length).toBeGreaterThan(0);
    const src = thumbs[0]!.getAttribute('src')!;
    expect(src).toMatch(/^\/api\/thumbnail\?comp=[^&]+&frame=\d+&height=48&build=\d+$/);
    expect(thumbs[0]).toHaveAttribute('loading', 'lazy');
  });

  it('plain names by default; Show details adds kind tags and the pieces, and is remembered', async () => {
    const { user } = await start();
    await user.click(await screen.findByRole('button', { name: 'Expand Scene' }));
    const timeline = screen.getByTestId('timeline');
    expect(within(timeline).queryByText('shape')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByRole('button', { name: 'Show details' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(timeline).getByText('shape')).toBeInTheDocument();
    expect(window.localStorage.getItem('kinetograph.studio.timeline.details')).toBe('1');
    await user.click(screen.getByRole('button', { name: 'Show details' }));
    expect(window.localStorage.getItem('kinetograph.studio.timeline.details')).toBe('0');
  });

  it('a click on a row seeks to its first visible frame and selects its layers', async () => {
    const { user } = await start();
    await user.click(await screen.findByRole('button', { name: 'Expand Scene' }));
    const card = screen.getAllByTestId('sequence-row')[1]!;
    await user.click(within(card).getByTestId('row-select'));
    expect(counter()).toHaveTextContent('10 / 150');
    expect(within(card).getByTestId('row-select')).toHaveAttribute('aria-pressed', 'true');
    // Already inside the bar: the playhead stays.
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(counter()).toHaveTextContent('12 / 150');
    await user.click(within(card).getByTestId('row-select'));
    expect(counter()).toHaveTextContent('12 / 150');
  });

  it('shows labels with the component and source line, and no generated id, when the server names the layers', async () => {
    const source = { file: 'examples/showcase/shots-a.tsx', line: 212, column: 7 };
    class Named extends MockServer {
      override timelineFor(comp: string): TimelineData {
        const data = super.timelineFor(comp);
        return {
          ...data,
          sequences: data.sequences.map((s) => (s.name === null ? { ...s, label: 'Opening', component: 'Main', source } : s)),
          layers: data.layers.map((l) => (l.id === 'title' ? { ...l, id: '$0.1', label: 'Title \u00b7 \u201cHello\u201d', component: 'Title', source } : l)),
        };
      }
    }
    const { user } = await start(new Named());
    await user.click(await screen.findByRole('button', { name: 'Expand Scene' }));
    const sequences = screen.getAllByTestId('sequence-row');
    const opening = within(sequences[2]!).getByTestId('row-select');
    expect(opening).toHaveAttribute('title', 'Opening \u00b7 Main \u00b7 examples/showcase/shots-a.tsx:212:7\nframes 80..119');
    expect(opening).toHaveTextContent('Opening');
    await user.click(screen.getByRole('button', { name: 'Expand Title card' }));
    await user.click(screen.getByRole('button', { name: 'Expand title-group' }));
    const row = screen.getAllByTestId('component-row').find((r) => r.textContent?.includes('Hello'))!;
    // Simple view: the name only. Details: the component and the file.
    expect(row).toHaveTextContent('Title \u00b7 \u201cHello\u201d');
    expect(row).not.toHaveTextContent('shots-a.tsx');
    await user.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getAllByTestId('component-row').find((r) => r.textContent?.includes('Hello'))).toHaveTextContent('Title \u00b7 shots-a.tsx:212');
    expect(row).not.toHaveTextContent('$0.1');
  });

  it('shows the progress of reading the timeline, never an empty list, until the rows arrive', async () => {
    const server = new MockServer();
    let open!: () => void;
    server.timelineGate = new Promise<void>((resolve) => (open = resolve));
    server.progress = { done: 300, total: 1521 };
    await start(server);
    expect(await screen.findByText('Reading the timeline: frame 300 of 1521')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-loading')).toBeInTheDocument();
    expect(screen.queryByText('No Sequences')).not.toBeInTheDocument();
    expect(screen.queryByText('No layers')).not.toBeInTheDocument();
    open();
    expect(await screen.findAllByTestId('sequence-row')).toHaveLength(1);
    expect(screen.queryByTestId('timeline-loading')).not.toBeInTheDocument();
  });

  it('draws a sound as a row with its waveform, and asks the server for the peaks', async () => {
    const server = new MockServer();
    server.sounds = [{ id: 'tone-key', src: 'sfx/tone.wav', ranges: [[20, 99]] }];
    await start(server);
    const row = await screen.findByTestId('audio-row');
    expect(row).toHaveTextContent('tone.wav');
    expect(await screen.findByTestId('waveform')).toBeInTheDocument();
    expect(server.waveformCalls[0]).toMatchObject({ clip: 'tone-key' });
  });

  it('keeps drawing the timeline it has while a newer one is read, with a thin progress line', async () => {
    const server = new MockServer();
    await start(server);
    expect(await screen.findAllByTestId('sequence-row')).toHaveLength(1);
    let open!: () => void;
    server.timelineGate = new Promise<void>((resolve) => (open = resolve));
    server.reload();
    expect(await screen.findByTestId('timeline-refreshing')).toBeInTheDocument();
    // The rows stay, no empty or loading state.
    expect(screen.getAllByTestId('sequence-row')).toHaveLength(1);
    expect(screen.queryByTestId('timeline-loading')).not.toBeInTheDocument();
    open();
    await vi.waitFor(() => expect(screen.queryByTestId('timeline-refreshing')).not.toBeInTheDocument());
    expect(screen.getAllByTestId('sequence-row')).toHaveLength(1);
  });

  it('shows the error, not an empty list, when the timeline cannot be read', async () => {
    const server = new MockServer();
    server.timelineError = new ApiError('PROJECT_ERROR', 'the composition threw at frame 12', 500);
    await start(server);
    expect(await screen.findByTestId('timeline-error')).toHaveTextContent('Could not read the timeline: the composition threw at frame 12');
    expect(screen.queryByText('No Sequences')).not.toBeInTheDocument();
  });

  it('moves the playhead and asks for preview-quality frames while the film strip is dragged, full quality on release', async () => {
    const { server } = await start();
    const ruler = screen.getByTestId('timeline-ruler');
    vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 0, right: 1600, bottom: 28, width: 1500, height: 28, x: 100, y: 0, toJSON: () => ({}),
    });
    const strip = screen.getByTestId('filmstrip').closest('[data-lane]')!;
    const playhead = screen.getByTestId('playhead');
    const left0 = playhead.style.left;

    fireEvent.pointerDown(strip, { clientX: 400, pointerId: 1 }); // 300px of 1500 = frame 30
    expect(counter()).toHaveTextContent('30 / 150');
    expect(server.lastFrameRequest).toMatchObject({ frame: 30, scale: 0.5, format: 'jpeg' });
    expect(playhead.style.left).not.toBe(left0);

    fireEvent.pointerMove(strip, { clientX: 850, pointerId: 1 }); // frame 75
    expect(counter()).toHaveTextContent('75 / 150');
    expect(server.lastFrameRequest).toMatchObject({ frame: 75, scale: 0.5, format: 'jpeg' });

    fireEvent.pointerUp(strip, { clientX: 850, pointerId: 1 });
    expect(server.lastFrameRequest).toMatchObject({ frame: 75, scale: 1, format: 'png' });

    // moving without a button down does not scrub
    fireEvent.pointerMove(strip, { clientX: 1000, pointerId: 1 });
    expect(counter()).toHaveTextContent('75 / 150');

    // past the ends clamps to the first and last frame
    fireEvent.pointerDown(strip, { clientX: 5000, pointerId: 1 });
    expect(counter()).toHaveTextContent('149 / 150');
    fireEvent.pointerMove(strip, { clientX: -50, pointerId: 1 });
    expect(counter()).toHaveTextContent('0 / 150');
    fireEvent.pointerUp(strip);
  });

  it('a drag across the ruler picks a span, the playhead stays; Shift extends it, Escape clears it', async () => {
    const { server } = await start();
    const ruler = screen.getByTestId('timeline-ruler');
    vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 0, right: 1600, bottom: 28, width: 1500, height: 28, x: 100, y: 0, toJSON: () => ({}),
    });
    expect(screen.queryByTestId('time-range')).not.toBeInTheDocument();
    fireEvent.pointerDown(ruler, { clientX: 400, pointerId: 1 }); // frame 30
    fireEvent.pointerMove(ruler, { clientX: 850, pointerId: 1 }); // frame 75
    fireEvent.pointerUp(ruler, { clientX: 850, pointerId: 1 });
    expect(screen.getByTestId('time-range')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Range start' })).toHaveAttribute('aria-valuenow', '30');
    expect(screen.getByRole('slider', { name: 'Range end' })).toHaveAttribute('aria-valuenow', '75');
    expect(screen.getByTestId('selection-chips')).toHaveTextContent('Intro · 0:01.0–0:02.5 (frames 30–75)');
    expect(server.lastFrameRequest).toMatchObject({ frame: 30 });

    // shift-drag widens it
    fireEvent.pointerDown(ruler, { clientX: 1300, pointerId: 1, shiftKey: true }); // frame 120
    fireEvent.pointerUp(ruler, { pointerId: 1 });
    expect(screen.getByRole('slider', { name: 'Range end' })).toHaveAttribute('aria-valuenow', '120');
    expect(screen.getByRole('slider', { name: 'Range start' })).toHaveAttribute('aria-valuenow', '30');

    // a grip moves with the arrow keys
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Range start' }), { key: 'ArrowRight' });
    expect(screen.getByRole('slider', { name: 'Range start' })).toHaveAttribute('aria-valuenow', '31');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('time-range')).not.toBeInTheDocument();
  });

  it('selects the layer of a clicked row in the scene tree and shows its resolved fields', async () => {
    const { user } = await start();
    await user.click(await screen.findByRole('button', { name: 'Expand Scene' }));
    await user.click(screen.getByRole('tab', { name: 'Props' }));

    // a Sequence row selects its group in the scene tree, which comes to the front
    await user.click(within(screen.getAllByTestId('sequence-row')[1]!).getByTestId('row-select'));
    const tree = await openScene(user);
    await waitFor(() => expect(within(screen.getByTestId('layer-details')).getByText('title-group')).toBeInTheDocument());

    // with details on, the pieces are rows too
    await user.click(screen.getByRole('button', { name: 'Show details' }));
    await user.click(screen.getByRole('button', { name: 'Expand Title card' }));
    await user.click(screen.getByRole('button', { name: 'Expand title-group' }));
    const titleRow = screen.getAllByTestId('component-row').find((r) => r.textContent?.startsWith('title') && !r.textContent.startsWith('title-group'))!;
    await user.click(within(titleRow).getByTestId('row-select'));
    const selected = within(tree).getAllByRole('treeitem').filter((i) => i.getAttribute('aria-selected') === 'true');
    expect(selected.map((i) => i.firstElementChild!.textContent)).toEqual(['titletext']);
    const details = await within(tree).findByTestId('layer-details');
    expect(details).toHaveTextContent('Inter 64');
    expect(details).toHaveTextContent('dropShadow');
    expect(within(titleRow).getByTestId('row-select')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the scene tree of the current frame with the topmost layer first, children nested', async () => {
    const { server, user } = await start();
    const tree = await openScene(user);
    const ids = within(tree).getAllByRole('treeitem').map((i) => i.querySelector('.truncate')!.textContent);
    expect(ids).toEqual(['title-group', 'title', 'bg']);
    expect(tree).toHaveTextContent('1920x1080');
    // the Scene tab has focus, and arrow keys move between tabs: let go of it first
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(server.inspectCalls.at(-1)).toMatchObject({ comp: 'Intro', frame: 1 }));
    await waitFor(() => expect(screen.getByTestId('scene-tree')).toHaveTextContent('frame 1'));
  });
});

describe('props panel', () => {
  it('lists the defaultProps as a form, and an edit re-renders the preview with the new props', async () => {
    const { server, user } = await start();
    await user.click(screen.getByRole('tab', { name: 'Props' }));
    const title = screen.getByLabelText('title');
    expect(title).toHaveValue('Hello');
    expect(screen.getByLabelText('size')).toHaveValue(64);
    expect(screen.getByRole('switch', { name: 'visible' })).toBeChecked();
    expect(screen.getByLabelText('color')).toHaveValue('#ff0000');
    expect(screen.getByLabelText('style')).toHaveValue(JSON.stringify({ bold: true }, null, 2));
    expect(screen.getByRole('button', { name: /Reset/ })).toBeDisabled();

    await user.clear(title);
    await user.type(title, 'Bye');
    await waitFor(() =>
      expect(server.lastFrameRequest.props).toEqual({ title: 'Bye', size: 64, visible: true, color: '#ff0000', style: { bold: true } }),
    );
    expect(server.lastFrameRequest).toMatchObject({ comp: 'Intro', scale: 1, format: 'png' });
    await waitFor(() => expect(server.inspectCalls.at(-1)?.props).toMatchObject({ title: 'Bye' }));
    await waitFor(() => expect(server.timelineCalls.at(-1)?.props).toMatchObject({ title: 'Bye' }));
    expect(screen.getByRole('button', { name: /Reset/ })).toBeEnabled();
  });

  it('edits numbers, booleans and nested values, and ignores JSON that does not parse', async () => {
    const { server, user } = await start();
    await user.click(screen.getByRole('tab', { name: 'Props' }));

    const size = screen.getByLabelText('size');
    await user.clear(size);
    expect(server.lastFrameRequest.props).toBeUndefined(); // an empty box is not a number
    await user.type(size, '96');
    await waitFor(() => expect(server.lastFrameRequest.props).toMatchObject({ size: 96 }));

    await user.click(screen.getByRole('switch', { name: 'visible' }));
    await waitFor(() => expect(server.lastFrameRequest.props).toMatchObject({ size: 96, visible: false }));

    const style = screen.getByLabelText('style');
    const requests = server.frameRequests.length;
    fireEvent.change(style, { target: { value: '{ "bold": ' } });
    expect(screen.getByText(/Not valid JSON/)).toBeInTheDocument();
    expect(server.frameRequests).toHaveLength(requests);
    fireEvent.change(style, { target: { value: '{ "bold": false, "tags": ["a"] }' } });
    await waitFor(() => expect(server.lastFrameRequest.props).toMatchObject({ style: { bold: false, tags: ['a'] } }));
    expect(screen.queryByText(/Not valid JSON/)).not.toBeInTheDocument();
  });

  it('resets to the defaults and asks for the frame without props', async () => {
    const { server, user } = await start();
    await user.click(screen.getByRole('tab', { name: 'Props' }));
    await user.click(screen.getByRole('switch', { name: 'visible' }));
    await waitFor(() => expect(server.lastFrameRequest.props).toMatchObject({ visible: false }));

    await user.click(screen.getByRole('button', { name: /Reset/ }));
    await waitFor(() => expect(server.lastFrameRequest.props).toBeUndefined());
    expect(screen.getByRole('switch', { name: 'visible' })).toBeChecked();
    expect(screen.getByRole('button', { name: /Reset/ })).toBeDisabled();
  });

  it('says so when a composition has no props, and keeps edits per composition', async () => {
    const { server, user } = await start();
    await user.click(screen.getByRole('tab', { name: 'Props' }));
    await user.click(screen.getByRole('switch', { name: 'visible' }));
    await user.click(await compButton(user, 'Outro'));
    expect(await screen.findByText('This composition has no props.')).toBeInTheDocument();
    await waitFor(() => expect(server.lastFrameRequest).toMatchObject({ comp: 'Outro' }));
    expect(server.lastFrameRequest.props).toBeUndefined();
    await user.click(await compButton(user, 'Intro'));
    await waitFor(() => expect(server.lastFrameRequest.props).toMatchObject({ visible: false }));
  });
});

describe('render queue', () => {
  async function openRenders() {
    const ctx = await start();
    await ctx.user.click(screen.getByRole('tab', { name: /Renders/ }));
    return ctx;
  }

  it('starts a render of the current composition with the range and output, and follows its progress live', async () => {
    const { server, user } = await openRenders();
    expect(screen.getByText('No renders yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /New render/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Output'), 'out/test.mp4');
    await user.click(within(dialog).getByRole('radio', { name: 'Custom' }));
    await user.clear(within(dialog).getByLabelText('Start'));
    await user.type(within(dialog).getByLabelText('Start'), '00:00.10');
    await user.clear(within(dialog).getByLabelText('End'));
    await user.type(within(dialog).getByLabelText('End'), '1.33');
    expect(within(dialog).getByTestId('export-summary')).toHaveTextContent('1 s, 31 frames');
    await user.click(within(dialog).getByRole('button', { name: 'Start export' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.startRenderCalls).toEqual([{ comp: 'Intro', output: 'out/test.mp4', range: '10..40' }]);
    const item = await screen.findByTestId('render-job-1');
    expect(item).toHaveTextContent('queued');
    expect(item).toHaveTextContent('10..40');
    expect(item).toHaveTextContent('/work/out/test.mp4');

    const queued = server.jobs[0]!;
    server.pushJob({ ...queued, status: 'running', framesDone: 15, framesTotal: 31, msPerFrame: 1000 });
    await waitFor(() => expect(item).toHaveTextContent('running'));
    expect(item).toHaveTextContent('15 / 31 frames');
    expect(item).toHaveTextContent('ETA 16s');
    expect(within(item).getByRole('progressbar')).toHaveAttribute('aria-valuenow', String((15 / 31) * 100));
    expect(screen.getByRole('tab', { name: /Renders/ })).toHaveTextContent('1');

    server.pushJob({ ...queued, status: 'done', framesDone: 31, framesTotal: 31, msPerFrame: 900, finishedAt: 5_000 });
    await waitFor(() => expect(item).toHaveTextContent('done'));
    expect(item).toHaveTextContent('31 / 31 frames');
    expect(item).toHaveTextContent('/work/out/test.mp4');
    expect(within(item).queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument();
  });

  it('cancels a job', async () => {
    const server = new MockServer();
    server.jobs = [job('1', { status: 'running', framesDone: 10, msPerFrame: 100 }), job('2')];
    const { user } = await start(server);
    await user.click(screen.getByRole('tab', { name: /Renders/ }));

    expect(await screen.findByTestId('render-job-2')).toHaveTextContent('queued');
    await user.click(within(screen.getByTestId('render-job-1')).getByRole('button', { name: 'Cancel render 1' }));
    expect(server.cancelCalls).toEqual(['1']);
    await waitFor(() => expect(screen.getByTestId('render-job-1')).toHaveTextContent('cancelled'));
    expect(within(screen.getByTestId('render-job-1')).queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('render-job-2')).toHaveTextContent('queued');
  });

  it('lists the newest job first and shows a failed job\'s error', async () => {
    const server = new MockServer();
    server.jobs = [job('1', { status: 'done', framesDone: 150 }), job('2', { status: 'failed', error: { code: 'ENCODE', message: 'ffmpeg exited 1' } })];
    const { user } = await start(server);
    await user.click(screen.getByRole('tab', { name: /Renders/ }));
    const items = await screen.findAllByTestId(/^render-job-/);
    expect(items.map((i) => i.getAttribute('data-testid'))).toEqual(['render-job-2', 'render-job-1']);
    expect(items[0]).toHaveTextContent('ENCODE: ffmpeg exited 1');
  });

  it('sends the edited props with the render, and shows the server\'s refusal in the dialog', async () => {
    const { server, user } = await start();
    await user.click(screen.getByRole('tab', { name: 'Props' }));
    await user.click(screen.getByRole('switch', { name: 'visible' }));
    await user.click(screen.getByRole('tab', { name: /Renders/ }));

    server.startRenderError = new ApiError('INVALID_ARG', 'bad range "9..x"', 400);
    await user.click(screen.getByRole('button', { name: /New render/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('with the props edited');
    await user.click(within(dialog).getByRole('radio', { name: 'Custom' }));
    await user.clear(within(dialog).getByLabelText('Start'));
    await user.type(within(dialog).getByLabelText('Start'), '00:00.09');
    await user.click(within(dialog).getByRole('switch', { name: /Draft/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Start export' }));

    expect(await within(dialog).findByText('bad range "9..x"')).toBeInTheDocument();
    expect(server.startRenderCalls[0]).toEqual({
      comp: 'Intro',
      range: '9..149',
      draft: true,
      props: { title: 'Hello', size: 64, visible: false, color: '#ff0000', style: { bold: true } },
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('transport controls', () => {
  it('goes to the first and last frame on Home and End, and toggles loop on L', async () => {
    const { user } = await start();
    await user.keyboard('{End}');
    expect(counter()).toHaveTextContent('149 / 150');
    await user.keyboard('{Home}');
    expect(counter()).toHaveTextContent('0 / 150');
    const loop = screen.getByRole('button', { name: 'Loop' });
    await user.keyboard('l');
    expect(loop).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('L');
    expect(loop).toHaveAttribute('aria-pressed', 'false');
  });

  it('takes a frame number or a timecode: Enter seeks, Escape cancels, a bad one stays open', async () => {
    const { user } = await start();
    const field = () => screen.getByRole('textbox', { name: 'Go to frame or timecode' });
    await user.click(screen.getByTestId('timecode'));
    await user.clear(field());
    await user.type(field(), '00:02:00{Enter}');
    expect(counter()).toHaveTextContent('60 / 150');
    expect(screen.getByTestId('timecode')).toHaveTextContent('00:02.00');

    await user.click(screen.getByTestId('timecode'));
    await user.clear(field());
    await user.type(field(), '7{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Go to frame or timecode' })).not.toBeInTheDocument();
    expect(counter()).toHaveTextContent('60 / 150');

    await user.click(screen.getByTestId('timecode'));
    await user.clear(field());
    await user.type(field(), 'nope{Enter}');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(counter()).toHaveTextContent('60 / 150');
  });
});

describe('keys and tools', () => {
  it('switches tools with V, H and Z, and sets the zoom with 1 and 0', async () => {
    const { user } = await start();
    const selection = screen.getByRole('button', { name: 'Selection' });
    expect(selection).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('h');
    expect(screen.getByRole('button', { name: 'Hand' })).toHaveAttribute('aria-pressed', 'true');
    expect(selection).toHaveAttribute('aria-pressed', 'false');
    await user.keyboard('z');
    expect(screen.getByRole('button', { name: 'Zoom' })).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('V');
    expect(selection).toHaveAttribute('aria-pressed', 'true');

    await user.keyboard('1');
    expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument();
    await user.keyboard('0');
    expect(screen.getByRole('button', { name: 'Fit (100%)' })).toBeInTheDocument();
  });

  it('opens the keyboard shortcuts with ?, and the playback keys wait while they are open', async () => {
    const { user } = await start();
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveTextContent('Show the frame at 100%');
    await user.keyboard('{ArrowRight}');
    expect(counter()).toHaveTextContent('0 / 150');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('viewer', () => {
  it('zooms in with the zoom tool, out with Alt, and the readout toggles fit and 100%', async () => {
    const { user } = await start();
    await user.keyboard('z');
    const frame = screen.getByTestId('frame');
    fireEvent.click(frame);
    expect(screen.getByRole('button', { name: '150%' })).toBeInTheDocument();
    fireEvent.click(frame, { altKey: true });
    expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '100%' }));
    expect(screen.getByRole('button', { name: 'Fit (100%)' })).toBeInTheDocument();
  });

  it('selects the topmost layer under the pointer, and none off the frame', async () => {
    const { user } = await start();
    await openScene(user);
    const frame = screen.getByTestId('frame');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 50, right: 2020, bottom: 1130, width: 1920, height: 1080, x: 100, y: 50, toJSON: () => ({}),
    });
    // Composition pixel (50, 25): on the title, which is inside its group and so on top of it.
    fireEvent.click(frame, { clientX: 150, clientY: 75 });
    expect(await screen.findByText('Properties: title')).toBeInTheDocument();
    // The pill on the outline shows the layer's name (never a generated `$0.1.2` path), with the id as its tooltip.
    expect(screen.getByTestId('selection-label')).toHaveTextContent('title');
    expect(screen.getByTestId('selection-label')).toHaveAttribute('title', 'title');
    fireEvent.click(frame, { clientX: 1500, clientY: 75 });
    expect(await screen.findByText('Select a layer to see its resolved fields.')).toBeInTheDocument();
  });

  it('pans with the hand tool while the button is down', async () => {
    const { user } = await start();
    await user.keyboard('h');
    const preview = screen.getByTestId('preview');
    fireEvent.pointerDown(preview, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(preview, { clientX: 40, clientY: 25, pointerId: 1 });
    fireEvent.pointerUp(preview, { pointerId: 1 });
    expect(screen.getByTestId('frame')).toHaveStyle({ transform: 'translate(30px, 15px)' });
    fireEvent.pointerMove(preview, { clientX: 500, clientY: 500, pointerId: 1 });
    expect(screen.getByTestId('frame')).toHaveStyle({ transform: 'translate(30px, 15px)' });
  });
});

/** Opens the command menu with Cmd+K and runs the action named `label` by typing it and pressing Enter. */
async function runCommand(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.keyboard('{Meta>}k{/Meta}');
  const input = await screen.findByRole('combobox', { name: 'Command' });
  await user.type(input, label);
  await user.keyboard('{Enter}');
}

describe('command menu', () => {
  it('opens with Cmd+K, runs the playback actions and the loop toggle', async () => {
    const { user } = await start();
    await runCommand(user, 'last frame');
    expect(counter()).toHaveTextContent('149 / 150');
    await runCommand(user, 'Loop on');
    expect(screen.getByRole('button', { name: 'Loop' })).toHaveAttribute('aria-pressed', 'true');
    await runCommand(user, 'first frame');
    expect(counter()).toHaveTextContent('0 / 150');
  });

  it('opens a page of compositions and selects one', async () => {
    const { user } = await start();
    await user.keyboard('{Meta>}k{/Meta}');
    const input = await screen.findByRole('combobox', { name: 'Command' });
    await user.type(input, 'go to comp');
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: 'Outro' }));
    await waitFor(() => expect(counter()).toHaveTextContent('0 / 48'));
    expect(await compButton(user, 'Outro')).toHaveAttribute('aria-pressed', 'true');
  });

  it('reaches the view, window and file actions the menu bar had', async () => {
    const { server, user } = await start();
    await runCommand(user, 'Safe zones');
    await runCommand(user, '100%');
    expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument();
    await runCommand(user, 'render queue');
    expect(screen.getByRole('tab', { name: /Renders/ })).toHaveAttribute('aria-selected', 'true');
    await runCommand(user, 'Export or');
    expect(await screen.findByRole('dialog', { name: /Export Intro/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await runCommand(user, 'Open Props');
    expect(screen.getByRole('tab', { name: 'Props' })).toHaveAttribute('aria-selected', 'true');

    const requests = server.frameRequests.length;
    await runCommand(user, 'Reload');
    await waitFor(() => expect(server.frameRequests.length).toBeGreaterThan(requests));

    await runCommand(user, 'Keyboard shortcuts');
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('shows overlays and the zoom steps in the preview\'s View menu', async () => {
    const { user } = await start();
    await user.click(screen.getByRole('button', { name: 'View options' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Safe zones/ }));
    expect(screen.getByRole('menuitemcheckbox', { name: /Safe zones/ })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'View options' }));
    await user.click(await screen.findByRole('menuitem', { name: /^100%/ }));
    expect(screen.getByRole('button', { name: '100%' })).toBeInTheDocument();
  });

  it('switches the theme and keeps it', async () => {
    const { user } = await start();
    expect(document.documentElement).toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: 'Use the light theme' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(window.localStorage.getItem('kg.theme')).toBe('light');
  });
});

describe('panels', () => {
  it('hides and shows the agent and the inspector', async () => {
    const { user } = await start();
    await user.click(screen.getByRole('button', { name: 'Hide the agent' }));
    expect(screen.queryByTestId('agent-panel')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show the agent' }));
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide the inspector' }));
    expect(screen.queryByRole('tab', { name: 'Props' })).not.toBeInTheDocument();
  });

  it('starts the timeline as a slim scrubber with a marker per Sequence, and the Export button opens the renders', async () => {
    const { user } = await start(new MockServer(), { slim: true });
    expect(await screen.findAllByTestId('marker')).not.toHaveLength(0);
    expect(screen.queryAllByTestId('sequence-row')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: /Export Intro/ });
    expect(dialog).toHaveTextContent('1920×1080 · 30 fps');
    expect(dialog).toHaveTextContent('150 frames');
    await user.click(within(dialog).getByRole('radio', { name: 'Custom' }));
    await user.click(within(dialog).getAllByRole('button', { name: 'Set to playhead' })[0]!);
    expect(within(dialog).getByLabelText('Start')).toHaveValue('00:00.00');
    await user.click(within(dialog).getByRole('button', { name: 'Start export' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /Renders/ })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('exporting')).toBeInTheDocument();
  });
});

describe('connection', () => {
  it('shows offline only while the socket is closed', async () => {
    const { server } = await start();
    expect(screen.queryByText('offline')).not.toBeInTheDocument();
    server.setConnected(false);
    expect(await screen.findByText('offline')).toBeInTheDocument();
    server.setConnected(true);
    await waitFor(() => expect(screen.queryByText('offline')).not.toBeInTheDocument());
  });
});

describe('copy for agent', () => {
  it('opens an editable message about the selected layer and copies what the user made of it', async () => {
    const { user } = await start();
    expect(screen.queryByRole('button', { name: 'Copy for agent' })).not.toBeInTheDocument();
    await pickInTree(user, 'title');
    await user.click(await screen.findByRole('button', { name: 'Copy for agent' }));

    const box = (await screen.findByRole('textbox', { name: 'Message for the agent' })) as HTMLTextAreaElement;
    expect(box.value).toContain('In scene.tsx, composition `Intro`, frame 0 (00:00:00):');
    expect(box.value).toContain('change the text layer `title`, text "Hello"');
    expect(box.selectionStart).toBe(box.value.length);

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.type(box, 'make it red');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\nChange: make it red$/));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});

describe('timeline controls', () => {
  it('scrubs from any lane, not only the ruler', async () => {
    const { server } = await start();
    await screen.findAllByTestId('sequence-row');
    const ruler = screen.getByTestId('timeline-ruler');
    vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 0, right: 1600, bottom: 28, width: 1500, height: 28, x: 100, y: 0, toJSON: () => ({}),
    });
    const lane = screen.getAllByTestId('sequence-row')[0]!.querySelector('[data-lane]')!;
    fireEvent.pointerDown(lane, { clientX: 400, pointerId: 1 });
    expect(counter()).toHaveTextContent('30 / 150');
    fireEvent.pointerUp(lane, { pointerId: 1 });
    expect(server.lastFrameRequest).toMatchObject({ frame: 30, scale: 1, format: 'png' });
  });

  it('zooms the time axis with the wheel while Ctrl or Cmd is held', async () => {
    await start();
    await screen.findAllByTestId('sequence-row');
    fireEvent.wheel(screen.getByTestId('timeline-ruler'), { deltaY: -100 });
    expect(screen.getByRole('slider', { hidden: true })).toHaveAttribute('aria-valuenow', '1');
    fireEvent.wheel(screen.getByTestId('timeline-ruler'), { ctrlKey: true, deltaY: -100 });
    expect(screen.getByRole('slider', { hidden: true })).toHaveAttribute('aria-valuenow', '1.25');
    fireEvent.wheel(screen.getByTestId('timeline-ruler'), { metaKey: true, deltaY: -100 });
    expect(screen.getByRole('slider', { hidden: true })).toHaveAttribute('aria-valuenow', '1.5625');
  });

  it('a search opens the way to what matches and hides the rest', async () => {
    const { user } = await start();
    await screen.findAllByTestId('sequence-row');
    await user.type(screen.getByRole('searchbox', { name: 'Search timeline' }), 'bg');
    const rows = screen.getAllByTestId(/sequence-row|component-row/);
    expect(rows.map((r) => r.querySelector('[data-testid="row-select"]')!.textContent)).toEqual(['Scene', 'bg']);
    await user.clear(screen.getByRole('searchbox', { name: 'Search timeline' }));
    expect(screen.getAllByTestId(/sequence-row|component-row/)).toHaveLength(1);
  });
});

describe('scene tree', () => {
  it('collapses a layer with children and expands it again', async () => {
    const { user } = await start();
    const tree = await openScene(user);
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(3);
    await user.click(within(tree).getByRole('button', { name: 'Collapse title-group' }));
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2);
    await user.click(within(tree).getByRole('button', { name: 'Expand title-group' }));
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(3);
  });

  it('collapses a property section', async () => {
    const { user } = await start();
    const tree = await openScene(user);
    await pickInTree(user, 'bg');
    const details = await within(tree).findByTestId('layer-details');
    expect(within(details).getByText('anchor')).toBeInTheDocument();
    await user.click(within(details).getByRole('button', { name: 'Layer Transform' }));
    expect(within(details).queryByText('anchor')).not.toBeInTheDocument();
    await user.click(within(details).getByRole('button', { name: 'Layer Transform' }));
    expect(within(details).getByText('anchor')).toBeInTheDocument();
  });
});
