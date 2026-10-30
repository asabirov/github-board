import { describe, expect, it } from 'vitest';
import {
  deltaNote,
  excludedNote,
  firstName,
  hasPulse,
  netLastDay,
  noCloseNote,
  pulseScale,
  quietNote,
  recencyLine,
  floorCount,
  joinFailed,
  joinFailedCountNote,
  joinFailedNote,
  fromLastGoodCopy,
  staleCopyCountNote,
  figuresWithheld,
  withheldCountNote,
  readShort,
  truncatedCountNote,
  truncatedNote,
} from './pulse';

// The board's test env is `node` (no DOM), so — like board-card.spec — we lock
// the pure drivers behind the rollup card rather than render it: `firstName` and
// `recencyLine` compose the card's recency reading.

describe('recencyLine (#470)', () => {
  it('reads as a sentence when both the person and the time are known', () => {
    expect(recencyLine('Octocat', '1h ago')).toBe('Closed by Octocat 1h ago');
  });

  it('drops the missing half rather than leaving a dangling word', () => {
    expect(recencyLine('', '1h ago')).toBe('Closed 1h ago');
    expect(recencyLine('Octocat', '')).toBe('Closed by Octocat');
  });

  it('says nothing at all when neither half is known', () => {
    // A bare "Closed" tells the reader less than an absent line.
    expect(recencyLine('', '')).toBe('');
  });
});

describe('noCloseNote (#488)', () => {
  it('a board that really has closed nothing says so', () => {
    expect(noCloseNote(0)).toBe('No issues closed yet');
  });

  it('a board with closes but none to name says nothing at all', () => {
    // The card has no close it can name — every recent one was a bot's, or
    // somebody else's words this reader may not have. "No issues closed yet"
    // would be contradicted by the board's own closed count and its ring.
    expect(noCloseNote(1)).toBe('');
    expect(noCloseNote(42)).toBe('');
  });
});

describe('excludedNote (#517)', () => {
  it('says nothing at all for a board holding only issues', () => {
    // Every board we run today. The card must read exactly as it did before.
    expect(excludedNote(0)).toBe('');
  });

  it('says nothing when the API never sent the count', () => {
    // A board-web talking to a board-api that predates the field: silence is the
    // only honest answer, and it is also the old behaviour.
    expect(excludedNote(undefined)).toBe('');
  });

  it('says what the figures left out, in the reader’s grammar', () => {
    expect(excludedNote(1)).toBe("1 item on this board isn’t an issue, so it isn’t counted");
    expect(excludedNote(3)).toBe("3 items on this board aren’t issues, so they aren’t counted");
  });
});

describe('firstName', () => {
  it('renders the last-closed name as a first name, from a display name or a bare login', () => {
    expect(firstName('Octocat')).toBe('Octocat');
    expect(firstName('octocat')).toBe('octocat'); // unresolved login → shown as-is
  });
});

// ─── The 14-day pulse (#663) ─────────────────────────────────────────────────
// The card used to end in one static number. These four drive what it says
// instead: which way the open count moved overnight, how that reads, the open
// level behind the number, and whether there is anything to draw at all.

describe('netLastDay (#663)', () => {
  it('reads the trailing bucket only — the last day\'s opens minus its closes', () => {
    // Sign convention, and it is the one every caller below depends on:
    // NEGATIVE means the open count fell, which is the good direction.
    expect(netLastDay([0, 1, 3], [0, 0, 7])).toBe(-4);
    expect(netLastDay([0, 1, 7], [0, 0, 3])).toBe(4);
    // Nothing before the last bucket can move it.
    expect(netLastDay([99, 99, 1], [0, 0, 1])).toBe(0);
  });

  it('answers 0 when either series is empty, rather than NaN', () => {
    // A board-api that predates the fields sends nothing, and `undefined.at(-1)`
    // arithmetic would print "NaN more open in the last 24 hours" on the card.
    expect(netLastDay([], [])).toBe(0);
    expect(netLastDay([1], [])).toBe(0);
    expect(netLastDay([], [1])).toBe(0);
  });
});

