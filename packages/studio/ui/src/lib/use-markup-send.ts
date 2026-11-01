// Sends markup notes to the agent as one message: the notes in time order, and for each distinct frame the preview frame
// with its marks drawn on it, stored in the project (public/refs/markup-<stamp>-<n>.png) through the image path the prompt
// box uses. The notes stay on the picture afterwards, in the sent style.

import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { AgentAttachment, CompositionInfo, ProjectInfo, TimelineData } from '@/api';
import { prepareAttachments } from '@/lib/attachments';
import { buildChatContext } from '@/lib/chat-context';
import { composeNotes, MarkupStore, pictureFrames, pictureName, toSend, type Note } from '@/lib/markup';
import { annotatedFrame } from '@/lib/markup-image';
import type { Player } from '@/lib/player';
import type { Chat } from '@/lib/use-chat';

export interface MarkupSendDeps {
  store: MarkupStore;
  chat: Pick<Chat, 'send'>;
  comp: CompositionInfo | null;
  project: ProjectInfo | null;
  timeline: TimelineData | null;
  player: Player;
  frameUrl(frame: number, scale: number): string | null;
  /** Fetches a frame for the picture (replaceable in a test). */
  load?: Parameters<typeof annotatedFrame>[1]['load'];
  now?(): number;
}

/** Sends the notes (these ids, or every note in the tray); resolves when the message has gone or failed. */
export async function sendMarkup(deps: MarkupSendDeps, ids: number[] | null): Promise<void> {
  const { store, chat, comp, project, timeline, player } = deps;
  if (!comp) return;
  const state = store.getState();
  const wanted: Note[] = ids ? toSend(state.notes, comp.id).filter((n) => ids.includes(n.id)) : toSend(state.notes, comp.id);
  if (wanted.length === 0) return;
  store.setBusy(true);
  try {
    const numbered = wanted.map((note, i) => ({ note, no: i + 1 }));
    const { shown, left } = pictureFrames(wanted);
    const stamp = (deps.now ?? Date.now)();
    const made = await Promise.all(
      shown.map((frame, i) =>
        annotatedFrame(pictureName(stamp, i + 1), {
          frame,
          marks: numbered.filter((n) => n.note.frame === frame),
          compWidth: comp.width,
          compHeight: comp.height,
          urlFor: deps.frameUrl,
          ...(deps.load ? { load: deps.load } : {}),
        }),
      ),
    );
    const files = made.flatMap((file, i) => (file ? [{ frame: shown[i]!, file }] : []));
    const unmade = shown.filter((f) => !files.some((m) => m.frame === f));
    let attachments: AgentAttachment[] = [];
    if (files.length > 0) {
      attachments = await prepareAttachments(
        files.map((m, i) => ({ id: i, file: m.file, preview: '' })),
        () => undefined,
      );
    }
    const pictures = new Map(files.map((m, i) => [m.frame, attachments[i]!.name] as const));
    const text = composeNotes(comp.id, comp.fps, wanted, pictures, [...unmade, ...left]);
    const context = project ? buildChatContext({ entry: project.entry, cwd: project.cwd, comp, frame: Math.floor(player.getState().frame), layers: [], timeline, range: null }) : '';
    if (chat.send(text, context, [`${wanted.length} markup note${wanted.length === 1 ? '' : 's'}`], undefined, attachments)) {
      store.markSent(numbered.map((n) => ({ id: n.note.id, no: n.no })));
      store.setBusy(false);
    } else {
      store.setBusy(false, 'The studio is not connected. Wait a moment and try again.');
    }
  } catch (error) {
    store.setBusy(false, error instanceof Error ? error.message : 'The notes could not be sent.');
  }
}

/** Does the sending when something (a bubble, the tray) asks the store for it; lives where the chat does. */
export function useMarkupSend(deps: MarkupSendDeps): number {
  // Only the count of requests is followed, so typing in a bubble does not render the layout. Returns the count.
  const asked = useSyncExternalStore(deps.store.subscribe, () => deps.store.getState().request?.n ?? 0);
  const seen = useRef(asked);
  const latest = useRef(deps);
  latest.current = deps;
  useEffect(() => {
    const request = deps.store.getState().request;
    if (!request || request.n === seen.current) return;
    seen.current = request.n;
    void sendMarkup(latest.current, request.ids);
  }, [asked, deps.store]);
  return asked;
}
