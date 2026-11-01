// The panels an agent opens in Studio to ask the person for a decision (docs/proposals/studio-panels.md).
// Shared by the server, the MCP tools and the UI; each panel's draft (what the agent sends) and answer (what the
// person submits) are defined here so that the panels can be built separately.

export type PanelKind = 'brief' | 'script' | 'storyboard' | 'styleframes' | 'review';

export type PanelStatus = 'open' | 'submitted' | 'dismissed';

/** A panel as the server keeps it and sends it to the window. */
export interface OpenPanel<K extends PanelKind = PanelKind> {
  id: string;
  panel: K;
  data: PanelDraft[K];
  message: string | null;
  status: PanelStatus;
  answer: PanelAnswer[K] | null;
  openedAt: number;
}

export interface PanelDraft {
  brief: Partial<Brief>;
  script: ScriptDraft;
  storyboard: Storyboard;
  styleframes: StyleframesDraft;
  review: ReviewRequest;
}

export interface PanelAnswer {
  brief: Brief;
  script: ScriptAnswer;
  storyboard: StoryboardAnswer;
  styleframes: StyleframesAnswer;
  review: ReviewAnswer;
}

// Brief

export type Platform = 'reel-9x16' | 'youtube-16x9' | 'square-1x1' | 'ad-slot' | 'custom';

export interface Brief {
  purpose: string;
  audience: string;
  platform: Platform;
  size: { width: number; height: number; fps: number };
  seconds: number;
  takeaway: string;
  references: Reference[];
  notes?: string;
}

export interface Reference {
  /** A link is kept as text and never downloaded; a file is copied into plan/refs/. */
  kind: 'link' | 'file';
  /** The URL, or the file's path relative to the project (plan/refs/<name>). */
  src: string;
  /** What the person likes about it. */
  like: string;
  /** For a video file: a contact sheet of 8 frames, relative to the project (plan/refs/<name>.sheet.png). */
  sheet?: string;
}

// Script

export interface ScriptLine {
  id: string;
  text: string;
  /** Seconds, from the voiceover once there is one, else estimated from the words. */
  seconds?: number;
}

export interface ScriptDraft {
  lines: ScriptLine[];
  /** Words per second for the estimate (default 2.5). */
  rate?: number;
  /** A music-led piece: the track, relative to the project, and its beats in seconds. */
  track?: { src: string; beats: number[] };
}

export interface ScriptAnswer {
  lines: ScriptLine[];
  notes: { line: string; text: string }[];
  approved: boolean;
  track?: { src: string; beats: number[] };
}

// Storyboard

export type Transition = 'cut' | 'match-cut' | 'whip' | 'dissolve' | 'wipe' | 'other';

export interface Shot {
  id: string;
  /** The board composition's frame that shows this shot. */
  frame: number;
  what: string;
  moves: string;
  line?: string;
  seconds: number;
  transition: Transition;
  transitionNote?: string;
}

export interface Storyboard {
  /** The composition that draws the board. */
  comp: string;
  shots: Shot[];
}

export interface StoryboardAnswer {
  shots: Shot[];
  removed: string[];
  notes: { shot: string; text: string }[];
  approved: boolean;
}

// Styleframes

export interface Styleframe {
  id: string;
  label: string;
  comp: string;
  frame: number;
  /** What this option tries: "serif display, warm grade". */
  note?: string;
}

export interface StyleframesDraft {
  frames: Styleframe[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StyleframesAnswer {
  /** The chosen frame, or null when the person mixes options (see mix). */
  pick: string | null;
  /** "A's type, B's colours". */
  mix?: string;
  notes: { frame: string; text: string; box?: Box }[];
  approved: boolean;
}

// Review

export interface ReviewRequest {
  comp: string;
  /** Frames, inclusive; the whole composition when left out. */
  range?: [number, number];
  ask?: string;
}

export interface Note {
  frame: number;
  text: string;
  box?: Box;
  layer?: string;
}

export interface ReviewAnswer {
  notes: Note[];
  verdict: 'approved' | 'changes';
}
