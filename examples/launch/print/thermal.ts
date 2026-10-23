// A thermal-printer photo: the picture is cut to a coarse grid of dots, its contrast crushed, and each dot printed or
// left blank by an 8x8 Bayer threshold, as a receipt printer's head does. A row-by-row noise and a few streaks (the
// head's weak and hot spots), and a reveal line that moves down as the paper feeds.

export const THERMAL = `precision highp float;
uniform vec2 u_res;       // the photo's box, px
uniform vec2 u_img_size;  // the picture, px
uniform sampler2D u_img;
uniform float u_dot;      // one printed dot, px
uniform float u_reveal;   // 0..1: how much of the photo has printed, from the top
uniform float u_seed;
uniform float u_mid;      // luma that becomes the middle grey, then the contrast about it
uniform float u_contrast;
uniform float u_bias;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float b2(vec2 p) { return 2.0 * p.x + 3.0 * p.y - 4.0 * p.x * p.y; }
float bayer8(vec2 c) {
  vec2 a = mod(c, 2.0);
  vec2 b = mod(floor(c / 2.0), 2.0);
  vec2 d = mod(floor(c / 4.0), 2.0);
  return (16.0 * b2(a) + 4.0 * b2(b) + b2(d) + 0.5) / 64.0;
}
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 cell = floor(frag / u_dot);
  vec2 local = fract(frag / u_dot) - 0.5;
  vec2 cuv = (cell + 0.5) * u_dot / u_res;
  // cover fit
  float ba = u_res.x / u_res.y;
  float ia = u_img_size.x / u_img_size.y;
  vec2 uv = cuv - 0.5;
  if (ia > ba) uv.x *= ba / ia; else uv.y *= ia / ba;
  uv += 0.5;
  vec3 col = texture2D(u_img, uv).rgb;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  // the head: a weak or hot row, and a few weak columns
  float rowN = hash(vec2(cell.y, u_seed));
  float colN = hash(vec2(cell.x, u_seed + 7.0));
  l += (rowN - 0.5) * 0.12;
  if (colN > 0.965) l += 0.22;
  if (hash(vec2(cell.y * 0.5, u_seed + 3.0)) > 0.985) l += 0.3;
  l = (l - u_mid) * u_contrast + 0.5 + u_bias;
  l = smoothstep(0.1, 0.9, l);
  float ink = l < bayer8(cell) ? 1.0 : 0.0;
  // a printed dot is a rounded square with a gap round it
  ink *= step(max(abs(local.x), abs(local.y)), 0.44);
  ink *= 0.84 + 0.16 * hash(cell + u_seed);
  float printed = step(frag.y / u_res.y, u_reveal);
  ink *= printed;
  vec3 paper = vec3(0.975, 0.97, 0.952);
  vec3 black = vec3(0.075, 0.075, 0.085);
  gl_FragColor = vec4(mix(paper, black, ink), 1.0);
}
`;
