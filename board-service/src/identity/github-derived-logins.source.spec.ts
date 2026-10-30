import { describe, expect, it, vi } from 'vitest';
import { GithubDerivedLoginsSource, isBotLogin, isNoReplyAddress } from './github-derived-logins.source';

/**
 * A fake Octokit that HONOURS `order` — the point of two of these tests. A fake
 * that ignores it lets you delete the `asc` pass with every test still green,
 * and reading both ends of a member's history is the whole reason this source
 * places anybody at all.
 */
function octokitWith(members: string[], byLogin: Record<string, { asc?: string[]; desc?: string[] }>) {
  return {
    paginate: vi.fn(async () => members.map((login) => ({ login }))),
    rest: { orgs: { listMembers: vi.fn() } },
    request: vi.fn(async (_route: string, params: { q: string; order: 'asc' | 'desc' }) => {
      const login = /author:(\S+)/.exec(params.q)?.[1] ?? '';
      const emails = byLogin[login]?.[params.order] ?? [];
      return { data: { items: emails.map((email) => ({ commit: { author: { email } } })) } };
    }),
  };
}

const config = { get: (k: string, d?: unknown) => (k === 'GITHUB_ORGS' ? 'acme' : d) };

/** The sleep seam is injected in every test — otherwise the multi-member cases
 *  each burn 3 real seconds and sit one config change away from timing out. */
const build = (octo: unknown, cfg: unknown = config) =>
  new GithubDerivedLoginsSource(cfg as never, () => octo as never, async () => {});

