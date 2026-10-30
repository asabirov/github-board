import { PrincipalState } from '../auth/github-principal';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { CAPABILITIES, isCapability, type Capability } from './capability';
import { asMsg, type Refusal, type RefusalReason } from './github-refusal';
import { githubOrgs } from '../config/github-orgs';
// Type only, so this adds no runtime dependency on the ingest. The per-org read
// answers in the ingest's own record rather than a second shape of its own —
// one answer about an org, not two that may disagree (#647).
import type { OrgReadOutcome } from '../issues-metrics/github-issues.source';
import { buildOctokitClient, tokenFor } from '../sources/github-client';
import { logGithubFailure } from '../sources/github-quota';

/**
 * What the board remembers about what Github has refused it (#584).
 *
 * Github publishes no universal "what may this credential do" answer, so the
 * registry is fed three ways and they do not rank equally: an operator's deny
 * list is `declared`, a real refusal Github gave to a real write is `learned`,
 * and the boot probe's reading of a classic token's scope list is `probed`.
 * Nothing here refuses anything on its own — `unknown` is the answer to
 * everything unattempted, and `unknown` refuses nothing.
 */

export type CapabilityState = 'unknown' | 'available' | 'refused';
export type CapabilitySource = 'learned' | 'probed' | 'declared';

export interface CapabilityVerdict {
  state: CapabilityState;
  /** OPERATOR-facing, and logged rather than returned. It may name the scope the
   *  credential lacks, which is the credential's shape and no client's business. */
  why: string | null;
  /** PERSON-facing and safe to return over the wire. */
  publicMessage: string | null;
  /** Which refusal this was, carried so a verdict served from memory says the
   *  same thing the live refusal said. Without it a `not-permitted-yet` learned
   *  a moment ago is re-served as a plain `not-permitted`, and `authorizeUrl`
   *  below is the reason that distinction exists. `null` when not `refused`. */
  reason: RefusalReason | null;
  /** `not-permitted-yet` only: where the person goes to make it permitted. The
   *  registry carries it for the same reason the refusal does — a memoised SSO
   *  refusal that dropped the link would send someone to a dead end for the
   *  whole minute the entry lives. */
  authorizeUrl: string | null;
  /** When this verdict was formed. null when `unknown`. */
  since: Date | null;
  source: CapabilitySource | null;
}

export const CAPABILITY_TTL_MS = 15 * 60_000;
/** `not-permitted-yet` is the one refusal a person can fix themselves, so it must
 *  not outlive the click that fixes it by fifteen minutes. */
export const NOT_PERMITTED_YET_TTL_MS = 60_000;
/** Target-scoped entries are keyed by caller-supplied strings, so the map is
 *  bounded and evicted oldest-first. */
export const MAX_TARGET_ENTRIES = 500;

type Entry = {
  state: 'available' | 'refused';
  why: string | null;
  publicMessage: string | null;
  /** Carried so a memoised refusal answers with the same reason the live one
   *  did. `null` on an `available`. */
  reason: RefusalReason | null;
  /** `not-permitted-yet` only. Carried for the same reason: this is the one
   *  refusal a person can fix themselves, and the link is how. */
  authorizeUrl: string | null;
  at: number;
  /** `Infinity` for a probed entry: a scope list is not a moment. */
  ttl: number;
  source: CapabilitySource;
};

const RANK: Record<CapabilitySource, number> = { declared: 3, learned: 2, probed: 1 };

