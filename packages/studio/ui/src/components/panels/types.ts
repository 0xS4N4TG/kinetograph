import type { OpenPanel, PanelAnswer, PanelKind } from '../../../../src/panels/types.ts';

export type * from '../../../../src/panels/types.ts';

/** What the panel host gives every panel component. */
export interface PanelProps<K extends PanelKind> {
  panel: OpenPanel<K>;
  /** Sends the answer; the host closes the panel when the server confirms. */
  onSubmit: (answer: PanelAnswer[K]) => void;
  onDismiss: () => void;
}
