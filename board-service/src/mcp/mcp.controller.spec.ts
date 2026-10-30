import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import { request as httpRequest } from 'http';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { GithubLoginResolver } from '../identity/github-login.resolver';
import { BOARD_ADMIN, BOARD_READ } from '../auth/scopes';

/**
 * The controller's own contract (#536).
 *
 * `identity-tool.spec.ts` tests `whoAmI` as a pure function, and both
 * server-building specs stub deps and never invoke a handler. So the two facts
 * the CONTROLLER is responsible for — that `staticAgent` comes from
 * `isStaticAgent(req.user)` and that the reported scopes are the caller's own —
 * were asserted about the function and never about the thing that feeds it.
 * Breaking either of them left the whole suite green.
 *
 * These drive the real handler over real HTTP, so the actor is built by the code
 * under test rather than by the test. A spec that rebuilt the actor itself would
 * pass both of those mutations too.
 *
 * Node's `http` rather than supertest, matching
 * `required-scopes.integration.spec.ts`: supertest is a bare JS dep here with no
 * type declarations, and adding `@types/supertest` is a dependency decision, not
 * a test detail.
 */

/** `req.user` as the guards leave it. Swapped per test before the request. */
type TestUser = Record<string, unknown> | undefined;
let currentUser: TestUser;

/** Records every address the resolver is asked for, so "never asked" is testable. */
const asked: string[] = [];
const resolverStub: Pick<GithubLoginResolver, 'forEmail' | 'typedLoginFor'> = {
  async forEmail(email: string) {
    asked.push(email);
    return 'octocat';
  },
  // board_whoami reads this one (#535); same answer, so the existing
  // assertions below keep meaning what they meant.
  async typedLoginFor(email: string) {
    asked.push(email);
    return 'octocat';
  },
};

let app: INestApplication;
let port: number;

interface WhoAmIAnswer {
  email: string;
  githubLogin: string | null;
  scopes: string[];
}

/** One `tools/call` for board_whoami, through the real transport. */
function whoAmI(): Promise<WhoAmIAnswer> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'board_whoami', arguments: {} },
  });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const body = JSON.parse(data);
            if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
            resolve(JSON.parse(body.result.content[0].text) as WhoAmIAnswer);
          } catch (err) {
            reject(new Error(`${(err as Error).message} — raw: ${data}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({
    controllers: [McpController],
    providers: [
      { provide: ConfigService, useValue: { get: (k: string) => k === 'BOARD_MCP_ENABLED' } },
      { provide: GithubLoginResolver, useValue: resolverStub },
    ],
  }).compile();

  app = mod.createNestApplication();
  // Stands in for the global guard chain, which is not mounted here: what these
  // tests are about is what the controller does with `req.user`, not how it got
  // there. `/mcp` is excluded from the `api` prefix in main.ts, so no prefix.
  app.use((req: { user?: TestUser }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    next();
  });
  await app.init();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo | string | null;
  if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
  port = address.port;
});

afterAll(async () => {
  await app?.close();
});

describe('McpController builds the actor', () => {
  it('a static agent reaches the tool and the roster resolver is never asked', async () => {
    // `staticAgent` must come from the FLAG (isStaticAgent), never from the
    // address (#525). If the controller drops it, the tool falls through to the
    // resolver and can hand a BOARD_AGENT_TOKENS caller a real person's handle —
    // the defence identity-tool.spec.ts asserts, which the controller has to
    // actually supply for that assertion to mean anything in production.
    asked.length = 0;
    currentUser = {
      sub: 'agent-sub',
      email: 'agent:ci',
      agent: true,
      staticAgent: true,
      scopes: [BOARD_READ],
    };

    const answer = await whoAmI();

    expect(answer.email).toBe('agent:ci');
    expect(answer.githubLogin).toBeNull();
    expect(asked).toEqual([]);
  });

  it('a scoped caller reports its own scope list, not an empty one', async () => {
    asked.length = 0;
    currentUser = {
      sub: 'pat-sub',
      email: 'octocat@example.com',
      agent: false,
      scopes: [BOARD_READ, BOARD_ADMIN],
    };

    const answer = await whoAmI();

    expect(answer.scopes).toEqual([BOARD_READ, BOARD_ADMIN]);
    expect(answer.email).toBe('octocat@example.com');
    // Not a static agent, so the resolver IS asked — for the caller's own
    // address and nothing else.
    expect(asked).toEqual(['octocat@example.com']);
    expect(answer.githubLogin).toBe('octocat');
  });

  it('an unscoped cookie session reports [], which is no limits and not no authority', async () => {
    // jwt-auth.guard.ts:132 builds { sub, email } for a browser session — no
    // scopes, no agent flag. `[]` is the honest answer and the highest authority
    // on this surface. It has to be reached by the caller HAVING no scopes; a
    // controller that sent [] for everyone is caught by the test above.
    asked.length = 0;
    currentUser = { sub: 'person-sub', email: 'octocat@example.com' };

    const answer = await whoAmI();

    expect(answer.scopes).toEqual([]);
    expect(answer.githubLogin).toBe('octocat');
  });
});
