// The pixel size of an image file from its header, for `new Image()`'s `naturalWidth` and `<img>` refs. PNG, JPEG,
// GIF, WebP, BMP and SVG (width/height or viewBox); nothing is decoded.

export function imageSizeOfBytes(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const u16be = (o: number): number => (b[o]! << 8) | b[o + 1]!;
  const u32be = (o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  const u16le = (o: number): number => b[o]! | (b[o + 1]! << 8);
  const u24le = (o: number): number => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
  const ascii = (o: number, n: number): string => String.fromCharCode(...b.slice(o, o + n));

  // PNG: signature, then the IHDR chunk.
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return { width: u32be(16), height: u32be(20) };
  // GIF: logical screen descriptor.
  if (b.length >= 10 && ascii(0, 3) === 'GIF') return { width: u16le(6), height: u16le(8) };
  // BMP: BITMAPINFOHEADER.
  if (b.length >= 26 && ascii(0, 2) === 'BM') {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  // JPEG: walk the markers to a start-of-frame.
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const length = u16be(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(o + 7), height: u16be(o + 5) };
      }
      o += 2 + length;
    }
    return null;
  }
  // WebP: RIFF container, lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (kind === 'VP8L') {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
  }
  // SVG: the root element's size.
  const head = new TextDecoder().decode(b.slice(0, 2048));
  const svg = /<svg\b([^>]*)>/i.exec(head);
  if (svg) {
    const attr = (name: string): number | null => {
      const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, 'i').exec(svg[1]!);
      return m ? Number(m[1]) : null;
    };
    const w = attr('width');
    const h = attr('height');
    if (w !== null && h !== null) return { width: w, height: h };
    const box = /viewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(svg[1]!);
    if (box) return { width: Number(box[1]), height: Number(box[2]) };
  }
  return null;
}
