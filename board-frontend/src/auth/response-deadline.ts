/** Keep response ownership and refusal generations without a client expiry clock. */
export interface ResponseDeadline { expiresAt: number; visibilityKey: string }
export const ACCESS_DEADLINE_HEADER = 'X-Board-Access-Expires-At';
export const ACCESS_VISIBILITY_HEADER = 'X-Board-Visibility';
const deadlines = new WeakMap<object, ResponseDeadline>();
const sensitiveResponses = new WeakMap<object, number>();
const generations = new WeakMap<ResponseDeadline, number>();
let generation = 0;
let revision = 0;
const listeners = new Set<() => void>();
export const responseRevision = () => revision;
export const subscribeResponseChanges = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
/** Invalidate projections of a refused cached answer, including nested rows. */
export function withdrawResponse(value: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    sensitiveResponses.set(node, -1);
    const lease = deadlines.get(node);
    if (lease) generations.set(lease, -1);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  revision++;
  for (const listener of listeners) listener();
}
let visibility: string | null = null;
let required = false;
let checkDeadline = 0;

export function setResponseIdentity(key: string | null, supported: boolean, expiresAt = 0): void {
  checkDeadline = visibility === key ? Math.max(checkDeadline, expiresAt) : expiresAt;
  required = visibility === key ? required || supported : supported;
  visibility = key;
}
/** A hard invalidation has already discarded every sensitive generation. */
export function resetResponseRequirements(): void { required = false; checkDeadline = 0; generation++; superseded = null; }
export const currentResponseIdentity = () => visibility;
export const currentResponseCheck = () => checkDeadline;
export const requiresResponseDeadline = () => required;
export function validResponseDeadline(value: unknown): value is ResponseDeadline {
  if (!value || typeof value !== 'object') return false;
  const lease = value as ResponseDeadline;
  return Number.isFinite(lease.expiresAt) && lease.expiresAt > 0
    && typeof lease.visibilityKey === 'string' && lease.visibilityKey === visibility;
}

/**
 * The key the CURRENT one replaced for the same person, or null (#1395).
 *
 * One, never a chain. Access can move twice while a tab is open, and a growing
 * list of keys the board still honours is not the trade-off Artur accepted: it
 * is the fence falling over.
 */
let superseded: string | null = null;

/**
 * Record that `previous` was this person's visibility key until a moment ago.
 *
 * Called only from `claimFor`, which is the one place that knows the address and
 * the session hint id are unchanged — that this is the same reader, re-checked,
 * and not somebody else. A different reader wipes and never reaches here.
 */
export function supersedeVisibility(previous: string | null): void {
  superseded = previous;
}
export const currentSupersededIdentity = () => superseded;

/**
 * Whether a lease may be DRAWN, as opposed to accepted off the wire (#1395).
 *
 * `validResponseDeadline` above is the wire's reading and does not move: a
 * response that arrives authorized under a key this app has not installed is
 * refused, because it may have been granted under access the reader has since
 * lost. This is the saved copy's reading, and it is wider by exactly one key.
 *
 * Artur's decision, recorded on #1395: when Github reports different access for
 * the SAME person, their own last answer stays on their own screen, marked
 * stale, until a live read refuses it. A live read is what settles it — each one
 * carries its own authorization, a 401, 403 or 404 withdraws the copy, and a 200
 * replaces it. The alternative was to delete it at once, which is what the board
 * did, and what made adding a repository cost a cold open.
 *
 * It is narrow in three ways: one superseded key, for one person, and only on
 * the drawing side. A whole wipe clears it (`resetResponseRequirements`).
 */
export function drawableResponseDeadline(value: unknown): value is ResponseDeadline {
  if (validResponseDeadline(value)) return true;
  if (superseded === null || !value || typeof value !== 'object') return false;
  const lease = value as ResponseDeadline;
  return Number.isFinite(lease.expiresAt) && lease.expiresAt > 0
    && typeof lease.visibilityKey === 'string' && lease.visibilityKey === superseded;
}
export function responseDeadline(value: unknown): ResponseDeadline | undefined {
  return value !== null && typeof value === 'object' ? deadlines.get(value) : undefined;
}
export function isSensitiveResponse(value: unknown): boolean {
  return value !== null && typeof value === 'object' && sensitiveResponses.has(value);
}
export function markSensitiveResponse<T>(value: T, lease?: ResponseDeadline): T {
  if (lease && !generations.has(lease)) generations.set(lease, generation);
  const seen = new WeakSet<object>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    sensitiveResponses.set(node, generation);
    if (lease) deadlines.set(node, lease);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return value;
}
export function tagResponse<T>(value: T, lease: ResponseDeadline): T {
  return markSensitiveResponse(value, lease);
}
export function copyResponseDeadline<T>(source: unknown, value: T): T {
  const sourceLease = responseDeadline(source);
  const heldLease = responseDeadline(value);
  const lease = responseExpired(source) ? sourceLease
    : responseExpired(value) ? heldLease
    : heldLease && (!sourceLease || heldLease.expiresAt <= sourceLease.expiresAt) ? heldLease : sourceLease;
  const sensitive = isSensitiveResponse(source) || isSensitiveResponse(value);
  const sourceGeneration = Math.min(isSensitiveResponse(source) ? sensitiveResponses.get(source as object)! : generation,
    isSensitiveResponse(value) ? sensitiveResponses.get(value as object)! : generation);
  const seen = new WeakSet<object>();
  const visit = (node: unknown, root = false) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    if (!root && isSensitiveResponse(node)) return;
    seen.add(node);
    if (lease) deadlines.set(node, lease);
    if (sensitive) {
      sensitiveResponses.set(node, Math.min(sourceGeneration, sensitiveResponses.get(node) ?? generation));
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value, true);
  return value;
}
export function responseExpired(value: unknown): boolean {
  if (isSensitiveResponse(value) && sensitiveResponses.get(value as object) !== generation) return true;
  const lease = responseDeadline(value);
  // The DRAWING reading (#1395): a copy under the key this person's current one
  // replaced is stale, not expired, and the live read is what ends it.
  return lease !== undefined && (!drawableResponseDeadline(lease) || generations.get(lease) !== generation);
}
