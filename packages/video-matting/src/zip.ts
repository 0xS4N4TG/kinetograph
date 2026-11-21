import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

/** One entry of a zip's central directory. */
interface ZipEntry {
  method: number;
  /** The stored (compressed) size. */
  size: number;
  offset: number;
}

/**
 * Reads named entries out of a zip file without loading the file: the central directory first, then only the bytes of
 * each entry asked for. Handles stored and deflated entries, not zip64 (a NuGet package is far below its limits).
 */
export async function readZipEntries(file: string, names: string[]): Promise<Map<string, Buffer>> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (position: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead !== length) throw new Error('the zip file is cut short');
      return buffer;
    };

    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await read(size - tailLength, tailLength);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const directory = await read(tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12));

    const entries = new Map<string, ZipEntry>();
    for (let p = 0, i = 0; i < count; i++) {
      if (directory.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
      const nameLength = directory.readUInt16LE(p + 28);
      const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
      entries.set(name, { method: directory.readUInt16LE(p + 10), size: directory.readUInt32LE(p + 20), offset: directory.readUInt32LE(p + 42) });
      p += 46 + nameLength + directory.readUInt16LE(p + 30) + directory.readUInt16LE(p + 32);
    }

    const files = new Map<string, Buffer>();
    for (const name of names) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`${name} is not in the archive`);
      const header = await read(entry.offset, 30);
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad zip entry for ${name}`);
      const data = await read(entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), entry.size);
      if (entry.method === 0) files.set(name, data);
      else if (entry.method === 8) files.set(name, inflateRawSync(data));
      else throw new Error(`${name}: unsupported zip method ${entry.method}`);
    }
    return files;
  } finally {
    await handle.close();
  }
}
