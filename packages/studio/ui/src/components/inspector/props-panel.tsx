import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { RotateCcwIcon } from 'lucide-react';

import type { CompositionInfo, InspectResult, PluginSummary, StudioApi } from '@/api';
import { PluginCard } from '@/components/inspector/plugin-card';
import { PluginList } from '@/components/inspector/plugin-list';
import { PluginPanels } from '@/components/inspector/plugin-panel';
import { PresetsMenu } from '@/components/inspector/presets-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { pluginUsed } from '@/lib/plugins';
import { fieldKind, helperText, schemaProperties, unsetType, type JsonSchema } from '@/lib/props-schema';
import { ActivePanelContext } from '@/lib/preview-context';
import { cn } from '@/lib/utils';

const NO_PATH: string[] = [];
const NO_PLUGINS: PluginSummary[] = [];
const NO_SELECTED: ReadonlySet<string> = new Set();
const noop = () => {};

/** The path of the first field a plugin draws, for its overlay to show before anything is touched. */
function firstPanel(entries: [string, JsonSchema | undefined][], base: string[]): string | null {
  for (const [name, schema] of entries) {
    const kind = fieldKind(schema);
    if (kind?.kind === 'panel') return [...base, name].join('.');
    if (kind?.kind === 'group') {
      const found = firstPanel(kind.properties, [...base, name]);
      if (found) return found;
    }
  }
  return null;
}

/** What a plugin card needs from the app: the installed plugins, which are selected, and the actions. */
interface PluginUi {
  plugins: PluginSummary[];
  selected: ReadonlySet<string>;
  onSelect(name: string): void;
  onAsk(text: string): void;
}
const PluginUiContext = createContext<PluginUi>({ plugins: [], selected: new Set(), onSelect: () => {}, onAsk: () => {} });

interface PropsPanelProps {
  api: StudioApi;
  /** The installed plugins, and the layers on screen (to tell which a composition uses). */
  plugins?: PluginSummary[];
  inspect?: InspectResult | null;
  /** Names of the plugins that are selected: a layer they draw is, or their card was clicked. */
  selectedPlugins?: ReadonlySet<string>;
  onSelectPlugin?(name: string): void;
  onAskAgent?(text: string): void;
  comp: CompositionInfo | null;
  values: Record<string, unknown>;
  /** True while the values differ from the composition's defaults. */
  edited: boolean;
  onChange(values: Record<string, unknown>): void;
  onReset(): void;
}

/**
 * A form for the composition's props; every edit re-renders the preview with the new props. The fields come from the
 * composition's `propsSchema` when it has one, then from any `defaultProps` the schema does not name. A field only
 * re-renders when its own value changes, so dragging one slider does not redraw the rest.
 */
export const PropsPanel = memo(function PropsPanel({ api, comp, values, edited, onChange, onReset, plugins = NO_PLUGINS, inspect = null, selectedPlugins = NO_SELECTED, onSelectPlugin = noop, onAskAgent = noop }: PropsPanelProps) {
  const [active, setActive] = useState<string | null>(null);
  const panels = useMemo<Record<string, string>>(() => Object.fromEntries(plugins.flatMap((p) => (p.panel ? [[p.name, p.panel]] : []))), [plugins]);
  const ui = useMemo<PluginUi>(() => ({ plugins, selected: selectedPlugins, onSelect: onSelectPlugin, onAsk: onAskAgent }), [plugins, selectedPlugins, onSelectPlugin, onAskAgent]);
  const used = useMemo(() => new Set(plugins.filter((p) => pluginUsed(p, comp?.propsSchema, inspect)).map((p) => p.name)), [plugins, comp?.propsSchema, inspect]);
  const schemaFields = schemaProperties(comp?.propsSchema);
  const names = useMemo(() => {
    const schemaNames = new Set(schemaFields.map(([name]) => name));
    return [...schemaNames, ...Object.keys(comp?.defaultProps ?? {}).filter((name) => !schemaNames.has(name))];
  }, [comp?.propsSchema, comp?.defaultProps]);
  const schemas = useMemo(() => new Map(schemaFields), [comp?.propsSchema]);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const setField = useCallback((name: string, value: unknown) => onChange({ ...valuesRef.current, [name]: value }), [onChange]);
  const activeContext = useMemo(
    () => ({ active: active ?? firstPanel(schemaFields, NO_PATH), setActive }),
    [active, comp?.propsSchema],
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="props-panel">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-4">
        <div className="-ml-2 flex items-center gap-0.5">
          {comp && <PresetsMenu api={api} comp={comp} values={values} onLoad={onChange} />}
        </div>
        <div className="-mr-2">
          <Button variant="ghost" size="sm" disabled={!edited} onClick={onReset} className="rounded-full px-3">
            <RotateCcwIcon />
            Reset
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <PluginUiContext.Provider value={ui}>
          {names.length === 0 ? (
            <p className="text-muted-foreground px-4 py-3 text-sm">This composition has no props.</p>
          ) : (
            <PluginPanels.Provider value={panels}>
              <ActivePanelContext.Provider value={activeContext}>
                <form className="flex flex-col gap-5 px-4 pt-1 pb-4" onSubmit={(event) => event.preventDefault()}>
                  {names.map((name) => (
                    <PropField key={name} name={name} parentPath={NO_PATH} schema={schemas.get(name)} value={values[name]} set={setField} />
                  ))}
                </form>
              </ActivePanelContext.Provider>
            </PluginPanels.Provider>
          )}
          <div className="px-4 pt-2 pb-6">
            <PluginList plugins={plugins} used={used} selected={selectedPlugins} onSelect={onSelectPlugin} onAsk={onAskAgent} />
          </div>
        </PluginUiContext.Provider>
      </ScrollArea>
    </div>
  );
});

