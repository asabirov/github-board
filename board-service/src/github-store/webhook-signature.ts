import { createHmac, timingSafeEqual } from 'node:crypto';

/** The shape of `X-Hub-Signature-256`: `sha256=` and the hex of a 32-byte HMAC. */
export const SIGNATURE_HEADER = /^sha256=([0-9a-f]{64})$/i;

/**
 * Whether `raw` is the body Github signed with the App's webhook secret
 * (#1007, V5).
 *
 * Computed over the bytes exactly as they arrived, never over a parsed and
 * re-serialised object, which would change whitespace or key order and fail
 * every real delivery. Nothing parses the body before this answers, so a
 * stranger's bytes never reach a JSON parser. The compare is `timingSafeEqual`
 * over two 32-byte digests, so how long a wrong signature takes to refuse says
 * nothing about how many of its bytes were right. The shape test before it
 * reveals nothing either: every well-formed header is the same length.
 */
export function verifyWebhookSignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  const match = SIGNATURE_HEADER.exec(header ?? '');
  if (!secret || !match) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
