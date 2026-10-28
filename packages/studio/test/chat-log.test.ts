import { describe, expect, it } from 'vitest';
import { ChatLog } from '../src/chat-log.js';

const user = (text: string) => ({ kind: 'user' as const, text, chips: [] });
const says = (text: string) => ({ kind: 'event' as const, event: { kind: 'message' as const, text } });
const tool = (id: string) => ({ kind: 'event' as const, event: { kind: 'tool' as const, id, title: 't', toolKind: 'edit', status: 'pending', files: [] } });

describe('the chat the server keeps', () => {
  it('joins streamed text into one record per paragraph', () => {
    const log = new ChatLog();
    log.push(user('hi'));
    for (const chunk of ['Su', 're', ', ok.']) log.push(says(chunk));
    log.push(tool('a'));
    log.push(says('Done'));
    expect(log.records).toEqual([user('hi'), says('Sure, ok.'), tool('a'), says('Done')]);
    expect(log.size).toBe(log.records.reduce((n, r) => n + JSON.stringify(r).length, 0));
  });

  it('drops whole turns from the start past its limits, so a replay starts at a user message', () => {
    const byCount = new ChatLog(5, 1 << 20);
    for (let turn = 0; turn < 4; turn += 1) {
      byCount.push(user(`q${turn}`));
      byCount.push(tool(`${turn}a`));
      byCount.push(tool(`${turn}b`));
    }
    expect(byCount.records.length).toBeLessThanOrEqual(5);
    expect(byCount.records[0]).toEqual(user('q3'));

    const byBytes = new ChatLog(1000, 2_000);
    for (let turn = 0; turn < 20; turn += 1) {
      byBytes.push(user(`question ${turn}`));
      byBytes.push(says('x'.repeat(300)));
    }
    expect(byBytes.size).toBeLessThanOrEqual(2_000);
    expect(byBytes.records[0]!.kind).toBe('user');
    expect(byBytes.records.at(-1)).toEqual(says('x'.repeat(300)));
  });
});
