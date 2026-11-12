// A check of the frame's layout that is answered by the render that draws the frame, not by a readback of its own. A
// readback sends the tree to the addon, styles and lays it out, and reads the answer back before the frame's render
// does the same work again on what is by then the same tree. A check that only has to say something about the frame
// (a warning) asks the render that draws it: the addon reports each asked element's size and overflow from the layout it
// draws (`probes` of `renderDomIsland`), and the answer is handed to the callback as the frame's tree is emitted.
// A check is made for every frame that is drawn, and none for a frame that is only played through (that is never drawn).

/** What the render reports of an element it drew (`Probe` of crates/dom/src/request.rs). */
export interface LayoutProbe {
  /** The size `getBoundingClientRect` gives. */
  width: number;
  height: number;
  /** The computed `overflow-x` and `overflow-y`. */
  overflowX: string;
  overflowY: string;
}

/** Gets the element's probe, or null when the frame's render did not draw it (or the addon cannot probe). */
export type ProbeAnswer = (probe: LayoutProbe | null) => void;

const asked = new WeakMap<object, ProbeAnswer>();

/** Asks the render that draws the frame for `host`'s probe: `answer` is called once, as the frame's tree is emitted. A later ask of the same element replaces this one. */
export function probeOnDraw(host: object, answer: ProbeAnswer): void {
  asked.set(host, answer);
}

/** The answer asked for `host`, taken: the emit that draws the element's island calls it with the island's output. */
export function takeProbe(host: object): ProbeAnswer | undefined {
  const answer = asked.get(host);
  if (answer !== undefined) asked.delete(host);
  return answer;
}
