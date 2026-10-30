/**
 * Which recorded routes the phone-width guard's fixture server can actually
 * answer — the question a MISSING key already answers loudly, asked of the keys
 * that are PRESENT (#735).
 *
 * The guard's server does `res.writeHead(hit.status ?? 200)` then
 * `res.end(JSON.stringify(hit.body))`, and it collects a route in `missingApi`
 * only when `fixtures[path]` is absent. So presence of a key is not an answer: an
 * entry stored as a bare payload has `body === undefined`, `JSON.stringify`
 * answers `undefined`, and the route replies 200 with a zero-length response.
 * The page's `res.json()` throws on it, the component renders its nothing-yet
 * state, and the guard reads that as the legitimate "nothing is waiting" state
 * every empty API produces. Nothing reports it, and the check goes on measuring
 * something easier than the page people see.
 *
 * Separate from the guard for the reason `day-grid-expectation.mjs` is separate:
 * importing the guard starts a server and a browser, and this is the part a unit
 * test can reach. `daySeriesFault` asks `entryFault` the same question, so there
 * is one definition of "the fixture cannot answer this" rather than two.
 *
 * Two things are deliberately not a fault. #744 argues both at length.
 *
 * A `null` body. `JSON.stringify(null)` is the four bytes `null`, which
 * `res.json()` parses without throwing — the route answers. Whether `null` is
 * the RIGHT answer is a question about content, and `daySeriesFault` is where
 * content is asked about, for the two routes where the answer matters.
 *
 * A status Node coerces. `writeHead('200')` and `writeHead(200.9)` both send a
 * 200, so flagging them would have this module claim a route is unanswerable
 * while the server answers it. That boundary is Node's rather than ours, so
 * `fixture-answers.spec.mjs` asserts this rule against a real `res.writeHead`
 * instead of trusting the sentence above.
 *
 * Which statuses ARE a fault turns on whose question this is, and the answer is
 * the page's rather than the server's.
 *
 * This module used to ask only whether the SERVER could put an answer on the
 * wire, and on that reading a 1xx was excluded — `writeHead` accepts it, so the
 * server had done its part and what a client made of it was somebody else's
 * question. That line does not survive being measured. The question worth asking
 * is the page's: can `res.json()` read the recorded payload back? Three classes
 * of status say no, each for its own reason, and all three are asserted in the
 * spec against a real server and a real `fetch` rather than against this text:
 *
 *   - A status `res.writeHead` REFUSES throws `ERR_HTTP_INVALID_STATUS_CODE`
 *     inside the request handler, so the socket dies with no reply at all — the
 *     page sees a network failure rather than an error status it could render.
 *   - 204, 205 and 304 carry NO PAYLOAD, however full `body` is. Node itself
 *     drops it at 204 and 304; at 205 Node really does put the bytes on the wire
 *     and the FETCH SPEC drops them, because 101, 103, 204, 205 and 304 are its
 *     null-body statuses. Two different mechanisms, one outcome on the page: a
 *     zero-length response and a `res.json()` that throws. A rule written against
 *     the server alone would call 205 answerable and the page would still see
 *     nothing — which is the #735 failure exactly.
 *   - A 1xx is an interim reply and never completes. The page's fetch does not
 *     resolve at all, so the block sits in its nothing-yet state until the
 *     guard's own 30-second poll gives up.
 *
 * A bodyless status is reported BY THE STATUS, whatever `body` holds — a full
 * payload, `null`, or no `body` key at all. The three read identically on the
 * wire, and no edit to `body` can fix any of them, so pointing a reader at the
 * body would be the wrong signpost. That is why the status rule is checked
 * BEFORE the body-shape rule below, and it is the one place the two orders give
 * different messages for the same entry.
 */

/** The lowest and highest codes `res.writeHead` accepts. Outside them it throws
 *  and the request is never answered. Asserted against a real `res.writeHead` in
 *  the spec, not read off the documentation. */
const STATUS_MIN = 100;
const STATUS_MAX = 999;

/** The statuses that reach the page carrying nothing, whatever `res.end` was
 *  given. 204 and 304 are stripped by Node; 205 is sent by Node and discarded by
 *  the client. Measured over a real request in the spec, not read off the RFC. */
const BODYLESS = new Set([204, 205, 304]);
/** The top of the interim range: a reply below this never completes, so the
 *  page's fetch never resolves. `writeHead` accepts every one of them. */
