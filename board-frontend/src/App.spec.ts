import { describe, expect, it } from 'vitest';
import { TAB_LABEL, type Tab } from './route';
// Vite's `?raw` rather than node:fs — the frontend package carries no node types.
import SOURCE from './App.tsx?raw';
import SIDE_ACCOUNT from './SideAccount.tsx?raw';
import { ISSUES_URL } from './SideAccount';
// A stylesheet is the one thing `?raw` cannot fetch here. vitest runs with its
// default `css: false`, which stubs every CSS module to the empty string —
// `?raw`, `?url` and import.meta.glob all hand back '' (measured, not assumed),
// and a guard reading '' would pass while proving nothing. node:fs is the only
// route to the bytes, and the package carries no node types, hence this:
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readFileSync } from 'node:fs';

// #523: every page App can render has to sit inside an <ErrorBoundary>, so a
// malformed 200 degrades to the boundary instead of white-screening the shell —
// the nav, the theme switch and the way to another page all survive.
//
// This reads App.tsx as text rather than rendering it. That is a deliberate
// limit of the test env, not a preference: vitest.config.ts runs `environment:
// 'node'` with no DOM, so the repo's only render path is renderToStaticMarkup —
// and React's server renderer does not run getDerivedStateFromError, so a throw
// there escapes the boundary instead of being caught. Proving the boundary
// behaves would need a DOM environment (a new dev dependency and a config
// change), so what is guarded here is the structure — the rule that no content
// branch goes unwrapped. React's own semantics do the rest.

/**
 * The whole `{tab === '<tab>' && …}` JSX expression App renders for one tab,
 * from its opening brace to the matching close.
 */
function branchFor(tab: string): string | null {
  const start = SOURCE.indexOf(`{tab === '${tab}'`);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  return null;
}

/** The name of the first element the branch renders, once its conditions pass. */
function firstElement(branch: string): string | null {
  const m = branch.match(/<([A-Za-z][\w.]*)/);
  return m ? m[1] : null;
}

const TABS = Object.keys(TAB_LABEL) as Tab[];

describe('App content branches (#523)', () => {
  it('has a render branch for every tab', () => {
    // Guards the sweep below: a tab with no branch would otherwise pass silently.
    expect(TABS.filter((t) => branchFor(t) === null)).toEqual([]);
  });

  it('can tell a missing branch from a present one', () => {
    // Keeps the two tests above honest — a reader that found nothing anywhere
    // would let both pass while proving nothing.
    expect(branchFor('no-such-tab')).toBeNull();
    expect(branchFor('repos')).toContain('<ReposPage />');
  });

  it('wraps every page in an error boundary, so none can white-screen the shell', () => {
    // The rule holder. A page added to Tab without a boundary lands in this list.
    const unwrapped = TABS.filter((t) => firstElement(branchFor(t) ?? '') !== 'ErrorBoundary');
    expect(unwrapped).toEqual([]);
  });

  it('gives every page boundary something to draw when it catches (#824 follow-up)', () => {
    // The boundary's own default is `null`, so a caught throw drew the shell
    // with an empty body and no message: indistinguishable from a board with
    // nothing on it, with no tell and nothing to press. The top bar keeps the
    // default deliberately and is not a tab, so it is not in this sweep.
    const missing = TABS.filter((t) => !(branchFor(t) ?? '').includes('fallback={PAGE_FALLBACK}'));
    expect(missing).toEqual([]);
    expect(SOURCE).toContain("import { ErrorBoundary, PAGE_FALLBACK } from './ErrorBoundary';");
  });

  it('wraps Your work and Unit — the two pages #523 found unprotected', () => {
    // Named on purpose: these were the two most-opened pages and the only two
    // that took the whole app down with them.
    expect(firstElement(branchFor('dashboard') ?? '')).toBe('ErrorBoundary');
    expect(firstElement(branchFor('team') ?? '')).toBe('ErrorBoundary');
  });
});

// The sheet's breakpoint (#608). 900px is written twice — as `SHEET_QUERY` in
// App.tsx and as the media query in app.css — because a media query cannot read
// a JS constant. The pair is not decoration: App renders the scrim, and NOTHING
// styles `.side-scrim` outside that query, so a scrim rendered at a width the
// query does not cover is an unstyled button in the shell's grid, taking the
// sidebar's 248px column and pushing the page onto a second row. Holding the two
// numbers together is what keeps that state impossible.

const CSS: string = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
/** app.css without its comments, so prose about braces cannot be read as one. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The condition of the `@media` block whose body styles `selector` — null if
 *  the selector is styled outside every media block, or not at all. */