/** `::` and not a control character. A capability is dotted lowercase ASCII —
 *  `capability.ts` is the only place the twelve are spelled — and a target is
 *  `owner/repo`, and Github permits a colon in neither an owner nor a repository
 *  name. So neither half can contain the separator and no two pairs can collide
 *  on one key. A printable separator also survives a round trip through a log
 *  line, a grep and a markdown document; a NUL byte has failed to do that twice
 *  on this plan.
 *
 *  The TARGET half is lowercased, and this is a security rung rather than a
 *  tidiness one (#584, found independently by both reviewers of PR #609 and
 *  executed by one of them). The plan had the key kept exactly as it arrived,
 *  reasoning that raw spellings "under-refuse and never over-refuse". They do
 *  not: the envelope's owner-pin compares `.toLowerCase()`, so `Acme/x`
 *  passes the pin, and the `Map` lookup here compares exactly, so it misses the
 *  refusal recorded for `acme/x` — and Github resolves owners and repos
 *  case-insensitively, so both requests reach the SAME repository. A caller who
 *  wants the rung gone holds down one shift key; churn 500 case variants and the
 *  genuine refusal is evicted, killing the rung for the canonical URL too.
 *  Normalising here rather than in `write-envelope.ts` is what keeps producers
 *  and the envelope keying identically, whatever the path carried.
 *
 *  It claims no case-insensitivity Github does not promise: this half only ever
 *  holds `owner/repo`, which Github does resolve case-insensitively. The
 *  CAPABILITY half is left alone — those are lowercase ASCII by construction.
 *
 *  THE FOLD IS SAFE ONLY BECAUSE EVERY TARGET REACHING IT HAS PASSED
 *  `isRepoName` (`write-envelope.ts`), and that is a coupling, not a
 *  coincidence. Across `0x80`-`0x10FFFF` exactly ONE code point lowercases into
 *  Github's repo charset: U+212A KELVIN SIGN, which folds to ASCII `k`. So
 *  `acme/{U+212A}it` and `acme/kit` — two DIFFERENT repositories,
 *  Github resolving neither into the other — collapse onto one key here, and a
 *  refusal recorded for the first would darken the second. Within the ASCII
 *  charset the fold is injective up to letter case, and a case-only group is one
 *  repository, so nothing else can collide. `isRepoName`'s `[A-Za-z0-9._-]`
 *  rung is what keeps U+212A off this path, on BOTH subjects. Relaxing
 *  `REPO_NAME` to admit non-ASCII re-opens that cross-target collision; the test
 *  that holds the pair together is "a repo name that folds onto another target"
 *  in `write-envelope.spec.ts`. */
const targetKey = (cap: Capability, target: string) => `${cap}::${target.toLowerCase()}`;

/** Which capabilities a classic scope grants — read ONE WAY ONLY. A missing
 *  scope is a fact and produces `refused`; a present scope is a ceiling and
 *  produces nothing. #577's token held `repo` and still 404d on the org
 *  custom-property endpoint, so "has the scope" has never meant "can do it".
 *
 *  `repo.dri` is deliberately NOT in this map. It is the one capability #577
 *  proves the scope map wrong about, and listing it would have the probe
 *  announce `available` for the exact write that failed.
 *
 *  `public_repo` is deliberately not a key either: it grants a strict subset of
 *  `repo` and the board's org is private, so treating it as `repo` would report
 *  on writes that cannot happen. */
const SCOPE_CAPABILITIES: Record<string, Capability[]> = {
  repo: [
    'issue.close',
    'issue.state',
    'issue.assignees',
    'issue.labels',
    'issue.milestone',
    'issue.body.task',
    'issue.comment',
    'boot-alert.file',
  ],
  project: ['issue.project.add', 'issue.project.create', 'issue.project.remove', 'issue.field'],
};

