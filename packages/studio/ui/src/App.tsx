import { useState } from 'react';

import type { StudioApi } from '@/api';
import { CompositionList } from '@/components/composition-list';
import { Preview } from '@/components/preview';
import { PropsPanel } from '@/components/props-panel';
import { RenderQueue } from '@/components/render-queue';
import { SceneTree } from '@/components/scene-tree';
import { Timeline } from '@/components/timeline';
import { Transport } from '@/components/transport';
import { Badge } from '@/components/ui/badge';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTransportKeys } from '@/lib/use-transport-keys';
import { useStudio } from '@/studio';

export function App({ api }: { api: StudioApi }) {
  const studio = useStudio(api);
  const { player, playerState, comp } = studio;
  const [tab, setTab] = useState('scene');
  useTransportKeys(player);

  const activeRenders = studio.renders.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const entry = studio.project?.entry.split(/[\\/]/).pop();

  return (
    <TooltipProvider>
      <div className="bg-background text-foreground flex h-screen flex-col">
        <header className="bg-card/50 flex h-12 shrink-0 items-center gap-3 border-b px-4 text-sm backdrop-blur">
          <span className="from-primary size-6 rounded-md bg-gradient-to-br to-sky-400 shadow-[0_0_12px_-2px_var(--primary)]" aria-hidden />
          <span className="font-semibold tracking-tight">Kinetograph studio</span>
          {entry && (
            <span className="text-muted-foreground bg-secondary rounded-md px-2 py-0.5 font-mono text-xs" title={studio.project?.entry}>
              {entry}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {studio.project && <Badge variant="outline" className="rounded-full">v{studio.project.version}</Badge>}
            <Badge variant="outline" className="rounded-full">build {studio.buildId}</Badge>
            <Badge variant={studio.connected ? 'secondary' : 'destructive'} className="rounded-full">
              <span className={`size-1.5 rounded-full ${studio.connected ? 'bg-emerald-400' : 'bg-current'}`} />
              {studio.connected ? 'connected' : 'offline'}
            </Badge>
          </div>
        </header>

        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="70%" minSize="30%">
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel defaultSize="18%" minSize="12%">
                <CompositionList
                  compositions={studio.compositions}
                  selected={comp?.id ?? null}
                  onSelect={studio.selectComp}
                />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize="50%" minSize="25%">
                <div className="flex h-full flex-col">
                  <Preview
                    comp={comp}
                    onImage={studio.onImage}
                    lastImage={studio.lastImage}
                    buildError={studio.buildError}
                    frameError={playerState.error}
                  />
                  <Transport comp={comp} player={player} state={playerState} />
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize="32%" minSize="20%">
                <Tabs value={tab} onValueChange={setTab} className="h-full gap-0">
                  <TabsList className="m-2 shrink-0">
                    <TabsTrigger value="scene">Scene</TabsTrigger>
                    <TabsTrigger value="props">Props</TabsTrigger>
                    <TabsTrigger value="renders">
                      Renders
                      {activeRenders > 0 && <Badge className="px-1.5 py-0">{activeRenders}</Badge>}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="scene" className="min-h-0">
                    <SceneTree
                      inspect={studio.inspect}
                      frame={playerState.frame}
                      selected={studio.selectedLayer}
                      onSelect={studio.selectLayer}
                    />
                  </TabsContent>
                  <TabsContent value="props" className="min-h-0">
                    <PropsPanel
                      comp={comp}
                      values={studio.propValues}
                      edited={studio.propsOverride !== undefined}
                      onChange={studio.setPropValues}
                      onReset={studio.resetProps}
                    />
                  </TabsContent>
                  <TabsContent value="renders" className="min-h-0">
                    <RenderQueue
                      comp={comp}
                      jobs={studio.renders}
                      propsEdited={studio.propsOverride !== undefined}
                      onStart={studio.startRender}
                      onCancel={studio.cancelRender}
                    />
                  </TabsContent>
                </Tabs>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="30%" minSize="15%">
            <Timeline
              comp={comp}
              data={studio.timeline}
              state={playerState}
              player={player}
              selectedLayer={studio.selectedLayer}
              onSelectLayer={(id) => {
                studio.selectLayer(id);
                setTab('scene');
              }}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </TooltipProvider>
  );
}
