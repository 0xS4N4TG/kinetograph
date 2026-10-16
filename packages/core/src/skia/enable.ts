// `@remotion/skia/enable`: the webpack tweak a Remotion project needs for Skia's WebAssembly. Nothing is bundled for
// Kinetograph's renderer to tweak, so the configuration is returned as it came.
export const enableSkia = <Configuration>(currentConfiguration: Configuration, _options?: { bundler?: string }): Configuration =>
  currentConfiguration;
