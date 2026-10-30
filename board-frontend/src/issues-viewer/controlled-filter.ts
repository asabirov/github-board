/**
 * The shared multi-select toggle — `useViewerState`'s own filter reducer and the
 * Unit page's Crew cards run through this one function, so a card press and a
 * FilterBar chip add and remove a value the same way.
 *
 * It used to sit beside `mergeControlledAssignees`, the seam that let the Unit
 * page own the viewer's assignee dimension out of band (#420). That seam is gone
 * (#461): an assignee toggle now goes through `setFilter` like every other
 * dimension, so it lands in the viewer's state, is encoded into the URL by
 * `commit`, and the Unit page reads it back from there. One writer, so the page
 * and its queue cannot disagree about who is selected.
 */

/** Add `value` if absent, remove it if present. */
export function toggleValue(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
