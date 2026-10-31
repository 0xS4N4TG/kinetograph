import {
  BotIcon,
  ChevronFirstIcon,
  ChevronLastIcon,
  ClapperboardIcon,
  CrosshairIcon,
  FrameIcon,
  GridIcon,
  HandIcon,
  KeyboardIcon,
  LayersIcon,
  ListVideoIcon,
  MaximizeIcon,
  MessageSquareIcon,
  MonitorIcon,
  MousePointerIcon,
  MoonIcon,
  PlayIcon,
  RefreshCwIcon,
  RepeatIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SlidersHorizontalIcon,
  SunIcon,
  DownloadIcon,
  ZoomInIcon,
} from 'lucide-react';
import { memo, useMemo } from 'react';

import type { CompositionInfo } from '@/api';
import { Launcher, type LauncherAction, type LauncherPage } from '@/components/command/launcher';
import type { Tool } from '@/components/viewer/viewer';
import type { Zoom } from '@/components/viewer/viewer';
import type { Player } from '@/lib/player';
import type { Theme } from '@/lib/theme';

export interface CommandMenuProps {
  compositions: CompositionInfo[];
  comp: CompositionInfo | null;
  player: Player;
  theme: Theme;
  onTheme(theme: Theme): void;
  onSelectComp(id: string): void;
  onZoom(zoom: Zoom): void;
  onTool(tool: Tool): void;
  onToggleSafeZones(): void;
  onToggleGuides(): void;
  onToggleChat(): void;
  onToggleInspector(): void;
  onToggleTimeline(): void;
  onToggleDetails(): void;
  onInspectorTab(tab: 'props' | 'scene' | 'renders'): void;
  onExport(): void;
  onReload(): void;
  onShowShortcuts(): void;
  /** The coding agents found on this computer, and the one in use. */
  agents: { id: string; name: string; command: string }[];
  agentCommand: string | null;
  onSelectAgent(command: string): void;
  onRestartAgent(): void;
}

/**
 * Cmd+K: every action the old menu bar had (File, Composition, View, Playback, Window, Help), plus the panels and the
 * theme. The keyboard shortcuts are shown beside the actions that have one.
 */
