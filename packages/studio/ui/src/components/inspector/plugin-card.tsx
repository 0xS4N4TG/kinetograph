import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDownIcon, EllipsisIcon, PlugIcon } from 'lucide-react';

import type { PluginSummary } from '@/api';
import { PluginPanel } from '@/components/inspector/plugin-panel';
import { Button } from '@/components/ui/button';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { copyText } from '@/lib/clipboard';
import type { JsonSchema } from '@/lib/props-schema';
import { cn } from '@/lib/utils';

/** The plugin's own icon (an SVG drawn in currentColor, so it takes the text colour), or a generic plug. */
export function PluginIcon({ plugin, className }: { plugin: Pick<PluginSummary, 'icon'> | undefined; className?: string }) {
  if (!plugin?.icon) return <PlugIcon className={cn('size-4', className)} aria-hidden="true" />;
  const url = `url("${plugin.icon}")`;
  return (
    <span
      aria-hidden="true"
      data-testid="plugin-icon"
      className={cn('inline-block size-4 shrink-0 bg-current', className)}
      style={{ maskImage: url, WebkitMaskImage: url, maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center' }}
    />
  );
}

/** "plugin", muted: what the card is. */
export function PluginBadge() {
  return <span className="bg-muted text-muted-foreground rounded-full px-1.5 py-px text-[10px] font-medium tracking-wide uppercase">plugin</span>;
}

interface PluginCardProps {
  /** The installed plugin; undefined when the schema names one that is not installed. */
  plugin: PluginSummary | undefined;
  /** The plugin's name in the schema, for the header when it is not installed. */
  pluginName: string;
  /** The field the plugin owns, e.g. `look`. */
  field: string;
  path: string[];
  schema: JsonSchema;
  value: unknown;
  onChange(value: unknown): void;
  /** The card is the selection: a layer it draws is selected, or the card was clicked. */
  selected: boolean;
  onSelect(): void;
  onAsk(text: string): void;
  /** Called when the panel is picked, so its overlay shows. */
  onActive(): void;
  help: ReactNode;
  /** The composition, so a panel's own state is kept per composition. */
  scope?: string;
}

/**
 * A field a plugin's panel owns, shown as the plugin: icon, title, version, the field name small and muted, the one-line
 * description, and the panel in the body. Clicking the header selects the plugin (and the layers it draws); a selected
 * card has a ring and opens itself.
 */
export function PluginCard({ plugin, pluginName, field, path, schema, value, onChange, selected, onSelect, onAsk, onActive, help, scope }: PluginCardProps) {
  const [open, setOpen] = useState(true);
  const [summary, setSummary] = useState('');
  const card = useRef<HTMLElement>(null);
  const title = plugin?.title ?? pluginName;

  // Selected from a layer: open and bring into view.
  useEffect(() => {
    if (!selected) return;
    setOpen(true);
    card.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  return (
    <section
      ref={card}
      data-testid="plugin-card"
      data-plugin={pluginName}
      data-selected={selected}
      aria-label={`${title} plugin`}
      onPointerDownCapture={onActive}
      onFocusCapture={onActive}
      className={cn('bg-muted/50 flex flex-col gap-2 scroll-my-3 rounded-xl p-3 transition-shadow', selected && 'ring-primary ring-2')}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`Select ${title}`}
          className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2"
        >
          <span className="bg-card text-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
            <PluginIcon plugin={plugin} className="size-[18px]" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold">{title}</span>
              <PluginBadge />
              {plugin && <span className="text-muted-foreground text-[11px]">{plugin.version}</span>}
            </span>
            <span className="text-muted-foreground truncate font-mono text-[11px]">{field}</span>
          </span>
        </button>
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost" size="icon" aria-label={`${title} menu`} className="size-7 rounded-full">
                <EllipsisIcon />
              </Button>
            }
          />
          <MenuPopup align="end">
            {plugin?.skill && <MenuItem onClick={() => void copyText(plugin.skill!)}>Copy path to SKILL.md</MenuItem>}
            <MenuItem onClick={() => onAsk(`Tell me about the ${title} plugin (${pluginName}) and how I can use it in this composition. Read its SKILL.md first.`)}>
              Ask the agent about {title}
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Button variant="ghost" size="icon" aria-label={open ? `Collapse ${title}` : `Expand ${title}`} aria-expanded={open} onClick={() => setOpen(!open)} className="size-7 rounded-full">
          <ChevronDownIcon className={cn('transition-transform', !open && '-rotate-90')} />
        </Button>
      </div>
      {plugin?.description && <p className="text-muted-foreground text-xs leading-relaxed">{plugin.description}</p>}
      {!open && summary !== '' && (
        <p className="text-foreground/80 truncate text-xs" data-testid="plugin-summary">
          {summary}
        </p>
      )}
      <div className={cn('flex flex-col gap-2', !open && 'hidden')}>
        <PluginPanel plugin={pluginName} name={field} schema={schema} path={path} value={value} onChange={onChange} open={open} onSummary={setSummary} {...(scope ? { scope } : {})} />
        {help}
      </div>
    </section>
  );
}
