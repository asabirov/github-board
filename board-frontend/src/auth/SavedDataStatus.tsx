/**
 * Background saved reads use a fixed-height status so the page stays still.
 * The label keeps the desktop words at every width (#1410), because the tooltip
 * does not open on touch and "Saved" alone reads as a write that succeeded.
 */
export function SavedDataStatus({ savedData = false }: { savedData?: boolean }) {
  return (
    <span role="status" title={savedData ? 'Showing the last data loaded.' : undefined} className={`flex flex-none items-center gap-1.5 text-[12px] text-dim ${savedData ? 'mr-3' : ''}`}>
      {savedData && <>
        <span aria-hidden="true" className="size-1.5 flex-none rounded-full" style={{ background: 'var(--accent)' }} />
        <span className="whitespace-nowrap">Saved data</span>
      </>}
    </span>
  );
}
