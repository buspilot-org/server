import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultThresholds, loadConfig } from '../../src/config.ts';

describe('config', () => {
  const base = { DATABASE_URL: 'postgres://x', TRACCAR_FORWARD_SECRET: 'x'.repeat(32) };

  it('loads defaults', () => {
    const c = loadConfig(base);
    assert.equal(c.port, 8080);
    assert.deepEqual(c.thresholds, defaultThresholds);
  });

  it('requires a long, URL-safe secret and a database URL', () => {
    assert.throws(() => loadConfig({ ...base, DATABASE_URL: '' }), /DATABASE_URL/);
    assert.throws(() => loadConfig({ ...base, TRACCAR_FORWARD_SECRET: 'short' }), /at least 32/);
    assert.throws(() => loadConfig({ ...base, TRACCAR_FORWARD_SECRET: 'x'.repeat(31) + '/' }), /letters, digits/);
    assert.throws(() => loadConfig({ ...base, PORT: 'abc' }), /PORT/);
  });
});
