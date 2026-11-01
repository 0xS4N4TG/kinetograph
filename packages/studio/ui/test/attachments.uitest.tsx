import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/app';
import type { AgentEvent } from '../src/api';
import { acceptImages, copyForAgent, fitSize, MAX_ATTACHMENTS } from '../src/lib/attachments';
import { MockServer } from './mock-server';

const png = (name = 'shot.png', bytes = 'pixels') => new File([bytes], name, { type: 'image/png' });
const dropOf = (files: File[]) => ({ dataTransfer: { types: ['Files'], files, items: [] } });
const pasteOf = (files: File[]) => ({ clipboardData: { types: ['Files'], files, items: [] } });

let uploads: { url: string; init: RequestInit }[];
let failWith: { status: number; message: string } | null;

beforeEach(() => {
  uploads = [];
  failWith = null;
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      uploads.push({ url, init });
      if (failWith) return new Response(JSON.stringify({ error: { code: 'INVALID_ARG', message: failWith.message } }), { status: failWith.status });
      const name = decodeURIComponent(new URL(url, 'http://studio.test').searchParams.get('name') ?? 'x.png');
      return new Response(JSON.stringify({ file: n++ === 0 ? name : name.replace(/\.(\w+)$/, '-2.$1'), src: `public/refs/${name}` }), { status: 201 });
    }),
  );
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

async function start() {
  const server = new MockServer();
  const user = userEvent.setup();
  render(<App api={server} />);
  await waitFor(() => expect(server.frameRequests.length).toBeGreaterThan(0));
  const panel = await screen.findByTestId('agent-panel');
  return { server, user, panel };
}
const say = (server: MockServer, event: AgentEvent) => act(() => server.send({ type: 'agent', event }));
const prompts = (server: MockServer) => server.agentMessages.filter((m) => m.type === 'agent.prompt') as Extract<(typeof server.agentMessages)[number], { type: 'agent.prompt' }>[];

describe('the attach button', () => {
  it('opens the file picker, which takes the same images as a drop (limits and errors included)', async () => {
    const { user } = await start();
    const input = screen.getByTestId('attach-input') as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('multiple');
    expect(input.accept).toBe('image/png,image/jpeg,image/webp,image/gif,image/avif');
    const clicked = vi.fn();
    input.addEventListener('click', clicked);
    await user.click(screen.getByRole('button', { name: 'Attach images' }));
    expect(clicked).toHaveBeenCalledTimes(1);
    await user.upload(input, [png('a.png'), png('b.png')]);
    expect(screen.getAllByTestId('image-chip')).toHaveLength(2);
    // a file that is not an image is refused in plain words, as on a drop
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } });
    expect(screen.getByTestId('attach-error')).toHaveTextContent('notes.txt is not an image');
    expect(screen.getAllByTestId('image-chip')).toHaveLength(2);
  });

  it('is findable: the placeholder says images work, and the frame toggle is labelled Frame', async () => {
    const { user } = await start();
    expect(screen.getByLabelText('Message for the agent')).toHaveAttribute('placeholder', expect.stringContaining('drop or paste images'));
    const toggle = screen.getByRole('switch', { name: 'Send a picture of the current frame with the message' });
    expect(toggle).toBeChecked();
    expect(screen.getByText('Frame')).toBeInTheDocument();
    expect(screen.queryByText('Picture')).toBeNull();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
  });
});

