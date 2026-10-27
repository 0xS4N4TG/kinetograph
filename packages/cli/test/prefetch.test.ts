import { describe, expect, it } from 'vitest';
import { scanRemoteUrls } from '../src/prefetch.js';

describe('the scan of a bundle for remote files', () => {
  it('finds picture, video and audio URLs in strings and CSS url()', () => {
    const code = `
      jsx(Img, { src: "https://images.example.com/photo.JPG?w=800" });
      const css = "background: url(https://cdn.example.com/bg.webp) no-repeat; mask: url('https://cdn.example.com/m.svg#a')";
      const v = 'https://media.example.com/clip.mp4';
    `;
    expect(scanRemoteUrls(code).sort()).toEqual([
      'https://cdn.example.com/bg.webp',
      'https://cdn.example.com/m.svg#a',
      'https://images.example.com/photo.JPG?w=800',
      'https://media.example.com/clip.mp4',
    ]);
  });

  it('leaves out pages, scripts, templates with holes and the source map', () => {
    const code = [
      'const docs = "https://reactjs.org/docs/error-decoder.html?invariant=" + x;',
      'const t = `https://x.test/${name}.png`;',
      'const s = "https://cdn.example.com/lib.js";',
      '//# sourceMappingURL=data:application/json;base64,https://hidden.test/a.png',
    ].join('\n');
    expect(scanRemoteUrls(code)).toEqual([]);
  });
});
