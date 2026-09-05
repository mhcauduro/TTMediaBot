// Some newly signed GVS URLs briefly return 403 before accepting media.
export async function waitForMedia(url, headers, {
  fetchImpl = fetch,
  now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 8000,
} = {}) {
  const started = now();
  let attempts = 0;
  while (true) {
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) throw new Error('Audio stream readiness timed out');
    attempts++;
    const response = await fetchImpl(url, {
      headers: { ...headers, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(2000, remaining)))),
    });
    await response.body?.cancel();
    if (response.status === 200 || response.status === 206) {
      return { attempts, elapsedMs: Math.round(now() - started) };
    }
    if (response.status !== 403) {
      throw new Error('Audio stream returned HTTP ' + response.status);
    }
    const delay = Math.min(500, timeoutMs - (now() - started));
    if (delay <= 0) throw new Error('Audio stream still returned HTTP 403 after readiness timeout');
    await sleep(delay);
  }
}
