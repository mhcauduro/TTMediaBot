import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForMedia } from '../readiness.mjs';

function probe(statuses) {
  let clock = 0, calls = 0, cancelled = 0;
  return {
    options: {
      now: () => clock,
      sleep: async ms => { clock += ms; },
      fetchImpl: async (_, opts) => {
        assert.equal(opts.headers.Range, 'bytes=0-');
        return { status: statuses[Math.min(calls++, statuses.length - 1)],
          body: { cancel: async () => { cancelled++; } } };
      },
    },
    counts: () => ({ calls, cancelled }),
  };
}
test('returns immediately for ready media', async () => {
  const p = probe([206]);
  assert.deepEqual(await waitForMedia('https://example.test', {}, p.options), { attempts: 1, elapsedMs: 0 });
  assert.deepEqual(p.counts(), { calls: 1, cancelled: 1 });
});
test('retries the same media until transient 403 clears', async () => {
  const p = probe([403,403,206]);
  assert.deepEqual(await waitForMedia('https://example.test', {}, p.options), { attempts: 3, elapsedMs: 400 });
  assert.deepEqual(p.counts(), { calls: 3, cancelled: 3 });
});
test('persistent 403 stops at the deadline', async () => {
  const p = probe([403]);
  await assert.rejects(waitForMedia('https://example.test', {}, {...p.options, timeoutMs: 1000}), /timed out|timeout/);
  assert.equal(p.counts().calls, 5);
});
test('does not retry permanent failures', async () => {
  const p = probe([404]);
  await assert.rejects(waitForMedia('https://example.test', {}, p.options), /HTTP 404/);
  assert.equal(p.counts().calls, 1);
});
