import { isFilled, takesAnswer } from '../../../../src/panels/custom.ts';
import type { Block, CustomAnswer, CustomDraft } from './types';

export type Values = Record<string, unknown>;

/** Where a picture of a composition comes from: the studio's frame route, at a fraction of the composition's size. */
export const frameSrc = (comp: string, frame: number, scale: number): string => `/api/frame?comp=${encodeURIComponent(comp)}&frame=${frame}&scale=${scale}&format=jpeg`;

/** What each input block starts with: its `value` (or items, rows) when the agent gave one, else empty. */
export function initialValues(blocks: Block[]): Values {
  const values: Values = {};
  for (const block of blocks) {
    switch (block.type) {
      case 'choice':
        values[block.id] = block.multiple ? (Array.isArray(block.value) ? [...block.value] : []) : typeof block.value === 'string' ? block.value : null;
        break;
      case 'slider':
        values[block.id] = block.value ?? block.min;
        break;
      case 'input':
        values[block.id] = block.value ?? '';
        break;
      case 'list':
        values[block.id] = [...block.items];
        break;
      case 'table':
        values[block.id] = block.rows.map((row) => [...row]);
        break;
      case 'notes':
        values[block.id] = [];
        break;
      case 'compare':
        values[block.id] = null;
        break;
    }
  }
  return values;
}

/** The required blocks that still have no value. */
export const missing = (blocks: Block[], values: Values): Block[] => blocks.filter((b) => b.required && takesAnswer(b) && !isFilled(b, values[b.id]));

/** The answer to send: every input block's value, with blank list items and empty notes left out. */
export function answerOf(blocks: Block[], values: Values): CustomAnswer {
  const out: Values = {};
  for (const block of blocks) {
    if (!takesAnswer(block)) continue;
    const value = values[block.id];
    if (block.type === 'list') out[block.id] = (value as string[]).map((s) => s.trim()).filter((s) => s !== '');
    else if (block.type === 'notes') out[block.id] = (value as { text: string }[]).filter((n) => n.text.trim() !== '').map((n) => ({ ...n, text: n.text.trim() }));
    else out[block.id] = value;
  }
  return { values: out };
}

/** What a saved answer says, as rows of a block's name and its value in words, for the read-only view. */
export function answerRows(draft: CustomDraft, answer: CustomAnswer): [string, string][] {
  const rows: [string, string][] = [];
  for (const block of draft.blocks) {
    if (!takesAnswer(block) || !(block.id in answer.values)) continue;
    const value = answer.values[block.id];
    const name = block.label ?? block.id;
    switch (block.type) {
      case 'choice': {
        const label = (id: string) => {
          const option = block.options.find((o) => o.id === id);
          return option?.label ?? option?.text ?? id;
        };
        const picked = Array.isArray(value) ? (value as string[]) : value === null ? [] : [value as string];
        rows.push([name, picked.length > 0 ? picked.map(label).join(', ') : 'none']);
        break;
      }
      case 'slider':
        rows.push([name, `${value}${block.unit ? ` ${block.unit}` : ''}`]);
        break;
      case 'input':
        rows.push([name, (value as string) || 'empty']);
        break;
      case 'list':
        rows.push([name, (value as string[]).length > 0 ? (value as string[]).map((s) => `- ${s}`).join('\n') : 'empty']);
        break;
      case 'table':
        rows.push([name, (value as string[][]).length > 0 ? (value as string[][]).map((r) => r.join(' | ')).join('\n') : 'empty']);
        break;
      case 'notes': {
        const notes = value as { text: string; box?: unknown }[];
        rows.push([name, notes.length > 0 ? notes.map((n, i) => `${i + 1}. ${n.text}${n.box ? ' (on an area)' : ''}`).join('\n') : 'none']);
        break;
      }
      case 'compare': {
        const side = value === 'a' || value === 'b' ? block[value] : null;
        rows.push([name, side ? `${value === 'a' ? 'A' : 'B'}${side.label ? `, ${side.label}` : ''}` : 'neither']);
        break;
      }
    }
  }
  return rows;
}
