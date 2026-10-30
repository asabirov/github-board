import { useId } from 'react';
import { boardLinkProps } from '../repos/repo-page-parts';
import { routePath } from '../route';
import { useOrgScope } from '../org-scope/OrgScopeProvider';
import { CARD_PADDING } from '../ui/block';
/**
 * The Unit page's crew — one card per team-table member (#358), and the filter
 * control over the unit queue below (#420).
 *
 * It carries no block header (#459). The three cards name everyone in the unit,
 * so a "Crew" label and a "3 members" count above them said what the cards
 * already say; both were dropped and the cards now sit straight under the page
 * heading. Every other block on the page keeps its BlockHeader — this is the one
 * region whose content is its own label.
 *
 * The card is the halo (#460). At rest it has no box at all: a member is a face
 * and a name on the page canvas, and their colour (#477) is a ring around the
 * photo — the one place on the board that already means "this person". Pressing
 * them is what summons a surface, so being selected reads as a change of
 * substance rather than a change of colour, and the hue stays free to mean
 * identity everywhere else it appears (the Projects ring, the assignee avatars
 * on issue rows). It is also why the crew leads the page: these cards are where
 * the colours are taught, and the rings below spend them.
 */
import type { Person } from '../api/people';
import { Avatar } from '../ui/avatar';
import { memberColors, memberWash } from '../member-color';
import type { RosterPerson } from './team-vm';

/** Cancel resting top padding without pulling the following notice under a card. */
const GRID_CLS =
  'grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3.5 -mt-4 max-[900px]:grid-cols-2 max-[900px]:gap-2.5';

/** The stand-in when the person table is empty or unavailable. */
const NOTICE_CLS = 'px-3 py-3.5 text-xs italic text-muted';

/** Which alias identifies this member to the colour scheme. A member with no
 *  linked Github login still has a colour — they are on the roster. */
const identityOf = (p: RosterPerson) => p.githubLogin ?? p.email ?? p.name;

export function CrewGrid({
  people,
  roster,
  isActive,
  hasSelection = roster.some(isActive),
  onToggle,
  emptyText = 'Nobody is on this unit.',
}: {
  /** The person table the colour scheme keys off (#477). */
  people: Person[];
  roster: RosterPerson[];
  /** Is this member's card pressed — i.e. is the queue narrowed to them? */
  isActive: (person: RosterPerson) => boolean;
  /** Includes assignee filters whose login is not in the displayed roster. */
  hasSelection?: boolean;
  onToggle: (person: RosterPerson) => void;
  /** The stand-in when the roster is empty. The default says the state and no
   *  more: it used to end "yet", which promises a roster that is going to fill,
   *  and this is the DEFAULT — it covers a read that came back empty as well as
   *  a unit nobody has been added to, and nobody has promised anything about the
   *  first (#1103 review, S4). `TeamView` passes its own on a failed read. */
  emptyText?: string;
}) {
  const colorOf = memberColors(people);
  if (roster.length === 0) return <div className={NOTICE_CLS}>{emptyText}</div>;
  return (
    <div className={GRID_CLS}>
      {roster.map((p) => (
        <PersonCard
          key={p.key}
          person={p}
          color={colorOf(identityOf(p))}
          active={isActive(p)}
          excluded={hasSelection && !isActive(p)}
          onToggle={() => onToggle(p)}
        />
      ))}
    </div>
  );
}

/** The one card padding (#944). A card at rest draws no box, but its avatar and
 *  name still start on the same line as every block's content below it, which at
 *  12px they did not. `relative` is what the toggle beneath is laid against. */
const CARD_CLS = `relative w-full min-w-0 rounded-xl ${CARD_PADDING}`;
/** The filter toggle fills the card from underneath (#1045), so the card's
 *  surface, hover and focus ring are the toggle's, as they were. */
const TOGGLE_CLS = 'absolute inset-0 rounded-xl transition-colors disabled:pointer-events-none focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-accent';
const LINK_FOCUS = 'rounded-md focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent';
/** Pressed summons the block surface under the member; at rest there is no box,
 *  and only a card that can filter offers the hover. */
const ACTIVE_CLS = 'cursor-pointer bg-elevated [.light_&]:bg-surface';
const REST_CLS = 'cursor-pointer bg-transparent hover:bg-surface/60';
const INERT_CLS = 'bg-transparent cursor-default';
const HALO_CLS = 'grid place-items-center rounded-full';

