// The panels an agent opens in Studio to ask the person for a decision (docs/proposals/studio-panels.md).
// Shared by the server, the MCP tools and the UI; each panel's draft (what the agent sends) and answer (what the
// person submits) are defined here so that the panels can be built separately.

export type PanelKind = 'brief' | 'script' | 'storyboard' | 'styleframes' | 'review' | 'custom';

/**
 * Where a panel is shown: a sheet over the preview and the timeline, a column beside the preview, or a tab in the left
 * column (beside the agent chat) or the right one (beside the inspector's tabs). A review defaults to 'beside-preview',
 * every other kind to 'sheet'.
 */
export type Placement = 'sheet' | 'left' | 'right' | 'beside-preview';

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
  /** Where it is shown; the server always sets it, a panel from before placements has none (see `placementOf`). */
  placement?: Placement;
}

export interface PanelDraft {
  brief: Partial<Brief>;
  script: ScriptDraft;
  storyboard: Storyboard;
  styleframes: StyleframesDraft;
  review: ReviewRequest;
  custom: CustomDraft;
}

export interface PanelAnswer {
  brief: Brief;
  script: ScriptAnswer;
  storyboard: StoryboardAnswer;
  styleframes: StyleframesAnswer;
  review: ReviewAnswer;
  custom: CustomAnswer;
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
  /** The brief's length in seconds, to total the lines against; the server fills it from plan/brief.json when left out. */
  targetSeconds?: number;
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
  /** The brief's length in seconds, to total the shots against; the server fills it from plan/brief.json when left out. */
  targetSeconds?: number;
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

// Custom

/** What every block has. Display blocks (heading, text, still, clip) have no value; the others put one in the answer. */
export interface BlockBase {
  /** Unique in the panel; a letter first, then letters, digits, "_" or "-" (40 at most). The key of the answer's values. */
  id: string;
  label?: string;
  help?: string;
  /** The panel cannot be submitted until this block has a value (see `isFilled` in the UI; the server checks it too). */
  required?: boolean;
}

export interface FrameRef {
  comp: string;
  frame: number;
}

export interface ChoiceOption {
  id: string;
  label?: string;
  still?: FrameRef;
  text?: string;
}

export interface CompareSide extends FrameRef {
  label?: string;
}

export type Block =
  | (BlockBase & { type: 'heading'; text: string })
  /** Paragraphs separated by a blank line; **bold** is the only markup. */
  | (BlockBase & { type: 'text'; text: string })
  | (BlockBase & { type: 'still'; comp: string; frame: number; caption?: string })
  /** Plays frames `from` to `to` (inclusive) of a composition in place. */
  | (BlockBase & { type: 'clip'; comp: string; from: number; to: number; caption?: string })
  /** Answer: the chosen option id (null for none), or, with `multiple`, a list of option ids. */
  | (BlockBase & { type: 'choice'; options: ChoiceOption[]; multiple?: boolean; value?: string | string[] })
  /** Answer: a number from min to max. */
  | (BlockBase & { type: 'slider'; min: number; max: number; step?: number; value?: number; unit?: string })
  /** Answer: the text. */
  | (BlockBase & { type: 'input'; multiline?: boolean; placeholder?: string; value?: string })
  /** Answer: the items (a list the person may add to, remove from and reorder when `editable`). */
  | (BlockBase & { type: 'list'; items: string[]; editable?: boolean })
  /** Answer: the rows, each as many cells as there are columns. */
  | (BlockBase & { type: 'table'; columns: string[]; rows: string[][]; editable?: boolean })
  /** Answer: the notes, each a text and, when drawn on the picture, a box in composition pixels. */
  | (BlockBase & { type: 'notes'; still: FrameRef })
  /** Answer: 'a' or 'b' (null for neither). */
  | (BlockBase & { type: 'compare'; a: CompareSide; b: CompareSide });

export type BlockType = Block['type'];

export interface CustomDraft {
  /** The slug that names the plan file: plan/custom-<name>.json. A new panel with the name of an open one replaces it. */
  name: string;
  title: string;
  blocks: Block[];
  /** The text of the submit button (default "Send"). */
  submitLabel?: string;
}

/** A note on a picture: its text and, when the person drew one, the area. */
export interface PictureNote {
  text: string;
  box?: Box;
}

/** The value of each input block by its id (display blocks have none). */
export interface CustomAnswer {
  values: Record<string, unknown>;
}
