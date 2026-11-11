import { afterEach, describe, expect, it, vi } from 'vitest';
import { usesGpuYuv } from '../src/gpu-yuv.js';

describe('usesGpuYuv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is for yuv420p video only', () => {
    expect(usesGpuYuv('yuv420p', undefined)).toBe(true);
    for (const format of ['yuv422p', 'yuv444p', 'yuv420p10le', 'yuva420p', 'yuva444p10le', '']) {
      expect(usesGpuYuv(format, undefined), format).toBe(false);
    }
  });

  it('is not for an image sequence', () => {
    expect(usesGpuYuv('', 'png')).toBe(false);
    expect(usesGpuYuv('yuv420p', 'jpeg')).toBe(false);
  });

  it('is off with KINETOGRAPH_CPU_YUV set', () => {
    vi.stubEnv('KINETOGRAPH_CPU_YUV', '1');
    expect(usesGpuYuv('yuv420p', undefined)).toBe(false);
  });
});
