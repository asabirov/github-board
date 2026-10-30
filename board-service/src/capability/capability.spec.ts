import { describe, expect, it } from 'vitest';
import { CAPABILITIES, isCapability } from './capability';
import type { Capability } from './capability';
import type { AuditAction } from '../audit/audit.types';

/**
 * The vocabulary is borrowed, not invented (#584), and this is what holds it
 * there. `capability.ts` says in prose that every route-backed name is an audit
 * action key; the assignment below makes the compiler say it instead, so a
 * capability misspelled against `audit.types.ts` is a red typecheck rather than
 * a name that silently matches no audit trail. `boot-alert.file` is excluded
 * because the boot notifier is audited by nothing and has no key to borrow.
 */
type RouteBacked = Exclude<Capability, 'boot-alert.file'>;
const _everyRouteBackedNameIsAnAuditAction: AuditAction = null as unknown as RouteBacked;
void _everyRouteBackedNameIsAnAuditAction;

describe('the capability vocabulary', () => {
  it('names a capability it holds and refuses one it does not', () => {
    expect(isCapability('repo.dri')).toBe(true);
    // The three an earlier draft invented. None of them is an audit key.
    for (const invented of ['issue.task', 'issue.project', 'feedback.create']) {
      expect(isCapability(invented)).toBe(false);
    }
  });

  it('does not answer for a name the prototype chain owns', () => {
    // `EDITABLE_BY` in `github-repos.source.ts` is a Map for this exact reason:
    // an object-literal lookup answers `constructor` truthily. `CAPABILITIES` is
    // an array and `includes` walks values, so it does not — pinned rather than
    // assumed, because the fallback this feeds is a permission decision.
    for (const inherited of ['constructor', 'toString', '__proto__']) {
      expect(isCapability(inherited)).toBe(false);
    }
  });

  it('holds fourteen names, none of them twice', () => {
    // A vacuity guard on the two above: a list that had lost half its entries
    // would still answer `false` to everything they assert.
    // Twelve until #693 added `issue.comment` — answering an issue from the
    // board is a write like any other, so it is a name in this vocabulary.
    // Thirteen until #982 added `issue.project.create`. Thirteen again since
    // #1450 removed `feedback.submit` with the feedback form.
    expect(CAPABILITIES).toHaveLength(13);
    expect(new Set(CAPABILITIES).size).toBe(13);
  });
});
