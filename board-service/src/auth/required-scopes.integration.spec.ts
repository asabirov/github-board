import { GithubUserService } from './github-user.service';
import 'reflect-metadata';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { request as httpRequest } from 'http';
import { SignJWT } from 'jose';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminAuthority } from './admin-authority';
import { SessionService } from './session.service';
import { expandPreset, deriveAgentFlag } from './scopes';
import { toolNamesForScope } from '../mcp/overview-tools';

/**
 * End-to-end back-compat lock for #56 (fine-grained board:* scopes). Boots the
 * REAL AppModule — the full APP_GUARD chain (JwtAuthGuard → TeamAccessGuard →
 * RequiredScopesGuard) plus every route decorator — and drives it over actual
 * HTTP with a static BOARD_AGENT_TOKENS bearer, the same shape a deployed agent
 * presents. This is the proof that the guard-unit tests
 * (jwt-auth.guard.spec.ts, required-scopes.guard.spec.ts) are individually
 * correct AND wired together correctly in the real module graph — in particular
 * that the fail-closed default for undecorated WRITE routes actually denies a
 * real agent token at the HTTP layer, not just in the guard's own unit test.
 *
 * AppModule is imported dynamically, AFTER the env vars below are set. Its
 * ConfigModule.forRoot() call reads process.env synchronously at *import*
 * time (a static top-level import would run before this file's own code), and
 * @nestjs/config gives process.env priority over anything parsed from a local
 * .env file — so this guarantees deterministic fixture-only config regardless
 * of whatever a developer's untracked board-service/.env happens to contain.
 *
 * That env block and that import sit at MODULE scope, not in `beforeAll`, since
 * #743; static imports are hoisted over both, so the ordering above survives.
 * docs/traps.md says why the load may not sit in the hook.
 */
const AGENT_NAME = 'ci-integration-agent';
const AGENT_SECRET = randomBytes(32).toString('hex'); // 64 hex chars, per BOARD_AGENT_TOKENS format
// BOARD_AGENT_TOKENS is the server-side map ("name:secret"); the bearer a
// caller PRESENTS is the secret alone — the server resolves the name by
// scanning the map for a matching secret (see matchAgentToken).
const AGENT_TOKEN_ENV = `${AGENT_NAME}:${AGENT_SECRET}`;
const SESSION_SECRET = 'integration-secret-0123456789-required-scopes-e2e';
/** The one team member the fixture roster + allow list are built from. */
const TEAM_MEMBER = 'octocat';
/** The numeric GitHub id the human session mints under, admitted by the allow
 *  list beside the login so the roster below still names a real person. */
const TEAM_MEMBER_ID = '9001';

// --- Auth / agent wiring under test ---
process.env.AUTH_DISABLED = 'false';
process.env.BOARD_AGENT_TOKENS = AGENT_TOKEN_ENV;
process.env.BOARD_SESSION_SECRET = SESSION_SECRET;
// Off since #456. This spec boots the real AppModule with no database, and
// `BOARD_MCP_ENABLED=true` now requires `IDENTITY_SOURCE=db` — so the pairing
// this line used to set refuses to boot. Nothing here reads the flag: the
// routes under test are REST, `/mcp` is deliberately out of scope (see the
// note further down), and `/api/admin/agents` is refused by the scope guard
// long before the service that reports `mcpEnabled` ever runs.
process.env.BOARD_MCP_ENABLED = 'false';
// One member: it is both the GitHub allow list (who may sign in) and the
// fixture people source (the roster /api/people serves), so the roster below
// has a real person on it to redact rather than an empty list that proves
// nothing.
process.env.BOARD_ALLOWED_GITHUB = `${TEAM_MEMBER},${TEAM_MEMBER_ID}`;
process.env.BOARD_FIXTURE_ADMINS = '';
// Makes the static agent token's own actor an ADMIN, which is what sets up
// the #471 scenario below. Fixture identities store no roles, so the
// dormant break-glass (#371) is active and this env IS the admin set.
process.env.BOARD_ADMIN_EMAILS = `agent:${AGENT_NAME}`;

