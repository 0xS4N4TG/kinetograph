import { useState } from 'react';

import type { StudioApi } from '@/api';
import { InspectorPanel } from '@/components/inspector/inspector-panel';
import { ProjectPanel } from '@/components/project/project-panel';
import { MenuBar } from '@/components/shell/menu-bar';
import { ToolBar, type Workspace } from '@/components/shell/tool-bar';
import { Timeline } from '@/components/timeline/timeline';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Transport } from '@/components/viewer/transport';
import { Viewer } from '@/components/viewer/viewer';
import { useTransportKeys } from '@/lib/use-transport-keys';
import { useStudio } from '@/studio';

export function App({ api }: { api: StudioApi }) {
  const studio = useStudio(api);
  const { player, playerState, comp } = studio;
  const [tab, setTab] = useState('scene');
  const [workspace, setWorkspace] = useState<Workspace>('Default');
  useTransportKeys(player);

  const selectWorkspace = (next: Workspace) => {
    setWorkspace(next);
    if (next === 'Export') setTab('renders');
    else if (next === 'Color & Inspect') setTab('scene');
    else if (next === 'Animation') setTab('props');
  };

  return (
    <TooltipProvider>
      <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
        {/* Menu bar and tool bar */}
        <header className="bg-card flex flex-col border-b select-none">
          <MenuBar project={studio.project} buildId={studio.buildId} connected={studio.connected} />
          <ToolBar workspace={workspace} onSelectWorkspace={selectWorkspace} />
        </header>

        {/* Docked NLE Panels with Dark Gutters */}
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1 bg-nle-gutter p-1 gap-1">
          <ResizablePanel defaultSize="64%" minSize="30%" className="overflow-hidden rounded-[2px] border border-white/10">
            <ResizablePanelGroup orientation="horizontal" className="gap-1 bg-nle-gutter">
              <ResizablePanel defaultSize="20%" minSize="14%" className="overflow-hidden rounded-[2px] border border-white/10">
                <ProjectPanel
                  compositions={studio.compositions}
                  selected={comp?.id ?? null}
                  onSelect={studio.selectComp}
                />
              </ResizablePanel>
              <ResizableHandle className="bg-transparent" />
              <ResizablePanel
                defaultSize="52%"
                minSize="25%"
                className="overflow-hidden rounded-[2px] border border-nle-blue/60 shadow-[inset_0_0_0_1px_rgba(38,128,235,0.25)]"
              >
                <div className="flex h-full flex-col">
                  <Viewer
                    comp={comp}
                    onImage={studio.onImage}
                    lastImage={studio.lastImage}
                    buildError={studio.buildError}
                    frameError={playerState.error}
                    inspect={studio.inspect}
                    selectedLayer={studio.selectedLayer}
                    compositions={studio.compositions}
                    onSelectComp={studio.selectComp}
                  />
                  <Transport comp={comp} player={player} state={playerState} />
                </div>
              </ResizablePanel>
              <ResizableHandle className="bg-transparent" />
              <ResizablePanel defaultSize="28%" minSize="20%" className="overflow-hidden rounded-[2px] border border-white/10">
                <InspectorPanel
                  tab={tab}
                  onTabChange={setTab}
                  comp={comp}
                  frame={playerState.frame}
                  inspect={studio.inspect}
                  selectedLayer={studio.selectedLayer}
                  onSelectLayer={studio.selectLayer}
                  propValues={studio.propValues}
                  propsEdited={studio.propsOverride !== undefined}
                  onChangeProps={studio.setPropValues}
                  onResetProps={studio.resetProps}
                  renders={studio.renders}
                  onStartRender={studio.startRender}
                  onCancelRender={studio.cancelRender}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle className="bg-transparent" />
          <ResizablePanel defaultSize="36%" minSize="18%" className="overflow-hidden rounded-[2px] border border-white/10">
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
