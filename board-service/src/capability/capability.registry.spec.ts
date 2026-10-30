import { expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { CapabilityRegistry, CAPABILITY_TTL_MS, MAX_TARGET_ENTRIES } from './capability.registry';
import { CAPABILITIES } from './capability';
import { cfg } from './capability-testing.contract'; // task 1 wrote it; nobody re-declares it
import type { Refusal } from './github-refusal';

/**
 * Every test below is paired against its own opposite, and that is not
 * decoration. The expiry tests assert before AND after; the scope tests assert
 * this-target AND that-target; the two ordering tests assert each direction of
 * the precedence rule; the `not-permitted-yet` test asserts a refusal that
 * carries a link AND one that does not. A one-sided assertion here would pass
 * equally against a `state()` that always answered `unknown`, and that is the
 * shape of vacuity this repository has shipped.
 */

let t = 0;
const reg = (
  env: Record<string, unknown> = {},
  now: () => number = () => t,
  probeRequest?: (token: string) => Promise<Record<string, string>>,
) => new CapabilityRegistry(cfg(env), now, probeRequest);

const refusal = (over: Partial<Refusal> = {}): Refusal => ({
  reason: 'not-permitted',
  message: 'GitHub refused this write',
  status: 403,
  retryable: false,
  scope: 'credential',
  ...over,
});

it('an unattempted capability is unknown, and unknown never refuses', () => {
  expect(reg().state('repo.dri')).toEqual({
    state: 'unknown',
    why: null,
    publicMessage: null,
    reason: null,
    authorizeUrl: null,
    since: null,
    source: null,
  });
});

it('a credential-wide refusal is believed about every target', () => {
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ scope: 'credential' }));
  expect(r.state('repo.dri').state).toBe('refused');
  expect(r.state('repo.dri', 'acme/anything').state).toBe('refused');
  expect(r.state('repo.dri').source).toBe('learned');
});

it('a TARGET-scoped refusal is believed about that target and NOTHING else', () => {
  // The outage this design exists to prevent, as a test. Before the scope rule,
  // one unwritable repo darkened `repo.dri` for every repo and every person.
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ scope: 'target' }), 'acme/locked');
  expect(r.state('repo.dri', 'acme/locked').state).toBe('refused'); // this one
  expect(r.state('repo.dri', 'acme/other').state).toBe('unknown'); // not that one
  expect(r.state('repo.dri').state).toBe('unknown'); // and not in general
});

it('a target-scoped refusal with no target is believed nowhere', () => {
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ scope: 'target' }));
  expect(r.state('repo.dri').state).toBe('unknown');
});

it('a credential-wide AVAILABLE does not mask a live target-scoped refusal', () => {
  // The bug this ordering exists to stop, as a test — and it is the common case,
  // not an edge. `recordSuccess` writes a credential-wide `available` on every
  // successful write to any target, and it lives fifteen minutes. If `state()`
  // returned that before consulting the target map, a capability in ACTIVE
  // SUCCESSFUL USE would answer `available` for the one repo the board has just
  // been refused — defeating the target map and task 9's rung together, silently.
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ scope: 'target' }), 'acme/locked');
  r.recordSuccess('repo.dri', 'acme/other'); // a real write, elsewhere, lands
  expect(r.state('repo.dri', 'acme/locked').state).toBe('refused'); // still refused
  expect(r.state('repo.dri', 'acme/other').state).toBe('available'); // and this one is fine
  expect(r.state('repo.dri').state).toBe('available'); // credential-wide, unchanged
});

it('a credential-wide REFUSAL does outrank a target entry, because it is true of every target', () => {
  // The other side of the same rule, so neither direction can be hardcoded.
  const r = reg();
  r.recordSuccess('repo.dri', 'acme/other');
  r.recordRefusal('repo.dri', refusal({ scope: 'credential' }));
  expect(r.state('repo.dri', 'acme/other').state).toBe('refused');
});