function mediaBlockFor(selector: string): string | null {
  const heads = /@media ([^{]+)\{/g;
  for (let head = heads.exec(RULES); head; head = heads.exec(RULES)) {
    const open = head.index + head[0].length - 1;
    let depth = 0;
    for (let i = open; i < RULES.length; i += 1) {
      if (RULES[i] === '{') depth += 1;
      else if (RULES[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          if (RULES.slice(open, i).includes(selector)) return head[1].trim();
          break;
        }
      }
    }
  }
  return null;
}

/** The query App.tsx declares, read from its source for the same reason the
 *  branches above are: importing App.tsx pulls in the whole app. */
function declaredQuery(): string | null {
  const m = SOURCE.match(/const SHEET_QUERY = '([^']+)'/);
  return m ? m[1] : null;
}

describe("the sheet's breakpoint (#608)", () => {
  it('is reading app.css, not an empty string', () => {
    // What keeps the rest of this block honest. Every assertion below compares
    // two things that are both absent from '', so on an empty read they would
    // agree about nothing — and an earlier spec in this lane did exactly that.
    expect(CSS.length).toBeGreaterThan(1000);
    expect(CSS).toContain('.side-scrim {');
  });

  it('can tell a rule inside a media block from one outside it', () => {
    // The reader itself: one that found a block for everything, or for nothing,
    // would let the rule holder pass while proving nothing.
    expect(mediaBlockFor('.side-logo-mark')).toBeNull();
    expect(mediaBlockFor('.no-such-selector')).toBeNull();
    expect(mediaBlockFor('.side-open')).not.toBeNull();
  });

  it('declares the query in App.tsx', () => {
    expect(declaredQuery()).not.toBeNull();
  });

  it('renders the scrim only at widths where app.css styles it', () => {
    // The rule holder. Move the number in either file alone and this goes red —
    // and because it reads the block the scrim actually sits in, the OTHER
    // 900px query in app.css cannot stand in for it.
    const styled = mediaBlockFor('.side-scrim');
    expect(styled).not.toBeNull(); // two nulls would satisfy the line below
    expect(styled).toBe(declaredQuery());
  });
});

/**
 * The gate the whole cache stands behind (#824, narrowed by #892, opened by
 * #1229).
 *
 * The gate used to be written the other way round — every kind that was not
 * `ready` or `expired` drew the sign-in screen — and `loading` fell into it
 * because it is not one of those two, not because a full screen was the right
 * size for it. #1229 measured the cost: one round trip on every route with no
 * nav, no page name and nothing to press, shell depth 1.0, on a board that in
 * most cases was about to draw perfectly well.
 *
 * So the gate NAMES the three it refuses now, and each of them is an ANSWER:
 * nobody, not you, or the question could not be put. `loading` is the question
 * still in the air, and it falls through to a drawn shell with the route's own
 * skeleton in it (`ui/ProbeShell.tsx`). `remembered` — #824's third state,
 * which drew FIGURES off the disk while the probe was in flight — is a
 * different thing again and stays removed: #892 took it out because a saved
 * payload names the person this device last belonged to, and that argument is
 * untouched by drawing furniture.
 *
 * Nothing in this suite can render App (the note at the
 * top of this file), so the gate is pinned as text the way its content branches
 * are.
 */
describe('who the board draws for before the probe answers (#824, #1229)', () => {
  const GATE = /if \(session\.kind === 'login' \|\| session\.kind === 'forbidden' \|\| session\.kind === 'error'\) \{\s*return <AuthScreen view=\{session\} \/>;/;

  it('sends exactly three answers to the full screen, and nothing else', () => {
    expect(SOURCE).toMatch(GATE);
    const gate = SOURCE.match(GATE)?.[0] ?? '';
    expect(gate).not.toBe('');
    // Named rather than excluded, so a kind added to `SessionView` later does
    // not join this list by default. `loading` and `remembered` are the two
    // that must NOT be in it: the first draws the shell now, and the second
    // does not exist.
    for (const refused of ['loading', 'remembered']) {
      expect(gate).not.toContain(`'${refused}'`);
    }
  });

  it('draws the shell, not a spinner, while the probe is in flight', () => {
    // The state that used to be a full screen. `probing` is what every
    // person-specific branch below asks, and `me` is null for exactly as long
    // as it is true.
    expect(SOURCE).toContain("const probing = session.kind === 'loading';");
    expect(SOURCE).toContain("const me = session.kind === 'loading' ? null : session.me;");
    // A hinted warm open draws saved labels with disabled controls (#1309).
    // Without a saved shell, the rail keeps its shapes until the probe answers.
    expect(SOURCE).toContain("const preview = session.kind === 'loading' && session.hint === true;");
    expect(SOURCE).toContain('const shell = me ?? (preview ? openingShell : undefined);');
    expect(SOURCE).toContain('{!me && !preview ? <RouteSkeleton route={route} /> :');
    expect(SOURCE).toContain('{!shell ? <OrgSwitcherShape /> : shell.github && (');
    expect(SOURCE).toMatch(/<GithubConnection\s+github=\{shell\.github\}\s+disabled=\{probing\}/);
    expect(SOURCE).not.toContain('me!.');
    expect(SOURCE).toContain('{probing ? openingShell && preview ? <SideAccount preview={openingShell} /> : <AccountShape /> : <SideAccount />}');
    expect(SOURCE).toContain('{probing ? <SyncShape /> : <SyncStamp />}');
  });

  it('asks nothing of the network on the probe’s behalf', () => {
    // The two providers that read on mount. Held until the probe has answered,
    // so the shell going up early adds no request ahead of it — issuing a
    // route's read beside the probe is step 1b and has its own transport rule.
    expect(SOURCE).toContain('<PeopleProvider enabled={!probing}');
    expect(SOURCE).toContain('<SyncProvider enabled={!probing}>');
  });

  it('remounts the whole tree when the probe names somebody else', () => {
    // `claimFor` has already wiped the disk by then. This is what makes the
    // TREE wiped too, so the new person meets skeletons and their own reads
    // rather than the last person's figures still on screen. The rule itself
    // lives in `auth/identity-generation.ts` and is driven as a sequence in its
    // own spec; what is pinned here is that `App` mounts under it, and under
    // nothing else. A key spelled from the address would turn over on the
    // probe's FIRST answer, which remounts `TopBar` and throws away whatever
    // the reader had typed into the search box (#1233).
    expect(SOURCE).toContain('key={peopleGeneration}>');
    expect(SOURCE).toContain("const peopleGeneration = useIdentityGeneration(who ? who.email + ':' + (who.sessionHintId ?? '') : null);");
    expect(SOURCE).not.toMatch(/key=\{me\b/);
  });

  /**
   * And NOT when the same person's access check reports something different
   * (#1395). That key moved on every eight-hour Github token refresh, so the
   * tree was thrown away and every page effect re-ran for an event the rule was
   * never about — measured at twice the reads on every open, the slow queue read
   * included. `claimFor` answers a genuinely moved key against the disk.
   */
  it('does not remount when the access check moves under the same person', () => {
    expect(SOURCE).not.toContain('visibilityKey ?? \'\') : null');
    expect(SOURCE).not.toMatch(/useIdentityGeneration\([^)]*visibilityKey/);
  });

  /**
   * The content column carries NO key of its own (#1395). It was keyed on the
   * preview state, so the identity answer — the one event that ends the preview
   * — remounted the subtree and re-ran every page effect, sending each of the
   * tab's reads twice per open.
   */
  it('does not key the content column on the preview state', () => {
    expect(SOURCE).toContain('<div data-board-content inert={preview}>');
    // The element itself, not the file: the comment above it quotes the key it
    // replaced, which is how a reader learns why there is none.
    expect(SOURCE).not.toMatch(/data-board-content[^>]*\bkey=/);
  });
});


/**
 * Who starts the opening queue read, and when nobody may (#1409).
 *
 * The count this protects is measured in a browser by
 * `scripts/check-opening-reads.mjs`, because what went wrong is an effect order
 * deciding what goes on the wire and no effect fires in this suite. What is
 * pinned here is the shape that makes the order stop
 * mattering: ONE flag for "already started", a second for "the probe has
 * answered", and a taker that starts the read itself rather than giving up.
 */
describe('the opening queue read is started once, by whoever asks first (#1409)', () => {
  it('lets the taker start the read instead of going without one', () => {
    expect(SOURCE).toContain('const held = openingMine.current ?? startOpeningMine(org, timeZone);');
  });

  it('starts it at most once per document, and never after the probe answered', () => {
    expect(SOURCE).toContain('if (openingStarted.current || probeAnswered.current) return null;');
    expect(SOURCE).toContain('openingStarted.current = true;');
    expect(SOURCE).toContain('probeAnswered.current = true;');
  });

  it('keeps the read fenced by the identity probe and the replay guard (#1098)', () => {
    expect(SOURCE).toContain('const read = fetchMyIssues(org, fetchMe(), timeZone);');
    expect(SOURCE).toContain('if (held.generation !== currentPayloadGeneration() || responseExpired(value)) {');
  });

  it('asks for the answer the receiving page keys its own cache on', () => {
    // The page stores the queue under `dayQuery(org, timeZone)`, so a read sent
    // under this component's own reading of the preference can land on a key
    // nothing on that page looks at.
    expect(SOURCE).toContain('if (!held || held.org !== org || held.timeZone !== timeZone) return undefined;');
  });
});

describe('access checks are user initiated (#1278)', () => {
  const effect = SOURCE.slice(SOURCE.indexOf('let alive = true;'), SOURCE.indexOf('// The session died'));

  it('keeps the opening identity request and mount cache protection', () => {
    expect(effect).toContain('const identity = fetchMe();');
    expect(effect).toContain('void probe(true);');
    expect(effect).toContain('forgetSensitivePayloads({ preserveLiveMine: true });');
    expect(effect).toContain('resetSessionExpiry();');
  });

  it('has no renewal, deadline, retry timer or focus probe', () => {
    expect(effect).not.toMatch(/setTimeout|setInterval|visibilitychange|focus|expiresAt/);
    expect(SOURCE).not.toContain('RECHECK_RETRY_MS');
    expect(effect).toContain("window.addEventListener('board-github-changed', onGithubAction)");
    // #1395's recovery is a probe and nothing else: a read that came back under
    // access the app has not installed asks for the identity to be re-read, and
    // the reader keeps what is on their screen until a live read settles it.
    expect(effect).toContain('window.addEventListener(IDENTITY_RECHECK_EVENT, onIdentityStale)');
    const recheck = effect.slice(effect.indexOf('const onIdentityStale'));
    expect(recheck.slice(0, recheck.indexOf('};'))).not.toContain('forgetSensitivePayloads');
  });

  it('does not mount a recheck takeover or topbar status', () => {
    expect(SOURCE).not.toContain('AccessRecheckNotice');
    expect(SOURCE).not.toContain('rechecking=');
    expect(SOURCE).not.toContain('hidden={recheckFailed}');
    expect(SOURCE).toContain('data-board-content inert={preview}');
  });

  it('keeps identity changes and real refusals authoritative', () => {
    expect(SOURCE).toContain("useIdentityGeneration(who ? who.email + ':' + (who.sessionHintId ?? '') : null)");
    expect(effect).toContain("if (mapped.kind === 'login' || mapped.kind === 'forbidden') { setSession(mapped); return; }");
    expect(effect).toContain('if (!mounted) setSession(mapped);');
    expect(effect).toContain('dispatchEvent(new Event(ACCESS_VERIFIED_EVENT))');
    // And only for a RE-check (#1395). On the opening probe this event put the
    // Repos map and an open board back to loading placeholders and made each of
    // them read twice, which is what `useAccessEpoch` exists to be read by.
    expect(effect).toContain('if (!opening) window.dispatchEvent(new Event(ACCESS_VERIFIED_EVENT));');
  });
});

/**
 * What the mount gate's error state is allowed to mean (#1061).
 *
 * `AuthScreen`'s `error` copy is "the board couldn't verify your session", and
 * for as long as the only thing that reached it was a 5xx or a dropped
 * connection that was true. `apiFetch`'s own 409 reached it too, and a 409
 * there sits on top of a request that answered 200 — so a first load in a fresh
 * browser drew a verification failure over a page with nothing wrong with it.
 *
 * Nothing in this suite can render App or run an effect, so
 * the branch is pinned as text the way the gate above it is. What it proves is
 * that a withdrawal is consulted BEFORE the line that moves the session, which
 * is the whole of the ordering that was wrong.
 */
describe('a withdrawn probe does not reach the gate (#1061)', () => {
  it('asks a withdrawal again instead of drawing a session it could not verify', () => {
    expect(SOURCE).toContain(
      'if (withdrawnRead(e) && reasked < WITHDRAWN_REASKS) { reasked += 1; void probe(); return; }',
    );
  });

  it('checks it before the only line that can put the gate up', () => {
    // `if (!mounted) setSession(mapped)` is that line, and an order the other
    // way round is the defect with the branch added on top of it.
    const withdrawn = SOURCE.indexOf('if (withdrawnRead(e)');
    const gate = SOURCE.indexOf('if (!mounted) setSession(mapped);');
    expect(withdrawn).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(withdrawn).toBeLessThan(gate);
  });

  it('bounds how many times it will ask, so a repeating fault still reaches the gate', () => {
    // #1004's reading: a board that says "Loading…" for ever is worse than one
    // that says what is wrong and offers a press.
    expect(SOURCE).toMatch(/const WITHDRAWN_REASKS = \d+;/);
    expect(SOURCE).toContain('reasked = 0;');
  });
});

describe('the account menu sends reports to the public repo (#1450)', () => {
  it('opens its issues in a new tab, from the one constant', () => {
    expect(ISSUES_URL).toBe('https://github.com/asabirov/github-board/issues');
    expect(SIDE_ACCOUNT).toContain('<a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">Report an issue</a>');
    // No form is left to open: the item is a link, not a panel section.
    expect(SIDE_ACCOUNT).not.toMatch(/openPanel\(\{[^}]*'feedback'/);
  });
});
