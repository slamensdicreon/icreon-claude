/**
 * `fn` over `items`, at most `limit` calls at a time, with the results in the items' order. After
 * a failure no new call starts, and the map fails with the earliest item's error, as a loop over
 * them would.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const settled: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        settled[i] = { status: 'fulfilled', value: await fn(items[i]!, i) };
      } catch (reason) {
        settled[i] = { status: 'rejected', reason };
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  const firstFailure = settled.find((r) => r?.status === 'rejected');
  if (firstFailure) throw (firstFailure as PromiseRejectedResult).reason;
  return settled.map((r) => (r as PromiseFulfilledResult<R>).value);
}
