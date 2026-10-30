import { describe, expect, it } from 'vitest';
import { REASSURING_WORDS } from '../reassuring-words';
import type { OwnerWritability, RepoCi, RepoHealth, RepoOwner, RepoRow, RepoSecurity, ReposView } from '../api/repos';
import {
  buildTiles,
  countTone,
  DEFAULT_ORDER,
  healthByRepo,
  NO_HEALTH,
  NO_MATCH_BODY,
  tilesReady,
  deltaHint,
  deltaLabel,
  flowLegend,
  queueMove,
  queueMoveSpoken,
  queueShare,
  flowTitle,
  matchesQuery,
  nameHint,
  noMatchTitle,
  openHint,
  orderAria,
  orderByKey,
  ORDERS,
  orderTrigger,
  NO_OWNER_FIELD,
  NO_OWNER_FIELD_HINT,
  ownerAria,
  ownerControlOffered,
  ownerHint,
  ownerName,
  ownerRestHint,
  ownerShortName,
  ownerOptions,
  SET_OWNER,
  ownerSlotFor,
  ownerSlotHint,
  ownerSlots,
  pushAge,
  repoFlow,
  repoRef,
  SEARCH_KEY_HINT,
  securityLevel, healthMatch, healthFilterNotice,
  spell,
  tileLabel,
  tileWord,
  visibleTiles,
  weekHint,
} from './repos-vm';

/**
 * Every state `OwnerWritability` has, as values a test can loop over.
 *
 * Written as the KEYS of a `satisfies Record<OwnerWritability, …>` rather than
 * as a plain array, because that is the only shape TypeScript checks for
 * completeness: a sixth state added to the union turns this file red instead of
 * quietly leaving the new one untested and unswept.
 */
const WRITABILITIES = Object.keys({
  'not-applicable': true,
  writable: true,
  restricted: true,
  absent: true,
  unreadable: true,
  unknown: true,
} satisfies Record<OwnerWritability, true>) as OwnerWritability[];

/** The same list plus the case a board-api too old to answer produces. */
const WRITABILITIES_AND_MISSING: (OwnerWritability | undefined)[] = [...WRITABILITIES, undefined];

/** `weeks([[2, 4], [1, 3]])` — a compact [opened, closed] list, padded to the
 *  full 10-week window with zero weeks. */
function weeks(pairs: [number, number][]): RepoRow['weeks'] {
  const out = pairs.map(([opened, closed]) => ({ opened, closed }));
  while (out.length < 10) out.push({ opened: 0, closed: 0 });
  return out;
}

const NO_SECURITY: RepoSecurity = { depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null };

function repo(over: Partial<RepoRow> & { name: string }): RepoRow {
  return {
    full: `acme/${over.name}`,
    key: over.name,
    htmlUrl: `https://github.com/acme/${over.name}`,
    description: null,
    weeks: weeks([]),
    open: 0,
    owner: null,
    language: null,
    pushedAt: null,
    ...over,
  };
}

/** One repo's health as the second read reports it (#571) — clean unless the
 *  test says otherwise, which is what the server sends for most of this org. */
function health(over: Partial<RepoHealth> = {}): RepoHealth {
  return { security: NO_SECURITY, ci: null, ciUrl: null, ...over };
}

/** The whole map's health, settled: every row given the health beside it. */
function settled(pairs: [RepoRow, RepoHealth][]): ReadonlyMap<string, RepoHealth> {
  return healthByRepo({ repos: pairs.map(([row, h]) => ({ full: row.full, ...h })) });
}

function view(repos: RepoRow[]): ReposView {
  return { updatedAt: '2026-08-04T09:00:00.000Z', repos, driOptions: [] };
}

const BUSY = repo({
  name: 'acme',
  open: 70,
  owner: { login: 'octocat', name: 'Octocat' },
});
const STEADY = repo({ name: 'board', key: 'board', open: 19 });
const CLEAR = repo({ name: 'roadmap', open: 0, weeks: weeks([[1, 1]]) });
const DORMANT = repo({ name: 'status', open: 0 });

describe('securityLevel', () => {
  it('is clean when every count is zero', () => {
    expect(securityLevel(NO_SECURITY)).toBe('clean');
  });

  it('is low for a non-zero count under the high threshold', () => {
    expect(securityLevel({ depHigh: 1, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null })).toBe('low');
    expect(securityLevel({ depHigh: 0, depModerate: 3, codeScanning: 0, secrets: 0, secretsUrl: null })).toBe('low');
    expect(securityLevel({ depHigh: 0, depModerate: 0, codeScanning: 4, secrets: 0, secretsUrl: null })).toBe('low');
  });

  it('is high once depHigh or codeScanning reaches 5', () => {
    expect(securityLevel({ depHigh: 5, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null })).toBe('high');
    expect(securityLevel({ depHigh: 0, depModerate: 0, codeScanning: 5, secrets: 0, secretsUrl: null })).toBe('high');
  });

  it('a leaked secret is exposed on its own', () => {
    expect(securityLevel({ depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 1, secretsUrl: null })).toBe('exposed');
  });

  it('a leaked secret outranks everything, even a repo that is otherwise spotless', () => {
    // Otherwise-clean repo (no dependency or code-scanning alerts at all) that
    // leaked exactly one secret must still read as exposed, not clean.
    expect(securityLevel({ depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 1, secretsUrl: null })).toBe('exposed');
    // And a secret outranks even a high-severity posture on the same repo.
    expect(securityLevel({ depHigh: 9, depModerate: 9, codeScanning: 9, secrets: 1, secretsUrl: null })).toBe('exposed');
  });

  it('gives a read that FAILED its own level, which is not clean (#718)', () => {
    // The four counts are zeros nobody measured. `clean` is a measurement — the
    // server counted and found none — and the two must not collapse into one
    // level, or the order below files an unread org among the spotless.
    const unread = { ...NO_SECURITY, state: 'unreadable' as const };
    expect(securityLevel(unread)).toBe('unread');
    expect(securityLevel({ ...NO_SECURITY, state: 'read' as const })).toBe('clean');
    // Absent — a board-api too old to say — reads as `clean`, which is what
    // this page has always drawn for it (`RepoSecurity.state` in api.ts).
    expect(securityLevel(NO_SECURITY)).toBe('clean');
  });

  it('gives a COUNTED alert its measured level, whatever the state says (#718)', () => {
    // `unreadable` means ANY ONE of the org's three alert lists refused, and the
    // state is stamped onto a real row — so a counted credential beside it is an
    // ordinary payload: secret scanning answered, Dependabot did not. The
    // measurement wins, or the surface draws a live leak in its quietest ink.
    const unread = { ...NO_SECURITY, state: 'unreadable' as const };
    expect(securityLevel({ ...unread, secrets: 3, secretsUrl: 'https://x' })).toBe('exposed');
    expect(securityLevel({ ...unread, depHigh: 6 })).toBe('high');
    expect(securityLevel({ ...unread, codeScanning: 9 })).toBe('high');
    expect(securityLevel({ ...unread, depModerate: 1 })).toBe('low');
    // Only an all-zero unreadable read has nothing measured to report.
    expect(securityLevel(unread)).toBe('unread');
  });
});

