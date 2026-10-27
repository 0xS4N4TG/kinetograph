// Errors a project's own scripts raise without stopping the render: `console.error` calls, uncaught exceptions and
// unhandled promise rejections. A library that catches its own failure (Mermaid logs it and leaves the diagram empty)
// draws nothing and says nothing else, so `doctor` would call the frame clean. They are collected as they happen and the
// frame loop reports what arrived while it drew the frame as unsupported items (`doctor` groups them by frames, `--strict`
// fails on them). Nothing is swallowed: `console.error` still prints, and `uncaughtExceptionMonitor` only observes.

import { format } from 'node:util';
import type { Unsupported } from '@kinetographdev/scene';

type Kind = 'console.error' | 'uncaught exception' | 'unhandled rejection';

const caught = new Map<string, Unsupported>();
let installed = false;

const REASON = 'the page raised an error and went on; whatever it was drawing may be missing';

/** Records one error, once per kind and message until the frame loop takes it. */
export function recordPageError(kind: Kind, message: string): void {
  const text = message.length > 300 ? `${message.slice(0, 300)}...` : message;
  const item: Unsupported = { path: '<page script>', element: 'page script', property: kind, value: text, reason: REASON };
  caught.set(`${kind}\n${text}`, item);
}

const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** Starts collecting. Safe to call again. */
export function installPageErrors(): void {
  if (installed) return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    recordPageError('console.error', format(...args).split('\n')[0] ?? '');
    original(...args);
  };
  if (typeof process !== 'undefined' && typeof process.on === 'function') {
    process.on('uncaughtExceptionMonitor', (error) => recordPageError('uncaught exception', describe(error)));
    // A handler makes Node keep going after a rejection, as a browser does; the report below says it happened.
    process.on('unhandledRejection', (reason) => recordPageError('unhandled rejection', describe(reason)));
  }
}

/** The errors collected since the last call, each once. */
export function takePageErrors(): Unsupported[] {
  const items = [...caught.values()];
  caught.clear();
  return items;
}
