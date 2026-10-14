// Orchestrator scaffolding (docs/AUTHORING.md §7.5): `@remotion/transitions`. Stream 2
// (`feat/remotion-shim`) implements it from Remotion's documented behaviour
// and types the exports properly; the names below are the contract.

export function TransitionSeriesImpl(...args: any[]): any {
  throw new Error(`not implemented: TransitionSeries(${args.length} args) (@kinetograph/core, stream 2)`);
}

export function linearTiming(...args: any[]): any {
  throw new Error(`not implemented: linearTiming(${args.length} args) (@kinetograph/core, stream 2)`);
}

export function springTiming(...args: any[]): any {
  throw new Error(`not implemented: springTiming(${args.length} args) (@kinetograph/core, stream 2)`);
}

export const TransitionSeries = Object.assign(TransitionSeriesImpl, {
  Sequence: TransitionSeriesImpl,
  Transition: TransitionSeriesImpl,
  Overlay: TransitionSeriesImpl,
});
