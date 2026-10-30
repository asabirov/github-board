import { useCallback, useLayoutEffect, useRef } from 'react';

/** A soft refresh does not revoke an in-flight answer. A newer settled answer
 *  (including a refusal) supersedes it; leaving this lifetime revokes it. */
export function createReadSequence() {
  let active = true;
  let issued = 0;
  let settled = 0;
  return {
    begin() {
      const own = ++issued;
      return () => {
        if (!active || own <= settled) return false;
        settled = own;
        return true;
      };
    },
    dispose() { active = false; },
  };
}

/** Keep separate sequences for independently served responses. The key names
 *  hard boundaries only: access epoch, organization, or whether a read is enabled. */
export function useReadSequence(key: string) {
  const current = useRef<ReturnType<typeof createReadSequence> | null>(null);
  useLayoutEffect(() => {
    const lifetime = createReadSequence();
    current.current = lifetime;
    return () => {
      lifetime.dispose();
      current.current = null;
    };
  }, [key]);
  return useCallback(() => current.current?.begin() ?? (() => false), []);
}
