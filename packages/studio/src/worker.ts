// The worker thread of the studio (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5). It loads the engine module it is told to, and answers the
// server's calls one at a time (the project's clock is global to the thread, so frames cannot interleave).
//
// Once a project's bundle is loaded the determinism shim has replaced this thread's `Date`, `performance.now` and
// timers, so nothing here uses them: time is `process.hrtime`, and the queue is promises.

import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { CreateEngine, Engine, PreviewReply, WorkerInit, WorkerReply, WorkerRequest } from './engine.js';
import { sweepTimeline } from './timeline.js';
import { toStudioError } from './util.js';

const init = workerData as WorkerInit;
const port = parentPort!;
const hrMs = (): number => Number(process.hrtime.bigint()) / 1e6;

let engine: Promise<Engine> | undefined;
function loadEngine(): Promise<Engine> {
  engine ??= import(pathToFileURL(init.engine).href).then((mod: { createEngine?: CreateEngine }) => {
    if (typeof mod.createEngine !== 'function') throw new Error(`${init.engine} does not export createEngine`);
    return mod.createEngine(init.options);
  });
  return engine;
}

async function handle(request: WorkerRequest): Promise<unknown> {
  const e = await loadEngine();
  switch (request.op) {
    case 'compositions':
      return e.compositions();
    case 'plan':
      return e.plan({ comp: request.comp, props: request.props, range: request.range });
    case 'preview': {
      const started = hrMs();
      const scene = await e.frame({ comp: request.comp, props: request.props, frame: request.frame });
      const image = await e.preview(scene, { scale: request.scale, format: request.format });
      const reply: PreviewReply = { ...image, ms: hrMs() - started };
      return reply;
    }
    case 'inspect': {
      const scene = await e.frame({ comp: request.comp, props: request.props, frame: request.frame });
      return e.inspect(scene);
    }
    case 'timeline':
      return sweepTimeline(e, { comp: request.comp, props: request.props });
    case 'render': {
      const cancel = init.cancel ? new Int32Array(init.cancel) : null;
      return e.render(request.spec, {
        onFrame: (done, total) => port.postMessage({ event: 'progress', id: request.id, done, total } satisfies WorkerReply),
        shouldCancel: () => cancel !== null && Atomics.load(cancel, 0) === 1,
      });
    }
  }
}

let queue: Promise<void> = Promise.resolve();
port.on('message', (request: WorkerRequest) => {
  queue = queue.then(async () => {
    let reply: WorkerReply;
    try {
      reply = { id: request.id, ok: true, result: await handle(request) };
    } catch (error) {
      reply = { id: request.id, ok: false, error: toStudioError(error) };
    }
    port.postMessage(reply);
  });
});
