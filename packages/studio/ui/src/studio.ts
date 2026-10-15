// The studio's state: what the server told us, what the user chose, and the player. One hook so `App` is layout only.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type {
  CompositionInfo,
  InspectResult,
  ProjectInfo,
  ReceivedFrame,
  RenderJob,
  RenderRequest,
  ServerMessage,
  StudioApi,
  StudioError,
  StudioSocket,
  TimelineData,
} from '@/api';
import { Player, type PlayerState } from '@/lib/player';

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

export interface Studio {
  project: ProjectInfo | null;
  connected: boolean;
  compositions: CompositionInfo[];
  comp: CompositionInfo | null;
  selectComp(id: string): void;
  buildId: number;
  buildError: StudioError | null;

  player: Player;
  playerState: PlayerState;
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

  timeline: TimelineData | null;
  inspect: InspectResult | null;
  selectedLayer: string | null;
  selectLayer(id: string | null): void;

  renders: RenderJob[];
  startRender(request: Omit<RenderRequest, 'comp' | 'props'>): Promise<RenderJob>;
  cancelRender(id: string): Promise<void>;
}

const INSPECT_DELAY_MS = 80;
const TIMELINE_DELAY_MS = 200;

export function useStudio(api: StudioApi): Studio {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [compositions, setCompositions] = useState<CompositionInfo[]>([]);
  const [compId, setCompId] = useState<string | null>(null);
  const [buildId, setBuildId] = useState(0);
  const [buildError, setBuildError] = useState<StudioError | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [selectedLayer, selectLayer] = useState<string | null>(null);
  const [renders, setRenders] = useState<RenderJob[]>([]);
  /** Bumped by every `reload`: what the timeline and the scene tree show is from the old build. */
  const [reloads, setReloads] = useState(0);

  // ---- the player and its socket ----

  const socketRef = useRef<StudioSocket | null>(null);
  const imageListeners = useRef(new Set<(frame: ReceivedFrame) => void>());
  const lastImageRef = useRef<ReceivedFrame | null>(null);
  const playerRef = useRef<Player | null>(null);
  if (playerRef.current === null) {
    playerRef.current = new Player({
      requestFrame: (args) => socketRef.current?.requestFrame(args) ?? -1,
      onImage: (frame) => {
        lastImageRef.current = frame;
        for (const listener of imageListeners.current) listener(frame);
      },
    });
  }
  const player = playerRef.current;
  const playerState = useSyncExternalStore(player.subscribe, player.getState);

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

  useEffect(() => {
    let cancelled = false;
    // A new build: everything fetched from the old one is stale.
    const rebuilt = (id: number) => {
      buildIdRef.current = id;
      setBuildId(id);
      setReloads((n) => n + 1);
      void loadCompositions();
      api.project().then(
        (p) => !cancelled && setProject(p),
        () => {},
      );
      player.reload();
    };
    const handle = (message: ServerMessage) => {
      switch (message.type) {
        case 'hello':
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
  }, [api, player, loadCompositions]);

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
    selectLayer(null);
  }, []);

  // `comp` is a new object after each refetch; the player only acts when what it shows changed.
  useEffect(() => {
    player.setComposition(comp, propsOverride);
  }, [player, comp, overrideKey]);

  // ---- timeline and scene tree ----

  useEffect(() => {
    if (!comp) {
      setTimeline(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.timeline(comp.id, propsOverride).then(
        (data) => !cancelled && setTimeline(data),
        () => !cancelled && setTimeline(null),
      );
    }, TIMELINE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, comp?.id, comp?.durationInFrames, overrideKey, reloads]);

  const frame = playerState.frame;
  const moving = playerState.playing || playerState.scrubbing;
  useEffect(() => {
    if (!comp) {
      setInspect(null);
      return;
    }
    if (moving) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.inspect(comp.id, frame, propsOverride).then(
        (data) => !cancelled && setInspect(data),
        () => !cancelled && setInspect(null),
      );
    }, INSPECT_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, comp?.id, frame, moving, overrideKey, reloads]);

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
    buildId,
    buildError,
    player,
    playerState,
    onImage,
    lastImage,
    propValues,
    propsOverride,
    setPropValues,
    resetProps,
    timeline,
    inspect,
    selectedLayer,
    selectLayer,
    renders,
    startRender,
    cancelRender,
  };
}
