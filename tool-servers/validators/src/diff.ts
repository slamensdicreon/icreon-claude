import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface PngDiff {
  /** Differing pixels over the larger image's area, to two decimals. */
  mismatchPercent: number;
  baseline: { width: number; height: number };
  candidate: { width: number; height: number };
  /** The candidate with differences in red; areas outside the shared region count as different. */
  png: Uint8Array;
}

/** Compares two PNGs; null if either isn't one. */
export function diffPngs(a: Uint8Array, b: Uint8Array, threshold: number): PngDiff | null {
  let base: PNG, cand: PNG;
  try {
    base = PNG.sync.read(Buffer.from(a));
    cand = PNG.sync.read(Buffer.from(b));
  } catch {
    return null;
  }
  // Full-page screenshots differ in height when content moves. Compare the shared region and
  // count everything outside it as different, so a page that grew or shrank can't pass.
  const w = Math.min(base.width, cand.width);
  const h = Math.min(base.height, cand.height);
  const crop = (img: PNG) => {
    if (img.width === w && img.height === h) return img.data;
    const out = new PNG({ width: w, height: h });
    PNG.bitblt(img, out, 0, 0, w, h, 0, 0);
    return out.data;
  };
  const shared = new PNG({ width: w, height: h });
  const inShared = pixelmatch(crop(base), crop(cand), shared.data, w, h, { threshold });

  const width = Math.max(base.width, cand.width);
  const height = Math.max(base.height, cand.height);
  const diff = new PNG({ width, height });
  for (let i = 0; i < diff.data.length; i += 4) diff.data.set([255, 0, 0, 255], i);
  PNG.bitblt(shared, diff, 0, 0, w, h, 0, 0);
  const mismatched = inShared + (width * height - w * h);
  return {
    mismatchPercent: Math.round((mismatched / (width * height)) * 10_000) / 100,
    baseline: { width: base.width, height: base.height },
    candidate: { width: cand.width, height: cand.height },
    png: new Uint8Array(PNG.sync.write(diff)),
  };
}
