import { useState } from 'react';
import {
  BoxSelectIcon,
  CrosshairIcon,
  HandIcon,
  LockIcon,
  MenuIcon,
  MousePointerIcon,
  MoveIcon,
  PenToolIcon,
  RotateCwIcon,
  SearchIcon,
  SparklesIcon,
  TypeIcon,
} from 'lucide-react';

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
import { cn } from '@/lib/utils';
import { useStudio } from '@/studio';

const MENUS = ['File', 'Edit', 'Composition', 'Layer', 'Effect', 'Animation', 'View', 'Window'];
const WORKSPACES = ['Default', 'Animation', 'Color & Inspect', 'Export'] as const;

export function App({ api }: { api: StudioApi }) {
  const studio = useStudio(api);
  const { player, playerState, comp } = studio;
  const [tab, setTab] = useState('scene');
  const [workspace, setWorkspace] = useState<(typeof WORKSPACES)[number]>('Default');
  useTransportKeys(player);

  const activeRenders = studio.renders.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const entry = studio.project?.entry.split(/[\\/]/).pop();

  return (
    <TooltipProvider>
      <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
        {/* EffectCraft / FilmCraft Top Menu & Tool Bar */}
        <header className="bg-card flex flex-col border-b select-none">
          {/* Row 1: Application Menu & Status */}
          <div className="bg-background/80 flex h-7 items-center gap-3 border-b border-white/[0.06] px-3 text-[11px]">
            <div className="flex items-center gap-1.5 font-semibold tracking-tight">
              <span
                className="flex size-4 items-center justify-center rounded-[3px] bg-gradient-to-br from-[#4da3ff] to-[#2680eb] text-[9px] font-bold text-white shadow-xs"
                aria-hidden="true"
              >
                K
              </span>
              <span>Kinetograph studio</span>
            </div>

            <nav className="text-muted-foreground hidden items-center gap-3 text-[11px] lg:flex" aria-hidden="true">
              {MENUS.map((item) => (
                <span key={item} className="hover:text-foreground cursor-default transition-colors">
                  {item}
                </span>
              ))}
            </nav>

            {entry && (
              <span
                className="text-muted-foreground bg-secondary/80 mx-auto rounded-xs border border-white/[0.06] px-2 py-0.5 font-mono text-[10px]"
                title={studio.project?.entry}
              >
                {entry}
              </span>
            )}

            <div className="ml-auto flex items-center gap-1.5">
              <span
                className="hidden items-center gap-1 rounded-xs border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-300 sm:inline-flex"
                title="Currently in Read-Only Inspect Mode; interactive canvas & keyframe editing coming soon"
              >
                <LockIcon className="size-2.5" aria-hidden="true" />
                <span>View-Only Mode</span>
              </span>
              {studio.project && (
                <Badge variant="outline" className="h-4 rounded-xs px-1.5 font-mono text-[10px]">
                  v{studio.project.version}
                </Badge>
              )}
              <Badge variant="outline" className="h-4 rounded-xs px-1.5 font-mono text-[10px]">
                build {studio.buildId}
              </Badge>
              <Badge
                variant={studio.connected ? 'secondary' : 'destructive'}
                className="h-4 rounded-xs px-1.5 font-mono text-[10px]"
              >
                <span className={`size-1.5 rounded-full ${studio.connected ? 'bg-emerald-400' : 'bg-current'}`} />
                {studio.connected ? 'connected' : 'offline'}
              </Badge>
            </div>
          </div>

          {/* Row 2: EffectCraft Tool Bar & Workspace Switcher */}
          <div className="flex h-8 items-center justify-between px-3 text-xs">
            <div className="flex items-center gap-1" aria-hidden="true">
              <span
                className="flex size-6 items-center justify-center rounded-xs bg-[#2680eb] text-white shadow-xs"
                title="Selection Tool (V) — Inspect Only"
              >
                <MousePointerIcon className="size-3.5" />
              </span>
              <span className="text-muted-foreground/70 flex size-6 items-center justify-center rounded-xs">
                <HandIcon className="size-3.5" />
              </span>
              <span className="text-muted-foreground/70 flex size-6 items-center justify-center rounded-xs">
                <SearchIcon className="size-3.5" />
              </span>
              <div className="bg-border mx-1 h-4 w-px" />
              <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Rotation Tool (Planned)">
                <RotateCwIcon className="size-3.5" />
              </span>
              <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Pan Behind / Anchor Point Tool (Planned)">
                <CrosshairIcon className="size-3.5" />
              </span>
              <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Move / Transform Tool (Planned)">
                <MoveIcon className="size-3.5" />
              </span>
              <div className="bg-border mx-1 h-4 w-px" />
              <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Rectangle / Shape Tool (Planned)">
                <BoxSelectIcon className="size-3.5" />
              </span>
              <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Pen / Mask Tool (Planned)">
                <PenToolIcon className="size-3.5" />
              </span>
              <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Text Tool (Planned)">
                <TypeIcon className="size-3.5" />
              </span>
              <div className="bg-border mx-1.5 h-4 w-px" />
              <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
                <SparklesIcon className="size-3 text-[#4da3ff]" />
                <span>Snapping</span>
              </span>
            </div>

            {/* Workspace Tabs (like EffectCraft: Default | Animation | Standard) */}
            <div className="flex h-full items-center gap-1" aria-hidden="true">
              {WORKSPACES.map((ws) => {
                const active = workspace === ws;
                return (
                  <button
                    key={ws}
                    type="button"
                    tabIndex={-1}
                    onClick={() => {
                      setWorkspace(ws);
                      if (ws === 'Export') setTab('renders');
                      else if (ws === 'Color & Inspect') setTab('scene');
                      else if (ws === 'Animation') setTab('props');
                    }}
                    className={cn(
                      'flex h-full items-center border-b-2 px-2.5 text-[11px] font-medium transition-colors',
                      active
                        ? 'border-[#2680eb] text-[#4da3ff]'
                        : 'text-muted-foreground hover:text-foreground border-transparent',
                    )}
                  >
                    {ws}
                  </button>
                );
              })}
            </div>
          </div>
        </header>

        {/* Docked NLE Panels with Dark Gutters */}
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1 bg-[#0d0d0f] p-1 gap-1">
          <ResizablePanel defaultSize="64%" minSize="30%" className="overflow-hidden rounded-[2px] border border-white/10">
            <ResizablePanelGroup orientation="horizontal" className="gap-1 bg-[#0d0d0f]">
              <ResizablePanel defaultSize="20%" minSize="14%" className="overflow-hidden rounded-[2px] border border-white/10">
                <CompositionList
                  compositions={studio.compositions}
                  selected={comp?.id ?? null}
                  onSelect={studio.selectComp}
                />
              </ResizablePanel>
              <ResizableHandle className="bg-transparent" />
              <ResizablePanel
                defaultSize="52%"
                minSize="25%"
                className="overflow-hidden rounded-[2px] border border-[#2680eb]/60 shadow-[inset_0_0_0_1px_rgba(38,128,235,0.25)]"
              >
                <div className="flex h-full flex-col">
                  <Preview
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
                <Tabs value={tab} onValueChange={setTab} className="bg-card h-full gap-0">
                  <div className="bg-secondary/60 flex h-7 shrink-0 items-center justify-between border-b px-2">
                    <TabsList className="h-7 rounded-none bg-transparent p-0">
                      <TabsTrigger
                        value="scene"
                        className="data-[state=active]:border-primary h-full rounded-none border-b-2 border-transparent px-2.5 text-[11px] data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                      >
                        Scene
                      </TabsTrigger>
                      <TabsTrigger
                        value="props"
                        className="data-[state=active]:border-primary h-full rounded-none border-b-2 border-transparent px-2.5 text-[11px] data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                      >
                        Props
                      </TabsTrigger>
                      <TabsTrigger
                        value="renders"
                        className="data-[state=active]:border-primary h-full rounded-none border-b-2 border-transparent px-2.5 text-[11px] data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                      >
                        Renders
                        {activeRenders > 0 && <Badge className="ml-1 px-1.5 py-0 text-[9px]">{activeRenders}</Badge>}
                      </TabsTrigger>
                    </TabsList>
                    <MenuIcon className="text-muted-foreground size-3" aria-hidden="true" />
                  </div>
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