export const CommandMenu = memo(function CommandMenu(p: CommandMenuProps) {
  const { compositions, comp, player, theme } = p;
  const has = comp !== null;
  const { actions, pages } = useMemo(() => {
    const last = () => Math.max(0, (player.getState().comp?.durationInFrames ?? 1) - 1);
    const actions: LauncherAction[] = [
      { id: 'export', label: 'Export or render', group: 'File', icon: <DownloadIcon />, keywords: ['render', 'queue'], onSelect: p.onExport },
      { id: 'reload', label: 'Reload the project', group: 'File', icon: <RefreshCwIcon />, onSelect: p.onReload },
      { id: 'composition', label: 'Go to composition', group: 'Composition', icon: <ClapperboardIcon />, page: 'compositions', keywords: ['switch', 'select'] },
      { id: 'play', label: 'Play or pause', group: 'Playback', icon: <PlayIcon />, shortcut: ['Space'], onSelect: () => player.toggle() },
      { id: 'start', label: 'Go to the first frame', group: 'Playback', icon: <ChevronFirstIcon />, shortcut: ['Home'], onSelect: () => player.seek(0) },
      { id: 'end', label: 'Go to the last frame', group: 'Playback', icon: <ChevronLastIcon />, shortcut: ['End'], onSelect: () => player.seek(last()) },
      { id: 'back', label: 'Step back one frame', group: 'Playback', icon: <SkipBackIcon />, shortcut: ['←'], onSelect: () => player.step(-1) },
      { id: 'forward', label: 'Step forward one frame', group: 'Playback', icon: <SkipForwardIcon />, shortcut: ['→'], onSelect: () => player.step(1) },
      { id: 'loop', label: 'Loop on or off', group: 'Playback', icon: <RepeatIcon />, shortcut: ['L'], onSelect: () => player.setLoop(!player.getState().loop) },
      { id: 'fit', label: 'Fit the frame to the preview', group: 'View', icon: <MaximizeIcon />, shortcut: ['0'], onSelect: () => p.onZoom('fit') },
      { id: 'zoom100', label: 'Show the frame at 100%', group: 'View', icon: <FrameIcon />, shortcut: ['1'], onSelect: () => p.onZoom(1) },
      { id: 'safe', label: 'Safe zones on or off', group: 'View', icon: <GridIcon />, onSelect: p.onToggleSafeZones },
      { id: 'guides', label: 'Layer controls on or off', group: 'View', icon: <CrosshairIcon />, onSelect: p.onToggleGuides },
      { id: 'tool-select', label: 'Selection tool', group: 'Tools', icon: <MousePointerIcon />, shortcut: ['V'], onSelect: () => p.onTool('select') },
      { id: 'tool-hand', label: 'Hand tool', group: 'Tools', icon: <HandIcon />, shortcut: ['H'], onSelect: () => p.onTool('hand') },
      { id: 'tool-zoom', label: 'Zoom tool', group: 'Tools', icon: <ZoomInIcon />, shortcut: ['Z'], onSelect: () => p.onTool('zoom') },
      { id: 'tab-props', label: 'Open Props', group: 'Window', icon: <SlidersHorizontalIcon />, onSelect: () => p.onInspectorTab('props') },
      { id: 'tab-scene', label: 'Open the scene tree', group: 'Window', icon: <LayersIcon />, onSelect: () => p.onInspectorTab('scene') },
      { id: 'tab-renders', label: 'Open the render queue', group: 'Window', icon: <ListVideoIcon />, onSelect: () => p.onInspectorTab('renders') },
      { id: 'chat', label: 'Show or hide the agent', group: 'Window', icon: <MessageSquareIcon />, onSelect: p.onToggleChat },
      { id: 'inspector', label: 'Show or hide the inspector', group: 'Window', icon: <SlidersHorizontalIcon />, onSelect: p.onToggleInspector },
      { id: 'timeline', label: 'Expand or fold the timeline', group: 'Window', icon: <ListVideoIcon />, onSelect: p.onToggleTimeline },
      { id: 'details', label: 'Timeline details on or off', group: 'Window', icon: <MonitorIcon />, onSelect: p.onToggleDetails },
      {
        id: 'theme',
        label: theme === 'dark' ? 'Use the light theme' : 'Use the dark theme',
        group: 'Window',
        icon: theme === 'dark' ? <SunIcon /> : <MoonIcon />,
        onSelect: () => p.onTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      { id: 'agent-switch', label: 'Switch agent', group: 'Agent', icon: <BotIcon />, page: 'agents', keywords: ['coding agent', 'claude', 'codex'] },
      { id: 'agent-restart', label: 'Restart agent', group: 'Agent', icon: <RefreshCwIcon />, keywords: ['new chat', 'clear'], onSelect: p.onRestartAgent },
      { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Help', icon: <KeyboardIcon />, shortcut: ['?'], onSelect: p.onShowShortcuts },
    ];
    const pages: Record<string, LauncherPage> = {
      agents: {
        title: 'Agent',
        placeholder: 'Pick a coding agent',
        actions: p.agents.map((a) => ({ id: `agent-${a.id}`, label: a.command === p.agentCommand ? `${a.name} (in use)` : a.name, icon: <BotIcon />, onSelect: () => p.onSelectAgent(a.command) })),
      },
      compositions: {
        title: 'Composition',
        placeholder: 'Pick a composition',
        actions: compositions.map((c) => ({
          id: `comp-${c.id}`,
          label: c.id,
          icon: <ClapperboardIcon />,
          keywords: [`${c.width}x${c.height}`],
          onSelect: () => p.onSelectComp(c.id),
        })),
      },
    };
    return { actions: has ? actions : actions.filter((a) => ['reload', 'theme', 'shortcuts', 'tab-props', 'tab-scene', 'tab-renders', 'chat', 'inspector', 'composition', 'agent-switch', 'agent-restart'].includes(a.id)), pages };
    // The handlers are stable (or read what they need when run).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositions, has, theme, player, p.agents, p.agentCommand, p.onSelectAgent, p.onRestartAgent, p.onTheme, p.onSelectComp, p.onZoom, p.onTool, p.onExport, p.onReload]);

  return <Launcher actions={actions} pages={pages} triggerLabel="Search or run a command" placeholder="Type a command or search" />;
});
