import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyBodyParsers } from '../config/body-limits';
import { ISSUE_STORE, type IssueStore } from './issue-store';
import { WEBHOOK_BODY_LIMIT, WEBHOOK_PATH } from './webhook-body';
import { WEBHOOK_DEADLINE, WEBHOOK_DEADLINE_MS } from './webhook-deadline';
import { GithubWebhookController } from './webhook.controller';

/**
 * The webhook receiver over a real socket (#1007, V5), through the same
 * `applyBodyParsers` and global prefix `main.ts` sets up, with the store
 * replaced by a spy. What is under test is the order things happen in:
 * everything that can be refused without the body is refused before it is
 * read, the signature is checked before anything parses the body, and only a
 * verified delivery reaches the store.
 *
 * The guards are not here. The route is `@Public()` and `@Writes()`, and
 * `webhook.integration.db-spec.ts` sends a delivery through the real AppModule,
 * every guard included.
 */

const SECRET = 'a-webhook-secret-of-some-length';
const sign = (body: Buffer | string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

interface Answer { status: number; body: string }

/** One request. `end: false` leaves the body open, which is how a refusal is
 *  shown to come before the body: the answer arrives while it is still owed. */
function send(port: number, headers: Record<string, string>, body: Buffer | string, end = true): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: WEBHOOK_PATH, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: text });
        req.destroy();
      });
    });
    req.on('error', reject);
    req.write(body);
    if (end) req.end();
  });
}

function headersFor(body: Buffer | string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-github-event': 'issues',
    'x-github-delivery': 'a1b2c3d4-0000-4000-8000-000000000001',
    'x-hub-signature-256': sign(body),
    ...extra,
  };
}

async function boot(
  store: IssueStore,
  webhook: boolean,
  deadlineMs: number = WEBHOOK_DEADLINE_MS,
): Promise<{ app: NestExpressApplication; port: number }> {
  @Module({
    controllers: [GithubWebhookController],
    providers: [
      { provide: ConfigService, useValue: { get: (k: string, d?: unknown) => (k === 'GITHUB_WEBHOOK_SECRET' && webhook ? SECRET : d) } },
      { provide: ISSUE_STORE, useValue: store },
      { provide: WEBHOOK_DEADLINE, useValue: deadlineMs },
    ],
  })
  class ReceiverModule {}
  const app = await NestFactory.create<NestExpressApplication>(ReceiverModule, { rawBody: true, logger: false });
  app.setGlobalPrefix('api');
  applyBodyParsers(app, { webhook });
  await app.listen(0, '127.0.0.1');
  return { app, port: (app.getHttpServer().address() as AddressInfo).port };
}

