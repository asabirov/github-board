import { expect, it } from 'vitest';
import { clientFingerprint, clientVisibilityKey } from './client-fingerprint';

it('separates identity and visibility and changes with the person, grants or server key', () => {
  const key = 'unconnected:alice@example.test\0subject';
  const visibility = clientVisibilityKey('synthetic-server-key', key);
  expect(visibility).toMatch(/^[a-f0-9]{64}$/);
  expect(visibility).toBe(clientVisibilityKey('synthetic-server-key', key));
  expect(visibility).not.toBe(clientFingerprint('synthetic-server-key', 'board-session-hint', key));
  expect(visibility).not.toBe(clientVisibilityKey('rotated-server-key', key));
  expect(visibility).not.toBe(clientVisibilityKey('synthetic-server-key', 'unconnected:bob@example.test\0other-subject'));
  expect(visibility).not.toBe(clientVisibilityKey('synthetic-server-key', `${key}:changed-grants`));
});

it.each([undefined, '', '   ', 'dev-insecure-session-secret-change-me'])('returns no usable visibility for an unsafe key: %s', secret => {
  expect(clientVisibilityKey(secret, 'unconnected:alice@example.test\0subject')).toBe('');
});
