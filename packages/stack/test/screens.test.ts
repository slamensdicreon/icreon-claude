import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { sliceScreenshot } from '../src/screens';

const png = (width: number, height: number, rgb: [number, number, number]) => {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) img.data.set([...rgb, 255], i);
  return new Uint8Array(PNG.sync.write(img));
};

// Encoding and slicing full-page PNGs is CPU work: CI runs every package's tests at once on two
// cores, where the default five seconds is not enough.
describe('sliceScreenshot', { timeout: 30_000 }, () => {
  it('halves a full-page screenshot and cuts it into slices from the top', () => {
    const slices = sliceScreenshot(png(1440, 3000, [176, 22, 48])).map((s) =>
      PNG.sync.read(Buffer.from(s)),
    );
    expect(slices.map((s) => [s.width, s.height])).toEqual([
      [720, 1400],
      [720, 100],
    ]);
    expect([...slices[0]!.data.subarray(0, 4)]).toEqual([176, 22, 48, 255]);
  });

  it('keeps at most maxSlices from the top of a very long page', () => {
    expect(
      sliceScreenshot(png(200, 4000, [0, 0, 0]), { sliceHeight: 100, maxSlices: 3 }),
    ).toHaveLength(3);
  });

  it('gives exactly what the plain box filter gives, odd sizes and cut pages included', () => {
    // The filter as first written: four samples per channel, clamped at the far edges.
    const reference = (bytes: Uint8Array, sliceHeight: number, maxSlices: number) => {
      const src = PNG.sync.read(Buffer.from(bytes));
      const w = Math.max(1, Math.floor(src.width / 2));
      const h = Math.max(1, Math.floor(src.height / 2));
      const half = new PNG({ width: w, height: h });
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < 4; c++) {
            let sum = 0;
            for (const [dx, dy] of [
              [0, 0],
              [1, 0],
              [0, 1],
              [1, 1],
            ] as const) {
              const sx = Math.min(src.width - 1, x * 2 + dx);
              const sy = Math.min(src.height - 1, y * 2 + dy);
              sum += src.data[(sy * src.width + sx) * 4 + c]!;
            }
            half.data[(y * w + x) * 4 + c] = Math.round(sum / 4);
          }
      const out: Uint8Array[] = [];
      for (let top = 0; top < h && out.length < maxSlices; top += sliceHeight) {
        const sh = Math.min(sliceHeight, h - top);
        const slice = new PNG({ width: w, height: sh });
        PNG.bitblt(half, slice, 0, top, w, sh, 0, 0);
        out.push(new Uint8Array(PNG.sync.write(slice)));
      }
      return out;
    };
    let seed = 7;
    const noise = (width: number, height: number) => {
      const img = new PNG({ width, height });
      for (let i = 0; i < img.data.length; i++)
        img.data[i] = (seed = (seed * 48271) % 2147483647) & 255;
      return new Uint8Array(PNG.sync.write(img));
    };
    for (const [width, height, sliceHeight, maxSlices] of [
      [333, 1001, 140, 6],
      [1, 1, 1400, 6],
      [201, 3999, 100, 3],
      [640, 50, 1400, 6],
    ] as const) {
      const img = noise(width, height);
      const got = sliceScreenshot(img, { sliceHeight, maxSlices });
      const want = reference(img, sliceHeight, maxSlices);
      expect(got.map((b) => Buffer.from(b).toString('base64'))).toEqual(
        want.map((b) => Buffer.from(b).toString('base64')),
      );
    }
  });
});
