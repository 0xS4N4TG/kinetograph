import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BriefPanel } from '../src/components/panels/brief-panel';
import type { Brief, OpenPanel } from '../src/components/panels/types';

const draft: Partial<Brief> = {
  purpose: 'Launch ad for the plugin store',
  audience: 'Motion designers',
  platform: 'reel-9x16',
  size: { width: 1080, height: 1920, fps: 30 },
  seconds: 30,
  takeaway: 'Plugins are one line of code.',
  references: [
    { kind: 'link', src: 'https://example.com/a', like: 'the cut rhythm' },
    { kind: 'link', src: 'https://example.com/b', like: 'the type' },
    { kind: 'file', src: 'plan/refs/c.mp4', like: 'the grade', sheet: 'plan/refs/c.mp4.sheet.png' },
  ],
};

const panel = (data: Partial<Brief> = draft, message: string | null = null): OpenPanel<'brief'> => ({
  id: 'p1',
  panel: 'brief',
  data,
  message,
  status: 'open',
  answer: null,
  openedAt: 0,
});

function setup(data: Partial<Brief> = draft, message: string | null = null) {
  const onSubmit = vi.fn();
  const onDismiss = vi.fn();
  render(<BriefPanel panel={panel(data, message)} onSubmit={onSubmit} onDismiss={onDismiss} />);
  return { onSubmit, onDismiss };
}

afterEach(() => vi.unstubAllGlobals());

describe('BriefPanel', () => {
  it('renders the agent draft and its references, leaving the title and message to the host', () => {
    setup(draft, 'Check the length.');
    expect(screen.queryByText('Check the length.')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Brief' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Purpose')).toHaveValue('Launch ad for the plugin store');
    expect(screen.getByLabelText('Audience')).toHaveValue('Motion designers');
    expect(screen.getByLabelText('Width')).toHaveValue(1080);
    expect(screen.getByLabelText('Height')).toHaveValue(1920);
    expect(screen.getByLabelText('Length')).toHaveValue(30);
    expect(screen.getByLabelText('Takeaway')).toHaveValue('Plugins are one line of code.');
    const refs = screen.getAllByTestId('reference');
    expect(refs).toHaveLength(3);
    expect(within(refs[2]!).getByAltText('Contact sheet of plan/refs/c.mp4')).toBeInTheDocument();
    expect(within(refs[0]!).getByLabelText('What you like about it')).toHaveValue('the cut rhythm');
    expect(screen.queryAllByTestId('warning')).toHaveLength(0);
  });

  it('fills the size from a platform, and keeps it editable', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /YouTube/ }));
    expect(screen.getByLabelText('Width')).toHaveValue(1920);
    expect(screen.getByLabelText('Height')).toHaveValue(1080);
    expect(screen.getByLabelText('Frame rate')).toHaveValue(30);
    await user.click(screen.getByRole('button', { name: /Square/ }));
    expect(screen.getByLabelText('Width')).toHaveValue(1080);
    expect(screen.getByLabelText('Height')).toHaveValue(1080);
    await user.clear(screen.getByLabelText('Width'));
    await user.type(screen.getByLabelText('Width'), '1200');
    expect(screen.getByRole('button', { name: /Custom/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Height')).toHaveValue(1080);
  });

  it('warns, without blocking, about an empty takeaway, an odd length and the number of references', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ ...draft, takeaway: '', seconds: 120, references: draft.references!.slice(0, 2) });
    const texts = screen.getAllByTestId('warning').map((w) => w.textContent);
    expect(texts.some((t) => t?.includes('No takeaway'))).toBe(true);
    expect(texts.some((t) => t?.includes('120 s is long for a reel'))).toBe(true);
    expect(texts.some((t) => t?.includes('2 of 3 to 5 references'))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Approve brief' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('warns about more than five references', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ kind: 'link' as const, src: `https://e.com/${i}`, like: 'x' }));
    setup({ ...draft, references: six });
    expect(screen.getAllByTestId('warning').some((w) => w.textContent?.includes('6 references'))).toBe(true);
  });

  it('sends the whole brief on approval, with the edits', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText('Notes'), '  Warm colours.  ');
    await user.click(screen.getByRole('button', { name: /YouTube/ }));
    await user.click(screen.getByRole('button', { name: 'Approve brief' }));
    expect(onSubmit).toHaveBeenCalledWith({
      purpose: 'Launch ad for the plugin store',
      audience: 'Motion designers',
      platform: 'youtube-16x9',
      size: { width: 1920, height: 1080, fps: 30 },
      seconds: 30,
      takeaway: 'Plugins are one line of code.',
      references: [
        { kind: 'link', src: 'https://example.com/a', like: 'the cut rhythm' },
        { kind: 'link', src: 'https://example.com/b', like: 'the type' },
        { kind: 'file', src: 'plan/refs/c.mp4', like: 'the grade', sheet: 'plan/refs/c.mp4.sheet.png' },
      ],
      notes: 'Warm colours.',
    });
  });

  it('does not send while the purpose is empty or a reference has no line on what is liked', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ ...draft, purpose: '' });
    const approve = screen.getByRole('button', { name: 'Approve brief' });
    expect(approve).toBeDisabled();
    await user.type(screen.getByLabelText('Purpose'), 'A teaser');
    expect(approve).toBeEnabled();
    await user.clear(within(screen.getAllByTestId('reference')[1]!).getByLabelText('What you like about it'));
    expect(approve).toBeDisabled();
    expect(screen.getByTestId('blocking')).toHaveTextContent('line on what you like');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('dismisses', async () => {
    const user = userEvent.setup();
    const { onDismiss } = setup();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('uploads a dropped file and adds it to the shelf with its sheet', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ src: 'plan/refs/clip.mp4', sheet: 'plan/refs/clip.mp4.sheet.png' }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const { onSubmit } = setup({ ...draft, references: [] });
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.drop(screen.getByTestId('drop-zone'), { dataTransfer: { files: [file], getData: () => '' } });
    await waitFor(() => expect(screen.getByAltText('Contact sheet of clip.mp4')).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/panels/brief/ref?name=clip.mp4');
    expect(init.method).toBe('PUT');
    await user.type(screen.getByLabelText('What you like about it'), 'the pacing');
    await user.click(screen.getByRole('button', { name: 'Approve brief' }));
    expect(onSubmit.mock.calls[0]![0].references).toEqual([{ kind: 'file', src: 'plan/refs/clip.mp4', like: 'the pacing', sheet: 'plan/refs/clip.mp4.sheet.png' }]);
  });

  it('shows an upload error and does not send it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'INVALID_ARG', message: 'the file is not a real video' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })));
    setup({ ...draft, references: [] });
    fireEvent.drop(screen.getByTestId('drop-zone'), { dataTransfer: { files: [new File(['x'], 'bad.mp4')], getData: () => '' } });
    await waitFor(() => expect(screen.getByText(/the file is not a real video/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Approve brief' })).toBeDisabled();
  });
});
