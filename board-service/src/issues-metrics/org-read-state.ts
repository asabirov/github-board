import type { OrgReadOutcome } from './github-issues.source';

/**
 * ONE question — "which configured orgs answered" — and the token that carries
 * it (#650).
 *
 * Its own file, and one with no runtime imports, because the two ends must not
 * import each other: the auth layer asking this question is a different thing
 * from the auth layer holding the metrics cache, and `MeController` injecting
 * `IssuesCacheService` would hand a controller that reports one boolean-ish
 * record the whole ~70-repo scan, its TTL clock and its submission index.
 * Everything below is a type or a pure function, so importing this from either
 * side pulls in nothing.
 */

/**
 * What ships on the wire, and it is the ingest's record MINUS `calls`.
 *
 * `calls` is a cost measurement — it answers "what does a second org cost",
 * which is an operator's question — and this field answers "can the board see
 * this org's work". Shipping it would put per-request telemetry on an auth
 * payload for no reader. It stays on `OrgReadOutcome`, server-side.
 */
export interface OrgReadReport {
  org: string;
  state: 'read' | 'unreadable';
  reason: string | null;
}

/** The accessor `MeController` depends on. One method, one question. */
export interface OrgReadState {
  /**
   * Which configured orgs the board could read, for the run whose numbers a
   * person is looking at.
   *
   * `[]` means the board makes NO CLAIM about any org — not that every org is
   * fine. A caller that cannot tell them apart must draw exactly what it drew
   * before this field existed.
   */
  orgsRead(): OrgReadReport[];
}

/** The ingest's record: the orgs the last successful run covered. */
export interface IngestOrgRecord {
  /** `null` when NO ingest has succeeded yet — distinct from `[]`, which is a
   *  run that happened and claimed no orgs. */
  lastIngestOrgs(): OrgReadOutcome[] | null;
}

/** The boot probe's record. Read here and nowhere else — see below. */
export interface BootOrgProbe {
  orgsAtBoot(): OrgReadOutcome[];
}

const onWire = (outcomes: OrgReadOutcome[]): OrgReadReport[] =>
  outcomes.map(({ org, state, reason }) => ({ org, state, reason }));

/**
 * The ingest's record is the source; the boot probe fills ONE window.
 *
 * The ingest wins whenever it has anything to say, because it describes THE RUN
 * THAT PRODUCED THE NUMBERS A PERSON IS LOOKING AT. The boot probe runs once, at
 * process start, and never again — so an org that broke after boot would read
 * fine forever and an org that recovered would read broken forever. Both are the
 * surface lying about the exact thing this field exists to stop it lying about.
 *
 * So the probe is a BOOTSTRAP, not a second opinion: it answers only while
 * `lastIngestOrgs()` is `null`, which is the window between process start and
 * the first successful ingest. `[]` from the ingest is an answer — "a run
 * happened and claimed nothing" — and it ENDS the window rather than falling
 * through, or the probe's verdict would outlive the run that superseded it.
 *
 * No entry is ever synthesised. An absent probe and an absent record both answer
 * `[]`, which is "no claim".
 */
export function composeOrgReadState(ingest: IngestOrgRecord, boot?: BootOrgProbe): OrgReadState {
  return {
    orgsRead: () => {
      const run = ingest.lastIngestOrgs();
      if (run !== null) return onWire(run);
      return onWire(boot?.orgsAtBoot() ?? []);
    },
  };
}

/** DI token. A string token because the interface above is a type and erases. */
export const ORG_READ_STATE = 'ORG_READ_STATE';
