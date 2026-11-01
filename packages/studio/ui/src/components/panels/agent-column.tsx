import type { ReactNode } from 'react';

import type { PanelTab } from '@/components/inspector/inspector-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const AGENT = 'agent';

/**
 * The left column: the agent chat, and a tab for each panel the agent placed here (`placement: 'left'`). The tab strip only
 * shows once there is a panel, but the chat is always inside the same tab panel, kept mounted, so what the person was
 * typing survives a panel opening and closing.
 */
export function AgentColumn({ agent, tabs, active, onTab }: { agent: ReactNode; tabs: PanelTab[]; active: string | null; onTab(id: string | null): void }) {
  return (
    <Tabs value={active ?? AGENT} onValueChange={(next) => onTab(next === AGENT ? null : String(next))} className="h-full min-h-0 gap-0">
      {tabs.length > 0 && (
        <div className="shrink-0 px-3 pt-3">
          <TabsList className="w-full justify-start overflow-x-auto rounded-full p-1 [scrollbar-width:none]" aria-label="Agent and panels">
            <TabsTrigger value={AGENT} className="rounded-full">
              Agent
            </TabsTrigger>
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="max-w-36 rounded-full">
                <span className="truncate">{t.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      )}
      <TabsContent value={AGENT} keepMounted className="min-h-0 data-[hidden]:hidden">
        {agent}
      </TabsContent>
      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value} className="flex min-h-0 flex-col pt-2">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