describe('GithubDerivedLoginsSource', () => {
  it('places a member by an address their public profile does not publish', async () => {
    const octo = octokitWith(['octocat'], {
      octocat: { asc: ['octocat@example.com'], desc: ['octocat@example.com'] },
    });
    expect(await build(octo).derive()).toEqual({
      map: new Map([['octocat@example.com', 'octocat']]),
      complete: true,
    });
  });

  it('finds the work address when ONLY the oldest commits carry it', async () => {
    // Ivan's measured shape: 213 of his newest 300 are noreply, the work
    // address is underneath. Delete the `asc` pass and this must go red.
    const octo = octokitWith(['IvanRoslov'], {
      IvanRoslov: {
        asc: ['ivan.roslov@example.com'],
        desc: ['69309824+IvanRoslov@users.noreply.github.com'],
      },
    });
    expect((await build(octo).derive()).map).toEqual(new Map([['ivan.roslov@example.com', 'IvanRoslov']]));
  });

  it('finds the work address when ONLY the newest commits carry it', async () => {
    // The mirror — somebody who started private and later set an address.
    const octo = octokitWith(['someone'], {
      someone: { asc: ['1+someone@users.noreply.github.com'], desc: ['someone@example.com'] },
    });
    expect((await build(octo).derive()).map).toEqual(new Map([['someone@example.com', 'someone']]));
  });

  it('sleeps once per REQUEST, not once per member', async () => {
    // The rate-limit arithmetic, pinned. Two members = four searches = four
    // gaps. Sleeping per member emits two requests per gap and doubles the
    // true rate against a bucket that allows 30 a minute.
    const sleeps: number[] = [];
    const octo = octokitWith(['a', 'b'], { a: { asc: ['a@x.io'] }, b: { asc: ['b@x.io'] } });
    const src = new GithubDerivedLoginsSource(config as never, () => octo as never, async (ms) => {
      sleeps.push(ms);
    });
    await src.derive();
    expect(sleeps.length).toBe(4);
  });

  it('drops an address two logins both claim rather than picking one', async () => {
    const octo = octokitWith(['a', 'b'], { a: { asc: ['shared@x.io'] }, b: { asc: ['shared@x.io'] } });
    expect((await build(octo).derive()).map).toEqual(new Map());
  });

  it('drops a bot committing under a REAL address', async () => {
    // The case that matters. A bot whose only address is a noreply one is
    // dropped by the noreply filter, so it tests that filter twice and proves
    // nothing about this one.
    const octo = octokitWith(['releaser[bot]'], { 'releaser[bot]': { asc: ['ci@example.com'] } });
    expect((await build(octo).derive()).map).toEqual(new Map());
    expect(isBotLogin('releaser[bot]')).toBe(true);
  });

  it('reports the run incomplete when a search fails, and still keeps what it found', async () => {
    const octo = octokitWith(['ok', 'bad'], { ok: { asc: ['ok@x.io'] } });
    octo.request = vi.fn(async (_r: string, p: { q: string; order: 'asc' | 'desc' }) => {
      if (p.q.includes('author:bad')) throw new Error('403 rate limited');
      return { data: { items: p.order === 'asc' ? [{ commit: { author: { email: 'ok@x.io' } } }] : [] } };
    }) as never;
    expect(await build(octo).derive()).toEqual({ map: new Map([['ok@x.io', 'ok']]), complete: false });
  });

  it('reports incomplete rather than empty-and-healthy when EVERY search fails', async () => {
    // The rate-limit case. An empty map returned as a success is cached and
    // pinned, blanking every derived attribution for the whole interval.
    const octo = octokitWith(['a'], {});
    octo.request = vi.fn(async () => {
      throw new Error('403 rate limited');
    }) as never;
    expect(await build(octo).derive()).toEqual({ map: new Map(), complete: false });
  });

  it('propagates a failure to list members, because it saw nothing at all', async () => {
    const octo = octokitWith([], {});
    octo.paginate = vi.fn(async () => {
      throw new Error('401');
    }) as never;
    await expect(build(octo).derive()).rejects.toThrow('401');
  });

  it('derives nothing when it is handed no org, rather than querying "org:"', async () => {
    // `org:` alone is a malformed query, and a run that enumerated nothing must
    // read as a run that found nobody rather than as a failure.
    const octo = octokitWith(['a'], { a: { asc: ['a@x.io'] } });
    const src = new GithubDerivedLoginsSource(config as never, () => octo as never, async () => {}, []);
    expect(await src.derive()).toEqual({ map: new Map(), complete: true });
    expect(octo.paginate).not.toHaveBeenCalled();
  });

  it('follows GITHUB_ORGS, which is the machine scope it shares with the ingest', async () => {
    // The ingest and this source must answer the same owners: the ingest
    // reading one set while this read another derived every login from the WRONG
    // org, silently, on every person-shaped surface. `ISSUES_METRICS_ORG` could
    // split them and is retired (#1209 part 4), so one resolver answers both.
    const octo = {
      paginate: vi.fn(async (_r: unknown, p: { org: string }) =>
        p.org === 'globex' ? [{ login: 'second-org-only' }] : [],
      ),
      rest: { orgs: { listMembers: vi.fn() } },
      request: vi.fn(async () => ({ data: { items: [{ commit: { author: { email: 'x@y.io' } } }] } })),
    };
    const pinned = { get: (k: string, d?: unknown) => (k === 'GITHUB_ORGS' ? 'globex' : d) };
    expect((await build(octo, pinned).derive()).map.get('x@y.io')).toBe('second-org-only');
    expect(octo.paginate.mock.calls.map((c) => (c[1] as { org: string }).org)).toEqual(['globex']);
  });

  it('refuses a GITHUB_ORGS that names no org rather than deriving from a guess (#647)', () => {
    // The list is read through `githubOrgs`, which refuses a present-but-blank
    // value: an empty list would have to mean "no org" or "any org", and neither
    // is a thing an operator can have meant. Joi refuses it first, so in a
    // deployment this is the second door.
    const octo = octokitWith(['a'], {});
    const blank = { get: (k: string, d?: unknown) => (k === 'GITHUB_ORGS' ? '  ' : d) };
    expect(() => build(octo, blank)).toThrow(/GITHUB_ORGS/);
  });

  it('takes its orgs from GITHUB_ORGS, not from any one surface key (#647)', async () => {
    const octo = {
      paginate: vi.fn(async (_r: unknown, p: { org: string }) =>
        p.org === 'globex' ? [{ login: 'second-org-only' }] : [],
      ),
      rest: { orgs: { listMembers: vi.fn() } },
      request: vi.fn(async () => ({ data: { items: [{ commit: { author: { email: 'x@y.io' } } }] } })),
    };
    const two = { get: (k: string, d?: unknown) => (k === 'GITHUB_ORGS' ? 'acme,globex' : d) };
    expect((await build(octo, two).derive()).map.get('x@y.io')).toBe('second-org-only');
    expect(octo.paginate.mock.calls.map((c) => (c[1] as { org: string }).org)).toEqual([
      'acme',
      'globex',
    ]);
  });

  // ── every configured org, not the first one (#647) ────────────────────────
  //
  // `orgs` is one entry today, from GITHUB_ORGS. These drive the seam
  // with two, because a producer that walks the list and a producer that pins
  // `orgs[0]` are indistinguishable while the list has one member — and the
  // whole point of the field is the day it has two.
  describe('across every configured org', () => {
    /** A fake that HONOURS `org` on both calls. One that ignores it lets a
     *  single-org producer pass every test below. */
    function octokitAcrossOrgs(
      membersByOrg: Record<string, string[]>,
      emailsByOrgLogin: Record<string, Record<string, string[]>>,
    ) {
      return {
        paginate: vi.fn(async (_route: unknown, params: { org: string }) =>
          (membersByOrg[params.org] ?? []).map((login) => ({ login })),
        ),
        rest: { orgs: { listMembers: vi.fn() } },
        request: vi.fn(async (_route: string, params: { q: string }) => {
          const login = /author:(\S+)/.exec(params.q)?.[1] ?? '';
          const org = /org:(\S+)/.exec(params.q)?.[1] ?? '';
          const emails = emailsByOrgLogin[org]?.[login] ?? [];
          return { data: { items: emails.map((email) => ({ commit: { author: { email } } })) } };
        }),
      };
    }

    const twoOrgs = (octo: unknown) =>
      new GithubDerivedLoginsSource(config as never, () => octo as never, async () => {}, [
        'acme',
        'globex',
      ]);

    it('a member of only the second org gets a derived login', async () => {
      const octo = octokitAcrossOrgs(
        { 'acme': ['octocat'], globex: ['second-org-only'] },
        {
          'acme': { octocat: ['octocat@example.com'] },
          globex: { 'second-org-only': ['nobody@example.com'] },
        },
      );
      const { map, complete } = await twoOrgs(octo).derive();
      expect(map.get('nobody@example.com')).toBe('second-org-only');
      expect(complete).toBe(true);
    });

    it('learns an address somebody only ever used in the second org', async () => {
      // Same person, both orgs, a different address stamped on each org's
      // commits. Searching only the first org learns only the first address.
      const octo = octokitAcrossOrgs(
        { 'acme': ['octocat'], globex: ['octocat'] },
        {
          'acme': { octocat: ['octocat@example.com'] },
          globex: { octocat: ['octocat@example.com'] },
        },
      );
      const { map } = await twoOrgs(octo).derive();
      expect(map.get('octocat@example.com')).toBe('octocat');
      expect(map.get('octocat@example.com')).toBe('octocat');
    });

    it('enumerates somebody in both orgs once, rather than searching them twice', async () => {
      // What the de-dupe actually costs when it is missing is WORK, not the map:
      // `byLogin` is a Map, so the same login arriving twice overwrites its own
      // entry and no ambiguity can arise from it whatever the code does. The
      // duplicate is paid for in searches — every one of them paced, against the
      // 30-a-minute search bucket.
      const octo = octokitAcrossOrgs(
        { 'acme': ['octocat'], globex: ['octocat'] },
        { 'acme': { octocat: ['octocat@example.com'] }, globex: {} },
      );
      expect((await twoOrgs(octo).derive()).map).toEqual(new Map([['octocat@example.com', 'octocat']]));
      // One member, two orgs, both ends of their history in each: four searches.
      // Enumerated twice it is eight.
      expect(octo.request).toHaveBeenCalledTimes(4);
    });

    it('sleeps once per request — two orgs, one member, two ends each', async () => {
      const sleeps: number[] = [];
      const octo = octokitAcrossOrgs({ 'acme': ['a'], globex: [] }, { 'acme': { a: ['a@x.io'] } });
      const src = new GithubDerivedLoginsSource(
        config as never,
        () => octo as never,
        async (ms) => {
          sleeps.push(ms);
        },
        ['acme', 'globex'],
      );
      await src.derive();
      // one member × two orgs × two ends
      expect(sleeps.length).toBe(4);
    });
  });

  it('recognises the noreply form regardless of the numeric prefix', () => {
    expect(isNoReplyAddress('69309824+IvanRoslov@users.noreply.github.com')).toBe(true);
    expect(isNoReplyAddress('ivan.roslov@example.com')).toBe(false);
  });
});
