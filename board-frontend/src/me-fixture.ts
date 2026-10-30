/**
 * A `Me` exactly as `/api/auth/me` can produce it — the session shape every
 * spec that gates on a write builds from (#626, #635).
 *
 * `canWrite` is not a free field. The server derives it from `writesEnabled`
 * AND the absence of a refusal among the capabilities the ISSUE editor writes
 * (`me.controller.ts`), so it is derived here rather than passed in, and a
 * session the backend could never send cannot be built.
 *
 * That is the whole reason this exists. A case in `ReposPage.spec.tsx` used to
 * hand-build `canWrite: true` beside a refused `issue.labels` — a payload #626
 * stopped the backend producing — and it went on passing green while the real
 * session took the owner picker off every tile. Three specs now ask about a
 * write, and three copies of this rule would be three chances to drift back to
 * a pair the server cannot produce.
 *
 * Test-only: nothing in the app imports it.
 */
import type { Me } from './use-me';

/** The prefix that defines ISSUE_EDITOR_CAPABILITIES on the server. */
const ISSUE_PREFIX = 'issue.';

export const meFixture = (over: Partial<Omit<Me, 'canWrite'>> = {}): Me => {
  const capabilities = over.capabilities ?? {};
  const writesEnabled = over.writesEnabled ?? false;
  return {
    email: 'stranger@example.com',
    isAdmin: false,
    name: 'stranger',
    githubLogin: null,
    orgs: [],
    ...over,
    writesEnabled,
    capabilities,
    canWrite:
      writesEnabled &&
      !Object.entries(capabilities).some(
        ([cap, state]) => cap.startsWith(ISSUE_PREFIX) && state === 'refused',
      ),
  };
};
