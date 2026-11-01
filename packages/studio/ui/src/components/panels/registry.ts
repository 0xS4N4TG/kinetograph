import type { ComponentType } from 'react';

import { BriefPanel } from './brief-panel';
import { ReviewPanel } from './review-panel';
import { ScriptPanel } from './script-panel';
import { StoryboardPanel } from './storyboard-panel';
import { StyleframesPanel } from './styleframes-panel';
import type { PanelKind, PanelProps } from './types';

/** The component for each panel kind; the host looks the open panel's kind up here. */
export const panelComponents: { [K in PanelKind]: ComponentType<PanelProps<K>> } = {
  brief: BriefPanel,
  script: ScriptPanel,
  storyboard: StoryboardPanel,
  styleframes: StyleframesPanel,
  review: ReviewPanel,
};
