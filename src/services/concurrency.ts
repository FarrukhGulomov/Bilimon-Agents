/**
 * Lightweight concurrency limiter for batch async work over an array of
 * items — plain async logic, no new dependency. Used by the orchestrator
 * to cap how many institutions are in-flight at once through the
 * LLM-heavy Researcher/Content-Manager stages during a large batch run
 * (batches can be any size, with no fixed ceiling), so `pipeline run`
 * never fires more than `limit` simultaneous LLM calls.
 *
 * Implementation is a simple pull-based worker pool ("semaphore via N
 * workers pulling from a shared cursor"): spin up at most `limit` workers,
 * each repeatedly claims the next unclaimed item (via a shared index) and
 * awaits `worker` on it until items run out. Order of completion is not
 * guaranteed, but `results[i]` always corresponds to `items[i]`.
 */
export interface RunWithConcurrencyOptions<T, R> {
  items: T[];
  limit: number;
  worker: (item: T, index: number) => Promise<R>;
  /** Called synchronously right after each item settles (fulfilled result only —
   * `worker` is expected to catch its own errors and encode them in R). */
  onSettled?: (result: R, item: T, index: number) => void;
}

export async function runWithConcurrency<T, R>(opts: RunWithConcurrencyOptions<T, R>): Promise<R[]> {
  const { items, worker, onSettled } = opts;
  const limit = Math.max(1, Math.floor(opts.limit) || 1);
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      const result = await worker(items[current], current);
      results[current] = result;
      onSettled?.(result, items[current], current);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(runWorker());
  await Promise.all(workers);
  return results;
}
