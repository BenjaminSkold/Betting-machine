// Bounded-concurrency map. Firing one request per match unbounded (300+
// matches and growing) blew past the R2 S3 client's default 50-socket
// limit -- observed live as "socket usage at capacity=50, 494 additional
// requests enqueued" on the wallet detail page. This runs at most `limit`
// promises at once instead of relying on any one caller to remember to
// throttle itself.
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
