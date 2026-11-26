/** SSE stream lifecycle with a fake stream (no HTTP): slow clients are dropped. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SSEStreamingApi } from 'hono/streaming';
import type { LiveHub } from '../../src/live/hub.ts';
import { defaultStreamLimits, runStream, StreamRegistry } from '../../src/live/streams.ts';
import { silentLogger } from '../../src/log.ts';

/** A stream whose client never reads: every write stays pending. */
function stalledStream(): SSEStreamingApi & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    aborted: false,
    write: (text: string) => {
      writes.push(text);
      return new Promise(() => undefined);
    },
    onAbort: () => undefined,
  } as unknown as SSEStreamingApi & { writes: string[] };
}

const hub = { onChange: () => () => undefined } as unknown as LiveHub;

describe('live streams', () => {
  it('drops a client that does not read (socket destroyed, slot freed)', async () => {
    const registry = new StreamRegistry({ ...defaultStreamLimits, writeTimeoutS: 1 });
    const slot = registry.reserve('user', '203.0.113.7');
    assert.ok(slot);
    assert.equal(registry.size, 1);
    let dropped = 0;
    const stream = stalledStream();
    await runStream(stream, {
      event: 'route', build: () => ({}), relevant: () => false, expiresAt: Date.now() + 3600_000, drop: () => { dropped++; },
    }, { a: 1 }, hub, slot, registry.limits, silentLogger);
    assert.equal(dropped, 1);
    assert.equal(registry.size, 0);
    assert.deepEqual(stream.writes, ['retry: 5000\n\n'], 'nothing more is written to a stalled client');
    // The per-IP count was released too.
    for (let i = 0; i < defaultStreamLimits.maxPerIp; i++) assert.ok(registry.reserve(`u${String(i)}`, '203.0.113.7'));
  });

  it('at shutdown, a client that does not take the end message is dropped', async () => {
    const registry = new StreamRegistry(defaultStreamLimits);
    const slot = registry.reserve('user');
    assert.ok(slot);
    let dropped = 0;
    let wrote = 0;
    const stream = {
      aborted: false,
      // The first writes go through; then the client stops reading.
      write: () => (++wrote <= 2 ? Promise.resolve() : new Promise(() => undefined)),
      onAbort: () => undefined,
    } as unknown as SSEStreamingApi;
    const running = runStream(stream, {
      event: 'route', build: () => ({}), relevant: () => false, expiresAt: Date.now() + 3600_000, drop: () => { dropped++; },
    }, { a: 1 }, hub, slot, registry.limits, silentLogger);
    await new Promise((r) => setTimeout(r, 10));
    await registry.closeAll(3000);
    await running;
    assert.equal(dropped, 1);
    assert.equal(registry.size, 0);
  });
});
