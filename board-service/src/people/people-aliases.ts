/**
 * Cross-system identity aliases (#73). The Google team group answers WHO is
 * on the team (and leaving it is what "departed" means — same event that
 * revokes app access). What no API can answer is that GitHub `octocat`,
 * ClickUp "Octocat" and octocat@example.com are one person — that linkage
 * lives here, keyed by email.
 *
 * Small team, rare changes: editing this file is a one-line PR. Group members
 * with no alias entry still appear on the roster (display name derived from
 * the email), they just won't attract GitHub/ClickUp identities until mapped.
 */

export interface PersonAliases {
  displayName: string;
  /**
   * All emails this person appears under (group, ClickUp, GitHub noreply…).
   *
   * The work address belongs here even when the roster card would link without
   * it (#520): buildPeople can fall back to matching the email's local part
   * against the display name, but nothing else does. `githubLoginFor` only reads
   * this list, so an entry with a login and no address answers null — and since
   * this table is what answers when the roster has no handle for somebody, that
   * person's home page shows zeros over "No Github identity linked to your
   * account yet".
   */
  emails: string[];
  /** ClickUp identity strings: DRI full names and usernames. */
  clickupNames: string[];
  githubLogin: string | null;
  /** ClickUp numeric user id (DB-backed identities only) — enables a link. */
  clickupUserId?: string | null;
}

export const PEOPLE_ALIASES: PersonAliases[] = [
  {
    displayName: 'Octocat',
    emails: ['octocat@example.com', 'octocat@example.org'],
    clickupNames: ['Octocat'],
    githubLogin: 'octocat',
  },
  {
    displayName: 'Hubot',
    emails: ['hubot@example.com', 'hubot@example.org'],
    clickupNames: ['Hubot'],
    githubLogin: 'hubot',
  },
  {
    displayName: 'Monalisa',
    emails: ['monalisa@example.com'],
    clickupNames: ['Monalisa'],
    githubLogin: 'monalisa',
  },
];

/** The wire shape of /api/people. */
export interface Person {
  /** Stable id — the person's group email (lowercased). */
  id: string;
  displayName: string;
  emails: string[];
  clickupNames: string[];
  githubLogin: string | null;
  clickupUserId: string | null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** "anton.khovanskiy@x.com" → "anton khovanskiy" (dots/dashes/underscores → spaces). */
function emailNameOf(email: string): string {
  const local = norm(email).split('@')[0] ?? '';
  return local.replace(/[._-]+/g, ' ').trim();
}

/** "monalisa@x.com" → "Monalisa" (fallback display name). */
function titleCaseEmail(email: string): string {
  return emailNameOf(email)
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Alias entry matching an identity string (display name, historic imported
 *  name, GitHub login, or email). Case-insensitive; null when nobody matches. */
function aliasOfIdentity(identity: string): PersonAliases | null {
  const n = norm(identity);
  if (!n) return null;
  return (
    PEOPLE_ALIASES.find(
      (a) =>
        norm(a.displayName) === n ||
        (a.githubLogin !== null && norm(a.githubLogin) === n) ||
        a.clickupNames.some((x) => norm(x) === n) ||
        a.emails.some((x) => norm(x) === n),
    ) ?? null
  );
}

/**
 * Resolve a person identity string (display name, historic imported name,
 * GitHub login, or email) to the person's GitHub login via the alias table.
 * Case-insensitive; null when the identity matches nobody.
 *
 * This is the FALLBACK half of that question, not the answer (#520). Surfaces
 * ask `GithubLoginResolver`, which puts the admin-editable roster first and
 * lands here when the roster holds no handle for the address — so a person the
 * roster has never heard of keeps resolving exactly as they always did, and
 * nobody has to ship a deploy to correct a handle.
 *
 * Note this path has NO local-part fallback: `buildPeople` will link
 * `monalisa@…` to "Monalisa" by name, and this will not. An
 * entry needs the address written down to be reachable here.
 */
export function githubLoginFor(identity: string): string | null {
  return aliasOfIdentity(identity)?.githubLogin ?? null;
}

export interface BuildPeopleOpts {
  /**
   * Domains where the email-local-part ↔ displayName fallback may link
   * (the workspace domain of the team group). Without this fence, any
   * outside address whose local part title-cases to a teammate's name
   * (monalisa@gmail.com) silently captures that person's identity
   * and work attribution. Explicit alias emails always link, any domain.
   */
  nameMatchDomains?: string[];
}

function aliasFor(email: string, aliases: PersonAliases[], opts?: BuildPeopleOpts): PersonAliases | null {
  const e = norm(email);
  const byEmail = aliases.find((a) => a.emails.some((x) => norm(x) === e));
  if (byEmail) return byEmail;
  // GitHub-only sign-in lists people by their GitHub login, so the roster's
  // key is a login as often as an address (#1450).
  const byLogin = aliases.find((a) => a.githubLogin !== null && norm(a.githubLogin) === e);
  if (byLogin) return byLogin;
  if (opts?.nameMatchDomains) {
    const domain = e.split('@')[1] ?? '';
    if (!opts.nameMatchDomains.map(norm).includes(domain)) return null;
  }
  return aliases.find((a) => emailNameOf(email) === norm(a.displayName)) ?? null;
}

/**
 * Merge group member emails with the alias table into the roster people.
 * One Person per member email — except when several member emails map to the
 * same alias entry (personal + work address both in the group): first wins,
 * later addresses fold into that person's email list.
 */
export function buildPeople(
  memberEmails: string[],
  aliases: PersonAliases[],
  opts?: BuildPeopleOpts,
): Person[] {
  const people: Person[] = [];
  const claimed = new Map<PersonAliases, Person>();
  const seen = new Set<string>();
  for (const email of memberEmails) {
    const id = norm(email);
    // Skip blanks and literal duplicates — a doubled entry in the member list
    // (e.g. a typo in BOARD_ALLOWED_GITHUB) must not resurrect the
    // duplicate-card bug this table exists to fix (#76).
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const alias = aliasFor(id, aliases, opts);
    if (alias) {
      const prior = claimed.get(alias);
      if (prior) {
        // Second group address of the same person: one card, but keep the
        // address so email-based identity resolution still finds them.
        if (!prior.emails.includes(id)) prior.emails.push(id);
        continue;
      }
      const person: Person = {
        id,
        displayName: alias.displayName,
        emails: [...new Set([id, ...alias.emails.map(norm)])],
        clickupNames: alias.clickupNames,
        githubLogin: alias.githubLogin,
        clickupUserId: alias.clickupUserId ?? null,
      };
      claimed.set(alias, person);
      people.push(person);
    } else {
      people.push({
        id,
        displayName: titleCaseEmail(id) || id,
        emails: [id],
        clickupNames: [],
        githubLogin: null,
        clickupUserId: null,
      });
    }
  }
  return people;
}
