// The studio's state: what the server told us, what the user chose, and the player. One hook so `App` is layout only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { readStored, writeStored } from '@/lib/persisted';

import {
  ApiError,
  type AgentClientMessage,
  type AgentEvent,
  type ChatRecord,
  type CompositionInfo,
  type OpenPanel,
  type PanelAnswer,
  type PanelKind,
  type InspectResult,
  type ProjectInfo,
  type ReceivedFrame,
  type RenderJob,
  type RenderRequest,
  type ServerMessage,
  type StudioApi,
  type StudioError,
  type StudioSocket,
  type TimelineData,
  type Waveform,
} from '@/api';
import { PreviewAudio } from '@/lib/audio';
import { findLayer } from '@/lib/inspect';
import { numberByParent, numberTree } from '@/lib/names';
import { Player } from '@/lib/player';
import { layerName, remapSelection, type FrameRange } from '@/lib/selection';

function toStudioError(error: unknown): StudioError {
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  return { code: 'IO', message: error instanceof Error ? error.message : String(error) };
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function upsertJob(jobs: RenderJob[], job: RenderJob): RenderJob[] {
  const index = jobs.findIndex((j) => j.id === job.id);
  if (index < 0) return [...jobs, job];
  const next = jobs.slice();
  next[index] = job;
  return next;
}

/** `panel` in place of the one with its id, or added; one dismissed (replaced by a newer one) is dropped. */
function upsertPanel(panels: OpenPanel[], panel: OpenPanel): OpenPanel[] {
  const rest = panels.filter((p) => p.id !== panel.id);
  return panel.status === 'dismissed' ? rest : [...rest, panel].sort((a, b) => a.openedAt - b.openedAt);
}

/** What the timeline has to show: the sweep is slow on a long film, so loading and failing are states of their own. */
export type TimelineStatus =
  | { state: 'loading'; done: number; total: number }
  // `refreshing`: the timeline on show is of the props or build before the last change, and a newer one is being read.
  | { state: 'ready'; data: TimelineData; refreshing: { done: number; total: number } | null }
  | { state: 'error'; error: StudioError };

export interface Studio {
  project: ProjectInfo | null;
  connected: boolean;
  compositions: CompositionInfo[];
  comp: CompositionInfo | null;
  selectComp(id: string): void;
  /** Fetches the project, compositions, timeline, scene and frame again. */
  reload(): void;
  buildId: number;
  buildError: StudioError | null;

  /** The player is not a React subscription here: the views that follow the frame read it with `usePlayerState`. */
  player: Player;
  /** Calls `listener` with each frame to show, and returns how to stop. */
  onImage(listener: (frame: ReceivedFrame) => void): () => void;
  /** The last frame handed to listeners, for a view that mounts later. */
  lastImage(): ReceivedFrame | null;

  /** The props shown in the form: the edits over the defaults. */
  propValues: Record<string, unknown>;
  /** Sent with frame requests and renders; undefined while nothing differs from the defaults. */
  propsOverride: Record<string, unknown> | undefined;
  setPropValues(values: Record<string, unknown>): void;
  resetProps(): void;

  timeline: TimelineStatus;
  /** The preview's sound: whether the composition has any, and the mute switch. */
  audio: PreviewAudio;
  /** Peaks of one audio clip of the timeline (or of the whole mix) in `buckets` slices. */
  waveform(clip: string | undefined, buckets: number): Promise<Waveform>;
  inspect: InspectResult | null;
  /** The layers picked in the preview, the scene tree or the timeline, in the order they were picked. */
  selectedLayers: string[];
  /** The first of `selectedLayers`, the one the details are shown for. */
  selectedLayer: string | null;
  selectLayer(id: string | null): void;
  selectLayers(ids: string[]): void;
  /** The span of time picked on the timeline (frames, both ends inside it), or null. */
  selectedRange: FrameRange | null;
  selectRange(range: FrameRange | null): void;

  /** Calls `listener` with each event of the coding agent, and returns how to stop. */
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  /** The address of a small picture of `frame` of the composition, for the timeline's clips; null without one. */
  thumbnailUrl(frame: number, height: number): string | null;
  /** The address of a frame as a JPEG at `scale` of the composition's size; null without a composition. */
  frameUrl(frame: number, scale: number): string | null;
  /** The conversation so far, sent when this window takes it over after a reload. */
  onAgentHistory(listener: (items: ChatRecord[]) => void): () => void;
  /** Sends a message to the coding agent; false when the connection is down. */
  sendAgent(message: AgentClientMessage): boolean;
  agentInfo(): ReturnType<StudioApi['agentInfo']>;

  /** The panels the agent opened that are open, and the ones submitted (for the stepper), oldest first. */
  panels: OpenPanel[];
  /** Why the server refused the last answer to a panel, by panel id. */
  panelErrors: Record<string, string>;
  /** Sends the person's answer; the panel closes when the server confirms. False when the connection is down. */
  submitPanel(id: string, answer: PanelAnswer[PanelKind]): boolean;
  dismissPanel(id: string): boolean;

  renders: RenderJob[];
  startRender(request: Omit<RenderRequest, 'comp' | 'props'>): Promise<RenderJob>;
  cancelRender(id: string): Promise<void>;
}

const INSPECT_DELAY_MS = 80;
/** A change of props is read again this long after the last one, ms. */
const TIMELINE_DELAY_MS = 250;
const TIMELINE_POLL_MS = 400;

export function useStudio(api: StudioApi): Studio {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [compositions, setCompositions] = useState<CompositionInfo[]>([]);
  const [compId, setCompId] = useState<string | null>(null);
  const [buildId, setBuildId] = useState(0);
  const [buildError, setBuildError] = useState<StudioError | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  // The edited props survive a reload: kept per project in the browser, restored once the project is known.
  const editsKey = project ? `kg.props:${project.entry}` : null;
  const editsRestored = useRef<string | null>(null);
  const skipWrite = useRef(false);
  useEffect(() => {
    if (!editsKey || editsRestored.current === editsKey) return;
    editsRestored.current = editsKey;
    const stored = readStored(editsKey);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      skipWrite.current = true;
      setEdits((all) => ({ ...(stored as Record<string, Record<string, unknown>>), ...all }));
    }
  }, [editsKey]);
  useEffect(() => {
    if (!editsKey || editsRestored.current !== editsKey) return;
    if (skipWrite.current) {
      skipWrite.current = false;
      return;
    }
    writeStored(editsKey, Object.keys(edits).length > 0 ? edits : undefined);
  }, [editsKey, edits]);
  const [timeline, setTimeline] = useState<TimelineStatus>({ state: 'loading', done: 0, total: 0 });
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [selectedLayers, setSelectedLayers] = useState<string[]>([]);
  const selectedLayer = selectedLayers[0] ?? null;
  const selectLayer = useCallback((id: string | null) => setSelectedLayers(id === null ? [] : [id]), []);
  const selectLayers = useCallback((ids: string[]) => setSelectedLayers(ids), []);
  const [selectedRange, selectRange] = useState<FrameRange | null>(null);
  /** The names the selected layers had, to find them again when the project is rebuilt and their ids moved. */
  const selectedNames = useRef(new Map<string, string>());
  const selectedRef = useRef<string[]>([]);
  selectedRef.current = selectedLayers;
  const rebuilt = useRef(false);
  const agentListeners = useRef(new Set<(event: AgentEvent) => void>());
  const historyListeners = useRef(new Set<(items: ChatRecord[]) => void>());
  const [renders, setRenders] = useState<RenderJob[]>([]);
  const [panels, setPanels] = useState<OpenPanel[]>([]);
  const [panelErrors, setPanelErrors] = useState<Record<string, string>>({});
  /** Bumped by every `reload`: what the timeline and the scene tree show is from the old build. */
  const [reloads, setReloads] = useState(0);

  // ---- the player and its socket ----

  const socketRef = useRef<StudioSocket | null>(null);
  const imageListeners = useRef(new Set<(frame: ReceivedFrame) => void>());
  const lastImageRef = useRef<ReceivedFrame | null>(null);
  const playerRef = useRef<Player | null>(null);
  const audioRef = useRef<PreviewAudio | null>(null);
  audioRef.current ??= new PreviewAudio();
  const audio = audioRef.current;
  if (playerRef.current === null) {
    playerRef.current = new Player({
      audio,
      requestFrame: (args) => socketRef.current?.requestFrame(args) ?? -1,
      onImage: (frame) => {
        lastImageRef.current = frame;
        for (const listener of imageListeners.current) listener(frame);
      },
    });
  }
  const player = playerRef.current;

  const onImage = useCallback((listener: (frame: ReceivedFrame) => void) => {
    imageListeners.current.add(listener);
    return () => {
      imageListeners.current.delete(listener);
    };
  }, []);
  const lastImage = useCallback(() => lastImageRef.current, []);

  // ---- data from the server ----

  const compIdRef = useRef(compId);
  compIdRef.current = compId;
  const buildIdRef = useRef(0);

  const loadCompositions = useCallback(async () => {
    let list: CompositionInfo[];
    try {
      list = await api.compositions();
    } catch {
      // no good build yet (409): the build error explains
      list = [];
    }
    setCompositions(list);
    setCompId((current) => (list.some((c) => c.id === current) ? current : (list[0]?.id ?? null)));
  }, [api]);

  /** Fetches everything again from the server; the selection and the props stay. */
  const refresh = useCallback(() => {
    rebuilt.current = true;
    setReloads((n) => n + 1);
    void loadCompositions();
    api.project().then(setProject, () => {});
    player.reload();
  }, [api, loadCompositions, player]);

  useEffect(() => {
    let cancelled = false;
    // A new build: everything fetched from the old one is stale.
    const rebuilt = (id: number) => {
      buildIdRef.current = id;
      setBuildId(id);
      refresh();
    };
    const handle = (message: ServerMessage) => {
      switch (message.type) {
        case 'hello':
          // The server sends the panels it keeps right after: start from nothing so that one closed meanwhile goes.
          setPanels([]);
          setBuildError(message.buildError);
          // (re)connected to a server that has built since: same as a reload we missed
          if (buildIdRef.current !== 0 && buildIdRef.current !== message.buildId) rebuilt(message.buildId);
          else {
            buildIdRef.current = message.buildId;
            setBuildId(message.buildId);
          }
          break;
        case 'reload':
          setBuildError(null);
          rebuilt(message.buildId);
          break;
        case 'buildError':
          setBuildError(message.error);
          break;
        case 'render':
          setRenders((jobs) => upsertJob(jobs, message.job));
          break;
        case 'props':
          // Pushed by the agent: show that composition with these props (Reset still goes back to the defaults).
          if (compIdRef.current !== message.comp) {
            setCompId(message.comp);
            setSelectedLayers([]);
          }
          setEdits((all) => ({ ...all, [message.comp]: message.props }));
          break;
        case 'agent':
          for (const listener of agentListeners.current) listener(message.event);
          break;
        case 'agent.history':
          for (const listener of historyListeners.current) listener(message.items);
          break;
        case 'panel':
        case 'panel.closed':
          setPanels((all) => upsertPanel(all, message.panel));
          setPanelErrors(({ [message.panel.id]: _gone, ...rest }) => rest);
          break;
        case 'panel.error':
          setPanelErrors((all) => ({ ...all, [message.id]: message.message }));
          break;
        case 'error':
          player.handleError(message.requestId, message.error);
          break;
      }
    };
    socketRef.current = api.connect({
      onMessage: handle,
      onFrame: (frame) => player.handleFrame(frame),
      onConnection: (open) => {
        setConnected(open);
        player.handleConnection(open);
      },
    });

    void (async () => {
      const [info, jobs] = await Promise.all([api.project().catch(() => null), api.renders().catch(() => [])]);
      if (cancelled) return;
      if (info) {
        setProject(info);
        buildIdRef.current = info.buildId;
        setBuildId(info.buildId);
        setBuildError(info.buildError);
      }
      setRenders(jobs);
      await loadCompositions();
    })();

    return () => {
      cancelled = true;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [api, player, loadCompositions, refresh]);

  // ---- the selected composition and its props ----

  const comp = useMemo(() => compositions.find((c) => c.id === compId) ?? null, [compositions, compId]);
  const edited = comp ? edits[comp.id] : undefined;
  const propValues = useMemo(() => edited ?? comp?.defaultProps ?? {}, [edited, comp?.defaultProps]);
  const propsOverride = useMemo(
    () => (comp && edited && !sameJson(edited, comp.defaultProps) ? edited : undefined),
    [comp, edited],
  );
  const overrideKey = JSON.stringify(propsOverride ?? null);

  const setPropValues = useCallback(
    (values: Record<string, unknown>) => {
      const id = compIdRef.current;
      if (id !== null) setEdits((all) => ({ ...all, [id]: values }));
    },
    [],
  );
  const resetProps = useCallback(() => {
    const id = compIdRef.current;
    if (id === null) return;
    setEdits((all) => {
      const { [id]: _removed, ...rest } = all;
      return rest;
    });
  }, []);

  const selectComp = useCallback((id: string) => {
    setCompId(id);
    selectRange(null);
    setSelectedLayers([]);
  }, []);

  // The server is told what is previewed, for the agent to read; again when the socket comes back.
  useEffect(() => {
    if (connected && comp) socketRef.current?.sendProps(comp.id, propValues);
  }, [connected, comp?.id, propValues]);

  // `comp` is a new object after each refetch; the player only acts when what it shows changed.
  useEffect(() => {
    player.setComposition(comp, propsOverride);
  }, [player, comp, overrideKey]);

  // ---- timeline and scene tree ----

  // The timeline on show stays until the next one arrives (a prop edit does not blank it); a thin line tracks the reading.
  useEffect(() => {
    if (!comp) {
      setTimeline({ state: 'loading', done: 0, total: 0 });
      return;
    }
    setTimeline((s) => (s.state === 'ready' && s.data.comp === comp.id ? { ...s, refreshing: s.refreshing ?? { done: 0, total: 0 } } : { state: 'loading', done: 0, total: 0 }));
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(() => {
      // The request answers only when the whole film has been read: meanwhile, ask how far it has got.
      poll = setInterval(() => {
        api.timelineProgress(comp.id, propsOverride).then(
          ({ done, total }) =>
            !cancelled &&
            setTimeline((s) => (s.state === 'loading' ? { state: 'loading', done, total } : s.state === 'ready' && s.refreshing ? { ...s, refreshing: { done, total } } : s)),
          () => {},
        );
      }, TIMELINE_POLL_MS);
      api.timeline(comp.id, propsOverride).then(
        (raw) => {
          if (cancelled) return;
          // Same-name siblings are numbered ("Card 2") once, here, for every view that names them.
          const data = { ...raw, layers: numberByParent(raw.layers) };
          // The same timeline as the one on show is not a new one: its rows are not drawn again.
          setTimeline((s) => (s.state === 'ready' && sameJson(s.data, data) ? (s.refreshing ? { ...s, refreshing: null } : s) : { state: 'ready', data, refreshing: null }));
        },
        (error: unknown) => !cancelled && setTimeline({ state: 'error', error: toStudioError(error) }),
      );
    }, TIMELINE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, [api, comp?.id, comp?.durationInFrames, overrideKey, reloads]);

  // The sound of the composition: fetched once the timeline sweep that mixes it has been asked for, with the same wait
  // after a prop edit. The sound that plays goes on until the new mix has been decoded.
  useEffect(() => {
    if (!comp) {
      audio.clear();
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void audio.load(() => api.audio(comp.id, propsOverride)).then((loaded) => {
        // Playing when the new sound arrives: it joins at the playhead.
        const { playing, frame } = player.getState();
        if (loaded && !cancelled && playing) audio.start(frame / comp.fps);
      });
    }, TIMELINE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, audio, player, comp?.id, comp?.fps, comp?.durationInFrames, overrideKey, reloads]);

  const waveform = useCallback(
    (clip: string | undefined, buckets: number) => (comp ? api.waveform(comp.id, propsOverride, clip, buckets) : Promise.resolve({ peaks: [] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, comp?.id, overrideKey],
  );

  // The scene of the frame on show, fetched once the playhead rests. Driven by the player's own subscription, not by a
  // React one, so a frame ticking by does not render the whole studio.
  useEffect(() => {
    if (!comp) {
      setInspect(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let key = '';
    const fetchScene = (frame: number) => {
      api.inspect(comp.id, frame, propsOverride).then(
        (data) => {
          if (cancelled) return;
          numberTree(data.layers);
          setInspect(data);
          // After a rebuild the ids may have moved: find the selected layers again by the names they had.
          if (rebuilt.current) {
            rebuilt.current = false;
            const next = remapSelection(selectedRef.current, selectedNames.current, data.layers);
            if (next.join('\0') !== selectedRef.current.join('\0')) setSelectedLayers(next);
          }
          for (const id of selectedRef.current) {
            const found = findLayer(data.layers, id);
            if (found) selectedNames.current.set(id, layerName(found));
          }
        },
        () => !cancelled && setInspect(null),
      );
    };
    const schedule = (force: boolean) => {
      const { frame, playing, scrubbing } = player.getState();
      const next = `${frame}:${playing || scrubbing}`;
      if (!force && next === key) return;
      key = next;
      clearTimeout(timer);
      if (playing || scrubbing) return;
      timer = setTimeout(() => fetchScene(frame), INSPECT_DELAY_MS);
    };
    schedule(true);
    const off = player.subscribe(() => schedule(false));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      off();
    };
  }, [api, player, comp?.id, overrideKey, reloads]);

  // ---- the coding agent ----

  const onAgentEvent = useCallback((listener: (event: AgentEvent) => void) => {
    agentListeners.current.add(listener);
    return () => {
      agentListeners.current.delete(listener);
    };
  }, []);
  const onAgentHistory = useCallback((listener: (items: ChatRecord[]) => void) => {
    historyListeners.current.add(listener);
    return () => {
      historyListeners.current.delete(listener);
    };
  }, []);
  const agentInfo = useCallback(() => api.agentInfo(), [api]);
  const frameUrl = useCallback(
    (frame: number, scale: number) => (comp && buildId > 0 ? api.frameUrl(comp.id, frame, scale, propsOverride) : null),
    [api, comp, buildId, propsOverride],
  );
  const thumbnailUrl = useCallback(
    (frame: number, height: number) => (comp && buildId > 0 ? api.thumbnailUrl(comp.id, frame, height, buildId, propsOverride) : null),
    [api, comp?.id, buildId, overrideKey],
  );
  const sendAgent = useCallback((message: AgentClientMessage) => socketRef.current?.sendAgent(message) ?? false, []);

  const submitPanel = useCallback(
    (id: string, answer: PanelAnswer[PanelKind]) => socketRef.current?.sendPanel({ type: 'panel.submit', id, answer }) ?? false,
    [],
  );
  const dismissPanel = useCallback((id: string) => socketRef.current?.sendPanel({ type: 'panel.dismiss', id }) ?? false, []);

  // ---- renders ----

  const startRender = useCallback(
    async (request: Omit<RenderRequest, 'comp' | 'props'>) => {
      if (!comp) throw new Error('no composition selected');
      const body: RenderRequest = { ...request, comp: comp.id };
      if (propsOverride) body.props = propsOverride;
      const job = await api.startRender(body);
      setRenders((jobs) => upsertJob(jobs, job));
      return job;
    },
    [api, comp, propsOverride],
  );
  const cancelRender = useCallback(
    async (id: string) => {
      const job = await api.cancelRender(id);
      setRenders((jobs) => upsertJob(jobs, job));
    },
    [api],
  );

  return {
    project,
    connected,
    compositions,
    comp,
    selectComp,
    reload: refresh,
    buildId,
    buildError,
    player,
    onImage,
    lastImage,
    propValues,
    propsOverride,
    setPropValues,
    resetProps,
    timeline,
    audio,
    waveform,
    inspect,
    selectedLayers,
    selectedLayer,
    selectLayer,
    selectLayers,
    selectedRange,
    selectRange,
    onAgentEvent,
    onAgentHistory,
    thumbnailUrl,
    frameUrl,
    sendAgent,
    agentInfo,
    panels,
    panelErrors,
    submitPanel,
    dismissPanel,
    renders,
    startRender,
    cancelRender,
  };
}
