import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closingMessage } from '../src/panels/summary.js';
import { stageStates } from '../src/panels/stages.js';
import type { OpenPanel } from '../src/panels/types.js';
import type { StudioServer } from '../src/index.js';
import { api, cleanup, Client, start, stopAll, tempDir, tokenOf, until, writeProject } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const command = `node ${JSON.stringify(FAKE)}`;

afterEach(async () => {
  await stopAll();
  cleanup();
});

const window = (s: StudioServer) => ({ 'x-studio-token': tokenOf(s)! });

/** The agent's token, as the studio gives it to the MCP server: asked of the fake agent's session/new. */
async function agentTokenOf(studio: StudioServer, client: Client): Promise<string> {
  client.send({ type: 'agent.prompt', text: 'mcp', context: '' });
  await client.waitForMessage('agent', (m) => m.event.kind === 'done', 20_000);
  const said = client
    .messages('agent')
    .flatMap((m) => (m.type === 'agent' && m.event.kind === 'message' ? [m.event.text] : []))
    .join('');
  void studio;
  return (JSON.parse(said) as { mcpServers: { env: { value: string }[] }[] }).mcpServers[0]!.env[0]!.value;
}

const draftBrief = { purpose: 'a launch ad' };
const brief = {
  purpose: 'launch ad',
  audience: 'developers',
  platform: 'reel-9x16',
  size: { width: 1080, height: 1920, fps: 30 },
  seconds: 20,
  takeaway: 'it renders without a browser',
  references: [{ kind: 'link', src: 'https://example.com/a', like: 'the cuts' }],
};
const shot = (id: string) => ({ id, frame: 0, what: 'box', moves: 'slides', seconds: 2, transition: 'cut' });
const board = { comp: 'Storyboard', shots: [shot('s1'), shot('s2'), shot('s3')] };

async function open(studio: StudioServer, token: string, panel: string, data: unknown, message?: string) {
  return api(studio, '/api/panels', { method: 'POST', headers: { 'x-studio-token': token }, json: { panel, data, message } });
}

describe('opening panels over HTTP', () => {
  it('takes the agent token and the window token, and nothing else', async () => {
    const { entry } = writeProject('Panels');
    const studio = await start(entry);
    expect((await api(studio, '/api/panels', { method: 'POST', json: { panel: 'brief', data: {} } })).status).toBe(403);
    expect((await open(studio, 'wrong', 'brief', {})).status).toBe(403);
    expect((await api(studio, '/api/panels')).status).toBe(403);
    const opened = await open(studio, tokenOf(studio)!, 'brief', draftBrief, 'Check this');
    expect(opened.status).toBe(201);
    expect(opened.json).toEqual({ id: 'p_1', status: 'open' });
    expect((await api(studio, '/api/panels/p_1')).status).toBe(403);
    const list = await api(studio, '/api/panels', { headers: window(studio) });
    expect(list.json.panels).toMatchObject([{ id: 'p_1', panel: 'brief', data: draftBrief, message: 'Check this', status: 'open', answer: null }]);
    expect((await api(studio, '/api/panels/p_9', { headers: window(studio) })).status).toBe(404);
  });

  it('lets the agent token open and read a panel but not list them or reach the agent routes', async () => {
    const { dir, entry } = writeProject('PanelsAgent');
    const studio = await start(entry, { agent: command, agentCwd: dir });
    const client = await Client.connect(studio);
    const agent = await agentTokenOf(studio, client);
    expect((await open(studio, agent, 'storyboard', board)).json).toEqual({ id: 'p_1', status: 'open' });
    expect((await api(studio, '/api/panels/p_1', { headers: { 'x-studio-token': agent } })).json).toEqual({ id: 'p_1', panel: 'storyboard', status: 'open', answer: null });
    expect((await api(studio, '/api/panels', { headers: { 'x-studio-token': agent } })).status).toBe(403);
    expect((await api(studio, '/api/plan/brief', { headers: { 'x-studio-token': agent } })).status).toBe(403);
    client.close();
  });

  it('refuses a panel kind it does not know and data that does not fit the kind', async () => {
    const { entry } = writeProject('PanelsBad');
    const studio = await start(entry);
    const token = tokenOf(studio)!;
    expect((await open(studio, token, 'poem', {})).status).toBe(400);
    expect((await open(studio, token, 'brief', 'text')).status).toBe(400);
    const bad = await open(studio, token, 'storyboard', { shots: [] });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('comp');
    expect((await api(studio, '/api/panels', { headers: window(studio) })).json.panels).toEqual([]);
  });
});

