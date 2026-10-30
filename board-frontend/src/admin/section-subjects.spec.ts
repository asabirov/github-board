import { describe, expect, it } from 'vitest';
import { ACCESS_SUBJECT } from './AccessSection';
import { AUDIT_LOG } from './AuditSection';
import { ADMIN_SECTIONS } from './sections';

/**
 * A pane's failed-read sentence says the pane's own name, and the name a reader
 * has is the one in the chrome (#1081 review, S1).
 *
 * `session-copy.ts` asks each caller for "the reader's name for the thing, not
 * the code's". Both panes here have one already: the rail row in
 * `sections.tsx`, which is also the H1 drawn directly above the sentence. The
 * Access pane briefly said "people and roles" instead — accurate about the
 * table under it, and a third name for a surface the chrome labels "Access"
 * twice on the same screen.
 *
 * Held as a match against the label rather than as two pinned strings, so
 * renaming a section in `sections.tsx` fails here instead of leaving the
 * sentence saying the old name.
 */
const label = (id: string) => ADMIN_SECTIONS.find((s) => s.id === id)?.label;

describe('an admin pane names itself the way its rail does', () => {
  it('Access says "Access"', () => {
    expect(label('access')).toBe('Access');
    expect(ACCESS_SUBJECT).toBe(label('access'));
  });

  it('Audit log says "the audit log" — the label with the article a sentence needs', () => {
    expect(label('audit')).toBe('Audit log');
    expect(AUDIT_LOG).toBe(`the ${label('audit')!.toLowerCase()}`);
  });
});
