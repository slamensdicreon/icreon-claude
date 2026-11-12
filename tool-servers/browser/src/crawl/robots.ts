import { CRAWLER_NAME } from './http';
/**
 * robots.txt, read the way major crawlers read it: the group naming us (LaunchworksBot) if there
 * is one, else the group for `*`; Allow and Disallow with `*` and `$`, the longest matching rule
 * wins and Allow wins a tie. Also the sitemaps it lists and its Crawl-delay.
 */
export interface Robots {
  allows(pathAndQuery: string): boolean;
  sitemaps: string[];
  /** Seconds, when the `*` group asks for one. */
  crawlDelay: number | null;
}

interface Rule {
  allow: boolean;
  pattern: string;
  re: RegExp;
}

export const ALLOW_ALL: Robots = { allows: () => true, sitemaps: [], crawlDelay: null };

export function parseRobots(text: string): Robots {
  const sitemaps: string[] = [];
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow allows everything: no rule.
      if (!value) continue;
      current.rules.push({ allow: key === 'allow', pattern: value, re: toRegExp(value) });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }
  const named = groups.filter((g) => g.agents.includes(CRAWLER_NAME.toLowerCase()));
  const mine = named.length ? named : groups.filter((g) => g.agents.includes('*'));
  const rules = mine.flatMap((g) => g.rules);
  const delay = mine.map((g) => g.delay).find((d) => d !== null) ?? null;
  return {
    sitemaps,
    crawlDelay: delay,
    allows(path: string) {
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        if (
          !best ||
          r.pattern.length > best.pattern.length ||
          (r.pattern.length === best.pattern.length && r.allow)
        )
          best = r;
      }
      return best ? best.allow : true;
    },
  };
}

function toRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}