it('and the credential-wide refusal is the verdict SERVED, not the target’s own', () => {
  // The test above holds the answer but not the rung that produces it: after a
  // `recordSuccess` there is no target entry left to lose to, so it passes with
  // the credential-wide-refusal rung deleted. This one keeps a live target entry
  // beside the credential-wide one and asks which came back.
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ scope: 'target', message: 'only this repo' }), 'acme/other');
  r.recordRefusal('repo.dri', refusal({ scope: 'credential', message: 'the credential itself' }));
  expect(r.state('repo.dri', 'acme/other').publicMessage).toBe('the credential itself');
});

it('a memoised not-permitted-yet still carries the link that makes it fixable', () => {
  // Without this the reason survives the round trip and the URL does not, so the
  // one refusal a person can fix themselves arrives with nothing to click for the
  // whole minute it lives.
  const r = reg();
  r.recordRefusal(
    'issue.state',
    refusal({
      reason: 'not-permitted-yet',
      authorizeUrl: 'https://github.com/orgs/acme/sso?authorization_request=abc',
    }),
  );
  const v = r.state('issue.state');
  expect(v.reason).toBe('not-permitted-yet');
  expect(v.authorizeUrl).toBe('https://github.com/orgs/acme/sso?authorization_request=abc');
  // …and a plain refusal carries neither, so this is not asserting a constant.
  r.recordRefusal('issue.labels', refusal());
  expect(r.state('issue.labels').reason).toBe('not-permitted');
  expect(r.state('issue.labels').authorizeUrl).toBeNull();
});

it('does NOT learn from a try-again', () => {
  // A throttle is not a permission answer. Recording it would refuse a write
  // that was only ever asked to wait — the failure `isThrottled` existed to
  // stop, moved into the registry.
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ reason: 'try-again', retryable: true, scope: 'none' }));
  expect(r.state('repo.dri').state).toBe('unknown');
});

it('does not learn from a try-again even when one arrives credential-wide', () => {
  // The scope rung alone would drop today's throttle, because the classifier
  // gives every `try-again` scope `none` — so the test above holds the scope
  // rung and not the reason one. This holds the reason rung: which KIND of
  // answer is a permission answer at all, whatever scope it claims.
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ reason: 'try-again', retryable: true, scope: 'credential' }));
  expect(r.state('repo.dri').state).toBe('unknown');
});

it('a learned refusal logs what the endpoint wanted and returns only what a person may read', () => {
  const r = reg();
  r.recordRefusal('issue.labels', refusal({ missingPermission: 'issues=write' }));
  const v = r.state('issue.labels');
  expect(v.why).toContain('issues=write'); // logged
  expect(v.publicMessage).not.toContain('issues=write'); // returned
  expect(v.since).toBeInstanceOf(Date); // and stamped, so a verdict says when
});

it('a success clears the stale refusal at the same target', () => {
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ scope: 'target' }), 'acme/locked');
  expect(r.state('repo.dri', 'acme/locked').state).toBe('refused'); // before
  r.recordSuccess('repo.dri', 'acme/locked');
  expect(r.state('repo.dri', 'acme/locked').state).toBe('available'); // after
});

// #584, PR #609 review. `owner/repo` is one identity to Github however it is
// spelled, and the envelope's owner-pin already compares case-insensitively — so
// a key that compared exactly handed anyone a one-keystroke bypass of the rung.
// Both directions are asserted: a re-cased lookup FINDS the refusal, and a
// target nothing was ever recorded for is still unknown.
it('a target refusal is found however the path was cased', () => {
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ scope: 'target' }), 'acme/locked');
  for (const spelling of ['Acme/locked', 'acme/Locked', 'ACME/LOCKED']) {
    expect(r.state('repo.dri', spelling).state, `${spelling} was not matched`).toBe('refused');
  }
  expect(r.state('repo.dri', 'Acme/other').state).toBe('unknown');
});

it('a target refusal recorded in MIXED case is found by the canonical path', () => {
  // The producers key the map too, so normalising only at lookup would leave the
  // two halves disagreeing in the other direction — a refusal Github gave for
  // `Acme/locked` invisible to the canonical URL everyone actually uses.
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ scope: 'target' }), 'Acme/Locked');
  expect(r.state('repo.dri', 'acme/locked').state).toBe('refused');
});

