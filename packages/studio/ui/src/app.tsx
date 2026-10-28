import { useState } from 'react';

import type { StudioApi } from '@/api';
import { AgentPanel } from '@/components/agent/agent-panel';
import { InspectorPanel } from '@/components/inspector/inspector-panel';
import { ProjectPanel } from '@/components/project/project-panel';
import { MenuBar } from '@/components/shell/menu-bar';
import { ShortcutsDialog } from '@/components/shell/shortcuts-dialog';
import { ToolBar, type Tool, type Workspace } from '@/components/shell/tool-bar';
import { Timeline } from '@/components/timeline/timeline';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Transport } from '@/components/viewer/transport';
import { Viewer, type View, type Zoom } from '@/components/viewer/viewer';
import { useChat } from '@/lib/use-chat';
import { useTransportKeys } from '@/lib/use-transport-keys';
import { useStudio } from '@/studio';

/** The inspector tab each workspace opens. */
const WORKSPACE_TABS: Record<Workspace, string> = {
  Default: 'scene',
  Animation: 'props',
  'Color & Inspect': 'scene',
  Export: 'renders',
};

export function App({ api }: { api: StudioApi }) {
  const studio = useStudio(api);
  const { player, playerState, comp } = studio;
  const chat = useChat(studio);
  const [tab, setTab] = useState('scene');
  const [workspace, setWorkspace] = useState<Workspace>('Default');
  const [tool, setTool] = useState<Tool>('select');
  const [view, setView] = useState<View>({ zoom: 'fit', pan: { x: 0, y: 0 } });
  const [safeZones, setSafeZones] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const selectWorkspace = (next: Workspace) => {
    setWorkspace(next);
    setTab(WORKSPACE_TABS[next]);
  };
  const zoomTo = (zoom: Zoom) => setView({ zoom, pan: { x: 0, y: 0 } });
  /** Layers picked in the preview or on the timeline: one, several, or none; shown in the scene tree. */
  const pickLayers = (ids: string[]) => {
    studio.selectLayers(ids);
    if (ids.length > 0 && tab !== 'agent') setTab('scene');
  };

  useTransportKeys(player, {
    v: () => setTool('select'),
    h: () => setTool('hand'),
    z: () => setTool('zoom'),
    '0': () => zoomTo('fit'),
    '1': () => zoomTo(1),
    '?': () => setShortcutsOpen(true),
  });

  return (
    <TooltipProvider>
      <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
        {/* Menu bar and tool bar */}
        <header className="bg-card flex flex-col border-b select-none">
          <MenuBar
            project={studio.project}
            buildId={studio.buildId}
            connected={studio.connected}
            compositions={studio.compositions}
            comp={comp}
            onSelectComp={studio.selectComp}
            player={player}
            playback={playerState}
            onZoom={zoomTo}
            safeZones={safeZones}
            onSafeZonesChange={setSafeZones}
            workspace={workspace}
            onSelectWorkspace={selectWorkspace}
            onRender={() => setTab('renders')}
            onReload={studio.reload}
            onShowShortcuts={() => setShortcutsOpen(true)}
          />
          <ToolBar tool={tool} onSelectTool={setTool} workspace={workspace} onSelectWorkspace={selectWorkspace} />
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
                    selectedLayers={studio.selectedLayers}
                    compositions={studio.compositions}
                    onSelectComp={studio.selectComp}
                    tool={tool}
                    view={view}
                    onViewChange={setView}
                    safeZones={safeZones}
                    onSafeZonesChange={setSafeZones}
                    onSelectLayers={pickLayers}
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
                  project={studio.project}
                  timeline={studio.timeline.state === 'ready' ? studio.timeline.data : null}
                  selectedLayer={studio.selectedLayer}
                  selectedLayers={studio.selectedLayers}
                  onSelectLayers={pickLayers}
                  onSelectLayer={(id, additive) =>
                    id !== null && additive
                      ? studio.selectLayers(
                          studio.selectedLayers.includes(id) ? studio.selectedLayers.filter((l) => l !== id) : [...studio.selectedLayers, id],
                        )
                      : studio.selectLayer(id)
                  }
                  agentTab={
                    <AgentPanel
                      studio={{ ...studio, frame: playerState.frame }}
                      chat={chat}
                      timeline={studio.timeline.state === 'ready' ? studio.timeline.data : null}
                    />
                  }
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
              status={studio.timeline}
              state={playerState}
              player={player}
              selectedLayers={studio.selectedLayers}
              onSelectLayers={pickLayers}
              thumbnailUrl={studio.thumbnailUrl}
            />
          </ResizablePanel>
        </ResizablePanelGroup>

        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </TooltipProvider>
  );
}
