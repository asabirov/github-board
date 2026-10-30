import { ownerId, repositoryId } from '../auth/github-target';
/**
 * Client-side search index for the ⌘K palette (#108, broadened in #214). Every
 * row bakes in the Route it navigates to, so the palette never reconstructs a
 * URL. Board-wide: people (from the shared context), the Projects boards, and
 * every tracked-repo open issue (which route to the in-board issue page, #235).
 */

import type { Person } from '../api/people';
import type { ProjectSummary } from '../api/projects';
import type { SearchIssue } from '../api/issues';
import type { Route } from '../route';

export type SearchKind = 'person' | 'project' | 'issue';

export interface SearchItem {
  kind: SearchKind;
  /** stable de-dupe key */
  id: string;
  /** short neutral chip label — the letter carries the category, not colour */
  chip: string;
  title: string;
  sub: string;
  /** internal navigation target */
  route?: Route;
  /** external link */
  href?: string;
  /** lowercased haystack for matching */
  keywords: string;
}

/** Human labels + display order for the result groups. Projects and people
 *  first (fewer, high-signal), issues last (the long tail). */
export const KIND_ORDER: SearchKind[] = ['project', 'person', 'issue'];
export const KIND_LABEL: Record<SearchKind, string> = {
  project: 'Projects',
  person: 'People',
  issue: 'Issues',
};

export function peopleItems(people: Person[]): SearchItem[] {
  return people.map((p) => ({
    kind: 'person',
    id: `person:${p.id}`,
    chip: 'P',
    title: p.displayName,
    // Subtitle names the person, falling back to the page. #420 retired the
    // per-member page, so the route is a bare `{tab:'team'}` — and prefixing a
    // login with the tab ("Overview · @octocat") reads as if the person were one.
    sub: p.githubLogin ? `@${p.githubLogin}` : 'Overview',
    route: { tab: 'team' },
    keywords: `${p.displayName} ${p.emails.join(' ')} ${p.githubLogin ?? ''} ${p.clickupNames.join(
      ' ',
    )}`.toLowerCase(),
  }));
}

export function projectItems(projects: ProjectSummary[]): SearchItem[] {
  return projects.map((p) => {
    const id = p.org ? ownerId(p.org) : undefined;
    return ({
    kind: 'project',
    // The board's whole address (#697), because `CommandPalette` keys its index
    // and its recents on this id: two orgs can both hold a board 3, and one id
    // meant one of them was silently dropped from the palette while the other
    // answered for both.
    id: id ? `project:id:${id}/${p.number}` : p.org ? `project:${p.org}/${p.number}` : `project:${p.number}`,
    chip: 'B',
    title: p.name,
    // Singular: this sits under ONE project's name, so "Projects" was naming
    // the tab rather than the thing (#694).
    sub: `Project, ${p.pct}% done, ${p.open + p.closed} issues`,
    // `org` qualifies `project` (#697): two orgs can both hold a board 3, and
    // the palette listed the same entry twice, both routing to the first.
    route: { tab: 'projects', org: p.org, project: p.number },
    keywords: `${p.name}`.toLowerCase(),
    });
  });
}

export function issueItems(issues: SearchIssue[]): SearchItem[] {
  return issues.map((i) => {
    const id = repositoryId(`${i.owner}/${i.repo}`);
    return ({
    kind: 'issue',
    id: id ? `issue:id:${id}#${i.number}` : `issue:${i.owner}/${i.repo}#${i.number}`,
    chip: '#',
    title: i.title,
    sub: `${i.repo} #${i.number}`,
    route: { tab: 'issue', issue: { owner: i.owner, repo: i.repo, number: i.number } },
    keywords: `${i.title} ${i.repo} #${i.number} ${i.number}`.toLowerCase(),
    });
  });
}

/**
 * Filter + rank. Every whitespace-separated token must appear in the haystack
 * (AND). Ranking favours a title hit over a metadata-only hit, and an earlier
 * hit over a later one. Stable within a rank (input order).
 */
export function searchItems(index: SearchItem[], query: string, limit = 50): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/);
  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of index) {
    if (!tokens.every((t) => item.keywords.includes(t))) continue;
    const title = item.title.toLowerCase();
    const ti = title.indexOf(tokens[0]);
    // lower is better: title-start (0) < title-substring < metadata-only
    const score = ti === 0 ? 0 : ti > 0 ? 1 + ti / 100 : 500 + item.keywords.indexOf(tokens[0]) / 100;
    scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.item);
}

/** Split matched items into their display groups, order preserved. */
export function groupByKind(items: SearchItem[]): { kind: SearchKind; items: SearchItem[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter(
    (g) => g.items.length > 0,
  );
}
