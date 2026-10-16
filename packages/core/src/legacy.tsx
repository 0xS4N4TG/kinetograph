// Remotion exports that are gone upstream or only talk to the CLI, kept so a project that imports them still bundles:
// `Config` (the CLI settings that moved to `@remotion/cli/config`) and `Experimental` (`Clipper` and `Null`, removed in
// Remotion 4.0.228, and `useIsPlayer`).

import type { ReactNode } from 'react';
import { warnOnce } from './warn.js';

const REMOVED = 'removed as of Remotion v4.0.228: its native clipping APIs were experimental and are gone';

function Clipper(): ReactNode {
  throw new Error(`<Clipper> has been ${REMOVED}.`);
}

function Null(): ReactNode {
  throw new Error(`<Null> has been ${REMOVED}.`);
}

export const Experimental = {
  /** Throws when rendered, as Remotion's does. */
  Clipper,
  /** Throws when rendered, as Remotion's does. */
  Null,
  /** There is no Player, so this is always false. */
  useIsPlayer: (): boolean => false,
};

const configGroups = new Set(['Bundling', 'Rendering', 'Log', 'Puppeteer', 'Output']);

/**
 * `Config.Rendering.setX(...)` and the other calls of Remotion's old config object. Every call does nothing and the
 * first prints where the options go instead; the groups (`Config.Bundling`, …) return the object, so chains work.
 * Typed loosely so that a call of any name, through any group, type-checks.
 */
export const Config: Record<string, any> = new Proxy(
  {},
  {
    get(_target, property): unknown {
      if (typeof property === 'string' && configGroups.has(property)) return Config;
      return () => {
        warnOnce(
          'Config',
          'Config.* calls do nothing in Kinetograph: there is no remotion.config.ts. Pass the options to the command (see `kinetograph render --help`).',
        );
      };
    },
  },
);
