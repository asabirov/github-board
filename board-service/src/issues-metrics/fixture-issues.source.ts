import { composeIssue, hasSubmissionFooter } from '../auth/submission-footer';
import type { CloseReason } from './close-reason';
import { IIssuesSource, RawIssue } from './issues-metrics.types';

const DAY_MS = 86_400_000;

/** A submission body exactly as `composeIssue` writes one — built BY it rather
 *  than copied, so this fixture cannot describe a shape the form has stopped
 *  writing. It could before: the copy here spelled out message-then-footer and
 *  went on saying so after #749 moved the attribution to the front. The rows
 *  below run through the real matcher rather than asserting a flag by hand
 *  (#516), and that matcher is position-blind, so the move changes nothing this
 *  fixture proves. */
const SUBMISSION_BODY = composeIssue(
  {
    category: 'bug',
    message: [
      'my weekly report never arrives and the button just spins',
      '',
      'I click Send report and the spinner runs forever. Nothing lands in my inbox.',
    ].join('\n'),
    submitterEmail: 'octocat@example.org',
  },
  [],
).body;

// Deterministic, plausible local dataset (#120). Dates are generated relative
// to "now" at call time so the rolling-12-week surface stays populated no
// matter when the fixture is run — and, since #817, so does the calendar grid,
// whose closes reach back over fourteen months (see the tail of SEED); the
// spread is index-derived (no randomness) so repeated calls are stable within a
// request.
const SEED: Array<{
  repo: string;
  assignees: string[];
  labels: string[];
  milestone: string | null;
  createdDaysAgo: number;
  closedDaysAgo: number | null;
  /** Why a closed row closed (#1014). Absent means `completed`, which is what
   *  the overwhelming majority of rows are and what every row here meant before
   *  the field existed. The three states a developer has to be able to SEE are
   *  seeded explicitly below — a completed close, a not-planned one, and one
   *  whose reason is null — because the null case is the lenient branch of
   *  `deliveredCloseAt` and fixture mode is the only place anyone meets it. */
  closeReason?: CloseReason;
  title: string;
  author?: string;
  /** The issue body, when a row needs one. Only the submissions do — every other
   *  row's marker is read off an absent body, which is no footer (#516). */
  body?: string;
  /** Pin the issue number instead of taking the seed's index-derived one. The
   *  two submissions pin theirs so this fixture and the issue-detail fixture
   *  describe the SAME issues — which is what lets the relations gate be driven
   *  end to end against a real indexed mark (#516). */
  number?: number;
}> = [
  // Fifteen of the open rows below carry `triage:` labels (#1099), because the
  // Group by menu derives Size / Priority / Route from them and a fixture with
  // none of them offers those groupings to nobody running locally. Most rows
  // deliberately carry none: the untriaged stack is the biggest thing a Size
  // grouping has to say, and a fixture where everything is triaged would hide
  // that the queue draws it. Two rows carry `triage:effort:<n>`, the
  // three-segment shape, so the derived path — a family nothing in this repo
  // knows the name of — is visible in the running app and not only in a test.
  { repo: 'acme', assignees: ['hubot'], labels: ['roadmap-kr'], milestone: 'C3', createdDaysAgo: 40, closedDaysAgo: 33, title: 'Selgeo sees rollout events in shared memory' },
  { repo: 'acme', assignees: ['octocat'], labels: ['discovery', 'triage:P3', 'triage:S', 'triage:defer'], milestone: 'C3', createdDaysAgo: 32, closedDaysAgo: null, title: 'Reconcile legacy architecture docs' },
  { repo: 'acme', assignees: ['octocat'], labels: ['research', 'triage:P3', 'triage:effort:1'], milestone: 'C3', createdDaysAgo: 31, closedDaysAgo: null, title: 'Schema gap analysis from June talk' },
  { repo: 'acme', assignees: [], labels: ['compliance-request', 'sanctions', 'triage:P2', 'triage:M'], milestone: 'C3', createdDaysAgo: 30, closedDaysAgo: null, title: 'Sanctions screening: list S1 coverage' },
  { repo: 'acme', assignees: [], labels: ['compliance-request', 'triage:P2', 'triage:S', 'triage:agent'], milestone: 'C3', createdDaysAgo: 6, closedDaysAgo: null, title: 'Sanctions screening: list S2 coverage' },
  { repo: 'acme', assignees: ['hubot'], labels: ['bug'], milestone: 'C3', createdDaysAgo: 5, closedDaysAgo: 4, title: 'Fix brain query timeout on cold start' },
  { repo: 'acme', assignees: ['monalisa'], labels: ['ux'], milestone: 'C3', createdDaysAgo: 12, closedDaysAgo: 9, title: 'Tighten onboarding invite copy' },
  { repo: 'acme', assignees: ['hubot'], labels: ['roadmap-kr', 'triage:P2', 'triage:effort:3'], milestone: 'C3', createdDaysAgo: 20, closedDaysAgo: null, title: 'Instrument shared-memory reads' },
  { repo: 'acme', assignees: ['octocat'], labels: ['epic', 'triage:P1', 'triage:XL', 'triage:owner'], milestone: 'C3', createdDaysAgo: 3, closedDaysAgo: null, title: 'Compliance epic: rails funding' },
  { repo: 'acme', assignees: [], labels: ['operational'], milestone: 'C2', createdDaysAgo: 55, closedDaysAgo: 50, title: 'Rotate service-account keys' },
  { repo: 'acme', assignees: ['hubot'], labels: ['bug'], milestone: 'C3', createdDaysAgo: 2, closedDaysAgo: 1, title: 'Handle empty confidence label' },
  { repo: 'acme', assignees: [], labels: ['sanctions', 'triage:P2', 'triage:S'], milestone: 'C3', createdDaysAgo: 4, closedDaysAgo: null, title: 'Sanctions: S3 list ingest' },
  { repo: 'acme', assignees: ['monalisa'], labels: ['enhancement'], milestone: 'C3', createdDaysAgo: 8, closedDaysAgo: 6, title: 'Add cycle filter to roadmap' },
  // Old enough to be aging (#478), like the submission below it: /api/issues/metrics
  // carries titles only for the aging set, and required-scopes.integration.spec.ts
  // needs an ORDINARY team issue there as the control the redaction must not touch.
  { repo: 'acme', assignees: [], labels: ['blocker', 'triage:P0', 'triage:L', 'triage:owner'], milestone: 'C3', createdDaysAgo: 44, closedDaysAgo: null, title: 'Auth: MCP token scope leak' },
  { repo: 'board', assignees: [], labels: ['enhancement'], milestone: null, createdDaysAgo: 9, closedDaysAgo: 2, title: 'Roadmap left-rail cycle overview' },
  { repo: 'board', assignees: [], labels: ['enhancement'], milestone: null, createdDaysAgo: 7, closedDaysAgo: 0.3, title: 'Modal dialogs for create/edit flows' },
  { repo: 'board', assignees: [], labels: ['bug'], milestone: null, createdDaysAgo: 3, closedDaysAgo: 2, title: 'Fix codeless annual KR dead-end' },
  { repo: 'board', assignees: [], labels: ['enhancement', 'triage:P3', 'triage:XS', 'triage:agent'], milestone: null, createdDaysAgo: 1, closedDaysAgo: null, title: 'Issue metrics surface' },
  { repo: 'board', assignees: [], labels: ['design'], milestone: null, createdDaysAgo: 0.5, closedDaysAgo: 0.2, title: 'Drop Instrument Serif' },
  { repo: 'board', assignees: [], labels: ['bug'], milestone: null, createdDaysAgo: 14, closedDaysAgo: 7, title: 'Sliding nav peek stays open on drill' },
  { repo: 'acme', assignees: ['octocat'], labels: ['deliverable', 'triage:P1', 'triage:L', 'triage:owner'], milestone: 'C3', createdDaysAgo: 25, closedDaysAgo: null, title: 'Ship-infra: jobs as first-class' },
  { repo: 'acme', assignees: ['hubot'], labels: ['roadmap-kr'], milestone: 'C3', createdDaysAgo: 45, closedDaysAgo: 40, title: 'Seat lift behind invite flag' },
  { repo: 'acme', assignees: [], labels: ['feedback'], milestone: 'C3', createdDaysAgo: 60, closedDaysAgo: 13, title: 'Customer: Selgeo weekly digest ask' },
  { repo: 'acme', assignees: ['monalisa'], labels: ['operational'], milestone: 'C3', createdDaysAgo: 70, closedDaysAgo: 23, title: 'Migrate deploy to overview stack' },
  // A few typed issues on the signed-in dev user (octocat) so the personal
  // "Your work" queue (#206) has bugs/features/blockers to group locally.
  { repo: 'board', assignees: ['octocat'], labels: ['bug', 'blocker', 'triage:P0', 'triage:M', 'triage:owner'], milestone: null, createdDaysAgo: 9, closedDaysAgo: null, title: 'board-api crash-loops in compiled prod on optional DI' },
  { repo: 'board', assignees: ['octocat'], labels: ['enhancement', 'triage:P2', 'triage:L', 'triage:agent'], milestone: null, createdDaysAgo: 1, closedDaysAgo: null, title: 'Split Dashboard into Personal + Unit pages' },
  // Triaged and nothing else: the row the Label grouping's "No label" stack
  // exists for (#1099). It skips the `triage:` labels, so without this stack
  // this issue would be the one that left the grouping.
  { repo: 'board', assignees: ['octocat'], labels: ['triage:P3', 'triage:XL'], milestone: null, createdDaysAgo: 1, closedDaysAgo: null, title: 'Command palette: search across all board data' },
  { repo: 'acme', assignees: ['octocat'], labels: ['bug', 'triage:P1', 'triage:XS', 'triage:agent'], milestone: 'C3', createdDaysAgo: 6, closedDaysAgo: null, title: 'Kit preset drops the 3.5 spacing step' },
  { repo: 'board', assignees: ['octocat'], labels: ['enhancement'], milestone: null, createdDaysAgo: 3, closedDaysAgo: 1, title: 'Access & Agents hub + account menu' },
  // A feedback submission (#497): the board's own repo under the `feedback`
  // label, which is what the old form filed (`submission-footer.ts`), and a title that IS
  // the first line of somebody's message. Old enough to land on the metrics
  // stale tile, so every title-bearing surface carries it locally and the
  // visibility rule has something real to hide.
  { repo: 'board', assignees: ['octocat'], labels: ['feedback', 'bug'], milestone: null, createdDaysAgo: 90, closedDaysAgo: null, title: '[Bug] my weekly report never arrives and the button just spins', body: SUBMISSION_BODY, number: 901 },
  // The same submission after ordinary triage swapped `feedback` for `bug` — the
  // whole of #516 (#512 in production has already picked up `bug` and `in
  // progress` alongside its `feedback`). Its labels no longer say what it is; the
  // footer in its body still does. It sits in the fixture from now on so every
  // surface that reads the shared cache carries a relabelled submission, and a
  // regression shows up here rather than in production.
  { repo: 'board', assignees: ['octocat'], labels: ['bug', 'in progress', 'triage:P1', 'triage:S'], milestone: null, createdDaysAgo: 88, closedDaysAgo: null, title: '[Bug] the digest email arrives empty every second week', body: SUBMISSION_BODY, number: 902 },
  // A year and a bit of closed work behind the rows above (#817). The calendar
  // grid draws a whole year, so a fixture whose oldest close was 50 days old
  // could only ever produce a grid that is empty for eleven months of it — and
  // an empty grid cannot show whether the frontend draws an unobserved month
  // differently from a quiet one.
  //
  // Three properties are deliberate, and a re-recorded `team-api.json` carries
  // all three. Closes reach back 437 days, past the 426 that make 14 months.
  // They thin out with age — roughly nine a month in the rows above, then two,
  // then one, then one every six weeks — because a young board really does look
  // like that and a flat year of one-a-day would hide any scale the grid picks.
  // And days 84 through 95 carry nothing at all: a whole quiet fortnight in the
  // middle of the busy end, so the grid has somewhere to show its empty cell
  // against its faintest filled one.
  //
  // Numbers are PINNED from 300 so the index-derived block stays exactly the
  // #100-129 that `fixture-projects.source.ts` and `issues-metrics.service.spec`
  // both name. Every row is closed and older than the 90-day time-to-close
  // window, so none of them moves a headline these fixtures are already read for.
  { repo: 'acme', assignees: ['hubot'], labels: ['bug'], milestone: 'C2', createdDaysAgo: 60, closedDaysAgo: 54, title: 'Retry shared-memory writes on a cold replica', number: 300 },
  { repo: 'board', assignees: [], labels: ['enhancement'], milestone: null, createdDaysAgo: 66, closedDaysAgo: 57, title: 'Cycle picker keeps its selection across pages', number: 301 },
  { repo: 'acme', assignees: ['monalisa'], labels: ['ux'], milestone: 'C2', createdDaysAgo: 71, closedDaysAgo: 62, title: 'Invite email: one call to action, not three', number: 302 },
  { repo: 'board', assignees: ['octocat'], labels: ['bug'], milestone: null, createdDaysAgo: 74, closedDaysAgo: 68, title: 'Queue drops its scroll position on refresh', number: 303 },
  { repo: 'acme', assignees: ['hubot'], labels: ['roadmap-kr'], milestone: 'C2', createdDaysAgo: 90, closedDaysAgo: 75, title: 'Rollout events carry the actor that caused them', number: 304 },
  { repo: 'acme', assignees: [], labels: ['operational'], milestone: 'C2', createdDaysAgo: 95, closedDaysAgo: 83, title: 'Move nightly backups off the shared bucket', number: 305 },
  { repo: 'board', assignees: ['octocat'], labels: ['enhancement'], milestone: null, createdDaysAgo: 108, closedDaysAgo: 96, title: 'Roadmap: collapse a cycle to its headline', number: 306 },
  { repo: 'acme', assignees: ['monalisa'], labels: ['bug'], milestone: 'C2', createdDaysAgo: 121, closedDaysAgo: 110, title: 'Seat count double-charges a re-invited member', number: 307 },
  { repo: 'acme', assignees: ['hubot'], labels: ['enhancement'], milestone: 'C2', createdDaysAgo: 140, closedDaysAgo: 128, title: 'Expose brain query timings on the health page', number: 308 },
  { repo: 'board', assignees: [], labels: ['design'], milestone: null, createdDaysAgo: 149, closedDaysAgo: 141, title: 'Stat tiles read at a phone width', number: 309 },
  { repo: 'acme', assignees: ['octocat'], labels: ['discovery'], milestone: 'C2', createdDaysAgo: 178, closedDaysAgo: 160, title: 'Where the compliance queue actually stalls', number: 310 },
  { repo: 'acme', assignees: ['hubot'], labels: ['bug'], milestone: 'C1', createdDaysAgo: 199, closedDaysAgo: 188, title: 'Webhook replay skips the first event of a batch', number: 311 },
  { repo: 'board', assignees: ['octocat'], labels: ['enhancement'], milestone: null, createdDaysAgo: 220, closedDaysAgo: 205, title: 'Sliding nav remembers where you came from', number: 312 },
  { repo: 'acme', assignees: ['monalisa'], labels: ['operational'], milestone: 'C1', createdDaysAgo: 250, closedDaysAgo: 232, title: 'Split staging credentials off the production role', number: 313 },
  { repo: 'acme', assignees: ['hubot'], labels: ['roadmap-kr'], milestone: 'C1', createdDaysAgo: 281, closedDaysAgo: 260, title: 'First shared-memory read from a second org', number: 314 },
  { repo: 'board', assignees: [], labels: ['bug'], milestone: null, createdDaysAgo: 305, closedDaysAgo: 291, title: 'Empty milestone renders as the string "null"', number: 315 },
  { repo: 'acme', assignees: ['octocat'], labels: ['deliverable'], milestone: 'C1', createdDaysAgo: 340, closedDaysAgo: 320, title: 'Ship the first tenant onto managed jobs', number: 316 },
  { repo: 'acme', assignees: ['hubot'], labels: ['feedback'], milestone: 'C1', createdDaysAgo: 380, closedDaysAgo: 358, title: 'Customer: Selgeo asks for a weekly rollup', number: 317 },
  { repo: 'board', assignees: ['octocat'], labels: ['enhancement'], milestone: null, createdDaysAgo: 425, closedDaysAgo: 401, title: 'First dashboard: open issues and who holds them', number: 318 },
  { repo: 'acme', assignees: ['octocat'], labels: ['operational'], milestone: 'C1', createdDaysAgo: 460, closedDaysAgo: 437, title: 'Stand the board repo up on its own deploy', number: 319 },
  // THE TWO CLOSES THAT ARE NOT DELIVERY, seeded so fixture mode exercises both
  // branches of `deliveredCloseAt` (#1014). Without them a developer running on
  // fixtures sees one reason forever and every grid, tile and ring agrees by
  // accident. Both sit in the trailing week, where the throughput tiles and the
  // grid's newest column can be read against each other on the page.
  { repo: 'acme', assignees: ['hubot'], labels: ['discovery'], milestone: 'C3', createdDaysAgo: 21, closedDaysAgo: 3, closeReason: 'not_planned', title: 'Drop the second ingest path — superseded by shared memory', number: 320 },
  // Reason NULL, which is neither Github's answer nor ours: a row from a source
  // that did not select the field. It COUNTS, and it is here so that the
  // leniency is visible on the page rather than only in close-reason.spec.ts.
  { repo: 'board', assignees: ['octocat'], labels: ['chore'], milestone: null, createdDaysAgo: 9, closedDaysAgo: 2, closeReason: null, title: 'Backfilled row: closed before the reason was recorded', number: 321 },
  // Forty rows across five repositories that had no queue before (#1113). The
  // queue's board draws one column per group, so grouped by repo the fixture
  // offered two columns and could not overflow a 1280px window at all — which
  // is the width the sideways-scroll fault was reported at, over seven. Seven
  // is what these make, and they are assigned so they reach `/api/issues/mine`
  // rather than only the org queue. `status` keeps an empty queue, because an
  // empty repository still belongs on the map (#472) and something local has
  // to draw that.
  { repo: 'acme-platform-billing', assignees: ['octocat'], labels: ['bug', 'triage:P1', 'triage:M'], milestone: null, createdDaysAgo: 12, closedDaysAgo: null, title: 'Metering: dedupe usage events on replay' },
  { repo: 'acme-platform-billing', assignees: ['octocat'], labels: ['bug', 'triage:P2'], milestone: null, createdDaysAgo: 19, closedDaysAgo: null, title: 'Invoice PDF prints the wrong tax line for a VAT-exempt org' },
  { repo: 'acme-platform-billing', assignees: ['octocat'], labels: ['enhancement', 'triage:P2', 'triage:L'], milestone: null, createdDaysAgo: 26, closedDaysAgo: null, title: 'Proration: credit a mid-cycle downgrade' },
  { repo: 'acme-platform-billing', assignees: ['octocat'], labels: ['bug'], milestone: null, createdDaysAgo: 7, closedDaysAgo: null, title: 'Webhook retries land out of order' },
  { repo: 'acme-platform-billing', assignees: ['octocat'], labels: ['bug', 'triage:P1', 'triage:S'], milestone: null, createdDaysAgo: 33, closedDaysAgo: null, title: 'Seat counts drift after a bulk invite' },
  { repo: 'acme-platform-billing', assignees: ['octocat'], labels: ['operational'], milestone: null, createdDaysAgo: 41, closedDaysAgo: null, title: 'Backfill usage rows that carry no plan id' },
  { repo: 'acme-platform-billing', assignees: ['octocat'], labels: ['enhancement', 'triage:P3', 'triage:XS'], milestone: null, createdDaysAgo: 15, closedDaysAgo: null, title: 'Put a reason on a refund receipt' },
  { repo: 'acme-platform-billing', assignees: ['octocat'], labels: ['ux'], milestone: null, createdDaysAgo: 4, closedDaysAgo: null, title: 'Billing portal: say when the next charge falls' },
  { repo: 'acme-platform-deploy', assignees: ['octocat'], labels: ['bug', 'blocker', 'triage:P0', 'triage:M'], milestone: null, createdDaysAgo: 3, closedDaysAgo: null, title: 'Drain connections before the swap' },
  { repo: 'acme-platform-deploy', assignees: ['octocat'], labels: ['bug', 'triage:P1'], milestone: null, createdDaysAgo: 10, closedDaysAgo: null, title: 'A failed deploy loses the last 200 log lines' },
  { repo: 'acme-platform-deploy', assignees: ['octocat'], labels: ['operational', 'triage:P2', 'triage:S'], milestone: null, createdDaysAgo: 22, closedDaysAgo: null, title: 'Pin the base image by digest, not by tag' },
  { repo: 'acme-platform-deploy', assignees: ['octocat'], labels: ['bug'], milestone: null, createdDaysAgo: 16, closedDaysAgo: null, title: 'Canary never promotes when a health check is slow' },
  { repo: 'acme-platform-deploy', assignees: ['octocat'], labels: ['operational', 'triage:P2'], milestone: null, createdDaysAgo: 29, closedDaysAgo: null, title: 'Rotate the registry credential on a schedule' },
  { repo: 'acme-platform-deploy', assignees: ['octocat'], labels: ['enhancement', 'triage:P1', 'triage:XL'], milestone: null, createdDaysAgo: 37, closedDaysAgo: null, title: 'Roll back a failed migration without a manual step' },
  { repo: 'acme-platform-deploy', assignees: ['octocat'], labels: ['bug', 'triage:P3'], milestone: null, createdDaysAgo: 8, closedDaysAgo: null, title: 'The old task set lingers for an hour after a swap' },
  { repo: 'acme-platform-deploy', assignees: ['octocat'], labels: ['ux', 'triage:S'], milestone: null, createdDaysAgo: 5, closedDaysAgo: null, title: 'Deploy view names a build id where a commit would do' },
  { repo: 'acme-realtime-gateway', assignees: ['octocat'], labels: ['bug', 'triage:P1', 'triage:M'], milestone: null, createdDaysAgo: 6, closedDaysAgo: null, title: 'Presence: a reconnect leaves a ghost member' },
  { repo: 'acme-realtime-gateway', assignees: ['octocat'], labels: ['bug', 'blocker', 'triage:P0', 'triage:L'], milestone: null, createdDaysAgo: 2, closedDaysAgo: null, title: 'Fan-out drops a message under load' },
  { repo: 'acme-realtime-gateway', assignees: ['octocat'], labels: ['bug', 'triage:P1'], milestone: null, createdDaysAgo: 13, closedDaysAgo: null, title: 'Slow consumers stall the whole room' },
  { repo: 'acme-realtime-gateway', assignees: ['octocat'], labels: ['bug', 'triage:P2', 'triage:XS'], milestone: null, createdDaysAgo: 21, closedDaysAgo: null, title: 'Heartbeat timeout is shorter than the proxy idle' },
  { repo: 'acme-realtime-gateway', assignees: ['octocat'], labels: ['bug', 'triage:P1', 'triage:L'], milestone: null, createdDaysAgo: 28, closedDaysAgo: null, title: 'Reconnect storm after a gateway restart' },
  { repo: 'acme-realtime-gateway', assignees: ['octocat'], labels: ['bug'], milestone: null, createdDaysAgo: 35, closedDaysAgo: null, title: 'Room joins are not idempotent' },
  { repo: 'acme-realtime-gateway', assignees: ['octocat'], labels: ['enhancement', 'triage:P3'], milestone: null, createdDaysAgo: 44, closedDaysAgo: null, title: 'Trace a message from publish to delivery' },
  { repo: 'acme-realtime-gateway', assignees: ['octocat'], labels: ['ux', 'triage:S'], milestone: null, createdDaysAgo: 9, closedDaysAgo: null, title: 'Close code 1006 tells the client nothing' },
  { repo: 'roadmap', assignees: ['octocat'], labels: ['enhancement', 'triage:P2', 'triage:M'], milestone: null, createdDaysAgo: 18, closedDaysAgo: null, title: 'Carry unfinished KRs into the next cycle' },
  { repo: 'roadmap', assignees: ['octocat'], labels: ['ux', 'triage:P3', 'triage:XS'], milestone: null, createdDaysAgo: 25, closedDaysAgo: null, title: 'A KR with no owner should say so' },
  { repo: 'roadmap', assignees: ['octocat'], labels: ['enhancement'], milestone: null, createdDaysAgo: 31, closedDaysAgo: null, title: 'Export a cycle for the board review' },
  { repo: 'roadmap', assignees: ['octocat'], labels: ['bug', 'triage:P2'], milestone: null, createdDaysAgo: 11, closedDaysAgo: null, title: 'Archive a cycle without losing its notes' },
  { repo: 'roadmap', assignees: ['octocat'], labels: ['enhancement', 'triage:P1', 'triage:XL'], milestone: null, createdDaysAgo: 39, closedDaysAgo: null, title: 'Link a KR to the issues that deliver it' },
  { repo: 'roadmap', assignees: ['octocat'], labels: ['bug', 'triage:P3'], milestone: null, createdDaysAgo: 47, closedDaysAgo: null, title: 'The quarterly view is slower than the cycle view' },
  { repo: 'roadmap', assignees: ['octocat'], labels: ['discovery'], milestone: null, createdDaysAgo: 52, closedDaysAgo: null, title: 'Confidence is a number nobody sets' },
  { repo: 'roadmap', assignees: ['octocat'], labels: ['enhancement', 'triage:S'], milestone: null, createdDaysAgo: 14, closedDaysAgo: null, title: 'Say which cycle an issue landed in' },
  { repo: 'acme-mail-extension-app', assignees: ['octocat'], labels: ['bug', 'triage:P2', 'triage:XS'], milestone: null, createdDaysAgo: 17, closedDaysAgo: null, title: 'Compose inserts the signature twice' },
  { repo: 'acme-mail-extension-app', assignees: ['octocat'], labels: ['bug', 'triage:P1', 'triage:M'], milestone: null, createdDaysAgo: 24, closedDaysAgo: null, title: 'The extension loses its token after a browser restart' },
  { repo: 'acme-mail-extension-app', assignees: ['octocat'], labels: ['bug'], milestone: null, createdDaysAgo: 30, closedDaysAgo: null, title: 'A reply with no In-Reply-To sorts to the top' },
  { repo: 'acme-mail-extension-app', assignees: ['octocat'], labels: ['bug', 'triage:P2', 'triage:L'], milestone: null, createdDaysAgo: 36, closedDaysAgo: null, title: 'Attachment upload stalls over 10MB' },
  { repo: 'acme-mail-extension-app', assignees: ['octocat'], labels: ['bug', 'triage:P3'], milestone: null, createdDaysAgo: 43, closedDaysAgo: null, title: 'The shortcut collides with the host page' },
  { repo: 'acme-mail-extension-app', assignees: ['octocat'], labels: ['ux', 'triage:S'], milestone: null, createdDaysAgo: 20, closedDaysAgo: null, title: 'Dark theme leaves the reply box white' },
  { repo: 'acme-mail-extension-app', assignees: ['octocat'], labels: ['enhancement', 'triage:P1'], milestone: null, createdDaysAgo: 49, closedDaysAgo: null, title: 'The permissions prompt asks for more than it needs' },
  { repo: 'acme-mail-extension-app', assignees: ['octocat'], labels: ['operational', 'triage:P1', 'triage:XL', 'triage:owner'], milestone: null, createdDaysAgo: 55, closedDaysAgo: null, title: 'Manifest v3 migration' },
];