describe('the person answering', () => {
  it('shows an opened panel to the window, and a submitted answer is checked, written to plan/<kind>.json and kept', async () => {
    const { dir, entry } = writeProject('PanelsSubmit');
    const studio = await start(entry);
    const client = await Client.connect(studio);
    await open(studio, tokenOf(studio)!, 'brief', draftBrief, 'Is this right?');
    const shown: any = await client.waitForMessage('panel');
    expect(shown.message.panel).toMatchObject({ id: 'p_1', panel: 'brief', message: 'Is this right?', status: 'open' });

    // A wrong answer is refused on the socket; the panel stays open and nothing is written.
    client.send({ type: 'panel.submit', id: 'p_1', answer: { purpose: 'x' } });
    const refused: any = await client.waitForMessage('panel.error');
    expect(refused.message).toMatchObject({ id: 'p_1' });
    expect(refused.message.message).toContain('audience');
    expect(existsSync(join(dir, 'plan', 'brief.json'))).toBe(false);

    client.send({ type: 'panel.submit', id: 'p_1', answer: brief });
    const closed: any = await client.waitForMessage('panel.closed');
    expect(closed.message).toMatchObject({ id: 'p_1', status: 'submitted', panel: { answer: brief } });
    expect(JSON.parse(readFileSync(join(dir, 'plan', 'brief.json'), 'utf8'))).toEqual(brief);
    expect(readFileSync(join(dir, 'plan', 'brief.json'), 'utf8')).toBe(`${JSON.stringify(brief, null, 2)}\n`);
    const got = await api(studio, '/api/panels/p_1', { headers: window(studio) });
    expect(got.json).toMatchObject({ status: 'submitted', answer: brief });
    expect((await api(studio, '/api/plan/brief', { headers: window(studio) })).json).toEqual(brief);
    expect((await api(studio, '/api/plan/script', { headers: window(studio) })).status).toBe(404);
    // Answering twice, or an unknown panel, is an error and not a second write.
    client.send({ type: 'panel.submit', id: 'p_1', answer: brief });
    await until(() => client.messages('panel.error').length, (n) => n === 2);
    client.close();
  });

  it('dismisses a panel without a plan file', async () => {
    const { dir, entry } = writeProject('PanelsDismiss');
    const studio = await start(entry);
    const client = await Client.connect(studio);
    await open(studio, tokenOf(studio)!, 'review', { comp: 'Short' });
    await client.waitForMessage('panel');
    client.send({ type: 'panel.dismiss', id: 'p_1' });
    const closed: any = await client.waitForMessage('panel.closed');
    expect(closed.message).toMatchObject({ id: 'p_1', status: 'dismissed' });
    expect(existsSync(join(dir, 'plan'))).toBe(false);
    expect((await api(studio, '/api/panels/p_1', { headers: window(studio) })).json).toMatchObject({ status: 'dismissed', answer: null });
    client.close();
  });

  it('replaces the open panel of a kind with a new one, dismissing the old', async () => {
    const { entry } = writeProject('PanelsReplace');
    const studio = await start(entry);
    const client = await Client.connect(studio);
    await open(studio, tokenOf(studio)!, 'brief', draftBrief);
    await open(studio, tokenOf(studio)!, 'review', { comp: 'Short' });
    expect((await open(studio, tokenOf(studio)!, 'brief', { purpose: 'second' })).json.id).toBe('p_3');
    const closed: any = await client.waitForMessage('panel.closed');
    expect(closed.message).toMatchObject({ id: 'p_1', status: 'dismissed' });
    const list = (await api(studio, '/api/panels', { headers: window(studio) })).json.panels as OpenPanel[];
    expect(list.map((p) => `${p.id}:${p.status}`)).toEqual(['p_2:open', 'p_3:open']);
    expect((await api(studio, '/api/panels/p_1', { headers: window(studio) })).json.status).toBe('dismissed');
    // The replaced panel can no longer be answered.
    client.send({ type: 'panel.submit', id: 'p_1', answer: brief });
    await client.waitForMessage('panel.error');
    client.close();
  });

  it('gives the open panels, and the submitted ones, to a window that connects or reconnects', async () => {
    const { entry } = writeProject('PanelsReconnect');
    const studio = await start(entry);
    // Opened while no window is connected: it waits.
    await open(studio, tokenOf(studio)!, 'brief', draftBrief);
    await open(studio, tokenOf(studio)!, 'storyboard', board);
    const first = await Client.connect(studio);
    await until(() => first.messages('panel').length, (n) => n === 2);
    first.send({ type: 'panel.submit', id: 'p_1', answer: brief });
    await first.waitForMessage('panel.closed');
    first.close();

    const second = await Client.connect(studio);
    await until(() => second.messages('panel').length, (n) => n === 2);
    const got = second.messages('panel').map((m: any) => `${m.panel.id}:${m.panel.status}`);
    expect(got).toEqual(['p_1:submitted', 'p_2:open']);
    // Hello comes first, so a window can start from nothing.
    expect(second.messages()[0]).toMatchObject({ type: 'hello' });
    second.close();
  });

  it('fills the length of a script or a board from the saved brief', async () => {
    const { dir, entry } = writeProject('PanelsTarget');
    const studio = await start(entry);
    const token = tokenOf(studio)!;
    await open(studio, token, 'storyboard', board);
    expect((await api(studio, '/api/panels/p_1', { headers: window(studio) })).json).toMatchObject({ status: 'open' });
    let list = (await api(studio, '/api/panels', { headers: window(studio) })).json.panels as any[];
    expect(list[0].data.targetSeconds).toBeUndefined();
    mkdirSync(join(dir, 'plan'));
    writeFileSync(join(dir, 'plan', 'brief.json'), JSON.stringify(brief));
    await open(studio, token, 'storyboard', board);
    await open(studio, token, 'script', { lines: [{ id: 'l1', text: 'hi' }] });
    await open(studio, token, 'script', { lines: [], targetSeconds: 5 });
    list = (await api(studio, '/api/panels', { headers: window(studio) })).json.panels;
    expect(list.filter((p) => p.status === 'open').map((p) => [p.panel, p.data.targetSeconds])).toEqual([['storyboard', 20], ['script', 5]]);
  });
});

