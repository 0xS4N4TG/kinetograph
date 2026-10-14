// Orchestrator scaffolding (docs/AUTHORING.md §7.5): `@remotion/google-fonts/<Family>`: `makeGoogleFont(familyName)` returns that module. Stream 2
// (`feat/remotion-shim`) implements it from Remotion's documented behaviour
// and types the exports properly; the names below are the contract.

export function makeGoogleFont(...args: any[]): any {
  throw new Error(`not implemented: makeGoogleFont(${args.length} args) (@kinetograph/core, stream 2)`);
}
