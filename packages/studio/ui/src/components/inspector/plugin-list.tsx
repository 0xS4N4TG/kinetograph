import type { PluginSummary } from '@/api';
import { PluginBadge, PluginIcon } from '@/components/inspector/plugin-card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PluginListProps {
  plugins: PluginSummary[];
  /** Names of the plugins this composition uses. */
  used: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onSelect(name: string): void;
  onAsk(text: string): void;
}

/** Every installed plugin: what it is, and whether this composition uses it; an unused one can be added by the agent. */
export function PluginList({ plugins, used, selected, onSelect, onAsk }: PluginListProps) {
  if (plugins.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Plugins" data-testid="plugin-list">
      <h3 className="text-[13px] font-semibold">Plugins</h3>
      <ul className="flex flex-col gap-1.5">
        {plugins.map((plugin) => {
          const isUsed = used.has(plugin.name);
          return (
            <li
              key={plugin.name}
              data-testid="plugin-row"
              data-plugin={plugin.name}
              data-used={isUsed}
              className={cn('bg-muted/50 flex items-start gap-2.5 rounded-xl p-2.5', selected.has(plugin.name) && 'ring-primary ring-2')}
            >
              <span className="bg-card text-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
                <PluginIcon plugin={plugin} className="size-[18px]" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => onSelect(plugin.name)} className="truncate text-left text-[13px] font-semibold outline-none hover:underline focus-visible:underline">
                    {plugin.title}
                  </button>
                  <PluginBadge />
                  <span className="text-muted-foreground text-[11px]">{plugin.version}</span>
                </div>
                {plugin.description && <p className="text-muted-foreground text-xs leading-relaxed">{plugin.description}</p>}
                <div className="mt-1 flex items-center gap-2">
                  <span className={cn('rounded-full px-2 py-px text-[11px] font-medium', isUsed ? 'bg-success/10 text-success-foreground' : 'bg-muted text-muted-foreground')}>
                    {isUsed ? 'used here' : 'installed'}
                  </span>
                  {!isUsed && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 rounded-full px-2 text-xs"
                      onClick={() => onAsk(`Add the ${plugin.title} plugin (${plugin.name}) to this composition. Read its SKILL.md first, then use it where it fits.`)}
                    >
                      Ask the agent to add it
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
