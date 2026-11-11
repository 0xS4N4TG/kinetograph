import { describe, expect, it } from 'vitest';
import { gpuBound } from '../src/parallel-render.js';

describe('gpuBound', () => {
  it('is for workers that wait on the GPU more than half their time', () => {
    // Shares measured with 4 workers on an M4: a film of drop-shadows and noise filters (0.6), the same with its effects
    // left out (0.3), and DOM pages whose time goes on their JS (0.05 and under).
    expect(gpuBound(600, 1000)).toBe(true);
    expect(gpuBound(300, 1000)).toBe(false);
    expect(gpuBound(50, 1000)).toBe(false);
    expect(gpuBound(500, 1000)).toBe(false);
    expect(gpuBound(501, 1000)).toBe(true);
  });

  it('is not for frames with no wait', () => {
    expect(gpuBound(0, 1000)).toBe(false);
    expect(gpuBound(0, 0)).toBe(false);
  });
});
