import { useResponseState } from '../auth/use-response-state';
import { useRenewalSignal, useAccessEpoch } from '../sync/sync-status';
/**
 * The issue page's right-hand properties panel (#384 variant 2B, re-grouped as
 * quiet grey blocks in #404): a stack of flat filled blocks — "Issue properties"
 * (Assignees, Labels, Milestone), then one block per Projects v2 board the issue
 * sits on (headed by the board's NAME, not a repeated "Project" label, with its
 * custom-field rows), then an "Add to project" block. Grouping by fill (the
 * canonical BLOCK surface) replaced the old borderless run of rows, which stamped
 * "Project" on every board group and parted them with oversized gaps.
 *
 * The issue's own open/closed state is NOT here (#423). As a "State" row it sat
 * directly above each board's "Status" field and the two read as one field said
 * twice; it now leads the properties column as `StatePill`, so every field left
 * in the panel belongs to Github's issue or to a named board, and nothing in it
 * competes with a board's Status.
 *
 * Each control asks about its OWN write (#635) via `verdict`: an armed one mounts
 * a popover editor that writes optimistically through to GitHub and reflects back
 * via `onPatch`; a refused one keeps its row, loses the affordance and says why;
 * an unarmed reader sees the plain rows they always have. A board block's remove
 * affordance rides its header on hover, and the last block adds the issue to
 * another board. The repo edit-options catalog (labels/milestones/assignables) is
 * fetched LAZILY on the first edit-open and cached here, never on page load.
 */
import { useEffect, useId, useState } from 'react';
import { fetchEditOptions, type Actor, type IssueDetail, type IssueEditOptions } from '../api/issues';
import {
  AddProjectEditor,
  newProjectOffered,
  AssigneeEditor,
  AssigneeValue,
  FieldEditor,
  FieldValueView,
  ISSUE_CAP,
  LabelEditor,
  LabelValue,
  MilestoneEditor,
  MilestoneValue,
  NONE,
  ProjectEditor,
  WithheldRow,
} from './facet-editors';
import type { ControlVerdict } from '../refusal';
import { PropertyRow } from './PropertyRow';
import { BlockTitle, PANEL_BLOCK } from './panel-block';

