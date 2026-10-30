import { BLOCK } from '../ui/block';
import { BAR, Placeholder } from '../ui/LoadingStructure';
import { PANEL_BLOCK } from './panel-block';

export const ISSUE_GRID = 'grid items-start gap-x-8 gap-y-8 lg:grid-cols-[minmax(0,1fr)_264px]';

function Bar({ className }: { className: string }) {
  return <Placeholder className={`${BAR} ${className}`} />;
}

function PropertyBlock({ rows }: { rows: number }) {
  return <div className={PANEL_BLOCK}>
    <div className="mb-1.5 flex min-h-[20px] items-center"><Bar className="h-3.5 w-28" /></div>
    {Array.from({ length: rows }, (_, row) => <div key={row} className="grid grid-cols-[74px_minmax(0,1fr)] items-center gap-3 py-[9px]">
      <Bar className="h-3 w-14" />
      <Bar className="h-[19.5px] w-4/5" />
    </div>)}
  </div>;
}

export function IssueLoading() {
  return <section aria-busy="true" aria-label="Loading issue">
    <div className={ISSUE_GRID} aria-hidden="true">
      <div className="min-w-0">
        <div className="mb-[22px] flex h-[38.94px] items-center max-[560px]:h-[30.68px]">
          <Bar className="h-8 w-4/5 max-[560px]:h-6" />
        </div>
        <div className="mt-4">
          <div className="flex h-5 items-center gap-1.5">
            <Bar className="size-5 rounded-full" />
            <Bar className="h-3 w-28" />
            <Bar className="h-3 w-24" />
          </div>
          <div className="mt-4 space-y-3 rounded-lg bg-surface p-4">
            <Bar className="h-4 w-full" />
            <Bar className="h-4 w-5/6" />
            <Bar className="h-4 w-3/4" />
            <Bar className="my-5 h-24 w-full rounded-lg" />
            <Bar className="h-4 w-5/6" />
            <Bar className="h-4 w-2/3" />
          </div>
        </div>
        <div className="mb-4 mt-6 flex h-[21px] items-center"><Bar className="h-3.5 w-16" /></div>
        <div className="iss-spine mt-6">
          <div className="iss-node">
            <Bar className="rok-av rounded-full" />
            <div className={`${BLOCK} space-y-3 p-4`}>
              <Bar className="h-3 w-32" />
              <Bar className="h-4 w-5/6" />
              <Bar className="h-4 w-2/3" />
            </div>
          </div>
        </div>
      </div>
      <div>
        <div className="flex h-8 items-center justify-between gap-2">
          <Bar className="h-6 w-20 rounded-full" />
          <Bar className="size-5 rounded-lg" />
        </div>
        <div className="flex flex-col gap-2.5 pt-1">
          <PropertyBlock rows={4} />
          <PropertyBlock rows={3} />
        </div>
      </div>
    </div>
    <p role="status" className="sr-only">Loading issue…</p>
  </section>;
}
