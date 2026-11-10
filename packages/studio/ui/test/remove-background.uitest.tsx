import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '../src/app';
import type { InspectResult, MattingJob } from '../src/api';
import { inspectFor, layer } from './fixtures';
import { MockServer } from './mock-server';

/** A project whose scene has a video layer, as the engine reports one (`src` is the absolute file). */
class VideoServer extends MockServer {
  override inspectFor(...args: Parameters<MockServer['inspectFor']>): InspectResult {
    const base = inspectFor(...args);
    return {
      ...base,
      layers: [
        ...base.layers,
        layer('clip', 'video', { src: '/work/public/person.mp4', media: { time: 0 }, source: { file: 'src/Scene.tsx', line: 42, column: 5 } }),
      ],
    };
  }
}

async function start(server = new VideoServer()) {
  const user = userEvent.setup();
  render(<App api={server} />);
  await waitFor(() => expect(server.frameRequests.length).toBeGreaterThan(0));
  return { server, user };
}

async function pick(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(screen.getByRole('tab', { name: 'Scene' }));
  const tree = await screen.findByTestId('scene-tree');
  await user.click(within(tree).getByTitle(new RegExp(`^${id} \\(`)));
}

async function runCommand(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.keyboard('{Meta>}k{/Meta}');
  const input = await screen.findByRole('combobox', { name: 'Command' });
  await user.type(input, label);
  await user.keyboard('{Enter}');
}

const matte = (extra: Partial<MattingJob> = {}): MattingJob => ({
  id: '1',
  kind: 'matte',
  model: 'modnet',
  status: 'running',
  stage: 'processing',
  progress: 0,
  output: 'public/person-no-background.webm',
  staticName: 'person-no-background.webm',
  error: null,
  ...extra,
});

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await pick(user, 'clip');
  await user.click(await screen.findByRole('button', { name: 'Remove background' }));
  return screen.findByRole('dialog', { name: 'Remove background from person.mp4' });
}

