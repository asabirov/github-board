import 'reflect-metadata'; // LINE 1. `PATH_METADATA` reads return undefined without it.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import type { ConfigService } from '@nestjs/config';
import type { CapabilityRegistry } from '../capability/capability.registry';
import { CAPABILITIES, type Capability } from '../capability/capability';
import { declaredWritesOf } from '../capability/writes-metadata-discovery.contract';
import { GithubReposSource } from '../repos/github-repos.source';
import { reportBootErrors } from '../boot-alert/boot-alert.notifier';
import { GithubIssueDetailSource } from './github-issue-detail.source';

/**
 * Which credential each Github write actually goes out under (#625).
 *
 * This measures the WIRE, not the intent: `fetch` is stubbed, every driver
 * below is a real source calling real Octokit, and the assertion reads the
 * `authorization` header the request carried. GITHUB_TOKEN and
 * GITHUB_WRITE_TOKEN are set to DIFFERENT strings for the whole run, so a call
 * on the wrong client is a different header rather than the same one.
 *
 * It exists because something else rests on it. The boot probe in
 * `capability/capability.registry.ts` reads scopes off GITHUB_WRITE_TOKEN and
 * seeds CREDENTIAL-WIDE `refused` verdicts that `CapabilityGuard` enforces from
 * the route alone. Before #625, nine of this board's thirteen Github mutations
 * rode the issue-detail source's READ client, so those verdicts described a
 * credential the writes never met — and the probe declined to seed anything at
 * all once the two tokens differed. Deleting that decline is only safe while
 * every write rides the write token. That is what this file measures, so the
 * next mutation put on a read client fails HERE rather than in production
 * behind a permanently-disabled write.
 *
 * The read half is measured in the SAME run, deliberately. A suite that only
 * looked at writes could not tell "every write moved" from "everything now runs
 * on one client that happens to be the write one".
 *
 * Two reads DO ride the write credential, on purpose and not by this lane's
 * doing — see `READS_ON_THE_WRITE_CREDENTIAL`. They are named one by one and
 * asserted to occur, so neither the rule nor its two exceptions can drift
 * without reddening something here.
 */

const READ_TOKEN = 'ghp_read_credential_aaaaaaaaaaaaaaaaaaaa';
const WRITE_TOKEN = 'ghp_write_credential_bbbbbbbbbbbbbbbbbbb';

const ENV: Record<string, unknown> = {
  GITHUB_TOKEN: READ_TOKEN,
  GITHUB_WRITE_TOKEN: WRITE_TOKEN,
  GITHUB_WRITE_ENABLED: true,
  GITHUB_ORGS: 'acme',
  FEEDBACK_REPO: 'acme/board',
  FEEDBACK_REPO_ID: 42,
  BOOT_ALERT_REPO_ID: 42,
  BOOT_ALERT_REPO: 'acme/board',
  BOOT_ALERT_ASSIGNEE: 'on-call',
  NODE_ENV: 'test',
};

const config = {
  get: (key: string, fallback?: unknown) => (key in ENV ? ENV[key] : fallback),
} as unknown as ConfigService;

/** Answers every capability question with "go ahead", and remembers nothing.
 *  What the envelope decides is not what this file measures. */
const permissive = {
  state: () => ({ state: 'available' as const }),
  recordRefusal: () => {},
  recordSuccess: () => {},
} as unknown as CapabilityRegistry;

// --- the wire ------------------------------------------------------------

interface Sent {
  /** Which driver was running. Named so a failure says WHICH call went out
   *  under the wrong credential — a bare header mismatch would not. */
  driver: string;
  method: string;
  url: string;
  body: string;
  token: string | null;
}

const sent: Sent[] = [];
let driver = '(none)';

/** A mutation, by the same test the Github write census uses: any non-GET REST
 *  call, and a GraphQL document that names a `mutation` operation. */
const isWrite = (s: Sent): boolean =>
  s.url.endsWith('/graphql') ? /\bmutation\b/.test(s.body) : s.method !== 'GET';

const describeSent = (s: Sent): string => `${s.driver}: ${s.method} ${new URL(s.url).pathname}`;

/**
 * The three READS that ride the WRITE credential on purpose, and are not this
 * lane's to move.
 *
 * The ownership schema read selects the property this credential will write.
 * `repo.dri`'s read-back is the write's own confirmation — `github-repos.source.ts`
 * shares one client with it deliberately, because a credential that could not
 * read the property back could not have written it. The boot notifier's dedupe
 * listing is the same shape: it exists only to choose between filing an issue
 * and commenting on one, and asked under another credential it could find an
 * issue the writing credential cannot comment on.
 *
 * Named individually rather than excused as a class, and each one is asserted to
 * have actually happened below — an allowlist nothing matches is an allowlist
 * that has quietly become a blanket.
 */
