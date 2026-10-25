// A tiny ACP agent for the tests: no model, no network. What it does depends on the words in the prompt:
//   "edit"   asks permission, then writes notes.txt through the client and tries to read ../outside.txt
//   "crash"  exits at once
//   else     answers with what it was sent (the text, and whether a picture came with it)
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';

if (process.env.FAKE_AGENT_AUTH === '1') {
  process.stderr.write('Please log in first\n');
  process.exit(1);
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

const say = (client, text) =>
  client.notify(methods.client.session.update, {
    sessionId: 's1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });

agent({ name: 'fake-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: process.env.FAKE_AGENT_IMAGE !== '0' } },
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: 's1' }))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const blocks = params.prompt;
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const images = blocks.filter((b) => b.type === 'image').length;
    if (text.includes('crash')) process.exit(3);
    if (text.includes('edit')) {
      const cwd = process.env.FAKE_AGENT_CWD ?? process.cwd();
      const permission = await client.request(methods.client.session.requestPermission, {
        sessionId: 's1',
        toolCall: { toolCallId: 't1', title: 'Write notes.txt', kind: 'edit', status: 'pending', locations: [{ path: `${cwd}/notes.txt` }] },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      if (permission.outcome.outcome === 'selected' && permission.outcome.optionId === 'allow') {
        await client.request(methods.client.fs.writeTextFile, { sessionId: 's1', path: `${cwd}/notes.txt`, content: 'hello\n' });
        await client.notify(methods.client.session.update, {
          sessionId: 's1',
          update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: `${cwd}/notes.txt`, oldText: null, newText: 'hello\n' }] },
        });
        let escaped = 'refused';
        try {
          await client.request(methods.client.fs.readTextFile, { sessionId: 's1', path: `${cwd}/../outside.txt` });
          escaped = 'READ OUTSIDE';
        } catch {
          // expected
        }
        await say(client, `wrote notes.txt; outside read ${escaped}`);
      } else {
        await say(client, 'not allowed');
      }
      return { stopReason: 'end_turn' };
    }
    await say(client, `got: ${text} | images: ${images}`);
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, () => {})
  .connect(stream);
