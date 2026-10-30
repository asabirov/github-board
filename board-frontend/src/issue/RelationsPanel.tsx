/**
 * An issue's relations (#469) — its parent, its sub-issues with how many are
 * done, and what blocks it or waits on it. We file umbrella issues with native
 * sub-issues and cross-repo blockers on purpose, so an issue page that drops the
 * relations drops the reason the issue exists.
 *
 * It renders as ONE block wearing the panel's fill, header and row grammar. An
 * issue with no relations renders nothing at all: no block, no empty rows.
 *
 * Two layouts, because the two homes have very different measures (variant B):
 *   `column` — the properties column, ~215px of usable width. A relation reads
 *     title-first with its reference beneath, the two-line grammar the board's
 *     issue rows already use; a title longer than ~35 characters ellipses.
 *   `wide` — the reading column, ~780px. The block sits above the comment
 *     timeline, and each group becomes an ordinary `PropertyRow`: label left,
 *     one line per relation right, reference then title. At that measure a
 *     title fits whole, so nothing truncates.
 *
 * Where a reference points: the board is owner-pinned to the org it mirrors, so
 * a reference under the SAME owner as the issue you are reading is one the board
 * can open, and it gets an in-board link. Anything else has no page here and
 * goes to Github. A reference in the issue's own repo is written `#NN`; every
 * other one carries its repo, `owner/repo#NN`, because that is the only way to
 * tell two `#130`s apart.
 */
import type { ReactNode } from 'react';
import type { IssueDetail, IssueRelation } from '../api/issues';
import { gotoPath, issuePath } from '../route';
import { BlockTitle, PANEL_BLOCK } from './panel-block';
import { PropertyRow } from './PropertyRow';

/** Where the block is rendered — the narrow properties column, or the wide
 *  reading column above the timeline. It changes the row grammar, nothing else:
 *  same data, same links, same emptiness rule. */
export type RelationsLayout = 'column' | 'wide';

/** True when the issue has nothing to say about its neighbours — the whole
 *  block is skipped, rather than rendered empty. */
function hasNoRelations(r: IssueDetail['relations']): boolean {
  return !r.parent && r.subIssues.length === 0 && r.blockedBy.length === 0 && r.blocking.length === 0;
}

/** `#241` in the issue's own repo, `acme/roadmap#42` anywhere else. */
function refText(host: IssueDetail, r: IssueRelation): string {
  const sameRepo = r.owner === host.owner && r.repo === host.repo;
  return sameRepo ? `#${r.number}` : `${r.owner}/${r.repo}#${r.number}`;
}

// One style set per layout, so a line's grammar is a lookup rather than a
// ternary repeated four times. `column` stacks title over reference (a title and
// `acme/acme-ui#356` cannot share ~140px); `wide` puts them on one line,
// reference first, the way a reference reads in prose.
const STYLE = {
  column: {
    line: 'group block w-full py-[4px] text-left',
    ref: 'block truncate text-[11.5px] leading-[1.45] tabular-nums text-muted',
    // A closed relation stays legible but recedes — the list reads as progress
    // without a glyph or a strikethrough doing the talking.
    titleOpen: 'block truncate text-[13px] leading-[1.45] text-fg group-hover:underline',
    titleClosed: 'block truncate text-[13px] leading-[1.45] text-muted group-hover:underline',
    refFirst: false,
  },
  wide: {
    line: 'group flex w-full min-w-0 items-baseline gap-2 py-[3px] text-left',
    ref: 'flex-none tabular-nums text-[12.5px] leading-[1.5] text-muted',
    titleOpen: 'min-w-0 truncate text-[13.5px] leading-[1.5] text-fg group-hover:underline',
    titleClosed: 'min-w-0 truncate text-[13.5px] leading-[1.5] text-muted group-hover:underline',
    refFirst: true,
  },
} as const;

const GROUP_LABEL = 'flex items-baseline justify-between gap-2 pt-2 text-[12px] leading-[1.5] text-muted';
const GROUP_FIRST = 'flex items-baseline justify-between gap-2 text-[12px] leading-[1.5] text-muted';
const COUNT_LINE = 'block pb-[2px] text-[12px] tabular-nums text-muted';

/** One relation line. In-board references navigate without a page load, the way
 *  every other issue link on the board does; off-board ones open Github in a new
 *  tab. Only the arrangement of reference and title varies by layout. */
