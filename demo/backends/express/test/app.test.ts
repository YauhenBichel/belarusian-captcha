// The Express demo backend against the shared demo-backend contract (demo/backends/contract.ts).

import type { AddressInfo } from 'node:net';
import { describeDemoBackend } from '../../contract.js';
import { createApp } from '../src/app.js';

describeDemoBackend('Express', async (cfg) => {
  const server = createApp(cfg).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
});
