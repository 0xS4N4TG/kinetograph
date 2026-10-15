// `@remotion/google-fonts/<Family>` is a module the kinetograph CLI makes when
// it bundles a project (docs/AUTHORING.md §9), so there is no file for the
// type checker to find. This declares the part of it the example uses.
declare module '@remotion/google-fonts/*' {
  export function loadFont(
    style?: string,
    options?: { weights?: string[]; subsets?: string[] },
  ): { fontFamily: string };
  export const fontFamily: string;
}
