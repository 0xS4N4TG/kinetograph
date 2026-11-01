import { useCallback, useEffect, useMemo, useState } from 'react';

import type { StudioApi } from '@/api';
import { AgentPanel } from '@/components/agent/agent-panel';
import { CommandMenu } from '@/components/command/command-menu';
import { ExportDialog } from '@/components/inspector/export-dialog';
import { InspectorPanel, type InspectorTab } from '@/components/inspector/inspector-panel';
import { PanelDock, PanelSheet, usePanelView } from '@/components/panels/panel-host';
import { PanelStepper } from '@/components/panels/stepper';
import { Panel } from '@/components/shell/panel';
import { ResizeHandle } from '@/components/shell/resize-handle';
import { ShortcutsDialog } from '@/components/shell/shortcuts-dialog';
import { TopBar } from '@/components/shell/top-bar';
import { Timeline } from '@/components/timeline/timeline';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Transport } from '@/components/viewer/transport';
import { Viewer, type Tool, type View, type Zoom } from '@/components/viewer/viewer';
import { jobPercent } from '@/lib/format';
import { clampRange } from '@/lib/selection';
import { usePersistedNumber } from '@/lib/persisted';
import { usePlayerState } from '@/lib/player-hooks';
import { layersOfPlugin, pluginsOfSelection, usePlugins } from '@/lib/plugins';
import { PreviewContext, type PreviewHost } from '@/lib/preview-context';
import { StudioContext } from '@/lib/studio-context';
import { useTheme } from '@/lib/theme';
import { useChat } from '@/lib/use-chat';
import { useTransportKeys } from '@/lib/use-transport-keys';
import { useStudio } from '@/studio';

const DETAILS_KEY = 'kinetograph.studio.timeline.details';
function readDetails(): boolean {
  try {
    return window.localStorage.getItem(DETAILS_KEY) === '1';
  } catch {
    return false;
  }
}
function writeDetails(on: boolean): void {
  try {
    window.localStorage.setItem(DETAILS_KEY, on ? '1' : '0');
  } catch {
    // No storage: the choice lasts until reload.
  }
}

const FIT: View = { zoom: 'fit', pan: { x: 0, y: 0 } };
/** Panel sizes, px: the defaults, the limits, and the height of the folded (slim) timeline. */
const SIDE_DEFAULT = 340;
const SIDE_MIN = 260;
const SIDE_MAX = 620;
const TIMELINE_SLIM = 172;
const TIMELINE_DEFAULT = 340;

/**
 * The layout, and nothing that follows the playhead: the transport, the timeline's playhead and the plugin overlays each
 * subscribe to the player themselves, so a frame ticking by never renders this component.
 */
