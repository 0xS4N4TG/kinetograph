// The chat as a list of items, built from the events the server sends. A pure reducer so the panel is only drawing.

import type { AgentEvent, AgentPermissionOption, AgentStatus, ChatRecord, QueuedMessage, ToolDiff, ToolInput } from '@/api';

export type ChatItem =
  | { kind: 'user'; id: number; text: string; chips: string[]; images?: string[] }
  | { kind: 'agent'; id: number; text: string }
  | {
      kind: 'tool';
      id: number;
      toolId: string;
      title: string;
      toolKind: string;
      status: string;
      files: string[];
      input?: ToolInput;
      output?: string;
      diffs?: ToolDiff[];
      /** How long the call took, once it has ended. */
      ms?: number;
    }
  | { kind: 'permission'; id: number; permissionId: string; title: string; files: string[]; options: AgentPermissionOption[]; answered: string | null }
  | { kind: 'error'; id: number; text: string };

export interface ChatState {
  items: ChatItem[];
  status: AgentStatus;
  command: string | null;
  /** Whether the agent takes pictures (known once it has started). */
  image: boolean;
  nextId: number;
  /** The messages sent while the agent was working, waiting for the turn to end (kept by the server). */
  queue: QueuedMessage[];
  /** The message just taken out of the queue to be edited (`n` counts them, so taking the same one twice is seen). */
  taken: { n: number; item: QueuedMessage } | null;
}

type NewItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'id'> : never) : never;

export const emptyChat: ChatState = { items: [], status: 'idle', command: null, image: false, nextId: 1, queue: [], taken: null };

/** Adds the user's own message. */
export function addUserMessage(state: ChatState, text: string, chips: string[], images: string[] = []): ChatState {
  const item: ChatItem = { kind: 'user', id: state.nextId, text, chips, ...(images.length > 0 ? { images } : {}) };
  return { ...state, items: [...state.items, item], nextId: state.nextId + 1 };
}

/** Starts again: the conversation is cleared (the status stays). */
export function clearChat(state: ChatState): ChatState {
  return { ...emptyChat, status: state.status, command: state.command, image: state.image, nextId: state.nextId, taken: state.taken };
}

/** Marks a permission as answered by the user, before the server confirms. */
export function answerPermission(state: ChatState, permissionId: string, optionId: string | null): ChatState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === 'permission' && item.permissionId === permissionId ? { ...item, answered: optionId ?? 'cancelled' } : item,
    ),
  };
}

export function reduceChat(state: ChatState, event: AgentEvent): ChatState {
  const push = (item: NewItem): ChatState => ({
    ...state,
    items: [...state.items, { ...item, id: state.nextId } as ChatItem],
    nextId: state.nextId + 1,
  });
  switch (event.kind) {
    case 'status':
      return { ...state, status: event.status, command: event.command, image: event.image };
    case 'message': {
      const last = state.items.at(-1);
      if (last?.kind === 'agent') {
        return { ...state, items: [...state.items.slice(0, -1), { ...last, text: last.text + event.text }] };
      }
      return push({ kind: 'agent', text: event.text });
    }
    case 'thought':
      return state;
    case 'tool': {
      const index = state.items.findIndex((i) => i.kind === 'tool' && i.toolId === event.id);
      if (index >= 0) {
        const old = state.items[index] as Extract<ChatItem, { kind: 'tool' }>;
        // An update may leave out what the first message said (an update without a kind arrives as 'other').
        const next: typeof old = {
          ...old,
          title: event.title || old.title,
          toolKind: event.toolKind && event.toolKind !== 'other' ? event.toolKind : old.toolKind,
          status: event.status,
          files: event.files.length > 0 ? event.files : old.files,
          ...(event.input ?? old.input ? { input: event.input ?? old.input } : {}),
          ...(event.output ?? old.output ? { output: event.output ?? old.output } : {}),
          ...(event.diffs ?? old.diffs ? { diffs: event.diffs ?? old.diffs } : {}),
          ...(event.ms ?? old.ms ? { ms: event.ms ?? old.ms } : {}),
        };
        return { ...state, items: state.items.map((item, i) => (i === index ? next : item)) };
      }
      return push({
        kind: 'tool',
        toolId: event.id,
        title: event.title,
        toolKind: event.toolKind,
        status: event.status,
        files: event.files,
        ...(event.input ? { input: event.input } : {}),
        ...(event.output ? { output: event.output } : {}),
        ...(event.diffs ? { diffs: event.diffs } : {}),
        ...(event.ms !== undefined ? { ms: event.ms } : {}),
      });
    }
    case 'permission':
      return push({ kind: 'permission', permissionId: event.id, title: event.title, files: event.files, options: event.options, answered: null });
    case 'permission_done':
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === 'permission' && item.permissionId === event.id && item.answered === null ? { ...item, answered: 'cancelled' } : item,
        ),
      };
    case 'done':
      return state;
    case 'user':
      return addUserMessage(state, event.text, event.chips ?? [], event.images);
    case 'queue':
      return { ...state, queue: event.items };
    case 'unqueued':
      return { ...state, taken: { n: (state.taken?.n ?? 0) + 1, item: event.item } };
    case 'error':
      return push({ kind: 'error', text: event.message });
  }
}

/** The conversation the server kept, replayed onto an empty chat (the status stays): what a reloaded window shows. */
export function replayChat(state: ChatState, records: ChatRecord[]): ChatState {
  let next = clearChat(state);
  for (const record of records) {
    if (record.kind === 'user') next = addUserMessage(next, record.text, record.chips, record.images);
    else if (record.kind === 'answer') next = answerPermission(next, record.id, record.optionId);
    else next = reduceChat(next, record.event);
  }
  return next;
}
