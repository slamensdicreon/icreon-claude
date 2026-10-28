import { PNG } from 'pngjs';

/**
 * Cuts a full-page screenshot into slices a model can read: halved in each dimension (a 1440px
 * desktop page becomes 720px wide), then cut every `sliceHeight` rows. At most `maxSlices`, so a
 * very long page costs a bounded number of images; the rest of the page is left out.
 */
export function sliceScreenshot(
  png: Uint8Array,
  opts: { sliceHeight?: number; maxSlices?: number } = {},
): Uint8Array[] {
  const sliceHeight = opts.sliceHeight ?? 1400;
  const maxSlices = opts.maxSlices ?? 6;
  const src = PNG.sync.read(Buffer.from(png));
  const w = Math.max(1, Math.floor(src.width / 2));
  const h = Math.max(1, Math.floor(src.height / 2));
  const half = new PNG({ width: w, height: h });
  // A 2×2 box filter: each output pixel is the mean of the four it covers.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
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
        half.data[o + c] = Math.round(sum / 4);
      }
    }
  }
  const out: Uint8Array[] = [];
  for (let top = 0; top < h && out.length < maxSlices; top += sliceHeight) {
    const sh = Math.min(sliceHeight, h - top);
    const slice = new PNG({ width: w, height: sh });
    PNG.bitblt(half, slice, 0, top, w, sh, 0, 0);
    out.push(new Uint8Array(PNG.sync.write(slice)));
  }
  return out;
}
