import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';

import type { Block } from '../types';
import { BlockShell } from './shell';

type SliderBlockType = Extract<Block, { type: 'slider' }>;
type InputBlockType = Extract<Block, { type: 'input' }>;

/** The step when the agent gave none: a hundredth of the span, as a power of ten (0..100 by 1, 0.5..2 by 0.01). */
export function stepOf(block: SliderBlockType): number {
  return block.step ?? 10 ** Math.floor(Math.log10((block.max - block.min) / 100));
}

const decimalsOf = (n: number): number => (String(n).split('.')[1] ?? '').length;

export function SliderBlock({ block, value, onChange }: { block: SliderBlockType; value: unknown; onChange(value: number): void }) {
  const step = stepOf(block);
  const decimals = Math.max(decimalsOf(step), decimalsOf(block.min));
  const current = typeof value === 'number' ? value : block.min;
  return (
    <BlockShell block={block}>
      <div className="flex items-center gap-3">
        <Slider
          min={block.min}
          max={block.max}
          step={step}
          value={current}
          getAriaLabel={() => block.label ?? block.id}
          onValueChange={(v) => onChange(Number((Array.isArray(v) ? (v[0] ?? block.min) : v).toFixed(decimals)))}
        />
        <output data-testid={`value-${block.id}`} className="w-20 shrink-0 text-right text-sm tabular-nums">
          {current.toFixed(decimals)}
          {block.unit ? ` ${block.unit}` : ''}
        </output>
      </div>
    </BlockShell>
  );
}

export function InputBlock({ block, id, value, onChange }: { block: InputBlockType; id: string; value: unknown; onChange(value: string): void }) {
  const text = typeof value === 'string' ? value : '';
  return (
    <BlockShell block={block} htmlFor={id}>
      {block.multiline ? (
        <Textarea id={id} value={text} placeholder={block.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} value={text} placeholder={block.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </BlockShell>
  );
}
