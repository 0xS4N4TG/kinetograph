// A tiny ACP agent for the tests: no model, no network. What it does depends on the words in the prompt:
//   "edit"   asks permission, then writes notes.txt through the client and tries to read ../outside.txt
//   "crash"  exits at once
//   "slow"   takes 700 ms, then answers as below
//   "tools"  runs a command and edits a file as tool calls (with raw input, output and a diff), then answers
//   "mcp"    answers with the mcpServers that session/new was given, as JSON
//   else     answers with what it was sent (the text, and whether a picture came with it)
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';

if (process.env.FAKE_AGENT_AUTH === '1') {
  process.stderr.write('Please log in first\n');
  process.exit(1);
}

let sessionNew = null;
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
  .onRequest(methods.agent.session.new, ({ params }) => {
    sessionNew = params;
    return { sessionId: 's1' };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const blocks = params.prompt;
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const images = blocks.filter((b) => b.type === 'image').length;
    if (text.includes('crash')) process.exit(3);
    if (text.includes('slow')) await new Promise((resolve) => setTimeout(resolve, 700));
    if (text.includes('tools')) {
      const cwd = process.env.FAKE_AGENT_CWD ?? process.cwd();
      const tell = (update) => client.notify(methods.client.session.update, { sessionId: 's1', update });
      await tell({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: `cd ${cwd} && ls`, kind: 'execute', status: 'in_progress', rawInput: { command: `cd ${cwd} && ls`, description: 'List files' } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await tell({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt\nb.txt' } }] });
      await tell({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c2',
        title: 'Edit a.txt',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: `${cwd}/a.txt` }],
        content: [{ type: 'diff', path: `${cwd}/a.txt`, oldText: 'one\ntwo\n', newText: 'one\n2\nthree\n' }],
      });
      await say(client, 'did tools');
      return { stopReason: 'end_turn' };
    }
    if (text.includes('mcp')) {
      await say(client, JSON.stringify(sessionNew));
      return { stopReason: 'end_turn' };
    }
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