describe('deltaNote (#663)', () => {
  it('leads with the sign, so the difference is read as a number and not a sentence', () => {
    // It sits under "26 open" in a column ~190px wide, so the unit is already
    // said above it and the words left are the ones stating the window.
    expect(deltaNote(-4)).toBe('\u22124 in the last 24h');
    expect(deltaNote(3)).toBe('+3 in the last 24h');
  });

  it('signs a one-issue move too, rather than dropping to a bare numeral', () => {
    expect(deltaNote(-1)).toBe('\u22121 in the last 24h');
    expect(deltaNote(1)).toBe('+1 in the last 24h');
  });

  it('signs a fall with a real minus, not a hyphen the digits dwarf', () => {
    // U+2212 matches the numerals' weight and width; U+002D is a word-joiner
    // glyph and reads as a dash between "open" and the count.
    expect(deltaNote(-4).startsWith('\u2212')).toBe(true);
    expect(deltaNote(-4)).not.toContain('-');
  });

  it('never dates the bucket to a calendar day', () => {
    // `pulseSlot`'s window is [now-24h, now), which at 07:15 spans two days.
    for (const net of [-4, -1, 1, 3]) expect(deltaNote(net)).not.toMatch(/yesterday|today/i);
  });

  it('says nothing at all when nothing moved', () => {
    // "+0 in the last 24h" is a line that costs a reader a beat and tells them
    // nothing — the caller drops the line instead.
    expect(deltaNote(0)).toBe('');
  });
});

describe('pulseScale (#663)', () => {
  /** A board of the page as `pulseScale` is handed it — both series, the way a
   *  `ProjectSummary` carries them. A variable and not an inline literal because
   *  the narrowed parameter rejects a fresh literal naming `dailyOpened`, and
   *  what these tests have to show is a real board's opens being ignored. */
  const board = (dailyOpened: number[], dailyClosed: number[]) => ({ dailyOpened, dailyClosed });

  it('is the tallest day on the WHOLE page, so three stacked cards compare', () => {
    // A quiet board and a busy one, normalised per card, drew the same spike.
    expect(pulseScale([board([0, 8], [0, 1]), board([0, 29], [0, 3])])).toBe(3);
  });

  it('measures the drawn series only, so an intake day cannot flatten the page', () => {
    // Live: 29 opened against 3 closed. Scaling to 29 put every closed bar on
    // the page on the 2px floor, and the chart draws no opens to explain it.
    expect(pulseScale([board([29], [3])])).toBe(3);
  });

  it('reads closes', () => {
    expect(pulseScale([board([1], [22])])).toBe(22);
  });

  it('never answers 0, so nothing divides by it', () => {
    expect(pulseScale([])).toBe(1);
    expect(pulseScale([board([0, 0], [0, 0])])).toBe(1);
    // A fortnight of intake and no closes divides by 1, not by 9.
    expect(pulseScale([board([9, 9], [0, 0])])).toBe(1);
    expect(pulseScale([{}])).toBe(1);
  });
});

describe('truncatedNote (#663)', () => {
  it('claims only what the flag can know — the board\'s own uncertainty, not Github\'s conduct', () => {
    // The flag is the source's own answer since #690, settled against the
    // `totalCount` Github reports beside the items: false says this read came up
    // short of it, or stopped while Github said there was more. Naming what
    // Github sent would be a claim the flag cannot carry.
    //
    // #722 rewrote the second clause. "so movement is left out" named the only
    // thing #663 withheld — the spark and the delta — and by #722 that had
    // stopped being the whole list: the counts now carry a floor mark and the
    // ring states nothing, so a sentence naming only movement described a card
    // that no longer existed. What replaced it names both.
    //
    // #763 cut it from 103 characters to 31, by way of a 41-character step that
    // fitted and was turned down. `truncatedNote`'s docblock says why, once.
    expect(truncatedNote(false)).toBe('Part of this list was not read.');
  });

  // NO LENGTH BOUND HERE ANY MORE. #663 guarded this at 70 characters and #722
  // raised it to 105 for the sentence it wanted; a typed bound is what gets
  // widened when the copy will not fit, which is the failure #763 was filed on.
  //
  // The geometry survives. The note's column is 234.0px at 390, the narrowest it
  // ever gets, so a sentence that fits there holds one line everywhere. This
  // sentence's own ink was not probed; what was measured is what the guard
  // measures — 17.39px over a 17.40px line-height, 0.999 lines, at all five.
  //
  // The guarantee lives in `scripts/check-phone-overflow.mjs` — /projects at 390,
  // 1024, 1140, 1280 and 1440, the note found by the card's "+" floor mark rather
  // than by its words, failing when its box outgrows its own computed line-height.
  // That count is the browser's, and no character budget buys it.

  it('says nothing on a board read in full', () => {
    expect(truncatedNote(true)).toBe('');
  });

  it('says nothing to an API that predates the field — an unknown is not a claim', () => {
    expect(truncatedNote(undefined)).toBe('');
  });
});

