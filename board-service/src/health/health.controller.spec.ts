import { describe, it, expect, afterEach } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const original = process.env.APP_VERSION;
  afterEach(() => {
    if (original === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = original;
  });

  it('reports when no webhook store is configured', () => {
    expect(new HealthController().health().webhookStore).toEqual({
      state: 'off',
    });
  });

  it('reports status ok and a timestamp', () => {
    const res = new HealthController().health();
    expect(res.status).toBe('ok');
    expect(typeof res.timestamp).toBe('string');
  });

  it('surfaces APP_VERSION when baked in, null otherwise', () => {
    process.env.APP_VERSION = 'v9.9.9';
    expect(new HealthController().health().version).toBe('v9.9.9');
    delete process.env.APP_VERSION;
    expect(new HealthController().health().version).toBeNull();
  });
});
