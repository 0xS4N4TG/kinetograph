import { FilmIcon, ImageIcon, LinkIcon, PlusIcon, UploadIcon, XIcon } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingImage, Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { newKey, type RefRow } from './brief-model';
import { refUrl, uploadRef } from './brief-upload';

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/** The picture beside a reference: the video's contact sheet, the image itself, or an icon. */
function Thumb({ row }: { row: RefRow }) {
  const shown = row.sheet ?? (row.kind === 'file' && IMAGE.test(row.src) ? row.src : null);
  return (
    <div className="bg-muted text-muted-foreground relative flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border">
      {row.uploading ? (
        <Skeleton data-testid="upload-skeleton" className="size-full rounded-none" />
      ) : shown ? (
        <LoadingImage src={refUrl(shown)} alt={row.sheet ? `Contact sheet of ${row.name ?? row.src}` : (row.name ?? row.src)} className="size-full object-cover" />
      ) : row.kind === 'file' ? (
        row.error ? <XIcon className="size-4" /> : IMAGE.test(row.src) ? <ImageIcon className="size-4" /> : <FilmIcon className="size-4" />
      ) : (
        <LinkIcon className="size-4" />
      )}
    </div>
  );
}

interface ReferencesProps {
  rows: RefRow[];
  onChange(update: (rows: RefRow[]) => RefRow[]): void;
}

/** The references shelf: links and dropped files, each with the line on what to take from it. */
export function References({ rows, onChange }: ReferencesProps) {
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const patch = (key: string, change: Partial<RefRow>) => onChange((all) => all.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const addFile = (file: File) => {
    const key = newKey();
    onChange((all) => [...all, { key, kind: 'file', src: '', like: '', name: file.name, uploading: true }]);
    uploadRef(file).then(
      (stored) => patch(key, { ...stored, uploading: false, error: undefined }),
      (error: unknown) => patch(key, { uploading: false, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  const addLink = (src = '') => onChange((all) => [...all, { key: newKey(), kind: 'link', src, like: '' }]);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) {
      for (const file of files) addFile(file);
      return;
    }
    const text = (event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')).trim();
    if (/^https?:\/\//i.test(text)) addLink(text);
  };

  return (
    <div className="flex flex-col gap-2" data-testid="references">
      {rows.map((row) => (
        <div key={row.key} className="bg-card flex items-start gap-3 rounded-lg border p-2" data-testid="reference">
          <Thumb row={row} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {row.kind === 'link' ? (
              <Input size="sm" value={row.src} placeholder="https://…  (kept as a note, never fetched)" aria-label="Link" onChange={(e) => patch(row.key, { src: e.target.value })} />
            ) : (
              <div className="text-muted-foreground truncate font-mono text-xs" title={row.src || row.name}>
                {row.uploading ? `Uploading ${row.name ?? ''}…` : row.src || row.name}
              </div>
            )}
            {row.error ? <div className="text-destructive-foreground text-xs">Could not upload: {row.error}</div> : null}
            <Input
              size="sm"
              value={row.like}
              placeholder="What you like about it: the cut rhythm, the type…"
              aria-label="What you like about it"
              onChange={(e) => patch(row.key, { like: e.target.value })}
            />
          </div>
          <Button variant="ghost" size="icon-xs" aria-label="Remove reference" onClick={() => onChange((all) => all.filter((r) => r.key !== row.key))}>
            <XIcon />
          </Button>
        </div>
      ))}
      <div
        data-testid="drop-zone"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'text-muted-foreground flex flex-wrap items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-xs transition-colors',
          over && 'border-ring bg-accent/50 text-foreground',
        )}
      >
        <UploadIcon className="size-4" />
        <span>Drop a video or image here, or</span>
        <Button variant="outline" size="xs" onClick={() => picker.current?.click()}>
          Choose a file
        </Button>
        <Button variant="outline" size="xs" onClick={() => addLink()}>
          <PlusIcon /> Add a link
        </Button>
        <input
          ref={picker}
          type="file"
          accept="video/*,image/*"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            for (const file of e.target.files ?? []) addFile(file);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
