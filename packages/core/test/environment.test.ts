import { describe, expect, it } from 'vitest';
import { getRemotionEnvironment } from '../src/index.js';

describe('getRemotionEnvironment', () => {
  it('reports a render everywhere, so the studio draws what the output file gets', () => {
    expect(getRemotionEnvironment()).toEqual({
      isStudio: false,
      isRendering: true,
      isPlayer: false,
      isReadOnlyStudio: false,
      isClientSideRendering: false,
    });
  });
});
