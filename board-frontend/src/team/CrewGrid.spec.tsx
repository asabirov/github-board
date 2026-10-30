import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CrewGrid } from './CrewGrid';
import { BLOCK_LABEL } from '../ui/BlockHeader';
import type { RosterPerson } from './team-vm';
import type { Person } from '../api/people';

// The board's test env is `node` (no DOM), so — same rationale as
// ProjectBlock.spec.tsx — render to a static HTML string and assert on markup.

function person(o: Partial<RosterPerson>): RosterPerson {
  return { key: 'a@example.com', slug: 'octocat', githubLogin: 'octocat', name: 'Octocat', email: 'a@example.com', ...o };
}

const roster = [
  person({ key: 'a@example.com', name: 'Octocat', githubLogin: 'octocat' }),
  person({ key: 'i@example.com', name: 'Ivan Petrov', githubLogin: 'ivanp' }),
  person({ key: 'x@example.com', name: 'Anton Volkov', githubLogin: null, email: 'x@example.com' }),
];

/** The person table the colour scheme keys off — same three people. */
const people: Person[] = roster.map((p) => ({
  id: p.key,
  displayName: p.name,
  emails: [p.email ?? p.key],
  clickupNames: [],
  githubLogin: p.githubLogin,
}));

describe('CrewGrid (#459/#460/#477)', () => {
  it('names every member on their own card', () => {
    const html = renderToStaticMarkup(<CrewGrid people={people} roster={roster} isActive={() => false} onToggle={() => {}} />);
    expect(html).toContain('Octocat');
    expect(html).toContain('Ivan Petrov');
    expect(html).toContain('Anton Volkov');
    expect(html).toContain('@octocat');
    // No linked Github login → the card falls back to the email and goes inert.
    expect(html).toContain('x@example.com');
    expect(html).toContain('disabled');
    // #1045: an included member carries no status word and no separate link.
    expect(html).not.toContain('Included');
    expect(html).not.toContain('View profile');
    expect(html).not.toContain('opacity-[0.38]');
  });

  it('links the avatar and the name to the profile, beside the toggle and not inside it (#1045)', () => {
    const html = renderToStaticMarkup(<CrewGrid people={people} roster={roster} isActive={() => false} onToggle={() => {}} />);
    // Avatar and name, for each member with a Github login; none for the inert one.
    expect(html.match(/<a [^>]*href="[^"]*\/octocat"/g)).toHaveLength(2);
    expect(html.match(/<a [^>]*href="[^"]*\/ivanp"/g)).toHaveLength(2);
    expect(html.match(/<a /g)).toHaveLength(4);
    // One keyboard stop per profile: the avatar's link is the name's, repeated
    // for the pointer and kept out of the tab order and the reading.
    expect(html.match(/<a [^>]*tabindex="-1"[^>]*aria-hidden="true"/g)).toHaveLength(2);
    // Every toggle is empty, so no link is nested in one, and each is named.
    expect(html.match(/<button [^>]*><\/button>/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Filter by Octocat"');
    expect(html).toContain('aria-label="Filter by Anton Volkov"');
  });

  it('carries no block header — neither a "Crew" label nor a member count', () => {
    const html = renderToStaticMarkup(<CrewGrid people={people} roster={roster} isActive={() => false} onToggle={() => {}} />);
    expect(html).not.toContain('Crew');
    expect(html).not.toContain('3 members');
    // The label treatment itself is absent, not just the word.
    expect(html).not.toContain(BLOCK_LABEL);
  });

  it('rings every member in their own colour (#477)', () => {
    const html = renderToStaticMarkup(<CrewGrid people={people} roster={roster} isActive={() => false} onToggle={() => {}} />);
    const hues = [...html.matchAll(/0 0 0 \dpx (var\(--seg-[^)]+\))/g)].map((m) => m[1]);
    expect(hues).toHaveLength(roster.length);
    expect(new Set(hues).size).toBe(roster.length);
  });

  it('keeps the identity ring unchanged when selected (#968)', () => {
    const ring = (active: boolean) =>
      renderToStaticMarkup(
        <CrewGrid people={people} roster={[roster[0]]} isActive={() => active} onToggle={() => {}} />,
      ).match(/0 0 0 (\dpx var\(--seg-[^)]+\))/)![1];
    const [rest, pressed] = [ring(false), ring(true)];
    expect(rest).toBe(pressed);
  });

  it('marks a filtered member pressed (#420)', () => {
    const html = renderToStaticMarkup(
      <CrewGrid people={people} roster={roster} isActive={(p) => p.githubLogin === 'ivanp'} onToggle={() => {}} />,
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    // The pressed card says so with its surface and `aria-pressed`; only the
    // members the page is not counting carry a word (#1045).
    expect(html).not.toContain('Selected');
    expect(html.match(/>Excluded</g)).toHaveLength(2);
    expect(html.match(/opacity-\[0.38\]/g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    // The word describes each excluded member's toggle, so it is heard on Tab.
    const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
    expect(described).toHaveLength(2);
    for (const id of described) expect(html).toContain(`id="${id}" class="absolute left-0 top-full mt-1 text-[11px] leading-none text-dim">Excluded<`);
  });

  it('quiets the roster when the assignee filter names someone outside it', () => {
    const html = renderToStaticMarkup(
      <CrewGrid people={people} roster={roster} hasSelection isActive={() => false} onToggle={() => {}} />,
    );
    expect(html.match(/>Excluded</g)).toHaveLength(roster.length);
    expect(html).not.toContain('>Included<');
  });

  it('shows the empty notice in place of the cards', () => {
    const html = renderToStaticMarkup(
      <CrewGrid people={people} roster={[]} isActive={() => false} onToggle={() => {}} emptyText="The unit roster couldn’t be read just now." />,
    );
    expect(html).toContain('The unit roster couldn’t be read just now.');
    expect(html).not.toContain('<button');
  });
});