describe('the plan files', () => {
  async function submitBrief(studio: StudioServer): Promise<any> {
    const client = await Client.connect(studio);
    await open(studio, tokenOf(studio)!, 'brief', draftBrief);
    await client.waitForMessage('panel');
    client.send({ type: 'panel.submit', id: 'p_1', answer: brief });
    const refused = await Promise.race([client.waitForMessage('panel.error'), client.waitForMessage('panel.closed')]);
    client.close();
    return refused;
  }

  it('refuses a plan directory that is a link out of the project, and writes nothing there', async () => {
    const { dir, entry } = writeProject('PlanOut');
    const elsewhere = tempDir();
    symlinkSync(elsewhere, join(dir, 'plan'));
    const studio = await start(entry);
    const got = await submitBrief(studio);
    expect(got.message.type).toBe('panel.error');
    expect(got.message.message).toContain('outside the project');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect((await api(studio, '/api/panels/p_1', { headers: window(studio) })).json.status).toBe('open');
    expect((await api(studio, '/api/plan/brief', { headers: window(studio) })).status).toBe(403);
  });

  it('refuses to write or read through a link in place of plan/<kind>.json', async () => {
    const { dir, entry } = writeProject('PlanLink');
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, 'secret.json'), '{"seconds":1}');
    mkdirSync(join(dir, 'plan'));
    symlinkSync(join(elsewhere, 'secret.json'), join(dir, 'plan', 'brief.json'));
    const studio = await start(entry);
    expect((await api(studio, '/api/plan/brief', { headers: window(studio) })).status).toBe(403);
    const got = await submitBrief(studio);
    expect(got.message.type).toBe('panel.error');
    expect(readFileSync(join(elsewhere, 'secret.json'), 'utf8')).toBe('{"seconds":1}');
    expect(readdirSync(join(dir, 'plan'))).toEqual(['brief.json']);
  });

  it('replaces a plain file, leaves no temporary file, and takes only panel kinds as names', async () => {
    const { dir, entry } = writeProject('PlanPlain');
    mkdirSync(join(dir, 'plan'));
    writeFileSync(join(dir, 'plan', 'brief.json'), '{"old":true}');
    const studio = await start(entry);
    expect((await submitBrief(studio)).message.type).toBe('panel.closed');
    expect(JSON.parse(readFileSync(join(dir, 'plan', 'brief.json'), 'utf8'))).toEqual(brief);
    expect(readdirSync(join(dir, 'plan'))).toEqual(['brief.json']);
    writeFileSync(join(dir, 'plan', 'notes.json'), '{}');
    expect((await api(studio, '/api/plan/notes', { headers: window(studio) })).status).toBe(404);
    expect((await api(studio, '/api/plan/..%2Fpackage', { headers: window(studio) })).status).toBe(404);
  });
});

