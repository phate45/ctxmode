// Vendored from mksglu/context-mode v1.0.169 (442f1eb) src/runPool.ts.
/**
 * Run jobs with at most N in flight, for batch_execute and fetch_and_index.
 * Results are allSettled-style in input order, so one job's throw cannot
 * strand its siblings.
 */

import { cpus } from "node:os";

export interface PoolJob<T> {
  run(): Promise<T>;
}

export interface RunPoolOptions {
  /** Hard concurrency cap (1-N). Auto-clamped to job count. */
  concurrency: number;
  /** Optional: also clamp by `os.cpus().length` (memory-pressure safety). Default false. */
  capByCpuCount?: boolean;
}

export interface RunPoolResult<T> {
  /** Per-index settled result, ordered by input index. */
  settled: PromiseSettledResult<T>[];
  /** Concurrency actually used after all caps applied. */
  effectiveConcurrency: number;
  /** True when effectiveConcurrency < requested concurrency. */
  capped: boolean;
}

export async function runPool<T>(
  jobs: PoolJob<T>[],
  opts: RunPoolOptions,
): Promise<RunPoolResult<T>> {
  const { concurrency, capByCpuCount = false } = opts;

  if (jobs.length === 0) {
    return { settled: [], effectiveConcurrency: 0, capped: false };
  }

  const requested = Math.max(1, concurrency);
  const cpuCap = capByCpuCount ? Math.max(1, cpus().length) : requested;
  const effectiveConcurrency = Math.min(requested, cpuCap, jobs.length);
  const capped = effectiveConcurrency < requested;

  const settled: PromiseSettledResult<T>[] = new Array(jobs.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= jobs.length) return;
      try {
        const value = await jobs[idx].run();
        settled[idx] = { status: "fulfilled", value };
      } catch (err) {
        settled[idx] = { status: "rejected", reason: err };
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < effectiveConcurrency; w++) workers.push(worker());
  // allSettled defends against any promise rejection escaping a worker
  // (the worker already swallows its own errors, but this is belt-and-braces).
  await Promise.allSettled(workers);

  return { settled, effectiveConcurrency, capped };
}
