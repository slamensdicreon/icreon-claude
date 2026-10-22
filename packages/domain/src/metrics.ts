import type { MetricKey } from '@lw/contracts';

const PERCENT: ReadonlySet<MetricKey> = new Set(['qa_pass', 'parity']);

export function metricUnit(key: MetricKey): 'count' | 'percent' {
  return PERCENT.has(key) ? 'percent' : 'count';
}