describe('truncatedCountNote (#715)', () => {
  it('says the card’s sentence, minus the full stop', () => {
    // One state, one sentence, two sizes. Mid-#763 these were two different
    // sentences — the card's shortened to fit 390px while this one kept "The
    // board cannot vouch for these counts" — which a design review read as
    // drift between two forms of one state. Both literals are pinned here, so
    // re-splitting them is a change somebody has to make on purpose.
    expect(truncatedCountNote(false)).toBe('Part of this list was not read');
    expect(truncatedNote(false)).toBe(`${truncatedCountNote(false)}.`);
  });

  it('carries no closing period — its siblings in that slot carry none either', () => {
    // "This week: 2 closed, 3 opened" / "Nothing opened or closed this week" are
    // the other two things this sub-line ever says, and a full stop on one of the
    // three reads as a typo.
    expect(truncatedCountNote(false).endsWith('.')).toBe(false);
  });

  it('says nothing on a board read in full', () => {
    expect(truncatedCountNote(true)).toBe('');
  });

  it('says nothing to an API that predates the field — an unknown is not a claim', () => {
    expect(truncatedCountNote(undefined)).toBe('');
  });
});

describe('hasPulse (#663)', () => {
  it('is false when a fortnight closed nothing', () => {
    // The flat shape #470 was right to pull. The card draws no chart.
    expect(hasPulse(new Array(14).fill(0))).toBe(false);
  });

  it('is false when the API sent no series at all', () => {
    expect(hasPulse([])).toBe(false);
  });

  it('is true for a lone close — one bar is a fact, and silence is not', () => {
    // Two days was a hedge against a smoothed line, which no longer exists. At a
    // readable arm a single bar reads, and holding it back made a one-event board
    // render exactly like a board whose API never sent the series.
    expect(hasPulse([0, 0, 4])).toBe(true);
  });

  it('is true as soon as two different days carry a close', () => {
    expect(hasPulse([0, 1, 1])).toBe(true);
    expect(hasPulse([0, 0, 1])).toBe(true);
  });
});


describe('quietNote (#663)', () => {
  it('a fortnight that closed nothing says so, over the buckets it was sent', () => {
    // Silence used to encode this, a board on an API predating the fields and a
    // board holding one event day all at once. This is the one that has words.
    expect(quietNote(new Array(14).fill(0))).toBe('No issues closed in the last 14 days');
    // The window comes off the series, so a source that sends a different one
    // cannot leave the sentence stating 14.
    expect(quietNote(new Array(7).fill(0))).toBe('No issues closed in the last 7 days');
  });

  it('speaks for the drawn series only, so it cannot say nothing happened', () => {
    // The board it stands under may have opened issues all fortnight — the card
    // says so, in the count and its signed difference. This sentence is the
    // spark's own absence, and claiming a quiet fortnight would be a lie.
    expect(quietNote(new Array(14).fill(0))).not.toMatch(/opened|nothing moved/);
  });

  it('says nothing at all when there is no series to be quiet about', () => {
    // An API predating the fields makes no claim about a fortnight, so neither
    // may the card.
    expect(quietNote([])).toBe('');
  });

  it('says nothing on a board with something to draw', () => {
    // Exactly `hasPulse`'s complement: whatever draws a chart never also says
    // the fortnight was empty.
    expect(quietNote([0, 0, 1])).toBe('');
    expect(quietNote([0, 2, 1])).toBe('');
  });
});