it('a success clears a refusal held under a different casing', () => {
  // Without this the write lands and the board goes on refusing the next one for
  // the whole fifteen minutes the entry lives.
  const r = reg();
  r.recordRefusal('repo.dri', refusal({ scope: 'target' }), 'acme/locked');
  r.recordSuccess('repo.dri', 'Acme/Locked');
  expect(r.state('repo.dri', 'acme/locked').state).toBe('available');
});

it('an EXPIRED learned refusal does not outrank a fresh probe', () => {
  // The rank guard reads the map directly rather than through `live()`, so
  // without its liveness clause a learned entry nobody may believe any more
  // would keep the probe out of that slot for the life of the process.
  t = 0;
  const r = reg();
  r.recordRefusal('issue.field', refusal());
  t += CAPABILITY_TTL_MS + 1;
  (r as unknown as { putProbed(c: string, s: 'refused', why: string): void }).putProbed(
    'issue.field',
    'refused',
    'The board’s Github token has no project scope',
  );
  expect(r.state('issue.field').source).toBe('probed');
});

it('a learned refusal expires, and the same capability goes back to unknown', () => {
  t = 0;
  const r = reg();
  r.recordRefusal('repo.dri', refusal());
  expect(r.state('repo.dri').state).toBe('refused'); // before
  t += CAPABILITY_TTL_MS + 1;
  expect(r.state('repo.dri').state).toBe('unknown'); // after
});

it('not-permitted-yet expires in a minute, not a quarter of an hour', () => {
  t = 0;
  const r = reg();
  r.recordRefusal('issue.state', refusal({ reason: 'not-permitted-yet' }));
  t += 61_000;
  expect(r.state('issue.state').state).toBe('unknown'); // the SSO link works again
  t = 0;
  r.recordRefusal('issue.labels', refusal({ reason: 'not-permitted' }));
  t += 61_000;
  expect(r.state('issue.labels').state).toBe('refused'); // and the other one does not
});

it('an unauthenticated refusal drops the WHOLE registry, from recordRefusal itself', () => {
  // Not from one call site remembering to call invalidateAll. Remembering is the
  // failure mode this entire issue is about.
  const r = reg({ GITHUB_CAPABILITIES_DENY: 'issue.close' });
  r.recordSuccess('repo.dri');
  r.recordRefusal('issue.labels', refusal({ scope: 'target' }), 'acme/board');
  expect(r.state('repo.dri').state).toBe('available'); // before
  r.recordRefusal('issue.state', refusal({ reason: 'unauthenticated' }));
  expect(r.state('repo.dri').state).toBe('unknown'); // after
  expect(r.state('issue.labels', 'acme/board').state).toBe('unknown');
  // …and the operator's switch is untouched, which is the whole point of it
  expect(r.state('issue.close').state).toBe('refused');
  expect(r.state('issue.close').source).toBe('declared');
});

it('precedence is declared > learned > probed, never insertion order', () => {
  const r = reg();
  r.recordRefusal('repo.dri', refusal()); // learned
  (r as unknown as { putProbed(c: string, s: 'available'): void }).putProbed('repo.dri', 'available');
  expect(r.state('repo.dri').state).toBe('refused'); // learned wins
  expect(r.state('repo.dri').source).toBe('learned');
});

it('the target map is bounded and evicts oldest-first', () => {
  const r = reg();
  for (let i = 0; i <= MAX_TARGET_ENTRIES; i += 1) {
    r.recordRefusal('repo.dri', refusal({ scope: 'target' }), `acme/r${i}`);
  }
  expect(r.state('repo.dri', 'acme/r0').state).toBe('unknown'); // evicted
  expect(r.state('repo.dri', `acme/r${MAX_TARGET_ENTRIES}`).state).toBe('refused');
});

