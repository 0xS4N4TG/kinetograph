import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCustomAnswer, checkCustomDraft, isFilled } from '../src/panels/custom.js';
import { defaultPlacement, planFileOf } from '../src/panels/placement.js';
import { closingMessage } from '../src/panels/summary.js';
import type { CustomDraft, OpenPanel } from '../src/panels/types.js';
import { checkAnswer, checkDraft } from '../src/panels/validate.js';
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

const draft = (over: Partial<CustomDraft> = {}): CustomDraft => ({
  name: 'end-card',
  title: 'Pick the end card',
  blocks: [
    { id: 'intro', type: 'heading', text: 'Two options' },
    { id: 'pick', type: 'choice', required: true, options: [{ id: 'a', label: 'A', still: { comp: 'End', frame: 40 } }, { id: 'b', label: 'B' }] },
    { id: 'tags', type: 'choice', multiple: true, options: [{ id: 'x', label: 'X' }, { id: 'y', text: 'Y' }] },
    { id: 'speed', type: 'slider', min: 0.5, max: 2, step: 0.1, value: 1, unit: 'x' },
    { id: 'why', type: 'input', multiline: true },
    { id: 'todo', type: 'list', items: ['one'], editable: true },
    { id: 'grid', type: 'table', columns: ['Shot', 'Rating'], rows: [['1', '']], editable: true },
    { id: 'marks', type: 'notes', still: { comp: 'End', frame: 40 } },
    { id: 'ab', type: 'compare', a: { comp: 'End', frame: 1, label: 'Old' }, b: { comp: 'End', frame: 2 } },
    { id: 'body', type: 'text', text: 'Some **bold** words.' },
    { id: 'frame', type: 'still', comp: 'End', frame: 3, caption: 'here' },
    { id: 'clip', type: 'clip', comp: 'End', from: 0, to: 30 },
  ],
  ...over,
});
const answer = {
  values: {
    pick: 'b',
    tags: ['x'],
    speed: 1.2,
    why: 'make it faster',
    todo: ['one', 'two'],
    grid: [['1', '4']],
    marks: [{ text: 'logo', box: { x: 1, y: 2, w: 3, h: 4 } }],
    ab: 'a',
  },
};

const open = (studio: StudioServer, data: unknown, extra: Record<string, unknown> = {}) =>
  api(studio, '/api/panels', { method: 'POST', headers: window(studio), json: { panel: 'custom', data, ...extra } });

describe('custom drafts', () => {
  it('accepts every block type', () => {
    expect(checkCustomDraft(draft() as never)).toBeNull();
    expect(checkDraft('custom', draft())).toBeNull();
  });

  const reject = (change: (d: any) => void, expected: string) => {
    const d: any = structuredClone(draft());
    change(d);
    expect(checkCustomDraft(d)).toContain(expected);
  };

  it('refuses a bad name, a bad title and a bad block list', () => {
    reject((d) => (d.name = 'End Card'), 'slug');
    reject((d) => (d.name = '../x'), 'slug');
    reject((d) => (d.name = 'a'.repeat(41)), 'slug');
    reject((d) => (d.title = ''), 'title');
    reject((d) => (d.blocks = []), 'blocks');
    reject((d) => (d.blocks = Array.from({ length: 41 }, (_, i) => ({ id: `h${i}`, type: 'heading', text: 'x' }))), 'blocks');
    reject((d) => (d.submitLabel = ''), 'submitLabel');
  });

  it('refuses a duplicate id, an unknown type and an id that is not a safe key', () => {
    reject((d) => (d.blocks[1].id = 'intro'), 'used twice');
    reject((d) => (d.blocks[0].type = 'video'), 'type must be one of');
    reject((d) => (d.blocks[0].id = '__proto__'), 'id');
    reject((d) => (d.blocks[0].id = ''), 'id');
    reject((d) => (d.blocks[0] = 'text'), 'object');
  });

  it('refuses options and strings over the limits and malformed blocks', () => {
    reject((d) => (d.blocks[1].options = Array.from({ length: 25 }, (_, i) => ({ id: `o${i}`, label: 'x' }))), 'options');
    reject((d) => (d.blocks[1].options[1].id = 'a'), 'used twice');
    reject((d) => (d.blocks[1].options[1] = { id: 'b' }), 'needs a label');
    reject((d) => (d.blocks[1].value = 'zzz'), 'option id');
    reject((d) => (d.blocks[2].value = 'x'), 'list of option ids');
    reject((d) => (d.blocks[0].text = 'x'.repeat(201)), 'text');
    reject((d) => (d.blocks[9].text = 'x'.repeat(4001)), 'text');
    reject((d) => (d.blocks[0].label = 'x'.repeat(201)), 'label');
    reject((d) => (d.blocks[3].min = 3), 'min below max');
    reject((d) => (d.blocks[3].value = 5), 'between');
    reject((d) => (d.blocks[3].step = 0), 'step');
    reject((d) => (d.blocks[6].rows = [['only one']]), 'cells');
    reject((d) => (d.blocks[5].items = Array.from({ length: 201 }, () => 'x')), 'items');
    reject((d) => (d.blocks[7].still = { comp: 'End', frame: -1 }), 'frame');
    reject((d) => (d.blocks[8].b = undefined), 'b');
    reject((d) => (d.blocks[11].from = 40), 'from first');
    reject((d) => (d.blocks[10].frame = 1.5), 'frame');
    reject((d) => (d.blocks[0].required = 'yes'), 'required');
  });
});

