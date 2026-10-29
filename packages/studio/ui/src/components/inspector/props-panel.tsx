import { useEffect, useId, useState, type ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";

import type { CompositionInfo } from "@/api";
import {
  fieldKind,
  helperText,
  schemaProperties,
  type JsonSchema,
} from "@/lib/props-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface PropsPanelProps {
  comp: CompositionInfo | null;
  values: Record<string, unknown>;
  /** True while the values differ from the composition's defaults. */
  edited: boolean;
  onChange(values: Record<string, unknown>): void;
  onReset(): void;
}

/**
 * A form for the composition's props; every edit re-renders the preview with the new props. The fields come from the
 * composition's `propsSchema` when it has one, then from any `defaultProps` the schema does not name.
 */
export function PropsPanel({
  comp,
  values,
  edited,
  onChange,
  onReset,
}: PropsPanelProps) {
  const schemaFields = schemaProperties(comp?.propsSchema);
  const schemaNames = new Set(schemaFields.map(([name]) => name));
  const names = [
    ...schemaNames,
    ...Object.keys(comp?.defaultProps ?? {}).filter(
      (name) => !schemaNames.has(name),
    ),
  ];
  const schemas = new Map(schemaFields);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="props-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
        <span className="text-sm font-medium">
          {comp ? `${comp.id} props` : "Props"}
        </span>
        <Button variant="ghost" size="sm" disabled={!edited} onClick={onReset}>
          <RotateCcwIcon />
          Reset
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {names.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm">
            This composition has no props.
          </p>
        ) : (
          <form
            className="flex flex-col gap-4 p-3"
            onSubmit={(event) => event.preventDefault()}
          >
            {names.map((name) => (
              <PropField
                key={name}
                name={name}
                schema={schemas.get(name)}
                value={values[name]}
                onChange={(v) => onChange({ ...values, [name]: v })}
              />
            ))}
          </form>
        )}
      </ScrollArea>
    </div>
  );
}

interface FieldProps {
  name: string;
  /** The field's JSON Schema, when the composition has one for it. */
  schema?: JsonSchema | undefined;
  value: unknown;
  onChange(value: unknown): void;
}

function Help({ schema }: { schema: JsonSchema | undefined }) {
  const text = helperText(schema);
  return text === null ? null : (
    <p className="text-muted-foreground text-xs">{text}</p>
  );
}

function PropField({ name, schema, value, onChange }: FieldProps) {
  const id = useId();
  const label = <Label htmlFor={id}>{name}</Label>;
  const kind = fieldKind(schema);

  if (kind?.kind === "group") {
    const group =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return (
      <fieldset className="flex flex-col gap-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{name}</legend>
        <Help schema={schema} />
        {kind.properties.map(([key, child]) => (
          <PropField
            key={key}
            name={key}
            schema={child}
            value={group[key]}
            onChange={(v) => onChange({ ...group, [key]: v })}
          />
        ))}
      </fieldset>
    );
  }
  if (kind?.kind === "enum") {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <Select
          value={value === undefined ? "" : String(value)}
          onValueChange={(picked) =>
            onChange(kind.options.find((option) => String(option) === picked))
          }
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kind.options.map((option) => (
              <SelectItem key={String(option)} value={String(option)}>
                {String(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Help schema={schema} />
      </div>
    );
  }
  if (kind?.kind === "slider" && typeof value === "number") {
    const step = kind.integer ? 1 : (kind.max - kind.min) / 200;
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <div className="flex items-center gap-3">
          <Slider
            min={kind.min}
            max={kind.max}
            step={step}
            value={[value]}
            onValueChange={([next]) => onChange(next)}
          />
          <div className="w-24 shrink-0">
            <NumberField id={id} value={value} onChange={onChange} />
          </div>
        </div>
        <Help schema={schema} />
      </div>
    );
  }
  if (kind?.kind === "color" && typeof value === "string") {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${name} colour`}
            className="border-input h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
            value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
            onChange={(event) => onChange(event.target.value)}
          />
          <Input
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
        <Help schema={schema} />
      </div>
    );
  }
  if (kind?.kind === "textarea" && typeof value === "string") {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <Textarea
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Help schema={schema} />
      </div>
    );
  }

  if (typeof value === "boolean") {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          {label}
          <Switch id={id} checked={value} onCheckedChange={onChange} />
        </div>
        <Help schema={schema} />
      </div>
    );
  }
  if (typeof value === "number") {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <NumberField id={id} value={value} onChange={onChange} />
        <Help schema={schema} />
      </div>
    );
  }
  if (typeof value === "string") {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Help schema={schema} />
      </div>
    );
  }
  return (
    <JsonField
      id={id}
      label={label}
      help={<Help schema={schema} />}
      value={value}
      onChange={onChange}
    />
  );
}

type FieldBody = {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  onChange(value: unknown): void;
};

/** Keeps what is being typed (`1.`, an empty box) until it is a number. */
function NumberField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange(value: unknown): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    // A box that is empty or half typed (`-`, `1e`) is kept; one that holds another number was reset from outside.
    if (
      draft !== null &&
      draft.trim() !== "" &&
      Number.isFinite(Number(draft)) &&
      Number(draft) !== value
    )
      setDraft(null);
  }, [value, draft]);
  return (
    <Input
      id={id}
      type="number"
      value={draft ?? String(value)}
      onChange={(event) => {
        setDraft(event.target.value);
        if (
          event.target.value.trim() !== "" &&
          Number.isFinite(Number(event.target.value))
        ) {
          onChange(Number(event.target.value));
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/** Nested values and null: edited as JSON, applied once it parses. */
function JsonField({
  id,
  label,
  help,
  value,
  onChange,
}: FieldBody & { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? "null";
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (draft === null) return;
    try {
      if (JSON.stringify(JSON.parse(draft)) !== JSON.stringify(value))
        setDraft(null);
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
      {invalid && (
        <p className="text-destructive text-xs">
          Not valid JSON; the preview keeps the last valid value.
        </p>
      )}
      {help}
    </div>
  );
}