it('why is operator-facing and publicMessage is not the same string', () => {
  const r = reg();
  (r as unknown as { putProbed(c: string, s: 'refused', why: string): void }).putProbed(
    'repo.dri',
    'refused',
    'The board’s Github token has no repo scope',
  );
  const v = r.state('repo.dri');
  expect(v.why).toContain('repo scope'); // logged
  expect(v.publicMessage).not.toContain('repo scope'); // returned
});

it('a deny-list entry that is not a capability is refused at construction', () => {
  expect(() => reg({ GITHUB_CAPABILITIES_DENY: 'issue.clsoe' })).toThrow(/issue\.clsoe/);
});

it('snapshot answers every capability, through state(), honouring the deny list', () => {
  const r = reg({ GITHUB_CAPABILITIES_DENY: 'issue.close' });
  const snap = r.snapshot();
  expect(Object.keys(snap).sort()).toEqual([...CAPABILITIES].sort());
  expect(snap['issue.close']).toBe('refused');
  expect(snap['repo.dri']).toBe('unknown');
});

it('the probe resolves even when the token prefix says not to bother', async () => {
  // The request is injected and COUNTED rather than left out. Left out, this
  // test passes with the prefix test deleted — by making a real HTTP call to
  // Github from the suite and swallowing whatever came back.
  let asked = 0;
  const r = reg({ GITHUB_TOKEN: 'github_pat_11ABCDE' }, () => t, async () => {
    asked += 1;
    return {};
  }); // fine-grained: no scopes header exists
  await expect(r.probe()).resolves.toBeUndefined();
  expect(asked).toBe(0); // it did not ask
  expect(r.state('repo.dri').state).toBe('unknown'); // and it learned nothing, correctly
});

it('the probe resolves when the request throws, and poisons nothing', async () => {
  const r = reg({ GITHUB_TOKEN: 'ghp_broken' }, () => t, async () => {
    throw new Error('ECONNRESET');
  });
  await expect(r.probe()).resolves.toBeUndefined();
  expect(r.state('repo.dri').state).toBe('unknown');
  // …and on a capability the probe CAN write. `repo.dri` is deliberately absent
  // from the scope map, so it is unpoisonable by construction and asserting on
  // it alone says nothing. A probe that recorded a refusal from a failure would
  // refuse `issue.field` here — with no TTL, until the next restart.
  expect(r.state('issue.field').state).toBe('unknown');
});

// ## The probe speaks for the WRITE credential (#584, PR #609 review; #625)
//
// Every verdict the probe can write is CREDENTIAL-WIDE and has no TTL, and
// `CapabilityGuard` enforces it from the route alone — so the probe may only
// speak for the credential the board's writes actually go out under.
//
// Until #625 it could not: nine of the board's thirteen Github mutations rode
// the issue-detail source's memoized `'read'` client, so a narrower
// GITHUB_WRITE_TOKEN seeded refusals on writes the board could still make, with
// no expiry and no route to reset them. The probe declined to seed anything at
// all once the two tokens differed. #625 split that client, the writes moved,
// and the decline went with them — measured on the wire, per capability, in
// `issue-detail/write-credential.spec.ts`.
it('probes as ever when GITHUB_WRITE_TOKEN is unset — every deployment today', async () => {
  const asked: string[] = [];
  const r = reg({ GITHUB_TOKEN: 'ghp_only' }, () => t, async (token) => {
    asked.push(token);
    return { 'x-oauth-scopes': 'repo' };
  });
  await r.probe();
  expect(asked).toEqual(['ghp_only']);
  expect(r.state('issue.field').state).toBe('refused'); // `project` absent → a fact
});

