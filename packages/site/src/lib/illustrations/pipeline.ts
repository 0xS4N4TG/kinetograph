import { Sketch, type Diagram } from '../sketch.ts';

export const title = 'No browser in the render path';

export function build(alt: string): Diagram {
  const sk = new Sketch();
  sk.group(10, 10, 580, 664);
  // The browser that is not there: a window with a line through it.
  sk.rect(34, 30, 34, 24, { w: 1.8, roughness: 1 });
  sk.line(34, 38, 68, 38, { w: 1.5, roughness: 0.6 });
  sk.ellipse(51, 42, 42, 42, { w: 2.2 });
  sk.line(36, 27, 66, 57, { w: 2.2, roughness: 0.6 });
  sk.label({ x: 90, y: 50, text: 'No browser in the render path', size: 22, weight: 700, anchor: 'start', tone: 'ink' });

  const steps = [
    { title: 'Your project', sub: 'TSX with Remotion’s API, or an HTML page' },
    { title: 'Node runs it', sub: 'React reconciler or HyperFrames runtime' },
    { title: 'Scene JSON', sub: 'layers and DOM islands' },
    { title: 'Rust GPU compositor', sub: 'N-API addon, wgpu and Skia', bold: true },
    { title: 'FFmpeg encode', sub: 'H.264 by default, audio mixed in' },
  ];
  const w = 420;
  const x = 90;
  const h = 70;
  const ys = steps.map((_, i) => 84 + i * 104);
  steps.forEach((s, i) => sk.node(x, ys[i], w, h, { ...s, step: i + 1 }));
  const cx = x + w / 2;
  for (let i = 0; i < steps.length; i++) {
    const to = i < steps.length - 1 ? ys[i + 1] : 600;
    sk.arrow([[cx, ys[i] + h + 4], [cx, to - 4]]);
  }
  const arrowNote = (i: number, text: string) => sk.say(cx + 14, ys[i] + h + 24, text, { size: 16 });
  arrowNote(0, 'for every frame');
  arrowNote(1, 'JSON');
  arrowNote(3, 'frame pixels');

  sk.pill(150, 604, 300, 46);
  sk.label({ x: 300, y: 634, text: 'Video · out/renders/Main.mp4', size: 20, weight: 400, anchor: 'middle', tone: 'ink', fit: 280 });
  return sk.build(600, 684, alt);
}