describe('dropping and pasting images into the prompt box', () => {
  it('shows an overlay while files are dragged over, and a chip for each dropped image', async () => {
    const { panel } = await start();
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
    fireEvent.dragEnter(panel, dropOf([]));
    expect(screen.getByTestId('drop-overlay')).toHaveTextContent('Drop images to attach');
    // moving between children does not flicker it away
    fireEvent.dragEnter(panel, dropOf([]));
    fireEvent.dragLeave(panel, dropOf([]));
    expect(screen.getByTestId('drop-overlay')).toBeInTheDocument();
    fireEvent.drop(panel, dropOf([png('a.png'), png('b.png')]));
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
    const chips = screen.getAllByTestId('image-chip');
    expect(chips).toHaveLength(2);
    expect(within(chips[0]!).getByRole('img')).toHaveAttribute('alt', 'a.png');
  });

  it('ignores a drag that carries no files (text, a layer)', async () => {
    const { panel } = await start();
    fireEvent.dragEnter(panel, { dataTransfer: { types: ['text/plain'], files: [], items: [] } });
    expect(screen.queryByTestId('drop-overlay')).toBeNull();
  });

  it('takes an image pasted from the clipboard, and leaves a text paste alone', async () => {
    const { user } = await start();
    const box = screen.getByLabelText('Message for the agent');
    fireEvent.paste(box, pasteOf([png('image.png')]));
    expect(screen.getAllByTestId('image-chip')).toHaveLength(1);
    await user.click(box);
    await user.paste('just words');
    expect(box).toHaveValue('just words');
    expect(screen.getAllByTestId('image-chip')).toHaveLength(1);
  });

  it('removes a chip with its x', async () => {
    const { user, panel } = await start();
    fireEvent.drop(panel, dropOf([png('a.png'), png('b.png')]));
    await user.click(screen.getByRole('button', { name: 'Remove a.png' }));
    const chips = screen.getAllByTestId('image-chip');
    expect(chips).toHaveLength(1);
    expect(within(chips[0]!).getByRole('img')).toHaveAttribute('alt', 'b.png');
  });

  it('says in plain words when a file is too big, is not an image, or is one too many', async () => {
    const { panel } = await start();
    const big = png('huge.png');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    fireEvent.drop(panel, dropOf([big]));
    expect(screen.getByTestId('attach-error')).toHaveTextContent('huge.png is over 20 MB.');
    expect(screen.queryByTestId('image-chip')).toBeNull();

    fireEvent.drop(panel, dropOf([new File(['x'], 'notes.txt', { type: 'text/plain' })]));
    expect(screen.getByTestId('attach-error')).toHaveTextContent('notes.txt is not an image');

    fireEvent.drop(panel, dropOf(Array.from({ length: 8 }, (_, i) => png(`p${i}.png`))));
    expect(screen.getAllByTestId('image-chip')).toHaveLength(MAX_ATTACHMENTS);
    expect(screen.getByTestId('attach-error')).toHaveTextContent('At most 6 images go with one message.');
  });
});

describe('sending a message with images', () => {
  it('stores each original in the project, then sends the names and a copy for the agent', async () => {
    const { server, user, panel } = await start();
    fireEvent.drop(panel, dropOf([png('a.png', 'AAA'), new File(['jj'], 'My Photo.jpg', { type: 'image/jpeg' })]));
    await user.type(screen.getByLabelText('Message for the agent'), 'use these');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    expect(uploads.map((u) => [u.init.method, decodeURIComponent(u.url)])).toEqual([
      ['PUT', '/api/agent/image?name=a.png'],
      ['PUT', '/api/agent/image?name=My Photo.jpg'],
    ]);
    // the server answers with the name it kept (a clash gets -2); that is what the agent is told
    const sent = prompts(server)[0]!;
    expect(sent.text).toBe('use these');
    expect(sent.attachments).toEqual([
      { name: 'a.png', data: btoa('AAA'), mimeType: 'image/png' },
      { name: 'My Photo-2.jpg', data: btoa('jj'), mimeType: 'image/jpeg' },
    ]);
    // the box is empty again
    expect(screen.queryByTestId('image-chip')).toBeNull();
    expect(screen.getByLabelText('Message for the agent')).toHaveValue('');
  });

  it('sends the window token with the upload when the page has one', async () => {
    sessionStorage.setItem('studio-token', 'secret');
    try {
      const { server, user, panel } = await start();
      fireEvent.drop(panel, dropOf([png('a.png')]));
      await user.type(screen.getByLabelText('Message for the agent'), 'x');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(prompts(server)).toHaveLength(1));
      expect(uploads[0]!.url).toContain('token=secret');
      expect((uploads[0]!.init.headers as Record<string, string>)['X-Studio-Token']).toBe('secret');
    } finally {
      sessionStorage.removeItem('studio-token');
    }
  });

  it('lets a message of only images go', async () => {
    const { server, user, panel } = await start();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.drop(panel, dropOf([png('a.png')]));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    expect(prompts(server)[0]).toMatchObject({ text: '', attachments: [{ name: 'a.png' }] });
  });

  it('keeps the images and says why when the upload fails, and does not store the stored ones twice on retry', async () => {
    const { server, user, panel } = await start();
    fireEvent.drop(panel, dropOf([png('a.png'), png('b.png')]));
    await user.type(screen.getByLabelText('Message for the agent'), 'go');
    // the first goes in, the second is refused
    let calls = 0;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init: RequestInit) => {
      uploads.push({ url, init });
      if (calls++ === 0) return new Response(JSON.stringify({ file: 'a.png', src: 'public/refs/a.png' }), { status: 201 });
      return new Response(JSON.stringify({ error: { code: 'INVALID_ARG', message: 'the file is not a real picture (PNG, JPEG, GIF, WebP or AVIF)' } }), { status: 400 });
    });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByTestId('attach-error')).toHaveTextContent('Could not store b.png: the file is not a real picture'));
    expect(prompts(server)).toHaveLength(0);
    expect(screen.getAllByTestId('image-chip')).toHaveLength(2);
    expect(screen.getByLabelText('Message for the agent')).toHaveValue('go');

    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init: RequestInit) => {
      uploads.push({ url, init });
      return new Response(JSON.stringify({ file: 'b.png', src: 'public/refs/b.png' }), { status: 201 });
    });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    expect(uploads.map((u) => decodeURIComponent(u.url))).toEqual(['/api/agent/image?name=a.png', '/api/agent/image?name=b.png', '/api/agent/image?name=b.png']);
    expect(prompts(server)[0]!.attachments!.map((a) => a.name)).toEqual(['a.png', 'b.png']);
  });

  it('keeps its images when it is queued behind a working agent', async () => {
    const { server, user, panel } = await start();
    await say(server, { kind: 'status', status: 'busy', command: 'fake --acp', image: true });
    fireEvent.drop(panel, dropOf([png('a.png')]));
    await user.type(screen.getByLabelText('Message for the agent'), 'later please');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(prompts(server)).toHaveLength(1));
    // stored at queue time, and the message carries them
    expect(uploads).toHaveLength(1);
    expect(prompts(server)[0]!.attachments).toEqual([{ name: 'a.png', data: btoa('pixels'), mimeType: 'image/png' }]);
    await say(server, { kind: 'queue', items: [{ id: 'q1', text: 'later please', chips: [], images: ['a.png'] }] });
    const queued = screen.getByTestId('chat-queued');
    expect(within(queued).getByRole('img')).toHaveAttribute('src', '/api/agent/image?name=a.png');
    // the turn ends: the message is the person's, with its thumbnail
    await say(server, { kind: 'user', text: 'later please', chips: [], images: ['a.png'] });
    await say(server, { kind: 'queue', items: [] });
    const bubble = screen.getByTestId('chat-user');
    expect(bubble).toHaveTextContent('later please');
    expect(within(bubble).getByRole('img')).toHaveAttribute('src', '/api/agent/image?name=a.png');
  });
});