it('a credential without the repo scope reports issue.comment refused, like its siblings (#693)', async () => {
  // The scope map is read ONE WAY ONLY: a missing scope is a fact. Answering an
  // issue is a `repo` write exactly as the other issue writes are, so a token
  // lacking that scope has to be pre-refused for commenting too. A capability
  // left out of the map instead stays `unknown`, and `unknown` refuses nothing —
  // which is the board offering a composer it cannot post with.
  t = 0;
  const without = reg({ GITHUB_TOKEN: 'ghp_project_only' }, () => t, async () => ({
    'x-oauth-scopes': 'project',
  }));
  await without.probe();
  expect(without.state('issue.comment').state).toBe('refused');
  // Beside a sibling, so a run where the probe seeded NOTHING cannot pass this.
  expect(without.state('issue.body.task').state).toBe('refused');

  // And the other direction: a present scope is a ceiling, never a permission,
  // so it seeds nothing and the capability stays open to be learned about.
  const with_ = reg({ GITHUB_TOKEN: 'ghp_repo' }, () => t, async () => ({ 'x-oauth-scopes': 'repo' }));
  await with_.probe();
  expect(with_.state('issue.comment').state).toBe('unknown');
});

it('probes as ever when GITHUB_WRITE_TOKEN is set to the SAME credential', async () => {
  // The other half, and the one that keeps the guard below from reading as
  // "GITHUB_WRITE_TOKEN present ⇒ no probe". Present and equal is not a seam.
  const asked: string[] = [];
  const r = reg({ GITHUB_TOKEN: 'ghp_same', GITHUB_WRITE_TOKEN: 'ghp_same' }, () => t, async (token) => {
    asked.push(token);
    return { 'x-oauth-scopes': 'repo' };
  });
  await r.probe();
  expect(asked).toEqual(['ghp_same']);
  expect(r.state('issue.field').state).toBe('refused');
});

it('asks the WRITE credential, and only it, when the two differ', async () => {
  // The seam, live. Before #625 nothing here could tell `'write'` from `'read'`:
  // the probe refused to ask at all on this input, and on every other input the
  // two purposes resolved to the same string. This is that discrimination.
  const asked: string[] = [];
  const r = reg({ GITHUB_TOKEN: 'ghp_read', GITHUB_WRITE_TOKEN: 'ghp_write' }, () => t, async (token) => {
    asked.push(token);
    return { 'x-oauth-scopes': 'repo' };
  });
  await r.probe();
  expect(asked).toEqual(['ghp_write']); // never 'ghp_read'
  // And it seeds, where it used to decline: `project` is absent from the write
  // credential's scopes, and the writes that capability guards now go out under
  // exactly that credential.
  expect(r.state('issue.field').state).toBe('refused');
});