export class CapabilityRegistry {
  private readonly principalState = new PrincipalState(() => ({
    entries: new Map<Capability, Entry>() as Map<Capability, Entry>,
    targets: new Map<string, Entry>() as Map<string, Entry>,
    bootOrgs: [] as OrgReadOutcome[]
  }));
  private readonly logger = new Logger(CapabilityRegistry.name);
  private get entries(): Map<Capability, Entry> { return this.principalState.current.entries; }
  private set entries(value: Map<Capability, Entry>) { this.principalState.current.entries = value; }
  /** Insertion-ordered, so the first key is the oldest — Map iteration order is
   *  specified, and that is what makes the eviction below oldest-first. */
  private get targets(): Map<string, Entry> { return this.principalState.current.targets; }
  private set targets(value: Map<string, Entry>) { this.principalState.current.targets = value; }
  private readonly denied: Set<Capability>;
  /** What `orgProbe()` saw at boot, kept for `orgsAtBoot()` alone (#650).
   *  Empty until `probe()` has run, and never written again after it. */
  private get bootOrgs(): OrgReadOutcome[] { return this.principalState.current.bootOrgs; }
  private set bootOrgs(value: OrgReadOutcome[]) { this.principalState.current.bootOrgs = value; }

  constructor(
    private readonly config: ConfigService,
    private readonly now: () => number = Date.now,
    /** Seam for the probe's one HTTP call. Production passes undefined. */
    private readonly probeRequest?: (token: string) => Promise<Record<string, string>>,
    /** Seam for the per-org read's one request. Production passes undefined. */
    private readonly orgRequest?: (org: string) => Promise<void>,
  ) {
    const raw = (config.get<string>('GITHUB_CAPABILITIES_DENY', '') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const bogus = raw.filter((s) => !isCapability(s));
    // Joi has already refused to boot on this, so in production the throw is
    // unreachable. It stays as the second line of defence, for a registry
    // constructed directly — in a spec, or by whatever calls this next.
    if (bogus.length) {
      throw new Error(`GITHUB_CAPABILITIES_DENY names no such capability: ${bogus.join(', ')}`);
    }
    this.denied = new Set(raw as Capability[]);
  }

  state(cap: Capability, target?: string): CapabilityVerdict {
    // PRECEDENCE, explicit: declared > learned > probed. Never insertion order —
    // a probed refusal would otherwise be self-sealing, because the real write
    // that would have disproved it is refused before it goes out.
    if (this.denied.has(cap)) {
      return {
        state: 'refused',
        why: 'Disabled by GITHUB_CAPABILITIES_DENY',
        publicMessage: 'The board is not permitted to do this.',
        reason: 'not-permitted',
        authorizeUrl: null,
        since: null,
        source: 'declared',
      };
    }
    const wide = this.live(this.entries, cap);
    // A credential-wide REFUSAL wins over everything, because a refusal is what
    // is true of every target. A credential-wide `available` does NOT: it is
    // written by recordSuccess on every successful write to ANY target, so
    // returning it here would mask a live target-scoped refusal for the whole
    // fifteen minutes the capability is in active successful use — which is the
    // common case, and precisely the case task 9's rung was added for. An
    // `available` learned from one target says nothing about another.
    if (wide?.state === 'refused') return this.verdict(wide);
    if (target) {
      const narrow = this.live(this.targets, targetKey(cap, target));
      if (narrow) return this.verdict(narrow);
    }
    if (wide) return this.verdict(wide);
    return {
      state: 'unknown',
      why: null,
      publicMessage: null,
      reason: null,
      authorizeUrl: null,
      since: null,
      source: null,
    };
  }

  private live<K>(map: Map<K, Entry>, key: K): Entry | undefined {
    const e = map.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > e.ttl) {
      // Nothing pushes a permission change to a running process, so every
      // learned answer is a claim about a moment. Expiring returns it to
      // `unknown`, which refuses nothing — the safe direction.
      map.delete(key);
      return undefined;
    }
    return e;
  }

  private verdict(e: Entry): CapabilityVerdict {
    return {
      state: e.state,
      why: e.why,
      publicMessage: e.publicMessage,
      reason: e.reason,
      authorizeUrl: e.authorizeUrl,
      since: new Date(e.at),
      source: e.source,
    };
  }