describe('custom answers', () => {
  const d = draft();
  const check = (values: unknown) => checkCustomAnswer(d, { values: values as Record<string, unknown> });

  it('accepts a full answer, a partial one and the shapes of each block', () => {
    expect(checkAnswer('custom', answer, d)).toBeNull();
    expect(check({ pick: 'a' })).toBeNull();
    expect(check({ pick: 'a', marks: [], ab: null, tags: [], why: '' })).toBeNull();
  });

  it('refuses unknown ids, display blocks and values of the wrong shape', () => {
    expect(check({ pick: 'a', nope: 1 })).toContain('values.nope');
    expect(check({ pick: 'a', intro: 'x' })).toContain('values.intro');
    expect(checkCustomAnswer(d, JSON.parse('{"values":{"pick":"a","__proto__":1}}'))).toContain('values.__proto__');
    expect(check({ pick: 'zzz' })).toContain('option id');
    expect(check({ pick: 'a', tags: ['x', 'x'] })).toContain('option ids');
    expect(check({ pick: 'a', tags: 'x' })).toContain('option ids');
    expect(check({ pick: 'a', speed: 3 })).toContain('from 0.5 to 2');
    expect(check({ pick: 'a', speed: '1' })).toContain('from 0.5 to 2');
    expect(check({ pick: 'a', why: 4 })).toContain('text');
    expect(check({ pick: 'a', todo: [1] })).toContain('texts');
    expect(check({ pick: 'a', grid: [['1']] })).toContain('2 cells');
    expect(check({ pick: 'a', marks: [{ text: 1 }] })).toContain('notes');
    expect(check({ pick: 'a', marks: [{ text: 'x', box: { x: 1 } }] })).toContain('notes');
    expect(check({ pick: 'a', ab: 'c' })).toContain('"a", "b" or null');
    expect(checkAnswer('custom', { values: [] }, d)).toContain('values');
    expect(checkAnswer('custom', 'x', d)).toContain('object');
  });

  it('wants every required block filled, and counts what is filled', () => {
    expect(check({})).toBe('pick is required');
    expect(check({ pick: null })).toBe('pick is required');
    const blocks = draft().blocks;
    const by = (id: string) => blocks.find((b) => b.id === id)!;
    expect(isFilled(by('pick'), 'a')).toBe(true);
    expect(isFilled(by('tags'), [])).toBe(false);
    expect(isFilled(by('why'), '  ')).toBe(false);
    expect(isFilled(by('todo'), [''])).toBe(false);
    expect(isFilled(by('marks'), [{ text: ' ' }])).toBe(false);
    expect(isFilled(by('marks'), [{ text: 'x' }])).toBe(true);
    expect(isFilled(by('ab'), null)).toBe(false);
    expect(isFilled(by('intro'), undefined)).toBe(true);
  });
});