export function PropertiesPanel({
  issue,
  verdict,
  onPatch,
  name,
}: {
  issue: IssueDetail;
  /** What this session may do with ONE named write (#635) — the `ISSUE_CAP` key
   *  the control depends on, answered per capability rather than per session.
   *  Required on purpose: a default would let a caller keep drawing eight
   *  controls off one boolean without anyone noticing. */
  verdict: (capability: string) => ControlVerdict;
  /** An editor reflects a successful write back into the page's issue (#384). */
  onPatch: (next: Partial<IssueDetail>) => void;
  name: (a: Actor | null) => string;
}) {
  // The repo's edit-options catalog (labels/milestones/assignables) is fetched
  // lazily on the first edit-open and shared by every editor. Once requested,
  // it renews with the issue and retains its own original deadline.
  const [editOptions, setEditOptions] = useResponseState<IssueEditOptions | null>(null, null);
  const [requested, request] = useState(0);
  const renewal = useRenewalSignal();
  const accessEpoch = useAccessEpoch();
  const loadOptions = () => { if (!editOptions) request(n => n + 1); };
  useEffect(() => {
    if (!requested) return;
    let alive = true;
    fetchEditOptions(issue.owner, issue.repo).then((o) => { if (alive) setEditOptions(o); }, () => {});
    return () => { alive = false; };
  }, [requested, renewal, accessEpoch, issue.owner, issue.repo]);

  const ed = { issue, onPatch, name, editOptions, loadOptions };

  // Each control's own verdict. `armed` mounts the editor; otherwise the row
  // itself decides whether it owes anyone a reason.
  const armed = (capability: string) => verdict(capability) === 'armed';
  // One control, one answer. `issue.project.remove` governs both the block's
  // `group` (which arms the hover reveal) and the affordance inside it, and
  // asking twice — once inside a template literal — is two places to change.
  const canRemoveProject = armed(ISSUE_CAP.projectRemove);

  // Ids for the sentences a withheld row is described by. A row points its
  // `aria-describedby` at one, so a screen reader reaching a row that cannot be
  // changed also reaches why. Per capability, not per row: `issue.field` is ONE
  // capability covering every custom field on a board, so its rows share a
  // sentence — written once, on the first of them — and all of them point at it.
  const uid = useId();
  const reasonId = (key: string) => `${uid}${key}`;

  return (
    <div className="flex flex-col gap-2.5 pt-1">
      <div className={PANEL_BLOCK}>
        <BlockTitle>Issue properties</BlockTitle>
        {/* Github's org-level issue type (#467) — Task / Bug / Feature, as the
            org defines it. It leads the block because it is the coarsest thing
            an issue is, and it sits OUTSIDE the verdict branch below: the type
            is set on Github, so the row is plain data for everyone rather than
            wearing an edit affordance that would open nothing. An issue with no
            type reads `None`, the same resting marker every other empty facet
            uses — never a type guessed from its labels. */}
        <PropertyRow label="Type">
          {issue.issueType ? <>{issue.issueType}</> : NONE}
        </PropertyRow>
        {armed(ISSUE_CAP.assignees) ? (
          <AssigneeEditor {...ed} />
        ) : (
          <WithheldRow
            verdict={verdict(ISSUE_CAP.assignees)}
            label="Assignees"
            align="center"
            reasonId={reasonId('assignees')}
          >
            <AssigneeValue assignees={issue.assignees} name={name} />
          </WithheldRow>
        )}
        {armed(ISSUE_CAP.labels) ? (
          <LabelEditor {...ed} />
        ) : (
          <WithheldRow verdict={verdict(ISSUE_CAP.labels)} label="Labels" reasonId={reasonId('labels')}>
            <LabelValue labels={issue.labels} />
          </WithheldRow>
        )}
        {armed(ISSUE_CAP.milestone) ? (
          <MilestoneEditor {...ed} />
        ) : (
          <WithheldRow verdict={verdict(ISSUE_CAP.milestone)} label="Milestone" reasonId={reasonId('milestone')}>
            <MilestoneValue milestone={issue.milestone} />
          </WithheldRow>
        )}
      </div>

      {/* One block per Projects v2 board — headed by the board NAME (#404), so
          "Project" is never repeated; the board's custom-field rows sit under it.
          The remove affordance (writer only) rides the header, revealed on hover
          via the block's `group`. */}
      {issue.projects.map((proj) => (
        <div key={proj.projectId} className={`${PANEL_BLOCK} ${canRemoveProject ? 'group' : ''}`}>
          <BlockTitle
            action={
              canRemoveProject ? (
                <ProjectEditor issue={issue} onPatch={onPatch} membership={proj} />
              ) : undefined
            }
          >
            <span className="truncate">{proj.title}</span>
          </BlockTitle>
          {proj.fields.map((f, i) =>
            armed(ISSUE_CAP.field) ? (
              <FieldEditor key={f.fieldId} issue={issue} onPatch={onPatch} membership={proj} field={f} />
            ) : (
              // Every field row on this board answers to the SAME capability, so
              // the reason is written once — on the first row — and the rest
              // point at it. Said per row it was one sentence copied down a
              // 250px column: two here, six for an issue on two boards with
              // three fields each.
              <WithheldRow
                verdict={verdict(ISSUE_CAP.field)}
                key={f.fieldId}
                label={f.name}
                reasonId={reasonId(`field-${proj.projectId}`)}
                sayReason={i === 0}
              >
                <FieldValueView field={f} value={proj.values[f.fieldId]} />
              </WithheldRow>
            ),
          )}
        </div>
      ))}

      {/* The add-to-project affordance (#404) — its own RECESSED block (a quieter
          fill than the data wells above, lifting to the well fill on hover) so it
          reads as an action slot, not a fourth data block; owns its block styling. */}
      {armed(ISSUE_CAP.projectAdd) && (
        <AddProjectEditor issue={issue} onPatch={onPatch} canCreate={newProjectOffered(verdict)} />
      )}
    </div>
  );
}
