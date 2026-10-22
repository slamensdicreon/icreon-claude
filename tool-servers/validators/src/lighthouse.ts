import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';

export interface LighthouseSummary {
  url: string;
  finalUrl: string;
  formFactor: 'mobile' | 'desktop';
  /** 0–100, null where Lighthouse could not score the category. */
  scores: {
    performance: number | null;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
  };
  metrics: {
    lcpMs: number | null;
    cls: number | null;
    tbtMs: number | null;
    fcpMs: number | null;
    speedIndexMs: number | null;
  };
  /** Failing audits, the ones that cost the most score first. */
  failing: { id: string; category: string; title: string; displayValue: string | null }[];
}

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];

/** One Lighthouse run in a fresh headless Chrome whose traffic goes through the egress proxy. */
export async function runLighthouse(
  url: string,
  formFactor: 'mobile' | 'desktop',
  opts: { chromePath?: string; proxyFlags: string[] },
): Promise<LighthouseSummary | { error: string }> {
  const chrome = await chromeLauncher.launch({
    chromePath: opts.chromePath,
    chromeFlags: ['--headless=new', '--no-sandbox', ...opts.proxyFlags],
  });
  try {
    const result = await lighthouse(
      url,
      { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: CATEGORIES },
      formFactor === 'desktop'
        ? {
            extends: 'lighthouse:default',
            settings: {
              formFactor: 'desktop',
              screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1 },
              throttling: { rttMs: 40, throughputKbps: 10_240, cpuSlowdownMultiplier: 1 },
            },
          }
        : undefined,
    );
    const lhr = result?.lhr;
    if (!lhr) return { error: 'Lighthouse returned no report' };
    if (lhr.runtimeError) return { error: lhr.runtimeError.message };
    const score = (id: string) => {
      const s = lhr.categories[id]?.score;
      return s == null ? null : Math.round(s * 100);
    };
    const metric = (id: string) => lhr.audits[id]?.numericValue ?? null;
    const failing = Object.entries(lhr.categories).flatMap(([category, c]) =>
      c.auditRefs
        .filter((r) => r.weight > 0)
        .map((r) => ({ r, a: lhr.audits[r.id]! }))
        .filter(({ a }) => a.score !== null && a.score < 0.9)
        .map(({ r, a }) => ({
          cost: r.weight * (1 - a.score!),
          id: a.id,
          category,
          title: a.title,
          displayValue: a.displayValue ?? null,
        })),
    );
    return {
      url,
      finalUrl: lhr.finalDisplayedUrl,
      formFactor,
      scores: {
        performance: score('performance'),
        accessibility: score('accessibility'),
        bestPractices: score('best-practices'),
        seo: score('seo'),
      },
      metrics: {
        lcpMs: metric('largest-contentful-paint'),
        cls: metric('cumulative-layout-shift'),
        tbtMs: metric('total-blocking-time'),
        fcpMs: metric('first-contentful-paint'),
        speedIndexMs: metric('speed-index'),
      },
      failing: failing
        .sort((x, y) => y.cost - x.cost)
        .slice(0, 12)
        .map(({ cost: _, ...f }) => f),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
  } finally {
    await chrome.kill();
  }
}
