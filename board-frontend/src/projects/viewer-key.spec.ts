import { describe, expect, it } from 'vitest';
import { projectViewerKey, projectViewerKeys } from './viewer-key';

describe('project viewer key (#463)', () => {
  it('gives every board its own key', () => {
    expect(projectViewerKey(7)).not.toBe(projectViewerKey(9));
  });

  it('gives the same board the same key across visits', () => {
    expect(projectViewerKey(7)).toBe(projectViewerKey(7));
  });
});

describe('two orgs’ board 7 are two boards (#697)', () => {
  it('gives each org’s board its own key', () => {
    expect(projectViewerKey(7, 'acme')).not.toBe(projectViewerKey(7, 'globex'));
  });

  it('still gives one board one key across visits', () => {
    expect(projectViewerKey(7, 'globex')).toBe(projectViewerKey(7, 'globex'));
  });

  it('never collides an org-qualified board with an unqualified one', () => {
    expect(projectViewerKey(7, 'globex')).not.toBe(projectViewerKey(7));
  });

  it('keeps the unqualified key exactly as it was', () => {
    expect(projectViewerKey(7)).toBe('project:7');
  });
});

// The key gained the org (#697), and a key that changes is an arrangement a
// person silently loses. So the board page hands the viewer the key it wants AND
// the key it used to have — see `viewer-prefs.ts`, which reads them in order.
describe('the keys a board page offers, newest first (#697)', () => {
  it('leads with the org-qualified key and falls back to the one it replaced', () => {
    expect(projectViewerKeys(7, 'acme')).toEqual(['project:acme/7', 'project:7']);
  });

  it('leads with the key the current code would write', () => {
    expect(projectViewerKeys(7, 'acme')[0]).toBe(projectViewerKey(7, 'acme'));
    expect(projectViewerKeys(7)[0]).toBe(projectViewerKey(7));
  });

  it('offers only the one key when no org qualifies the board — there is nothing to fall back from', () => {
    expect(projectViewerKeys(7)).toEqual(['project:7']);
  });

  it('never lets two orgs’ board 7 reach each other’s arrangement', () => {
    const a = projectViewerKeys(7, 'acme');
    const b = projectViewerKeys(7, 'globex');
    expect(a[0]).not.toBe(b[0]);
    // They share the fallback, which is the key neither of them writes: whichever
    // board is opened first inherits the pre-#697 arrangement and then writes its
    // own, and the other keeps reading the legacy one until it is arranged too.
    // Two orgs is a deployment nobody runs yet, and this is the only shape that
    // costs a single-org deployment nothing.
    expect(a[1]).toBe('project:7');
    expect(b[1]).toBe('project:7');
  });
});
