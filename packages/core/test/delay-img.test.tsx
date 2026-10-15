// The usual hold-the-frame-until-the-picture-loads pattern: delayRender() released in <img onLoad> (docs/ENGINE.md §10.3).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { setDomAddon, setDomEnvironment } from '@kinetograph/compat/dom';
import { createSceneRoot, TimelineContext } from '@kinetograph/react';
import { continueRender, delayRender, openRenderHandles, resetRenderState } from '../src/assets.js';
import '../src/web-install.js';

describe('delayRender released by <img onLoad>', () => {
  it('does not wait for ever for a project file, nor for a missing one (onError)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-delay-'));
    mkdirSync(join(dir, 'public'));
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12);
    png.writeUInt32BE(8, 16);
    png.writeUInt32BE(8, 20);
    writeFileSync(join(dir, 'public', 'a.png'), png);
    setDomEnvironment({ baseDir: dir, publicDir: join(dir, 'public') });
    setDomAddon({ renderDomIsland: () => '{"layers":[],"unsupported":[],"camera":null}' });
    resetRenderState();

    function Held({ src }: { src: string }) {
      const [handle] = useState(() => delayRender(`img ${src}`));
      return <img src={src} onLoad={() => continueRender(handle)} onError={() => continueRender(handle)} />;
    }
    const timeline = {
      frame: 0,
      absoluteFrame: 0,
      durationInFrames: 1,
      frozen: false,
      config: { id: 'T', width: 10, height: 10, fps: 30, durationInFrames: 1, defaultProps: {}, props: {} },
    };
    const root = createSceneRoot({ viewport: { width: 10, height: 10 } });
    root.render(
      <TimelineContext.Provider value={timeline}>
        <Held src="a.png" />
        <Held src="missing.png" />
      </TimelineContext.Provider>,
    );
    expect(openRenderHandles()).toBe(0);
    root.unmount();
    setDomAddon(null);
    resetRenderState();
  });
});
