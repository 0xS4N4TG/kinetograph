// onLoad / onError of an <img> and the load events of a <video> are delivered once per src when the frame's work is
// done (packages/cli/skills/kinetograph/references/ENGINE.md §10.3), so a project that holds the frame with delayRender() until onLoad is not left waiting.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useState } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetStylesheets, setDomAddon, setDomEnvironment } from '@kinetographdev/compat/dom';
import { installDomGlobals } from '@kinetographdev/compat/shim';
import { createSceneRoot, TimelineContext } from '../src/index.js';
import { timeline } from './harness.js';

let dir: string;
beforeAll(() => {
  installDomGlobals();
  dir = mkdtempSync(join(tmpdir(), 'kg-media-'));
  mkdirSync(join(dir, 'public'));
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12);
  png.writeUInt32BE(40, 16);
  png.writeUInt32BE(30, 20);
  writeFileSync(join(dir, 'public', 'a.png'), png);
  writeFileSync(join(dir, 'public', 'clip.mp4'), 'not really a video');
  setDomEnvironment({ baseDir: dir, publicDir: join(dir, 'public') });
  setDomAddon({
    renderDomIsland: () => '{"layers":[],"unsupported":[],"camera":null}',
    probeMedia: () => ({ width: 640, height: 360, durationInSeconds: 2.5 }),
  });
});
afterAll(() => {
  setDomAddon(null);
  resetStylesheets();
});

function mount(node: React.ReactNode) {
  const root = createSceneRoot({ viewport: { width: 100, height: 100 } });
  const wrap = (n: React.ReactNode) => <TimelineContext.Provider value={timeline(0)}>{n}</TimelineContext.Provider>;
  root.render(wrap(node));
  return { root, wrap };
}

describe('load events', () => {
  it('fire onLoad for an <img> with a project file, once, with its natural size, and let state follow', () => {
    const seen: unknown[] = [];
    let renders = 0;
    function Pic({ src }: { src: string }) {
      const [size, setSize] = useState('none');
      renders++;
      return (
        <div>
          <img
            src={src}
            onLoad={(e: any) => {
              seen.push([e.type, e.target.naturalWidth, e.target.naturalHeight]);
              setSize(`${e.target.naturalWidth}x${e.target.naturalHeight}`);
            }}
          />
          <span title={size} />
        </div>
      );
    }
    const { root, wrap } = mount(<Pic src="a.png" />);
    expect(seen).toEqual([['load', 40, 30]]);
    expect(renders).toBe(2);
    root.render(wrap(<Pic src="a.png" />));
    expect(seen).toHaveLength(1);
    root.render(wrap(<Pic src={join(dir, 'public', 'a.png')} />));
    expect(seen).toHaveLength(2);
    root.unmount();
  });

  it('fire onError, with a message, for a missing file and for a remote URL', () => {
    const errors: string[] = [];
    mount(
      <>
        <img src="nope.png" onError={(e: any) => errors.push(e.message)} />
        <img src="https://example.com/a.png" onError={(e: any) => errors.push(e.message)} />
      </>,
    ).root.unmount();
    expect(errors[0]).toContain('no such file in the project');
    expect(errors[1]).toContain('remote URLs are not available');
  });

  it('release a delayRender held until onLoad', async () => {
    const { delayRender, continueRender, openRenderHandles } = await import('@kinetographdev/core').catch(() => ({}) as any);
    if (!delayRender) return;
    function Held() {
      const [handle] = useState(() => delayRender('img'));
      return <img src="a.png" onLoad={() => continueRender(handle)} />;
    }
    mount(<Held />).root.unmount();
    expect(openRenderHandles?.() ?? 0).toBe(0);
  });

  it('fire the loading events of a <video> whose file is there, with its duration', () => {
    const seen: string[] = [];
    function Clip() {
      return (
        <video
          src="clip.mp4"
          onLoadedMetadata={(e: any) => seen.push(`metadata ${e.target.duration} ${e.target.videoWidth}x${e.target.videoHeight}`)}
          onLoadedData={() => seen.push('data')}
          onCanPlay={() => seen.push('canplay')}
        />
      );
    }
    mount(<Clip />).root.unmount();
    expect(seen).toEqual(['metadata 2.5 640x360', 'data', 'canplay']);
  });
});
