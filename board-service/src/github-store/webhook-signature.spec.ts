import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyWebhookSignature } from './webhook-signature';

// The real compare, wrapped so the test can see it was the one used. An ESM
// namespace cannot be spied on after the fact, so it is replaced up front.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const SECRET = 'a-webhook-secret-of-some-length';
const sign = (secret: string, body: Buffer | string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyWebhookSignature (#1007, V5)', () => {
  const body = Buffer.from('{"action":"opened","issue":{"number":1}}');

  it('accepts the signature Github computes over the exact bytes', () => {
    expect(verifyWebhookSignature(SECRET, body, sign(SECRET, body))).toBe(true);
    expect(verifyWebhookSignature(SECRET, body, sign(SECRET, body).toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
  });

  it('refuses a signature made with another secret', () => {
    expect(verifyWebhookSignature(SECRET, body, sign('another-secret-entirely-here', body))).toBe(false);
  });

  it('refuses the same object serialised differently, because the HMAC is over bytes', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyWebhookSignature(SECRET, reserialised, sign(SECRET, body))).toBe(false);
  });

  it('refuses a missing, empty, truncated, sha1 or non-hex header', () => {
    const good = sign(SECRET, body);
    for (const header of [undefined, '', good.slice(0, -2), `sha1=${good.slice(7, 47)}`, `sha256=${'z'.repeat(64)}`, `${good} `]) {
      expect(verifyWebhookSignature(SECRET, body, header)).toBe(false);
    }
  });

  it('refuses everything when no secret is configured, even a signature made with the empty key', () => {
    expect(verifyWebhookSignature('', body, sign('', body))).toBe(false);
  });

  it('compares with timingSafeEqual over two 32-byte digests, not string equality', () => {
    const compare = vi.mocked(timingSafeEqual);
    compare.mockClear();
    expect(verifyWebhookSignature(SECRET, body, sign('another-secret-entirely-here', body))).toBe(false);
    expect(compare).toHaveBeenCalledTimes(1);
    const [given, expected] = compare.mock.calls[0] as [Buffer, Buffer];
    expect([given.length, expected.length]).toEqual([32, 32]);
  });
});
