import 'reflect-metadata'; // LINE 1. `PATH_METADATA` reads return undefined without it.
import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CAPABILITIES, ISSUE_EDITOR_CAPABILITIES } from './capability';
import { declaredWritesOf, type DeclaredWrite } from './writes-metadata-discovery.contract';

/**
 * `ISSUE_EDITOR_CAPABILITIES` is what `/api/auth/me` aggregates `canWrite` over
 * (#626), so the set has to be what the editor actually writes — not a list that
 * merely looked right when it was written.
 *
 * It is derived from `CAPABILITIES` by the `issue.` prefix, which stops it being
 * a second spelling of nine names. This suite closes the other half: that the
 * prefix and the editor agree. An eleventh issue route added without a capability,
 * an `issue.*` capability no route exercises, or a rename on either side lands
 * here rather than silently widening or narrowing what one refusal darkens.
 *
 * The discovery is `declaredWritesOf` — the same function `writes-declared.spec.ts`
 * gates the whole board with, not a predicate rebuilt here.
 */
const CONTROLLER = join(__dirname, '../issue-detail/issue-detail.controller.ts');

let routes: DeclaredWrite[] = [];

beforeAll(async () => {
  const mod = (await import(pathToFileURL(CONTROLLER).href)) as Record<string, unknown>;
  for (const exported of Object.values(mod)) routes.push(...declaredWritesOf(exported));
});

describe('the issue-editor capability set (#626)', () => {
  it('found the editor’s write routes, and not a fraction of them', () => {
    // A FLOOR. Every assertion below passes on an empty list — an import that
    // resolved to nothing, a renamed controller, a discovery that stopped
    // descending — and would then be pinning the set against nothing at all.
    expect(routes.length, `metadata discovery found ${routes.length} write routes`).toBeGreaterThanOrEqual(10);
  });

  it('every write route on the editor declares what it writes', () => {
    // Without this the union is short by exactly the routes that forgot, and the
    // equality below would then pass by agreeing with a hole.
    expect(routes.filter((r) => r.caps === undefined).map((r) => r.key)).toEqual([]);
  });

  it('is exactly the union of @Writes on IssueDetailController’s write routes', () => {
    const union = [...new Set(routes.flatMap((r) => r.caps ?? []))].sort();
    expect(union).toEqual([...ISSUE_EDITOR_CAPABILITIES].sort());
  });

  it('is derived from CAPABILITIES by the prefix, and is a strict subset of it', () => {
    // The derivation itself, so a hand-typed replacement of the filter fails
    // here: the set must be every `issue.` name in the vocabulary and nothing
    // else, and it must leave the three the editor does not write behind.
    expect([...ISSUE_EDITOR_CAPABILITIES].sort()).toEqual(
      CAPABILITIES.filter((c) => c.startsWith('issue.')).sort(),
    );
    for (const cap of ISSUE_EDITOR_CAPABILITIES) expect(CAPABILITIES).toContain(cap);
    for (const outside of ['repo.dri', 'boot-alert.file'] as const) {
      expect(ISSUE_EDITOR_CAPABILITIES).not.toContain(outside);
    }
    // Nine until #693 added `issue.comment` and the route that writes it, ten
    // until #982 added `issue.project.create`.
    expect(ISSUE_EDITOR_CAPABILITIES).toHaveLength(11);
  });
});
