import type { IncomingMessage, ServerResponse } from 'node:http';
import { SIGNATURE_HEADER } from './webhook-signature';

/** Where Github delivers the App's webhooks. Public: Github holds no session.
 *  It is `@Controller('github/webhook')` under the global `api` prefix, spelled
 *  out there because `writes-declared.spec.ts` reads routes from the source.
 *  `webhook-receiver.spec.ts` posts here through that controller, so the two
 *  cannot part without it failing. */
export const WEBHOOK_PATH = '/api/github/webhook';

/**
 * The largest delivery the receiver reads. An `issues` delivery carries one
 * issue, its repository and its sender, and the issue body is the only part
 * that grows: Github caps it at 65,536 characters, which JSON escaping can take
 * to about 390 kB (`config/body-limits.ts` has that arithmetic). 1 MiB clears it
 * with room. Github caps a payload at 25 MB, and a delivery that large carries
 * nothing this board reads, so it is refused.
 */
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;

type Req = IncomingMessage & { body?: unknown; _body?: boolean };

/**
 * Reads a webhook delivery's body as raw bytes, bounded, before any JSON parser
 * can see it (#1007, V5).
 *
 * Mounted ahead of the JSON parser, which then finds the stream finished and
 * leaves `req.body` alone, so the controller receives a `Buffer` and verifies the
 * signature over exactly the bytes Github signed. Everything that can be refused
 * without the body is refused here first, before a byte is buffered: the
 * endpoint switched off, a signature header that is missing or the wrong shape,
 * a missing delivery id or event name, or a declared length over the limit. So a
 * delivery nobody could verify costs a header check. A body that turns out
 * longer than it declared is refused at the limit, and the buffer is dropped.
 *
 * The HMAC itself is checked in the controller, against the bytes this left in
 * `req.body`.
 */
export function webhookBody(enabled: boolean) {
  return (req: Req, res: ServerResponse, next: (err?: unknown) => void): void => {
    if (req.method !== 'POST') return next();
    if (!enabled) return refuse(req, res, 404, 'Not Found');
    if (!SIGNATURE_HEADER.test(headerOf(req, 'x-hub-signature-256') ?? '')) {
      return refuse(req, res, 401, 'Missing or malformed X-Hub-Signature-256');
    }
    const id = headerOf(req, 'x-github-delivery');
    const event = headerOf(req, 'x-github-event');
    if (!id || id.length > 100 || !event || event.length > 100) {
      return refuse(req, res, 400, 'Missing X-GitHub-Delivery or X-GitHub-Event');
    }
    if (Number(req.headers['content-length']) > WEBHOOK_BODY_LIMIT) {
      return refuse(req, res, 413, `Delivery over ${WEBHOOK_BODY_LIMIT} bytes`);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > WEBHOOK_BODY_LIMIT) {
        settled = true;
        chunks.length = 0;
        refuse(req, res, 413, `Delivery over ${WEBHOOK_BODY_LIMIT} bytes`);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      req.body = Buffer.concat(chunks);
      req._body = true;
      next();
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      next(err);
    });
  };
}

function headerOf(req: Req, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Answer now, and never buffer what is still arriving. Node would otherwise
 * read the rest of the body to keep the connection, so the rest is discarded as
 * it comes, and the connection is cut once that passes the limit. It is not
 * cut at once: closing a socket with unread bytes in it sends a reset, which can
 * lose the answer on its way to a legitimate sender.
 */
function refuse(req: Req, res: ServerResponse, status: number, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
    res.end(JSON.stringify({ statusCode: status, message }));
  }
  let discarded = 0;
  req.on('data', (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > WEBHOOK_BODY_LIMIT) req.destroy();
  });
  req.resume();
}