function RelationLink({ host, relation, layout }: {
  host: IssueDetail; relation: IssueRelation; layout: RelationsLayout;
}) {
  const s = STYLE[layout];
  const title = <span className={relation.state === 'closed' ? s.titleClosed : s.titleOpen}>{relation.title}</span>;
  const ref = <span className={s.ref}>{refText(host, relation)}</span>;
  const body = s.refFirst ? <>{ref}{title}</> : <>{title}{ref}</>;
  const onBoard = relation.owner === host.owner;

  if (!onBoard) {
    return (
      <a href={relation.url} target="_blank" rel="noopener noreferrer" className={s.line} title={relation.title}>
        {body}
      </a>
    );
  }
  const path = issuePath(`${relation.owner}/${relation.repo}`, relation.number);
  return (
    <a
      href={path}
      onClick={(e) => { e.preventDefault(); gotoPath(path); }}
      className={s.line}
      title={relation.title}
    >
      {body}
    </a>
  );
}

/** One named group of relations. In the column the label sits above its lines
 *  (there is no room beside them); at the wide measure it becomes an ordinary
 *  `PropertyRow`, the same label-left grammar as every other row on the page.
 *  `first` drops the leading gap so the group under the block header doesn't sit
 *  lower than the rows in the block above. */
function Group({ label, meta, first, layout, children }: {
  label: string; meta?: string; first?: boolean; layout: RelationsLayout; children: ReactNode;
}) {
  if (layout === 'wide') {
    return (
      <PropertyRow label={label}>
        <div className="w-full">
          {meta && <span className={COUNT_LINE}>{meta}</span>}
          {children}
        </div>
      </PropertyRow>
    );
  }
  return (
    <div>
      <div className={first ? GROUP_FIRST : GROUP_LABEL}>
        <span>{label}</span>
        {meta && <span className="flex-none tabular-nums">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

function RelationList({ host, relations, layout }: {
  host: IssueDetail; relations: IssueRelation[]; layout: RelationsLayout;
}) {
  return (
    <>
      {relations.map((r) => (
        <RelationLink key={`${r.owner}/${r.repo}#${r.number}`} host={host} relation={r} layout={layout} />
      ))}
    </>
  );
}

export function RelationsPanel({ issue, layout = 'column', className }: {
  issue: IssueDetail;
  /** Defaults to the properties column; `wide` is the reading-column block. */
  layout?: RelationsLayout;
  /** Spacing from the caller — carried on the block itself so an issue with no
   *  relations leaves no empty, margin-bearing wrapper behind. */
  className?: string;
}) {
  const { relations } = issue;
  if (hasNoRelations(relations)) return null;

  const { parent, subIssues, subIssuesTotal, subIssuesClosed, blockedBy, blocking } = relations;
  // The list is a first page (the query caps it), the counts are Github's own
  // over every sub-issue — so the summary stays true past the page, and the
  // remainder is offered on Github rather than silently dropped.
  const beyondPage = subIssuesTotal - subIssues.length;
  const group = { layout };

  return (
    <div className={className ? `${PANEL_BLOCK} ${className}` : PANEL_BLOCK}>
      <BlockTitle>Relations</BlockTitle>

      {parent && (
        <Group label="Parent" first {...group}>
          <RelationLink host={issue} relation={parent} layout={layout} />
        </Group>
      )}

      {subIssues.length > 0 && (
        <Group label="Sub-issues" meta={`${subIssuesClosed} of ${subIssuesTotal} done`} first={!parent} {...group}>
          <RelationList host={issue} relations={subIssues} layout={layout} />
          {beyondPage > 0 && (
            <a
              href={issue.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block pt-[3px] text-[12px] text-muted text-link"
            >
              {beyondPage} more on GitHub
            </a>
          )}
        </Group>
      )}

      {blockedBy.length > 0 && (
        <Group label="Blocked by" first={!parent && subIssues.length === 0} {...group}>
          <RelationList host={issue} relations={blockedBy} layout={layout} />
        </Group>
      )}

      {blocking.length > 0 && (
        <Group label="Blocking" first={!parent && subIssues.length === 0 && blockedBy.length === 0} {...group}>
          <RelationList host={issue} relations={blocking} layout={layout} />
        </Group>
      )}
    </div>
  );
}
