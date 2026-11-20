// The proof-of-work search (ALTCHA classic SHA-256, docs/DESIGN.md section 4.1): find `number` in
// [0, maxnumber] with hex(SHA-256(salt + number)) === challenge. The same loop runs in the Web
// Worker (worker.ts) and, when no worker can be started, on the main thread in yielding slices.

import type { PowChallenge } from '@belarusian-captcha/shared';

export type PowTask = Pick<PowChallenge, 'challenge' | 'salt' | 'maxnumber'>;

export interface PowFound {
  number: number;
  /** Milliseconds the search took. */
  took: number;
}

export interface SearchOptions {
  /** Checked every `sliceSize` hashes; the search stops and returns null once it is true. */
  cancelled?: () => boolean;
  /** Called every `sliceSize` hashes, e.g. to give the main thread back to the page. */
  onSlice?: () => Promise<void>;
  sliceSize?: number;
}

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/.test(hex)) return undefined;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Returns the number and the time taken, or null if none matches (or the search is cancelled). */
export async function searchPow(task: PowTask, opts: SearchOptions = {}): Promise<PowFound | null> {
  const target = hexToBytes(task.challenge);
  if (!target || !Number.isSafeInteger(task.maxnumber) || task.maxnumber < 0) return null;
  const subtle = globalThis.crypto.subtle;
  const slice = opts.sliceSize ?? 1000;
  const t0 = Date.now();
  for (let n = 0; n <= task.maxnumber; n++) {
    const digest = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(task.salt + n)));
    if (sameBytes(digest, target)) return { number: n, took: Date.now() - t0 };
    if (n % slice === slice - 1) {
      if (opts.cancelled?.()) return null;
      await opts.onSlice?.();
    }
  }
  return null;
}

/** A running search: its result, and a way to stop it. */
export interface PowJob {
  result: Promise<PowFound | null>;
  cancel(): void;
}

export type PowSolver = (task: PowTask) => PowJob;

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Main-thread search in slices of 500 hashes, so the page stays responsive. */
export function mainThreadSolver(task: PowTask): PowJob {
  let stopped = false;
  return {
    result: searchPow(task, { cancelled: () => stopped, onSlice: nextTask, sliceSize: 500 }),
    cancel: () => {
      stopped = true;
    },
  };
}

/**
 * Runs the search in a Web Worker loaded from `workerUrl`. A worker must be same-origin with the
 * page, so when the script is served from another origin (the API's) the constructor throws, and
 * a worker can also fail to load (404, a CSP without `worker-src`). In every such case the search
 * falls back to the main thread instead of failing the check.
 */
export function workerSolver(
  workerUrl: string | undefined,
  WorkerImpl: typeof Worker | undefined = globalThis.Worker,
): PowSolver {
  return (task) => {
    if (!workerUrl || !WorkerImpl) return mainThreadSolver(task);
    let worker: Worker;
    try {
      worker = new WorkerImpl(workerUrl);
    } catch {
      return mainThreadSolver(task);
    }
    let fallback: PowJob | undefined;
    let cancelled = false;
    const result = new Promise<PowFound | null>((resolve) => {
      worker.onmessage = (e: MessageEvent<PowFound | { number: null }>) => {
        worker.terminate();
        resolve(e.data.number === null ? null : (e.data as PowFound));
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        worker.terminate();
        if (cancelled) return resolve(null);
        fallback = mainThreadSolver(task);
        resolve(fallback.result);
      };
      worker.postMessage(task);
    });
    return {
      result,
      cancel: () => {
        cancelled = true;
        worker.terminate();
        fallback?.cancel();
      },
    };
  };
}
