import { expandPreset, grantablePresets, type Preset } from '../auth/scopes';

/**
 * Server-rendered consent page for the MCP OAuth flow, and the pages a flow that
 * grants nothing ends on. Values are normalised then HTML-escaped; the forms
 * POST back to the same path with the chosen scope.
 *
 * The layout follows Github's "Authorize <app>" screen, which solves the same
 * problem for the same audience: a third party nobody has vouched for, asking a
 * developer for scoped access to their account. From it, in order:
 *
 *   - the client's own name is the page heading, above the card, at heading size
 *     but book weight — big enough to read before deciding, not bold enough to
 *     carry the board's authority;
 *   - one line of board-authored fact under it, in the negative, saying what the
 *     board does not vouch for (Github: "Not owned or operated by GitHub");
 *   - the card states who the grant acts as and what was asked for;
 *   - the destination sits under the decision as centred text, never a link.
 *
 * What Github shows that the board does not: an owner, an avatar, a creation
 * date, a user count, a "Learn more" link. The board knows none of those about a
 * dynamically registered MCP client, so it claims none of them.
 *
 * The buttons are DERIVED from `grantablePresets(canGrantAdmin)` (#545), never
 * listed here. The page can only offer what the person's own authority may
 * hold, and it learns that from the same functions `consent.controller.ts` caps
 * the POST with — so the screen and the grant cannot drift apart, and adding a
 * preset to `PRESET_SCOPES` moves both. The first entry is the primary button;
 * with today's ordering that is `agent`, the least privilege, which is where the
 * emphasis belongs. Anything further the authority may grant is a quieter
 * full-width row above the decision.
 *
 * The form is still not a gate: `decide` caps whatever comes back, so a forged
 * `scope=full` field from a non-admin yields the read-only grant anyway.
 */
const PRESET_LABEL: Record<Preset, string> = {
  agent: 'Read the board',
  full: 'Read and change the board',
};

/**
 * Github's octicon-circle-slash, the mark it puts on "Not owned or operated by
 * GitHub". A negation, not a shield and not a lock: the board is not warning
 * about danger it has detected, it is stating the limit of what it knows.
 */
const SLASH =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM3.965 13.096a6.5 6.5 0 0 0 9.131-9.131Z' +
  'M1.5 8a6.474 6.474 0 0 0 1.404 4.035l9.131-9.131A6.499 6.499 0 0 0 1.5 8Z"/></svg>';

/**
 * The refusal's label and its wire value. The label is the person's word; the
 * value is the protocol's, and the two are deliberately different — a form field
 * that reads like copy invites somebody to "improve" it and change the wire.
 */
const REFUSE_LABEL = 'Cancel';
const REFUSE_VALUE = 'deny';

const CAP_NOTE =
  'You are not a board admin, so read-only is all this can grant. ' +
  'An admin can change that in Admin › Access.';

/**
 * How much of a client's name survives, and what marks the cut.
 *
 * Supplied by the caller rather than fixed here because the cap's size and the
 * marker's appearance are visual decisions (V1b) that the design pass owns.
 * There is deliberately no default: a call site cannot render a capped name
 * without having answered the question.
 */
export interface NameCap {
  /** Total length of the returned string, marker included. */
  cap: number;
  /** Visible mark that the name was cut. */
  marker: string;
}

/**
 * Display normalisation for every string a stranger supplied — the client's
 * name and the destination the code will be sent to.
 *
 * What it removes, and why each one:
 *  - Unicode format characters — the class, `\p{Cf}` — are deleted outright
 *    rather than spaced, because they sit INSIDE words and spacing them would
 *    visibly split a name that is legitimately one word. Zero-width characters,
 *    the bidi embeddings and overrides, and the directional isolates are all
 *    members of it. U+202E reverses everything after it, which is the classic
 *    display attack, and it reverses a rendered domain just as happily as a
 *    name; `<bdi>` and `unicode-bidi:isolate` contain such a character's effect
 *    on a page but do not remove it from the string, and these strings also go
 *    into logs — so it is stripped, not merely isolated.
 *
 *    Three hand-written ranges stood here instead of the class, and each one
 *    was an attempt at it that fell short. U+061C, an Arabic letter mark, is a
 *    bidi control the bidi range missed. U+00AD, the soft hyphen, is a format
 *    character that renders as nothing at all — `Cla`+U+00AD+`ude Code` is
 *    pixel-identical to `Claude Code`. So are U+2060 and the tag characters at
 *    U+E0000. A range list can be narrowed by omission and nothing notices; the
 *    class cannot, and the suite carries a row per character above so it cannot
 *    be narrowed on purpose either.
 *  - C0 controls and U+007F become a space. A newline in a name is a line break
 *    on the page and a forged second line in a log. They are a separate step
 *    because they become a space rather than vanishing.
 *  - Whitespace runs collapse and the ends are trimmed, so padding cannot push
 *    the rest of the page around.
 *
 * `String(raw)` first, for the same reason `esc` does it: express hands a
 * repeated query parameter over as an array, and `.replace` throws on one.
 */