describe('the transcript', () => {
  it('shows thumbnails in the user bubble, also after a reload replays the history', async () => {
    const { server } = await start();
    await act(() => server.send({ type: 'agent.history', items: [{ kind: 'user', text: 'see this', chips: [], images: ['a.png', 'b.jpg'] }, { kind: 'user', text: 'no pictures', chips: [] }] }));
    const bubbles = screen.getAllByTestId('chat-user');
    expect(within(bubbles[0]!).getAllByRole('img').map((i) => i.getAttribute('src'))).toEqual(['/api/agent/image?name=a.png', '/api/agent/image?name=b.jpg']);
    expect(within(bubbles[1]!).queryByRole('img')).toBeNull();
  });
});

describe('the helpers', () => {
  it('accepts images by type or, with no type, by name, and limits size and count', () => {
    const files = [png('a.png'), new File(['x'], 'b.avif'), new File(['x'], 'c.txt', { type: 'text/plain' }), new File(['x'], 'd.heic', { type: 'image/heic' })];
    const result = acceptImages(files, 0);
    expect(result.files.map((f) => f.name)).toEqual(['a.png', 'b.avif']);
    expect(result.error).toMatch(/c\.txt is not an image/);
    expect(acceptImages([png('x.png'), png('y.png')], 5).files).toHaveLength(1);
    expect(acceptImages([png('x.png')], 6).error).toBe('At most 6 images go with one message.');
  });

  it('fits the long side to 1568 px and never scales up', () => {
    expect(fitSize(4000, 2000)).toEqual({ width: 1568, height: 784 });
    expect(fitSize(1000, 3136)).toEqual({ width: 500, height: 1568 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('redraws a large picture at most 1568 px for the agent, and sends a small one as it is', async () => {
    const original = globalThis.createImageBitmap;
    const sizes: [number, number][] = [];
    globalThis.createImageBitmap = (async () => ({ width: 4000, height: 3000, close() {} })) as unknown as typeof createImageBitmap;
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement) {
      sizes.push([this.width, this.height]);
      return 'data:image/jpeg;base64,QUJD';
    });
    try {
      const big = new File([new Uint8Array(10)], 'big.png', { type: 'image/png' });
      Object.defineProperty(big, 'size', { value: 8_000_000 });
      const copy = await copyForAgent(big);
      expect(sizes[0]).toEqual([1568, 1176]);
      // a PNG is tried first; it was small enough here
      expect(copy).toEqual({ data: 'QUJD', mimeType: 'image/png' });
      // AVIF is never sent as it is
      globalThis.createImageBitmap = (async () => ({ width: 10, height: 10, close() {} })) as unknown as typeof createImageBitmap;
      expect(await copyForAgent(new File(['x'], 'a.avif', { type: 'image/avif' }))).toMatchObject({ mimeType: 'image/png' });
      // small and sendable: the bytes as they are
      expect(await copyForAgent(png('s.png', 'ABC'))).toEqual({ data: btoa('ABC'), mimeType: 'image/png' });
    } finally {
      toDataURL.mockRestore();
      globalThis.createImageBitmap = original;
    }
  });
});