describe('telling the agent', () => {
  const said = (c: Client) =>
    c
      .messages('agent')
      .flatMap((m) => (m.type === 'agent' && m.event.kind === 'message' ? [m.event.text] : []))
      .join('');

  it('sends the answer as the next user message, with the plan file named', async () => {
    const { dir, entry } = writeProject('PanelsTell');
    const studio = await start(entry, { agent: command, agentCwd: dir });
    const client = await Client.connect(studio);
    client.send({ type: 'agent.prompt', text: 'hello', context: '' });
    await client.waitForMessage('agent', (m) => m.event.kind === 'done');
    await open(studio, tokenOf(studio)!, 'storyboard', board);
    await client.waitForMessage('panel');
    client.send({
      type: 'panel.submit',
      id: 'p_1',
      answer: { shots: [shot('s3'), shot('s1')], removed: ['s2'], notes: [{ shot: 's1', text: 'longer' }], approved: true },
    });
    const text = '[panel storyboard p_1 submitted] approved 2 of 3 shots; see plan/storyboard.json\nremoved: s2\norder: s3, s1\ns1: longer';
    // The chat shows it as the person's message, and the agent got it.
    await client.waitForMessage('agent', (m) => m.event.kind === 'user' && m.event.text === text);
    await client.waitForMessage('agent', (m) => m.event.kind === 'message' && m.event.text.includes('[panel storyboard p_1 submitted]'));
    expect(said(client)).toContain(text);
    // A window that reloads sees it in the replay.
    client.close();
    const again = await Client.connect(studio);
    const replay: any = await again.waitForMessage('agent.history');
    expect(replay.message.items.some((i: any) => i.kind === 'user' && i.text === text)).toBe(true);
    again.close();
  });

  it('queues the message while the agent is mid-turn, and sends it when the turn ends', async () => {
    const { dir, entry } = writeProject('PanelsQueue');
    const studio = await start(entry, { agent: command, agentCwd: dir });
    const client = await Client.connect(studio);
    client.send({ type: 'agent.prompt', text: 'slow one', context: '' });
    await client.waitForMessage('agent', (m) => m.event.kind === 'status' && m.event.status === 'busy');
    await open(studio, tokenOf(studio)!, 'brief', draftBrief);
    await open(studio, tokenOf(studio)!, 'review', { comp: 'Short' });
    client.send({ type: 'panel.submit', id: 'p_1', answer: brief });
    client.send({ type: 'panel.dismiss', id: 'p_2' });
    await client.waitForMessage('panel.closed', (m) => m.id === 'p_2');
    // Still the first turn: nothing was sent yet, and no refusal came.
    expect(said(client)).not.toContain('[panel');
    expect(client.messages('agent').some((m: any) => m.event.kind === 'error')).toBe(false);
    await until(() => said(client), (t) => t.includes('[panel brief p_1 submitted]'));
    // One message holds both.
    expect(said(client)).toContain('[panel brief p_1 submitted] brief approved: reel-9x16 1080x1920 at 30 fps, 20 s, 1 reference; see plan/brief.json');
    expect(said(client)).toContain('[panel review p_2 dismissed]');
    expect(said(client).match(/got: /g)).toHaveLength(2);
    client.close();
  });

  it('keeps the message when no agent is running, and the answer stays readable', async () => {
    const { dir, entry } = writeProject('PanelsNoAgent');
    const studio = await start(entry, { agent: command, agentCwd: dir });
    const client = await Client.connect(studio);
    await open(studio, tokenOf(studio)!, 'brief', draftBrief);
    await client.waitForMessage('panel');
    client.send({ type: 'panel.submit', id: 'p_1', answer: brief });
    await client.waitForMessage('panel.closed');
    await new Promise((r) => setTimeout(r, 300));
    // No agent was started to be told.
    expect(client.messages('agent').filter((m: any) => m.event.kind !== 'status')).toEqual([]);
    expect(existsSync(join(dir, 'plan', 'brief.json'))).toBe(true);
    // The next turn that ends carries it.
    client.send({ type: 'agent.prompt', text: 'hello', context: '' });
    await until(() => said(client), (t) => t.includes('[panel brief p_1 submitted]'));
    client.close();
  });
});

