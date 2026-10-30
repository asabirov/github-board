/**
 * Split a platform shell surface path into its readable area parts (#313).
 * The widget stamps where the feedback came from as a raw path like
 * `/acme/~/mail/broadcasts` or `/acme/~/deployment/environments/<uuid>`.
 * We strip the `/<product>/~/` shell prefix, drop id-ish segments (uuids,
 * numbers), and keep the first two meaningful area segments — so the reader sees
 * "Mail", "Broadcasts", not the raw path.
 *
 * Returns the parts rather than a joined string (#448). This used to join them
 * with a middot on the argument that two path parts are real breadcrumb
 * structure, unlike a decorative metadata chain. The argument doesn't survive
 * contact with the row: the row then used the SAME glyph to join this string to
 * the reporter, so the line rendered as one flat three-item chain and no reader
 * could tell the hierarchical join from the list-y one. A middot can't express
 * hierarchy — it only ever says "and also". Handing the caller the parts lets it
 * space and tone them, which can.
 */

// uuid / long hex / all-digits segments are instance ids, not area names.
const ID_RE = /^[0-9a-f]{8,}(-[0-9a-f]+)*$|^\d+$/i;

function titleCaseSegment(seg: string): string {
  return seg
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Broadest area first, most specific last — `['Mail', 'Broadcasts']`. Empty
 *  when the path is missing or carries nothing but ids. */
export function surfaceParts(path: string | null | undefined): string[] {
  if (!path) return [];
  const rest = path.replace(/^\/[^/]+\/~\//, '').replace(/^\/+/, '');
  const segs = rest.split('/').filter((s) => s && !ID_RE.test(s));
  return segs.slice(0, 2).map(titleCaseSegment).filter(Boolean);
}
