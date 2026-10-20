/**
 * An engraving of a Kinetograph-style box camera of the 1890s: wooden body on a tripod, a brass lens, two film
 * magazines on top with a strip of film between them, and the hand crank. Drawn in a 600 x 600 space.
 */

import { COBALT, FilmStrip, Hatch, type Ink, PAPER, Reel } from './engrave';

const PRINT: Ink = { line: COBALT, ground: PAPER };

/** The camera alone, in its own 600 x 600 space. `idp` keeps clip-path ids unique when it is drawn twice. */
export function Camera({ idp = 'cam' }: { idp?: string }) {
  const box = 'M170 250 L430 250 L430 420 L170 420Z';
  const grain = Array.from({ length: 15 }, (_, k) => {
    const y = 262 + k * 10.5;
    return `M176 ${y} C240 ${y + 4 * Math.sin(k)} 300 ${y - 3} 360 ${y + 2 * Math.cos(k * 1.7)} S410 ${y + 1} 424 ${y}`;
  }).join(' ');
  return (
    <g stroke={COBALT} strokeLinejoin="round" strokeLinecap="round">
      {/* tripod */}
      <g fill={PAPER} strokeWidth={1.3}>
        <path d="M258 420 L190 578 L202 580 L272 420Z" />
        <path d="M342 420 L410 578 L398 580 L328 420Z" />
        <path d="M294 420 L294 586 L306 586 L306 420Z" />
        <path d="M206 520 L394 520" fill="none" strokeWidth={1} />
        <rect x={240} y={420} width={120} height={14} />
      </g>
      <Hatch id={`${idp}-cam-leg`} clip="M328 420 L410 578 L398 580 L342 420Z M294 420 L294 586 L300 586 L300 420Z" x0={290} y0={420} x1={410} y1={590} gap={3} angle={0.3} ink={PRINT} width={0.6} />

      {/* film magazines, behind the body */}
      <Reel x={236} y={196} r={66} ink={PRINT} className="kg-spin" />
      <Reel x={368} y={196} r={66} ink={PRINT} className="kg-spin" />
      <FilmStrip p0={[236, 262]} c1={[260, 300]} c2={[340, 300]} p1={[368, 262]} width={18} frames={5} ink={PRINT} />

      {/* body */}
      <path d={box} fill={PAPER} strokeWidth={1.8} />
      <path d={grain} fill="none" strokeWidth={0.6} opacity={0.7} />
      <Hatch id={`${idp}-cam-shade`} clip="M398 250 L430 250 L430 420 L398 420Z" x0={398} y0={250} x1={430} y1={420} gap={2.6} angle={0} ink={PRINT} width={0.7} />
      <path d="M170 250 L190 236 L446 236 L430 250Z" fill={PAPER} strokeWidth={1.4} />
      <path d="M430 250 L446 236 L446 404 L430 420Z" fill={PAPER} strokeWidth={1.4} />
      <Hatch id={`${idp}-cam-side`} clip="M430 250 L446 236 L446 404 L430 420Z" x0={430} y0={236} x1={446} y1={420} gap={2.2} angle={0} ink={PRINT} width={0.7} />
      {[[176, 256], [414, 256], [176, 404], [414, 404]].map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width={10} height={10} fill={PAPER} strokeWidth={1} />)}

      {/* maker's plate */}
      <rect x={250} y={316} width={100} height={46} rx={3} fill={PAPER} strokeWidth={1.3} />
      <rect x={256} y={322} width={88} height={34} rx={2} fill="none" strokeWidth={0.8} />
      <path d="M268 334 L332 334 M274 344 L326 344" strokeWidth={1} />
      {[[262, 328], [338, 328], [262, 350], [338, 350]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r={1.6} fill={COBALT} />)}

      {/* lens */}
      <g fill={PAPER} strokeWidth={1.3}>
        <rect x={150} y={296} width={20} height={70} />
        <rect x={110} y={304} width={40} height={54} />
        <rect x={84} y={312} width={26} height={38} />
        <ellipse cx={84} cy={331} rx={8} ry={19} />
        <ellipse cx={84} cy={331} rx={4} ry={11} fill="none" strokeWidth={0.8} />
      </g>
      <Hatch id={`${idp}-lens-1`} clip="M110 340 L150 340 L150 358 L110 358Z M84 338 L110 338 L110 350 L84 350Z" x0={84} y0={330} x1={150} y1={360} gap={2.2} angle={0} ink={PRINT} width={0.7} />
      <path d="M118 304 L118 358 M128 304 L128 358 M138 304 L138 358" strokeWidth={0.6} />

      {/* crank */}
      <g fill={PAPER} strokeWidth={1.4}>
        <circle cx={466} cy={334} r={16} />
        <circle cx={466} cy={334} r={6} fill={COBALT} />
        <path d="M466 334 L512 286" strokeWidth={5} />
        <path d="M466 334 L512 286" strokeWidth={2.4} stroke={PAPER} />
        <rect x={506} y={262} width={12} height={30} rx={5} />
        <path d="M446 334 L466 334" strokeWidth={4} />
      </g>
      {/* gear train peeking through the side */}
      <circle cx={466} cy={334} r={24} fill="none" strokeWidth={0.8} strokeDasharray="3 3" />
    </g>
  );
}
