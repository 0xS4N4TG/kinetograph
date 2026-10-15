import { useEffect, useId, useState, type ReactNode } from 'react';
import { RotateCcwIcon } from 'lucide-react';

import type { CompositionInfo } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

interface PropsPanelProps {
  comp: CompositionInfo | null;
  values: Record<string, unknown>;
  /** True while the values differ from the composition's defaults. */
  edited: boolean;
  onChange(values: Record<string, unknown>): void;
  onReset(): void;
}

/** A form for the composition's `defaultProps`; every edit re-renders the preview with the new props. */
export function PropsPanel({ comp, values, edited, onChange, onReset }: PropsPanelProps) {
  const names = Object.keys(comp?.defaultProps ?? {});
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="props-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">{comp ? `${comp.id} props` : 'Props'}</span>
        <Button variant="ghost" size="sm" disabled={!edited} onClick={onReset}>
          <RotateCcwIcon />
          Reset
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {names.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm">This composition has no props.</p>
        ) : (
          <form className="flex flex-col gap-4 p-3" onSubmit={(event) => event.preventDefault()}>
            {names.map((name) => (
              <PropField key={name} name={name} value={values[name]} onChange={(v) => onChange({ ...values, [name]: v })} />
            ))}
          </form>
        )}
      </ScrollArea>
    </div>
  );
}

interface FieldProps {
  name: string;
  value: unknown;
  onChange(value: unknown): void;
}

function PropField({ name, value, onChange }: FieldProps) {
  const id = useId();
  const label = <Label htmlFor={id}>{name}</Label>;

  if (typeof value === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3">
        {label}
        <Switch id={id} checked={value} onCheckedChange={onChange} />
      </div>
    );
  }
  if (typeof value === 'number') return <NumberField id={id} label={label} value={value} onChange={onChange} />;
  if (typeof value === 'string') {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
      </div>
    );
  }
  return <JsonField id={id} label={label} value={value} onChange={onChange} />;
}

type FieldBody = { id: string; label: ReactNode; onChange(value: unknown): void };

/** Keeps what is being typed (`1.`, an empty box) until it is a number. */
function NumberField({ id, label, value, onChange }: FieldBody & { value: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    // A box that is empty or half typed (`-`, `1e`) is kept; one that holds another number was reset from outside.
    if (draft !== null && draft.trim() !== '' && Number.isFinite(Number(draft)) && Number(draft) !== value) setDraft(null);
  }, [value, draft]);
  return (
    <div className="flex flex-col gap-1.5">
      {label}
      <Input
        id={id}
        type="number"
        value={draft ?? String(value)}
        onChange={(event) => {
          setDraft(event.target.value);
          if (event.target.value.trim() !== '' && Number.isFinite(Number(event.target.value))) {
            onChange(Number(event.target.value));
          }
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}

/** Nested values and null: edited as JSON, applied once it parses. */
function JsonField({ id, label, value, onChange }: FieldBody & { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (draft === null) return;
    try {
      if (JSON.stringify(JSON.parse(draft)) !== JSON.stringify(value)) setDraft(null);
    } catch {
      // still typing
    }
  }, [value, draft]);
  return (
    <div className="flex flex-col gap-1.5">
      {label}
      <Textarea
        id={id}
        className="font-mono text-xs"
        aria-invalid={invalid}
        value={draft ?? text}
        onChange={(event) => {
          setDraft(event.target.value);
          try {
            onChange(JSON.parse(event.target.value));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        onBlur={() => {
          setDraft(null);
          setInvalid(false);
        }}
      />
      {invalid && <p className="text-destructive text-xs">Not valid JSON; the preview keeps the last valid value.</p>}
    </div>
  );
}
