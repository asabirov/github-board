/**
 * The single definition of "is this request a human session?" (#384, S6).
 *
 * A request whose `req.user` carries a `scopes` array is a scoped/programmatic
 * actor (a static agent token or a personal access token); a human session has
 * no `scopes`. Both `HumanOnlyGuard` and the `canWrite` capability on
 * `/api/auth/me` decide "human" through THIS predicate, so the signal is defined
 * once — if it ever changes (e.g. humans start carrying `scopes: []`, which is
 * truthy), the guard and the capability move together and can't drift.
 */
export const isHumanSession = (user?: { scopes?: string[] }): boolean => !user?.scopes;
