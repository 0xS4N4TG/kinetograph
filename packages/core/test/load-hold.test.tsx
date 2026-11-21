// A load the page starts while a frame is prepared holds the frame (images, fetches, bitmaps); a Suspense of the page's own
// that the load was for is revealed before the frame is read; a canvas draws after the loads (canvas-draws.ts); a load that
// fails is reported with its URL.

import { Suspense, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Rect } from '@kinetographdev/react';
import { trackPending } from '@kinetographdev/compat/shim';
import { PAGE_LOAD_LABEL, continueRender, delayRender, resetRenderState } from '../src/assets.js';
import { drawWhenSettled } from '../src/canvas-draws.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, realTimers, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import '../src/web-install.js';

beforeEach(() => {
  resetCompositions();
  resetRenderState();
  installDeterminism();
  resetVirtualClock();
});
afterEach(() => {
  uninstallDeterminism();
  resetRenderState();
});

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

type Picture = { onload: (() => void) | null; src: string; complete: boolean };
const Img = (globalThis as unknown as { Image: new () => Picture }).Image;

/** The ids of the layers of a frame. */
async function ids(frame = 0) {
  const result = await createFrameRenderer('T').renderFrame(frame);
  return { result, ids: JSON.stringify(result) };
}

function root(component: React.FC) {
  registerRoot(() => <Composition id="T" component={component} width={16} height={16} fps={30} durationInFrames={5} />);
}

describe('loads the page starts', () => {
  it('reveals a Suspense of the page whose image finished loading, in the frame it was started', async () => {
    let done = false;
    let promise: Promise<void> | null = null;
    const Reveal = () => {
      promise ??= new Promise<void>((resolve) => {
        const img = new Img();
        img.onload = () => ((done = true), resolve());
        img.src = PIXEL;
      });
      if (!done) throw promise;
      return <Rect id="revealed" width={4} height={4} fill="#fff" />;
    };
    root(() => (
      <Suspense fallback={null}>
        <Reveal />
      </Suspense>
    ));
    expect((await ids()).ids).toContain('revealed');
  });

  it('runs a draw asked for by a canvas after the images the frame loads are there', async () => {
    const seen: boolean[] = [];
    const Canvas = () => {
      useEffect(() => {
        const img = new Img();
        img.src = PIXEL;
        drawWhenSettled(Symbol('c'), () => seen.push(img.complete));
      });
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    };
    root(Canvas);
    await ids();
    expect(seen).toEqual([true]);
  });

  it('reports a load that failed, with its URL', async () => {
    const Missing = () => {
      useEffect(() => {
        const img = new Img();
        img.src = 'no-such-picture.png';
      }, []);
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    };
    root(Missing);
    const { result } = await ids();
    expect(result.unsupported.some((u) => u.property === 'load' && String(u.value).includes('no-such-picture.png'))).toBe(true);
  });

  it('gives the animation-frame callbacks of a frame one run while the page scripts load, however long that takes', async () => {
    let runs = 0;
    const Page = () => {
      useEffect(() => {
        const handle = delayRender(PAGE_LOAD_LABEL);
        const loop = () => {
          runs++;
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        // A read of a file that takes some turns of the event loop: the number of turns is not the page's clock.
        void trackPending(new Promise<void>((resolve) => realTimers.setTimeout(resolve, 60))).then(() => continueRender(handle));
      }, []);
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    };
    root(Page);
    await ids();
    expect(runs).toBe(1);
  });

  it('runs the callbacks when the page scripts wait for a frame and nothing is loading', async () => {
    let finished = false;
    const Page = () => {
      useEffect(() => {
        const handle = delayRender(PAGE_LOAD_LABEL);
        // A script that awaits a frame before it finishes loading: only a callback can release the hold.
        requestAnimationFrame(() => {
          finished = true;
          continueRender(handle);
        });
      }, []);
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    };
    root(Page);
    await ids();
    expect(finished).toBe(true);
  });

  it('runs a page that animates and keeps render targets once per frame in a still, as in a render of every frame', async () => {
    let runs = 0;
    const Page = () => {
      useEffect(() => {
        // A trail: each frame draws a target from the one the frame before drew (the two swap).
        const gl = document.createElement('canvas').getContext('webgl2')!;
        const shader = (type: number, source: string) => {
          const made = gl.createShader(type)!;
          gl.shaderSource(made, source);
          gl.compileShader(made);
          return made;
        };
        const program = gl.createProgram()!;
        gl.attachShader(program, shader(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p;out vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0,1);}'));
        gl.attachShader(program, shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;in vec2 uv;uniform sampler2D prev;out vec4 o;void main(){o=texture(prev,uv)+vec4(.1,0,0,0);}'));
        gl.linkProgram(program);
        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        const target = () => {
          const texture = gl.createTexture()!;
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          const framebuffer = gl.createFramebuffer()!;
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          return { texture, framebuffer };
        };
        const pair = [target(), target()];
        let current = 0;
        const loop = () => {
          runs++;
          const from = pair[current]!;
          current = 1 - current;
          gl.bindFramebuffer(gl.FRAMEBUFFER, pair[current]!.framebuffer);
          gl.bindTexture(gl.TEXTURE_2D, from.texture);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }, []);
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    };
    root(Page);
    await createFrameRenderer('T').renderFrame(3);
    // The page's own state (a count, a rotation) cannot be put back: a render that found the targets after stepping, and
    // started over, would have run the callbacks twice.
    expect(runs).toBe(4);
  });
  it('runs the callbacks of a page with a CSS transition once per frame in a still, as in a render of every frame', async () => {
    let runs = 0;
    const Page = () => {
      useEffect(() => {
        const loop = () => {
          runs++;
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }, []);
      // The transition makes the frame look back over a window of frames, which a replay of it would run the callbacks for again.
      return <div id="r" style={{ position: 'absolute', left: 0, top: 0, width: 4, height: 4, background: '#f00', transition: 'opacity 1s linear' }} />;
    };
    root(Page);
    await createFrameRenderer('T').renderFrame(3);
    expect(runs).toBe(4);
  });
});
