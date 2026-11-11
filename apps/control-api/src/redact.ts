/**
 * What a Watcher doesn't see: what the work costs (spend, budgets, tokens), and anything about
 * credentials beyond their names (hints, sealed references, the scope each was granted for).
 * Values are blanked, not removed, so every answer still has the shape its contract promises.
 */

/** Amounts, wherever they appear. */
const MONEY = new Set(['usd', 'tokens', 'spentUsd', 'budgetUsd', 'weekUsd', 'costUsd', 'spendUsd']);
/** Objects that are all amounts: a project's budgets and what it has spent. */
const AMOUNTS = new Set(['budgets', 'spent']);
/** Credential details, wherever they appear. */
const SECRET_DETAIL = new Set(['hint', 'reference']);

/** Activity lines that are about money; each reads as its plain fact instead. */
const MONEY_LINES: Record<string, string> = {
  'budget.updated': 'Spend recorded',
};

/** Cypher's lines speak to the Director; a Watcher reads them about the Director. */
const VOICE = new Set(['text', 'emphasis', 'read', 'closing', 'subtitle']);
const ABOUT_THE_DIRECTOR: [RegExp, string][] = [
  [/\bOne thing is yours\b/g, 'One thing waits on the Director'],
  [/\b(\w+) things are yours\b/g, '$1 things wait on the Director'],
  [/\bNothing needs you\b/g, 'Nothing waits on the Director'],
  [/\bnothing needs you\b/g, 'nothing waits on the Director'],
  [/\bneeds you\b/g, 'needs the Director'],
  [/\bneed you\b/g, 'need the Director'],
  [/\bis yours\b/g, "is the Director's"],
  [/\bare yours\b/g, "are the Director's"],
];
const aboutTheDirector = (t: string) =>
  ABOUT_THE_DIRECTOR.reduce((x, [re, to]) => x.replace(re, to), t);

const zeroed = (v: unknown): unknown =>
  typeof v === 'number'
    ? 0
    : Array.isArray(v)
      ? v.map(zeroed)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, zeroed(x)]))
        : v;

export function redactForWatcher(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForWatcher);
  if (!value || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (MONEY.has(k) && typeof v === 'number') out[k] = 0;
    else if (AMOUNTS.has(k) && v && typeof v === 'object') out[k] = zeroed(v);
    else if (SECRET_DETAIL.has(k) && typeof v === 'string') out[k] = '';
    else if (VOICE.has(k) && typeof v === 'string') out[k] = aboutTheDirector(v);
    else out[k] = redactForWatcher(v);
  }
  const type = typeof o.type === 'string' ? o.type : null;
  if (type) {
    // An activity row's line about money.
    if (typeof out.summary === 'string') {
      if (MONEY_LINES[type]) out.summary = MONEY_LINES[type];
      else if (type === 'project.updated' && out.summary.startsWith('Budgets set'))
        out.summary = 'Budgets changed';
    }
    // A credential event: the scope names the client's environment.
    if (type.startsWith('credential.') && out.data && typeof out.data === 'object') {
      const data = out.data as Record<string, unknown>;
      if (typeof data.scope === 'string') out.data = { ...data, scope: '' };
    }
  }
  return out;
}

/** A JSON body as a Watcher receives it; anything that isn't JSON passes unchanged. */
export function redactJsonForWatcher(body: string): string {
  try {
    return JSON.stringify(redactForWatcher(JSON.parse(body)));
  } catch {
    return body;
  }
}
