import { useEffect } from 'react';
import { DisabledProjectStrip } from '../dashboard/ProjectContributions';
import { fetchProjectPreview, type ProjectCatalogEntry } from '../api/projects';
import { useResponseState } from '../auth/use-response-state';
import { gotoPath, routePath } from '../route';
import { useAccessEpoch, useRenewalSignal } from '../sync/sync-status';
import { BLOCK, CARD_PADDING } from '../ui/block';
import { BlockHeader } from '../ui/BlockHeader';
import { Placeholder } from '../ui/LoadingStructure';

/** Board identities are useful before the item walk can establish counts.
 * This temporary view makes no claim about completion or weekly activity. */
export function ProjectsPreviewCard({ projects, failed = false }: { projects: ProjectCatalogEntry[]; failed?: boolean }) {
  // WHOSE BOARD, when the list holds more than one owner (#911 review, R2). Two
  // orgs can spell one title, and a link's accessible name is its own text — so
  // the owner goes INSIDE the anchor, which fixes what is read and what is
  // announced with one string. The differing href fixes neither.
  const owners = new Set(projects.map((p) => p.org).filter(Boolean));
  const qualify = owners.size > 1;
  return (
    <div className={`${BLOCK} col-span-2 min-h-[200px] ${CARD_PADDING} max-[900px]:col-span-1`}>
      <BlockHeader label="Projects" />
      {/* The read is still out, or it failed (#1395). Since a 503 keeps this
          preview rather than removing it, "Loading…" would sit over names whose
          completion is never going to arrive. */}
      <p className="text-[12px] text-muted" role="status">
        {failed ? 'Couldn’t load completion' : 'Loading completion and weekly activity…'}
      </p>
      <div className="mt-3.5 flex flex-col gap-0.5">
        {projects.length === 0 && <div aria-hidden="true" className="space-y-4 py-2">
          <Placeholder className="h-4 w-48 max-w-full bg-elevated" />
          <Placeholder className="h-3 w-32 max-w-full bg-elevated" />
        </div>}
        {projects.map((p) => {
          const path = routePath({ tab: 'projects', org: p.org, project: p.number });
          return (
            <div key={`${p.org ?? ''}/${p.number}`} className="flex items-center gap-4">
              <a
                href={path}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  gotoPath(path);
                }}
                className="-mx-2 min-w-0 flex-1 rounded-lg px-2 py-2 text-[13px] font-medium text-fg no-underline transition-colors hover:bg-elevated"
              >
                <span className="block truncate">
                  {p.title}
                  {qualify && p.org ? <span className="font-normal text-muted"> in {p.org}</span> : null}
                </span>
              </a>
              <span aria-hidden="true"><Placeholder className="h-3 w-12 bg-elevated" /></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Which address each catalog answer was asked for. Keyed by the answer itself,
 *  for the reason `response-deadline.ts` keys its metadata by object: a wrapper
 *  holding the scope beside the array carries none of the array's lease. */
const askedFor = new WeakMap<object, string | undefined>();

/** Record the address a catalog answer was asked for, and hand the answer back
 *  unwrapped so its lease travels with it. */
export function rememberScope(projects: ProjectCatalogEntry[], org: string | undefined): ProjectCatalogEntry[] {
  askedFor.set(projects, org);
  return projects;
}

/** What a held answer may draw at this address: itself, or nothing.
 *
 *  The ADDRESS, not the owners inside the answer (#911 review). Owner equality
 *  reads true for every row of a narrowed answer under the union, where `org` is
 *  undefined, so one org's boards would draw there as the whole list. */
export function answerFor(held: ProjectCatalogEntry[] | null, org: string | undefined): ProjectCatalogEntry[] {
  return held && askedFor.get(held) === org ? held : [];
}

/**
 * The catalog names, held only while the full rollup is still walking items.
 *
 * THE ARRAY, NOT A COPY OF IT (#905, R3; #911 review, I1). Response metadata is
 * keyed by object, so holding the marked answer itself is what lets
 * `useResponseState` drop it on that response's own clock. The address is fenced
 * at RENDER and cleared in an EFFECT, the pair `PageCrumb` makes.
 */
export function ProjectsPreview({ org, failed = false }: { org?: string; failed?: boolean }) {
  const [held, setHeld] = useResponseState<ProjectCatalogEntry[] | null>(null, null);
  const renewal = useRenewalSignal();
  const accessEpoch = useAccessEpoch();
  useEffect(() => { setHeld(null); }, [org, setHeld]);
  useEffect(() => {
    let alive = true;
    const scope = org;
    fetchProjectPreview(scope).then((projects) => { if (alive) setHeld(rememberScope(projects, scope)); }, () => {});
    return () => { alive = false; };
    // The sensitive GENERATION is deliberately not a dependency (#911 review,
    // R1): a hard expiry bumps it before the new check has answered, so reading
    // on it costs one request the expired check authorized and a second after
    // the verified one lands. Clearing is `useResponseState`'s above.
  }, [org, renewal, accessEpoch, setHeld]);
  const projects = answerFor(held, org);
  if (failed && projects.length === 0) return <DisabledProjectStrip label="Projects" note="Projects couldn’t be read just now." />;
  return <ProjectsPreviewCard projects={projects} failed={failed} />;
}