describe('opening and answering a custom panel', () => {
  it('opens over HTTP with the default placement or the one asked for, and refuses a bad placement', async () => {
    const { entry } = writeProject('CustomOpen');
    const studio = await start(entry);
    expect((await open(studio, draft())).json).toEqual({ id: 'p_1', status: 'open' });
    expect((await open(studio, draft({ name: 'second' }), { placement: 'right' })).status).toBe(201);
    const bad = await open(studio, draft({ name: 'third' }), { placement: 'bottom' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('placement');
    const worse = await open(studio, { ...draft({ name: 'x' }), blocks: [] });
    expect(worse.status).toBe(400);
    expect(worse.json.error.message).toContain('the data for a custom panel is not valid');
    const list = (await api(studio, '/api/panels', { headers: window(studio) })).json.panels as OpenPanel[];
    expect(list.map((p) => `${p.id}:${p.placement}`)).toEqual(['p_1:sheet', 'p_2:right']);
    // Any kind takes a placement; a review is beside the preview unless told otherwise.
    await api(studio, '/api/panels', { method: 'POST', headers: window(studio), json: { panel: 'review', data: { comp: 'Short' } } });
    await api(studio, '/api/panels', { method: 'POST', headers: window(studio), json: { panel: 'brief', data: {}, placement: 'left' } });
    const all = (await api(studio, '/api/panels', { headers: window(studio) })).json.panels as OpenPanel[];
    expect(all.slice(2).map((p) => `${p.panel}:${p.placement}`)).toEqual(['review:beside-preview', 'brief:left']);
    expect(defaultPlacement('brief')).toBe('sheet');
  });

  it('keeps several open when their names differ, and a new one with the same name replaces the old', async () => {
    const { entry } = writeProject('CustomNames');
    const studio = await start(entry);
    const client = await Client.connect(studio);
    await open(studio, draft({ name: 'one' }));
    await open(studio, draft({ name: 'two' }));
    const third = await open(studio, draft({ name: 'one', title: 'Again' }));
    expect(third.json.id).toBe('p_3');
    const closed: any = await client.waitForMessage('panel.closed');
    expect(closed.message).toMatchObject({ id: 'p_1', status: 'dismissed' });
    const list = (await api(studio, '/api/panels', { headers: window(studio) })).json.panels as OpenPanel[];
    expect(list.map((p) => `${p.id}:${p.status}`)).toEqual(['p_2:open', 'p_3:open']);
    // A custom panel does not replace a panel of another kind, or the reverse.
    await api(studio, '/api/panels', { method: 'POST', headers: window(studio), json: { panel: 'brief', data: {} } });
    expect(((await api(studio, '/api/panels', { headers: window(studio) })).json.panels as OpenPanel[]).filter((p) => p.status === 'open')).toHaveLength(3);
    client.close();
  });

  it('checks the answer against the blocks, writes plan/custom-<name>.json and keeps it for the window', async () => {
    const { dir, entry } = writeProject('CustomSubmit');
    const studio = await start(entry);
    const client = await Client.connect(studio);
    await open(studio, draft());
    await open(studio, draft({ name: 'other' }));
    await client.waitForMessage('panel');
    client.send({ type: 'panel.submit', id: 'p_1', answer: { values: { pick: 'zzz' } } });
    const refused: any = await client.waitForMessage('panel.error');
    expect(refused.message.message).toContain('option id');
    client.send({ type: 'panel.submit', id: 'p_1', answer: { values: {} } });
    await until(() => client.messages('panel.error').length, (n) => n === 2);
    expect((client.messages('panel.error')[1] as any).message).toContain('pick is required');
    expect(existsSync(join(dir, 'plan'))).toBe(false);

    client.send({ type: 'panel.submit', id: 'p_1', answer });
    const closed: any = await client.waitForMessage('panel.closed', (m) => m.id === 'p_1');
    expect(closed.message).toMatchObject({ status: 'submitted', panel: { answer } });
    // The file keeps the draft with the answer, so the panel can come back after a restart.
    expect(readFileSync(join(dir, 'plan', 'custom-end-card.json'), 'utf8')).toBe(`${JSON.stringify({ draft: draft(), answer }, null, 2)}\n`);
    expect(readdirSync(join(dir, 'plan'))).toEqual(['custom-end-card.json']);
    expect((await api(studio, '/api/plan/custom-end-card', { headers: window(studio) })).json).toEqual({ draft: draft(), answer });
    // The other panel is still open and has its own file name.
    expect((await api(studio, '/api/panels/p_2', { headers: window(studio) })).json.status).toBe('open');
    client.send({ type: 'panel.submit', id: 'p_2', answer: { values: { pick: 'a' } } });
    await client.waitForMessage('panel.closed', (m) => m.id === 'p_2');
    expect(readdirSync(join(dir, 'plan')).sort()).toEqual(['custom-end-card.json', 'custom-other.json']);
    client.close();
  });

  it('brings an answered custom panel back after a restart, with its blocks', async () => {
    const { dir, entry } = writeProject('CustomRestore');
    const first = await start(entry);
    const client = await Client.connect(first);
    await open(first, draft());
    await client.waitForMessage('panel');
    client.send({ type: 'panel.submit', id: 'p_1', answer });
    await client.waitForMessage('panel.closed');
    client.close();
    await stopAll();

    const second = await start(entry);
    const again = await Client.connect(second);
    await until(() => again.messages('panel').length, (n) => n === 1);
    const restored: any = again.messages('panel')[0]!;
    expect(restored.panel).toMatchObject({ panel: 'custom', status: 'submitted', data: draft(), answer });
    expect(readdirSync(join(dir, 'plan'))).toEqual(['custom-end-card.json']);
    // A new panel of the same name opens beside it and replaces nothing that waits.
    expect((await open(second, draft())).json).toEqual({ id: 'p_2', status: 'open' });
    again.close();
  });

  it('leaves out a custom plan file that is not a draft with an answer that fits it', async () => {
    const { dir, entry } = writeProject('CustomRestoreBad');
    mkdirSync(join(dir, 'plan'));
    const put = (name: string, value: unknown) => writeFileSync(join(dir, 'plan', `custom-${name}.json`), typeof value === 'string' ? value : JSON.stringify(value));
    put('good', { draft: draft({ name: 'good' }), answer });
    put('values-only', answer);
    put('wrong-name', { draft: draft({ name: 'other' }), answer });
    put('bad-answer', { draft: draft({ name: 'bad-answer' }), answer: { values: { pick: 'zzz' } } });
    put('missing-required', { draft: draft({ name: 'missing-required' }), answer: { values: {} } });
    put('not-json', '{ nope');
    const studio = await start(entry);
    const list = (await api(studio, '/api/panels', { headers: window(studio) })).json.panels as OpenPanel[];
    expect(list.map((p) => `${(p.data as CustomDraft).name}:${p.status}`)).toEqual(['good:submitted']);
  });

  it('does not restore from a plan directory that leaves the project, or a file that is a link', async () => {
    const { dir, entry } = writeProject('CustomRestoreLinks');
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, 'custom-good.json'), JSON.stringify({ draft: draft({ name: 'good' }), answer }));
    symlinkSync(elsewhere, join(dir, 'plan'));
    const linked = await start(entry);
    expect(((await api(linked, '/api/panels', { headers: window(linked) })).json as { panels: unknown[] }).panels).toEqual([]);
    await stopAll();

    const other = writeProject('CustomRestoreFileLink');
    mkdirSync(join(other.dir, 'plan'));
    symlinkSync(join(elsewhere, 'custom-good.json'), join(other.dir, 'plan', 'custom-good.json'));
    const studio = await start(other.entry);
    expect(((await api(studio, '/api/panels', { headers: window(studio) })).json as { panels: unknown[] }).panels).toEqual([]);
  });

  it('serves and writes only slugged custom plan files', async () => {
    const { entry } = writeProject('CustomNamesOnly');
    const studio = await start(entry);
    for (const name of ['custom', 'custom-', 'custom-A', 'custom-..%2Fx', 'custom-a.b', `custom-${'a'.repeat(41)}`]) {
      expect((await api(studio, `/api/plan/${name}`, { headers: window(studio) })).status, name).toBe(404);
    }
    expect((await api(studio, '/api/plan/custom-ok', { headers: window(studio) })).status).toBe(404);
    expect(planFileOf({ panel: 'custom', data: draft() })).toBe('custom-end-card');
    expect(planFileOf({ panel: 'brief', data: {} })).toBe('brief');
  });

  it('tells the agent in one line, and a dismissal by name', async () => {
    const { dir, entry } = writeProject('CustomTell');
    const studio = await start(entry, { agent: command, agentCwd: dir });
    const client = await Client.connect(studio);
    client.send({ type: 'agent.prompt', text: 'hello', context: '' });
    await client.waitForMessage('agent', (m) => m.event.kind === 'done');
    await open(studio, draft());
    await open(studio, draft({ name: 'second' }));
    await client.waitForMessage('panel');
    client.send({ type: 'panel.submit', id: 'p_1', answer });
    const text =
      '[panel custom:end-card p_1 submitted] pick=b, tags=x, speed=1.2 x, why="make it faster", todo=2 items, grid=1 row, marks=1 note, ab=a; see plan/custom-end-card.json';
    await client.waitForMessage('agent', (m) => m.event.kind === 'user' && m.event.text === text);
    client.send({ type: 'panel.dismiss', id: 'p_2' });
    await client.waitForMessage('agent', (m) => m.event.kind === 'user' && m.event.text === '[panel custom:second p_2 dismissed]');
    client.close();
  });

  it('writes the message for a custom panel without any value', () => {
    const panel = (over: Partial<OpenPanel>): OpenPanel => ({ id: 'p_9', panel: 'custom', data: draft(), message: null, status: 'open', answer: null, openedAt: 1, ...over });
    expect(closingMessage(panel({ status: 'submitted', answer: { values: {} } }))).toBe('[panel custom:end-card p_9 submitted] no values; see plan/custom-end-card.json');
    expect(closingMessage(panel({ status: 'dismissed' }))).toBe('[panel custom:end-card p_9 dismissed]');
  });
});
