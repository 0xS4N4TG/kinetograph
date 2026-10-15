import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StudioError } from './protocol.js';

/** A failure with a studio error code (`INVALID_ARG`, `NOT_FOUND`, `BUILD`, …). */
export class StudioFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StudioFailure';
  }
}

/**
 * The `StudioError` of any thrown value; the CLI's and the addon's errors keep their codes. (As the CLI's
 * `toErrorObject`, which is not imported so that a worker that does not need the CLI does not load it.)
 */
export function toStudioError(error: unknown): StudioError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'INTERNAL', message: error.message };
  }
  return { code: 'INTERNAL', message: String(error) };
}

/** The HTTP status for an error, with the code the client sees (docs/AUTHORING.md §11.5). */
export function httpError(error: unknown): { status: number; error: StudioError } {
  const { code, message } = toStudioError(error);
  switch (code) {
    case 'INVALID_ARG':
    case 'FRAME_OUT_OF_RANGE':
      return { status: 400, error: { code: 'INVALID_ARG', message } };
    case 'NOT_FOUND':
    case 'COMPOSITION_NOT_FOUND':
      return { status: 404, error: { code: 'NOT_FOUND', message } };
    case 'BUILD':
      return { status: 409, error: { code, message } };
    default:
      return { status: 500, error: { code, message } };
  }
}

/** `JSON.stringify` with object keys sorted, so equal props are equal keys. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The path of a built file of this package: beside this one when it is the built copy, else in `dist/` (the sources
 * run directly under vitest, and a worker cannot load TypeScript).
 */
export function builtFile(name: string): string {
  const beside = fileURLToPath(new URL(`./${name}`, import.meta.url));
  return existsSync(beside) ? beside : fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
}
