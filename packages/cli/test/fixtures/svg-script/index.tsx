// Script-built SVG styled by the page's CSS, as a test fixture: `Plain` makes its shapes with document.createElementNS
// in a layout effect, `D3` with d3-selection in an effect. The rules come from a <style> tag, @media ones included.
import React,{ useEffect, useLayoutEffect, useRef } from 'react';
import { Composition, registerRoot } from 'remotion';
import { select } from 'd3-selection';

const NS = 'http://www.w3.org/2000/svg';
const css = `
  .arc { fill: none; stroke: orange; stroke-width: 8 }
  .dot { fill: #00aa00 }
  @media (min-width: 100px) { .wide { fill: #ff00ff } }
  @media (max-width: 10px) { .narrow { fill: #ff0000 } }
  .chart .bar { fill: #aa0000 }
`;

const Plain = () => {
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const svg = ref.current!;
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('class', 'arc');
    p.setAttribute('d', 'M10 80 Q 100 0 190 80');
    svg.appendChild(p);
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', 'dot');
    c.setAttribute('cx', '40');
    c.setAttribute('cy', '30');
    c.setAttribute('r', '15');
    svg.appendChild(c);
  }, []);
  return (
    <div style={{ background: '#fff', width: 400, height: 200 }}>
      <style>{css}</style>
      <svg ref={ref} width={200} height={100} viewBox="0 0 200 100">
        <rect className="wide" x={120} y={5} width={30} height={30} />
        <rect className="narrow" x={160} y={5} width={30} height={30} />
      </svg>
    </div>
  );
};

const D3 = () => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const svg = select(ref.current!).append('svg').attr('width', 200).attr('height', 100);
    svg
      .selectAll('rect')
      .data([20, 50, 80])
      .join('rect')
      .attr('class', 'bar')
      .attr('x', (_d, i) => 10 + i * 40)
      .attr('y', (d) => 100 - d)
      .attr('width', 30)
      .attr('height', (d) => d);
    svg.append('path').attr('class', 'arc').attr('d', 'M0 10 L200 10');
  }, []);
  return (
    <div ref={ref} className="chart" style={{ background: '#fff', width: 400, height: 200 }}>
      <style>{css}</style>
    </div>
  );
};

registerRoot(() => (
  <>
    <Composition id="Plain" component={Plain} width={400} height={200} fps={30} durationInFrames={5} />
    <Composition id="D3" component={D3} width={400} height={200} fps={30} durationInFrames={5} />
  </>
));
