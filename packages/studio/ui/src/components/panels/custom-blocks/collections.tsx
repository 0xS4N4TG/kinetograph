import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import type { Block } from '../types';
import { BlockShell } from './shell';

type ListBlockType = Extract<Block, { type: 'list' }>;
type TableBlockType = Extract<Block, { type: 'table' }>;

const without = <T,>(list: T[], at: number): T[] => list.filter((_, i) => i !== at);

/** Moves the item at `from` one place up (-1) or down (1). */
function moved<T>(list: T[], from: number, by: -1 | 1): T[] {
  const to = from + by;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

export function ListBlock({ block, value, onChange }: { block: ListBlockType; value: unknown; onChange(value: string[]): void }) {
  const items = Array.isArray(value) ? (value as string[]) : block.items;
  const name = block.label ?? block.id;
  if (!block.editable) {
    return (
      <BlockShell block={block}>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {items.map((item, i) => (
            <li key={i} className="break-words">
              {item}
            </li>
          ))}
        </ul>
      </BlockShell>
    );
  }
  return (
    <BlockShell block={block}>
      <ol className="flex flex-col gap-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-center gap-1">
            <Input size="sm" aria-label={`${name}, item ${i + 1}`} value={item} onChange={(e) => onChange(items.map((s, at) => (at === i ? e.target.value : s)))} />
            <Button variant="ghost" size="icon-xs" aria-label={`Move item ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moved(items, i, -1))}>
              <ArrowUpIcon />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label={`Move item ${i + 1} down`} disabled={i === items.length - 1} onClick={() => onChange(moved(items, i, 1))}>
              <ArrowDownIcon />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label={`Remove item ${i + 1}`} onClick={() => onChange(without(items, i))}>
              <XIcon />
            </Button>
          </li>
        ))}
      </ol>
      <Button variant="ghost" size="xs" className="text-muted-foreground self-start" onClick={() => onChange([...items, ''])}>
        <PlusIcon /> Add item
      </Button>
    </BlockShell>
  );
}

export function TableBlock({ block, value, onChange }: { block: TableBlockType; value: unknown; onChange(value: string[][]): void }) {
  const rows = Array.isArray(value) ? (value as string[][]) : block.rows;
  const name = block.label ?? block.id;
  const edit = block.editable === true;
  return (
    <BlockShell block={block}>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="bg-muted/50 text-left">
              {block.columns.map((column, c) => (
                <th key={c} scope="col" className="px-2 py-1.5 text-xs font-medium">
                  {column}
                </th>
              ))}
              {edit ? <th className="w-8" aria-label="Remove row" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-t">
                {row.map((cell, c) => (
                  <td key={c} className="p-1 align-top">
                    {edit ? (
                      <Input size="sm" aria-label={`${name}, row ${r + 1}, ${block.columns[c]}`} value={cell} onChange={(e) => onChange(rows.map((x, ri) => (ri === r ? x.map((y, ci) => (ci === c ? e.target.value : y)) : x)))} />
                    ) : (
                      <span className="block px-1 py-0.5 break-words">{cell}</span>
                    )}
                  </td>
                ))}
                {edit ? (
                  <td className="p-1 align-middle">
                    <Button variant="ghost" size="icon-xs" aria-label={`Remove row ${r + 1}`} onClick={() => onChange(without(rows, r))}>
                      <XIcon />
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit ? (
        <Button variant="ghost" size="xs" className="text-muted-foreground self-start" onClick={() => onChange([...rows, block.columns.map(() => '')])}>
          <PlusIcon /> Add row
        </Button>
      ) : null}
    </BlockShell>
  );
}
