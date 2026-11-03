// What the table says about an effect beyond its status: where Kinetograph differs, and why. Edit when a gap closes.
export const NOTES = {
  curves: 'Needs `createCurveSampler`, which Kinetograph does not have yet',
  shatter: 'Same picture; pixels on the edges of the shards differ (28 dB)',
  tear: 'Same picture; pixels on the tear\'s edge differ (39 dB)',
  scale: 'The 2D backend is approximate (32 dB); WebGPU and WebGL 2 match',
  rainFall: 'On WebGL 2 the engine can\'t read a texture in the vertex shader; WebGPU is used',
  snowFall: 'On WebGL 2 the engine can\'t read a texture in the vertex shader; WebGPU is used',
  lut: 'On WebGL 2 the engine has no 3D textures; WebGPU is used',
};