/** The org the fixture pretends to have read from — the one the fixture repo
 *  descriptors carry too (`repos/fixture-repos.source.ts`), so the map's
 *  owner-qualified join finds them (#647). One constant rather than a literal
 *  in each row, so the URL and the owner cannot drift apart. */
const FIXTURE_OWNER = 'acme';

/** The repository a seed key addresses on Github, for the keys whose two names
 *  differ. Every other key IS its repository name, which is why this map holds
 *  one entry rather than eight: `board` is the board's own short key and
 *  `board` is the repository it stands for.
 *
 *  Before #1113 this was a conditional with `acme` as its else branch, so the
 *  five repositories seeded there would all have addressed `acme/acme`
 *  and a card's Open-on-Github would have gone to the wrong repository. */
const REPO_NAMES: Record<string, string> = { board: 'board' };

export class FixtureIssuesSource implements IIssuesSource {
  async listIssues(): Promise<RawIssue[]> {
    const now = Date.now();
    return Promise.resolve(
      SEED.map((s, idx) => {
        const number = s.number ?? 100 + idx;
        return {
        owner: FIXTURE_OWNER,
        repo: s.repo,
        number,
        title: s.title,
        htmlUrl: `https://github.com/${FIXTURE_OWNER}/${REPO_NAMES[s.repo] ?? s.repo}/issues/${number}`,
        state: (s.closedDaysAgo == null ? 'open' : 'closed') as 'open' | 'closed',
        createdAt: new Date(now - s.createdDaysAgo * DAY_MS).toISOString(),
        closedAt: s.closedDaysAgo == null ? null : new Date(now - s.closedDaysAgo * DAY_MS).toISOString(),
        author: s.author ?? 'hubot',
        assignees: s.assignees,
        labels: s.labels,
        // The fixture IS the source of truth for its own rows (#497).
        labelsComplete: true,
        // Read off the seeded body through the real matcher, so a fixture row is
        // marked the same way a live one is (#516).
        submission: hasSubmissionFooter(s.body),
        // An OPEN row carries no reason at all, the way Github sends none; a
        // closed row takes its seed's, defaulting to the completed close that is
        // what every row here meant before the field existed (#1014).
        // `in`, NOT `??` — the seed's whole point is that `closeReason: null` is a
        // DIFFERENT answer from an absent key, and `??` folds the two together, so
        // the row seeded to exercise the lenient branch came out `completed` and
        // fixture mode held no closed row with an unknown reason at all.
        stateReason: s.closedDaysAgo == null ? null : 'closeReason' in s ? s.closeReason ?? null : 'completed',
        milestone: s.milestone,
        };
      }),
    );
  }
}
