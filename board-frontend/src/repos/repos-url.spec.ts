import { describe, expect, it } from 'vitest';
import { decodeRepos, encodeRepos } from './repos-url';
import { DEFAULT_ORDER, ORDERS } from './repos-vm';

describe('encodeRepos', () => {
  it('writes nothing for the order the map opens in, so a first visit stays a clean URL', () => {
    expect(encodeRepos({ order: DEFAULT_ORDER })).toBe('');
  });

  it('names a chosen order', () => {
    expect(encodeRepos({ order: 'recent' })).toBe('?order=recent');
    expect(encodeRepos({ order: 'name' })).toBe('?order=name');
  });

  it('round-trips every order the map offers', () => {
    for (const order of ORDERS) {
      expect(decodeRepos(encodeRepos({ order: order.key })).order ?? DEFAULT_ORDER).toBe(order.key);
    }
  });
});

describe('the chosen owner rides in the same codec (#583)', () => {
  it('names the chosen owner by login', () => {
    expect(encodeRepos({ order: DEFAULT_ORDER, owner: 'IvanRoslov' })).toBe('?owner=IvanRoslov');
    expect(decodeRepos('?owner=IvanRoslov')).toEqual({ owner: 'IvanRoslov' });
  });

  it('says "nobody" as its own param, so no login can ever be mistaken for it', () => {
    // A Github login is alphanumerics and inner hyphens, so `?owner=none` would
    // be a login somebody could hold. A separate flag cannot collide — the same
    // shape the IssuesViewer carries `unassigned` in.
    expect(encodeRepos({ order: DEFAULT_ORDER, owner: null })).toBe('?unowned=1');
    expect(decodeRepos('?unowned=1')).toEqual({ owner: null });
  });

  it('writes nothing when no owner narrows the map', () => {
    expect(encodeRepos({ order: DEFAULT_ORDER })).toBe('');
    expect(encodeRepos({ order: DEFAULT_ORDER, owner: undefined })).toBe('');
  });

  it('carries the owner and the order together, so a link reproduces the whole view', () => {
    expect(encodeRepos({ order: 'recent', owner: 'octocat' })).toBe('?order=recent&owner=octocat');
    expect(decodeRepos('?order=recent&owner=octocat')).toEqual({ order: 'recent', owner: 'octocat' });
    expect(decodeRepos('?order=name&unowned=1')).toEqual({ order: 'name', owner: null });
  });

  it('round-trips every owner the map can be narrowed to, alongside every order', () => {
    for (const order of ORDERS) {
      for (const owner of ['IvanRoslov', null, undefined] as const) {
        const back = decodeRepos(encodeRepos({ order: order.key, owner }));
        expect(back.order ?? DEFAULT_ORDER).toBe(order.key);
        expect(back.owner).toBe(owner);
      }
    }
  });

  it('tells "the link said nobody" apart from "the link said nothing"', () => {
    // `null` is the repos nobody owns and `undefined` is the whole map, and the
    // page acts differently on each.
    expect('owner' in decodeRepos('?unowned=1')).toBe(true);
    expect('owner' in decodeRepos('?order=name')).toBe(false);
  });

  it('ignores an owner param that names nobody at all', () => {
    expect(decodeRepos('?owner=')).toEqual({});
    expect(decodeRepos('?unowned=0')).toEqual({});
    expect(decodeRepos('?unowned=yes')).toEqual({});
  });

  it('lets the nobody flag win where a link somehow says both', () => {
    // Not a link this page writes; a hand-edited URL must still land somewhere
    // definite rather than on whichever param the parser reached first.
    expect(decodeRepos('?owner=octocat&unowned=1')).toEqual({ owner: null });
  });
});

describe('decodeRepos', () => {
  it('reads the order out of a link', () => {
    expect(decodeRepos('?order=security')).toEqual({});
    // Whether the caller kept the leading `?` is not the caller's problem.
    expect(decodeRepos('order=security')).toEqual({});
  });

  it('says nothing at all about a URL that names no order', () => {
    expect(decodeRepos('')).toEqual({});
    expect(decodeRepos('?')).toEqual({});
    expect(decodeRepos('?tab=repos')).toEqual({});
  });

  it('ignores an order it does not recognise rather than fabricating one', () => {
    // A link written against a fifth order that never shipped, or a typo.
    expect(decodeRepos('?order=pulls')).toEqual({});
    expect(decodeRepos('?order=')).toEqual({});
  });

  it('ignores every param that is not the order', () => {
    expect(decodeRepos('?q=board&label=bug&order=name')).toEqual({ order: 'name' });
  });
});


it('preserves health filters with owner and ordinary order, ignoring unknown facets', () => {
  for (const health of ['ci', 'security', 'secrets', 'dependencies', 'code-scanning'] as const) {
    const state = { order: 'recent' as const, owner: 'alice', health };
    expect(decodeRepos(encodeRepos(state))).toEqual(state);
  }
  expect(decodeRepos('?health=unknown&order=security')).toEqual({});
});
