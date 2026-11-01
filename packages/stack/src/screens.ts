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
  const { width: W, height: H, data: d } = src;
  const w = Math.max(1, Math.floor(W / 2));
  // Only the rows the slices keep: a long page's tail is left out anyway.
  const h = Math.min(Math.max(1, Math.floor(H / 2)), sliceHeight * maxSlices);
  const half = new PNG({ width: w, height: h });
  // A 2×2 box filter: each output pixel is the mean of the four it covers (the last row and
  // column repeat at an odd edge). Offsets are worked out once per column and per row.
  const col0 = new Int32Array(w);
  const col1 = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    col0[x] = Math.min(W - 1, x * 2) * 4;
    col1[x] = Math.min(W - 1, x * 2 + 1) * 4;
  }
  for (let y = 0; y < h; y++) {
    const r0 = Math.min(H - 1, y * 2) * W * 4;
    const r1 = Math.min(H - 1, y * 2 + 1) * W * 4;
    for (let x = 0; x < w; x++) {
      const a = r0 + col0[x]!;
      const b = r0 + col1[x]!;
      const e = r1 + col0[x]!;
      const f = r1 + col1[x]!;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++)
        half.data[o + c] = Math.round((d[a + c]! + d[b + c]! + d[e + c]! + d[f + c]!) / 4);
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
