// Orchestrator scaffolding (docs/AUTHORING.md §7.5): `@remotion/motion-blur`. Stream 2
// (`feat/remotion-shim`) implements it from Remotion's documented behaviour
// and types the exports properly; the names below are the contract.

export function Trail(...args: any[]): any {
  throw new Error(`not implemented: Trail(${args.length} args) (@kinetograph/core, stream 2)`);
}

export function CameraMotionBlur(...args: any[]): any {
  throw new Error(`not implemented: CameraMotionBlur(${args.length} args) (@kinetograph/core, stream 2)`);
}
