// What the table says about an effect beyond its status: where Kinetograph differs, and why. Edit when a gap closes.
export const NOTES = {
  shatter: 'On WebGL 2 pixels on the edges of the shards differ a little (35 dB); WebGPU is used and matches',
  tear: 'On WebGL 2 pixels on the tear\'s edge differ a little (50 dB); WebGPU is used and matches',
  scale: 'The 2D backend is approximate (32 dB: the edges of thin lines are resampled a little differently); WebGPU and WebGL 2 match',
};
