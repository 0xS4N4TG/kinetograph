import { createContext, useContext, useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { JsonSchema } from '@/lib/props-schema';
import { useFrame } from '@/lib/player-hooks';
import { ActivePanelContext, PreviewContext } from '@/lib/preview-context';

/** The panel URL of each installed plugin that has one, by plugin name. */
export const PluginPanels = createContext<Record<string, string>>({});

/** What a plugin's panel is given (CONTRACT.md sections 3 and 10). */
interface PanelContext {
  value: unknown;
  schema: JsonSchema;
  path: string[];
  onChange(value: unknown): void;
  preview?: {
    overlay: HTMLElement;
    width: number;
    height: number;
    frame: number;
  };
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
  /** False while the field's section is folded: the overlay is hidden then. */
  open?: boolean;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** The element a panel draws on the picture with: composition pixels, scaled by Studio's `--kg-preview-scale`. */
function makeOverlay(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'plugin-overlay');
  Object.assign(el.style, { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0', transform: 'scale(var(--kg-preview-scale, 1))', pointerEvents: 'none' });
  return el;
}

/**
 * A field drawn by a plugin's panel module: it is imported from the studio server (which bundles it), mounted in a
 * plain element, and given the field's value, and an overlay laid over the preview picture. A panel that fails to load
 * or throws is replaced by an error box.
 */
export function PluginPanel({ plugin, name, schema, path, value, onChange, open = true }: PluginPanelProps) {
  const url = useContext(PluginPanels)[plugin];
  const preview = useContext(PreviewContext);
  const { active } = useContext(ActivePanelContext);
  const key = path.join('.');
  const shown = open && (active === null || active === key);
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<PanelHandle | null>(null);
  const [overlay] = useState(makeOverlay);
  const [error, setError] = useState<string | null>(null);
  const frame = useFrame(preview?.player ?? NO_PLAYER);
  const width = preview?.width ?? 0;
  const height = preview?.height ?? 0;
  const layer = preview?.layer ?? null;

  // The panel calls the latest `onChange`, and `update` gets the latest context, without remounting.
  const latest = useRef<PanelContext>({ value, schema, path, onChange });
  latest.current = {
    value,
    schema,
    path,
    onChange,
    ...(preview ? { preview: { overlay, width, height, frame } } : {}),
  };
  const context = (): PanelContext => ({ ...latest.current, onChange: (next) => latest.current.onChange(next) });

  // The overlay sits in the preview's frame while there is one, and is gone when this panel is.
  useEffect(() => {
    if (!layer) return;
    layer.appendChild(overlay);
    return () => overlay.remove();
  }, [layer, overlay]);
  useEffect(() => {
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
  }, [overlay, width, height]);
  useEffect(() => {
    overlay.style.display = shown ? '' : 'none';
  }, [overlay, shown]);

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

  // From outside: the value changed (reset, preset, the agent), or the frame on screen did.
  useEffect(() => {
    try {
      handle.current?.update(context());
    } catch (cause) {
      setError(message(cause));
    }
  }, [value, frame, width, height]);

  if (url === undefined || error !== null) {
    return (
      <Alert variant="error" data-testid="plugin-panel-error">
        <AlertTitle>The panel for {name} did not load</AlertTitle>
        <AlertDescription>{url === undefined ? `${plugin} is not installed or has no panel.` : error}</AlertDescription>
      </Alert>
    );
  }
  return <div ref={host} data-testid="plugin-panel" />;
}

/** `useFrame` needs a player; without a preview there is no frame to follow. */
const NO_PLAYER = {
  subscribe: () => () => {},
  getState: () => ({ frame: 0 }),
} as unknown as import('@/lib/player').Player;
