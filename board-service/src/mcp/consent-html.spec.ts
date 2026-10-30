import { describe, it, expect } from 'vitest';
import {
  RENDERED_CAP,
  SCOPE_CHIP_LIMIT,
  renderConsentPage,
  renderTerminalPage,
  sanitiseClientName,
  splitDestination,
  type ConsentPageOptions,
} from './consent-html';

const BASE: ConsentPageOptions = {
  reqId: 'req-1',
  clientName: 'Claude Code',
  email: 'a@example.com',
  csrf: 'csrf-xyz',
  requestedScopes: undefined,
  canGrantAdmin: true,
  redirectUri: 'http://127.0.0.1:52411/callback',
  reach: 'local',
};

const render = (over: Partial<ConsentPageOptions> = {}) =>
  renderConsentPage({ ...BASE, ...over });

const page = (canGrantAdmin: boolean, requested?: string[]) =>
  render({ canGrantAdmin, requestedScopes: requested });

/**
 * The one CSS rule that governs `sel`, sliced out by the two literals around it.
 *
 * Both literals are asserted found, for the reason two other rows in this file
 * already guard the same `indexOf` trap: a missing selector returns -1, the
 * slice silently widens to the whole document, and `overflow-wrap:anywhere`
 * appears in four rules — so five assertions would go on passing for the wrong
 * reason the day the FOLLOWING selector is renamed.
 */
const rule = (html: string, sel: string, next: string) => {
  const from = html.indexOf(`\n${sel}{`);
  const to = html.indexOf(`\n${next}{`);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return html.slice(from, to);
};

