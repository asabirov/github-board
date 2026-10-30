import type { NestExpressApplication } from '@nestjs/platform-express';
import { WEBHOOK_PATH, webhookBody } from '../github-store/webhook-body';

/**
 * How large a JSON request body the service accepts (#693).
 *
 * SIZED FROM `COMMENT_BODY_MAX`, which is the largest thing any route here
 * takes. That cap counts CHARACTERS — UTF-16 code units — while this one counts
 * BYTES, and the two are not the same number: JSON escapes a control character
 * to six bytes, so 65,536 counted characters can cost 393,000 bytes on the
 * wire. Six bytes per counted character is the ceiling, because nothing costs
 * more: a CJK character is three bytes and JSON leaves it alone, an astral
 * character is four bytes across two counted units, and `"` and `\` are two.
 * 512 kB clears 393,000 with room for the envelope and for a cap that grows.
 *
 * Left at body-parser's 100 kB default until #693, which is below the cap the
 * comment route advertises: a 51,200-character Russian comment cost 102,419
 * bytes and was refused 413 by the transport before the route that would have
 * accepted it ever ran, while the route's own 400 went on promising the author
 * 65,505 characters. `body-limits.integration.spec.ts` sends the worst case of
 * each shape and reads the status off a real socket.
 */
export const JSON_BODY_LIMIT = '512kb';

/**
 * The request body parsers, as production registers them.
 *
 * Here rather than inline in `main.ts` for one reason: the number above is a
 * contract with the routes over it, and `main.ts` runs `bootstrap()` at import
 * time, so nothing can read it without starting a server. The spec beside this
 * file drives real HTTP through exactly this function.
 */
export function applyBodyParsers(app: NestExpressApplication, options: { webhook?: boolean } = {}): void {
  // Ahead of the JSON parser, so a Github webhook delivery reaches its route as
  // the bytes Github signed and no parser runs over one before it is verified
  // (#1007, V5). `webhook` says whether the receiver is on at all; off, the path
  // answers 404 without reading a byte.
  app.use(WEBHOOK_PATH, webhookBody(options.webhook ?? false));
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useBodyParser('urlencoded', { extended: false }); // consent form posts
}