describe('matchesQuery', () => {
  const row = repo({ name: 'board', description: 'The internal ops board' });

  it('matches on the name, case-insensitively', () => {
    expect(matchesQuery(row, 'BOARD')).toBe(true);
  });

  it('matches on the description, case-insensitively', () => {
    expect(matchesQuery(row, 'OPS BOARD')).toBe(true);
  });

  it('an empty (or blank) query matches everything', () => {
    expect(matchesQuery(row, '')).toBe(true);
    expect(matchesQuery(row, '   ')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(matchesQuery(row, 'roadmap')).toBe(false);
  });

  it('does not throw on a repo with no description', () => {
    expect(matchesQuery(repo({ name: 'acme', description: null }), 'ops')).toBe(false);
  });
});

describe('buildTiles', () => {
  it('sorts by open count descending, then by name', () => {
    const tiles = buildTiles(view([DORMANT, STEADY, BUSY, CLEAR]));
    expect(tiles.map((t) => t.row.name)).toEqual(['acme', 'board', 'roadmap', 'status']);
  });

  it('breaks a tie in open count alphabetically', () => {
    const a = repo({ name: 'zeta', open: 5 });
    const b = repo({ name: 'alpha', open: 5 });
    expect(buildTiles(view([a, b])).map((t) => t.row.name)).toEqual(['alpha', 'zeta']);
  });

  it('puts no standing on a tile — the row and its health, and nothing derived (#607)', () => {
    // A tile carried a `behind` boolean until #607, and the warning left edge
    // was its only reader. Both went: what a queue is doing is the sparkline's
    // to draw, on every tile, from the weeks already on the row.
    const tiles = buildTiles(view([BUSY, STEADY, CLEAR, DORMANT]));
    for (const tile of tiles) expect(Object.keys(tile).sort()).toEqual(['health', 'row']);
  });
});

// ── the owner row (#583) ─────────────────────────────────────────────────────
// The four struck-out chips are gone and the owners took their place, so these
// assert on the org's own shape: three people and the repos nobody owns.

const IVAN: RepoOwner = { login: 'IvanRoslov', name: 'Ivan Roslov' };
const ARTUR: RepoOwner = { login: 'octocat', name: 'Octocat' };
const ANTON: RepoOwner = { login: 'anton-khovanskiy', name: 'Anton Khovanskiy' };

/** The live org in miniature: Ivan owns the most, then Octocat, then Anton, and
 *  some repos nobody owns (measured 47 / 17 / 4 / 10 across 78). */
const OWNED = [
  repo({ name: 'i-one', owner: IVAN }),
  repo({ name: 'i-two', owner: IVAN }),
  repo({ name: 'i-three', owner: IVAN }),
  repo({ name: 'a-one', owner: ARTUR }),
  repo({ name: 'a-two', owner: ARTUR }),
  repo({ name: 'k-one', owner: ANTON }),
  repo({ name: 'nobody-one' }),
  repo({ name: 'nobody-two' }),
];

describe('ownerSlots', () => {
  const slots = ownerSlots(buildTiles(view(OWNED)));

  it('gives every owner the map records a slot, and the repos nobody owns one more', () => {
    expect(slots.map((s) => s.login)).toEqual(['IvanRoslov', 'octocat', 'anton-khovanskiy', null]);
  });

  it('counts the repos behind each slot', () => {
    expect(slots.map((s) => s.count)).toEqual([3, 2, 1, 2]);
  });

  it('adds up to the whole map, so no repo falls between the slots', () => {
    expect(slots.reduce((sum, s) => sum + s.count, 0)).toBe(OWNED.length);
  });

  it('reads the owners off the rows, never off the schema’s allowed values', () => {
    // `driOptions` is what a repo MAY be given; a person who owns nothing today
    // is a face narrowing to an empty map. The row is right when the org changes
    // because it is derived from the org.
    const one = ownerSlots(buildTiles(view([repo({ name: 'solo', owner: ARTUR })])));
    expect(one.map((s) => s.login)).toEqual(['octocat']);
  });

  it('leaves the nobody slot out where every repo has an owner', () => {
    // Asymmetry is fine: a slot standing for no repos is filler.
    const all = ownerSlots(buildTiles(view([repo({ name: 'solo', owner: ARTUR })])));
    expect(all.some((s) => s.login === null)).toBe(false);
  });

  it('names each person in full, and a login that resolves to nobody by its handle', () => {
    expect(slots.map((s) => s.name)).toEqual(['Ivan Roslov', 'Octocat', 'Anton Khovanskiy', 'No owner']);
    const bot = ownerSlots(buildTiles(view([repo({ name: 'x', owner: { login: 'board-bot', name: null } })])));
    expect(bot[0].name).toBe('board-bot');
  });

  it('breaks a tie in repo count alphabetically, so the row does not shuffle between loads', () => {
    const tied = ownerSlots(
      buildTiles(view([repo({ name: 'one', owner: IVAN }), repo({ name: 'two', owner: ARTUR })])),
    );
    expect(tied.map((s) => s.name)).toEqual(['Ivan Roslov', 'Octocat']);
  });
});

describe('ownerSlotFor', () => {
  const slots = ownerSlots(buildTiles(view(OWNED)));

  it('finds the person a login names', () => {
    expect(ownerSlotFor(slots, 'octocat')?.name).toBe('Octocat');
  });

  it('finds the repos nobody owns', () => {
    expect(ownerSlotFor(slots, null)?.count).toBe(2);
  });

  it('narrows nothing where nothing was chosen', () => {
    expect(ownerSlotFor(slots, undefined)).toBeNull();
  });

  it('narrows nothing for an owner the map has no repos for, rather than emptying it', () => {
    // A link written when somebody still owned a repo, or a typo. The same rule
    // the reading order keeps: an unknown key reads as the map at rest.
    expect(ownerSlotFor(slots, 'someone-else')).toBeNull();
  });
});

describe('what an owner slot says', () => {
  const slots = ownerSlots(buildTiles(view(OWNED)));
  const slotFor = (login: string | null) => slots.find((s) => s.login === login)!;

  it('says whose face it is and how many repos are behind it — a face says neither', () => {
    expect(ownerSlotHint(slotFor('IvanRoslov'))).toBe('Ivan Roslov owns 3 repos');
  });

  it('keeps the struck-out chip’s own words for the repos nobody owns', () => {
    expect(ownerSlotHint(slotFor(null))).toBe('2 repos with nobody recorded as owner');
  });

  it('agrees with itself at one', () => {
    const one = ownerSlots(buildTiles(view([repo({ name: 'solo', owner: ANTON }), repo({ name: 'bare' })])));
    expect(ownerSlotHint(one.find((s) => s.login === 'anton-khovanskiy')!)).toBe('Anton Khovanskiy owns 1 repo');
    expect(ownerSlotHint(one.find((s) => s.login === null)!)).toBe('1 repo with nobody recorded as owner');
  });
});

describe('spell (read by the sparkline’s accessible name)', () => {
  it('spells small counts and falls back to digits past ten', () => {
    expect(spell(0)).toBe('no');
    expect(spell(3)).toBe('three');
    expect(spell(10)).toBe('ten');
    expect(spell(11)).toBe('11');
  });
});

// ── what the map itself reads off the model (#558, Task 6) ──────────────────
// Everything the page prints comes from here, so each of these is asserted on
// the value rather than on the rendered page.

describe('visibleTiles', () => {
  const tiles = buildTiles(view([BUSY, STEADY, CLEAR, DORMANT]));
  const owned = buildTiles(view(OWNED));
  const slotFor = (login: string | null) => ownerSlotFor(ownerSlots(owned), login);

  it('with no owner chosen and no query, shows the whole map in its reading order', () => {
    expect(visibleTiles(tiles, null, '').map((t) => t.row.name)).toEqual([
      'acme',
      'board',
      'roadmap',
      'status',
    ]);
  });

  it('narrows to the chosen owner', () => {
    expect(visibleTiles(owned, slotFor('octocat'), '').map((t) => t.row.name)).toEqual(['a-one', 'a-two']);
  });

  it('narrows to the repos nobody owns, which is why the No owner chip could go', () => {
    // #583's Definition of Done: the repos with no owner stay reachable.
    expect(visibleTiles(owned, slotFor(null), '').map((t) => t.row.name)).toEqual(['nobody-one', 'nobody-two']);
  });

  it('narrows on the name', () => {
    expect(visibleTiles(tiles, null, 'road').map((t) => t.row.name)).toEqual(['roadmap']);
  });

  it('narrows on the description too', () => {
    const described = buildTiles(view([repo({ name: 'acme-ui', description: 'shared design-system library' }), STEADY]));
    expect(visibleTiles(described, null, 'design-system').map((t) => t.row.name)).toEqual(['acme-ui']);
  });

  it('applies the chosen owner and the query together, neither replacing the other', () => {
    // Both narrowings hold at once: what is left satisfies both.
    expect(visibleTiles(owned, slotFor('IvanRoslov'), 'one').map((t) => t.row.name)).toEqual(['i-one']);
    expect(visibleTiles(owned, slotFor('octocat'), 'i-')).toEqual([]);
  });
});

describe('an owner’s count', () => {
  it('counts over the whole map, not over what the query left standing', () => {
    // The face answers "how many does this person own", so typing into the
    // field must not move the number the hint states.
    const slots = ownerSlots(buildTiles(view(OWNED)));
    expect(ownerSlotFor(slots, 'IvanRoslov')?.count).toBe(3);
    expect(ownerSlotHint(ownerSlotFor(slots, 'IvanRoslov')!)).toContain('3 repos');
  });

  it('agrees with the tiles left standing when it is the only thing narrowing', () => {
    // The number in the hint and the number of tiles on screen answer the same
    // question the moment nothing else is narrowing, and must not differ.
    const tiles = buildTiles(view(OWNED));
    for (const slot of ownerSlots(tiles)) {
      expect(visibleTiles(tiles, slot, '')).toHaveLength(slot.count);
    }
  });
});

/** The word a settled health draws, or null — the shape these specs asserted
 *  before the page read its health separately (#571). The third answer,
 *  `unsettled`, has its own section below; nothing here can reach it, because
 *  every subject here is a health that has landed. */
function drawnWord(h: RepoHealth) {
  const slot = tileWord(h);
  return slot.state === 'word' ? slot : null;
}

describe('the drawn word’s hint (#573)', () => {
  it('says what produced the word rather than repeating the word on the tile', () => {
    // The tile already prints "Leaked secret". A hint that answered with
    // "Security: Leaked secret" would spend a hover saying it again.
    const word = drawnWord(health({ security: { ...NO_SECURITY, secrets: 1, secretsUrl: null } }))!;
    expect(word.hint).toBe('GitHub secret scanning found a credential in this repo');
    expect(word.hint).not.toBe(word.text);
  });

  it('names WHICH run a CI conclusion belongs to, keeping the conclusion’s own word', () => {
    expect(drawnWord(health({ ci: 'failure' }))!.hint).toBe('Latest completed Actions run: Failing');
    expect(drawnWord(health({ ci: 'action_required' }))!.hint).toBe(
      'Latest completed Actions run: Action required',
    );
  });

  it('writes down no word for a condition the tile cannot draw', () => {
    // Three rounds of fixes went into words for security levels and CI
    // conclusions nothing on the page reaches — 3 of 4 security hints, 3 of 4
    // security words and 6 of 8 CI words were unreachable, and their specs read
    // as coverage of shipped behaviour. Whatever a repo is, it gets one of these
    // four words or none, and the four are the only ones written anywhere.
    const drawn = new Set<string>();
    const conclusions: RepoCi[] = [
      'failure', 'timed_out', 'action_required', 'success', 'cancelled', 'neutral', 'skipped', 'stale', null,
    ];
    for (const ci of conclusions) {
      for (const security of [NO_SECURITY, { ...NO_SECURITY, depHigh: 9 }, { ...NO_SECURITY, codeScanning: 9 }, { ...NO_SECURITY, secrets: 1, secretsUrl: null }]) {
        const word = drawnWord(health({ ci, security }));
        if (word) drawn.add(`${word.text} :: ${word.hint}`);
      }
    }
    expect([...drawn].sort()).toEqual([
      'CI failing :: Latest completed Actions run: Failing',
      'CI needs action :: Latest completed Actions run: Action required',
      'CI timed out :: Latest completed Actions run: Timed out',
      'Leaked secret :: GitHub secret scanning found a credential in this repo',
    ]);
  });
});

/** Every conclusion `RepoCi` can hold, so a walk over it is a walk over all of
 *  them rather than over the three somebody remembered. */
const ALL_CONCLUSIONS: RepoCi[] = [
  'failure', 'timed_out', 'action_required',
  'success', 'cancelled', 'neutral', 'skipped', 'stale', null,
];

/** The three that mean somebody has to do something. `cancelled` and `skipped`
 *  are choices rather than faults, and `null` is a repo no run has ever
 *  finished on. */
const NEEDS_ATTENTION: RepoCi[] = ['failure', 'timed_out', 'action_required'];

describe('the CI conclusions the tile speaks up about (#583)', () => {
  // The CI failing chip is struck out, and its predicate went with it. The rule
  // it shared with the tile's word is what mattered and it is asserted here
  // instead: the word fires on those three conclusions and on nothing else.
  // They were separate lists once and disagreed — the chip counted three, the
  // word fired on one, so pressing the chip yielded a tile carrying no word at
  // all (acme-docs, action_required).
  it('draws a word for exactly the three that want a human, conclusion for conclusion', () => {
    for (const ci of ALL_CONCLUSIONS) {
      expect(drawnWord(health({ ci })) !== null, `${ci}`).toBe(NEEDS_ATTENTION.includes(ci));
    }
  });

  it('says nothing for a conclusion that is a choice rather than a fault', () => {
    // `quiet` and not `unsettled`: the health landed and had nothing to report,
    // which is a different answer from not knowing yet (#571).
    for (const ci of ['cancelled', 'skipped', 'success', null] as RepoCi[]) {
      expect(tileWord(health({ ci })).state, `${ci}`).toBe('quiet');
    }
  });
});

describe('tileWord', () => {
  it('says the CI conclusion that actually happened, and says CI while saying it', () => {
    // Beside a repo name a bare "Failing" does not say WHAT failed, and #578's
    // bar is readable on sight, without hovering.
    expect(drawnWord(health({ ci: 'action_required' }))?.text).toBe('CI needs action');
    expect(drawnWord(health({ ci: 'timed_out' }))?.text).toBe('CI timed out');
    expect(drawnWord(health({ ci: 'failure' }))?.text).toBe('CI failing');
  });

  it('leaves the hover hint on Github’s own vocabulary', () => {
    // Deliberately not the same word: the hint names the run and quotes the
    // conclusion Github reports, which is what you would search Actions for.
    const word = drawnWord(health({ ci: 'failure' }))!;
    expect(word.hint).toBe('Latest completed Actions run: Failing');
    expect(word.hint).toContain('Failing');
    expect(word.text).toBe('CI failing');
  });

  it('gives every conclusion that wants a human its OWN word, and never one word for three', () => {
    // Three distinct words, so a repo whose run is waiting on somebody is not
    // told its build failed. The list is walked whole, and the words are
    // asserted distinct — the fault the table replaced was a vocabulary that
    // read complete while half of it was unreachable.
    const words = NEEDS_ATTENTION.map((ci) => drawnWord(health({ ci }))?.text);
    expect(words).toEqual(['CI failing', 'CI timed out', 'CI needs action']);
    expect(new Set(words).size).toBe(3);
  });

  it('a leaked secret outranks any CI conclusion, and only one word is ever drawn', () => {
    const both = health({ ci: 'failure', security: { ...NO_SECURITY, secrets: 1, secretsUrl: null } });
    expect(tileWord(both)).toEqual({
      state: 'word',
      text: 'Leaked secret',
      tone: 'danger',
      hint: 'GitHub secret scanning found a credential in this repo',
      href: null,
    });
  });

  it('points each word at the address READ for it, never at one composed here (#605)', () => {
    const RUN = 'https://github.com/acme/board/actions/runs/42';
    const ALERT = 'https://github.com/acme/board/security/secret-scanning/7';
    // The three CI words take the run's address; the secret word takes the
    // alert's. Two different addresses, so a table that wired every word to one
    // field would fail rather than pass by coincidence.
    for (const ci of NEEDS_ATTENTION) {
      expect(drawnWord(health({ ci, ciUrl: RUN }))?.href, `${ci}`).toBe(RUN);
    }
    const leak = drawnWord(health({
      ciUrl: RUN,
      security: { ...NO_SECURITY, secrets: 1, secretsUrl: ALERT },
    }))!;
    expect(leak.text).toBe('Leaked secret');
    expect(leak.href).toBe(ALERT);
  });

  it('a word with no address read draws EXACTLY as it drew before (#605)', () => {
    // The whole of the null case: same text, same tone, same hint, byte for
    // byte, and nothing to click. Compared against the hint literal rather than
    // against another call of the same function, which would agree with itself
    // however wrong both were.
    const inert = drawnWord(health({ ci: 'failure', ciUrl: null }))!;
    expect(inert.href).toBeNull();
    expect(inert.hint).toBe('Latest completed Actions run: Failing');
    expect(inert.text).toBe('CI failing');
    expect(inert.tone).toBe('warning');

    const leak = drawnWord(health({ security: { ...NO_SECURITY, secrets: 1, secretsUrl: null } }))!;
    expect(leak.href).toBeNull();
    expect(leak.hint).toBe('GitHub secret scanning found a credential in this repo');
  });

  it('says the same thing whether or not the word has an address (#605)', () => {
    // The hint deliberately does NOT name the destination. A clause saying so
    // took every CI hint to two lines and a 47px box, which stopped clearing
    // the tile in the row below — so the underline, the browser's own status
    // bar and the link role carry that job, and the sentence never changes.
    const RUN = 'https://github.com/acme/board/actions/runs/42';
    const linked = drawnWord(health({ ci: 'timed_out', ciUrl: RUN }))!;
    const inert = drawnWord(health({ ci: 'timed_out', ciUrl: null }))!;

    expect(linked.hint).toBe('Latest completed Actions run: Timed out');
    expect(inert.hint).toBe('Latest completed Actions run: Timed out');
    // Guarded: the two hints matching would also be true if BOTH were somehow
    // empty or undefined, so pin the string above and prove the pair really do
    // differ in the field the address lives in — otherwise this passes on a
    // `tileWord` that ignored `ciUrl` altogether.
    expect(linked.href).toBe(RUN);
    expect(inert.href).toBeNull();
  });

  it('a CI conclusion takes the warning tone, a leaked secret the danger one', () => {
    expect(drawnWord(health({ ci: 'failure' }))?.tone).toBe('warning');
    expect(drawnWord(health({ security: { ...NO_SECURITY, secrets: 1, secretsUrl: null } }))?.tone).toBe('danger');
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(tileWord(health({ ci: 'success' })).state).toBe('quiet');
    expect(tileWord(health({ ci: null })).state).toBe('quiet');
    // `high` is deliberately unmarked: it fires on half this org, which is its
    // normal state rather than news, and the security order still lifts those
    // repos to the top of the map.
    expect(tileWord(health({ security: { ...NO_SECURITY, depHigh: 9 } })).state).toBe('quiet');
  });
});

describe('the word slot before the health lands (#571)', () => {
  it('is unsettled while the health read is in flight — never a word, never quiet', () => {
    // The whole point of the third answer. A repo whose health has not arrived
    // is not a clean repo: it is a repo nothing is known about yet, and the tile
    // draws a placeholder rather than the absence of a word.
    expect(tileWord(null)).toEqual({ state: 'unsettled' });
  });

  it('settles at the defaults when the health read failed, drawing no word and no placeholder', () => {
    // A failed read hands the page an empty settled map: no CI conclusion and
    // no drawn word, rather than a placeholder that will never be replaced.
    //
    // The security state under that silence is `unreadable` since #718 — the
    // tile says so in its own slot, and the test above holds that — so "quiet"
    // here means the DRAWN WORD slot, which is the one this describe is about.
    const tiles = buildTiles(view([STEADY, BUSY]), 'open', NO_HEALTH);
    expect(tiles.map((t) => tileWord(t.health).state)).toEqual(['quiet', 'quiet']);
    expect(tiles.every((t) => t.health !== null)).toBe(true);
  });

  it('a settled read that carries a repo’s row draws that repo’s word', () => {
    const red = repo({ name: 'red' });
    const clean = repo({ name: 'clean' });
    const tiles = buildTiles(
      view([red, clean]),
      'name',
      settled([[red, health({ ci: 'failure' })], [clean, health()]]),
    );
    expect(tiles.map((t) => tileWord(t.health).state)).toEqual(['quiet', 'word']);
  });

  it('joins the health onto the row by its canonical key, never by position', () => {
    // The join key is `full`, and the two reads have no reason to arrive in the
    // same sequence — the map is re-sorted here besides. A positional join
    // would put acme-ui's leaked secret on board.
    const one = repo({ name: 'one', open: 1 });
    const two = repo({ name: 'two', open: 9 });
    const byOpen = buildTiles(
      view([one, two]),
      'open',
      settled([[two, health()], [one, health({ security: { ...NO_SECURITY, secrets: 1, secretsUrl: null } })]]),
    );
    expect(byOpen.map((t) => t.row.name)).toEqual(['two', 'one']);
    expect(byOpen.map((t) => tileWord(t.health).state)).toEqual(['quiet', 'word']);
  });

  it('settles a repo the read said nothing about as UNREAD, never as unsettled and never as zero', () => {
    // The server sends a row for every repo including the clean ones, so this is
    // a skew between two deploys, or the whole read having failed. Settled is
    // settled: the page does not hold a placeholder open waiting for a row that
    // is not coming.
    //
    // What it settles AT changed with #718. It used to be four zeros, which
    // made a refused health read draw a clean bill of health for every repo on
    // the map; the zeros are still there because the shape needs numbers, and
    // `state: 'unreadable'` beside them is what says nobody counted.
    const missing = repo({ name: 'missing' });
    const [tile] = buildTiles(view([missing]), 'open', NO_HEALTH);
    expect(tile.health).toEqual({
      security: { ...NO_SECURITY, state: 'unreadable' },
      ci: null,
      ciUrl: null,
    });
    expect(tileWord(tile.health).state).toBe('quiet');
    expect(securityLevel(tile.health!.security)).toBe('unread');
  });
});

it('waits for health only when a health filter is active', () => {
  expect(tilesReady('all', null)).toBe(true);
  for (const filter of ['ci', 'security'] as const) {
    expect(tilesReady(filter, null)).toBe(false);
    expect(tilesReady(filter, NO_HEALTH)).toBe(true);
  }
});

describe('healthByRepo (#571)', () => {
  it('keys every row by the repo it belongs to', () => {
    const row = repo({ name: 'board' });
    const map = healthByRepo({ repos: [{ full: row.full, ...health({ ci: 'failure' }) }] });
    expect(map.get('acme/board')).toEqual({ security: NO_SECURITY, ci: 'failure', ciUrl: null });
  });

  it('is empty for a failed read, which is what NO_HEALTH stands for', () => {
    expect([...NO_HEALTH.keys()]).toEqual([]);
    expect([...healthByRepo({ repos: [] }).keys()]).toEqual([]);
  });
});

describe('the share the map derives', () => {
  it('splits the open queue over the repos that HAVE one, not over the whole map', () => {
    // 30 open across 3 repos with a queue is a share of 10, whatever else is on
    // the map. Over all 6 it would be 5, and half the map would read heavy.
    const rows = [
      repo({ name: 'a', open: 20 }),
      repo({ name: 'b', open: 7 }),
      repo({ name: 'c', open: 3 }),
      repo({ name: 'd', open: 0 }),
      repo({ name: 'e', open: 0 }),
      repo({ name: 'f', open: 0 }),
    ];
    expect(queueShare(rows)).toBe(10);
  });

  it('rounds, so the line and the number a reader is told are one number', () => {
    // 302 over 44 is 6.86 on the live org. A reader told "its share is 7" and a
    // tile reading 7 going heavy would be the board contradicting itself.
    const rows = [repo({ name: 'a', open: 8 }), repo({ name: 'b', open: 6 }), repo({ name: 'c', open: 6 })];
    expect(queueShare(rows)).toBe(7); // 20 / 3 = 6.67
    expect(countTone(7, 7)).toBe('ordinary');
    expect(countTone(8, 7)).toBe('heavy');
    // And DOWN, or `Math.ceil` reads as rounding: every other fraction in this
    // suite sits above .5, so nothing else here tells the two apart.
    const down = [repo({ name: 'd', open: 7 }), repo({ name: 'e', open: 6 }), repo({ name: 'f', open: 6 })];
    expect(queueShare(down)).toBe(6); // 19 / 3 = 6.33
    expect(countTone(7, 6)).toBe('heavy');
  });

  it('has no share to state when nothing on the map has a queue', () => {
    expect(queueShare([repo({ name: 'a', open: 0 }), repo({ name: 'b', open: 0 })])).toBeNull();
    expect(queueShare([])).toBeNull();
  });

  it('reads a zero as empty whether or not a share exists', () => {
    expect(countTone(0, 7)).toBe('empty');
    expect(countTone(0, null)).toBe('empty');
  });

  it('reads every count as ordinary when there is no share to beat', () => {
    // A map of one repo holding everything: its own count IS the share, so
    // nothing on it can carry more than its share.
    expect(countTone(82, null)).toBe('ordinary');
    expect(queueShare([repo({ name: 'acme', open: 82 })])).toBe(82);
    expect(countTone(82, 82)).toBe('ordinary');
  });
});

describe('openHint (#573)', () => {
  it('gives the bare number its unit, and agrees at one', () => {
    expect(openHint(repo({ name: 'acme', open: 19 }), null)).toBe('19 open issues');
    expect(openHint(repo({ name: 'status', open: 1 }), null)).toBe('1 open issue');
  });

  it('is the count and nothing else, on every repo the map holds (#607)', () => {
    // It appended a second sentence on some repos until #607 — a gloss on the
    // warning left edge, which is gone. A label, so no full stop, and no clause
    // after it however the repo's window reads.
    for (const row of [BUSY, STEADY, CLEAR, DORMANT, repo({ name: 'loud', open: 90, weeks: weeks([[40, 1]]) })]) {
      const hint = openHint(row, null);
      expect(hint, row.name).toMatch(/^\d+ open issues?$/);
      expect(hint, row.name).toContain(String(row.open));
    }
  });

  it('leaves the resting hint a bare label, with no punctuation and no clause', () => {
    const hint = openHint(repo({ name: 'board', open: 19 }), null);
    expect(hint).toBe('19 open issues');
    expect(hint).not.toContain('left edge');
    expect(hint).not.toContain('·');
    expect(hint.endsWith('.')).toBe(false);
  });
});

describe('the count hint says what the map made of the number', () => {
  it('stays a bare label where the count is ordinary or empty', () => {
    // A label and not a sentence, so no full stop — the rule this hint has
    // carried since #573.
    expect(openHint(repo({ name: 'a', open: 3 }), 7)).toBe('3 open issues');
    expect(openHint(repo({ name: 'b', open: 0 }), 7)).toBe('0 open issues');
    expect(openHint(repo({ name: 'c', open: 1 }), 7)).toBe('1 open issue');
  });

  it('states the derivation on the counts it changed the tone of', () => {
    // The number is the whole point: a reader who wants to know why this tile
    // is louder than the one beside it gets the line, not an adjective.
    expect(openHint(repo({ name: 'acme', open: 82 }), 7)).toBe(
      '82 open issues — more than its share, which on this map is 7',
    );
  });

  it('says nothing extra where the map derived no share', () => {
    expect(openHint(repo({ name: 'acme', open: 82 }), null)).toBe('82 open issues');
  });
});

describe('what the page no longer says (#607)', () => {
  it('mentions no left edge and nothing falling behind, anywhere it speaks', () => {
    // The edge went, so every sentence that explained one had to go with it —
    // this is the check that none grew back. Every exported string on the
    // surface, gathered from the words themselves rather than from a list
    // somebody has to remember to extend.
    //
    // DESCRIBED is here because the four above are not enough to reach two of
    // these sentences. `nameHint` returns null without a description, so its
    // whole leg filtered away to nothing, and `pushAge` on a null `pushedAt`
    // takes the NEVER_PUSHED branch and never the dated ones. Both legs read as
    // guarded and neither discriminated: a clause put into a described repo's
    // hint, or into `pushed today`, passed this test. One row with both fields
    // set fires them.
    const DESCRIBED = repo({
      name: 'described',
      open: 4,
      description: 'a repo whose name hint has something to say',
      pushedAt: '2026-08-13T09:00:00.000Z',
      weeks: weeks([[9, 1], [7, 2]]),
    });
    // SHRANK is here for the same reason DESCRIBED is: without it a leg reads as
    // swept and is not. `queueMove` has three branches, and of the five rows
    // above only DESCRIBED leaves zero — up. A word put into the DOWN branch
    // passed this sweep and the #613 one below, both, until this row existed.
    const SHRANK = repo({ name: 'shrank', open: 2, weeks: weeks([[1, 6], [2, 5]]) });
    const rows = [BUSY, STEADY, CLEAR, DORMANT, DESCRIBED, SHRANK];
    const said = [
      // Bound explicitly, not `rows.map(openHint)`: bare, `map` hands the index
      // to the share and the clause below is swept against a number the map
      // never derived. The share IS derived here so the heavy clause joins this
      // sweep by being written (#695), which is what this sweep is for.
      ...rows.map((r) => openHint(r, queueShare(rows))),
      ...rows.map(nameHint).filter((s): s is string => s !== null),
      ...rows.map((r) => tileLabel(r, null)),
      ...rows.map(flowTitle),
      ...rows.map((r) => queueMove(repoFlow(r).net)),
      ...rows.map(deltaHint),
      // The one line the GRID says rather than a tile (#660), which is a
      // sentence on this surface like any other.
      ...[flowLegend(rows)].filter((s): s is string => s !== null),
      ...rows.map((r) => pushAge(r, Date.parse('2026-08-13T12:00:00.000Z'))).filter((s): s is string => s !== null),
      ...ORDERS.map((o) => o.label),
      ...ORDERS.map((o) => orderAria(o.key)),
      NO_MATCH_BODY,
      noMatchTitle('anything'),
    ];
    for (const sentence of said) {
      expect(sentence.toLowerCase(), sentence).not.toContain('left edge');
      expect(sentence.toLowerCase(), sentence).not.toContain('falling behind');
      expect(sentence.toLowerCase(), sentence).not.toContain('opened more issues than it closed');
    }
  });
});

describe('what the struck-out chips left behind (#583)', () => {
  // Four chips went. Each narrowing they carried is either reachable another
  // way or deliberately gone, and this is where that is recorded rather than
  // being a thing nobody can find.

  it('No owner became a face, keeping its own words', () => {
    const slots = ownerSlots(buildTiles(view(OWNED)));
    expect(ownerSlotHint(ownerSlotFor(slots, null)!)).toContain('with nobody recorded as owner');
  });

  it('Falling behind went with the border it explained (#607), leaving the chart', () => {
    // The chip's narrowing is the one of the four that is deliberately gone
    // rather than reachable another way. What replaced it is not a sentence:
    // every tile draws opened against closed for ten weeks, so the evidence the
    // chip summarised is on all 78 tiles instead of a boolean on three.
    expect(openHint(repo({ name: 'acme', open: 3 }), null)).toBe('3 open issues');
    expect(flowTitle(repo({ name: 'acme', open: 3 }))).toContain('ten weeks');
  });

  it('CI failing is still readable on sight, as the tile’s own word', () => {
    for (const ci of NEEDS_ATTENTION) expect(drawnWord(health({ ci }))?.text).toMatch(/^CI /);
  });

  it('Security filters every observed alert category', () => {
    // The chip is gone and the security ORDER is what lifts these repos now, so
    // the three doors are asserted against the order rather than against a
    // hint's wording. The middle one is where the chip's own wording was false
    // once: the server counts a code-scanning alert at ANY severity
    // (`s.codeScanning++` in github-repos.source.ts, where only the Dependabot
    // read splits by severity). And `depHigh` is high AND critical added
    // together (`if (sev === 'high' || sev === 'critical') s.depHigh++`), so a
    // repo reaching the loud levels on critical alerts alone comes through it.
    // Named so the ALPHABET puts the quiet repo first: then a loud repo on top
    // is the security order doing the work, not the name comparator underneath
    // it.
    const quiet = repo({ name: 'aaa-quiet' });
    const ways: [RepoRow, RepoHealth][] = [
      [repo({ name: 'z-secret' }), health({ security: { ...NO_SECURITY, secrets: 1, secretsUrl: null } })],
      [repo({ name: 'z-scanning' }), health({ security: { ...NO_SECURITY, codeScanning: 5 } })],
      [repo({ name: 'z-critical' }), health({ security: { ...NO_SECURITY, depHigh: 5 } })],
    ];
    for (const [row, loud] of ways) {
      expect(['exposed', 'high']).toContain(securityLevel(loud.security));
      const map = settled([[quiet, health()], [row, loud]]);
      expect(buildTiles(view([quiet, row]), 'open', map).filter(t => healthMatch(t, 'security') === 'match').map((t) => t.row.name)[0]).toBe(row.name);
      expect(buildTiles(view([quiet, row]), 'name', map).map((t) => t.row.name)[0]).toBe('aaa-quiet');
    }
  });
});

describe('the owner control’s hint (#573)', () => {
  it('carries the FULL name the tile has no room to print, and says the pick writes', () => {
    // The name says what it is, not just who: nothing on the tile labels that
    // footer name as ownership, so the hint cannot open on a bare fragment.
    expect(ownerHint({ login: 'anton-khovanskiy', name: 'Anton Khovanskiy' })).toBe(
      'Anton Khovanskiy owns this repo. Picking a name here writes it on GitHub',
    );
    // The tile itself prints only the first name.
    expect(ownerShortName({ login: 'anton-khovanskiy', name: 'Anton Khovanskiy' })).toBe('Anton');
  });

  it('drops the name when there is none, rather than hinting at "Set owner"', () => {
    expect(ownerHint(null)).toBe('Picking a name here writes it on GitHub');
  });

  it('does not duplicate the accessible name, which is a different sentence', () => {
    const owner = { login: 'octocat', name: 'Octocat' };
    expect(ownerHint(owner)).not.toBe(ownerAria(repo({ name: 'acme' }), owner));
    expect(ownerAria(repo({ name: 'acme' }), owner)).toBe('Owner of acme: Octocat. Click to change.');
  });
});

describe('nameHint (#573)', () => {
  it('hints a repo’s description', () => {
    expect(nameHint(repo({ name: 'acme-ui', description: 'shared design-system library' }))).toBe(
      'shared design-system library',
    );
  });

  it('hints nothing where there is no description — the name is already on screen', () => {
    expect(nameHint(repo({ name: 'acme-ui', description: null }))).toBeNull();
    expect(nameHint(repo({ name: 'acme-ui', description: '   ' }))).toBeNull();
  });
});

describe('SEARCH_KEY_HINT (#573)', () => {
  it('says what pressing the key does', () => {
    expect(SEARCH_KEY_HINT).toBe('Press / to jump to this field from anywhere on the page');
  });
});

describe('repoFlow', () => {
  it('totals the window and reports the net', () => {
    const flow = repoFlow(repo({ name: 'acme', weeks: weeks([[3, 1], [4, 2]]) }));
    expect(flow).toEqual({ opened: 7, closed: 3, net: 4, active: true });
  });

  it('is inactive when nothing opened or closed all window', () => {
    expect(repoFlow(repo({ name: 'status' })).active).toBe(false);
  });
});

describe('deltaLabel', () => {
  it('signs a queue that gained ground', () => {
    expect(deltaLabel(4)).toBe('+4');
  });

  it('leaves a loss and a draw as they are', () => {
    expect(deltaLabel(-3)).toBe('−3');
    expect(deltaLabel(0)).toBe('0');
  });

  it('says nothing about which of the two directions is the good one (#660)', () => {
    // It formats a signed number and stops. Three of its four callers sign a
    // count where MORE is the good news, so a glyph claiming a direction is bad
    // would be wrong on them; the repo tile's claim about a QUEUE is `queueMove`.
    for (const net of [4, -3]) {
      expect(deltaLabel(net)).not.toContain('↑');
      expect(deltaLabel(net)).not.toContain('↓');
    }
  });
});

describe('queueMove (#660)', () => {
  it('points a grown queue up and a shrunk one down, so no reader has to be told', () => {
    // The defect this replaces: `+4` and `−3` differ by a sign whose meaning is
    // a convention, and the half a reader guesses at — plus, more of something —
    // is the bad news. An arrow carries the direction itself: down is fewer open
    // issues than ten weeks ago, and nothing on the page has to say so.
    expect(queueMove(-3)).toBe('↓3');
    expect(queueMove(4)).toBe('↑4');
  });

  it('tells the two directions apart by the arrow, not by a sign or a magnitude', () => {
    // Distinguishable is not enough: two labels differing only in their number
    // would pass a `not.toBe`, and so would a pair that had swapped arrows. Each
    // direction is named, on the same magnitude, in both directions.
    expect(queueMove(9)).not.toBe(queueMove(-9));
    expect(queueMove(-9)).toBe('↓9');
    expect(queueMove(9)).toBe('↑9');
    // …and the signs a reader was being asked to decode are on neither.
    for (const net of [9, -9]) {
      expect(queueMove(net)).not.toContain('+');
      expect(queueMove(net)).not.toContain('−');
    }
  });

  it('leaves a queue that has not moved as a bare zero, pointing nowhere', () => {
    // Zero is not a direction. An arrow on it would claim a movement the window
    // did not have.
    expect(queueMove(0)).toBe('0');
    expect(queueMove(0)).not.toContain('↑');
    expect(queueMove(0)).not.toContain('↓');
  });
});

describe('queueMoveSpoken (#660)', () => {
  it('names the direction in a word, because the arrow is not in a screen reader’s dictionary', () => {
    // `↑` and `↓` (U+2191/U+2193) are not in NVDA's default English symbol
    // dictionary, so `↑25` and `↓25` are BOTH announced as "25" — a sign
    // inversion for that reader, in a change whose whole point was to stop the
    // direction depending on a hover. The word is what the tile hands them.
    expect(queueMoveSpoken(25)).toBe('up 25');
    expect(queueMoveSpoken(-25)).toBe('down 25');
    // Distinguishable is not enough; each direction is named on the same
    // magnitude, and neither word is the other's.
    expect(queueMoveSpoken(25)).not.toBe(queueMoveSpoken(-25));
    expect(queueMoveSpoken(-25)).not.toContain('up');
  });

  it('reads a queue that has not moved as the non-event it is', () => {
    // The drawn `0` announces correctly on its own — this is not a symbol
    // problem — but it announces as a bare digit in a column of them. "no
    // change" is the same claim the drawn zero makes, in the register the two
    // arrows are spoken in.
    expect(queueMoveSpoken(0)).toBe('no change');
  });

  it('branches with the figure it speaks for, so the two cannot disagree', () => {
    // Two functions, one claim. A direction added to one and not the other is
    // the whole defect this closes, arriving from the other side.
    for (const net of [7, -7, 0]) {
      const drawn = queueMove(net);
      const said = queueMoveSpoken(net);
      expect(drawn.startsWith('↑')).toBe(said.startsWith('up'));
      expect(drawn.startsWith('↓')).toBe(said.startsWith('down'));
      // …and the magnitude is the same number in both.
      expect(said).toContain(String(Math.abs(net)) === '0' ? 'change' : String(Math.abs(net)));
      expect(drawn).toContain(String(Math.abs(net)));
    }
  });
});

describe('flowLegend (#660)', () => {
  const LEGEND = '↑↓ change in open issues over 10 weeks';

  it('says the figure is a CHANGE, which is the one thing it cannot be read as', () => {
    // Three facts, and the third is what the second wave shipped without. `↑54`
    // on `acme` is a NET: that repo opened 404 and closed 350 across the
    // window, so a reader taking `↑54` for "54 opened in ten weeks" is wrong by
    // 350 with nothing on the page to correct them. Naming the quantity and the
    // window alone left that reading intact — "change in" is what forecloses it.
    expect(flowLegend([BUSY, CLEAR])).toBe(LEGEND);
    expect(flowLegend([BUSY, CLEAR])).toContain('change in');
  });

  it('counts the buckets it was given rather than repeating the number ten', () => {
    // Built bucket by bucket rather than through `weeks()`, which pads every row
    // back out to ten and would let a hardcoded '10 weeks' pass this.
    const short = repo({ name: 'acme' });
    short.weeks = [{ opened: 1, closed: 0 }, { opened: 2, closed: 1 }];
    expect(flowLegend([short])).toBe('↑↓ change in open issues over 2 weeks');
  });

  it('states no window at all where the tiles drawing a figure disagree about one', () => {
    // This line speaks for every tile on screen off ONE row's bucket count, and
    // the only thing making that sound was a paragraph in three docstrings
    // saying `rollUpRepos` pads every row to ten. `RepoRow['weeks']` is a plain
    // array and says no such thing, so the check lives here instead of the
    // paragraph: a window nobody agrees on is not stated at all, rather than
    // taken from whichever row happened to sort first.
    // CLEAR is active over ten buckets; this one is active over two.
    const short = repo({ name: 'short' });
    short.weeks = [{ opened: 1, closed: 0 }, { opened: 2, closed: 1 }];
    expect(flowLegend([short, CLEAR])).not.toContain('10');
    expect(flowLegend([short, CLEAR])).not.toContain('2 weeks');
    // A row drawing no figure is not a disagreement, whatever its bucket count:
    // it is not on the axis this line speaks about.
    const quiet = repo({ name: 'quiet' });
    quiet.weeks = [{ opened: 0, closed: 0 }];
    expect(flowLegend([quiet, CLEAR])).toBe(LEGEND);
  });

  it('keeps the words and drops only the window where the rows disagree (#660)', () => {
    // The whole of #660 is that a figure on a tile says neither what it counts
    // nor that it is a CHANGE. Falling silent on a disagreement put every tile
    // back in that state — the drawn `↑54` stays, and the sentence explaining it
    // goes — so the disagreement costs the window and nothing else.
    const short = repo({ name: 'short' });
    short.weeks = [{ opened: 1, closed: 0 }, { opened: 2, closed: 1 }];
    expect(flowLegend([short, CLEAR])).toBe('↑↓ change in open issues');
    expect(flowLegend([short, CLEAR])).not.toContain('week');
  });

  it('is silent only where no figure is drawn, never while one is', () => {
    // The guarantee, on every shape that reaches it: a legend is withheld for
    // exactly one reason, and a window nobody agrees on is not that reason.
    const short = repo({ name: 'short' });
    short.weeks = [{ opened: 1, closed: 0 }, { opened: 2, closed: 1 }];
    const quiet = repo({ name: 'quiet' });
    quiet.weeks = [{ opened: 0, closed: 0 }];
    for (const rows of [[BUSY, CLEAR], [short], [short, CLEAR], [short, CLEAR, quiet, DORMANT]]) {
      expect(flowLegend(rows)).toContain('↑↓ change in open issues');
    }
  });

  it('says nothing where no tile in front of the reader draws a figure', () => {
    // A chartless repo draws its last push and no figure at all — six of the
    // eight fixture rows, 29 of the live org's 87. A legend for a mark nothing
    // on screen carries is a legend telling a reader to go and look for one.
    expect(flowLegend([DORMANT])).toBeNull();
    expect(flowLegend([])).toBeNull();
    // …and one active repo among the quiet ones is enough to earn it back.
    expect(flowLegend([DORMANT, CLEAR])).toBe(LEGEND);
  });
});

describe('deltaHint (#660)', () => {
  const GREW = repo({ name: 'acme', weeks: weeks([[3, 1], [4, 2]]) });
  const SHRANK = repo({ name: 'board', weeks: weeks([[1, 3], [2, 4]]) });

  it('gives the figure the two counts it is the difference of', () => {
    // What the figure IS — open issues, over ten weeks, up or down — is drawn
    // once for the grid by `flowLegend`, so this box is left with the evidence:
    // the arithmetic behind `↑4`, which is on no other surface a pointer
    // reaches. It is deliberately short. Carrying the sentence as well took the
    // box to two lines, and two lines under a figure at the tile's right edge
    // reach 83px onto the next tile, over its owner's face and name.
    expect(deltaHint(GREW)).toBe('7 opened, 3 closed');
    expect(deltaHint(SHRANK)).toBe('3 opened, 7 closed');
  });

  it('is the chart’s own accessible name without the window', () => {
    // One derivation, read twice, so the box and the name a screen reader is
    // given cannot come to report two different windows.
    expect(flowTitle(GREW)).toBe(`${deltaHint(GREW)} over ten weeks`);
  });
});

describe('flowTitle', () => {
  it('spells the window out beside the two counts', () => {
    expect(flowTitle(repo({ name: 'acme', weeks: weeks([[3, 1], [4, 2]]) }))).toBe(
      '7 opened, 3 closed over ten weeks',
    );
  });

  it('says "one week" and not "one weeks" on a window one bucket long', () => {
    // `spell(1)` is 'one', and this sentence pinned the plural — so a one-bucket
    // window read "over one weeks". Unreachable from today's only caller
    // (`rollUpRepos` pads to ten, and `repos.service.ts:739` passes no `weeks`),
    // but both this and `flowLegend` take the window as a parameter and this one
    // got the plural wrong on an axis the other already handles.
    const short = repo({ name: 'acme' });
    short.weeks = [{ opened: 3, closed: 1 }];
    expect(flowTitle(short)).toBe('3 opened, 1 closed over one week');
  });
});

describe('weekHint', () => {
  const ROW = repo({
    name: 'acme',
    weeks: weeks([[1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7], [9, 8], [12, 3]]),
  });

  it('names the last bucket as this week', () => {
    expect(weekHint(ROW, 9)).toBe('this week, 3 closed and 12 opened');
  });

  it('reads as a sentence, with no field separator left in it (#694)', () => {
    // It was three fields joined by a middot. The counts now lead, in
    // deltaHint's own words, and the week trails as a clause.
    expect(weekHint(ROW, 7)).not.toContain('·');
    expect(weekHint(ROW, 7)).toBe('2 weeks ago, 7 closed and 8 opened');
  });

  it('counts back in whole weeks, singular at one', () => {
    expect(weekHint(ROW, 8)).toBe('1 week ago, 8 closed and 9 opened');
    expect(weekHint(ROW, 6)).toBe('3 weeks ago, 6 closed and 7 opened');
    expect(weekHint(ROW, 0)).toBe('9 weeks ago, 0 closed and 1 opened');
  });

  it('reports a quiet week as the zeroes it is, rather than hiding it', () => {
    const quiet = repo({ name: 'quiet', weeks: weeks([[4, 4]]) });
    expect(weekHint(quiet, 5)).toBe('4 weeks ago, 0 closed and 0 opened');
  });

  it('reads an out-of-range index as the nearest week it has', () => {
    expect(weekHint(ROW, -1)).toBe('9 weeks ago, 0 closed and 1 opened');
    expect(weekHint(ROW, 99)).toBe('this week, 3 closed and 12 opened');
  });
});

describe('pushAge (#572)', () => {
  const NOW = Date.parse('2026-08-13T12:00:00.000Z');
  const DAY = 86_400_000;
  /** A repo whose last push was `days` ago — the only field this reads. */
  const pushed = (days: number) => repo({ name: 'acme', pushedAt: new Date(NOW - days * DAY).toISOString() });

  it('says today for a push inside the last day', () => {
    expect(pushAge(pushed(0), NOW)).toBe('pushed today');
    // Six hours ago is still today, and so is a clock a little ahead of ours.
    expect(pushAge(pushed(0.25), NOW)).toBe('pushed today');
    expect(pushAge(pushed(-1), NOW)).toBe('pushed today');
  });

  it('counts whole days up to a week, singular at one', () => {
    expect(pushAge(pushed(1), NOW)).toBe('pushed 1 day ago');
    expect(pushAge(pushed(4), NOW)).toBe('pushed 4 days ago');
    expect(pushAge(pushed(6), NOW)).toBe('pushed 6 days ago');
  });

  it('counts whole weeks from a week out, singular at one', () => {
    expect(pushAge(pushed(7), NOW)).toBe('pushed 1 week ago');
    expect(pushAge(pushed(13), NOW)).toBe('pushed 1 week ago');
    expect(pushAge(pushed(21), NOW)).toBe('pushed 3 weeks ago');
    // The org's cold tail, measured 2026-08-13: 30, 52 and 56 days.
    expect(pushAge(pushed(30), NOW)).toBe('pushed 4 weeks ago');
    expect(pushAge(pushed(52), NOW)).toBe('pushed 7 weeks ago');
    expect(pushAge(pushed(56), NOW)).toBe('pushed 8 weeks ago');
  });

  it('turns over to months where the week count stops reading, singular at one', () => {
    // Eight weeks and two months are the same age, so the turn costs nothing.
    expect(pushAge(pushed(59), NOW)).toBe('pushed 8 weeks ago');
    expect(pushAge(pushed(60), NOW)).toBe('pushed 2 months ago');
    expect(pushAge(pushed(94), NOW)).toBe('pushed 3 months ago');
    expect(pushAge(pushed(400), NOW)).toBe('pushed 13 months ago');
  });

  it('says nothing at all where the payload did not answer', () => {
    // Caught live, not here: a dev API predating the field served rows with no
    // `pushedAt` at all, so the tile read "pushed NaN months ago" on 22 repos.
    // Off the type, but board-web ships ahead of board-api routinely, and while
    // it does EVERY row arrives this way.
    //
    // It got `never pushed to` for a while, which was worse than the NaN: a
    // false statement about 22 repos, most of them pushed to that week, in a
    // sentence a reader has no reason to doubt. Nothing said is the only honest
    // reading of a field nobody sent.
    const stale = { ...repo({ name: 'stale' }), pushedAt: undefined } as unknown as RepoRow;
    expect(pushAge(stale, NOW)).toBeNull();
    expect(pushAge({ ...repo({ name: 'junk' }), pushedAt: 'not a date' }, NOW)).toBeNull();
  });

  it('says a repo never pushed to was never pushed to, rather than a number', () => {
    // `pushedAt: null` is Github answering: there has never been a push. That is
    // a fact and it gets a sentence — unlike the silences above, which are the
    // payload failing to answer. Zero days would read "pushed today", which is
    // the misreading this whole line exists to end.
    expect(pushAge(repo({ name: 'empty', pushedAt: null }), NOW)).toBe('never pushed to');
  });
});

describe('tileLabel', () => {
  it('names the repo and its open count', () => {
    expect(tileLabel(repo({ name: 'acme', open: 74 }), null)).toBe('acme, 74 open issues');
  });

  it('agrees at one', () => {
    expect(tileLabel(repo({ name: 'status', open: 1 }), null)).toBe('status, 1 open issue');
  });

  it('says a tile is over its share to a reader who cannot see the tone (#695)', () => {
    // The three tones are the whole of what #695 added, and a tone is not
    // available to a screen reader. Without this the accessible name is
    // identical on a tile the map set loud and one it did not, so the reading
    // the issue asked for exists only for a viewer who can see colour.
    expect(tileLabel(repo({ name: 'acme', open: 82 }), 7)).toBe(
      'acme, 82 open issues, more than its share',
    );
  });

  it('adds nothing to a count the map left ordinary or empty', () => {
    // Same rule the hint follows: the clause is the heavy tiles' alone, so it
    // stays a mark of difference rather than becoming noise on all 87.
    expect(tileLabel(repo({ name: 'board', open: 7 }), 7)).toBe('board, 7 open issues');
    expect(tileLabel(repo({ name: 'roadmap', open: 0 }), 7)).toBe('roadmap, 0 open issues');
    expect(tileLabel(repo({ name: 'acme', open: 82 }), null)).toBe('acme, 82 open issues');
  });
});

describe('owner copy', () => {
  it('shows the person’s name, falling back to the login the org recorded', () => {
    expect(ownerName({ login: 'octocat', name: 'Octocat' })).toBe('Octocat');
    expect(ownerName({ login: 'someone-else', name: null })).toBe('someone-else');
  });

  it('shows only the first name on a tile, where the footer line is short', () => {
    // The footer is one line shared with the drawn word, and `ownerShortName`
    // carries the measurement of what that leaves — re-taken since #578 removed
    // the three pips that used to sit there. Read it there rather than here: a
    // second copy of the figures is the one that goes stale. What it settles is
    // that a full name fits today only by a coincidence of who owns which tile,
    // and any tile is one failing run away from losing up to 89px to a word.
    // The whole name is still on the accessible name below.
    expect(ownerShortName({ login: 'anton-khovanskiy', name: 'Anton Khovanskiy' })).toBe('Anton');
    expect(ownerShortName(null)).toBe('Set owner');
  });

  it('keeps a whole login when it resolves to nobody — half a handle names no one', () => {
    expect(ownerShortName({ login: 'some-service-account', name: null })).toBe('some-service-account');
  });

  it('labels the control with the repo it writes and its current value', () => {
    expect(ownerAria(repo({ name: 'acme' }), { login: 'octocat', name: 'Octocat' })).toBe(
      'Owner of acme: Octocat. Click to change.',
    );
    expect(ownerAria(repo({ name: 'acme' }), null)).toBe('Owner of acme, unset. Click to change.');
  });

  it('offers the schema’s values and nothing else, plus the row that clears it', () => {
    expect(ownerOptions(['octocat'], (l) => (l === 'octocat' ? 'Octocat' : null))).toEqual([
      { login: 'octocat', label: 'Octocat' },
      { login: null, label: 'No owner' },
    ]);
  });
});

describe('repoRef', () => {
  it('splits the canonical key into the org and the repo the write addresses', () => {
    expect(repoRef(repo({ name: 'board' }))).toEqual({
      owner: 'acme',
      repo: 'board',
    });
  });
});

describe('noMatchTitle', () => {
  it('names the query it found nothing for', () => {
    expect(noMatchTitle('  zzz  ')).toBe('No repo matches “zzz”');
  });

  it('says so plainly when a chip, not a word, emptied the map', () => {
    expect(noMatchTitle('   ')).toBe('No repo matches this filter');
  });
});

// ── the reading order (#587) ─────────────────────────────────────────────────

/** A repo whose only interesting property is when it was last pushed to. */
function pushed(name: string, pushedAt: string | null): RepoRow {
  return repo({ name, pushedAt });
}

const ORDER_KEYS = ORDERS.map((o) => o.key);

describe('the orders the map offers', () => {
  it('offers four, and no order over data the board does not hold', () => {
    expect(ORDER_KEYS).toEqual(['open', 'recent', 'name']);
    // Pull-request counts are #582 and nothing serves them, so an order over
    // them would be a control over data that does not exist.
    expect(ORDER_KEYS).not.toContain('pulls');
  });

  it('opens on the fullest queue, as the map always has', () => {
    expect(DEFAULT_ORDER).toBe('open');
    const rows = view([DORMANT, STEADY, BUSY, CLEAR]);
    expect(buildTiles(rows).map((t) => t.row.name)).toEqual(buildTiles(rows, DEFAULT_ORDER).map((t) => t.row.name));
  });

  it('reads an unknown key — a stale link, a typo — as the default rather than emptying the map', () => {
    const rows = view([DORMANT, STEADY, BUSY, CLEAR]);
    expect(buildTiles(rows, 'pulls').map((t) => t.row.name)).toEqual(['acme', 'board', 'roadmap', 'status']);
    expect(orderByKey('pulls').key).toBe(DEFAULT_ORDER);
  });

  it('breaks every tie by name, so no order leaves the map in an arbitrary sequence', () => {
    const a = repo({ name: 'zeta', pushedAt: '2026-08-01T00:00:00.000Z' });
    const b = repo({ name: 'alpha', pushedAt: '2026-08-01T00:00:00.000Z' });
    for (const order of ORDER_KEYS) {
      expect(buildTiles(view([a, b]), order).map((t) => t.row.name)).toEqual(['alpha', 'zeta']);
    }
  });

  it('names each order in one wording, which the control reads out as a phrase', () => {
    // `Last push` and not `Recent activity`: the order sorts on the push and
    // nothing else, only the chartless tiles print an age, and "activity" is the
    // word #572 exists to disown. The URL key stays `recent` — a value is not a
    // label — which `repos-url.spec.ts` holds.
    expect(ORDERS.map((o) => o.label)).toEqual(['Open issues', 'Last push', 'Name']);
    expect(ORDER_KEYS.map(orderTrigger)).toEqual([
      'by open issues',
      'by last push',
      'by name',
    ]);
    expect(orderAria('recent')).toBe('Reading order: last push');
    // The one word all three readings must NOT carry, in any of them.
    expect([...ORDERS.map((o) => o.label), ...ORDER_KEYS.map(orderTrigger), ...ORDER_KEYS.map(orderAria)]
      .join(' ')).not.toMatch(/activity/i);
    // Not the owner control's "Click to change": `aria-haspopup` already says a
    // menu is behind this, and the page asserts that phrase appears nowhere the
    // owner picker is withheld.
    expect(ORDER_KEYS.map(orderAria).join(' ')).not.toContain('Click to change');
  });
});

describe('by last push', () => {
  const FRESH = pushed('fresh', '2026-08-13T09:00:00.000Z');
  const WEEK = pushed('week', '2026-08-06T09:00:00.000Z');
  const COLD = pushed('cold', '2026-05-01T09:00:00.000Z');

  it('is the repo’s last push, most recent first — the same field the tile’s age reads', () => {
    expect(buildTiles(view([COLD, FRESH, WEEK]), 'recent').map((t) => t.row.name)).toEqual(['fresh', 'week', 'cold']);
  });

  it('puts a repo Github has never taken a push for after every repo that has one', () => {
    const never = pushed('never', null);
    expect(buildTiles(view([never, COLD, FRESH]), 'recent').map((t) => t.row.name)).toEqual([
      'fresh',
      'cold',
      'never',
    ]);
  });

  it('never sorts an unknown push as an old one — it has no age to be measured against', () => {
    // The oldest push on this org is 94 days; a repo with no push at all is not
    // "older than that", it is unmeasured. Even against a push from 1970 — the
    // moment a zero would land on — the unknown stays below.
    const ancient = pushed('ancient', '1970-01-02T00:00:00.000Z');
    const never = pushed('never', null);
    expect(buildTiles(view([never, ancient]), 'recent').map((t) => t.row.name)).toEqual(['ancient', 'never']);
  });

  it('treats a push it cannot read as unknown, not as a moment', () => {
    const unreadable = pushed('unreadable', 'not-a-date');
    const ancient = pushed('ancient', '1970-01-02T00:00:00.000Z');
    expect(buildTiles(view([unreadable, ancient]), 'recent').map((t) => t.row.name)).toEqual(['ancient', 'unreadable']);
  });

  it('orders the unmeasured among themselves by name', () => {
    const zeta = pushed('zeta', null);
    const alpha = pushed('alpha', null);
    expect(buildTiles(view([zeta, alpha]), 'recent').map((t) => t.row.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('by name', () => {
  it('is the plain alphabet, whatever the queue says', () => {
    expect(buildTiles(view([BUSY, STEADY, CLEAR, DORMANT]), 'name').map((t) => t.row.name)).toEqual([
      'acme',
      'board',
      'roadmap',
      'status',
    ]);
  });
});

describe('an order composes with the search and the chosen owner', () => {
  const rows = [
    repo({ name: 'alpha', open: 1, owner: ARTUR, pushedAt: '2026-05-01T00:00:00.000Z' }),
    repo({ name: 'beta', open: 9, owner: ARTUR, pushedAt: '2026-08-12T00:00:00.000Z' }),
    repo({ name: 'gamma', open: 4, owner: IVAN, pushedAt: '2026-08-13T00:00:00.000Z' }),
  ];
  /** The chosen face, resolved against whichever ordering is under test — the
   *  slots are derived from the tiles, so they must be too. */
  const octocat = (orderKey: string) =>
    ownerSlotFor(ownerSlots(buildTiles(view(rows), orderKey)), 'octocat');

  it('re-arranges what the owner left standing, and changes nothing about which repos stand', () => {
    const byOpen = visibleTiles(buildTiles(view(rows), 'open'), octocat('open'), '');
    const byRecent = visibleTiles(buildTiles(view(rows), 'recent'), octocat('recent'), '');
    expect(byOpen.map((t) => t.row.name)).toEqual(['beta', 'alpha']);
    expect(byRecent.map((t) => t.row.name)).toEqual(['beta', 'alpha']);

    const byName = visibleTiles(buildTiles(view(rows), 'name'), octocat('name'), '');
    expect(byName.map((t) => t.row.name)).toEqual(['alpha', 'beta']);
    expect(new Set(byName.map((t) => t.row.name))).toEqual(new Set(byOpen.map((t) => t.row.name)));
  });

  it('an order never decides WHICH owner a face stands for, or how many', () => {
    // The slots are read off the tiles, so re-ordering the tiles must leave the
    // faces and their counts exactly where they were.
    for (const order of ORDERS) {
      expect(ownerSlots(buildTiles(view(rows), order.key))).toEqual(ownerSlots(buildTiles(view(rows), 'open')));
    }
  });

  it('re-arranges what a typed query left standing, and changes nothing about which repos stand', () => {
    const q = 'a';
    const byOpen = visibleTiles(buildTiles(view(rows), 'open'), null, q).map((t) => t.row.name);
    const byRecent = visibleTiles(buildTiles(view(rows), 'recent'), null, q).map((t) => t.row.name);
    expect(byOpen).toEqual(['beta', 'gamma', 'alpha']);
    expect(byRecent).toEqual(['gamma', 'beta', 'alpha']);
    expect([...byRecent].sort()).toEqual([...byOpen].sort());
  });
});

describe('an org that cannot record an owner at all (#649)', () => {
  it('covers every state the union has', () => {
    // Vacuity gate. The loops below are only worth their names if the list they
    // walk is the whole union — an empty or truncated one would pass silently.
    expect(WRITABILITIES).toEqual(['not-applicable', 'writable', 'restricted', 'absent', 'unreadable', 'unknown']);
  });

  it('withholds the control exactly where the write is known to be impossible', () => {
    // Both of these are permanent and both are the ORG's answer: Github keeps
    // the property to its owners, or the org has no such property. A control
    // drawn for either can only end in a refusal, and a refusal with a good
    // message is still a control that was drawn and pressed.
    expect(ownerControlOffered('restricted')).toBe(false);
    expect(ownerControlOffered('absent')).toBe(false);
  });

  it('keeps the control where the board has NOT learned the write is impossible', () => {
    // `unreadable` is a fact about this board's TOKEN and says nothing about
    // the org; it may be one bad minute. `unknown` is a schema that read fine
    // and named a setting we do not recognise, so the allowed values are real.
    // Hiding a control on either is #577 inverted: a map that goes quietly
    // uneditable and never says so.
    expect(ownerControlOffered('unreadable')).toBe(true);
    expect(ownerControlOffered('unknown')).toBe(true);
    expect(ownerControlOffered('writable')).toBe(true);
  });

  it('keeps the control when the server said nothing at all, by decision', () => {
    // board-web ships ahead of board-api, and across that window the field is
    // simply not on the response. The fallback is the behaviour the page had
    // before the field existed — offer it, and let a refused write say so.
    // Pinned here so nobody "tidies" the predicate into a truthiness test.
    expect(ownerControlOffered(undefined)).toBe(true);
  });

  it('says the org has no owner field, rather than going on offering to set one', () => {
    // The distinction the whole task is for. A repo nobody has got round to
    // owning and a repo whose ORG cannot record an owner are different facts,
    // and they must not print the same words.
    expect(ownerShortName(null, 'absent')).toBe(NO_OWNER_FIELD);
    expect(ownerShortName(null, 'absent')).not.toBe(SET_OWNER);
  });

  it('never renders a failed read as a fact about the org', () => {
    // The one thing this task cannot get wrong. `unreadable` is about this
    // board's token; printing "no owner field" for it would state a limitation
    // of the org the board never established.
    for (const writability of WRITABILITIES_AND_MISSING) {
      if (writability === 'absent' || writability === 'not-applicable') continue;
      expect(ownerShortName(null, writability), `${writability}`).toBe(SET_OWNER);
      expect(ownerRestHint(null, writability), `${writability}`).toBeNull();
    }
  });

  it('explains the label only where the label names a limitation', () => {
    expect(ownerRestHint(null, 'absent')).toBe(NO_OWNER_FIELD_HINT);
    // An owned repo reads as owned whatever the org's schema says: the property
    // holds a value, and how it got there is not the tile's sentence.
    for (const writability of WRITABILITIES_AND_MISSING) {
      if (writability === 'not-applicable') continue;
      const owner = { login: 'anton-khovanskiy', name: 'Anton Khovanskiy' };
      expect(ownerShortName(owner, writability), `${writability}`).toBe('Anton');
      expect(ownerRestHint(owner, writability), `${writability}`).toBeNull();
    }
  });
});

describe('the tile says nothing about how the repo is doing (#613)', () => {
  it('never calls a repo clear, well, fine or healthy — whatever its queue reads', () => {
    // #613 made every count carry the same weight, including a zero, and the
    // pull the whole way through that issue was towards saying something ABOUT
    // the empty ones — a word, a tick, a quieter tone standing in for one.
    //
    // Measured on this org and the reason none of that shipped: 41 repos have
    // an empty queue and 10 of them are not in good standing — 8 with a failing
    // CI, 2 with a leaked credential. Any of those words is therefore false on
    // a quarter of the tiles it would land on, two of them holding a credential
    // in their history. An empty queue is a fact about the QUEUE.
    //
    // Standing has one place to be reported and it still reports it: the footer
    // word, whose own vocabulary is asserted whole a few describes up. This
    // sweeps everything else this surface can say about a repo.
    const NOW = Date.parse('2026-08-13T12:00:00.000Z');
    const rows = [
      BUSY,
      STEADY,
      CLEAR,
      DORMANT,
      repo({
        name: 'quiet-and-exposed',
        open: 0,
        description: 'an empty queue on a repo with a credential in its history',
        pushedAt: '2026-08-13T09:00:00.000Z',
      }),
      // Every row above nets zero, so `queueMove` said '0' five times and neither
      // arrow branch was swept at all: a reassuring word put into either one
      // passed this test. One queue that grew and one that fell fire both.
      repo({ name: 'grew', open: 14, weeks: weeks([[9, 1], [7, 2]]) }),
      repo({ name: 'shrank', open: 2, weeks: weeks([[1, 6], [2, 5]]) }),
    ];
    const said = [
      // Bound explicitly, not `rows.map(openHint)`: bare, `map` hands the index
      // to the share and the clause below is swept against a number the map
      // never derived. The share IS derived here so the heavy clause joins this
      // sweep by being written (#695), which is what this sweep is for.
      ...rows.map((r) => openHint(r, queueShare(rows))),
      ...rows.map((r) => tileLabel(r, null)),
      ...rows.map(flowTitle),
      ...rows.map(nameHint).filter((s): s is string => s !== null),
      ...rows.map((r) => queueMove(repoFlow(r).net)),
      ...rows.map(deltaHint),
      // The one line the GRID says rather than a tile (#660), which is a
      // sentence on this surface like any other.
      ...[flowLegend(rows)].filter((s): s is string => s !== null),
      ...rows.map((r) => pushAge(r, NOW)).filter((s): s is string => s !== null),
      // The owner slot's resting words, in every state the org's `dri` property
      // can be in — so a sentence added there later joins this sweep by being
      // written, not by somebody remembering to add it here (#649).
      ...WRITABILITIES_AND_MISSING.map((w) => ownerShortName(null, w)),
      ...WRITABILITIES_AND_MISSING.map((w) => ownerRestHint(null, w)).filter((s): s is string => s !== null),
    ];
    // Not a style list. Each of these is a claim about the repo's standing that
    // the board has not read and cannot make from a queue length, plus the two
    // glyphs that make the same claim without words. Hoisted to one const (#650)
    // now that a second sweep reads it — see `src/reassuring-words.ts`.
    const forbidden = REASSURING_WORDS;
    expect(said.length).toBeGreaterThan(20);
    for (const sentence of said) {
      for (const word of forbidden) {
        expect(sentence.toLowerCase(), `${sentence} / ${word}`).not.toContain(word);
      }
    }
  });
});

it('health filters distinguish observed failures, partial alerts, and unavailable results', () => {
  const row = repo({ name: 'health' });
  const tile = (h: RepoHealth | null) => ({ row, health: h });
  for (const ci of ['failure', 'timed_out', 'action_required'] as const) {
    expect(healthMatch(tile(health({ ci })), 'ci')).toBe('match');
  }
  for (const ci of ['success', 'cancelled', 'skipped', 'neutral'] as const) {
    expect(healthMatch(tile(health({ ci })), 'ci')).toBe('clear');
  }
  expect(healthMatch(tile(health()), 'ci')).toBe('unknown');
  expect(healthMatch(tile(null), 'security')).toBe('unknown');
  for (const state of ['unreadable', 'not-applicable'] as const) {
    expect(healthMatch(tile(health({ security: { ...NO_SECURITY, state } })), 'security')).toBe('unknown');
    expect(healthMatch(tile(health({ security: { ...NO_SECURITY, state, depModerate: 1 } })), 'security')).toBe('match');
  }
  expect(healthMatch(tile(health()), 'security')).toBe('clear');
  expect(healthFilterNotice([tile(null)], 'security')).toContain('couldn’t be read for 1 repository');
  expect(healthFilterNotice([tile(null)], 'all')).toBeNull();
});

it('quietly excludes unsupported personal security reads but still reports failed reads (#1277)', () => {
  const tile = (h: RepoHealth | null) => ({ row: repo({ name: 'health' }), health: h });
  const personal = tile(health({ security: { ...NO_SECURITY, state: 'not-applicable' } }));
  const failed = tile(health({ security: { ...NO_SECURITY, state: 'unreadable' } }));
  expect(healthMatch(personal, 'security')).toBe('unknown');
  expect(healthFilterNotice([personal], 'security')).toBeNull();
  expect(healthFilterNotice([personal, failed, tile(null)], 'security')).toBe(
    'Security results couldn’t be read for 2 repositories, so this filter leaves them out.',
  );
  expect(healthFilterNotice([personal], 'ci')).toBe(
    'CI results couldn’t be read for 1 repository, so this filter leaves it out.',
  );
});