describe('the webhook receiver, over a socket (#1007, V5)', () => {
  const receive = vi.fn<IssueStore['receive']>();
  const store: IssueStore = { receive, read: vi.fn(), baseline: vi.fn() };
  let app: NestExpressApplication;
  let port: number;

  beforeAll(async () => {
    ({ app, port } = await boot(store, true));
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    receive.mockReset();
  });

  it('records a delivery Github signed, with the body parsed only after the check, and returns its store outcome', async () => {
    receive.mockResolvedValue('applied');
    const body = JSON.stringify({ action: 'opened', issue: { number: 7 } });
    const answer = await send(port, headersFor(body), body);
    expect(answer).toEqual({ status: 200, body: JSON.stringify({ status: 'applied' }) });
    expect(receive).toHaveBeenCalledWith({
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      event: 'issues',
      payload: { action: 'opened', issue: { number: 7 } },
    });
  });

  it('answers a duplicate 200', async () => {
    receive.mockResolvedValue('duplicate');
    const body = '{"action":"opened"}';
    expect(await send(port, headersFor(body), body)).toEqual({ status: 200, body: JSON.stringify({ status: 'duplicate' }) });
  });

  it('refuses a wrong signature 401 before anything parses the body, even a body that is not JSON', async () => {
    const body = 'this is { not json';
    const answer = await send(port, headersFor(body, { 'x-hub-signature-256': sign(body, 'some-other-secret-of-length') }), body);
    expect(answer.status).toBe(401);
    expect(receive).not.toHaveBeenCalled();
  });

  it('parses only after the signature holds: a signed body that is not JSON is 400, not 401', async () => {
    const body = 'this is { not json';
    expect((await send(port, headersFor(body), body)).status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
  });

  it('refuses a delivery with no signature header while its body is still arriving', async () => {
    const headers = headersFor('x');
    delete headers['x-hub-signature-256'];
    const answer = await send(port, { ...headers, 'content-length': '100' }, 'only ten b', false);
    expect(answer.status).toBe(401);
    expect(receive).not.toHaveBeenCalled();
  });

  it('refuses a malformed signature header or a missing delivery id without reading the body', async () => {
    const malformed = await send(port, { ...headersFor('x'), 'x-hub-signature-256': 'sha1=abc', 'content-length': '100' }, 'x', false);
    expect(malformed.status).toBe(401);
    const noId = headersFor('x');
    delete noId['x-github-delivery'];
    expect((await send(port, { ...noId, 'content-length': '100' }, 'x', false)).status).toBe(400);
  });

  it('refuses a declared length over the limit 413 before reading a byte of it', async () => {
    const answer = await send(port, { ...headersFor('x'), 'content-length': String(WEBHOOK_BODY_LIMIT + 1) }, 'x', false);
    expect(answer.status).toBe(413);
  });

  it('cuts a body that runs past the limit without declaring its length, at the limit and before it ends', async () => {
    const body = Buffer.alloc(WEBHOOK_BODY_LIMIT + 64 * 1024, 0x20);
    const answer = await send(port, { ...headersFor(body), 'transfer-encoding': 'chunked' }, body, false);
    expect(answer.status).toBe(413);
    expect(receive).not.toHaveBeenCalled();
  });

  it('answers 503 when the store cannot record the delivery, so Github logs it as failed', async () => {
    receive.mockRejectedValue(new Error('connection refused'));
    const body = '{"action":"opened"}';
    expect((await send(port, headersFor(body), body)).status).toBe(503);
  });
});

/**
 * The bound on how long a delivery may be held (#1070, B1).
 *
 * A store that refuses answers at once and always did. A store that TOOK the
 * connection and then stopped answering is the one that went wrong: Prisma
 * checks its transaction `timeout` between statements and never during one, so
 * nothing under the controller bounded it. The measured cost was one delivery
 * held 40 seconds under a client deadline and about 300 without one, with
 * Github's own limit at 10 and no redelivery after it.
 *
 * The store here is the worst case in one line: `receive` returns a promise
 * that never settles. The deadline is driven down to 300 ms so this is a fast
 * test; the production value is pinned separately below, against the transaction
 * budget it has to sit above and Github's timeout it has to sit under.
 */
describe('a webhook delivery the store never answers (#1070, B1)', () => {
  it('is answered 503 inside the deadline, rather than held until Github gives up', async () => {
    const receive = vi.fn<IssueStore['receive']>().mockReturnValue(new Promise(() => {}));
    const { app, port } = await boot({ receive, read: vi.fn(), baseline: vi.fn() }, true, 300);
    try {
      const body = '{"action":"opened"}';
      const began = Date.now();
      const answer = await send(port, headersFor(body), body);
      const took = Date.now() - began;
      expect(receive).toHaveBeenCalledTimes(1);
      expect(answer.status).toBe(503);
      expect(took).toBeLessThan(3_000);
    } finally {
      await app.close();
    }
  });

  it('holds the production deadline inside Github\'s 10 seconds and above the transaction budget', () => {
    // The 5 seconds a delivery's transaction may run, from `RECEIVE_TX_OPTIONS`
    // in `issue-store.ts`: the deadline sits above the transaction's own budget
    // and inside Github's 10 seconds. The delivery waits for its slot before
    // the transaction, holding no connection, and the deadline bounds that wait.
    expect(WEBHOOK_DEADLINE_MS).toBeGreaterThan(2_000 + 5_000);
    expect(WEBHOOK_DEADLINE_MS).toBeLessThan(10_000);
  });
});

describe('the webhook receiver while it is off (#1007, V5)', () => {
  it('answers 404 without reading the body, whatever the delivery carries', async () => {
    const receive = vi.fn<IssueStore['receive']>();
    const { app, port } = await boot({ receive, read: vi.fn(), baseline: vi.fn() }, false);
    try {
      const answer = await send(port, { ...headersFor('x'), 'content-length': '100' }, 'x', false);
      expect(answer.status).toBe(404);
      expect(receive).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
