// The PoW Web Worker (dist/widget.worker.js): one task in, one answer out, then the widget
// terminates it. Messages: in {challenge, salt, maxnumber}; out {number, took} or {number: null}.

import { type PowTask, searchPow } from './pow.js';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<PowTask>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (e) => {
  searchPow(e.data).then(
    (found) => scope.postMessage(found ?? { number: null }),
    () => scope.postMessage({ number: null }),
  );
};
