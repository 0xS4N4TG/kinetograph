import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';

import { ChoiceBlock } from './custom-blocks/choice';
import { ListBlock, TableBlock } from './custom-blocks/collections';
import { CompareBlock, NotesBlock } from './custom-blocks/notes-compare';
import { ClipBlock, StillBlock } from './custom-blocks/picture';
import { InputBlock, SliderBlock } from './custom-blocks/simple';
import { HeadingBlock, TextBlock } from './custom-blocks/text';
import { answerOf, initialValues, missing, type Values } from './custom-model';
import type { Block, PanelProps } from './types';

/**
 * The custom panel (docs/proposals/studio-panels.md, "A custom panel made of blocks"): the agent's layout drawn by one
 * generic renderer. Nothing from the agent runs; each block is a fixed component fed data. The answer is a value per input
 * block, and the button waits for the required ones.
 */
export function CustomPanel({ panel, onSubmit, onDismiss }: PanelProps<'custom'>) {
  const { blocks, submitLabel } = panel.data;
  const [values, setValues] = useState<Values>(() => initialValues(blocks));
  const set = (id: string, value: unknown) => setValues((all) => ({ ...all, [id]: value }));
  const lacking = useMemo(() => missing(blocks, values), [blocks, values]);

  const draw = (block: Block) => {
    const id = `${panel.id}-${block.id}`;
    const value = values[block.id];
    switch (block.type) {
      case 'heading':
        return <HeadingBlock block={block} />;
      case 'text':
        return <TextBlock block={block} />;
      case 'still':
        return <StillBlock block={block} />;
      case 'clip':
        return <ClipBlock block={block} />;
      case 'choice':
        return <ChoiceBlock block={block} value={value} onChange={(v) => set(block.id, v)} />;
      case 'slider':
        return <SliderBlock block={block} value={value} onChange={(v) => set(block.id, v)} />;
      case 'input':
        return <InputBlock block={block} id={id} value={value} onChange={(v) => set(block.id, v)} />;
      case 'list':
        return <ListBlock block={block} value={value} onChange={(v) => set(block.id, v)} />;
      case 'table':
        return <TableBlock block={block} value={value} onChange={(v) => set(block.id, v)} />;
      case 'notes':
        return <NotesBlock block={block} value={value} onChange={(v) => set(block.id, v)} />;
      case 'compare':
        return <CompareBlock block={block} value={value} onChange={(v) => set(block.id, v)} />;
    }
  };

  return (
    <div className="@container bg-background flex h-full min-h-0 flex-col" data-testid="custom-panel">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          {blocks.map((block) => (
            <div key={block.id} className="min-w-0">
              {draw(block)}
            </div>
          ))}
        </div>
      </div>
      <div className="border-border/60 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          {lacking.length > 0 ? (
            <span className="text-muted-foreground text-xs" role="status">
              {lacking.length === 1 ? `${lacking[0]!.label ?? lacking[0]!.id} needs a value.` : `${lacking.length} blocks need a value.`}
            </span>
          ) : null}
          <Button disabled={lacking.length > 0} onClick={() => onSubmit(answerOf(blocks, values))}>
            {submitLabel ?? 'Send'}
          </Button>
        </div>
      </div>
    </div>
  );
}
