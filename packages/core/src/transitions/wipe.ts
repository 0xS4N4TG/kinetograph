// Orchestrator scaffolding (docs/AUTHORING.md §7.5): `@remotion/transitions/wipe`. Stream 2
// (`feat/remotion-shim`) implements it from Remotion's documented behaviour
// and types the exports properly; the names below are the contract.

export function wipe(...args: any[]): any {
  throw new Error(`not implemented: wipe(${args.length} args) (@kinetograph/core, stream 2)`);
}
