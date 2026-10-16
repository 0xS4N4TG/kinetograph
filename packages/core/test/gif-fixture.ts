// A GIF whose structure is real (header, colour table, graphic control extensions, image descriptors) and whose
// pictures are one pixel of data each: enough for code that reads a GIF's timing, not for decoding it.

/** `delaysCs` are the pictures' delays in hundredths of a second, as the file stores them. */
export function makeGif(delaysCs: number[], width = 4, height = 3): Uint8Array {
  const bytes: number[] = [...Buffer.from('GIF89a'), width & 255, width >> 8, height & 255, height >> 8, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  for (const delay of delaysCs) {
    bytes.push(0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0);
    bytes.push(0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0);
    bytes.push(2, 2, 0x44, 0x01, 0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
