/**
 * Whether the GPU converts frames to yuv420p before the readback (`Renderer.setYuv420`), for the render workers and the
 * single-thread render alike: only for yuv420p video, which is what the encoder takes, and never for an image sequence.
 * Other pixel formats (and alpha) keep the RGBA readback. `KINETOGRAPH_CPU_YUV=1` reads back RGBA and converts on the
 * CPU, for comparing.
 */
export function usesGpuYuv(convertFormat: string, sequence: unknown): boolean {
  return !sequence && convertFormat === 'yuv420p' && process.env.KINETOGRAPH_CPU_YUV === undefined;
}
