import type { PersonAliases } from '../people/people-aliases';
import type { IdentityRecord } from './identity.repository';

const norm = (s: string) => s.trim().toLowerCase();

/** The board's merged view of "which Github handle belongs to whom" (#541). */
export interface TeamRoster {
  /** Lowercased Github login → a display name for it. Every login either source
   *  has ever named, because this only ever labels a row that already exists. */
  names: Map<string, string>;
  /** The logins the board currently claims as its team — the seed list for the
   *  throughput chart's rows, and the only field that can bring a row into
   *  existence. Spelled the way the file spells them where the file knows the
   *  login at all, otherwise as stored. */
  logins: string[];
}

/**
 * Merge the admin-editable roster with the checked-in alias table.
 *
 * The two fields answer different questions and can cause different things, so
 * they get DIFFERENT precedence. This is the part most likely to be "simplified"
 * later into one rule, so both halves say why.
 *
 * `logins` is person-level. It is the seed list `computeMetrics` turns into chart
 * rows, so it is the only field that can bring a row into existence. If it were a
 * plain union, a handle an admin cleared would come straight back off the file
 * and the row with it — #540 again, through the back door. So a person the roster
 * knows contributes exactly what the roster says, cleared handle included, and
 * only a person the roster has never heard of falls through to the file.
 *
 * `names` deliberately does NOT do that. It is a display lookup: given a login
 * that has ALREADY turned up in issue data or a CODEOWNERS file, what is this
 * account called. It cannot resurrect a row, so suppression there prevents
 * nothing — and it would lose a name we already had. A renamed handle still has
 * historical issues assigned to the old one, and those rows appear regardless;
 * under person-level precedence they would read as a bare handle. Same for a
 * cleared handle still sitting in a repo's CODEOWNERS on the Repos map. Nothing
 * in #540 asks us to forget a name.
 */
export function mergeRoster(records: IdentityRecord[], aliases: PersonAliases[]): TeamRoster {
  // `names`: plain union, file first, roster overlaid. Keyed on lowercase — a
  // CODEOWNERS file writes a login in whatever case the author felt like, and
  // the lookup handed to computeMetrics is a raw case-sensitive `get`, so a
  // mis-cased roster handle would render a bare handle where a name belongs.
  const names = new Map<string, string>();
  for (const a of aliases) {
    if (a.githubLogin) names.set(norm(a.githubLogin), a.displayName);
  }
  for (const r of records) {
    if (r.githubLogin) names.set(norm(r.githubLogin), r.displayName);
  }

  // `logins`: person-level precedence, in three steps.
  const known = new Set(records.flatMap((r) => r.emails.map(norm).filter(Boolean)));
  const raw: string[] = [];
  for (const a of aliases) {
    const owned = a.emails.some((e) => known.has(norm(e)));
    if (!owned && a.githubLogin) raw.push(a.githubLogin);
  }
  for (const r of records) {
    if (r.githubLogin) raw.push(r.githubLogin);
  }

  // Canonicalise spelling through the file where the file knows the login at
  // all, so a handle re-typed in the wrong case still displays the way Github
  // shows it. Cosmetic and free — the chart's own identity keying is already
  // case-folded (#547), so this decides which spelling a human sees, not
  // whether two rows appear.
  const filedSpelling = new Map<string, string>();
  for (const a of aliases) {
    if (a.githubLogin) filedSpelling.set(norm(a.githubLogin), a.githubLogin);
  }

  const logins: string[] = [];
  const seen = new Set<string>();
  for (const login of raw) {
    const key = norm(login);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    logins.push(filedSpelling.get(key) ?? login);
  }

  return { names, logins };
}
