import { createContext, useContext, useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { JsonSchema } from '@/lib/props-schema';

/** The panel URL of each installed plugin that has one, by plugin name. */
export const PluginPanels = createContext<Record<string, string>>({});

/** What a plugin's panel is given (the contract: CONTRACT.md §3, docs/guides/plugins). */
interface PanelContext {
  value: unknown;
  schema: JsonSchema;
  path: string[];
  onChange(value: unknown): void;
}

interface PanelHandle {
  update(ctx: PanelContext): void;
  unmount(): void;
}

interface PluginPanelProps {
  plugin: string;
  name: string;
  schema: JsonSchema;
  path: string[];
  value: unknown;
  onChange(value: unknown): void;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * A field drawn by a plugin's panel module: it is imported from the studio server (which bundles it), mounted in a
 * plain element, and given the field's value. A panel that fails to load or throws is replaced by an error box.
 */
export function PluginPanel({ plugin, name, schema, path, value, onChange }: PluginPanelProps) {
  const url = useContext(PluginPanels)[plugin];
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<PanelHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The panel calls the latest `onChange`, and `update` gets the latest context, without remounting.
  const latest = useRef<PanelContext>({ value, schema, path, onChange });
  latest.current = { value, schema, path, onChange };
  const context = (): PanelContext => ({ ...latest.current, onChange: (next) => latest.current.onChange(next) });

  useEffect(() => {
    if (url === undefined) return;
    let cancelled = false;
    setError(null);
    import(/* @vite-ignore */ url).then(
      (module: { mount?: (el: HTMLElement, ctx: PanelContext) => PanelHandle }) => {
        if (cancelled || !host.current) return;
        try {
          if (typeof module.mount !== 'function') throw new Error('the module does not export mount(el, ctx)');
          handle.current = module.mount(host.current, context());
        } catch (cause) {
          setError(message(cause));
        }
      },
      (cause: unknown) => !cancelled && setError(message(cause)),
    );
    return () => {
      cancelled = true;
      try {
        handle.current?.unmount();
      } catch {
        // the panel is going away anyway
      }
      handle.current = null;
    };
  }, [url]);

  useEffect(() => {
    try {
      handle.current?.update(context());
    } catch (cause) {
      setError(message(cause));
    }
  }, [value]);

  if (url === undefined || error !== null) {
    return (
      <Alert variant="destructive" data-testid="plugin-panel-error">
        <AlertTitle>The panel for {name} did not load</AlertTitle>
        <AlertDescription>{url === undefined ? `${plugin} is not installed or has no panel.` : error}</AlertDescription>
      </Alert>
    );
  }
  return <div ref={host} data-testid="plugin-panel" />;
}
