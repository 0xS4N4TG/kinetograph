// Orchestrator scaffolding (docs/AUTHORING.md §7.5): `@remotion/transitions/fade`. Stream 2
// (`feat/remotion-shim`) implements it from Remotion's documented behaviour
// and types the exports properly; the names below are the contract.

export function fade(...args: any[]): any {
  throw new Error(`not implemented: fade(${args.length} args) (@kinetograph/core, stream 2)`);
}
