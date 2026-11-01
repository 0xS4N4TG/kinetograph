import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { frameSrc } from '../src/components/panels/frame-src';
import { CustomPanel } from '../src/components/panels/custom-panel';
import { StoryboardPanel } from '../src/components/panels/storyboard-panel';
import { StyleframesPanel } from '../src/components/panels/styleframes-panel';
import { styleframeUrl } from '../src/components/panels/styleframes-card';
import type { Block, OpenPanel } from '../src/components/panels/types';
import { StudioContext } from '../src/lib/studio-context';
import type { Studio } from '../src/studio';
import { intro } from './fixtures';

const base = { message: null, status: 'open', answer: null, openedAt: 0 } as const;
const studioAt = (buildId: number) => ({ buildId, compositions: [{ ...intro, id: 'Board' }] }) as unknown as Studio;
const builds = () => screen.getAllByRole('img', { hidden: true }).map((img) => new URL(img.getAttribute('src')!, 'http://studio.test').searchParams.get('build'));

function show(ui: React.ReactElement, buildId: number) {
  const wrap = (id: number) => <StudioContext.Provider value={studioAt(id)}>{ui}</StudioContext.Provider>;
  const view = render(wrap(buildId));
  return { rebuild: (id: number) => view.rerender(wrap(id)) };
}

describe('the build id in a panel picture address', () => {
  it('is added to the frame route address only once there is a build', () => {
    expect(frameSrc('A', 3, 0.5)).toBe('/api/frame?comp=A&frame=3&scale=0.5&format=jpeg');
    expect(frameSrc('A', 3, 0.5, 0)).toBe('/api/frame?comp=A&frame=3&scale=0.5&format=jpeg');
    expect(frameSrc('A', 3, 0.5, 7)).toBe('/api/frame?comp=A&frame=3&scale=0.5&format=jpeg&build=7');
    expect(styleframeUrl({ id: 'a', label: 'A', comp: 'A', frame: 3 }, 7)).toBe('/api/frame?comp=A&frame=3&scale=1&format=jpeg&build=7');
  });

  it('reloads the styleframes after a rebuild', () => {
    const panel: OpenPanel<'styleframes'> = {
      ...base,
      id: 'p1',
      panel: 'styleframes',
      data: { frames: [{ id: 'a', label: 'A', comp: 'Intro', frame: 1 }, { id: 'b', label: 'B', comp: 'Intro', frame: 2 }] },
    };
    const { rebuild } = show(<StyleframesPanel panel={panel} onSubmit={() => {}} onDismiss={() => {}} />, 3);
    expect(builds()).toEqual(['3', '3']);
    rebuild(4);
    expect(builds()).toEqual(['4', '4']);
  });

  it('reloads the storyboard stills after a rebuild', () => {
    const shot = (id: string, frame: number) => ({ id, frame, what: id, moves: '', seconds: 1, transition: 'cut' as const });
    const panel: OpenPanel<'storyboard'> = { ...base, id: 'p1', panel: 'storyboard', data: { comp: 'Board', shots: [shot('s1', 0), shot('s2', 30)] } };
    const { rebuild } = show(<StoryboardPanel panel={panel} onSubmit={() => {}} onDismiss={() => {}} />, 5);
    expect(builds()).toEqual(['5', '5']);
    rebuild(6);
    expect(builds()).toEqual(['6', '6']);
  });

  it('reloads the pictures of a custom panel (still, clip, choice, notes and compare) after a rebuild', () => {
    const blocks: Block[] = [
      { id: 'still', type: 'still', comp: 'Board', frame: 1 },
      { id: 'clip', type: 'clip', comp: 'Board', from: 0, to: 10 },
      { id: 'pick', type: 'choice', options: [{ id: 'a', still: { comp: 'Board', frame: 2 } }] },
      { id: 'marks', type: 'notes', still: { comp: 'Board', frame: 3 } },
      { id: 'ab', type: 'compare', a: { comp: 'Board', frame: 4 }, b: { comp: 'Board', frame: 5 } },
    ];
    const panel: OpenPanel<'custom'> = { ...base, id: 'p1', panel: 'custom', data: { name: 'x', title: 'X', blocks } };
    const { rebuild } = show(<CustomPanel panel={panel} onSubmit={() => {}} onDismiss={() => {}} />, 1);
    expect(builds()).toHaveLength(6);
    expect(new Set(builds())).toEqual(new Set(['1']));
    rebuild(2);
    expect(new Set(builds())).toEqual(new Set(['2']));
  });
});