const INTERIM_MAX = 199;

const FIXTURE_NAME = 'scripts/fixtures/team-api.json';

/** The shape every entry has to be in for the server to answer from it. Quoted
 *  in failure messages so the fix is in the message rather than in a doc. */
export const ENTRY_SHAPE = '{"status": 200, "body": <the payload>}';

/**
 * Why the fixture server cannot answer from one entry, or `null` when it can.
 *
 * Takes the raw value at a route key, including `undefined` for a route the
 * fixture has no key for at all — `daySeriesFault` calls it that way.
 */
export function entryFault(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `is stored as ${describeValue(entry)}, not a ${ENTRY_SHAPE} entry`;
  }
  // BEFORE the body-shape rule, because a status that carries no payload cannot
  // be fixed by editing `body` — see the docblock.
  const statusReason = statusFault(entry.status);
  if (statusReason) return statusReason;
  if (!('body' in entry) || entry.body === undefined) {
    return (
      'has no `body`, so the server answers 200 with an empty response and the ' +
      `page's \`res.json()\` throws — store the payload under \`body\`, as ${ENTRY_SHAPE}`
    );
  }
  return null;
}

/** Why the page cannot read a payload back from an entry carrying this status,
 *  or `null` when it can. An absent status is the server's documented 200. */
function statusFault(status) {
  if (status == null) return null;
  const code = Math.trunc(Number(status));
  if (!Number.isFinite(code) || code < STATUS_MIN || code > STATUS_MAX) {
    return (
      `has a \`status\` of ${JSON.stringify(status)}, which \`res.writeHead\` refuses — ` +
      `the request dies unanswered. Use a number between ${STATUS_MIN} and ${STATUS_MAX}, or ` +
      'drop the key and take the 200 the server defaults to'
    );
  }
  if (code <= INTERIM_MAX) {
    return (
      `has a \`status\` of ${code}, an interim reply that never completes — the page's fetch ` +
      'never resolves and the block sits in its nothing-yet state until this guard gives up. ' +
      'Use 200, or drop the key and take the 200 the server defaults to'
    );
  }
  if (BODYLESS.has(code)) {
    return (
      `has a \`status\` of ${code}, which reaches the page carrying no payload whatever \`body\` ` +
      "holds, so the page's `res.json()` throws and the block renders the same nothing-yet state " +
      'a genuinely empty API gives. Use 200, or drop the key and take the 200 the server ' +
      'defaults to'
    );
  }
  return null;
}

/** What a value is, in the words a failure message wants. */
function describeValue(value) {
  if (value === undefined) return 'nothing at all';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Every route in a parsed fixture the server cannot answer, in the order the
 * fixture holds them, as `{ route, reason }`.
 *
 * Collected rather than thrown at the first one, so one run reports all of them —
 * the same reason the guard's own `missingApi` is a Set and not a throw.
 */
export function unservableEntries(fixtures) {
  const found = [];
  for (const [route, entry] of Object.entries(fixtures ?? {})) {
    const reason = entryFault(entry);
    if (reason) found.push({ route, reason });
  }
  return found;
}

/**
 * Whether the recorded fixture can answer every route it names, answered BEFORE
 * Chrome is started.
 *
 * Returns `null` when there is nothing wrong, or `{ message, detail }` for the
 * guard's `exitNow`.
 */
export function fixtureAnswerFault(fixtures) {
  const found = unservableEntries(fixtures);
  if (found.length === 0) return null;

  return {
    message:
      `${FIXTURE_NAME} holds ${found.length} ` +
      `${found.length === 1 ? 'entry' : 'entries'} the fixture server cannot answer.`,
    detail:
      `${found.map(({ route, reason }) => `  ${route} — ${reason}`).join('\n')}\n\n` +
      `Every entry has to be ${ENTRY_SHAPE}. A route stored as its bare payload still has a key, ` +
      'so the server never records it in `missingApi` and never sends the 501 that would fail this ' +
      'run: it answers 200 with a zero-length body, the page\'s `res.json()` throws, and the block ' +
      'renders the same nothing-yet state a genuinely empty API gives. That is indistinguishable ' +
      'from a legitimate empty state on the page, which is why it is caught here by shape instead.\n' +
      `Re-record ${FIXTURE_NAME} against a fixture-mode board-service rather than hand-wrapping ` +
      'the entry.',
  };
}