  recordRefusal(cap: Capability, r: Refusal, target?: string): void {
    // A 401 is not one capability's problem, and dropping the registry is a
    // property of THIS function rather than of every producer remembering to
    // call invalidateAll. Remembering is the failure mode #584 is about.
    if (r.reason === 'unauthenticated') {
      this.invalidateAll('Github rejected the board’s credential');
      return;
    }
    if (r.reason !== 'not-permitted' && r.reason !== 'not-permitted-yet') return;
    const ttl = r.reason === 'not-permitted-yet' ? NOT_PERMITTED_YET_TTL_MS : CAPABILITY_TTL_MS;
    const entry: Entry = {
      state: 'refused',
      // `why` may name the credential's shape and is LOGGED, never returned.
      why: r.missingPermission ? `${r.message} (wanted ${r.missingPermission})` : r.message,
      publicMessage: r.message,
      // Both carried. Without them a `not-permitted-yet` served from memory
      // during its one-minute life downgrades to a plain `not-permitted` and
      // loses the SSO link the reason exists to carry — a person sent to fix it
      // would meet a dead end for the whole minute the entry lives.
      reason: r.reason,
      authorizeUrl: r.authorizeUrl ?? null,
      at: this.now(),
      ttl,
      source: 'learned',
    };
    if (r.scope === 'credential') {
      this.put(this.entries, cap, entry);
    } else if (r.scope === 'target' && target) {
      this.putTarget(targetKey(cap, target), entry);
    } else {
      // scope 'none', or 'target' with nothing to key on. Believed nowhere.
      return;
    }
    this.logger.warn(
      `capability ${cap}${target ? ` on ${target}` : ''} refused by Github (${r.reason}, ${r.scope}): ${entry.why}`,
    );
  }

  recordSuccess(cap: Capability, target?: string): void {
    // Credential-wide, and deliberately weaker than a refusal: `state()` reads a
    // wide `available` only AFTER the target map, because this entry is written
    // by a success on one target and says nothing about any other.
    const entry: Entry = {
      state: 'available',
      why: null,
      publicMessage: null,
      reason: null,
      authorizeUrl: null,
      at: this.now(),
      ttl: CAPABILITY_TTL_MS,
      source: 'learned',
    };
    this.put(this.entries, cap, entry);
    if (target) this.targets.delete(targetKey(cap, target));
  }

  invalidateAll(why: string): void {
    this.entries.clear();
    this.targets.clear();
    this.logger.warn(`capability cache dropped: ${why}`);
  }

  snapshot(): Record<Capability, CapabilityState> {
    // Through state(), so the deny list and the TTL are honoured in ONE place.
    // Credential-wide only: a target-scoped entry answers a question the client
    // has not asked, and there is no bounded way to report all of them. What
    // that omits is enforced by the write envelope instead — `target-scope.spec.ts`
    // runs both halves of that claim rather than restating it here (#626).
    return Object.fromEntries(CAPABILITIES.map((cap) => [cap, this.state(cap).state])) as Record<
      Capability,
      CapabilityState
    >;
  }

