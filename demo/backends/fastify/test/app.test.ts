// The Fastify demo backend against the shared demo-backend contract (demo/backends/contract.ts).

import { describeDemoBackend } from '../../contract.js';
import { createApp } from '../src/app.js';

describeDemoBackend('Fastify', async (cfg) => {
  const app = createApp(cfg);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  return { base, close: () => app.close() };
});
