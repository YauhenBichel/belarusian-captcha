import {
  createPowChallenge,
  encodePowSolution,
  verifyPowSolution,
} from '@belarusian-captcha/shared';
import * as altcha from 'altcha-lib/v1';
import { describe, expect, it, vi } from 'vitest';
import { mainThreadSolver, type PowTask, searchPow, workerSolver } from './pow.js';

const KEY = 'test-pow-key';

async function task(number: number, maxnumber = 1000) {
  return createPowChallenge({
    hmacKey: KEY,
    maxnumber,
    expiresAt: Date.now() + 60_000,
    params: { cid: 'c1' },
    number,
  });
}

describe('searchPow', () => {
  it('finds the number, and the server accepts the payload', async () => {
    const ch = await task(377);
    const found = await searchPow(ch);
    expect(found?.number).toBe(377);
    const ok = await verifyPowSolution(
      {
        algorithm: ch.algorithm,
        challenge: ch.challenge,
        number: 377,
        salt: ch.salt,
        signature: ch.signature,
      },
      KEY,
      Date.now(),
    );
    expect(ok.ok).toBe(true);
  });

  it('solves a challenge made by altcha-lib, and altcha-lib accepts the payload', async () => {
    const ch = await altcha.createChallenge({
      hmacKey: KEY,
      maxnumber: 500,
      expires: new Date(Date.now() + 60_000),
    });
    const found = await searchPow({ ...ch, maxnumber: 500 });
    expect(found).not.toBeNull();
    const payload = encodePowSolution({
      algorithm: ch.algorithm,
      challenge: ch.challenge,
      number: found?.number ?? -1,
      salt: ch.salt,
      signature: ch.signature,
      took: found?.took ?? 0,
    });
    expect(await altcha.verifySolution(payload, KEY)).toBe(true);
  });

  it('finds 0 and maxnumber (both ends are inclusive)', async () => {
    expect((await searchPow(await task(0, 10)))?.number).toBe(0);
    expect((await searchPow(await task(10, 10)))?.number).toBe(10);
  });

  it('returns null when no number in range matches', async () => {
    const ch = await task(50, 100);
    expect(await searchPow({ ...ch, maxnumber: 49 })).toBeNull();
  });

  it('returns null for a malformed challenge or maxnumber', async () => {
    const ch = await task(5, 10);
    expect(await searchPow({ ...ch, challenge: 'zz' })).toBeNull();
    expect(await searchPow({ ...ch, maxnumber: -1 })).toBeNull();
    expect(await searchPow({ ...ch, maxnumber: 1.5 })).toBeNull();
  });

  it('stops when cancelled, between slices', async () => {
    const ch = await task(900, 1000);
    const onSlice = vi.fn(async () => {});
    const found = await searchPow(ch, { sliceSize: 100, cancelled: () => true, onSlice });
    expect(found).toBeNull();
    expect(onSlice).not.toHaveBeenCalled();
  });

  it('yields every slice', async () => {
    const ch = await task(350, 1000);
    const onSlice = vi.fn(async () => {});
    await searchPow(ch, { sliceSize: 100, onSlice });
    expect(onSlice).toHaveBeenCalledTimes(3);
  });
});

describe('mainThreadSolver', () => {
  it('solves, and cancel() stops a search', async () => {
    expect((await mainThreadSolver(await task(42, 100)).result)?.number).toBe(42);
    const job = mainThreadSolver(await task(5_000_000, 5_000_000));
    job.cancel();
    expect(await job.result).toBeNull();
  });
});

/** A Worker stand-in that answers on the next tick, or fails. */
function fakeWorker(mode: 'answer' | 'error' | 'throw') {
  const made: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    terminated = false;
    constructor(readonly url: string) {
      if (mode === 'throw') throw new DOMException('cross-origin', 'SecurityError');
      made.push(this);
    }
    postMessage(t: PowTask) {
      setTimeout(async () => {
        if (this.terminated) return;
        if (mode === 'error') this.onerror?.({ preventDefault() {} } as ErrorEvent);
        else this.onmessage?.({ data: (await searchPow(t)) ?? { number: null } } as MessageEvent);
      }, 0);
    }
    terminate() {
      this.terminated = true;
    }
  }
  return { Impl: FakeWorker as unknown as typeof Worker, made };
}

describe('workerSolver', () => {
  it('runs the search in the worker and terminates it', async () => {
    const { Impl, made } = fakeWorker('answer');
    const job = workerSolver('https://api.test/widget.worker.js', Impl)(await task(77, 100));
    expect((await job.result)?.number).toBe(77);
    expect(made[0]?.url).toBe('https://api.test/widget.worker.js');
    expect(made[0]?.terminated).toBe(true);
  });

  it('falls back to the main thread when the worker cannot be constructed (cross-origin)', async () => {
    const { Impl } = fakeWorker('throw');
    const job = workerSolver('https://other.test/widget.worker.js', Impl)(await task(9, 100));
    expect((await job.result)?.number).toBe(9);
  });

  it('falls back to the main thread when the worker fails to load', async () => {
    const { Impl } = fakeWorker('error');
    const job = workerSolver('https://api.test/missing.js', Impl)(await task(11, 100));
    expect((await job.result)?.number).toBe(11);
  });

  it('uses the main thread without a worker URL or Worker support', async () => {
    expect((await workerSolver(undefined)(await task(3, 10)).result)?.number).toBe(3);
    expect((await workerSolver('x.js', undefined)(await task(4, 10)).result)?.number).toBe(4);
  });

  it('cancel() terminates the worker', async () => {
    const { Impl, made } = fakeWorker('answer');
    const job = workerSolver('w.js', Impl)(await task(1, 10));
    job.cancel();
    expect(made[0]?.terminated).toBe(true);
  });
});
