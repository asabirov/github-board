import { describe, expect, it, vi } from 'vitest';
import { loadFailureText, logLoadFailure, reasonOf } from './session-copy';

/** Every string api.ts can put in `message` on one of the five read paths that
 *  reach `loadFailureText`: the two sentinels it throws by name, and the
 *  `<route> <status>` string each of the five fetchers builds. Read off
 *  `api.ts` rather than guessed — `fetchMyTokens` throws `tokens <status>`,
 *  `fetchConnectedClients` `clients <status>`, `fetchAuditLog` `audit <status>`,
 *  `fetchAdminAccess` `access <status>` and `fetchMyIssues` `my-issues
 *  <status>`. The last entry is the one #1055 was reported with, off the
 *  Projects board, which reaches its own inline sentence rather than this
 *  helper; it is here because it is the shape the report named. */
const WHAT_API_THROWS = [
  'unauthenticated',
  'forbidden',
  'tokens 503',
  'clients 500',
  'audit 502',
  'access 500',
  'my-issues 502',
  'project-items 500',
];

describe('loadFailureText (#512, #1055)', () => {
  it('never prints a sentinel api.ts throws', () => {
    // "Couldn't load projects: unauthenticated" was on a real person's screen.
    for (const message of WHAT_API_THROWS) {
      const line = loadFailureText('projects', message);
      expect(line).not.toContain('unauthenticated');
      expect(line).not.toContain('forbidden');
    }
  });

  it('never prints a status code or a route name (#1055)', () => {
    // "Couldn't load project: project-items 500" is the sentence #1055 is about.
    for (const message of WHAT_API_THROWS) {
      const line = loadFailureText('your tokens', message);
      expect(line).not.toMatch(/\d/);
      expect(line).not.toContain(message);
    }
  });

  it('says an expired session is why the surface stopped', () => {
    expect(loadFailureText('projects', 'unauthenticated')).toBe(
      'Your session ended, so projects stopped loading.',
    );
    expect(loadFailureText('the audit log', 'unauthenticated')).toBe(
      'Your session ended, so the audit log stopped loading.',
    );
  });

  it('says a refused read is a refusal, and offers no retry for it', () => {
    expect(loadFailureText('your tokens', 'forbidden')).toBe(
      'Couldn’t load your tokens. The read was refused, and a reload won’t change that.',
    );
    expect(loadFailureText('your connected clients', 'forbidden')).toBe(
      'Couldn’t load your connected clients. The read was refused, and a reload won’t change that.',
    );
    expect(loadFailureText('your queue', 'forbidden')).not.toContain('Reload the page');
  });

  it('blames nobody for a refusal (#1081 review, B1)', () => {
    // The arm used to say "You aren't allowed to see your queue", and the one
    // 403 a browser can actually reach on this surface is `GithubPrincipalGuard`
    // answering "Connect Github to use this surface" — a missing credential,
    // not a verdict on the reader. The sentence may not claim it is either.
    for (const subject of ['your tokens', 'your connected clients', 'your queue']) {
      const line = loadFailureText(subject, 'forbidden');
      expect(line).not.toContain('You aren’t allowed');
      expect(line).not.toContain('you aren’t allowed');
      expect(line).not.toMatch(/\byou\b/i);
    }
  });

  it('names what did not load and what to do about it', () => {
    expect(loadFailureText('your tokens', 'tokens 503')).toBe(
      'Couldn’t load your tokens. Reload the page to try again.',
    );
    expect(loadFailureText('your queue', 'my-issues 502')).toBe(
      'Couldn’t load your queue. Reload the page to try again.',
    );
    expect(loadFailureText('Access', 'access 500')).toBe(
      'Couldn’t load Access. Reload the page to try again.',
    );
  });

  it('says what could not be loaded when the error carried no message (#1082)', () => {
    // The inverse of #1055. That one printed api.ts's own string as the tail of
    // the sentence; this one is a rejection with nothing to say at all, and the
    // two panes that guarded on the WORDS rather than on the failure drew no
    // sentence for it. The words were never what this line says: since #1055 it
    // says what is missing and what to do, and `subject` carries both.
    for (const message of ['', undefined, null]) {
      expect(loadFailureText('your tokens', message)).toBe(
        'Couldn’t load your tokens. Reload the page to try again.',
      );
    }
  });

  it('never answers with an empty line (#1082)', () => {
    // The property, rather than the three inputs above: whatever a read
    // rejected with, this says something.
    for (const message of ['', undefined, null, 'clients 500', 'unauthenticated', 'forbidden']) {
      expect(loadFailureText('your connected clients', message).trim().length).toBeGreaterThan(0);
    }
  });

  it('reads the same for every failure a reload could clear', () => {
    // The sentence is the subject's, not the status's: one answer to "this did
    // not load", so two surfaces failing for different reasons do not sound
    // like two different bugs.
    const said = new Set(
      ['tokens 503', 'clients 500', 'audit 502', 'my-issues 502'].map((m) => loadFailureText('your tokens', m)),
    );
    expect(said.size).toBe(1);
  });
});

describe('reasonOf (#1082)', () => {
  it('reads the words off an ordinary rejection', () => {
    expect(reasonOf(new Error('clients 500'))).toBe('clients 500');
    expect(reasonOf('unauthenticated')).toBe('unauthenticated');
  });

  it('answers an empty string for an error carrying no words, rather than the error', () => {
    // `??` and not `||`: an empty message is the error's own answer, and
    // replacing it with `String(e)` would put "Error" on the console line.
    // Nothing draws these words anyway — `loadFailureText` says what could not
    // be loaded — so the empty string costs a reader nothing and the pane
    // guards must simply stop reading it as "no error".
    expect(reasonOf(new Error(''))).toBe('');
  });

  it('answers a rejection that carried nothing, instead of throwing inside the handler', () => {
    // AccountView caught with `String(e.message ?? e)`, which reads `.message`
    // off whatever arrived. A promise CAN reject with nothing — `Promise.reject()`
    // — and that read is a TypeError raised inside the rejection handler, so the
    // failure never reached the state the pane branches on and the page sat on
    // its first-load arm for the rest of the session. The same screen the empty
    // message drew, by a different route, which is why both are one issue.
    expect(() => (undefined as unknown as { message: string }).message).toThrow(TypeError);
    for (const thrown of [undefined, null, {}, new Error()]) {
      expect(() => reasonOf(thrown)).not.toThrow();
      expect(typeof reasonOf(thrown)).toBe('string');
    }
  });
});

describe('logLoadFailure (#1055)', () => {
  it('keeps the message the sentence stopped printing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logLoadFailure('your tokens', 'tokens 503');
    expect(warn).toHaveBeenCalledWith('load failed: your tokens: tokens 503');
    warn.mockRestore();
  });
});
