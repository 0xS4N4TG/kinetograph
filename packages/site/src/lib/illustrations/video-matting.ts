import { Sketch, type Diagram } from '../sketch.ts';

export const title = 'Video matting';

/** A head and shoulders in pencil shading. */
function person(sk: Sketch, cx: number, bottom: number, scale = 1) {
  const r = 14 * scale;
  const hy = bottom - 50 * scale;
  sk.hatch(
    `M${cx - 30 * scale} ${bottom} C${cx - 30 * scale} ${bottom - 26 * scale} ${cx - 14 * scale} ${bottom - 30 * scale} ${cx} ${bottom - 30 * scale} ` +
      `C${cx + 14 * scale} ${bottom - 30 * scale} ${cx + 30 * scale} ${bottom - 26 * scale} ${cx + 30 * scale} ${bottom} Z`,
  );
  sk.hatch(
    `M${cx - r} ${hy} C${cx - r} ${hy - r * 1.4} ${cx + r} ${hy - r * 1.4} ${cx + r} ${hy} C${cx + r} ${hy + r * 1.4} ${cx - r} ${hy + r * 1.4} ${cx - r} ${hy} Z`,
  );
  sk.ellipse(cx, hy, r * 2, r * 2, { w: 1.8 });
}

export function build(alt: string): Diagram {
  const sk = new Sketch();
  sk.node(20, 72, 130, 66, { title: 'Video', sub: 'original.mp4' });
  sk.node(190, 72, 170, 66, { title: 'Model', sub: 'once, before render', bold: true });
  sk.node(410, 20, 180, 64, { title: 'Foreground', sub: 'subject with alpha' });
  sk.node(410, 126, 180, 64, { title: 'Base', sub: 'original, opaque' });
  sk.arrow([[156, 105], [184, 105]]);
  sk.arrow([[366, 105], [386, 105], [386, 52], [404, 52]], { r: 10 });
  sk.arrow([[386, 105], [386, 158], [404, 158]], { r: 10 });

  const xs = [30, 180, 330, 480];
  const y = 236;
  const w = 100;
  const h = 92;
  xs.forEach((x, i) => sk.rect(x, y, w, h, { dash: i === 2 ? '7 6' : undefined }));
  person(sk, xs[0] + w / 2, y + h - 6);
  sk.label({ x: xs[1] + 12, y: y + 58, text: 'BEHIND', size: 22, weight: 700, anchor: 'start', tone: 'ink' });
  person(sk, xs[2] + w / 2, y + h - 6);
  sk.label({ x: xs[3] + 8, y: y + 58, text: 'BEH', size: 22, weight: 700, anchor: 'start', tone: 'ink' });
  sk.label({ x: xs[3] + w - 8, y: y + 58, text: 'D', size: 22, weight: 700, anchor: 'end', tone: 'ink' });
  person(sk, xs[3] + w / 2, y + h - 6);

  for (const cx of [155, 305]) {
    sk.line(cx - 10, y + 46, cx + 10, y + 46, { w: 2.6, roughness: 0.6 });
    sk.line(cx, y + 36, cx, y + 56, { w: 2.6, roughness: 0.6 });
  }
  for (const cx of [455]) {
    sk.line(cx - 10, y + 40, cx + 10, y + 40, { w: 2.6, roughness: 0.6 });
    sk.line(cx - 10, y + 52, cx + 10, y + 52, { w: 2.6, roughness: 0.6 });
  }

  [
    ['base', 'bottom'],
    ['text', 'middle'],
    ['foreground', 'top'],
  ].forEach(([name, sub], i) => {
    sk.label({ x: xs[i] + w / 2, y: y + h + 28, text: name, size: 22, weight: 700, anchor: 'middle', tone: 'ink' });
    sk.say(xs[i] + w / 2, y + h + 52, sub, { anchor: 'middle' });
  });
  sk.label({ x: xs[3] + w / 2, y: y + h + 28, text: 'result', size: 22, weight: 700, anchor: 'middle', tone: 'ink' });
  sk.say(xs[3] + w / 2, y + h + 52, 'text behind', { anchor: 'middle' });
  sk.say(xs[3] + w / 2, y + h + 72, 'subject', { anchor: 'middle' });

  sk.say(30, 468, 'Rendering never runs the model, so every render comes out the same.');
  return sk.build(600, 496, alt);
}
