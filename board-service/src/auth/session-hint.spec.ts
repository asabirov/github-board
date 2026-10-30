import { expect, it, vi } from 'vitest';
import { sessionHintId, setSessionHint } from './session-hint';
it('uses an opaque domain-separated person id and a readable session companion', () => {
  const cookie = vi.fn();
  const id = sessionHintId('secret', 'google-sub');
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(id).not.toBe(sessionHintId('other-secret', 'google-sub'));
  setSessionHint({ cookie } as any, 'https://board.test', id, 'visibility', 123);
  expect(cookie).toHaveBeenCalledWith('board_session_hint', JSON.stringify({ id, visibilityKey: 'visibility' }), {
    httpOnly: false, secure: true, sameSite: 'lax', path: '/', maxAge: 123000,
  });
});

it.each([undefined, '', 'dev-insecure-session-secret-change-me'])('does not publish a hint with an unsafe key: %s', secret => {
  const cookie = vi.fn();
  const id = sessionHintId(secret, 'google-sub');
  expect(id).toBeNull();
  setSessionHint({ cookie } as any, 'https://board.test', id, null, 123);
  expect(cookie).not.toHaveBeenCalled();
});