// --- Every data source forced to fixture/local so boot never touches the
// network, regardless of GitHub creds sitting in a local .env. ---
process.env.ISSUES_SOURCE = 'fixture';
process.env.PROJECTS_SOURCE = 'fixture';
process.env.IDENTITY_SOURCE = 'fixture';
// The org the fixture sources are written against, named rather than defaulted
// (#1166). It was `GITHUB_ORGS`'s and `FEEDBACK_REPO`'s default as well until
// the organisation was renamed to `acme`; #1175 then took both defaults off,
// so these two lines are what lets this file boot at all — unset, Joi refuses
// the boot and names the setting.
process.env.GITHUB_ORGS = 'acme';
process.env.FEEDBACK_REPO = 'acme/board';
process.env.GITHUB_WRITE_ENABLED = 'false';
process.env.GITHUB_TOKEN = '';
// The WRITE credential too, and it is the one that matters most: since #756
// `sources/write-identity.service.ts` asks `GET /user` under it at boot, and
// `github-client.ts` reads it FIRST for purpose 'write'. GITHUB_WRITE_ENABLED
// does not gate that ask — it reports the flag, it does not obey it — so a
// developer with a machine-user token in a local .env would otherwise make a
// live call under the production write credential every time they ran this
// file. `sources/spec-boot-credentials.spec.ts` holds every spec that boots
// the real AppModule to this line.
process.env.GITHUB_WRITE_TOKEN = '';
process.env.GITHUB_APP_ID = '';
process.env.GITHUB_PRIVATE_KEY = '';
process.env.GITHUB_INSTALLATION_ID = '';
process.env.GITHUB_USER_APP_CLIENT_ID = '';
process.env.GITHUB_USER_APP_CLIENT_SECRET = '';
process.env.BOARD_CREDENTIAL_KEY = '';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '';
process.env.GOOGLE_DWD_SUBJECT = '';
process.env.DATABASE_URL = '';

// Top-level await: vitest runs this through vite-node's ESM pipeline, but
// `tsc -p tsconfig.json --noEmit` reads the package as CommonJS and
// rejects it, so the await needs a suppression. Keep the import a statement of
// its OWN — on one line the directive swallows TS2307 too, and a typo'd
// specifier then compiles clean against `any`. docs/traps.md, "A hook that
// loads the module graph is timed against the machine", has the measurements
// and the case where the directive does not self-detect. #743.
const appModulePromise = import('../app.module.js');
// @ts-expect-error TS1309 — top-level await in a CommonJS module
const appModule = await appModulePromise;
const { AppModule } = appModule;