  /**
   * The boot probe — log and continue, always.
   *
   * It runs the same prefix test Github's own `github/github-mcp-server` runs,
   * for the same reason: a fine-grained PAT (`github_pat_`) and an App
   * installation token (`ghs_`) publish no scopes anywhere, so there is nothing
   * to ask for.
   */
  async probe(): Promise<void> {
    // FIRST, and outside the try below, because every exit `probe()` takes from
    // here on is one the per-org read must not share. `capability.module.ts`
    // calls `probe()` and nothing else at boot, so this is where "beside it,
    // unconditionally" is spelled — not inside it.
    //
    // The return is KEPT now (#650), where it used to be dropped: it is the only
    // thing that can answer "which orgs can the board read" before the first
    // ingest has finished. See `orgsAtBoot()` for how narrow that is.
    this.bootOrgs = await this.orgProbe();
    try {
      const token = tokenFor(this.config, 'write');
      // `'write'`, and since #625 it means what it says. Every verdict this
      // probe writes is CREDENTIAL-WIDE, and `CapabilityGuard` enforces it from
      // the route alone — so a probed `refused` is only honest while the writes
      // it refuses actually go out under the credential probed here.
      //
      // Until #625 they did not. Nine of the board's thirteen Github mutations
      // rode the issue-detail source's memoized READ client, which holds
      // GITHUB_TOKEN and may well have had the scope; a narrower
      // GITHUB_WRITE_TOKEN would have disabled writes the board could still
      // make, permanently — a probed entry has `ttl: Infinity`, only a learned
      // success outranks it, and the guard refuses before any write can produce
      // one. So the probe declined to seed anything at all once the two tokens
      // differed. `github-issue-detail.source.ts` now sends those nine out
      // through a `'write'` client, and the decline went with them.
      //
      // `issue-detail/write-credential.spec.ts` is what keeps it true rather
      // than a claim made here: it drives every one of the twelve capabilities
      // with the two tokens set to DIFFERENT strings and reads the
      // `authorization` header each request carried. A mutation put back on a
      // read client fails there, naming itself.
      // Only a classic PAT and an OAuth user token answer this question at all.
      // The list is NOT exhaustive: a `ghu_` user-to-server token and a legacy
      // 40-hex classic PAT both skip here and stay `unknown`, which refuses
      // nothing. That is the safe failure and it is deliberate.
      if (!token.startsWith('ghp_') && !token.startsWith('gho_')) {
        this.logger.log('capability probe skipped: this credential publishes no scope list');
        return;
      }
      const headers = this.probeRequest
        ? await this.probeRequest(token)
        : ((await new Octokit({ auth: token }).request('HEAD /user')).headers as Record<
            string,
            string
          >);
      const raw = headers['x-oauth-scopes'];
      if (raw == null) return; // said nothing; claim nothing
      const held = new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      // A header that parses to NOTHING is the absent header, said differently:
      // `''`, whitespace, a lone comma. Read as a list of none it makes every
      // scope in the map absent, which refuses eleven of the twelve capabilities
      // off one blank line — `boot-alert.file` among them, and the notifier
      // consults that verdict UNGATED by the enforcing flag, so boot-error
      // reporting (#592) would go dark for the life of the process. A credential
      // that publishes an empty scope list has told us nothing we can act on.
      if (held.size === 0) {
        this.logger.log('capability probe: the credential published an empty scope list');
        return;
      }
      for (const [scope, caps] of Object.entries(SCOPE_CAPABILITIES)) {
        if (held.has(scope)) continue; // a ceiling, not a grant
        for (const cap of caps) {
          this.putProbed(cap, 'refused', `The board’s Github token has no ${scope} scope`);
        }
      }
    } catch (err) {
      // Log and continue, the github-mcp-server shape. A freshly minted
      // installation token can 401/403 while its permissions propagate, and a
      // probed entry has no TTL, so a probe that recorded a refusal here would
      // poison the registry until the next restart.
      this.logger.warn(`capability probe failed, continuing with no probed answers: ${asMsg(err)}`);
    }
  }