// #722 — the gates the surfaces read, and the third state's two sentences. Pure
// and here rather than spelled at each call site: the card, the three rings, the
// count's floor mark and the rollup headline are one gate, and a sentence can be
// reworded without silently moving what is withheld.
describe('readShort / joinFailed (#722)', () => {
  it('reads each flag as `=== false`, so an absent one is not a failure', () => {
    expect(readShort(false)).toBe(true);
    expect(readShort(true)).toBe(false);
    expect(readShort(undefined)).toBe(false);
    expect(joinFailed(false)).toBe(true);
    expect(joinFailed(true)).toBe(false);
    expect(joinFailed(undefined)).toBe(false);
  });

  it('answers the two independently — neither is derived from the other', () => {
    // A board can be read short with its org's join intact, joined with a short
    // read, both, or neither. Folding them would leave one of the two sentences
    // unsayable.
    expect([readShort(false), joinFailed(undefined)]).toEqual([true, false]);
    expect([readShort(undefined), joinFailed(false)]).toEqual([false, true]);
    expect([readShort(false), joinFailed(false)]).toEqual([true, true]);
  });
});

describe('floorCount (#722)', () => {
  it('marks a count off a short read as a floor, leaving the number alone', () => {
    // The "+" is the whole mark. A partial read undercounts, so 9 means "at
    // least 9" — wrong in one direction only, which is what lets it survive
    // where the ring's ratio of two such counts does not.
    expect(floorCount(9, false)).toBe('9+');
    expect(floorCount(0, false)).toBe('0+');
  });

  it('leaves a board read whole, and one making no claim, exactly as it was', () => {
    expect(floorCount(9, true)).toBe('9');
    expect(floorCount(9, undefined)).toBe('9');
  });
});

describe('joinFailedNote / joinFailedCountNote (#722)', () => {
  it('names the week, and nothing wider — the board itself was read whole', () => {
    // The org-wide join is what did not run. This board's items were all read,
    // so its ring, its percentage and its open count are sound and the sentence
    // must not put them in doubt.
    expect(joinFailedNote(false)).toBe("This week’s closes were not read, so movement is left out.");
    expect(joinFailedCountNote(false)).toBe("This week’s closes were not read");
  });

  it('says the row form in fewer words than the card form — one state at two sizes', () => {
    // The pairing is the point: one state at two sizes, both here, so the row
    // and the card cannot drift.
    expect(joinFailedCountNote(false).length).toBeLessThan(joinFailedNote(false).length);
    // UNTIL #763 this also asserted `joinFailedNote` was shorter than
    // `truncatedNote`, because this pair withholds less. The ordering flipped —
    // 58 characters against 31 — and the reasoning is what stopped being true:
    // the card's sentence is now sized by the 234.0px column it must fit at 390,
    // so its length says nothing about how much it withholds. Nor is it asserted
    // the other way round; a comparison against a sibling sentence is a typed
    // character bound wearing a hat, and that bound is what #763 removed. What it
    // stood in for — which of the two a card says when a board is both — is
    // asserted directly in `ProjectsView.spec.tsx`, "says the read-short sentence
    // and not this one when a board is both".
  });

  it('carries no closing period in the row form — its siblings carry none', () => {
    expect(joinFailedCountNote(false).endsWith('.')).toBe(false);
    // …and the card form does, matching `truncatedNote` in the slot they share.
    expect(joinFailedNote(false).endsWith('.')).toBe(true);
  });

  it('says nothing when the join ran, and nothing to an API that never said', () => {
    expect(joinFailedNote(true)).toBe('');
    expect(joinFailedNote(undefined)).toBe('');
    expect(joinFailedCountNote(true)).toBe('');
    expect(joinFailedCountNote(undefined)).toBe('');
  });
});

/**
 * The fourth state (#770). #713's retiree WAS served with `pulseJoined: false`,
 * until #792 stopped it, so before this pair the row said the join's sentence on
 * it — and the join RAN: a rollup is cached only when it did, so every copy a
 * drop retires is one whose join succeeded. `lastGoodCopy` is the bit that
 * separates the two causes, and since #792 it is the only bit that does: a
 * retiree's `pulseJoined` is `true` like any other read's, and the flag saying
 * the four joined figures came off is `joinedFiguresWithheld`.
 */
