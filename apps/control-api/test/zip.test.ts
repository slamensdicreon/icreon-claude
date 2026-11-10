import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zip } from '../src/zip';

/** Reads a zip back through its central directory, as unzip tools do. */
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(at + 26);
    const body = buf.subarray(at + 30 + localNameLen, at + 30 + localNameLen + size);
    out[name] = (method === 8 ? inflateRawSync(body) : body).toString('utf8');
    p += 46 + nameLen;
  }
  return out;
}

describe('zip', () => {
  it('writes files that read back exactly, deflated or stored', () => {
    const long = '# Page inventory\n\n' + 'Home, About, Contact. '.repeat(200);
    const files = {
      'documents/page-inventory-v3.md': long,
      'documents/naïve-café.json': '{"a":1}',
      'README.txt': 'x',
    };
    const buf = zip(
      Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') })),
    );
    expect(unzip(buf)).toEqual(files);
    expect(buf.length).toBeLessThan(long.length);
  });
});