it('a credential that answers with no scopes header is not a probe failure', async () => {
  // The guard's whole effect is on the log: without it the missing header is
  // read anyway, throws inside the try, and lands in the catch — same verdicts,
  // but an operator is told the probe FAILED when Github answered fine and
  // simply had no scopes to publish.
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  try {
    const r = reg({ GITHUB_TOKEN: 'ghp_headerless' }, () => t, async () => ({}));
    await expect(r.probe()).resolves.toBeUndefined();
    expect(r.state('issue.field').state).toBe('unknown'); // claimed nothing
    expect(warn).not.toHaveBeenCalled(); // and blamed nobody
    // …and it is not the EMPTY-header case below wearing a different fixture:
    // that one logs, this one returns before any log line.
    expect(log).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
});

it('an EMPTY scopes header claims nothing, the way an absent one does', async () => {
  // Measured rather than asserted. Before this guard, a blank `x-oauth-scopes`
  // built an empty held-set and every scope in the map read as absent, so ONE
  // header refused eleven of the twelve capabilities at once — `boot-alert.file`
  // among them, which boot-alert.notifier.ts:46 consults UNGATED by the
  // enforcing flag before filing a boot error. Boot-error reporting, which is
  // the whole of #592, then went dark for the life of the process.
  //
  // Four spellings of blank, because `,` and ` , ` parse to nothing exactly as
  // `''` does and a guard that only trimmed would miss them.
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  try {
    for (const blank of ['', '   ', ',', ' , ']) {
      log.mockClear();
      const r = reg({ GITHUB_TOKEN: 'ghp_blank' }, () => t, async () => ({
        'x-oauth-scopes': blank,
      }));
      await r.probe();
      const refused = CAPABILITIES.filter((c) => r.state(c).state === 'refused');
      expect(
        refused,
        `${JSON.stringify(blank)} refused ${refused.length} of ${CAPABILITIES.length}`,
      ).toEqual([]);
      // The same verdict as the absent header, by a DIFFERENT route, and the log
      // is where the two are told apart: an absent header returns before this
      // line is reached and says nothing at all. Without the assertion, a spec
      // that only read the verdicts would pass on a probe that never looked at
      // the header.
      expect(log).toHaveBeenCalledWith(expect.stringContaining('empty scope list'));
    }
  } finally {
    log.mockRestore();
  }
});

it('the probe writes refused from an ABSENT scope and leaves a present one unknown', async () => {
  // Presence is a ceiling, not a grant — #577's token held `repo` and still 404d
  // on the org custom-property endpoint. So a held scope proves nothing and a
  // missing one proves a lot.
  const r = reg({ GITHUB_TOKEN: 'ghp_real' }, () => t, async () => ({ 'x-oauth-scopes': 'repo' }));
  await r.probe();
  expect(r.state('issue.state').state).toBe('unknown'); // `repo` held → no claim
  expect(r.state('issue.field').state).toBe('refused'); // `project` absent → a fact
  expect(r.state('issue.field').source).toBe('probed');
});

it('a probed verdict expires so permission changes are learned again', async () => {
  t = 0;
  const r = reg({ GITHUB_TOKEN: 'ghp_real' }, () => t, async () => ({ 'x-oauth-scopes': 'repo' }));
  await r.probe();
  t += CAPABILITY_TTL_MS * 100;
  expect(r.state('issue.field').state).toBe('unknown');
});

// ## The per-org read (#647)
//
// It is NOT part of `probe()`, and that is the whole design. `probe()` returns
// early four ways before its scope loop — a token that is not `ghp_`/`gho_`
// (which includes the empty string an App deployment produces), an absent scope
// header, a header that parses to nothing, and any throw — so a per-org read
// appended to it would be dead code on exactly the credential shapes most likely
// to be single-org. It also writes CREDENTIAL-WIDE entries at `ttl: Infinity`
// with no org axis, so one org's refusal would darken another for the life of
// the process with nothing able to clear it.
//
// So `orgProbe()` runs beside it, unconditionally, and records nothing in the
// registry. Its outcome is org-keyed and lands in the ingest's `orgs[]` record.

/** Runs `probe()` — the boot entry point `capability.module.ts` calls — and
 *  reports which orgs the per-org read actually asked about. */
const orgsAskedByBoot = async (env: Record<string, unknown>) => {
  const asked: string[] = [];
  const r = new CapabilityRegistry(
    cfg(env),
    () => t,
    async () => ({}),
    async (org: string) => {
      asked.push(org);
    },
  );
  await r.probe();
  return { asked, registry: r };
};

it('logs a line per configured org, so silence cannot read as a pass', async () => {
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  try {
    const r = new CapabilityRegistry(
      cfg({ GITHUB_ORGS: 'acme,globex', GITHUB_TOKEN: 'github_pat_1' }),
      () => t,
      async () => ({}),
      async (org: string) => {
        if (org === 'globex') throw new Error('404 Not Found');
      },
    );
    await r.orgProbe();
    const lines = [...log.mock.calls, ...err.mock.calls].map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('acme'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('globex'))).toHaveLength(1);
    // The unreadable one says so. A line that read the same for both would make
    // the output useless for the one question it exists to answer.
    expect(lines.find((l) => l.includes('globex'))).toMatch(/unreadable/);
    expect(lines.find((l) => l.includes('acme'))).not.toMatch(/unreadable/);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
});

it('reports each org as read or unreadable, never as nothing at all', async () => {
  const r = new CapabilityRegistry(
    cfg({ GITHUB_ORGS: 'acme,globex' }),
    () => t,
    async () => ({}),
    async (org: string) => {
      if (org === 'globex') throw new Error('404 Not Found');
    },
  );
  const out = await r.orgProbe();
  expect(out.map((o) => [o.org, o.state])).toEqual([
    ['acme', 'read'],
    ['globex', 'unreadable'],
  ]);
  // …and WHY, in the same record the ingest fills. An outcome that says only
  // `unreadable` leaves a surface unable to tell a 404 from a dead credential,
  // and the log line it would have to read instead is not a surface.
  expect(out[1].reason).toMatch(/404 Not Found/);
  expect(out[0].reason).toBeNull();
});

it('the per-org read runs on a fine-grained PAT, an App installation, and a split write token', async () => {
  // The three credential shapes `probe()` gives up on before its loop. A read
  // appended to `probe()` would be dead code on all three — and a single-org
  // credential is likelier to be one of them than to be a classic PAT.
  const orgs = 'acme,globex';
  expect((await orgsAskedByBoot({ GITHUB_ORGS: orgs, GITHUB_TOKEN: 'github_pat_1' })).asked).toEqual([
    'acme',
    'globex',
  ]);
  // App installation: no token at all, which `tokenFor` answers with ''.
  expect((await orgsAskedByBoot({ GITHUB_ORGS: orgs })).asked).toEqual(['acme', 'globex']);
  expect(
    (
      await orgsAskedByBoot({
        GITHUB_ORGS: orgs,
        GITHUB_TOKEN: 'ghp_read',
        GITHUB_WRITE_TOKEN: 'ghp_write',
      })
    ).asked,
  ).toEqual(['acme', 'globex']);
});

it('an org that fails to read never darkens another org’s capability', async () => {
  const r = new CapabilityRegistry(
    cfg({ GITHUB_ORGS: 'acme,globex', GITHUB_TOKEN: 'ghp_x' }),
    () => t,
    async () => ({}),
    async () => {
      throw new Error('403 Forbidden');
    },
  );
  await r.orgProbe();
  // Nothing at all is recorded: the registry has no org axis, its entries are
  // credential-wide and never expire, and `state()` would hand one org's refusal
  // to every other for the life of the process.
  for (const cap of CAPABILITIES) expect(r.state(cap).state).toBe('unknown');
});

it('a GITHUB_ORGS that names no org is reported, not thrown — a boot probe never rejects', async () => {
  const r = new CapabilityRegistry(cfg({ GITHUB_ORGS: '  ' }), () => t, async () => ({}), async () => {});
  await expect(r.orgProbe()).resolves.toEqual([]);
  await expect(r.probe()).resolves.toBeUndefined();
});

/**
 * #650 — `probe()` KEEPS what the per-org read saw, where it used to drop it.
 *
 * Not a second opinion on the ingest's record: `orgProbe()` runs once, at
 * process start, so this list is frozen for the life of the process. It exists
 * to fill the window before the first ingest has finished, and
 * `composeOrgReadState` stops reading it the moment there is a run to describe.
 */
it('retains the per-org outcome from boot, so the pre-first-ingest window can be answered', async () => {
  const { registry } = await orgsAskedByBoot({ GITHUB_ORGS: 'acme' });
  expect(registry.orgsAtBoot()).toEqual([
    { org: 'acme', state: 'read', reason: null, calls: 1 },
  ]);
});

it('claims no org before probe() has run — nothing measured, nothing said', async () => {
  const r = new CapabilityRegistry(cfg({ GITHUB_ORGS: 'acme,globex' }), () => t);
  // NOT `read` for two orgs it has not asked about. An invented `read` is the
  // exact reassurance an unreadable org must not produce.
  expect(r.orgsAtBoot()).toEqual([]);
});

it('a boot read that failed is retained as unreadable, with its reason', async () => {
  const r = new CapabilityRegistry(
    cfg({ GITHUB_ORGS: 'acme,globex' }),
    () => t,
    async () => ({}),
    async (org: string) => {
      if (org === 'globex') throw new Error('404 Not Found');
    },
  );
  await r.probe();
  expect(r.orgsAtBoot().map((o) => [o.org, o.state])).toEqual([
    ['acme', 'read'],
    ['globex', 'unreadable'],
  ]);
  expect(r.orgsAtBoot()[1].reason).toMatch(/404 Not Found/);
});