function normalise(raw: string): string {
  return String(raw)
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What the rendered page holds every string a stranger supplied to — the
 * client's name, the destination, and each requested scope. One bound and one
 * marker for all three, because the argument for capping is the same argument
 * three times: an unbounded string a stranger chose is a way to push the
 * decision below the fold and make the rest of the page somebody else's.
 *
 * The cap sits above 200 characters on purpose. The approved design renders a
 * 200-character name WHOLE, and #545's own containment row asserts exactly that,
 * so the cap is not the containment mechanism — `overflow-wrap:anywhere` on the
 * heading is. The cap is the outer bound that stops an unbounded string being
 * the entire page, pushing the decision and the destination below the fold. 256
 * is the first round number above the rendered-whole case, and the longest real
 * client name in the board's own recipes is fourteen characters, so the
 * legitimate case never reaches it. The marker is an ellipsis rather than a
 * glyph, because the only thing the cut has to say is that there was more.
 */
export const RENDERED_CAP: NameCap = { cap: 256, marker: '\u2026' };

/**
 * How many requested scopes the page will show.
 *
 * The list is one chip per entry, the entries come off the client's own
 * `scope=` query parameter, and registration is open \u2014 so it was as long as
 * anybody wanted it to be. Two thousand scopes rendered two thousand chips and
 * a 151KB page with the decision far below them. The board's whole scope
 * vocabulary is two entries, so sixteen is far above any request a real client
 * can make and still nowhere near a page a person has to scroll past. Beyond it
 * the list is cut and the cut is marked with `RENDERED_CAP.marker`, the same
 * mark a cut name carries.
 */
export const SCOPE_CHIP_LIMIT = 16;

/**
 * Normalise a string a stranger supplied and hold it to a length. Every such
 * string on this page goes through here — the name, the destination, and each
 * requested scope — so there is one rule and not three.
 *
 * Escaping is NOT part of it: `esc()` runs after, at the point of
 * interpolation, and that order is load-bearing. Escape first and a cut through
 * `&amp;` emits `&am`, a broken entity built out of a stranger's text.
 */
function displayed(raw: string, { cap, marker }: NameCap): string {
  const collapsed = normalise(raw);
  if (collapsed.length <= cap) return collapsed;
  // Cut the RAW string and mark the cut. `cap` counts the marker, so the
  // result is never wider than the caller budgeted for.
  return marker.length >= cap
    ? collapsed.slice(0, cap)
    : collapsed.slice(0, cap - marker.length) + marker;
}

/**
 * Make a client's self-chosen name safe to put on a page, in a `<title>`, or in
 * a screenshot.
 *
 * What it deliberately does NOT do: defeat impersonation. `Cl` + Cyrillic а +
 * `ude Desktop` is composed entirely of legitimate characters and comes back
 * untouched, and so does a merely plausible name like `Board CLI`. This
 * function stops layout and injection attacks. That is the whole claim, and the
 * suite pins the ceiling so nobody widens it silently (Decision 1).
 */
export function sanitiseClientName(raw: string, cap: NameCap): string {
  return displayed(raw, cap);
}

/**
 * What the board is willing to say about where a code sent to this destination
 * would end up.
 *
 * Three states rather than a boolean, because "not local" and "the board will
 * not claim" are different answers and only one of them may be printed as a
 * fact. The caller composes it from the two classifications it already holds —
 * whether the host is loopback, and whether the scheme is one whose host means
 * what the loopback test assumes — so this file never re-derives either.
 *
 *  - `local`    — a loopback host on an http(s) scheme: the ordinary local MCP
 *                 client, and the code does not leave the machine.
 *  - `remote`   — an http(s) scheme pointing somewhere else.
 *  - `unstated` — anything else, and the board says nothing about location.
 *                 `cursor://anysphere.cursor-retrieval/cb` is the case that
 *                 forces this state to exist: the loopback test works by HOST
 *                 and reads it as remote, but the thing it reaches is a program
 *                 on this machine, so "not on this computer" would be the board
 *                 inventing a fact.
 */
export type DestinationReach = 'local' | 'remote' | 'unstated';

/**
 * Split a destination into the part that decides where the code goes and the
 * parts that do not.
 *
 * Cut by POSITION in the string the page is about to render, never by looking
 * up `new URL(...).hostname` and searching for it. `https://evil.example@evil.example/cb`
 * contains the host twice and `indexOf` would emphasise the userinfo copy — the
 * exact deception this is here to defeat. Walking the string means the returned
 * three pieces always concatenate back to the original, character for
 * character, so the page still shows the whole address and nothing else.
 *
 * The port is deliberately on the quiet side of the cut. Under RFC 8252 §7.3 a
 * loopback client takes whatever port it can get, so the port is the part of a
 * legitimate address that changes every run — and it decides nothing.
 *
 * Returns null for anything with no `://` authority at all, which includes a
 * custom scheme written without one (`cursor:cb`). Those have no host to
 * promote, so the page shows the address whole and emphasises none of it.
 */
export function splitDestination(
  address: string,
): { pre: string; host: string; post: string } | null {
  const scheme = address.indexOf('://');
  if (scheme < 0) return null;
  const authStart = scheme + 3;
  let authEnd = address.length;
  for (let i = authStart; i < address.length; i++) {
    const c = address[i];
    if (c === '/' || c === '?' || c === '#') {
      authEnd = i;
      break;
    }
  }
  const authority = address.slice(authStart, authEnd);
  // LAST '@', not the first: userinfo may itself contain one.
  const at = authority.lastIndexOf('@');
  const hostStart = authStart + (at >= 0 ? at + 1 : 0);
  const hostPart = address.slice(hostStart, authEnd);
  let hostEnd = authEnd;
  if (hostPart.startsWith('[')) {
    // An IPv6 literal is full of colons; the one that starts a port is the one
    // after the closing bracket.
    const close = hostPart.indexOf(']');
    if (close >= 0) hostEnd = hostStart + close + 1;
  } else {
    const colon = hostPart.indexOf(':');
    if (colon >= 0) hostEnd = hostStart + colon;
  }
  if (hostEnd <= hostStart) return null;
  return {
    pre: address.slice(0, hostStart),
    host: address.slice(hostStart, hostEnd),
    post: address.slice(hostEnd),
  };
}

/**
 * The destination block: what the board is about to do, then the host alone,
 * then the whole address underneath.
 *
 * It answers a finding about the block it replaces. The part of an address that
 * decides where a code goes is the host, and it was neither the part the eye
 * landed on — the whole address was one bold string, so the userinfo of
 * `https://board@evil.example/cb` read as the destination — nor
 * above the button that sends it.
 *
 * So: the sentence leads, in the plain register the circle-slash line already
 * uses, and ends in a comma that the host completes. The host carries the
 * emphasis because it carries the meaning. The whole address stays on the page,
 * quiet and underneath, because it is the thing a careful person verifies and
 * the board must not be the one that hid it.
 *
 * The two sentences are the same sentence with one word changed, deliberately.
 * Under RFC 8252 §7.3 a loopback address on an arbitrary port is the ordinary
 * local MCP client, and `https://claude.ai/...` is a real hosted client — so
 * neither is a warning, and a block that read as one for the remote case would
 * teach people to ignore it.
 */
function destinationBlock(
  escaped: string,
  parts: ReturnType<typeof splitDestination>,
  reach: DestinationReach,
): string {
  const lead =
    reach === 'local'
      ? 'The code stays on this computer, at'
      : reach === 'remote'
        ? 'The code leaves this computer, to'
        : 'Authorizing will send the code to';
  // With no authority to cut there is no host to promote, so the whole address
  // takes the emphasised line and there is no second line to repeat it on.
  const host = parts ? esc(parts.host) : escaped;
  const full = parts ? `<span class="addr">${escaped}</span>` : '';
  return (
    `    <p class="dest"><span class="lead">${lead}</span>` +
    `<span class="host">${host}</span>${full}</p>\n`
  );
}

/**
 * One object rather than six positional arguments, deliberately. `csrf` and
 * `clientName` are both strings that both get escaped into the page, so a
 * positional swap renders a page that looks entirely correct with the CSRF
 * token silently broken — and nothing in the suite would catch it. Named keys
 * make that swap impossible to write.
 */
export interface ConsentPageOptions {
  reqId: string;
  /** Absent when the client registered no name, or has been evicted since. */
  clientName: string | undefined;
  email: string;
  csrf: string;
  requestedScopes: string[] | undefined;
  canGrantAdmin: boolean;
  /** Where the code goes — the pending record's, never the registration's list. */
  redirectUri: string;
  /**
   * What the board may say about where that is. Passed in rather than derived
   * here: the caller already classifies the destination to decide whether to
   * log it, and one classification means the line on the page and the line in
   * the log cannot disagree. It is also computed from the RAW address, while
   * this file renders the normalised one — and where those differ, the raw one
   * is the address the code would actually be sent to.
   */
  reach: DestinationReach;
}

// `String(s)` first because these values come off the wire, and express hands a
// repeated query parameter (`?req=a&req=b`) over as an array — which every
// `.replace` below would throw on, turning a malformed URL into a 500 on a
// credential-granting screen. Coerced, a duplicated id simply matches no pending
// request and the flow ends on the terminal page.
const esc = (s: string) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CSS = `
:root{--bg:#0e1015;--card:#1f222d;--fg:#eeeff0;--fg2:#a5a9b5;--fg3:#8a93a8;--row:#252936;--rowh:#2d3240;
  --brand:#165ff2;--brandh:#3d7af4;--on-brand:#f6f7f7;--sh:0 8px 24px rgba(0,0,0,.5)}
@media (prefers-color-scheme:light){:root{--bg:#e1e2e4;--card:#fff;--fg:#0e1015;--fg2:#393d4b;--fg3:#535a6e;
  --row:#f2f3f4;--rowh:#e9eaec;--brand:#165ff2;--brandh:#0b4cd5;--sh:0 8px 24px rgba(0,0,0,.10)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
  -webkit-font-smoothing:antialiased;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:30rem;padding:2rem 1.25rem}
.mark{font-size:15px;font-weight:600;letter-spacing:-.01em;margin:0 0 12px;text-align:center;color:var(--fg)}
h1{margin:0 0 16px;font-size:1.5rem;font-weight:400;letter-spacing:-.01em;text-align:center;
  line-height:1.3;overflow-wrap:anywhere}
.card{background:var(--card);border-radius:16px;padding:26px 24px;box-shadow:var(--sh)}
p{margin:0;color:var(--fg2);font-size:15px;overflow-wrap:anywhere}
b{color:var(--fg);font-weight:600}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.875em}
.chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:14px 0 0;font-size:13px;color:var(--fg3)}
.chip{background:var(--row);color:var(--fg2);border-radius:7px;padding:3px 8px;font-size:13px;
  max-width:100%;min-width:0;overflow-wrap:anywhere}
.chip-off{background:none;padding-left:0;color:var(--fg3)}
.cap{margin-top:12px;font-size:13px;line-height:1.5;color:var(--fg2)}
form{margin:0}
.wide{margin-top:20px}
.row{display:flex;gap:8px;margin-top:20px}
.wide+.row{margin-top:16px}
.row form{flex:1 1 0;min-width:0}
.btn{display:block;width:100%;text-align:center;border:0;border-radius:11px;padding:13px 12px;
  background:var(--row);color:var(--fg);font:inherit;font-weight:600;font-size:15px;line-height:1.2;
  cursor:pointer;overflow-wrap:anywhere}
.btn:hover{background:var(--rowh)}
.btn:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.btn-on{background:var(--brand);color:var(--on-brand)}
.btn-on:hover{background:var(--brandh)}
.dest{margin-top:20px}
.dest .lead{display:block;font-size:13px;line-height:1.45;color:var(--fg2)}
.dest .host{display:block;margin-top:2px;font-size:17px;line-height:1.3;font-weight:600;
  letter-spacing:-.01em;color:var(--fg);overflow-wrap:anywhere}
.dest .addr{display:block;margin-top:5px;font-size:13px;line-height:1.45;color:var(--fg3);
  overflow-wrap:anywhere}
.facts{display:flex;gap:8px;align-items:flex-start;margin:0 0 14px;padding:0 2px;
  font-size:13px;line-height:1.45;color:var(--fg2)}
.facts svg{flex:none;margin-top:2px;fill:currentColor}
`;

/**
 * One document for every page this file renders. The terminal pages carry the
 * same stylesheet as the consent screen deliberately: they are arrived at from
 * it, most often by pressing one of its buttons, and a bare unstyled paragraph
 * reads as a crash rather than as an answer.
 */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>${CSS}</style></head>
<body>
<main>
  <p class="mark">board.</p>
${body}
</main>
</body></html>`;
}

/**
 * How a flow that granted nothing ended. Three arrivals, three different things
 * to say, and the difference is not cosmetic:
 *
 *  - `expired` — the request is gone: spent, timed out, or never existed.
 *    Starting again is the right advice and this is the only page that gives it.
 *    It does not say what came of the request, because it cannot know. One way
 *    to reach it is to grant, press Back and submit the page again — where the
 *    answer was yes, a credential exists, and a line saying nothing was granted
 *    would send somebody away believing they had nothing to revoke.
 *  - `refused` — the person said no and the board completed it here, because
 *    there was no live record left to carry a refusal back to the client.
 *    Telling them to restart the connection they just declined would be absurd.
 *  - `unbound` — the request was started in another browser. An honest person
 *    meets this when their MCP client opened the system default browser and
 *    they are signed in to a different one; rendering that as "expired" sends
 *    them to redo the thing that just failed. It is also the exact signature of
 *    the pre-seeded-link attack, which is why it says where to go and offers
 *    nothing to press.
 */
export type TerminalOutcome = 'expired' | 'refused' | 'unbound';

const TERMINAL_COPY: Record<TerminalOutcome, { title: string; heading: string; body: string }> = {
  expired: {
    title: 'Board — request closed',
    heading: 'This request is no longer open',
    body: 'It timed out, or it was already answered. Either way it cannot be answered again. Start the connection again from your MCP client.',
  },
  refused: {
    title: 'Board — access refused',
    heading: 'Access refused',
    body: 'No code was issued, and board sent nothing to the client. You can close this tab.',
  },
  unbound: {
    title: 'Board — request from another browser',
    heading: 'This request started in another browser',
    body: 'Nothing was granted. Open the link again in the browser you started the connection from.',
  },
};

export function renderTerminalPage(outcome: TerminalOutcome): string {
  const { title, heading, body } = TERMINAL_COPY[outcome];
  return shell(
    title,
    `  <h1>${heading}</h1>
  <div class="card">
    <p>${body}</p>
  </div>
`,
  );
}

export function renderConsentPage({
  reqId,
  clientName,
  email,
  csrf,
  requestedScopes,
  canGrantAdmin,
  redirectUri,
  reach,
}: ConsentPageOptions): string {
  // Sanitise and normalise the RAW strings; escape last, at interpolation. The
  // order is load-bearing — escape first and a cut through `&amp;` emits `&am`.
  const name = clientName === undefined ? '' : sanitiseClientName(clientName, RENDERED_CAP);
  // Capped like the name, and for the name's reason. A 4000-character URI was
  // rendered whole. Presentation is untouched: this is the value, not the row
  // it sits in.
  const address = displayed(redirectUri, RENDERED_CAP);

  const hidden = `
      <input type="hidden" name="req" value="${esc(reqId)}" />
      <input type="hidden" name="csrf" value="${esc(csrf)}" />`;

  const grant = (preset: Preset, primary: boolean) => `
    <form method="POST" action="/api/oauth/consent">${hidden}
      <input type="hidden" name="scope" value="${preset}" />
      <button class="btn${primary ? ' btn-on' : ''}" type="submit">${PRESET_LABEL[preset]}</button>
    </form>`;

  // The refusal is a submit of the same form family — never an anchor, and never
  // a link back to the client, because refusing must not be one click away from
  // a custom-protocol launch. It carries the request id and the CSRF token like
  // every grant does: a refusal consumes the pending record, so a cross-site
  // auto-POST must not be able to cancel somebody's connection. Its field is
  // `decision`, never `scope` — a malformed scope can then never be read as a
  // refusal, and a malformed decision can never be read as a grant. Neutral, not
  // red: refusing is the safe act and the board is not warning about anything.
  const refuse = `
    <form method="POST" action="/api/oauth/consent">${hidden}
      <input type="hidden" name="decision" value="${REFUSE_VALUE}" />
      <button class="btn" type="submit">${REFUSE_LABEL}</button>
    </form>`;

  // The first preset is the primary — least privilege — and it is the one that
  // sits beside the refusal. Anything further this authority may grant is a
  // quieter full-width row above the decision, so the decision itself is the
  // same two controls in the same two places on a member's page and an admin's.
  //
  // The refusal comes first, in the DOM and therefore in the tab order. The
  // person most likely to want it is the one who did not start this flow, and
  // they are also the one least likely to be reading carefully.
  const [primary, ...rest] = grantablePresets(canGrantAdmin);
  const extra = rest.map((p) => `<div class="wide">${grant(p, false)}</div>`).join('');
  const decision = `<div class="row">${refuse}${grant(primary, true)}</div>`;

  // Which requested scope this person will actually receive, derived from the
  // same list the buttons come from rather than from a second test for
  // 'board:admin'. A scope nobody recognises is marked not granted too, which
  // is right. The words carry that, not a strike-through: `text-decoration` is
  // not exposed to assistive technology, so a struck chip reads as an ordinary
  // one to a screen reader. Matched on the RAW scope, displayed normalised: a
  // string that only looks like `board:read` once its zero-width characters are
  // gone is not `board:read`, and saying so is the honest chip.
  //
  // The list is capped as well as each entry in it, for the reason the name is:
  // the entries are a stranger's and there is no bound on how many of them
  // there can be. Two thousand of them pushed the decision 152,000 bytes down
  // the document. The cut carries the same mark a cut name carries.
  const grantable = new Set(grantablePresets(canGrantAdmin).flatMap((p) => expandPreset(p)));
  const requested = requestedScopes ?? [];
  const chips = requested
    .slice(0, SCOPE_CHIP_LIMIT)
    .map((raw) => {
      const shown = esc(displayed(raw, RENDERED_CAP));
      return grantable.has(raw)
        ? `<span class="chip"><code>${shown}</code></span>`
        : `<span class="chip chip-off"><code>${shown}</code> not granted</span>`;
    })
    .join('');
  const cut = requested.length > SCOPE_CHIP_LIMIT ? RENDERED_CAP.marker : '';
  const chipRow = chips ? `    <div class="chips">Requested scopes ${chips}${cut}</div>\n` : '';

  // `client_name` is optional in dynamic registration, and a registration can
  // also be evicted from the registry while its request is still live. Either
  // way the heading has to work with nothing in it — and `esc(undefined)` would
  // write the literal word `undefined` where a name belongs, because `esc`
  // coerces with `String(s)`. The board names the absence instead.
  const heading = name ? `Authorize ${esc(name)}` : 'Authorize an unnamed client';

  // Github counterweights an app's own name with a strip of facts it can stand
  // behind — owner, age, user count. The board has one such fact about a
  // dynamically registered MCP client, and states it in the negative, naming
  // only what is actually on the page above it.
  const own = name ? 'The name and address above are' : 'The address above is';
  const facts =
    `<p class="facts">${SLASH}<span><b>Not</b> run or vetted by board. ` +
    `${own} the client\u2019s own.</span></p>`;

  // Above the decision, not under it. It is the fact the decision turns on, and
  // a person cannot weigh it after pressing the button that acts on it. The
  // address is cut and classified from the same normalised string the page
  // prints, so the emphasised host is always a substring of the address shown.
  const dest = destinationBlock(esc(address), splitDestination(address), reach);

  return shell(
    'Board — MCP access',
    `  <h1>${heading}</h1>
  ${facts}
  <div class="card">
    <p>This client asks to act on the board as <b>${esc(normalise(email))}</b>.</p>
${chipRow}${canGrantAdmin ? '' : `    <p class="cap">${CAP_NOTE}</p>\n`}${extra}
${dest}${decision}
  </div>
`,
  );
}