  /**
   * Read every configured org once at boot, and say how each went (#647).
   *
   * NOT part of `probe()` and NOT recorded in this registry, both deliberately.
   *
   * `probe()` gives up four ways before its scope loop — a token that is not
   * `ghp_`/`gho_` (the empty string an App deployment produces lands here), an
   * absent `x-oauth-scopes` header, a header that parses to nothing, and any
   * throw. A per-org read appended to it would be dead code on a fine-grained
   * PAT and on an App installation, which are exactly the credential shapes
   * likeliest to reach only one org. So it runs before all of them and shares
   * none of them.
   *
   * Nothing is written to the registry either. Entries here are keyed by
   * capability alone, are credential-wide, and a probed one never expires — so
   * one org's refusal recorded through `putProbed` would refuse that capability
   * for EVERY org for the life of the process, with no route to clear it. The
   * outcome is org-keyed instead, in the ingest's own record.
   *
   * Never rejects, and never records a refusal from a failure: `probe()` is
   * called as a floating promise at boot, and a freshly minted installation
   * token can 403 while its permissions propagate.
   */
  async orgProbe(): Promise<OrgReadOutcome[]> {
    let orgs: string[];
    try {
      orgs = githubOrgs(this.config);
    } catch (err) {
      this.logger.error(`org read skipped: ${asMsg(err)}`);
      return [];
    }
    // The same list read the ingest depends on, one page deep: an org the board
    // cannot enumerate is an org whose work it cannot see at all. `GET /orgs/{org}`
    // would answer for public metadata a credential can read without being able
    // to list a single repo, which is the reassurance this must not give.
    const ask =
      this.orgRequest ??
      (async (org: string) => {
        await buildOctokitClient(this.config, 'read').request('GET /orgs/{org}/repos', {
          org,
          per_page: 1,
        });
      });

    const out: OrgReadOutcome[] = [];
    for (const org of orgs) {
      try {
        await ask(org);
        out.push({ org, state: 'read', reason: null, calls: 1 });
        this.logger.log(`org read: ${org} — the board can list its repos`);
      } catch (err) {
        // The reason travels in the record, not only in the line below: the
        // record is what a surface can read.
        out.push({ org, state: 'unreadable', reason: asMsg(err), calls: 1 });
        // A quota refusal is a warning that says when, not a boot alert (#986).
        // The org is recorded unreadable either way.
        logGithubFailure(
          this.logger,
          err,
          `org read: ${org} — unreadable (${asMsg(err)}). Nothing is known about this org's ` +
            'work, so no surface may draw it as an org with nothing going on.',
          `org read: ${org} unreadable for now`,
        );
      }
    }
    return out;
  }

  /**
   * A BOOTSTRAP, and it has exactly one job (#650): fill the window between
   * process start and the first successful ingest, when there is no snapshot at
   * all and the alternative is a surface saying nothing about any org.
   *
   * It is NOT a second opinion on the ingest's record and must never be read
   * beside one. `orgProbe()` runs ONCE, at boot; this list is frozen from that
   * moment for the life of the process, so an org that broke ten minutes later
   * still reads `read` here and one that recovered still reads `unreadable`.
   * The single caller — `composeOrgReadState` — asks only while the ingest has
   * no run to describe, and stops asking the moment it has one.
   *
   * Empty before `probe()` has run, which is the honest answer then: nothing has
   * been measured, so nothing is claimed.
   */
  orgsAtBoot(): OrgReadOutcome[] {
    return this.bootOrgs;
  }

  private put<K>(map: Map<K, Entry>, key: K, entry: Entry): void {
    const held = map.get(key);
    if (held && RANK[held.source] > RANK[entry.source] && this.now() - held.at <= held.ttl) return;
    map.set(key, entry);
  }

  private putTarget(key: string, entry: Entry): void {
    this.targets.set(key, entry);
    // Bounded. The key contains a caller-supplied string, so an unbounded map is
    // a memory grief anyone signed in could cause even though they can no longer
    // cause a refusal.
    while (this.targets.size > MAX_TARGET_ENTRIES) {
      const oldest = this.targets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.targets.delete(oldest);
    }
  }

  /** Used by `probe()` and by the precedence test. Never overwrites a learned
   *  entry, which is the other half of `declared > learned > probed`. */
  private putProbed(
    cap: Capability,
    state: 'available' | 'refused',
    why: string | null = null,
  ): void {
    this.put(this.entries, cap, {
      state,
      why,
      publicMessage: state === 'refused' ? 'The board is not permitted to do this.' : null,
      reason: state === 'refused' ? 'not-permitted' : null,
      authorizeUrl: null,
      at: this.now(),
      ttl: CAPABILITY_TTL_MS,
      source: 'probed',
    });
  }
}
