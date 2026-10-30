// Types for the synthetic Github's shape helpers, so a spec in TypeScript can
// import them and name the same repositories the harness does. The
// implementation is `fake-shape.mjs`; these two are kept in step by hand.
export interface SyntheticOwner {
  /** The owner's login, as FAKE_ORGS spelled it. */
  org: string;
  /** Its position in FAKE_ORGS, which every id is derived from. */
  index: number;
  repos: number;
  members: number;
}
export function orgsFrom(spec?: string): Map<string, SyntheticOwner>;
export function repoId(orgs: Map<string, SyntheticOwner>, org: string, i: number): number;
export function repoAtId(orgs: Map<string, SyntheticOwner>, id: number | string): { org: string; name: string; index: number } | undefined;
export function installationId(orgs: Map<string, SyntheticOwner>, org: string): number;
export function grantsFrom(orgs: Map<string, SyntheticOwner>, spec?: string): SyntheticOwner[];
