// The chat's state and what it can do: send a message with the selection as context, answer a permission, stop, start over.

import { useCallback, useEffect, useMemo, useReducer } from 'react';

import type { AgentEvent, AgentInfo, ChatRecord } from '@/api';
import { addUserMessage, answerPermission, clearChat, emptyChat, reduceChat, replayChat, type ChatState } from '@/lib/chat';
import type { Studio } from '@/studio';

type Action =
  | { type: 'event'; event: AgentEvent }
  | { type: 'user'; text: string; chips: string[] }
  | { type: 'answer'; id: string; optionId: string | null }
  | { type: 'history'; items: ChatRecord[] }
  | { type: 'clear' };

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'event':
      return reduceChat(state, action.event);
    case 'user':
      return addUserMessage(state, action.text, action.chips);
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
  send(text: string, context: string, chips: string[], image?: { data: string; mimeType: string }): boolean;
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
    (text, context, chips, image) => {
      if (!sendAgent({ type: 'agent.prompt', text, context, image, chips })) {
        dispatch({ type: 'event', event: { kind: 'error', message: 'The studio is not connected. Wait a moment and try again.' } });
        return false;
      }
      dispatch({ type: 'user', text, chips });
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

  return useMemo(() => ({ state, send, answer, stop, restart, chooseAgent, loadInfo }), [state, send, answer, stop, restart, chooseAgent, loadInfo]);
}
