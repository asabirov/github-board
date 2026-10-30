import { createHmac } from 'node:crypto';

/** Stable pseudonyms, not anonymous IDs: equal inputs remain correlatable. */
export function clientFingerprint(secret: string | undefined, domain: 'board-session-hint' | 'board-visibility', value: string): string | null {
  if (!secret?.trim() || secret === 'dev-insecure-session-secret-change-me') return null;
  return createHmac('sha256', secret).update(`${domain}\0${value}`).digest('hex');
}

/** Empty means no usable visibility lease when the server key is unconfigured. */
export const clientVisibilityKey = (secret: string | undefined, key: string): string =>
  clientFingerprint(secret, 'board-visibility', key) ?? '';
