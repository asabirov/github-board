import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { request as httpRequest } from 'http';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Body, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyBodyParsers } from './body-limits';
import { COMMENT_BODY_MAX } from '../issue-detail/issue-detail.types';
import { maxAuthorBody } from '../issue-detail/comment-footer';

/**
 * The cap the comment route advertises has to be a cap that can physically be
 * sent (#693).
 *
 * `COMMENT_BODY_MAX` counts CHARACTERS, and the 400 the route answers quotes
 * that number back to the author. The body arrives as JSON over Express, whose
 * parser counts BYTES and defaults to 100 kB — so before this spec a 51,200
 * character Russian comment was refused by the transport, 413, before the route
 * it was well within the limit of ever ran. The browser has no entry for 413
 * either, so the author read it as a generic failure and retried the same paste.
 *
 * Driven over real HTTP through the same `applyBodyParsers` that `main.ts`
 * calls, because the number under test belongs to the parser and to no route.
 */
describe('a comment the route says it will take can be sent (#693)', () => {
  let app: NestExpressApplication;
  let port: number;

  @Controller('echo')
  class EchoController {
    @Post()
    take(@Body() body: { bodyMarkdown?: string }): { characters: number } {
      return { characters: body.bodyMarkdown?.length ?? 0 };
    }
  }

  @Module({ controllers: [EchoController] })
  class EchoModule {}

  beforeAll(async () => {
    // `NestFactory.create` with `rawBody`, then the parsers, then listen — the
    // three lines of `main.ts` in that order, and the order is the thing. Nest
    // registers its OWN 100 kB json parser during `init()` and skips doing so
    // only when a parser of that name is already on the stack, so a call made
    // after the app is listening would be a second parser behind the default and
    // change nothing. A testing module would not have caught that.
    app = await NestFactory.create<NestExpressApplication>(EchoModule, {
      rawBody: true,
      logger: false,
    });
    applyBodyParsers(app);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo | string | null;
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
    port = address.port;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Minimal HTTP client, matching `auth/required-scopes.integration.spec.ts`:
   *  supertest is an untyped bare dep here and installing types for it would be
   *  a dependency decision rather than a test. */
  function post(payload: string): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/echo',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let json: unknown;
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
      req.write(payload);
      req.end();
    });
  }

  /** The longest body the comment route's own 400 promises an author. */
  const AUTHOR = maxAuthorBody('octocat@example.com');

  /** A body of exactly that many CHARACTERS, built from the given unit. */
  const sendFilledWith = (unit: string) =>
    post(JSON.stringify({ bodyMarkdown: unit.repeat(Math.ceil(AUTHOR / unit.length)).slice(0, AUTHOR) }));

  /** One control character: one UTF-16 code unit, six bytes once JSON escapes
   *  it. Written this way rather than as a literal so the source stays legible. */
  const ESCAPED = String.fromCharCode(1);

  it('takes the longest Cyrillic comment the route would admit', async () => {
    // Two bytes a character in UTF-8, which is where the measured 413 came from:
    // 51,200 characters of Russian is 102,419 bytes against a 102,400 default.
    const res = await sendFilledWith('это большой ');
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ characters: AUTHOR });
  });

  it('takes the longest CJK comment the route would admit', async () => {
    // Three bytes a character — the worst case for anything JSON leaves alone.
    const res = await sendFilledWith('这是一条很长的评论');
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ characters: AUTHOR });
  });

  it('takes one made entirely of characters JSON has to escape', async () => {
    // The true worst case, and the one the limit is sized on. No body the
    // advertised cap admits can cost more bytes than this one.
    const res = await sendFilledWith(ESCAPED);
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ characters: AUTHOR });
  });

  it('is the configuration production actually boots with', () => {
    // Everything above drives `applyBodyParsers` directly, which proves the
    // function and not the wiring: deleting the call from `main.ts` would leave
    // every assertion above green and the running service back on 100 kB.
    // `main.ts` calls `bootstrap()` at import time and so cannot be imported,
    // and its source is the only other place the answer lives.
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    // Open-ended, because #1007's webhook receiver passes an options object.
    expect(main).toContain('applyBodyParsers(app');
    expect(main).not.toContain('useBodyParser'); // no second, unmeasured parser config
  });

  it('sizes the limit against that worst case rather than asserting it', () => {
    // The arithmetic the limit is chosen from, run rather than written into a
    // comment: six bytes per counted character, plus the envelope, under 512 kB.
    const worst = Buffer.byteLength(JSON.stringify({ bodyMarkdown: ESCAPED.repeat(COMMENT_BODY_MAX) }));
    expect(worst / COMMENT_BODY_MAX).toBeGreaterThan(5.9);
    expect(worst).toBeLessThan(512 * 1024);
  });
});
