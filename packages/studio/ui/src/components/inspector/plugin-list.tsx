import { PlugIcon } from 'lucide-react';

import type { CatalogPlugin, PluginSummary } from '@/api';
import { PluginBadge, PluginIcon } from '@/components/inspector/plugin-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface PluginListProps {
  plugins: PluginSummary[];
  /** The site's plugin catalog; null while it loads. */
  catalog: CatalogPlugin[] | null;
  /** Names of the plugins this composition uses. */
  used: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onSelect(name: string): void;
  onAsk(text: string): void;
}

/**
 * The Plugins list, always shown. "In this project" is every installed plugin: what it is, and whether this composition
 * uses it; an unused one can be added by the agent. "Available" is the site's plugins the project does not have: a link
 * to the plugin's page, and, once its package is published, a button that asks the agent to add it.
 */
export function PluginList({ plugins, catalog, used, selected, onSelect, onAsk }: PluginListProps) {
  const installed = new Set(plugins.map((p) => p.name));
  const available = (catalog ?? []).filter((p) => !installed.has(p.name));
  return (
    <section className="flex flex-col gap-3" aria-label="Plugins" data-testid="plugin-list">
      <h3 className="text-[13px] font-semibold">Plugins</h3>
      {plugins.length > 0 && (
        <div className="flex flex-col gap-1.5" role="group" aria-label="In this project">
          <h4 className="text-muted-foreground text-xs font-medium">In this project</h4>
          <ul className="flex flex-col gap-1.5">
            {plugins.map((plugin) => (
              <InstalledRow key={plugin.name} plugin={plugin} isUsed={used.has(plugin.name)} isSelected={selected.has(plugin.name)} onSelect={onSelect} onAsk={onAsk} />
            ))}
          </ul>
        </div>
      )}
      {catalog === null ? (
        <div className="flex flex-col gap-1.5" aria-label="Loading available plugins" data-testid="plugin-list-loading">
          <h4 className="text-muted-foreground text-xs font-medium">Available</h4>
          <Skeleton className="h-[72px] rounded-xl" />
          <Skeleton className="h-[72px] rounded-xl" />
        </div>
      ) : available.length > 0 ? (
        <div className="flex flex-col gap-1.5" role="group" aria-label="Available">
          <h4 className="text-muted-foreground text-xs font-medium">Available</h4>
          <ul className="flex flex-col gap-1.5">
            {available.map((plugin) => (
              <AvailableRow key={plugin.name} plugin={plugin} onAsk={onAsk} />
            ))}
          </ul>
        </div>
      ) : (
        plugins.length === 0 && <p className="text-muted-foreground text-xs">No plugins yet.</p>
      )}
    </section>
  );
}

interface InstalledRowProps {
  plugin: PluginSummary;
  isUsed: boolean;
  isSelected: boolean;
  onSelect(name: string): void;
  onAsk(text: string): void;
}

function InstalledRow({ plugin, isUsed, isSelected, onSelect, onAsk }: InstalledRowProps) {
  return (
    <li
      data-testid="plugin-row"
      data-plugin={plugin.name}
      data-used={isUsed}
      className={cn('bg-muted/50 flex items-start gap-2.5 rounded-xl p-2.5', isSelected && 'ring-primary ring-2')}
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
}

/** A catalog plugin the project does not have. A plugin's icon is not drawn: the window may not load pictures from other sites. */
function AvailableRow({ plugin, onAsk }: { plugin: CatalogPlugin; onAsk(text: string): void }) {
  return (
    <li data-testid="available-row" data-plugin={plugin.name} data-published={plugin.published} className="bg-muted/50 flex items-start gap-2.5 rounded-xl p-2.5">
      <span className="bg-card text-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
        <PlugIcon className="size-[18px]" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold">{plugin.title}</span>
          <PluginBadge />
          {plugin.version && <span className="text-muted-foreground text-[11px]">{plugin.version}</span>}
        </div>
        {plugin.description && <p className="text-muted-foreground text-xs leading-relaxed">{plugin.description}</p>}
        <div className="mt-1 flex items-center gap-2">
          {plugin.published ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 rounded-full px-2 text-xs"
              onClick={() =>
                onAsk(`Add the ${plugin.title} plugin to this project: install the package ${plugin.name} with the project's package manager, then read its SKILL.md and use the plugin where it fits.`)
              }
            >
              Ask the agent to add it
            </Button>
          ) : (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-px text-[11px] font-medium">Coming soon</span>
          )}
          <a
            href={plugin.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${plugin.title} on the Kinetograph site`}
            className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            Learn more
          </a>
        </div>
      </div>
    </li>
  );
}