describe('board:* scopes — end-to-end back-compat (#56)', () => {
  /** That person's OTHER address in the alias table — personal, non-corporate,
   *  and precisely what a static token must never receive (#482). */
  const PERSONAL_ADDRESS = 'octocat@example.org';
  /** The fixture's feedback submission: a Github issue in FEEDBACK_REPO whose
   *  TITLE is the first line of an end user's message (#497). */
  const SUBMISSION_TITLE = '[Bug] my weekly report never arrives and the button just spins';
  /** The same submission after ordinary triage swapped `feedback` for `bug`
   *  (#516). Its labels no longer say what it is; the footer the form wrote into
   *  its body still does. This is the row the LABEL rule alone hands over. */
  const RELABELLED_TITLE = '[Bug] the digest email arrives empty every second week';
  /** An ordinary team issue on the same fixture — the control that proves the
   *  rule costs a static token nothing it exists for. */
  const TEAM_TITLE = 'Auth: MCP token scope leak';
  /** What a static token reads in the submission's place. */
  const HIDDEN_TITLE = 'Feedback submission (hidden)';

  let app: INestApplication | undefined;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // This suite isolates scopes/freshness; assume a synthetic Github connection.
    vi.spyOn(app.get(GithubUserService), 'principal').mockImplementation(async (email: string) => ({
      key: email, email, login: null, token: 'synthetic-connected', owners: [{ login: 'acme', type: 'Organization' }], repositories: [], cache: new WeakMap(),
    }));
    // Mirrors main.ts's bootstrap exactly enough to matter: the global 'api'
    // prefix is what makes the routes below match in the first place.
    app.setGlobalPrefix('api', { exclude: ['mcp'] });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo | string | null;
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind a TCP port');
    }
    port = address.port;
  });

  afterAll(async () => {
    // Guarded, not because closing twice is a worry, but because `app` is
    // unassigned when the hook above failed at or before
    // `createNestApplication()` — an import that threw, a module that would not
    // compile. (The three failure points after it — `init`, `listen` and the
    // port check — all leave `app` assigned, and this closes it.) Unguarded,
    // that first case reports `Cannot read properties of undefined (reading
    // 'close')` as a SECOND failure, on top of the real one a reader came to
    // read (#743). The `| undefined` on the declaration is what makes tsc
    // require the guard rather than leaving it to a comment.
    await app?.close();
  });

  /** Minimal HTTP client (no supertest — this repo has it as a bare JS dep with
   *  no type declarations installed, and adding an ambient shim just to avoid
   *  Node's built-in, fully-typed `http` module isn't worth it here). */
  function call(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let json: unknown = undefined;
            try {
              json = data ? JSON.parse(data) : undefined;
            } catch {
              json = data;
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** A plain human UI session — the same HS256 shape google-auth mints after
   *  login: issuer `atlas`, an email, and no scope claim. */
  function mintHumanSession(email: string): Promise<string> {
    return new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('atlas')
      .setSubject(TEAM_MEMBER_ID)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(SESSION_SECRET));
  }

  // --- Scenario 1: the default board:read still reaches an undecorated GET
  // route, so the route answers a static token — but since #482 the roster it
  // answers with has no addresses on it, the alias table's personal,
  // non-corporate ones least of all. A static token is nobody: no person is
  // accountable for what it reads.
  it('static agent token: GET /api/people → 200 (default board:read), roster stripped of addresses', async () => {
    const res = await call('GET', '/api/people', { token: AGENT_SECRET });
    expect(res.status).toBe(200);
    const people = (res.json as { people: { displayName: string; emails: string[] }[] }).people;
    expect(people.length).toBeGreaterThan(0);
    expect(people.map((p) => p.displayName)).toContain('Octocat');
    for (const person of people) expect(person.emails).toEqual([]);
    expect(JSON.stringify(res.json)).not.toContain(PERSONAL_ADDRESS);
  });

  it('human session: GET /api/people → the roster keeps its addresses', async () => {
    const res = await call('GET', '/api/people', { token: await mintHumanSession(TEAM_MEMBER) });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).toContain(PERSONAL_ADDRESS);
  });

  // --- Scenario 2c (#497): the submission is ALSO a Github issue, and the old
  // form built its title from the first line of the message — so
  // the ordinary issue routes carried the words too. They stay open (that is
  // what an agent token is for) and lose only the submission's title.
  // /api/issues/metrics carries issue TITLES in exactly one place: the aging set
  // behind the Oldest-open block (#478). If the fixture's open issues were all
  // young, that set would be empty and the two title assertions below would pass
  // over a response with no titles in it at all — proving nothing. This pins the
  // precondition, so a future fixture edit fails here with a readable reason
  // rather than quietly hollowing out the redaction tests.
  it('the metrics fixture actually has an aging set — the only titles that route carries', async () => {
    const res = await call('GET', '/api/issues/metrics', { token: await mintHumanSession(TEAM_MEMBER) });
    const m = res.json as { stale: { title: string }[]; staleTotal: number };
    expect(m.staleTotal).toBeGreaterThan(0);
    expect(m.stale.map((s) => s.title)).toContain(TEAM_TITLE);
    expect(m.stale.map((s) => s.title)).toContain(SUBMISSION_TITLE);
    // …and the relabelled one too (#516), or every assertion about it below runs
    // over a response with no such row and proves nothing.
    expect(m.stale.map((s) => s.title)).toContain(RELABELLED_TITLE);
  });

  for (const path of ['/api/issues/search-index', '/api/issues/metrics', '/api/issues/all']) {
    it(`static agent token: GET ${path} → 200, no submission title, team titles intact`, async () => {
      const res = await call('GET', path, { token: AGENT_SECRET });
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.json);
      expect(body).not.toContain(SUBMISSION_TITLE);
      expect(body).toContain(HIDDEN_TITLE);
      expect(body).toContain(TEAM_TITLE);
    });

    it(`static agent token: GET ${path} → the RELABELLED submission is withheld too (#516)`, async () => {
      const res = await call('GET', path, { token: AGENT_SECRET });
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.json);
      expect(body).not.toContain(RELABELLED_TITLE);
      // …and the ordinary team issue on the same surface is untouched, so this is
      // the marker working rather than the repo going dark.
      expect(body).toContain(TEAM_TITLE);
    });

    it(`human session: GET ${path} → the submission's own words`, async () => {
      const res = await call('GET', path, { token: await mintHumanSession(TEAM_MEMBER) });
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.json);
      expect(body).toContain(SUBMISSION_TITLE);
      expect(body).toContain(RELABELLED_TITLE);
      expect(body).not.toContain(HIDDEN_TITLE);
    });
  }

  it('static agent token: the hidden row is still THERE — the counts a token reads do not move', async () => {
    const agent = await call('GET', '/api/issues/metrics', { token: AGENT_SECRET });
    const human = await call('GET', '/api/issues/metrics', { token: await mintHumanSession(TEAM_MEMBER) });
    const totals = (r: { json: unknown }) => (r.json as { totals: Record<string, number> }).totals;
    expect(totals(agent)).toEqual(totals(human));
  });

  // The body route. The fixture's one issue detail is an ordinary team issue in
  // `acme/acme`, so what it proves here is the SECOND half of #497: a
  // static token still reads an issue body end to end. The refusal on a
  // submission is proven against the real service in
  // issue-detail.service.spec.ts — the fixture detail source holds no submission
  // to drive over HTTP.
  it('static agent token: GET /api/issues/acme/acme/218 → 200 with the body and thread intact', async () => {
    const res = await call('GET', '/api/issues/acme/acme/218', { token: AGENT_SECRET });
    expect(res.status).toBe(200);
    const issue = res.json as { number: number; bodyMarkdown: string; comments: unknown[] };
    expect(issue.number).toBe(218);
    expect(issue.bodyMarkdown.length).toBeGreaterThan(0);
    expect(issue.comments.length).toBeGreaterThan(0);
  });

  // --- Scenario 2d (#497): the relations panel. #218 above is an ORDINARY team
  // issue, so it passes the body gate — and it names its neighbours by title.
  // We file submissions under umbrella issues as a matter of course, so a
  // static token could read an end user's first line by asking for the parent.
  // Refusing the parent would be the wrong shape: the parent is ours.
  const UMBRELLA = '/api/issues/acme/acme/218';
  const SUBMISSION_ISSUE = '/api/issues/acme/board/901';
  /** A team sub-issue on the same umbrella — the control that proves the rule
   *  costs the token nothing on the relations it exists to read. */
  const TEAM_RELATION_TITLE = 'Re-run the deploy job from the release run';

  type Relations = {
    relations: {
      parent: { title: string } | null;
      subIssues: { number: number; title: string; url: string; state: string; repo: string }[];
      blockedBy: { title: string }[];
      subIssuesTotal: number;
      subIssuesClosed: number;
    };
  };

  it('the fixture really does hang a submission off that umbrella — otherwise the two tests below prove nothing', async () => {
    const res = await call('GET', UMBRELLA, { token: await mintHumanSession(TEAM_MEMBER) });
    const { relations } = res.json as Relations;
    expect(relations.subIssues.map((r) => r.title)).toContain(SUBMISSION_TITLE);
    expect(relations.blockedBy.map((r) => r.title)).toContain(SUBMISSION_TITLE);
    expect(relations.subIssues.map((r) => r.title)).toContain(TEAM_RELATION_TITLE);
  });

  it('static agent token: the umbrella answers, and no relation hands over the submission’s words', async () => {
    const res = await call('GET', UMBRELLA, { token: AGENT_SECRET });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).not.toContain(SUBMISSION_TITLE);
    const { relations } = res.json as Relations;
    expect(relations.subIssues.map((r) => r.title)).toContain(HIDDEN_TITLE);
    expect(relations.blockedBy.map((r) => r.title)).toContain(HIDDEN_TITLE);
    expect(relations.subIssues.map((r) => r.title)).toContain(TEAM_RELATION_TITLE);
  });

  it('static agent token: the hidden relation keeps its row — number, repo, state, URL', async () => {
    const res = await call('GET', UMBRELLA, { token: AGENT_SECRET });
    const { relations } = res.json as Relations;
    const hidden = relations.subIssues.find((r) => r.title === HIDDEN_TITLE);
    expect(hidden).toMatchObject({
      number: 901,
      state: 'open',
      url: 'https://github.com/acme/board/issues/901',
    });
    // …and the counts a token reads still match a human's. (Was 6; the fixture
    // gained the relabelled twin the #516 cases below drive.)
    expect(relations.subIssuesTotal).toBe(7);
    expect(relations.subIssuesClosed).toBe(2);
  });

  it('human session: every relation title reads whole', async () => {
    const res = await call('GET', UMBRELLA, { token: await mintHumanSession(TEAM_MEMBER) });
    expect(JSON.stringify(res.json)).toContain(SUBMISSION_TITLE);
    expect(JSON.stringify(res.json)).not.toContain(HIDDEN_TITLE);
  });

  it('static agent token: GET the submission itself → 403, words and address both withheld', async () => {
    const res = await call('GET', SUBMISSION_ISSUE, { token: AGENT_SECRET });
    expect(res.status).toBe(403);
    const body = JSON.stringify(res.json);
    expect(body).not.toContain(SUBMISSION_TITLE);
    expect(body).not.toContain(PERSONAL_ADDRESS);
    expect(body).not.toContain('Submitted by');
  });

  it('human session: GET the submission itself → 200, the message and its footer intact', async () => {
    const res = await call('GET', SUBMISSION_ISSUE, { token: await mintHumanSession(TEAM_MEMBER) });
    expect(res.status).toBe(200);
    const issue = res.json as { title: string; bodyMarkdown: string };
    expect(issue.title).toBe(SUBMISSION_TITLE);
    expect(issue.bodyMarkdown).toContain(PERSONAL_ADDRESS);
  });

  // --- Scenario 2e (#516): the same doors, after ordinary triage swapped
  // `feedback` for `bug`. Nothing about the issue changed except its labels —
  // the message, the address and the footer are the same bytes — and the label
  // rule alone would have handed all of it over.
  const RELABELLED_ISSUE = '/api/issues/acme/board/902';

  it('the fixture really does hold a relabelled submission — otherwise the tests below prove nothing', async () => {
    const res = await call('GET', RELABELLED_ISSUE, { token: await mintHumanSession(TEAM_MEMBER) });
    const issue = res.json as { title: string; bodyMarkdown: string; labels: { name: string }[] };
    expect(issue.title).toBe(RELABELLED_TITLE);
    expect(issue.labels.map((l) => l.name)).not.toContain('feedback');
    expect(issue.bodyMarkdown).toContain('Submitted by');
  });

  it('static agent token: GET the relabelled submission → 403, words and address both withheld', async () => {
    const res = await call('GET', RELABELLED_ISSUE, { token: AGENT_SECRET });
    expect(res.status).toBe(403);
    const body = JSON.stringify(res.json);
    expect(body).not.toContain(RELABELLED_TITLE);
    expect(body).not.toContain(PERSONAL_ADDRESS);
    expect(body).not.toContain('Submitted by');
  });

  it('static agent token: the umbrella still answers, and the relabelled twin reads hidden among its relations', async () => {
    const res = await call('GET', UMBRELLA, { token: AGENT_SECRET });
    expect(res.status).toBe(200);
    const json = res.json as Relations & { title: string };
    // The umbrella is OURS — it is served whole.
    expect(json.title).toBe("Board deploy didn't fire on merge");
    expect(JSON.stringify(res.json)).not.toContain(RELABELLED_TITLE);
    const twin = json.relations.subIssues.find((r) => r.number === 902);
    expect(twin?.title).toBe(HIDDEN_TITLE);
    // …and the ordinary team sub-issue beside it is untouched.
    expect(json.relations.subIssues.map((r) => r.title)).toContain(TEAM_RELATION_TITLE);
  });

  it('human session: the relabelled twin reads whole among the umbrella’s relations', async () => {
    const res = await call('GET', UMBRELLA, { token: await mintHumanSession(TEAM_MEMBER) });
    const { relations } = res.json as Relations;
    expect(relations.subIssues.map((r) => r.title)).toContain(RELABELLED_TITLE);
  });

  it('static agent token: the Projects board serves the relabelled row hidden, team rows intact', async () => {
    const res = await call('GET', '/api/projects/7', { token: AGENT_SECRET });
    expect(res.status).toBe(200);
    const detail = res.json as { items: { number: number; title: string }[] };
    const row = detail.items.find((i) => i.number === 462);
    expect(row?.title).toBe(HIDDEN_TITLE);
    expect(detail.items.some((i) => i.title === 'Reconcile legacy architecture docs')).toBe(true);
  });

  it('human session: the same board row reads whole — and the fixture really carries it', async () => {
    const res = await call('GET', '/api/projects/7', { token: await mintHumanSession(TEAM_MEMBER) });
    const detail = res.json as { items: { number: number; title: string }[] };
    expect(detail.items.find((i) => i.number === 462)?.title).toBe(RELABELLED_TITLE);
  });

  /**
   * The Projects detail query reads each issue's BODY now (#516), so the thing
   * to prove is that the body stops at the source's mapper. It becomes a boolean
   * there and is dropped; the boolean itself comes off in `readableItems`. So no
   * submitter's message, no address, and not even the marker reaches a response
   * — for anyone, including the humans who may read all of it elsewhere.
   */
  for (const who of ['human', 'agent'] as const) {
    it(`${who}: no submission body rides the Projects cache onto the wire (#516)`, async () => {
      const token = who === 'agent' ? AGENT_SECRET : await mintHumanSession(TEAM_MEMBER);
      for (const path of ['/api/projects', '/api/projects/7']) {
        const res = await call('GET', path, { token });
        expect(res.status).toBe(200);
        const body = JSON.stringify(res.json);
        expect(body).not.toContain('Submitted by');
        expect(body).not.toContain(PERSONAL_ADDRESS);
        expect(body).not.toContain('the spinner runs forever');
        expect(body).not.toContain('"submission"');
      }
    });
  }

  it('static agent token: PATCH the relabelled submission’s task → refused, and no body crosses the wire', async () => {
    // Refused by `HumanOnlyGuard` first — that is the primary control and stays
    // so. The assertion is that the route is refused AND silent, which holds
    // whichever gate answers.
    const res = await call('PATCH', `${RELABELLED_ISSUE}/task`, {
      token: AGENT_SECRET,
      body: { line: 3, checked: true },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = JSON.stringify(res.json);
    expect(body).not.toContain(PERSONAL_ADDRESS);
    expect(body).not.toContain('Submitted by');
    expect(body).not.toContain(RELABELLED_TITLE);
  });

  // --- Scenario 3: the fail-closed default for an undecorated WRITE route.
  // There IS one, and it is not a spare fixture: POST /api/oauth/consent.
  // `ConsentController.decide` declares no @RequiredScopes and no @Public, so a
  // scoped actor is denied by default (#56, required-scopes.guard.ts:53-63).
  // That default is what has always stood between a scoped credential and a
  // refreshable MCP grant minted in its own name — see #545. The day somebody
  // adds @RequiredScopes(board:read) here to "make the route reachable" — the
  // exact decorator McpController had to add for its own @All handler
  // (mcp.controller.ts:30-35) — this is the test that says no.
  //
  // The agent token in this fixture IS an admin (BOARD_ADMIN_EMAILS is set to
  // its synthetic address above, and the #371 break-glass is live), so neither
  // refusal below can be the authority check answering quietly.
  it('static agent token: POST /api/oauth/consent → 403 (undecorated write, fail-closed)', async () => {
    const res = await call('POST', '/api/oauth/consent', { token: AGENT_SECRET });
    expect(res.status).toBe(403);
    // Pin WHICH refusal. Global APP_GUARDs run before controller-scoped ones, so
    // RequiredScopesGuard answers first and HumanOnlyGuard never sees this
    // request — assert the message, or the case would still pass with the
    // fail-closed default removed and only the controller guard left.
    expect(JSON.stringify(res.json)).toContain('no declared scope requirement');
  });

  it('static agent token: GET /api/oauth/consent → 403, and no consent page is rendered', async () => {
    // The GET default is board:read, which every static token carries, so this
    // route used to render a consent screen to a caller /api/auth/me reports as
    // not a person. HumanOnlyGuard on the controller is what refuses it (#545)
    // — this is the half of the gate the POST case cannot reach.
    const res = await call('GET', '/api/oauth/consent?req=nonexistent', { token: AGENT_SECRET });
    expect(res.status).toBe(403);
    // Read the RAW body, not JSON.stringify of it. `call` falls back to the raw
    // string for a non-JSON response, and stringifying escapes every quote —
    // `value=\"agent\"` — so a stringified haystack can never contain
    // `value="agent"`, and the assertion would pass against a fully rendered
    // consent page. This is the half that says no page came back.
    expect(String(res.json ?? '')).not.toContain('value="agent"');
  });

  // --- Scenario 4: the admin route explicitly requires board:admin, which the
  // static agent preset never carries ---
  it('static agent token: PUT /api/admin/identity → 403 (missing board:admin)', async () => {
    const res = await call('PUT', '/api/admin/identity', {
      token: AGENT_SECRET,
      body: { keyEmail: 'someone@example.com' },
    });
    expect(res.status).toBe(403);
  });

  // --- Scenario 5 (#471): the admin READS are scope-gated too, so being an
  // admin is no longer enough on its own. This token's ADDRESS is in the admin
  // set (asserted below) and it carries board:read — the exact actor that used
  // to read the org's whole token inventory and audit log through the
  // undecorated-GET default. The 403s below are the scope gate, pinned by their
  // message; since #551 AdminGuard would refuse this caller too, so each read is
  // now closed twice over and neither refusal depends on the other.
  it('the agent token\'s address is in the admin set, and the gate refuses it anyway (#551)', async () => {
    // `app!`, not `app?.`: a `beforeAll` that throws leaves every `it` in the
    // file unrun, so inside a test the hook has necessarily assigned it. Only
    // the teardown runs either way, which is why that one carries a real guard.
    const authority = app!.get(AdminAuthority);
    // The address question, which is what BOARD_ADMIN_EMAILS answers: the env
    // var has no format validation, so `agent:<name>` set there IS in the admin
    // set wherever the #371 break-glass is live. This is the precondition that
    // keeps the 403s below meaningful — a lookup that simply missed would
    // produce the same status.
    expect(authority.isAdmin(`agent:${AGENT_NAME}`)).toBe(true);
    // The caller question, which is what the gate now asks. #546 fixed the
    // report and left the gate asking the first question; #551 made both read
    // this one method, so the surface and the gate cannot drift apart again.
    expect(
      authority.isAdminActor({ email: `agent:${AGENT_NAME}`, agent: true, staticAgent: true }),
    ).toBe(false);
    const res = await call('GET', '/api/auth/me', { token: AGENT_SECRET });
    expect(res.status).toBe(200);
  });

  // #546, end to end through the real guard chain: the actor above has an admin
  // address, and is told it is not an admin. A static agent is not a person and
  // cannot hold a person's role, so the hint is a false claim rather than
  // authority — and since #551 the gate agrees, because it reads the same
  // decision this field is rendered from.
  it('...and /api/auth/me does not tell that same token it is an admin (#546)', async () => {
    const res = await call('GET', '/api/auth/me', { token: AGENT_SECRET });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      email: `agent:${AGENT_NAME}`,
      isAdmin: false,
      canWrite: false,
      githubLogin: null,
    });
  });

  for (const path of ['/api/admin/access', '/api/admin/agents', '/api/admin/audit']) {
    it(`admin-owned board:read token: GET ${path} → 403 (missing board:admin)`, async () => {
      const res = await call('GET', path, { token: AGENT_SECRET });
      expect(res.status).toBe(403);
      expect(String((res.json as { message?: string }).message)).toMatch(/board:admin/);
    });
  }

  // --- Legacy compatibility: a pre-#56 consent token carries only `mcp_scope`
  // (no `board_scopes` claim). Exercised through the REAL SessionService
  // instance from the booted app (real HS256 verify, real expandPreset() +
  // deriveAgentFlag() call sites) rather than a bare unit test on scopes.ts.
  //
  // This stops short of a full MCP JSON-RPC wire round-trip (initialize +
  // tools/list against /mcp): that transport is already covered end-to-end by
  // overview-tools.spec.ts (tool sets per scope) and mcp-rest-parity.spec.ts
  // (every REST write route accounted for on the MCP surface), and building a
  // from-scratch streamable-HTTP MCP client here would duplicate that coverage
  // without adding any assurance about #56 specifically. What IS new here: the
  // proof that legacy tokens (no board_scopes claim) still resolve through the
  // real verifySession() → deriveAgentFlag() path introduced by this feature.
  it('legacy compat: mcp_scope=agent/full tokens resolve to the right board scopes + agent flag', async () => {
    const google = app!.get(SessionService); // see the note on `app!` above
    const secretKey = new TextEncoder().encode(SESSION_SECRET);
    const mintLegacyToken = (scope: 'agent' | 'full') =>
      new SignJWT({ email: `legacy-${scope}@example.com`, mcp_scope: scope })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('atlas')
        .setSubject(`legacy-${scope}-sub`)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(secretKey);

    const agentSession = await google.verifySession(await mintLegacyToken('agent'));
    expect(agentSession.boardScopes).toEqual(expandPreset('agent'));
    expect(deriveAgentFlag(agentSession.boardScopes!)).toBe(true);

    const fullSession = await google.verifySession(await mintLegacyToken('full'));
    expect(fullSession.boardScopes).toEqual(expandPreset('full'));
    expect(deriveAgentFlag(fullSession.boardScopes!)).toBe(false);

    // And the surface a legacy token reaches is the real one (#536): the read
    // tool at either scope, under the board_ prefix only.
    expect(toolNamesForScope(true)).toEqual(['board_whoami']);
    expect(toolNamesForScope(false)).toEqual(['board_whoami']);
  });
});