/** Selection keeps the ring and padding fixed; hue still identifies the person.
 *  The reporter chose a raised surface instead of an enlarged ring (#968). */
const haloStyle = (color: string) => ({
  boxShadow: `0 0 0 2px ${color}`,
  padding: 2.5,
});

/** A member with no Github photo falls back to initials, and the shared avatar
 *  paints that circle from its own hash palette — a second, unrelated colour for
 *  the same person, sitting inside their halo. Inside the halo it wears the
 *  member's own hue instead: a wash of it behind the initial, the hue itself for
 *  the letter. Elsewhere the hash palette stands, since those surfaces have no
 *  roster to read a member colour from. */
const initialsStyle = (color: string) => ({ background: memberWash(color, 18), color });

/** One roster card — a filter toggle over the unit queue (#420). Pressed → the
 *  queue narrows to this member's issues; pressed again → it clears. A member with
 *  no linked Github login can't be an assignee filter, so their card is inert.
 *
 *  The avatar and the name are the way to the member's profile (#1045), which a
 *  "View profile" link under the card used to be. A link cannot sit inside a
 *  button, so the toggle is a sibling filling the card from underneath and the
 *  content lets the pointer through to it everywhere but the two links: the
 *  avatar or the name opens the profile, anywhere else on the card filters. The
 *  avatar's link repeats the name's for the pointer only, so each member is two
 *  keyboard stops, the profile and then the toggle.
 *
 *  An included member carries no status word (#1045): "Included" was the default
 *  said on every card. An excluded one keeps its word, because a member the page
 *  is not counting changes what every figure on it means, and the dimmed ring is
 *  too faint to be that signal alone. "Selected" went with "Included": the
 *  raised surface and `aria-pressed` already say it. The word is placed under
 *  the login rather than in the flow, so it appears without moving the name and
 *  without a blank line held open on every other card. */
function PersonCard({
  person,
  color,
  active,
  excluded,
  onToggle,
}: {
  person: RosterPerson;
  color: string;
  active: boolean;
  excluded: boolean;
  onToggle: () => void;
}) {
  const { org } = useOrgScope();
  const profile = person.githubLogin ? routePath({ tab: 'people', person: person.githubLogin, org: org ?? undefined }) : null;
  const sub = person.githubLogin ? `@${person.githubLogin}` : person.email ?? '';
  const inert = person.githubLogin == null;
  // The word describes the toggle too, so a reader tabbing to it hears it.
  const excludedId = useId();
  const surface = active ? ACTIVE_CLS : inert ? INERT_CLS : REST_CLS;
  const halo = (
    <span className={`${HALO_CLS} ${excluded ? 'opacity-[0.38] grayscale-[80%]' : ''}`} style={haloStyle(color)}>
      <Avatar
        name={person.name}
        login={person.githubLogin}
        className="pj-av-lg"
        px={64}
        style={inert ? initialsStyle(color) : undefined}
      />
    </span>
  );
  const nameCls = `text-[13.5px] font-semibold ${excluded ? 'text-muted' : active ? '' : 'text-dim'}`;
  return (
    <div className={CARD_CLS}>
      {/* Above the toggle, which comes after it so the profile is the first
          stop and the first thing read. */}
      <div className="pointer-events-none relative z-[1] flex items-center gap-3">
        {profile
          ? <a {...boardLinkProps(profile)} tabIndex={-1} aria-hidden="true" className="pointer-events-auto rounded-full">{halo}</a>
          : halo}
        <div className="relative flex min-w-0 flex-col gap-0.5">
          {profile
            ? <a {...boardLinkProps(profile)} className={`pointer-events-auto self-start ${nameCls} text-link ${LINK_FOCUS}`}>{person.name}</a>
            : <span className={nameCls}>{person.name}</span>}
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted">
            {sub}
          </span>
          {excluded && <span id={excludedId} className="absolute left-0 top-full mt-1 text-[11px] leading-none text-dim">Excluded</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={inert}
        aria-pressed={active}
        aria-label={`Filter by ${person.name}`}
        aria-describedby={excluded ? excludedId : undefined}
        className={`${TOGGLE_CLS} ${surface}`}
      />
    </div>
  );
}
