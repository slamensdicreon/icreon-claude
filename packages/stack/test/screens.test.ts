import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { sliceScreenshot } from '../src/screens';

const png = (width: number, height: number, rgb: [number, number, number]) => {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) img.data.set([...rgb, 255], i);
  return new Uint8Array(PNG.sync.write(img));
};

describe('sliceScreenshot', () => {
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
});
