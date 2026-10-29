import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '../src/app';
import type { CompositionInfo, PluginSummary } from '../src/api';
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
