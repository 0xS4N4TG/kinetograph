import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '../src/app';
import type { CatalogPlugin, CompositionInfo, PluginSummary } from '../src/api';
import { PluginList } from '../src/components/inspector/plugin-list';
import { layersOfPlugin, pluginsOfSelection } from '../src/lib/plugins';
import { buildChatContext } from '../src/lib/chat-context';
import { intro, inspectFor, layer } from './fixtures';
import { MockServer } from './mock-server';

const hexed: PluginSummary = {
  name: '@kinetographdev/hexed',
  version: '0.1.0',
  title: 'Hexed',
  description: 'Rolls a look onto any picture.',
  icon: '/api/plugins/%40kinetographdev%2Fhexed/icon.svg',
  components: ['Hexed'],
  skill: '/work/node_modules/@kinetographdev/hexed/SKILL.md',
  panel: '/api/plugins/%40kinetographdev%2Fhexed/panel.js',
  tools: [],
};
const paper: PluginSummary = { ...hexed, name: '@kinetographdev/paper', title: 'Paper', description: 'Paper material.', icon: null, components: ['MatchCut'], panel: null };

const look: CompositionInfo = {
  ...intro,
  defaultProps: { look: { grade: 'warm' }, title: 'Hello' },
  propsSchema: {
    type: 'object',
    properties: {
      look: { type: 'object', kinetographPanel: '@kinetographdev/hexed', description: 'The rolled look.' },
      title: { type: 'string' },
    },
  },
};

class PluginServer extends MockServer {
  override pluginList = [hexed, paper];
  override comps = [look];
  override inspectFor(comp: CompositionInfo, frame: number) {
    const base = inspectFor(comp, frame);
    return { ...base, layers: [layer('pic', 'image', { component: 'Hexed' } as never), ...base.layers] };
  }
}

describe('plugin helpers', () => {
  const inspect = inspectFor(look, 0);
  inspect.layers.unshift(layer('pic', 'image', { component: 'Hexed' } as never));
  it('maps components to plugins and back', () => {
    expect(layersOfPlugin(hexed, inspect)).toEqual(['pic']);
    expect(layersOfPlugin(paper, inspect)).toEqual([]);
    expect(pluginsOfSelection([hexed, paper], inspect, ['pic', 'bg'])).toEqual([hexed.name]);
  });
  it('names the plugin in the agent context', () => {
    const text = buildChatContext({ entry: '/work/scene.tsx', cwd: '/work', comp: look, frame: 0, layers: [inspect.layers[0]!], timeline: null, plugins: [hexed] });
    expect(text).toContain('plugin Hexed (@kinetographdev/hexed');
  });
});