interface FieldProps {
  name: string;
  /** Where the field's parent is in the props, e.g. `["look"]` for `look.seed`. */
  parentPath: string[];
  /** The field's JSON Schema, when the composition has one for it. */
  schema?: JsonSchema | undefined;
  value: unknown;
  /** Sets one field of the parent (stable, so an untouched field does not re-render). */
  set(name: string, value: unknown): void;
}

function Help({ schema }: { schema: JsonSchema | undefined }) {
  const text = helperText(schema);
  return text === null ? null : <p className="text-muted-foreground text-xs leading-relaxed">{text}</p>;
}

const FIELD = 'flex flex-col gap-2';

const PropField = memo(function PropField({ name, parentPath, schema, value, set }: FieldProps) {
  const id = useId();
  const path = useMemo(() => [...parentPath, name], [parentPath, name]);
  const onChange = useCallback((next: unknown) => set(name, next), [set, name]);
  const kind = fieldKind(schema);
  // An optional field with no value yet is drawn from its schema's type, empty, and marked as the component's default.
  const unset = value === undefined ? unsetType(schema) : null;
  const label = (
    <Label htmlFor={id} className="text-[13px] font-medium">
      {name}
      {value === undefined && <span className="text-muted-foreground ml-1.5 text-xs font-normal">default</span>}
    </Label>
  );

  if (kind?.kind === 'panel' && schema) {
    return <PanelSection name={name} path={path} plugin={kind.plugin} schema={schema} value={value} onChange={onChange} />;
  }
  if (kind?.kind === 'group') {
    return (
      <GroupField name={name} path={path} schema={schema} value={value} properties={kind.properties} onChange={onChange} />
    );
  }
  if (kind?.kind === 'enum') {
    const items = kind.options.map((option) => ({ value: String(option), label: String(option) }));
    return (
      <div className={FIELD}>
        {label}
        <Select
          items={items}
          value={value === undefined ? null : String(value)}
          onValueChange={(picked) => onChange(kind.options.find((option) => String(option) === picked))}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Help schema={schema} />
      </div>
    );
  }
  if (kind?.kind === 'slider' && (typeof value === 'number' || unset === 'number')) {
    const step = kind.integer ? 1 : (kind.max - kind.min) / 200;
    const number = typeof value === 'number' ? value : undefined;
    const thumb = number ?? (typeof schema?.default === 'number' ? schema.default : kind.min);
    return (
      <div className={FIELD}>
        {label}
        <div className="flex items-center gap-3">
          <Slider
            min={kind.min}
            max={kind.max}
            step={step}
            value={thumb}
            getAriaLabel={() => name}
            onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
          />
          <div className="w-24 shrink-0">
            <NumberField id={id} value={number} onChange={onChange} />
          </div>
        </div>
        <Help schema={schema} />
      </div>
    );
  }
  if (kind?.kind === 'color' && (typeof value === 'string' || unset === 'string')) {
    const text = typeof value === 'string' ? value : '';
    return (
      <div className={FIELD}>
        {label}
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${name} colour`}
            className="border-input size-8 shrink-0 cursor-pointer rounded-lg border bg-transparent p-0.5"
            value={/^#[0-9a-f]{6}$/i.test(text) ? text : '#000000'}
            onChange={(event) => onChange(event.target.value)}
          />
          <Input id={id} value={text} onChange={(event) => onChange(event.target.value)} />
        </div>
        <Help schema={schema} />
      </div>
    );
  }
  if (kind?.kind === 'textarea' && (typeof value === 'string' || unset === 'string')) {
    return (
      <div className={FIELD}>
        {label}
        <Textarea id={id} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} />
        <Help schema={schema} />
      </div>
    );
  }

  if (typeof value === 'boolean' || unset === 'boolean') {
    return (
      <div className={FIELD}>
        <div className="flex items-center justify-between gap-3">
          {label}
          <Switch id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
        </div>
        <Help schema={schema} />
      </div>
    );
  }
  if (typeof value === 'number' || unset === 'number') {
    return (
      <div className={FIELD}>
        {label}
        <NumberField id={id} value={typeof value === 'number' ? value : undefined} onChange={onChange} />
        <Help schema={schema} />
      </div>
    );
  }
  if (typeof value === 'string' || unset === 'string') {
    return (
      <div className={FIELD}>
        {label}
        <Input id={id} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} />
        <Help schema={schema} />
      </div>
    );
  }
  return <JsonField id={id} label={label} help={<Help schema={schema} />} value={value} onChange={onChange} />;
});

/** A field a plugin's panel owns, drawn as the plugin's card. */
function PanelSection({ name, path, plugin, schema, value, onChange }: { name: string; path: string[]; plugin: string; schema: JsonSchema; value: unknown; onChange(value: unknown): void }) {
  const { setActive } = useContextActive();
  const ui = useContext(PluginUiContext);
  const info = ui.plugins.find((p) => p.name === plugin);
  const key = path.join('.');
  return (
    <PluginCard
      plugin={info}
      pluginName={plugin}
      field={name}
      path={path}
      schema={schema}
      value={value}
      onChange={onChange}
      selected={ui.selected.has(plugin)}
      onSelect={() => ui.onSelect(plugin)}
      onAsk={ui.onAsk}
      onActive={() => setActive(key)}
      help={<Help schema={schema} />}
    />
  );
}

function useContextActive() {
  return useContext(ActivePanelContext);
}

function GroupField({ name, path, schema, value, properties, onChange }: { name: string; path: string[]; schema: JsonSchema | undefined; value: unknown; properties: [string, JsonSchema | undefined][]; onChange(value: unknown): void }) {
  const group = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const groupRef = useRef(group);
  groupRef.current = group;
  const setChild = useCallback((key: string, next: unknown) => onChange({ ...groupRef.current, [key]: next }), [onChange]);
  return (
    <fieldset className="bg-muted/50 flex flex-col gap-4 rounded-xl p-3.5">
      <legend className="float-left mb-3 w-full text-[13px] font-semibold">{name}</legend>
      <Help schema={schema} />
      {properties.map(([key, child]) => (
        <PropField key={key} name={key} parentPath={path} schema={child} value={group[key]} set={setChild} />
      ))}
    </fieldset>
  );
}

type FieldBody = {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  onChange(value: unknown): void;
};

/** Keeps what is being typed (`1.`, an empty box) until it is a number. Empty while `value` is unset. */
function NumberField({ id, value, onChange }: { id: string; value: number | undefined; onChange(value: unknown): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    // A box that is empty or half typed (`-`, `1e`) is kept; one that holds another number was reset from outside.
    if (draft !== null && draft.trim() !== '' && Number.isFinite(Number(draft)) && Number(draft) !== value)
      setDraft(null);
  }, [value, draft]);
  return (
    <Input
      id={id}
      type="number"
      value={draft ?? (value === undefined ? '' : String(value))}
      placeholder={value === undefined ? 'default' : undefined}
      onChange={(event) => {
        setDraft(event.target.value);
        if (event.target.value.trim() !== '' && Number.isFinite(Number(event.target.value))) {
          onChange(Number(event.target.value));
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/** Nested values and null: edited as JSON, applied once it parses. */
function JsonField({ id, label, help, value, onChange }: FieldBody & { value: unknown }) {
  // An unset field is an empty box; `null` is a value of its own.
  const text = value === undefined ? '' : (JSON.stringify(value, null, 2) ?? 'null');
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
    <div className={FIELD}>
      {label}
      <Textarea
        id={id}
        className="font-mono text-xs"
        aria-invalid={invalid}
        value={draft ?? text}
        placeholder={value === undefined ? 'default' : undefined}
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
      {invalid && <p className="text-destructive-foreground text-xs">Not valid JSON; the preview keeps the last valid value.</p>}
      {help}
    </div>
  );
}
