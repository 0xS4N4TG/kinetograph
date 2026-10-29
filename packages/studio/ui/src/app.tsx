import { useCallback, useMemo, useState } from 'react';
import { MessageSquareIcon } from 'lucide-react';

import type { StudioApi } from '@/api';
import { AgentPanel } from '@/components/agent/agent-panel';
import { CommandMenu } from '@/components/command/command-menu';
import { InspectorPanel, type InspectorTab } from '@/components/inspector/inspector-panel';
import { Panel } from '@/components/shell/panel';
import { ShortcutsDialog } from '@/components/shell/shortcuts-dialog';
import { TopBar } from '@/components/shell/top-bar';
import { Timeline } from '@/components/timeline/timeline';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Transport } from '@/components/viewer/transport';
import { Viewer, type Tool, type View, type Zoom } from '@/components/viewer/viewer';
import { usePlayerState } from '@/lib/player-hooks';
import { PreviewContext, type PreviewHost } from '@/lib/preview-context';
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
    '?': () => setShortcutsOpen(true),
  });

  const toggleChat = useCallback(() => setChatOpen((v) => !v), []);
  const toggleInspector = useCallback(() => setInspectorOpen((v) => !v), []);
  const toggleTimeline = useCallback(() => setTimelineOpen((v) => !v), []);
  const toggleSafeZones = useCallback(() => setSafeZones((v) => !v), []);
  const toggleGuides = useCallback(() => setGuides((v) => !v), []);
  const exportNow = useCallback(() => openTab('renders'), [openTab]);
  const showShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const onDetailsChange = useCallback((next: boolean) => toggleDetails(next), [toggleDetails]);
  const toggleDetailsOnly = useCallback(() => toggleDetails(), [toggleDetails]);

  const timelineData = studio.timeline.state === 'ready' ? studio.timeline.data : null;
  const preview = useMemo<PreviewHost>(
    () => ({ layer: overlayLayer, width: comp?.width ?? 0, height: comp?.height ?? 0, player }),
    [overlayLayer, comp?.width, comp?.height, player],
  );

  return (
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
            />
          }
        />

        <div className="flex min-h-0 flex-1 gap-3">
          {chatOpen ? (
            <Panel className="w-[340px] shrink-0 2xl:w-[380px]" aria-label="Agent">
              <AgentPanel
                comp={comp}
                project={studio.project}
                inspect={studio.inspect}
                selectedLayers={studio.selectedLayers}
                selectLayers={studio.selectLayers}
                lastImage={studio.lastImage}
                chat={chat}
                timeline={timelineData}
              />
            </Panel>
          ) : (
            <Button variant="outline" size="icon-lg" aria-label="Show the agent" onClick={toggleChat} className="bg-card shrink-0 self-start rounded-full">
              <MessageSquareIcon />
            </Button>
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <Panel className="flex-1" aria-label="Preview">
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
              <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
                <Transport comp={comp} player={player} className="pointer-events-auto" />
              </div>
            </Panel>
            <Panel className="shrink-0 transition-[height] duration-200" style={{ height: timelineOpen ? 'clamp(280px, 40vh, 460px)' : 128 }} aria-label="Timeline">
              <Timeline
                comp={comp}
                status={studio.timeline}
                player={player}
                selectedLayers={studio.selectedLayers}
                onSelectLayers={pickLayers}
                thumbnailUrl={studio.thumbnailUrl}
                expanded={timelineOpen}
                onExpandedChange={setTimelineOpen}
                details={details}
                onDetailsChange={onDetailsChange}
              />
            </Panel>
          </div>

          {inspectorOpen && (
            <Panel className="w-[340px] shrink-0 2xl:w-[380px]" aria-label="Inspector">
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
                  onStartRender={studio.startRender}
                  onCancelRender={studio.cancelRender}
                />
              </PreviewContext.Provider>
            </Panel>
          )}
        </div>

        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </TooltipProvider>
  );
}