const READS_ON_THE_WRITE_CREDENTIAL = [
  'issue.state: GET /repos/acme/board',
  'issue.close: GET /repos/acme/board',
  'issue.assignees: GET /repos/acme/board',
  'issue.labels: GET /repos/acme/board',
  'issue.milestone: GET /repos/acme/board',
  'issue.body.task: GET /repos/acme/board',
  'issue.comment: GET /repos/acme/board',
  'repo.dri: GET /repos/acme/board',
  'boot-alert.file: GET /repos/acme/board',
  'boot-alert.file: GET /repositories/42',
  'repo.dri: GET /repos/acme/board/properties/values',
  'repo.dri: GET /orgs/acme/properties/schema',
  'boot-alert.file: GET /repos/acme/board/issues',
];

/** The issue the boot notifier's dedupe read finds, when there is one. */
const BOOT_ALERT_ISSUE = 7;
/** Whether it finds it. The notifier FILES an issue when the read comes back
 *  empty and COMMENTS on the one it finds when it does not — two Github writes
 *  on one client, and this answer is the only thing that chooses between them.
 *  The driver below runs the notifier once each way, so both are measured. */
let bootAlertIssueOpen = false;

function bodyFor(url: string, method: string, body: string): { status: number; json: unknown } {
  const path = new URL(url).pathname;
  if (path === '/graphql') {
    const query = String((JSON.parse(body || '{}') as { query?: string }).query ?? '');
    // Ahead of the `on ProjectV2` branch below, which the owner read's
    // `on ProjectV2Owner` would otherwise match (#982).
    if (query.includes('assignableUsers')) {
      return { status: 200, json: { data: { repository: { assignableUsers: { nodes: [{ login: 'ann', name: 'Ann Baker' }], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
    }
    if (query.includes('createProjectV2')) {
      return {
        status: 200,
        json: { data: { createProjectV2: { projectV2: { id: 'PVT_2', number: 2, title: 'measured', url: null } } } },
      };
    }
    if (query.includes('repositoryOwner')) {
      return {
        status: 200,
        json: {
          data: {
            repository: { issue: { id: 'I_1' } },
            repositoryOwner: { id: 'O_1', login: OWNER, projectsV2: { nodes: [] } },
          },
        },
      };
    }
    if (query.includes('addProjectV2ItemById')) {
      return { status: 200, json: { data: { addProjectV2ItemById: { item: { id: 'ITEM_1' } } } } };
    }
    if (query.includes('deleteProjectV2Item')) {
      return { status: 200, json: { data: { deleteProjectV2Item: { deletedItemId: 'ITEM_1' } } } };
    }
    if (query.includes('clearProjectV2ItemFieldValue')) {
      return { status: 200, json: { data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM_1' } } } } };
    }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      return { status: 200, json: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM_1' } } } } };
    }
    if (query.includes('on ProjectV2')) {
      return { status: 200, json: { data: { node: { owner: { __typename: 'Organization', login: 'acme' } } } } };
    }
    if (query.includes('issue(number:$n)')) {
      return { status: 200, json: { data: { repository: { issue: { id: 'I_1' } } } } };
    }
    return { status: 200, json: { data: { repository: { issue: null } } } };
  }
  if (path.endsWith('/properties/schema')) return { status: 200, json: [{ property_name: 'owner' }] };
  if (path.endsWith('/properties/values')) return { status: method === 'GET' ? 200 : 204, json: [] };
  if (/\/issues\/\d+$/.test(path)) {
    return { status: 200, json: { number: 1, body: '- [ ] a task', assignees: [], milestone: null } };
  }
  if (path.endsWith('/issues') && method === 'POST') {
    return { status: 201, json: { number: 1, html_url: 'https://github.com/acme/board/issues/1' } };
  }
  if (method === 'GET' && (path === '/repositories/42' || path === '/repos/acme/board')) return { status: 200, json: { id: 42, full_name: 'acme/board' } };
  if (path.endsWith('/issues') && method === 'GET') {
    return { status: 200, json: bootAlertIssueOpen ? [{ number: BOOT_ALERT_ISSUE }] : [] };
  }
  if (/\/issues\/\d+\/comments$/.test(path) && method === 'POST') {
    return {
      status: 201,
      json: { html_url: `https://github.com/acme/board/issues/${BOOT_ALERT_ISSUE}` },
    };
  }
  return { status: 200, json: [] };
}

const captureFetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
  const url = typeof input === 'string' ? input : String((input as { url: string }).url);
  const method = (init.method ?? 'GET').toUpperCase();
  const body = typeof init.body === 'string' ? init.body : '';
  const auth = new Headers(init.headers as Record<string, string>).get('authorization');
  sent.push({ driver, method, url, body, token: auth?.replace(/^(token|bearer)\s+/i, '') ?? null });
  const { status, json } = bodyFor(url, method, body);
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
};

/** Runs one driver and hands back only the requests IT made. */
async function drive(name: string, fn: () => Promise<unknown>): Promise<Sent[]> {
  const from = sent.length;
  driver = name;
  try {
    await fn();
  } finally {
    driver = '(none)';
  }
  return sent.slice(from);
}

// --- what has to be driven -----------------------------------------------

const OWNER = 'acme';
const REPO = 'board';
const issues = () => new GithubIssueDetailSource(config, permissive);

/** One boot-error report. Driven twice, once either side of
 *  `bootAlertIssueOpen`, because the notifier has two writes and its dedupe read
 *  is what picks between them. */
const bootAlert = () =>
  reportBootErrors(
    config,
    [{ level: 'error', message: 'measured', at: new Date().toISOString() }] as Parameters<typeof reportBootErrors>[1],
    { log: () => {}, error: () => {}, warn: () => {} },
    0,
    permissive,
  );

/**
 * One driver per capability in the vocabulary, keyed by the capability so the
 * table can be checked against a derivation rather than read for plausibility.
 *
 * Three capabilities carry more than one write, and each is driven in full:
 * `setFieldValue` clears with one GraphQL document and updates with another,
 * the boot notifier files an issue or comments on the one already open, and
 * `issue.assignees` replaces, adds and removes (#1009). A table keyed by
 * capability would otherwise cover one of each, and the uncovered rest is a
 * Github write nothing measures.
 */
const DRIVERS: Record<Capability, () => Promise<unknown>> = {
  'issue.state': () => issues().setState(OWNER, REPO, 1, 'open'),
  'issue.close': () => issues().close(OWNER, REPO, 1),
  'issue.assignees': async () => {
    const src = issues();
    await src.setAssignees(OWNER, REPO, 1, ['octocat']);
    await src.addAssignees(OWNER, REPO, 1, ['octocat']);
    await src.removeAssignees(OWNER, REPO, 1, ['octocat']);
  },
  'issue.labels': () => issues().setLabels(OWNER, REPO, 1, ['bug']),
  'issue.milestone': () => issues().setMilestone(OWNER, REPO, 1, 3),
  'issue.body.task': () => issues().toggleTask(OWNER, REPO, 1, 1, true),
  'issue.comment': () => issues().addComment(OWNER, REPO, 1, 'measured'),
  'issue.project.add': () => issues().addToProject(OWNER, REPO, 1, 'PVT_1'),
  'issue.project.create': () => issues().createProject(OWNER, REPO, 1, 'measured'),
  'issue.project.remove': () => issues().removeFromProject('ITEM_1', 'PVT_1', OWNER, REPO),
  'issue.field': async () => {
    const src = issues();
    await src.setFieldValue('PVT_1', 'ITEM_1', 'F_1', { kind: 'text', text: 'x' }, OWNER, REPO);
    await src.setFieldValue('PVT_1', 'ITEM_1', 'F_1', { kind: 'text', text: '' }, OWNER, REPO);
  },
  'repo.dri': () => new GithubReposSource(config, permissive).setDri(`${OWNER}/${REPO}`, null),
  // NOT derivable, and the one that is not: the boot notifier is a function the
  // bootstrap calls, not a Nest route, so no `@Writes` metadata reaches it and
  // `declaredWritesOf` cannot see it. Driven by name instead of dropped — and
  // driven twice, because it writes Github two ways and only one of them
  // happens on any given boot.
  'boot-alert.file': async () => {
    await bootAlert(); // nothing open: files the issue
    bootAlertIssueOpen = true;
    try {
      await bootAlert(); // one open: comments on it
    } finally {
      bootAlertIssueOpen = false;
    }
  },
};

/**
 * How many Github mutations each capability's driver puts on the wire. One
 * each, but for the three that carry more — and those are the reason this is a
 * map rather than a number. A floor of "at least one per capability" is cleared
 * by a pair that has quietly become a single, which is how the notifier's
 * comment branch went unmeasured for a whole lane.
 */
const WRITES_PER_CAPABILITY: Partial<Record<Capability, number>> = {
  // Replace, add and remove (#1009): three Github calls under one capability.
  'issue.assignees': 3,
  'issue.field': 2,
  'boot-alert.file': 2,
};
const writesExpected = (cap: Capability): number => WRITES_PER_CAPABILITY[cap] ?? 1;
/** Eighteen: fourteen capabilities, the second write `issue.field` and the
 *  notifier each make, and the second and third `issue.assignees` makes. */
const WRITES_ON_THE_WIRE = [...CAPABILITIES].reduce((n, cap) => n + writesExpected(cap), 0);

/** Reads driven in the same run, so "every write moved" is distinguishable from
 *  "everything moved". `learn`'s 404 re-read is measured separately below. */
const READERS: Record<string, () => Promise<unknown>> = {
  fetch: () => issues().fetch(OWNER, REPO, 1),
  editOptions: () => issues().editOptions(OWNER, REPO),
  projectOwnerLogin: () => issues().projectOwnerLogin('PVT_1'),
  // The assign picker's fresh read (#1009). A read, so it rides GITHUB_TOKEN.
  currentAssignees: () => issues().currentAssignees(OWNER, REPO, 1),
};

const CONTROLLER = join(__dirname, 'issue-detail.controller.ts');
let declaredCaps: string[] = [];
const byCapability = new Map<string, Sent[]>();
const byReader = new Map<string, Sent[]>();

beforeAll(async () => {
  vi.stubGlobal('fetch', captureFetch);
  const mod = (await import(pathToFileURL(CONTROLLER).href)) as Record<string, unknown>;
  const routes = Object.values(mod).flatMap((exported) => declaredWritesOf(exported));
  declaredCaps = [...new Set(routes.flatMap((r) => r.caps ?? []))].sort();
  for (const [cap, fn] of Object.entries(DRIVERS)) byCapability.set(cap, await drive(cap, fn));
  for (const [name, fn] of Object.entries(READERS)) byReader.set(name, await drive(name, fn));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('the set of writes this suite drives (#625)', () => {
  it('covers every capability the vocabulary names', () => {
    // Keyed by capability and compared to `CAPABILITIES` rather than hand-listed:
    // a fourteenth capability lands here as a missing key, before it can land in
    // production as a write nobody measured.
    expect(Object.keys(DRIVERS).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('covers every capability `@Writes` declares on the issue editor’s routes', () => {
    // The DERIVATION, read through the same metadata discovery
    // `writes-declared.spec.ts` gates the board with — not a second list of ten
    // names. An eleventh issue route, or a rename on either side, fails here.
    expect(declaredCaps.length, `metadata discovery found ${declaredCaps.length} capabilities`).toBeGreaterThanOrEqual(10);
    for (const cap of declaredCaps) expect(Object.keys(DRIVERS)).toContain(cap);
  });
});

describe('what the harness actually captured (#625)', () => {
  it('captured at least one request per write, so nothing below passes on an empty run', () => {
    // THE FLOOR. Every assertion in this file is a `for` over captured requests,
    // and a `for` over nothing passes. A stub that never got installed, an
    // Octokit that stopped reading `globalThis.fetch`, a driver that threw before
    // its request — all of them read as clean without this.
    const writes = sent.filter(isWrite);
    expect(writes.length, `captured ${writes.length} Github mutations`).toBeGreaterThanOrEqual(
      WRITES_ON_THE_WIRE,
    );
    expect(sent.filter((s) => !isWrite(s)).length).toBeGreaterThanOrEqual(Object.keys(READERS).length);
  });

  it('every driven capability produced the mutations it owes, and no others', () => {
    // Per capability and by COUNT, so "fourteen writes were captured" cannot be
    // satisfied by one driver writing fourteen times while another wrote
    // nothing — nor, which is subtler, by a capability that carries two writes
    // making only one of them.
    const made = Object.fromEntries([...byCapability].map(([cap, reqs]) => [cap, reqs.filter(isWrite).length]));
    const owed = Object.fromEntries([...CAPABILITIES].map((cap) => [cap, writesExpected(cap)]));
    expect(made).toEqual(owed);
  });

  it('the boot notifier both FILES and COMMENTS, so the pair is on the wire', () => {
    // The notifier's second write is the one this harness used not to reach:
    // with nothing open it filed and stopped, and `issues.createComment` never
    // happened. It shares the notifier's single client with `issues.create`, so
    // nothing could move it on its own today — but "every Github write rides the
    // write credential" is the sentence the deleted probe decline rests on, and
    // twelve of thirteen mutations is not that sentence.
    const boot = (byCapability.get('boot-alert.file') ?? []).filter(isWrite).map(describeSent);
    expect(boot).toEqual([
      'boot-alert.file: POST /repos/acme/board/issues',
      `boot-alert.file: POST /repos/acme/board/issues/${BOOT_ALERT_ISSUE}/comments`,
    ]);
  });

  it('saw BOTH credentials on the wire', () => {
    // The discriminator against "everything is on one client now". Without it a
    // tree where every call — read and write — ran on the write token would pass
    // the write assertions cleanly.
    expect(READ_TOKEN).not.toBe(WRITE_TOKEN);
    expect(sent.some((s) => s.token === READ_TOKEN)).toBe(true);
    expect(sent.some((s) => s.token === WRITE_TOKEN)).toBe(true);
  });
});

describe('the credential each Github call goes out under (#625)', () => {
  it('every mutation carries GITHUB_WRITE_TOKEN', () => {
    const wrong = sent.filter(isWrite).filter((s) => s.token !== WRITE_TOKEN).map(describeSent);
    expect(wrong).toEqual([]);
  });

  it('every read carries GITHUB_TOKEN but the two that ride the write credential on purpose', () => {
    // `toggleTask`'s body re-read and `addToProject`'s node-id lookup are in
    // here, because the split is per CALL and not per method: a write method
    // that reads first reads as the reader.
    const wrong = sent
      .filter((s) => !isWrite(s))
      .filter((s) => s.token !== READ_TOKEN)
      .map(describeSent)
      .filter((d) => !READS_ON_THE_WRITE_CREDENTIAL.includes(d));
    expect(wrong).toEqual([]);
  });

  it('both named write-credential reads actually happened, so the allowlist is not a blanket', () => {
    const seen = sent.filter((s) => !isWrite(s) && s.token === WRITE_TOKEN).map(describeSent);
    for (const named of READS_ON_THE_WRITE_CREDENTIAL) expect(seen).toContain(named);
    // And nothing ELSE reads under the write credential: an entry added to the
    // list above without a reason still has to be a read that occurs, and a read
    // that starts occurring without an entry fails the assertion before this one.
    expect([...new Set(seen)].sort()).toEqual([...READS_ON_THE_WRITE_CREDENTIAL].sort());
  });

  it('the three plain read paths carry GITHUB_TOKEN and mutate nothing', () => {
    for (const [name, reqs] of byReader) {
      expect(reqs.length, `${name} made no request`).toBeGreaterThan(0);
      expect(reqs.filter(isWrite).map(describeSent)).toEqual([]);
      expect(reqs.map((r) => r.token)).toEqual(reqs.map(() => READ_TOKEN));
    }
  });
});

describe('the 404 re-read that earns a refusal (#625)', () => {
  it('asks under the READ credential, because that is the question it is asking', async () => {
    // `learn`'s re-read asks whether the READ credential can still see the issue.
    // That is what lets a 404 on a write be classified as a refusal rather than
    // an absence. Moved to the write client it would answer a different
    // question, and an issue the write token cannot see would start reading as
    // an issue that is not there — so this pins it where the docblock says it is.
    // Captures exactly as above, then answers 404 to everything — so the write
    // is refused and the re-read finds nothing, which is the path that reaches
    // `learn`.
    const refusing = async (i: unknown, init: RequestInit = {}): Promise<Response> => {
      const response = await captureFetch(i, init);
      if (init.method === 'GET' && new URL(String(i)).pathname === '/repos/acme/board') return response;
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };
    vi.stubGlobal('fetch', refusing);
    const reqs = await drive('learn.reread', () =>
      issues().setState(OWNER, REPO, 1, 'open').catch(() => undefined),
    );
    vi.stubGlobal('fetch', captureFetch);

    const rereads = reqs.filter((r) => r.method === 'GET' && new URL(r.url).pathname.endsWith('/issues/1'));
    expect(rereads.length, 'the write never re-read the issue').toBe(1);
    expect(rereads[0].token).toBe(READ_TOKEN);
    expect(reqs.filter(isWrite).map((r) => r.token)).toEqual([WRITE_TOKEN]);
  });
});