describe('fromLastGoodCopy / staleCopyCountNote (#770)', () => {
  it('names the board’s OWN numbers, which is what a retiree has wrong', () => {
    // Not the week, and not the item list: those two sentences are about a read
    // going wrong, and on a retiree both reads went fine. What is out of date is
    // the counts, the ring and the contributor list, and nothing else says so.
    expect(staleCopyCountNote(true)).toBe('These counts predate the last change');
  });

  it('reads `=== true`, the opposite way from its two neighbours', () => {
    // `readShort` and `joinFailed` withhold on no claim. This one would have
    // every board in a deployment announce that its numbers are old, so absent
    // has to mean "not a copy" — which is what a board-api predating the field
    // and every board on a successful read both are.
    expect(fromLastGoodCopy(true)).toBe(true);
    expect(fromLastGoodCopy(false)).toBe(false);
    expect(fromLastGoodCopy(undefined)).toBe(false);
    expect(staleCopyCountNote(false)).toBe('');
    expect(staleCopyCountNote(undefined)).toBe('');
  });

  it('carries no closing period, and is the widest thing the sub-line says', () => {
    expect(staleCopyCountNote(true).endsWith('.')).toBe(false);
    // NOT a bound, and the bound that stood here was wrong in the direction that
    // flatters: it read `<= joinFailedCountNote + 5` under a comment claiming
    // the sentence fit INSIDE the one it displaces. It does not. 36 characters
    // against 32, 32 and 30, so it is the longest copy this column has ever had
    // to hold — which is a fact worth asserting rather than a budget worth
    // setting. The 234.0px column figure is recorded in this file, above the
    // `truncatedNote` case.
    //
    // The array is every OTHER sentence that can take this sub-line slot, not a
    // chosen pair, so it tracks `weeklyClosedLine`'s chain rather than the two
    // sentences that happened to exist when this case was written.
    // `withheldCountNote` entered that chain at #792 and passes here at 32; it is
    // also ranked against this one from its own side, in the #792 case below, so
    // what the array adds is not that sentence's rank but the habit of listing
    // the slot — a sixth sentence added to `weeklyClosedLine` and to nothing else
    // is one nobody has measured, and this is the line that notices.
    for (const sibling of [joinFailedCountNote(false), truncatedCountNote(false), withheldCountNote(true)]) {
      expect(staleCopyCountNote(true).length).toBeGreaterThan(sibling.length);
    }
  });
});

/**
 * The fifth state (#792), and the only one with no cause on it. The three
 * predicates above each read the flag for one cause; board-api sets this one
 * inside the function that takes the four joined figures off, so it is true on
 * every cause including the ones this frontend has never heard of. What it buys
 * is a row that can say "withheld" to a board-api newer than itself instead of
 * counting the absence as zero.
 */
describe('figuresWithheld / withheldCountNote (#792)', () => {
  it('says the figures are gone without saying what took them', () => {
    // Every other sentence in this slot names something. This one cannot: the
    // reader that reaches it has been told the figures are off the payload and
    // nothing else, so the sentence has to hold for a cause invented after it.
    expect(withheldCountNote(true)).toBe("This week’s closes were withheld");
  });

  it('reads `=== true`, the same way round as `fromLastGoodCopy`', () => {
    // And the opposite of `readShort` and `joinFailed`. Absent here is a
    // board-api that predates the field, not a board whose figures are gone —
    // read the other way, every board in the app refuses to state a week for as
    // long as a deploy window lasts.
    expect(figuresWithheld(true)).toBe(true);
    expect(figuresWithheld(false)).toBe(false);
    expect(figuresWithheld(undefined)).toBe(false);
    expect(withheldCountNote(false)).toBe('');
    expect(withheldCountNote(undefined)).toBe('');
  });

  it('carries no closing period — its three siblings in that slot carry none', () => {
    expect(withheldCountNote(true).endsWith('.')).toBe(false);
  });

  it('does not move the width ceiling `staleCopyCountNote` holds', () => {
    // Asserted, not measured, for the reason recorded on that one: the phone
    // guard checks containment and this sub-line wraps rather than overhangs.
    // 32 characters — level with `joinFailedCountNote` and four inside the 36 of
    // the widest thing this column has ever had to hold, so the ceiling is where
    // #770 left it.
    expect(withheldCountNote(true).length).toBe(joinFailedCountNote(false).length);
    expect(withheldCountNote(true).length).toBeLessThan(staleCopyCountNote(true).length);
  });
});