describe('Remove background: where it is offered', () => {
  it('shows a button on a selected video layer, and not on others', async () => {
    const { user } = await start();
    await pick(user, 'bg');
    expect(screen.queryByRole('button', { name: 'Remove background' })).not.toBeInTheDocument();
    await pick(user, 'clip');
    expect(await screen.findByRole('button', { name: 'Remove background' })).toBeInTheDocument();
  });

  it('is in the command menu only while a video layer is selected', async () => {
    const { user } = await start();
    await user.keyboard('{Meta>}k{/Meta}');
    await user.type(await screen.findByRole('combobox', { name: 'Command' }), 'background');
    expect(screen.queryByText('Remove background from the selected video')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await pick(user, 'clip');
    await runCommand(user, 'Remove background');
    expect(await screen.findByRole('dialog', { name: 'Remove background from person.mp4' })).toBeInTheDocument();
  });

  it('is not offered for a plain shape in the command menu', async () => {
    const { user } = await start();
    await pick(user, 'bg');
    await user.keyboard('{Meta>}k{/Meta}');
    await user.type(await screen.findByRole('combobox', { name: 'Command' }), 'Remove back');
    expect(screen.queryByText('Remove background from the selected video')).not.toBeInTheDocument();
  });
});

describe('Remove background: the dialog', () => {
  it("has Remotion's defaults: the name in public/, modnet with its size, original audio, Very High", async () => {
    const { user } = await start();
    const dialog = await openDialog(user);
    expect(within(dialog).getByLabelText('Output in public/')).toHaveValue('person-no-background.webm');
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Model' })).toHaveTextContent('modnet · 25.9 MB'));
    expect(within(dialog).getByRole('switch')).toBeChecked();
    expect(within(dialog).getByRole('combobox', { name: 'Video quality' })).toHaveTextContent('Very High');
    expect(within(dialog).getByRole('button', { name: 'Remove background' })).toBeEnabled();
  });

  it('starts with the options as set, and shows progress from the server', async () => {
    const { server, user } = await start();
    const dialog = await openDialog(user);
    const output = within(dialog).getByLabelText('Output in public/');
    await user.clear(output);
    await user.type(output, 'cut.webm');
    await user.click(within(dialog).getByRole('switch'));
    await user.click(within(dialog).getByRole('button', { name: 'Remove background' }));
    await waitFor(() => expect(server.startMattingCalls).toEqual([{ input: '/work/public/person.mp4', output: 'cut.webm', model: 'modnet', audio: 'drop', quality: 'very-high' }]));
    act(() => server.send({ type: 'matting', job: matte({ staticName: 'cut.webm', progress: 0.42 }) }));
    expect(await within(dialog).findByText('Removing the background 42%')).toBeInTheDocument();
    expect(within(dialog).getByRole('progressbar', { name: 'Removing the background' })).toHaveAttribute('aria-valuenow', '42');
    expect(within(dialog).getByRole('button', { name: 'Cancel removal' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Remove background' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove background' })).toBeDisabled();
  });

  it('cancels a removal that is running', async () => {
    const { server, user } = await start();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Remove background' }));
    await waitFor(() => expect(server.startMattingCalls).toHaveLength(1));
    act(() => server.send({ type: 'matting', job: matte({ progress: 0.1 }) }));
    await user.click(await within(dialog).findByRole('button', { name: 'Cancel removal' }));
    expect(server.mattingCalls).toContain('cancel 1');
    act(() => server.send({ type: 'matting', job: matte({ status: 'cancelled' }) }));
    expect(await within(dialog).findByText('Cancelled')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove background' })).toBeEnabled();
  });

  it("swaps the video's source when the file is written: the agent is asked for that one line", async () => {
    const { server, user } = await start();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Remove background' }));
    await waitFor(() => expect(server.startMattingCalls).toHaveLength(1));
    act(() => server.send({ type: 'matting', job: matte({ progress: 0.9 }) }));
    act(() => server.send({ type: 'matting', job: matte({ status: 'done', progress: 1 }) }));
    const done = await within(dialog).findByTestId('matting-done');
    expect(done).toHaveTextContent('public/person-no-background.webm is ready');
    expect(done).toHaveTextContent("src={staticFile('person-no-background.webm')}");
    expect(done).toHaveTextContent('Asked the agent');
    const prompts = server.agentMessages.filter((m) => m.type === 'agent.prompt');
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]! as Extract<(typeof prompts)[number], { type: 'agent.prompt' }>;
    expect(prompt.text).toContain('src/Scene.tsx:42');
    expect(prompt.text).toContain("staticFile('person-no-background.webm')");
    expect(prompt.chips).toEqual(['Remove background']);
    expect(prompt.context).toContain('video layer');
    // Told once, however often the job is reported.
    act(() => server.send({ type: 'matting', job: matte({ status: 'done', progress: 1 }) }));
    expect(server.agentMessages.filter((m) => m.type === 'agent.prompt')).toHaveLength(1);
    // The footer's Close, and the corner cross every dialog has.
    expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(2);
    expect(within(dialog).queryByRole('button', { name: 'Remove background' })).not.toBeInTheDocument();
  });

  it('shows the error of a failed removal and lets the user try again', async () => {
    const { server, user } = await start();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Remove background' }));
    await waitFor(() => expect(server.startMattingCalls).toHaveLength(1));
    act(() => server.send({ type: 'matting', job: matte({ status: 'failed', error: { code: 'MATTING', message: 'the decoder gave up' } }) }));
    expect(await within(dialog).findAllByText('the decoder gave up')).not.toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Remove background' })).toBeEnabled();
    expect(server.agentMessages.filter((m) => m.type === 'agent.prompt')).toHaveLength(0);
  });

  it("shows the server's refusal at once", async () => {
    const server = new VideoServer();
    const { ApiError } = await import('../src/api');
    server.mattingError = new ApiError('INVALID_ARG', 'public/person-no-background.webm already exists: pick another name', 400);
    const { user } = await start(server);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Remove background' }));
    expect(await within(dialog).findByText(/already exists: pick another name/)).toBeInTheDocument();
  });

  it('refuses a name that is not a .webm inside public/', async () => {
    const { server, user } = await start();
    const dialog = await openDialog(user);
    const output = within(dialog).getByLabelText('Output in public/');
    await user.clear(output);
    await user.type(output, '../x.mp4');
    expect(within(dialog).getByText('The file must end in .webm.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove background' })).toBeDisabled();
    expect(server.startMattingCalls).toHaveLength(0);
  });

  it('says clearly that this build has no background removal, and cannot start', async () => {
    const server = new VideoServer();
    server.mattingStatus = { available: false, message: 'Background removal is not in this build of Kinetograph. Update `kinetograph`.', models: [], jobs: [] };
    const { user } = await start(server);
    const dialog = await openDialog(user);
    const warning = await within(dialog).findByTestId('matting-unavailable');
    expect(warning).toHaveTextContent('Background removal is not available');
    expect(warning).toHaveTextContent('not in this build of Kinetograph');
    expect(within(dialog).getByRole('button', { name: 'Remove background' })).toBeDisabled();
  });

  it('cannot start for a video that is a URL', async () => {
    class UrlServer extends MockServer {
      override inspectFor(...args: Parameters<MockServer['inspectFor']>): InspectResult {
        const base = inspectFor(...args);
        return { ...base, layers: [...base.layers, layer('clip', 'video', { src: 'https://example.com/person.mp4' })] };
      }
    }
    const { user } = await start(new UrlServer() as VideoServer);
    const dialog = await openDialog(user);
    expect(dialog).toHaveTextContent('not a file on this computer');
    expect(within(dialog).getByRole('button', { name: 'Remove background' })).toBeDisabled();
  });

  it('offers a copy of the request when no agent is connected', async () => {
    const server = new VideoServer();
    server.agent = { presets: [], command: null, cwd: '/work' };
    const { user } = await start(server);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Remove background' }));
    await waitFor(() => expect(server.startMattingCalls).toHaveLength(1));
    act(() => server.send({ type: 'matting', job: matte({ status: 'done', progress: 1 }) }));
    const done = await within(dialog).findByTestId('matting-done');
    expect(done).toHaveTextContent('The agent is not connected');
    expect(within(done).getByRole('button', { name: 'Copy the request' })).toBeInTheDocument();
    expect(server.agentMessages.filter((m) => m.type === 'agent.prompt')).toHaveLength(0);
  });
});

