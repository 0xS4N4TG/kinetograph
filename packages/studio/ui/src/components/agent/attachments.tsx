import { XIcon } from 'lucide-react';

import { attachmentUrl, type Attachment } from '@/lib/attachments';
import { cn } from '@/lib/utils';

/** The pictures waiting in the prompt box, each with an x. */
export function AttachmentChips({ items, remove }: { items: Attachment[]; remove(id: number): void }) {
  if (items.length === 0) return null;
  return (
    <ul className="mb-1.5 flex flex-wrap items-center gap-1.5 px-0.5" data-testid="image-chips" aria-label="Attached images">
      {items.map((item) => (
        <li key={item.id} className="group relative" data-testid="image-chip" title={item.file.name}>
          <img src={item.preview} alt={item.file.name || 'Attached image'} className="border-border size-11 rounded-lg border object-cover" />
          <button
            type="button"
            aria-label={`Remove ${item.file.name || 'image'}`}
            onClick={() => remove(item.id)}
            className="bg-foreground text-background focus-visible:ring-ring absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full opacity-90 outline-none hover:opacity-100 focus-visible:ring-2"
          >
            <XIcon className="size-2.5" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The pictures of a message already sent (or queued), small, from the project's public/refs. */
export function MessageImages({ names, small = false, className }: { names: string[]; small?: boolean; className?: string }) {
  if (names.length === 0) return null;
  return (
    <div className={cn('flex max-w-full flex-wrap gap-1.5', className)} data-testid="message-images">
      {names.map((name, index) => (
        <img
          key={`${name}-${index}`}
          src={attachmentUrl(name)}
          alt={name}
          title={name}
          loading="lazy"
          className={cn('border-border rounded-lg border object-cover', small ? 'size-8' : 'size-16')}
        />
      ))}
    </div>
  );
}