describe('renderConsentPage', () => {
  it('embeds the request id, csrf token and the caller', () => {
    const html = page(true);
    expect(html).toContain('value="req-1"');
    expect(html).toContain('value="csrf-xyz"');
    expect(html).toContain('a@example.com');
  });

  it('offers both presets to somebody who may hold admin scope', () => {
    const html = page(true);
    expect(html).toContain('value="agent"');
    expect(html).toContain('value="full"');
  });

  it('offers only the read preset to somebody who may not (#545)', () => {
    const html = page(false);
    expect(html).toContain('value="agent"');
    expect(html).not.toContain('value="full"');
  });

  it('tells a non-admin why the fuller choice is absent, in plain prose', () => {
    const html = page(false);
    expect(html).toContain('You are not a board admin, so read-only is all this can grant.');
    expect(html).toContain('An admin can change that in Admin › Access.');
    // The note explains a ceiling to a person; it must not name the code that
    // enforces it, nor the register that phrase came from.
    expect(html).not.toContain('Acting on your behalf');
    expect(page(true)).not.toContain('not a board admin');
  });

  it('says what each button does, in words rather than preset keys (#545)', () => {
    // REWRITTEN for the approved design. It used to also pin a second line of
    // hint copy under each label (`>read-only<`, `>propose and apply board
    // changes<`); the design drops the hints, because the decision row puts the
    // refusal beside the grant at the same size and a two-line button cannot
    // hold that shape. What the row was really protecting — that the preset KEYS
    // never reach the person — is unchanged and still asserted below.
    const html = page(true);
    expect(html).toContain('>Read the board<');
    expect(html).toContain('>Read and change the board<');
    // `agent`/`full` stay the wire values; they are not shown to the person.
    expect(html).not.toContain('>Agent<');
    expect(html).not.toContain('>Full<');
  });

  it('ends the lead-in at the person, with no second name for the scopes block (#545)', () => {
    // REWRITTEN for the approved design. #545 pinned the exact ending
    // `requests access on behalf of <b>a@example.com</b>.</p>`; the client's
    // name has left that sentence for the heading, so the sentence itself is
    // new. The property the row protects is unchanged: the lead-in ends at the
    // person, and the scopes block gets no second name of its own.
    for (const canGrantAdmin of [true, false]) {
      const html = page(canGrantAdmin, ['board:read']);
      expect(html).toContain('This client asks to act on the board as <b>a@example.com</b>.</p>');
      expect(html).not.toContain('Session scope');
      expect(html).not.toContain('This is what it will get');
    }
  });

  it('marks a withheld scope in words, never by a strike-through alone (#545)', () => {
    // text-decoration is invisible to assistive technology, so the words carry
    // the meaning and the rule that struck the code is gone.
    const html = page(false, ['board:read', 'board:admin']);
    expect(html).toContain('not granted');
    expect(html).not.toContain('line-through');
  });

  it('leads with least privilege: the read-only button is primary for both authorities', () => {
    // V11, decided by the approved design: blue stays on the single grant. On
    // the admin page it is first among grants; on the member page, where there
    // is only one, it is the answer that carries the emphasis against the
    // refusal beside it. Pinned either way so the meaning cannot drift silently.
    for (const canGrantAdmin of [true, false]) {
      const html = page(canGrantAdmin);
      const agentForm = html.slice(html.indexOf('value="agent"'));
      expect(agentForm.slice(0, 400)).toContain('btn-on');
    }
  });

  it('names the client in the heading, not in code — monospace is for scopes (#545)', () => {
    const html = page(true, ['board:read']);
    expect(html).toContain('<h1>Authorize Claude Code</h1>');
    expect(html).not.toContain('<code>Claude Code</code>');
    expect(html).toContain('<code>board:read</code>');
  });

  it('renders two registrations as two different pages (#554)', () => {
    expect(render({ clientName: 'Claude Code' })).not.toBe(render({ clientName: 'Cursor' }));
    expect(render({ clientName: 'Cursor' })).toContain('<h1>Authorize Cursor</h1>');
  });

  it('escapes hostile client names', () => {
    const html = render({ clientName: '<script>alert(1)</script>', requestedScopes: undefined });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes a hostile destination the same way (#554)', () => {
    const html = render({ redirectUri: 'https://evil.example/"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises a bidi override in the name, so the sanitiser is actually wired in (#554)', () => {
    // U+202E reverses everything after it. Exported and tested as a pure
    // function below; this row is what proves the render path calls it.
    const html = render({ clientName: 'Claude\u202EDesktop' });
    expect(html).toContain('<h1>Authorize ClaudeDesktop</h1>');
    expect(html).not.toContain('\u202E');
  });

  it('normalises a bidi override in the destination too (#554)', () => {
    const html = render({ redirectUri: 'https://evil.example/\u202Ecb' });
    expect(html).not.toContain('\u202E');
  });

  it('never renders the word undefined as a client identity (#554)', () => {
    // `client_name` is optional in dynamic registration and `esc` coerces with
    // `String(s)`, so an unguarded `esc(client.client_name)` puts that word on
    // the page as the client's name.
    const html = render({ clientName: undefined });
    expect(html).not.toContain('undefined');
    expect(html).toContain('<h1>Authorize an unnamed client</h1>');
  });

  it('still offers the grant buttons to a client the registry has forgotten (#554)', () => {
    // The registry evicts oldest-first past 1000, so a live pending record can
    // outlive its own registration. The board has lost the name; it has not lost
    // the request, and the request is still grantable.
    const html = render({ clientName: undefined, canGrantAdmin: false });
    expect(html).toContain('value="agent"');
    expect(html).toContain('http://127.0.0.1:52411/callback');
  });

  it('shows where the code goes (#554)', () => {
    expect(render({ redirectUri: 'https://bord-manager.org/cb' })).toContain(
      'https://bord-manager.org/cb',
    );
  });

  it('renders the destination as text and never as a link (#554)', () => {
    // Scheme safety does not live in board code: the SDK's SafeUrlSchema rejects
    // only javascript:, data: and vbscript:, so `vscode:`, `cursor:` and every
    // other custom scheme is a legal registered destination. An anchor hands the
    // browser one of those on a click the person did not understand.
    for (const uri of ['vscode://ms-vscode/cb', 'https://evil.example/cb']) {
      expect(render({ redirectUri: uri })).not.toMatch(/<a[\s>]/);
    }
  });

  it('renders requested board:* scopes when supplied (#56)', () => {
    expect(page(true, ['board:read', 'board:admin'])).toContain('board:admin');
  });

  it('marks a requested scope this person will not receive as not granted (#545)', () => {
    const html = page(false, ['board:read', 'board:admin']);
    expect(html).toContain('chip-off');
    expect(html).toContain('not granted');
    // The admin sees the same scope as an ordinary chip — the struck one is
    // about this person's ceiling, not about the scope.
    expect(page(true, ['board:read', 'board:admin'])).not.toContain('not granted');
  });

  it('omits the requested-scopes block when none supplied', () => {
    expect(page(true)).not.toContain('Requested scopes');
  });

  it('is a whole page for either authority when nothing was requested (#545)', () => {
    const asAdmin = page(true);
    expect(asAdmin).toContain('value="agent"');
    expect(asAdmin).toContain('value="full"');
    expect(asAdmin).not.toContain('class="chips"');
    const asMember = page(false);
    expect(asMember).toContain('value="agent"');
    expect(asMember).not.toContain('value="full"');
    expect(asMember).toContain('not a board admin');
    expect(asMember).not.toContain('class="chips"');
  });

  it('never lets the decision sit flush against the prose (#545)', () => {
    // REWRITTEN for the approved design. #545 pinned this on
    // `form:first-of-type{margin-top:20px}` and `form:last-of-type{margin-bottom:0}`,
    // which worked while every control was its own full-width form in document
    // order. The design puts the decision in a flex row, so those selectors no
    // longer match what they were chosen to match and the spacing has moved onto
    // the row and onto the extra-grant block. Same defect guarded, on the rules
    // that now carry it. Spacing is CSS and this suite has no layout engine —
    // the rendered proof is a browser measurement, not this assertion.
    for (const canGrantAdmin of [true, false]) {
      const html = page(canGrantAdmin);
      expect(html).not.toContain('class="chips"');
      expect(rule(html, '.row', '.wide+.row')).toContain('margin-top:20px');
      expect(rule(html, '.wide', '.row')).toContain('margin-top:20px');
    }
  });

  it('holds a 200-character requested scope inside its own column (#545)', () => {
    const long = `board:${'x'.repeat(194)}`;
    expect(long.length).toBe(200);
    const html = page(false, [long]);
    // Rendered whole — the fix is containment, not truncation.
    expect(html).toContain(long);
    const chipRule = html.slice(html.indexOf('.chip{'), html.indexOf('.chip-off{'));
    expect(chipRule).toContain('max-width:100%');
    expect(chipRule).toContain('min-width:0');
    expect(chipRule).toContain('overflow-wrap:anywhere');
  });

  it('holds a 200-character client name inside the page, rendered whole (#545)', () => {
    // REWRITTEN for the approved design, and only for where the name now sits.
    // #545 asserted `<b>${long}</b>` because the name lived inside the lead-in
    // paragraph; it is the heading now, so the containment rule that has to
    // carry it is h1's. What the row asserted — that a 200-character name is
    // rendered WHOLE and contained rather than cut — is unchanged, and the cap
    // is set above 200 precisely so it stays true.
    const long = 'A'.repeat(200);
    expect(RENDERED_CAP.cap).toBeGreaterThan(long.length);
    const html = render({ clientName: long });
    expect(html).toContain(`<h1>Authorize ${long}</h1>`);
    expect(rule(html, 'h1', '.card')).toContain('overflow-wrap:anywhere');
  });

  it('holds a 200-character destination inside its column (#554)', () => {
    const long = `https://evil.example/${'x'.repeat(179)}`;
    expect(long.length).toBe(200);
    const html = render({ redirectUri: long, reach: 'remote' });
    expect(html).toContain(long);
    // The destination is now two lines, not one paragraph of text: the host on
    // its own, and the whole address under it. BOTH have to break, and each
    // carries its own rule — the paragraph rule no longer reaches either,
    // because the text is in spans inside it.
    expect(rule(html, '.dest .host', '.dest .addr')).toContain('overflow-wrap:anywhere');
    expect(rule(html, '.dest .addr', '.facts')).toContain('overflow-wrap:anywhere');
  });

  it('caps a name past the cap and marks the cut (#554)', () => {
    // An unbounded name is a way to push the decision below the fold, to push
    // the destination out of view, and to make the heading the whole page.
    //
    // The input and the bound are BOTH written here as numbers, on purpose. An
    // earlier version of this row fed `cap + 200` characters in and asserted the
    // output was `cap` long, which is true for every cap there is — raising the
    // cap to a hundred thousand left it green. A test that derives its input
    // from the value it is testing has no opinion about that value.
    expect(RENDERED_CAP.cap).toBeGreaterThan(200);
    expect(RENDERED_CAP.cap).toBeLessThanOrEqual(512);
    const html = render({ clientName: 'A'.repeat(2000) });
    const heading = html.match(/<h1>Authorize ([^<]*)<\/h1>/)![1];
    expect(heading.length).toBeLessThanOrEqual(512);
    expect(heading.endsWith(RENDERED_CAP.marker)).toBe(true);
  });

  /**
   * `requestedScopes` comes off the client's own `scope=` query parameter, so
   * every string in it is a stranger's, exactly like the client name — and until
   * these rows it was the one such string on the page with no hostile-input
   * coverage at all.
   */
  describe("a requested scope is a stranger's string too (#554)", () => {
    // `requestedScopes` comes off the client's own `scope=` query parameter, so
    // every entry is a stranger's string exactly as the client name is. The
    // invisible characters below are written as escapes for the same reason the
    // sanitiser's own rows give: a literal U+202E in this file would reverse the
    // source itself in most editors.
    it('matches on the RAW scope, never on the normalised one', () => {
      // A string that only becomes `board:read` once its zero-width characters
      // are gone is not `board:read`, and the chip has to say so. Matching on
      // the normalised string instead is a mutation that left every other row in
      // this file green, and it turns a scope nobody will receive into one that
      // reads as granted.
      const html = page(true, ['board:re\u200Bad']);
      expect(html).toContain('not granted');
      expect(html).toContain('<code>board:read</code>');
    });

    it('displays the scope NORMALISED, so an override cannot reverse the row', () => {
      // The other half of the same line, and the other surviving mutation:
      // dropping `normalise` from the chip text puts U+202E into the document,
      // where it reverses everything rendered after it.
      const html = page(true, ['board:read\u202Eevil']);
      expect(html).not.toContain('\u202E');
      expect(html).toContain('board:readevil');
    });

    it('escapes a hostile scope rather than rendering it', () => {
      const html = page(true, ['<script>alert(1)</script>']);
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;');
    });

    it.each([
      ['a newline', 'board:read\nboard:admin', 'board:read board:admin'],
      ['a C0 control', 'board:re\u0007ad', 'board:re ad'],
      ['U+200E left-to-right mark', 'board:\u200Eread', 'board:read'],
      ['U+00AD soft hyphen', 'board:\u00ADread', 'board:read'],
      ['U+2069 pop directional isolate', 'board:read\u2069', 'board:read'],
    ])('strips %s out of the chip, like the name', (_what, raw, shown) => {
      const html = page(true, [raw]);
      expect(html.match(/<span class="chip[^>]*><code>([^<]*)<\/code>/)![1]).toBe(shown);
    });
  });

  /**
   * The destination block's three parts, as the page actually printed them.
   *
   * The block leads with a sentence, then the host alone, then the whole
   * address underneath for verification — so "what did the page say the
   * destination was" is now two different questions, and the rows below are
   * careful about which one they ask. `destAddr` is the one that answers the
   * old question: the whole address, exactly as rendered.
   */
  const destBlock = (html: string) => html.match(/<p class="dest">([\s\S]*?)<\/p>/)![1];
  const destLead = (html: string) => destBlock(html).match(/<span class="lead">([^<]*)<\/span>/)![1];
  const destHost = (html: string) => destBlock(html).match(/<span class="host">([^<]*)<\/span>/)![1];
  const destAddr = (html: string) =>
    destBlock(html).match(/<span class="addr">([^<]*)<\/span>/)?.[1];

  /** How many scope chips the page printed. */
  const chipCount = (html: string) => (html.match(/<span class="chip/g) ?? []).length;

  it('caps how many requested scopes it will render, and marks the cut (#554)', () => {
    // One chip per entry, off the client's own `scope=` query parameter, with
    // registration open to anybody: 2000 scopes rendered 2001 chips and a 151KB
    // page, with the decision 152,000 bytes down. The client name got a cap for
    // exactly this reason one line above it.
    const many = Array.from({ length: 2000 }, (_, i) => `board:scope${i}`);
    const html = page(false, many);
    expect(chipCount(html)).toBe(SCOPE_CHIP_LIMIT);
    expect(html).toContain(RENDERED_CAP.marker);
    // The decision is still near the top of the document rather than below a
    // wall of chips. Generous, and four orders of magnitude off the defect.
    expect(html.indexOf('<div class="row">')).toBeLessThan(10_000);
  });

  it('renders every scope when the list is inside the cap, with no marker', () => {
    const html = page(true, ['board:read', 'board:admin']);
    expect(chipCount(html)).toBe(2);
    expect(html).not.toContain(RENDERED_CAP.marker);
  });

  it('caps a single over-long requested scope the way the name is capped (#554)', () => {
    const html = page(true, [`board:${'y'.repeat(4000)}`]);
    const chip = html.match(/<span class="chip[^"]*"><code>([^<]*)<\/code>/)![1];
    expect(chip.length).toBe(RENDERED_CAP.cap);
    expect(chip.endsWith(RENDERED_CAP.marker)).toBe(true);
  });

  it('caps the destination the way the name is capped (#554)', () => {
    // Same argument as the name and the chips: an unbounded string a stranger
    // chose is a way to make the rest of the page somebody else's problem.
    const long = `https://evil.example/${'x'.repeat(3979)}`;
    expect(long.length).toBe(4000);
    const html = render({ redirectUri: long });
    expect(html).not.toContain(long);
    // The cap is applied to the address BEFORE it is cut into a host and a
    // remainder, so the bound is on the whole rendered address — the line the
    // 4000 characters would otherwise have landed on.
    const shown = destAddr(html)!;
    expect(shown.length).toBe(RENDERED_CAP.cap);
    expect(shown.endsWith(RENDERED_CAP.marker)).toBe(true);
  });

  it('leaves an ordinary destination byte-identical, so the legitimate case pays nothing', () => {
    expect(destAddr(render({ redirectUri: 'http://localhost:52411/callback' }))).toBe(
      'http://localhost:52411/callback',
    );
  });

  /**
   * The destination block leads with what the board is about to do, puts the
   * host alone on the line the eye lands on, and repeats the whole address
   * underneath for verification.
   *
   * The part of an address that decides where a code goes is the host, and it
   * was neither the part the eye landed on nor above the button that sends it.
   */
  describe('the destination block (#554)', () => {
    it('puts the destination above the decision it informs', () => {
      // It sat under the buttons. A fact that decides a choice has to be
      // readable before the control that makes it, not after.
      const html = render();
      expect(html.indexOf('<p class="dest">')).toBeLessThan(html.indexOf('<div class="row">'));
    });

    it.each([
      ['a plain remote address', 'https://claude.ai/api/mcp/auth_callback', 'claude.ai'],
      ['a loopback address', 'http://127.0.0.1:52411/callback', '127.0.0.1'],
      // The host appears twice in this one. It is the whole reason the cut is
      // made by position rather than by searching for the hostname.
      [
        'a userinfo address that is itself a hostname',
        'https://evil.example@evil.example/cb',
        'evil.example',
      ],
      [
        'a lookalike host',
        'https://board.evil.example/cb',
        'board.evil.example',
      ],
    ])('emphasises the host, and only the host, of %s', (_what, uri, host) => {
      expect(destHost(render({ redirectUri: uri, reach: 'remote' }))).toBe(host);
    });

    it('keeps the port out of the emphasised line, and the whole address under it', () => {
      // Under RFC 8252 §7.3 a loopback client takes whatever port it can get,
      // so the port changes every run and decides nothing.
      const html = render({ redirectUri: 'http://127.0.0.1:52411/callback', reach: 'local' });
      expect(destHost(html)).toBe('127.0.0.1');
      expect(destHost(html)).not.toContain('52411');
      expect(destAddr(html)).toBe('http://127.0.0.1:52411/callback');
    });

    it('states where the code goes for a loopback destination', () => {
      expect(destLead(render({ redirectUri: 'http://127.0.0.1:52411/cb', reach: 'local' }))).toBe(
        'The code stays on this computer, at',
      );
    });

    it('states where the code goes for a remote one, in the same shape', () => {
      // The same sentence with one word changed, deliberately: a hosted client
      // like `https://claude.ai/...` is ordinary, not a warning.
      expect(
        destLead(render({ redirectUri: 'https://claude.ai/api/mcp/auth_callback', reach: 'remote' })),
      ).toBe('The code leaves this computer, to');
    });

    it('claims nothing about where a custom-scheme destination goes', () => {
      // The loopback classifier works by HOST, so `cursor://…` reads as remote
      // — but the thing it reaches is a program on this machine. Saying "not on
      // this computer" would be the board inventing a fact, so it says neither.
      const html = render({
        redirectUri: 'cursor://anysphere.cursor-retrieval/cb',
        reach: 'unstated',
      });
      expect(destLead(html)).toBe('Authorizing will send the code to');
      expect(html).not.toContain('this computer');
      // It still gets the emphasis: the host is the part that decides.
      expect(destHost(html)).toBe('anysphere.cursor-retrieval');
    });

    it('shows an address it cannot cut whole, with no emphasis to mislead', () => {
      // `cursor:cb` has no `://` authority at all, so there is no host to
      // promote. The page shows the string it was given and nothing more.
      const html = render({ redirectUri: 'cursor:cb', reach: 'unstated' });
      expect(destHost(html)).toBe('cursor:cb');
      expect(destAddr(html)).toBeUndefined();
    });
  });

  it('offers a refusal beside the grant, on both the admin and the one-button page (#555)', () => {
    for (const canGrantAdmin of [true, false]) {
      const html = page(canGrantAdmin);
      expect(html).toContain('name="decision" value="deny"');
      expect(html).toContain('>Cancel<');
    }
  });

  it('gives the refusal the request id and the csrf token, like the grants (#555)', () => {
    // A refusal consumes the pending record, so it needs the same protection a
    // grant does: a cross-site auto-POST must not be able to cancel a request.
    const html = page(false);
    const at = html.indexOf('name="decision" value="deny"');
    // Without this the slice below runs from -401 to -1, which is a window over
    // the END of the document — and one that happens to contain both tokens.
    expect(at).toBeGreaterThan(0);
    const refuseForm = html.slice(at - 400, at);
    expect(refuseForm).toContain('value="req-1"');
    expect(refuseForm).toContain('value="csrf-xyz"');
  });

  it('keeps the refusal out of the scope vocabulary entirely (#555)', () => {
    // Naming its field `scope`, or giving it the value `full`, would turn the
    // #545 rows that assert a non-admin's page carries no `value="full"` red —
    // correctly, but for a reason that has nothing to do with authority.
    const html = page(false);
    expect(html).toContain('name="decision" value="deny"');
    expect(html).not.toContain('name="scope" value="deny"');
    expect(html).not.toContain('name="decision" value="full"');
    expect(html).not.toContain('name="decision" value="agent"');
    expect(html).not.toContain('value="full"');
  });

  it('puts the refusal first, in reading order and in the DOM (#555)', () => {
    // The person most likely to want the refusal is the one who did not start
    // the flow, and they are also the one least likely to be reading carefully.
    const html = page(true);
    const refusal = html.indexOf('name="decision" value="deny"');
    const grant = html.indexOf('name="scope" value="agent"');
    // Both found, or `indexOf` returns -1 and "-1 < n" is true for a page with
    // no refusal on it at all.
    expect(refusal).toBeGreaterThan(0);
    expect(grant).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(grant);
  });

  it('makes the refusal the same size and shape as the grant, and never red (#555)', () => {
    // Colour is the only difference: the grant carries the brand emphasis, the
    // refusal carries none. Refusing is the safe act and nothing about it is a
    // warning.
    const html = page(false);
    expect(html).toContain('<button class="btn" type="submit">Cancel</button>');
    expect(html).toContain('<button class="btn btn-on" type="submit">Read the board</button>');
  });

  it('is not a link back to the client, only a form (#555)', () => {
    expect(page(false)).not.toMatch(/<a[\s>]/);
  });

  it('renders rather than throws when ?req= is duplicated into an array (#545)', () => {
    const html = render({
      // The cast IS the test: express hands a repeated `?req=` over as an array,
      // and `esc()`'s `String(s)` coercion is what keeps that off the 500 path.
      reqId: ['a', 'b'] as unknown as string,
      clientName: 'MCP client',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('name="req"');
  });
});

/**
 * Three paths end on this page and none of them may read as another: a request
 * that is gone, a refusal the board completed itself, and a request this browser
 * did not start. The last one is the reason the copy is per-outcome rather than
 * one neutral page — telling an honest person on a second device that their
 * request "expired" sends them to restart the thing that just worked.
 */
describe('renderTerminalPage — where a flow that grants nothing ends (#555)', () => {
  const OUTCOMES = ['expired', 'refused', 'unbound'] as const;

  it.each(OUTCOMES)('renders %s as a whole document with the page stylesheet', (outcome) => {
    // Until this task the dead-request answer was a bare `<p>` with no doctype
    // and no styles, on the same flow as a credential-granting screen.
    const html = renderTerminalPage(outcome);
    const consent = page(true);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html lang="en">');
    const stylesheet = consent.slice(consent.indexOf('<style>'), consent.indexOf('</style>'));
    expect(stylesheet.length).toBeGreaterThan(200);
    expect(html).toContain(stylesheet);
  });

  it.each(OUTCOMES)('offers nothing that grants on the %s page', (outcome) => {
    const html = renderTerminalPage(outcome);
    expect(html).not.toContain('value="agent"');
    expect(html).not.toContain('value="full"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
  });

  it('never tells somebody who just refused to restart the connection they refused', () => {
    const html = renderTerminalPage('refused');
    expect(html).not.toContain('restart');
    expect(html).toContain('No code was issued');
  });

  it('never tells somebody a credential does not exist when one might', () => {
    // The dead-request page is reachable by granting, pressing Back and
    // submitting again — where the request WAS already answered, a live
    // credential exists, and "nothing was granted" would send the person away
    // believing they have nothing to revoke. The page says what it knows, which
    // is that the request is closed.
    const html = renderTerminalPage('expired');
    expect(html).not.toContain('nothing was granted');
    expect(html).toContain('already answered');
  });

  it('never tells a person whose request was started elsewhere that it expired', () => {
    // The cross-device case: an MCP client that opens the system default
    // browser while the person is signed in to another one. "Expired" would
    // send them to redo the thing that just failed.
    const html = renderTerminalPage('unbound');
    expect(html).toContain('another browser');
    expect(html).not.toContain('expired');
    expect(html).not.toContain('timed out');
  });

  it('gives each outcome its own words, so no two arrivals read alike', () => {
    const headings = OUTCOMES.map((o) => renderTerminalPage(o).match(/<h1>([^<]*)<\/h1>/)![1]);
    expect(new Set(headings).size).toBe(OUTCOMES.length);
  });
});

/**
 * The cap and the marker are supplied by each test rather than baked into the
 * function, because what the cap IS and what truncation LOOKS LIKE are still
 * open design questions (V1b). What is settled — and what these rows pin — is
 * that a cap and a visible marker exist at all, and that every one of these
 * characters is gone before anything renders the string.
 *
 * Invisible characters are written as escapes on purpose: a literal U+202E in
 * this file would reverse the source itself in most editors.
 */
const CAP = { cap: 64, marker: '~' };

describe('sanitiseClientName — a stranger chose this string (#554)', () => {
  it.each([
    ['a newline', 'Claude\nCode'],
    ['a carriage return', 'Claude\rCode'],
    ['a C0 control (U+0007)', 'Claude\u0007Code'],
    ['a tab', 'Claude\tCode'],
    ['U+007F delete', 'Claude\u007FCode'],
  ])('turns %s into ordinary space, so the name cannot break out of its line', (_what, raw) => {
    expect(sanitiseClientName(raw, CAP)).toBe('Claude Code');
  });

  it.each([
    ['U+200B zero-width space', '\u200B'],
    ['U+200E left-to-right mark', '\u200E'],
    ['U+FEFF zero-width no-break space', '\uFEFF'],
    // Every row below survived the three hand-written ranges this class
    // replaced, and each one is a member of the class those ranges were an
    // attempt at. `Cla\u00ADude Code` renders pixel-identical to `Claude Code`.
    ['U+061C arabic letter mark, a bidi control outside U+202A-U+202E', '\u061C'],
    ['U+00AD soft hyphen, a format character that renders as nothing', '\u00AD'],
    ['U+2060 word joiner', '\u2060'],
    ['U+E0001 language tag', '\u{E0001}'],
    ['U+E0061 tag latin small letter a', '\u{E0061}'],
  ])('strips %s outright rather than spacing it, so the word stays one word', (_what, ch) => {
    expect(sanitiseClientName(`Clau${ch}de Code`, CAP)).toBe('Claude Code');
  });

  it('strips U+202E, the right-to-left override', () => {
    // The classic display attack: everything after it renders reversed.
    expect(sanitiseClientName('Claude\u202ECode', CAP)).toBe('ClaudeCode');
  });

  it.each([
    ['U+2066 left-to-right isolate', '\u2066'],
    ['U+2067 right-to-left isolate', '\u2067'],
    ['U+2068 first-strong isolate', '\u2068'],
    ['U+2069 pop directional isolate', '\u2069'],
  ])('strips %s — the isolates are separate characters from U+202E', (_what, ch) => {
    // A character class covering only U+202E passes the row above and fails
    // this one. That is why the two are asserted apart.
    expect(sanitiseClientName(`Claude${ch}Code`, CAP)).toBe('ClaudeCode');
  });

  it('collapses a run of spaces and tabs to one space', () => {
    expect(sanitiseClientName('Claude \t  Code', CAP)).toBe('Claude Code');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitiseClientName('  Claude Code \n ', CAP)).toBe('Claude Code');
  });

  it('leaves an ordinary name byte-identical, so the legitimate case pays nothing', () => {
    expect(sanitiseClientName('Claude Code', CAP)).toBe('Claude Code');
  });

  it('leaves a name at the cap byte-identical', () => {
    const atCap = 'A'.repeat(CAP.cap);
    expect(sanitiseClientName(atCap, CAP)).toBe(atCap);
  });

  it('caps an over-length name AT the cap, marker included', () => {
    const out = sanitiseClientName('A'.repeat(200), CAP);
    expect(out.length).toBe(CAP.cap);
    expect(out.endsWith(CAP.marker)).toBe(true);
  });

  it('escapes nothing — escaping is the render step and it has to run last', () => {
    // If this function ever escapes, the order is inverted, and the row below
    // is what that inversion looks like on the page.
    expect(sanitiseClientName('Tom & Jerry <3', CAP)).toBe('Tom & Jerry <3');
  });

  it('cuts the raw string, never a half-written entity', () => {
    // Sanitise and truncate the RAW string; escape last. Escaping first turns
    // `&` into `&amp;`, and a cut through it emits `&am` — a broken entity the
    // browser shows as literal text, out of a string a stranger chose.
    const raw = `${'A'.repeat(18)}&${'B'.repeat(20)}`;
    expect(sanitiseClientName(raw, { cap: 21, marker: '~' })).toBe(`${'A'.repeat(18)}&B~`);
  });

  it('leaves a homoglyph name completely unchanged — and that is the point', () => {
    // `Cl` + Cyrillic \u0430 (U+0430) + `ude Desktop`. Every character in it is
    // legitimate, so nothing here touches it. This sanitiser defeats layout
    // attacks and injection; it does NOT defeat impersonation, and the plan
    // does not claim it does (Decision 1). If somebody "improves" this into a
    // Unicode confusables filter, this row goes red — which is the ceiling
    // being on the record in the code rather than only in a document.
    const homoglyph = 'Cl\u0430ude Desktop';
    expect(sanitiseClientName(homoglyph, CAP)).toBe(homoglyph);
  });
});

/**
 * The cut that decides which part of a destination the page emphasises.
 *
 * Tested as a pure function as well as through the page because the invariant
 * that matters — the three pieces are the original string, in order, with
 * nothing added and nothing lost — is not visible in the rendered markup once
 * the pieces have been escaped and wrapped.
 */
describe('splitDestination (#554)', () => {
  const HOSTILE = [
    'https://claude.ai/api/mcp/auth_callback',
    'http://127.0.0.1:52411/callback',
    'http://[::1]:5000/cb',
    'https://evil.example@evil.example/cb',
    'https://board@evil.example/cb',
    'https://board.evil.example/cb',
    'https://user:pw@host.example:8443/a?b=c#d',
    'https://a@b@evil.example/cb',
    'cursor://anysphere.cursor-retrieval/cb',
    'https://host.example',
    'https://host.example?q=1',
    'https://host.example#f',
    // Mixed case, because a split that "tidies" the host it returns — lower-
    // casing it the way `new URL(...).hostname` does — puts a host on the
    // emphasised line that is not the text of the address printed under it.
    // Every other address here is already lowercase, so nothing else notices.
    'https://board@EVIL.Example/CB',
    'https://ClAuDe.ai/API/mcp',
  ];

  it.each(HOSTILE)('puts %s back together character for character', (uri) => {
    // The page shows the whole address and nothing else. If the pieces do not
    // rejoin into exactly the input, the page is showing a destination that is
    // not the one the code will be sent to — which is worse than the defect
    // this block was written to fix.
    const p = splitDestination(uri)!;
    expect(p.pre + p.host + p.post).toBe(uri);
  });

  it('cuts at the LAST @, so a host that also appears in the userinfo is not the emphasised copy', () => {
    // `https://evil.example@evil.example/cb` contains its host twice. Taking
    // `new URL(uri).hostname` and locating it with `indexOf` lands on the
    // userinfo copy — and emphasising the userinfo is the exact deception this
    // block exists to defeat. Cutting by position cannot make that mistake.
    expect(splitDestination('https://evil.example@evil.example/cb')).toEqual({
      pre: 'https://evil.example@',
      host: 'evil.example',
      post: '/cb',
    });
  });

  it('is not fooled by an @ inside the userinfo', () => {
    expect(splitDestination('https://a@b@evil.example/cb')!.host).toBe('evil.example');
  });

  it.each([
    ['http://127.0.0.1:52411/callback', '127.0.0.1', ':52411/callback'],
    ['http://[::1]:5000/cb', '[::1]', ':5000/cb'],
    ['https://user:pw@host.example:8443/a?b=c#d', 'host.example', ':8443/a?b=c#d'],
  ])('leaves the port on the quiet side of the cut: %s', (uri, host, post) => {
    // A legitimate loopback port changes every run and decides nothing, so it
    // belongs with the rest of the address, not on the emphasised line.
    const p = splitDestination(uri)!;
    expect(p.host).toBe(host);
    expect(p.post).toBe(post);
  });

  it('keeps an IPv6 literal whole rather than cutting it at its own colons', () => {
    expect(splitDestination('http://[::1]/cb')!.host).toBe('[::1]');
  });

  it.each([
    ['a scheme with no authority', 'cursor:cb'],
    ['a bare string', 'not-a-url'],
    ['an empty authority', 'https:///cb'],
  ])('has nothing to emphasise in %s', (_what, uri) => {
    expect(splitDestination(uri)).toBeNull();
  });
});