describe('the messages and the stepper', () => {
  const panel = (over: Partial<OpenPanel>): OpenPanel => ({ id: 'p_1', panel: 'brief', data: {}, message: null, status: 'open', answer: null, openedAt: 1, ...over });

  it('writes a dismissal as one line and a review in time order', () => {
    expect(closingMessage(panel({ status: 'dismissed' }))).toBe('[panel brief p_1 dismissed]');
    const review = panel({
      id: 'p_4',
      panel: 'review',
      status: 'submitted',
      answer: { verdict: 'changes', notes: [{ frame: 90, text: 'late' }, { frame: 12, text: 'too long', layer: 'Title' }] },
    });
    expect(closingMessage(review)).toBe('[panel review p_4 submitted] changes wanted, 2 notes; see plan/review.json\nframe 12 (Title): too long\nframe 90: late');
  });

  it('marks a stage open or approved from the panels, and splits the reviews between Animatic and Build', () => {
    const none = stageStates([]);
    expect(Object.values(none).map((s) => s.state)).toEqual(Array(7).fill('empty'));
    const states = stageStates([
      panel({ id: 'p_1', status: 'submitted', answer: {} as never, openedAt: 1 }),
      panel({ id: 'p_2', panel: 'storyboard', openedAt: 2 }),
      panel({ id: 'p_3', panel: 'review', status: 'submitted', answer: { verdict: 'changes', notes: [] }, openedAt: 3 }),
      panel({ id: 'p_4', panel: 'review', status: 'submitted', answer: { verdict: 'approved', notes: [] }, openedAt: 4 }),
      panel({ id: 'p_5', panel: 'review', openedAt: 5 }),
    ]);
    expect(states.brief).toEqual({ state: 'approved', panelId: null });
    expect(states.board).toEqual({ state: 'open', panelId: 'p_2' });
    expect(states.script.state).toBe('empty');
    expect(states.animatic.state).toBe('approved');
    expect(states.build).toEqual({ state: 'open', panelId: 'p_5' });
    expect(stageStates([panel({ panel: 'review', openedAt: 1 })]).animatic).toEqual({ state: 'open', panelId: 'p_1' });
  });
});
