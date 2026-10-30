import { describe, expect, it } from 'vitest';
import { decodeViewer } from '../issues-viewer/viewer-url';
import { canonicalisation, dataLogins, pressCrewCard, selectedLogins, withAssignees } from './crew-filter';

/** How the ingest spells the logins this page holds issues for — NOT how the
 *  roster spells them. The distinction is the whole point of `dataLogins`. */
const KNOWN = ['octocat', 'IvanRoslov', 'anton-khovanskiy'];

describe('dataLogins (#461, C2)', () => {
  const row = (...assignees: string[]) => ({ assignees });

  it('reports every distinct assignee spelling the queue carries', () => {
    expect(dataLogins([row('octocat'), row('IvanRoslov', 'octocat'), row()]).sort())
      .toEqual(['IvanRoslov', 'octocat']);
  });

  it('is empty for an empty queue, so nothing downstream has anything to correct '
    + 'against — before the queue lands, a guess is what breaks a working URL', () => {
    expect(dataLogins([])).toEqual([]);
  });
});

describe('selectedLogins (#461)', () => {
  it('reads nothing from a bare URL', () => {
    expect(selectedLogins('', KNOWN)).toEqual([]);
    expect(selectedLogins('?group=type', KNOWN)).toEqual([]);
  });

  it('reads the queue’s own assignee dimension — one param, one selection', () => {
    expect(selectedLogins('?assignee=octocat', KNOWN)).toEqual(['octocat']);
    expect(selectedLogins('?assignee=octocat&assignee=IvanRoslov', KNOWN))
      .toEqual(['octocat', 'IvanRoslov']);
  });

  it('spells a mangled login the way the DATA spells it, so a shared or hand-edited '
    + '`?assignee=ivanroslov` cannot light a card over an empty queue', () => {
    expect(selectedLogins('?assignee=ivanroslov', KNOWN)).toEqual(['IvanRoslov']);
    expect(selectedLogins('?assignee=ANTON-KHOVANSKIY', KNOWN)).toEqual(['anton-khovanskiy']);
  });

  it('keeps a login the data does not hold — the FilterBar writes this same dimension, '
    + 'and filtering to an assignee with nothing open is a legitimate thing to have '
    + 'done. It counts nothing and matches nothing, in the tiles and in the queue '
    + 'alike, because both compare the same way', () => {
    expect(selectedLogins('?assignee=dependabot', KNOWN)).toEqual(['dependabot']);
    expect(selectedLogins('?assignee=DEPENDABOT', KNOWN)).toEqual(['DEPENDABOT']);
  });

  it('corrects nothing while the queue is still in flight, rather than guessing at a '
    + 'spelling from a roster that is admin-typed and need not match Github', () => {
    expect(selectedLogins('?assignee=ivanroslov', [])).toEqual(['ivanroslov']);
  });

  it('collapses two spellings of one person to one token — left as written they are a '
    + 'literal duplicate: two identical React keys in the FilterBar, and the login '
    + 'twice over in every drill-in href', () => {
    expect(selectedLogins('?assignee=ivanroslov&assignee=IvanRoslov', KNOWN)).toEqual(['IvanRoslov']);
    expect(selectedLogins('?assignee=octocat&assignee=octocat', KNOWN)).toEqual(['octocat']);
  });

  it('drops an empty token', () => {
    expect(selectedLogins('?assignee=&assignee=octocat', KNOWN)).toEqual(['octocat']);
    expect(selectedLogins('?assignee=', KNOWN)).toEqual([]);
  });

  it('reads a login carrying the separator this page joins selections with as ONE '
    + 'token — a crafted `?assignee=IvanRoslov%00octocat` is one assignee nobody has, '
    + 'not the two people it names', () => {
    expect(selectedLogins('?assignee=IvanRoslov\u0000octocat', KNOWN))
      .toEqual(['IvanRoslov\u0000octocat']);
  });
});

describe('withAssignees (#461)', () => {
  it('writes the selection into an otherwise bare URL', () => {
    expect(withAssignees('', ['octocat'])).toBe('?assignee=octocat');
    expect(withAssignees('', ['octocat', 'IvanRoslov'])).toBe('?assignee=octocat&assignee=IvanRoslov');
  });

  it('clears the selection back to a clean URL', () => {
    expect(withAssignees('?assignee=octocat', [])).toBe('');
  });

  it('replaces the previous selection rather than appending to it', () => {
    expect(withAssignees('?assignee=octocat', ['IvanRoslov'])).toBe('?assignee=IvanRoslov');
  });

  it('leaves every other viewer param exactly as it found it — a card press must not '
    + 'rewrite the queue’s search, grouping, view or any other filter', () => {
    const before = '?q=cache&group=label&view=list&label=bug&unassigned=1&project=GTM'
      + '&repo=board&state=all&type=bug&tf=aging&cf_size=L';
    const after = withAssignees(before, ['octocat']);
    const b = new URLSearchParams(before);
    const a = new URLSearchParams(after);
    for (const k of ['q', 'group', 'view', 'label', 'unassigned', 'project', 'repo', 'state', 'type', 'tf', 'cf_size']) {
      expect(a.getAll(k)).toEqual(b.getAll(k));
    }
    expect(a.getAll('assignee')).toEqual(['octocat']);
  });

  it('keeps `?view=board` even though the Unit queue’s own default IS board — the '
    + 'write must not round-trip through a codec that would drop it', () => {
    expect(new URLSearchParams(withAssignees('?view=board', ['octocat'])).get('view')).toBe('board');
  });

  it('keeps a param the viewer codec does not know about', () => {
    expect(new URLSearchParams(withAssignees('?ref=slack', ['octocat'])).get('ref')).toBe('slack');
  });

  it('is the single writer: what it writes is exactly what the viewer decodes, so the '
    + 'page and the queue cannot disagree about who is selected', () => {
    for (const selection of [['octocat'], ['octocat', 'IvanRoslov'], []]) {
      const search = withAssignees('?label=bug&tf=aging', selection);
      expect(decodeViewer(search).filters?.assignees ?? []).toEqual(selection);
      expect(selectedLogins(search, KNOWN)).toEqual(selection);
    }
  });

  it('round-trips a login carrying URL-hostile characters', () => {
    const search = withAssignees('', ['a b&c']);
    expect(decodeViewer(search).filters?.assignees).toEqual(['a b&c']);
  });
});