describe('Remove background: the Models tab', () => {
  async function modelsTab(server = new VideoServer()) {
    const { user } = await start(server);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('tab', { name: 'Models' }));
    return { server, user, dialog };
  }

  it('lists both models with their size, and whether each is downloaded', async () => {
    const { dialog } = await modelsTab();
    const modnet = await within(dialog).findByTestId('model-modnet');
    expect(modnet).toHaveTextContent('modnet');
    expect(modnet).toHaveTextContent('25.9 MB');
    expect(modnet).toHaveTextContent('Downloaded');
    const ben2 = within(dialog).getByTestId('model-ben2-base');
    expect(ben2).toHaveTextContent('223.0 MB');
    expect(ben2).toHaveTextContent('Not downloaded');
    expect(within(modnet).getByRole('button', { name: 'Remove modnet' })).toBeInTheDocument();
    expect(within(ben2).getByRole('button', { name: 'Download ben2-base' })).toBeInTheDocument();
  });

  it('downloads a model with progress, which can be cancelled', async () => {
    const { server, user, dialog } = await modelsTab();
    await user.click(await within(dialog).findByRole('button', { name: 'Download ben2-base' }));
    expect(server.mattingCalls).toContain('download ben2-base');
    const download: MattingJob = { id: 'd-ben2-base', kind: 'download', model: 'ben2-base', status: 'running', stage: 'downloading', progress: 0.3, error: null };
    act(() => server.send({ type: 'matting', job: download }));
    const row = await within(dialog).findByTestId('model-ben2-base');
    expect(await within(row).findByText('Downloading ben2-base 30%')).toBeInTheDocument();
    expect(within(row).getByRole('progressbar', { name: 'Downloading ben2-base' })).toHaveAttribute('aria-valuenow', '30');
    await user.click(within(row).getByRole('button', { name: 'Cancel' }));
    expect(server.mattingCalls).toContain('cancel d-ben2-base');
  });

  it('shows a model as downloaded once its download is done', async () => {
    const { server, dialog } = await modelsTab();
    server.mattingStatus = { ...server.mattingStatus, models: server.mattingStatus.models.map((m) => ({ ...m, cached: true })) };
    act(() => server.send({ type: 'matting', job: { id: 'd-ben2-base', kind: 'download', model: 'ben2-base', status: 'done', stage: 'downloading', progress: 1, error: null } }));
    await waitFor(() => expect(within(within(dialog).getByTestId('model-ben2-base')).getByText('Downloaded')).toBeInTheDocument());
  });

  it('removes a downloaded model', async () => {
    const { server, user, dialog } = await modelsTab();
    await user.click(await within(dialog).findByRole('button', { name: 'Remove modnet' }));
    expect(server.mattingCalls).toContain('remove modnet');
    await waitFor(() => expect(within(within(dialog).getByTestId('model-modnet')).getByText('Not downloaded')).toBeInTheDocument());
  });
});