export function App({ api }: { api: StudioApi }) {
  const studio = useStudio(api);
  const { player, comp } = studio;
  const chat = useChat(studio);
  const [theme, setTheme] = useTheme();
  const [tab, setTab] = useState<InspectorTab>('props');
  const [chatOpen, setChatOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [chatWidth, setChatWidth] = usePersistedNumber('kg.size.chat', SIDE_DEFAULT);
  const [inspectorWidth, setInspectorWidth] = usePersistedNumber('kg.size.inspector', SIDE_DEFAULT);
  const [timelineHeight, setTimelineHeight] = usePersistedNumber('kg.size.timeline', TIMELINE_DEFAULT);
  const [exportOpen, setExportOpen] = useState(false);
  const delivered = useMemo(() => studio.renders.some((job) => job.status === 'done'), [studio.renders]);
  const panelView = usePanelView(studio.panels, delivered);
  const [agents, setAgents] = useState<{ id: string; name: string; command: string }[]>([]);
  const agentCommand = chat.state.command;
  const { loadInfo, chooseAgent, restart } = chat;
  // The agents found on this computer, for the command menu; the first is used when the server has not picked one.
  useEffect(() => {
    let live = true;
    void loadInfo().then((info) => {
      if (live && info) setAgents(info.presets);
    });
    return () => {
      live = false;
    };
  }, [loadInfo]);
  useEffect(() => {
    const first = agents[0];
    if (first && agentCommand === null) chooseAgent(first.command);
  }, [agents]);
  const [details, setDetails] = useState(readDetails);
  const [tool, setTool] = useState<Tool>('select');
  const [view, setView] = useState<View>(FIT);
  const [safeZones, setSafeZones] = useState(false);
  const [guides, setGuides] = useState(true);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [overlayLayer, setOverlayLayer] = useState<HTMLElement | null>(null);
  const frameError = usePlayerState(player, (s) => s.error);

  const zoomTo = useCallback((zoom: Zoom) => setView({ zoom, pan: { x: 0, y: 0 } }), []);
  const openTab = useCallback((next: InspectorTab) => {
    setTab(next);
    setInspectorOpen(true);
  }, []);
  const { selectLayers, selectLayer } = studio;
  const selectedLayers = studio.selectedLayers;
  /** Layers picked in the preview or on the timeline: one, several, or none; shown in the scene tree. */
  const pickLayers = useCallback(
    (ids: string[]) => {
      selectLayers(ids);
      if (ids.length > 0) openTab('scene');
    },
    [selectLayers, openTab],
  );
  const pickLayer = useCallback(
    (id: string | null, additive?: boolean) =>
      id !== null && additive
        ? selectLayers(selectedLayers.includes(id) ? selectedLayers.filter((l) => l !== id) : [...selectedLayers, id])
        : selectLayer(id),
    [selectLayers, selectLayer, selectedLayers],
  );
  const { selectedRange, selectRange } = studio;
  const range = useMemo(() => clampRange(selectedRange, comp?.durationInFrames ?? 0), [selectedRange, comp?.durationInFrames]);
  const plugins = usePlugins(api);
  /** The plugin whose card was clicked; the plugins that drew the selected layers count as selected too. */
  const [focusedPlugin, setFocusedPlugin] = useState<string | null>(null);
  const layerPlugins = useMemo(() => pluginsOfSelection(plugins, studio.inspect, selectedLayers), [plugins, studio.inspect, selectedLayers]);
  const selectedPlugins = useMemo<ReadonlySet<string>>(() => new Set(focusedPlugin ? [...layerPlugins, focusedPlugin] : layerPlugins), [layerPlugins, focusedPlugin]);
  useEffect(() => {
    if (focusedPlugin !== null && selectedLayers.length > 0 && !layerPlugins.includes(focusedPlugin)) setFocusedPlugin(null);
  }, [selectedLayers, layerPlugins, focusedPlugin]);
  /** Clicking a plugin's card selects it and the layers it draws; clicking it again lets go. */
  const selectPlugin = useCallback(
    (name: string) => {
      const plugin = plugins.find((p) => p.name === name);
      if (!plugin) return;
      if (selectedPlugins.has(name)) {
        setFocusedPlugin(null);
        selectLayers(layerPlugins.includes(name) ? [] : selectedLayers);
        return;
      }
      setFocusedPlugin(name);
      selectLayers(layersOfPlugin(plugin, studio.inspect));
    },
    [plugins, selectedPlugins, layerPlugins, selectedLayers, selectLayers, studio.inspect],
  );
  const [agentDraft, setAgentDraft] = useState<{ text: string; id: number } | null>(null);
  /** Opens the agent with a message typed for the user to send. */
  const askAgent = useCallback((text: string) => {
    setChatOpen(true);
    setAgentDraft((previous) => ({ text, id: (previous?.id ?? 0) + 1 }));
  }, []);
  const toggleDetails = useCallback((next?: boolean) => {
    setDetails((on) => {
      const value = typeof next === 'boolean' ? next : !on;
      writeDetails(value);
      return value;
    });
  }, []);

  useTransportKeys(player, {
    v: () => setTool('select'),
    h: () => setTool('hand'),
    z: () => setTool('zoom'),
    '0': () => zoomTo('fit'),
    '1': () => zoomTo(1),
    Escape: () => {
      selectRange(null);
      selectLayers([]);
      setFocusedPlugin(null);
    },
    m: () => studio.audio.setMuted(!studio.audio.getState().muted),
    '?': () => setShortcutsOpen(true),
  });

  const toggleChat = useCallback(() => setChatOpen((v) => !v), []);
  const toggleInspector = useCallback(() => setInspectorOpen((v) => !v), []);
  const toggleTimeline = useCallback(() => setTimelineOpen((v) => !v), []);
  const toggleSafeZones = useCallback(() => setSafeZones((v) => !v), []);
  const toggleGuides = useCallback(() => setGuides((v) => !v), []);
  const exportNow = useCallback(() => setExportOpen(true), []);
  const showRenders = useCallback(() => openTab('renders'), [openTab]);
  const startExport = useCallback(
    async (request: Parameters<typeof studio.startRender>[0]) => {
      await studio.startRender(request);
      openTab('renders');
    },
    [studio.startRender, openTab],
  );
  const exporting = useMemo(() => {
    const active = studio.renders.filter((job) => job.status === 'queued' || job.status === 'running');
    if (active.length === 0) return null;
    const running = active.find((job) => job.status === 'running') ?? active[0]!;
    return { count: active.length, percent: Math.round(jobPercent(running)) };
  }, [studio.renders]);
  /** Dragging the timeline's top edge: small folds it to the scrubber, larger opens the rows at that height. */
  const resizeTimeline = useCallback(
    (height: number) => {
      if (height < TIMELINE_SLIM + 40) setTimelineOpen(false);
      else {
        setTimelineOpen(true);
        setTimelineHeight(height);
      }
    },
    [setTimelineHeight],
  );
  const maxSide = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(window.innerWidth * 0.4)));
  const maxTimeline = Math.max(TIMELINE_DEFAULT, Math.round(window.innerHeight * 0.7));
  const showShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const onDetailsChange = useCallback((next: boolean) => toggleDetails(next), [toggleDetails]);
  const toggleDetailsOnly = useCallback(() => toggleDetails(), [toggleDetails]);

  const timelineData = studio.timeline.state === 'ready' ? studio.timeline.data : null;
  /** Where the top-level Sequences start and end: the progress bar is split there. */
  const edges = useMemo(() => {
    const set = new Set<number>();
    for (const s of timelineData?.sequences ?? []) {
      if (s.parent !== null) continue;
      set.add(s.from);
      set.add(s.from + s.durationInFrames);
    }
    return [...set].sort((x, y) => x - y);
  }, [timelineData]);
  const preview = useMemo<PreviewHost>(
    () => ({ layer: overlayLayer, width: comp?.width ?? 0, height: comp?.height ?? 0, player }),
    [overlayLayer, comp?.width, comp?.height, player],
  );

  return (
    <StudioContext.Provider value={studio}>
    <TooltipProvider delay={500}>
      <div className="text-foreground flex h-screen flex-col gap-3 overflow-hidden p-3">
        <TopBar
          project={studio.project}
          buildId={studio.buildId}
          connected={studio.connected}
          compositions={studio.compositions}
          comp={comp}
          onSelectComp={studio.selectComp}
          theme={theme}
          onTheme={setTheme}
          chatOpen={chatOpen}
          onToggleChat={toggleChat}
          inspectorOpen={inspectorOpen}
          onToggleInspector={toggleInspector}
          onExport={exportNow}
          exporting={exporting}
          onShowRenders={showRenders}
          launcher={
            <CommandMenu
              compositions={studio.compositions}
              comp={comp}
              player={player}
              theme={theme}
              onTheme={setTheme}
              onSelectComp={studio.selectComp}
              onZoom={zoomTo}
              onTool={setTool}
              onToggleSafeZones={toggleSafeZones}
              onToggleGuides={toggleGuides}
              onToggleChat={toggleChat}
              onToggleInspector={toggleInspector}
              onToggleTimeline={toggleTimeline}
              onToggleDetails={toggleDetailsOnly}
              onInspectorTab={openTab}
              onExport={exportNow}
              onReload={studio.reload}
              onShowShortcuts={showShortcuts}
              agents={agents}
              agentCommand={agentCommand}
              onSelectAgent={chooseAgent}
              onRestartAgent={restart}
            />
          }
        />

        <div className="flex min-h-0 flex-1">
          {chatOpen && (
            <Panel className="shrink-0" style={{ width: chatWidth }} aria-label="Agent">
              <AgentPanel
                comp={comp}
                project={studio.project}
                inspect={studio.inspect}
                selectedLayers={studio.selectedLayers}
                selectLayers={studio.selectLayers}
                range={range}
                onClearRange={() => selectRange(null)}
                thumbnailFrameUrl={studio.frameUrl}
                lastImage={studio.lastImage}
                chat={chat}
                timeline={timelineData}
                plugins={plugins}
                draft={agentDraft}
              />
            </Panel>
          )}
          {chatOpen && (
            <ResizeHandle orientation="vertical" label="Resize the agent" size={chatWidth} direction={1} min={SIDE_MIN} max={maxSide} onResize={setChatWidth} onReset={() => setChatWidth(SIDE_DEFAULT)} />
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1">
              <Panel className="min-w-0 flex-1" aria-label="Preview">
                <Viewer
                  comp={comp}
                  onImage={studio.onImage}
                  lastImage={studio.lastImage}
                  buildError={studio.buildError}
                  frameError={frameError}
                  inspect={studio.inspect}
                  selectedLayers={studio.selectedLayers}
                  tool={tool}
                  onToolChange={setTool}
                  view={view}
                  onViewChange={setView}
                  safeZones={safeZones}
                  onSafeZonesChange={setSafeZones}
                  guides={guides}
                  onGuidesChange={setGuides}
                  onOverlayHost={setOverlayLayer}
                  onSelectLayers={pickLayers}
                />
                <div className="pointer-events-none absolute inset-x-4 bottom-4 flex justify-center">
                  <Transport comp={comp} player={player} audio={studio.audio} edges={edges} className="pointer-events-auto w-full max-w-3xl" />
                </div>
                {panelView.active && (
                  <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center">
                    <PanelStepper stages={panelView.stages} shown={panelView.shown?.id ?? null} onSelect={panelView.select} onDeliver={exportNow} />
                  </div>
                )}
                {panelView.shown && panelView.shown.panel !== 'review' && (
                  <PanelSheet panel={panelView.shown} error={studio.panelErrors[panelView.shown.id]} onSubmit={studio.submitPanel} onDismiss={studio.dismissPanel} onHide={panelView.hide} />
                )}
              </Panel>
              {panelView.shown?.panel === 'review' && (
                <PanelDock panel={panelView.shown} error={studio.panelErrors[panelView.shown.id]} onSubmit={studio.submitPanel} onDismiss={studio.dismissPanel} onHide={panelView.hide} />
              )}
            </div>
            <ResizeHandle
              orientation="horizontal"
              label="Resize the timeline"
              size={timelineOpen ? timelineHeight : TIMELINE_SLIM}
              direction={-1}
              min={TIMELINE_SLIM}
              max={maxTimeline}
              onResize={resizeTimeline}
              onReset={() => setTimelineOpen((open) => !open)}
            />
            <Panel className="shrink-0" style={{ height: timelineOpen ? Math.min(timelineHeight, maxTimeline) : TIMELINE_SLIM }} aria-label="Timeline">
              <Timeline
                comp={comp}
                status={studio.timeline}
                player={player}
                selectedLayers={studio.selectedLayers}
                onSelectLayers={pickLayers}
                selectedRange={range}
                onSelectRange={selectRange}
                thumbnailUrl={studio.thumbnailUrl}
                waveform={studio.waveform}
                expanded={timelineOpen}
                onExpandedChange={setTimelineOpen}
                details={details}
                onDetailsChange={onDetailsChange}
              />
            </Panel>
          </div>

          {inspectorOpen && (
            <ResizeHandle orientation="vertical" label="Resize the inspector" size={inspectorWidth} direction={-1} min={SIDE_MIN} max={maxSide} onResize={setInspectorWidth} onReset={() => setInspectorWidth(SIDE_DEFAULT)} />
          )}
          {inspectorOpen && (
            <Panel className="shrink-0" style={{ width: inspectorWidth }} aria-label="Inspector">
              <PreviewContext.Provider value={preview}>
                <InspectorPanel
                  api={api}
                  tab={tab}
                  onTabChange={setTab}
                  comp={comp}
                  inspect={studio.inspect}
                  project={studio.project}
                  timeline={timelineData}
                  selectedLayer={studio.selectedLayer}
                  selectedLayers={studio.selectedLayers}
                  onSelectLayers={pickLayers}
                  onSelectLayer={pickLayer}
                  propValues={studio.propValues}
                  propsEdited={studio.propsOverride !== undefined}
                  onChangeProps={studio.setPropValues}
                  onResetProps={studio.resetProps}
                  renders={studio.renders}
                  onNewRender={exportNow}
                  onCancelRender={studio.cancelRender}
                  plugins={plugins}
                  selectedPlugins={selectedPlugins}
                  onSelectPlugin={selectPlugin}
                  onAskAgent={askAgent}
                />
              </PreviewContext.Provider>
            </Panel>
          )}
        </div>

        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <ExportDialog open={exportOpen} onOpenChange={setExportOpen} comp={comp} propsEdited={studio.propsOverride !== undefined} player={player} thumbnailUrl={studio.thumbnailUrl} onStart={startExport} />
      </div>
    </TooltipProvider>
    </StudioContext.Provider>
  );
}
