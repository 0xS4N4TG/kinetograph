// The chat's state and what it can do: send a message with the selection as context, answer a permission, stop, start over.

import { useCallback, useEffect, useMemo, useReducer } from 'react';

import type { AgentAttachment, AgentEvent, AgentInfo, ChatRecord } from '@/api';
import { answerPermission, clearChat, emptyChat, reduceChat, replayChat, type ChatState } from '@/lib/chat';
import type { Studio } from '@/studio';

type Action =
  | { type: 'event'; event: AgentEvent }
  | { type: 'answer'; id: string; optionId: string | null }
  | { type: 'history'; items: ChatRecord[] }
  | { type: 'clear' };

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'event':
      return reduceChat(state, action.event);
    case 'answer':
      return answerPermission(state, action.id, action.optionId);
    case 'history':
      return replayChat(state, action.items);
    case 'clear':
      return clearChat(state);
  }
}

export interface Chat {
  state: ChatState;
  send(text: string, context: string, chips: string[], image?: { data: string; mimeType: string }, attachments?: AgentAttachment[]): boolean;
  /** Takes a message out of the queue before the agent gets it. */
  unqueue(id: string): void;
  /** Takes a message out of the queue and gives it back in `state.taken`, to edit it. */
  take(id: string): void;
  /** Puts the queued messages in this order. */
  requeue(order: string[]): void;
  /** Stops the turn and sends this queued message next. */
  sendNow(id: string): void;
  answer(permissionId: string, optionId: string | null): void;
  stop(): void;
  /** Ends the conversation: the agent starts again at the next message. */
  restart(): void;
  chooseAgent(command: string | null): void;
  loadInfo(): Promise<AgentInfo | null>;
}

/**
 * Lives in `App`, above the tabs, so that switching tabs does not lose the conversation; the server keeps it too, and
 * replays it to this window after a reload (`agent.history`).
 */
export function useChat(studio: Pick<Studio, 'onAgentEvent' | 'onAgentHistory' | 'sendAgent' | 'agentInfo'>): Chat {
  const [state, dispatch] = useReducer(reducer, emptyChat);
  const { onAgentEvent, onAgentHistory, sendAgent, agentInfo } = studio;

  useEffect(() => onAgentEvent((event) => dispatch({ type: 'event', event })), [onAgentEvent]);
  useEffect(() => onAgentHistory((items) => dispatch({ type: 'history', items })), [onAgentHistory]);

  const send = useCallback<Chat['send']>(
    (text, context, chips, image, attachments) => {
      if (!sendAgent({ type: 'agent.prompt', text, context, image, chips, ...(attachments && attachments.length > 0 ? { attachments } : {}) })) {
        dispatch({ type: 'event', event: { kind: 'error', message: 'The studio is not connected. Wait a moment and try again.' } });
        return false;
      }
      // The server answers with the message in the chat (sent now) or in the queue (the agent is working).
      return true;
    },
    [sendAgent],
  );
  const answer = useCallback<Chat['answer']>(
    (id, optionId) => {
      dispatch({ type: 'answer', id, optionId });
      sendAgent({ type: 'agent.permission', id, optionId });
    },
    [sendAgent],
  );
  const unqueue = useCallback((id: string) => void sendAgent({ type: 'agent.unqueue', id }), [sendAgent]);
  const take = useCallback((id: string) => void sendAgent({ type: 'agent.unqueue', id, take: true }), [sendAgent]);
  const requeue = useCallback((order: string[]) => void sendAgent({ type: 'agent.requeue', order }), [sendAgent]);
  const sendNow = useCallback((id: string) => void sendAgent({ type: 'agent.sendnow', id }), [sendAgent]);
  const stop = useCallback(() => void sendAgent({ type: 'agent.cancel' }), [sendAgent]);
  const restart = useCallback(() => {
    sendAgent({ type: 'agent.reset' });
    dispatch({ type: 'clear' });
  }, [sendAgent]);
  const chooseAgent = useCallback(
    (command: string | null) => {
      sendAgent({ type: 'agent.select', command });
      dispatch({ type: 'clear' });
    },
    [sendAgent],
  );
  const loadInfo = useCallback(() => agentInfo().then((info) => info, () => null), [agentInfo]);

  return useMemo(() => ({ state, send, unqueue, take, requeue, sendNow, answer, stop, restart, chooseAgent, loadInfo }), [state, send, unqueue, take, requeue, sendNow, answer, stop, restart, chooseAgent, loadInfo]);
}
