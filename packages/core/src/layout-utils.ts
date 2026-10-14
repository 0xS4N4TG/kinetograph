// Orchestrator scaffolding (docs/AUTHORING.md §7.5): `@remotion/layout-utils`. Stream 2
// (`feat/remotion-shim`) implements it from Remotion's documented behaviour
// and types the exports properly; the names below are the contract.

export function measureText(...args: any[]): any {
  throw new Error(`not implemented: measureText(${args.length} args) (@kinetograph/core, stream 2)`);
}

export function fitText(...args: any[]): any {
  throw new Error(`not implemented: fitText(${args.length} args) (@kinetograph/core, stream 2)`);
}

export function fillTextBox(...args: any[]): any {
  throw new Error(`not implemented: fillTextBox(${args.length} args) (@kinetograph/core, stream 2)`);
}
