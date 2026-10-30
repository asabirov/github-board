import { clientFingerprint } from './client-fingerprint';
import type { Response } from 'express';
export const SESSION_HINT_COOKIE = 'board_session_hint';
/** Stable across devices/sign-outs under one server key; never a credential. */
export const sessionHintId = (secret: string | undefined, sub: string): string | null =>
  clientFingerprint(secret, 'board-session-hint', sub);
export function setSessionHint(res: Response, base: string, id: string | null, visibilityKey: string | null, seconds: number): void {
  if (!id) return;
  res.cookie(SESSION_HINT_COOKIE, JSON.stringify({ id, visibilityKey }), {
    httpOnly: false, secure: base.startsWith('https:'), sameSite: 'lax', path: '/', maxAge: Math.max(0, seconds) * 1000,
  });
}
