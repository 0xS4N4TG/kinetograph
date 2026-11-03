// What the table says about an effect beyond its status: where Kinetograph differs, and why. Edit when a gap closes.
export const NOTES = {
  curves: 'On WebGL 2 the engine has no float textures; WebGPU is used',
  shatter: 'On WebGL 2 pixels on the edges of the shards differ a little (35 dB); WebGPU is used and matches',
  tear: 'On WebGL 2 pixels on the tear\'s edge differ a little (50 dB); WebGPU is used and matches',
  scale: 'The 2D backend is approximate (32 dB: the edges of thin translucent lines blend in linear light, not in sRGB as Chrome does); WebGPU and WebGL 2 match',
  rainFall: 'On WebGL 2 the engine can\'t read a texture in the vertex shader; WebGPU is used',
  snowFall: 'On WebGL 2 the engine can\'t read a texture in the vertex shader; WebGPU is used',
  lut: 'On WebGL 2 the engine has no 3D textures; WebGPU is used',
  'star-fx3': "Shape and blur match; the vignette over the shape's transparent pixels darkens the background less than in Remotion (the same on a `<CanvasImage>` of a transparent picture, so it is the effect's alpha, not the component; 34.7 dB)",
  'img-rainFall': 'On WebGL 2 the engine can\'t read a texture in the vertex shader; WebGPU is used',
};
