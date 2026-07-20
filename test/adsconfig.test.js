// The drop-in ads endpoint: no ADSENSE_CLIENT env → client gets null and
// loads zero third-party code; with it set, the id (and test flag) flow
// through. Read at request time, so both cases are testable in one process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/app.js';

async function getAdsConfig(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/ads-config`);
  assert.equal(res.status, 200);
  return res.json();
}

test('/api/ads-config gates the entire ads integration on ADSENSE_CLIENT', async () => {
  const { httpServer } = createServer();
  await new Promise((r) => httpServer.listen(0, r));
  const { port } = httpServer.address();
  const saved = { client: process.env.ADSENSE_CLIENT, test: process.env.ADSENSE_TEST };
  try {
    delete process.env.ADSENSE_CLIENT;
    delete process.env.ADSENSE_TEST;
    assert.deepEqual(await getAdsConfig(port), { adsenseClient: null, adsenseTest: false });

    process.env.ADSENSE_CLIENT = 'ca-pub-12345';
    process.env.ADSENSE_TEST = '1';
    assert.deepEqual(await getAdsConfig(port), { adsenseClient: 'ca-pub-12345', adsenseTest: true });
  } finally {
    if (saved.client == null) delete process.env.ADSENSE_CLIENT; else process.env.ADSENSE_CLIENT = saved.client;
    if (saved.test == null) delete process.env.ADSENSE_TEST; else process.env.ADSENSE_TEST = saved.test;
    await new Promise((r) => httpServer.close(r));
  }
});