describe('plugin cards', () => {
  it('shows the plugin card, lists installed plugins, and selects both ways', async () => {
    const user = userEvent.setup();
    render(<App api={new PluginServer()} />);
    let card = await screen.findByTestId('plugin-card');
    expect(within(card).getByText('Hexed')).toBeInTheDocument();
    expect(within(card).getByText('plugin')).toBeInTheDocument();
    expect(within(card).getByText('look')).toBeInTheDocument();
    expect(card).toHaveAttribute('data-selected', 'false');

    const rows = screen.getAllByTestId('plugin-row');
    expect(rows.map((r) => r.getAttribute('data-used'))).toEqual(['true', 'false']);
    expect(within(rows[1]!).getByRole('button', { name: 'Ask the agent to add it' })).toBeInTheDocument();

    // wait until the frame's layers are known
    await user.click(screen.getByRole('tab', { name: 'Scene' }));
    await within(await screen.findByTestId('scene-tree')).findByTitle(/^pic \(/);
    await user.click(screen.getByRole('tab', { name: 'Props' }));

    // card -> layers
    card = screen.getByTestId('plugin-card');
    await user.click(within(card).getByRole('button', { name: 'Select Hexed' }));
    await waitFor(() => expect(screen.getByTestId('selection-chips')).toHaveTextContent('pic · frame 0'));
    expect(card).toHaveAttribute('data-selected', 'true');

    // layers -> card: pick another plugin's row, then the layer in the scene tree
    await user.click(within(card).getByRole('button', { name: 'Select Hexed' }));
    await waitFor(() => expect(screen.getByTestId('plugin-card')).toHaveAttribute('data-selected', 'false'));
    await user.click(screen.getByRole('tab', { name: 'Scene' }));
    await user.click(within(await screen.findByTestId('scene-tree')).getByTitle(/^pic \(/));
    await user.click(screen.getByRole('tab', { name: 'Props' }));
    await waitFor(() => expect(screen.getByTestId('plugin-card')).toHaveAttribute('data-selected', 'true'));

    // asking about an unused plugin puts a message in the agent's box
    await user.click(within(screen.getAllByTestId('plugin-row')[1]!).getByRole('button', { name: 'Ask the agent to add it' }));
    expect((screen.getByLabelText('Message for the agent') as HTMLTextAreaElement).value).toContain('Add the Paper plugin');
  });
});

const site = (name: string, title: string, published = false): CatalogPlugin => ({ name, slug: title.toLowerCase(), title, description: `${title} for videos.`, published, url: `https://site.test/plugins/${title.toLowerCase()}/` });
const none = new Set<string>();

describe('plugin list', () => {
  const list = (plugins: PluginSummary[], catalog: CatalogPlugin[] | null, onAsk: (text: string) => void = () => {}) =>
    render(<PluginList plugins={plugins} catalog={catalog} used={new Set([hexed.name])} selected={none} onSelect={() => {}} onAsk={onAsk} />);

  it('has two groups: installed in this project, and the catalog plugins not installed', () => {
    list([hexed], [site(hexed.name, 'Hexed'), site('@kinetographdev/vj', 'Vj')]);
    const inProject = screen.getByRole('group', { name: 'In this project' });
    expect(within(inProject).getAllByTestId('plugin-row')).toHaveLength(1);
    expect(within(inProject).getByText('used here')).toBeInTheDocument();
    const available = screen.getByRole('group', { name: 'Available' });
    const rows = within(available).getAllByTestId('available-row');
    expect(rows.map((r) => r.getAttribute('data-plugin'))).toEqual(['@kinetographdev/vj']);
  });

  it('with nothing installed shows only Available', () => {
    list([], [site('@kinetographdev/vj', 'Vj')]);
    expect(screen.queryByRole('group', { name: 'In this project' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Available' })).toBeInTheDocument();
    expect(screen.getByText('Plugins')).toBeInTheDocument();
  });

  it('says so when there is nothing at all, and while the catalog loads shows a skeleton', () => {
    const empty = list([], []);
    expect(screen.getByText('No plugins yet.')).toBeInTheDocument();
    expect(screen.queryByRole('group')).toBeNull();
    empty.unmount();
    list([], null);
    expect(screen.getByTestId('plugin-list-loading').querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText('No plugins yet.')).toBeNull();
  });

  it('shows Coming soon, not an action, for a plugin that is not published, and links to its page', () => {
    list([], [site('@kinetographdev/vj', 'Vj')]);
    const row = screen.getByTestId('available-row');
    expect(within(row).getByText('Coming soon')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).toBeNull();
    const link = within(row).getByRole('link', { name: 'Vj on the Kinetograph site' });
    expect(link).toHaveAttribute('href', 'https://site.test/plugins/vj/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('offers to ask the agent to add a published plugin, naming the package', async () => {
    const asked: string[] = [];
    list([], [site('@kinetographdev/vj', 'Vj', true)], (text) => asked.push(text));
    const row = screen.getByTestId('available-row');
    expect(within(row).queryByText('Coming soon')).toBeNull();
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Ask the agent to add it' }));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('@kinetographdev/vj');
    expect(asked[0]).toContain('SKILL.md');
  });
});

describe('plugin catalog in the app', () => {
  class CatalogServer extends MockServer {
    override catalogList = [site('@kinetographdev/vj', 'Vj', true)];
  }
  it('lists the catalog although no plugin is installed, and an Ask puts the message in the agent box', async () => {
    const user = userEvent.setup();
    render(<App api={new CatalogServer()} />);
    const row = await screen.findByTestId('available-row');
    expect(screen.queryByTestId('plugin-row')).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Ask the agent to add it' }));
    expect((screen.getByLabelText('Message for the agent') as HTMLTextAreaElement).value).toContain('@kinetographdev/vj');
  });

  it('shows the empty state when the catalog cannot be had', async () => {
    class Down extends MockServer {
      override catalogError = true;
    }
    render(<App api={new Down()} />);
    expect(await screen.findByText('No plugins yet.')).toBeInTheDocument();
  });
});

describe('reload', () => {
  it('keeps edited props across a reload, and Reset forgets them', async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    const first = render(<App api={new PluginServer()} />);
    const title = await screen.findByLabelText('title');
    await user.clear(title);
    await user.type(title, 'Kept');
    first.unmount();

    render(<App api={new PluginServer()} />);
    await waitFor(() => expect(screen.getByLabelText('title')).toHaveValue('Kept'));
    await user.click(screen.getByRole('button', { name: /Reset/ }));
    await waitFor(() => expect(screen.getByLabelText('title')).toHaveValue('Hello'));
    expect(window.localStorage.getItem('kg.props:/work/scene.tsx')).toBeNull();
    window.localStorage.clear();
  });
});
