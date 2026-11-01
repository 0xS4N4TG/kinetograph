// HTTP routes a panel needs besides the generic /api/panels ones (a file drop, a contact sheet). Each panel kind adds
// its handler in its own file and lists it here; the server tries them in order after its own routes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { briefRoute } from './brief-routes.js';
import { scriptRoute } from './script-routes.js';

export interface PanelRouteContext {
  /** The directory that holds the project's entry; plan files live in <projectDir>/plan/. */
  projectDir: string;
  /** True when the request carries the window's token (not the agent's). */
  fromWindow: boolean;
}

/** Handles the request and returns true, or returns false to leave it to the next handler. */
export type PanelRoute = (req: IncomingMessage, res: ServerResponse, url: URL, ctx: PanelRouteContext) => Promise<boolean>;

export const panelRoutes: PanelRoute[] = [briefRoute, scriptRoute];
