import type { Block } from '../types';
import { BlockShell } from './shell';

type Heading = Extract<Block, { type: 'heading' }>;
type Text = Extract<Block, { type: 'text' }>;

export function HeadingBlock({ block }: { block: Heading }) {
  return (
    <div data-testid={`block-${block.id}`} data-block="heading">
      <h3 className="text-base font-semibold">{block.text}</h3>
      {block.help ? <p className="text-muted-foreground text-xs">{block.help}</p> : null}
    </div>
  );
}

/** Paragraphs split at a blank line, with **bold** as the only markup; React text, never HTML. */
export function inline(paragraph: string) {
  return paragraph.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}

export function TextBlock({ block }: { block: Text }) {
  return (
    <BlockShell block={block}>
      <div className="flex flex-col gap-2 text-sm leading-relaxed">
        {block.text
          .split(/\n{2,}/)
          .filter((p) => p.trim() !== '')
          .map((p, i) => (
            <p key={i} className="whitespace-pre-line">
              {inline(p.trim())}
            </p>
          ))}
      </div>
    </BlockShell>
  );
}