describe('canonicalisation (#461)', () => {
  it('asks for no rewrite when the URL already spells every login the data’s way', () => {
    expect(canonicalisation('?assignee=IvanRoslov', KNOWN)).toBeNull();
    expect(canonicalisation('', KNOWN)).toBeNull();
    expect(canonicalisation('?assignee=dependabot', KNOWN)).toBeNull();
  });

  it('asks for no rewrite merely because the viewer wrote the params in another order '
    + '— every commit the queue makes fires a popstate, and rewriting on each of them '
    + 'would cost a second navigation per keystroke in its search box', () => {
    expect(canonicalisation('?assignee=octocat&tf=aging', KNOWN)).toBeNull();
    expect(canonicalisation('?q=cache&assignee=octocat&state=all', KNOWN)).toBeNull();
  });

  it('asks for the corrected URL when a login is spelled differently from the data', () => {
    expect(canonicalisation('?assignee=ivanroslov', KNOWN)).toBe('?assignee=IvanRoslov');
    expect(canonicalisation('?tf=aging&assignee=IVANROSLOV', KNOWN)).toBe('?tf=aging&assignee=IvanRoslov');
  });

  it('asks for no rewrite at all while the queue is still in flight — the roster is '
    + 'admin-typed, so correcting against it could rewrite a URL that works into one '
    + 'that does not, on every load and with no way back', () => {
    expect(canonicalisation('?assignee=ivanroslov', [])).toBeNull();
    expect(canonicalisation('?assignee=IVANROSLOV&tf=aging', [])).toBeNull();
  });

  it('clears a duplicate token', () => {
    expect(canonicalisation('?assignee=ivanroslov&assignee=IvanRoslov', KNOWN)).toBe('?assignee=IvanRoslov');
    expect(canonicalisation('?assignee=octocat&assignee=octocat', KNOWN)).toBe('?assignee=octocat');
  });

  it('clears an empty token', () => {
    expect(canonicalisation('?assignee=&assignee=octocat', KNOWN)).toBe('?assignee=octocat');
    expect(canonicalisation('?assignee=&tf=aging', KNOWN)).toBe('?tf=aging');
  });

  it('settles in one pass — the URL it asks for needs no further correction', () => {
    for (const start of [
      '?assignee=ivanroslov&label=bug',
      '?assignee=ivanroslov&assignee=IvanRoslov',
      '?assignee=&assignee=octocat',
    ]) {
      const once = canonicalisation(start, KNOWN)!;
      expect(once).not.toBeNull();
      expect(canonicalisation(once, KNOWN)).toBeNull();
    }
  });
});

describe('pressCrewCard (#461)', () => {
  it('adds a member who is not selected', () => {
    expect(pressCrewCard('', [], 'octocat')).toBe('?assignee=octocat');
  });

  it('removes one who is', () => {
    expect(pressCrewCard('?assignee=octocat', ['octocat'], 'octocat')).toBe('');
  });

  it('adds to a selection rather than replacing it — two pressed cards are an OR, the '
    + 'same one the queue applies', () => {
    expect(pressCrewCard('?assignee=octocat', ['octocat'], 'IvanRoslov'))
      .toBe('?assignee=octocat&assignee=IvanRoslov');
  });

  it('presses against the SELECTION, not against whatever the URL literally holds — the '
    + 'two differ whenever a login was spelled another way, and toggling on the raw '
    + 'text would leave both spellings in the URL at once', () => {
    expect(pressCrewCard('?assignee=ivanroslov', ['IvanRoslov'], 'IvanRoslov')).toBe('');
  });

  it('says a card with no linked Github login means nothing — the queue matches on '
    + 'login, so pressing that person could only ever filter to nobody', () => {
    expect(pressCrewCard('?assignee=octocat', ['octocat'], null)).toBeNull();
  });

  it('leaves every other viewer param exactly as it found it', () => {
    const after = pressCrewCard('?q=cache&group=label&view=board&tf=aging', [], 'octocat')!;
    const p = new URLSearchParams(after);
    expect([p.get('q'), p.get('group'), p.get('view'), p.get('tf')])
      .toEqual(['cache', 'label', 'board', 'aging']);
    expect(p.getAll('assignee')).toEqual(['octocat']);
  });

  it('produces a URL the page reads back as the selection it just made', () => {
    const after = pressCrewCard('', [], 'IvanRoslov')!;
    expect(selectedLogins(after, KNOWN)).toEqual(['IvanRoslov']);
    expect(pressCrewCard(after, selectedLogins(after, KNOWN), 'IvanRoslov')).toBe('');
  });
});
