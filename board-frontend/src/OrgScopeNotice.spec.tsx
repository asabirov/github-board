import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrgScopeNotice } from './OrgScopeNotice';
import type { OrgReadState } from './api/types';
import { reassuringWordIn } from './reassuring-words';
import { orgScopeSentences } from './auth/org-scope-copy';

// The board's test env is `node`, so — same rationale as Pulse.spec.tsx — render
// to a static HTML string and assert against the markup.
const read = (org: string): OrgReadState => ({ org, state: 'read', reason: null });
const unread = (org: string, reason: string | null = null): OrgReadState =>
  ({ org, state: 'unreadable', reason });

const html = (orgs: OrgReadState[]) => renderToStaticMarkup(<OrgScopeNotice orgs={orgs} />);

describe('the org-scope notice (#650)', () => {
  it('names the org the session could not read', () => {
    const markup = html([read('acme'), unread('globex')]);
    expect(markup).toContain('globex');
    expect(markup).toContain('could not read it');
  });

  it('shows Github’s reason when there is one', () => {
    expect(html([unread('globex', 'Bad credentials')])).toContain('Bad credentials');
  });

  it('renders NOTHING when every org was read — not a byte, not a reassurance', () => {
    // Not "renders a quiet all-read line": an empty string is the proof that the
    // page around it is unchanged, because a component that emits zero bytes
    // cannot move anything.
    expect(html([read('acme'), read('globex')])).toBe('');
  });

  it('renders NOTHING on an empty orgs list — the old-deploy case', () => {
    // api.ts reads an absent `orgs` as []. This is the whole old-deploy promise,
    // proved rather than asserted: zero bytes, so such a deploy draws exactly
    // what it draws today.
    expect(html([])).toBe('');
  });

  // The sweep runs over the SENTENCES, not the markup. Stripping tags off
  // rendered HTML to recover the words was a second derivation of what this
  // component says, and it had to strip attributes too — the class names are
  // full of words nobody reads. `orgScopeSentences` is the first derivation:
  // exactly the strings the JSX below puts on screen, and the same ones the
  // copy module's own sweep uses.
  it('spends no reassuring word in any state it can render', () => {
    for (const orgs of [[], [read('a')], [unread('a')], [unread('a', 'Bad credentials'), unread('b')]]) {
      for (const sentence of orgScopeSentences(orgs)) {
        expect(reassuringWordIn(sentence), JSON.stringify(orgs)).toBeUndefined();
      }
    }
  });

  // …and the sentences swept above are the ones actually rendered, so the sweep
  // cannot go quietly out of date if the JSX stops drawing one of them.
  it('renders every sentence the sweep covers', () => {
    const orgs = [unread('globex', 'Bad credentials')];
    const markup = html(orgs);
    const sentences = orgScopeSentences(orgs);
    expect(sentences).toHaveLength(2);
    for (const sentence of sentences) expect(markup).toContain(sentence);
  });

  it('carries no border and no all-caps label — house style, in the markup', () => {
    const markup = html([unread('globex', 'Bad credentials')]);
    expect(markup).not.toMatch(/border/);
    expect(markup).not.toMatch(/uppercase/);
    expect(markup).not.toMatch(/[✓✔☑↗]/);
    // The house spelling on screen, which #979 turned round: this line held
    // "GitHub" out when the board still wrote "Github". SPELLINGS in
    // scripts/copy-gate/gate.mjs says why.
    expect(markup).not.toContain('Github');
  });
});
