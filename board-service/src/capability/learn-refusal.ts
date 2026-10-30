import type { Capability } from './capability';
import type { Refusal } from './github-refusal';

/** Re-read the exact target the write just failed on. Resolves `true` when the
 *  target is there and the credential can see it. */
export type Reread = () => Promise<boolean>;

/**
 * The one thing a refusal asks of the registry.
 *
 * Task 4 builds `CapabilityRegistry`; it satisfies this by having the method.
 * Naming the part rather than the class is what lets the learning land before
 * the memory it will eventually teach.
 */
export interface RefusalRecorder {
  recordRefusal(cap: Capability, r: Refusal, target?: string): void;
}

/**
 * Turn a refusal into something the registry may believe (#584).
 *
 * A bare 404 on a write is the shape that hid #577: a missing permission and an
 * absent target answer identically. The board earns the distinction by asking a
 * question it can trust — it RE-READS the exact target it just failed to write.
 * On the failure path only, so it costs nothing in the normal case.
 *
 *  - the re-read succeeds → the target is there and the credential can see it,
 *    so the write refusal was permission. `not-permitted`, keyed on this target,
 *    and the registry is told.
 *  - the re-read 404s → the target is genuinely absent. `not-found`, and this
 *    function tells the registry NOTHING AT ALL — it returns before recording.
 *    That is what stops a caller naming a repository that does not exist and
 *    darkening a capability for everyone.
 *  - the re-read itself breaks → the same: it returns without recording. A
 *    broken re-read is not evidence.
 *
 * Every OTHER refusal is handed to the registry exactly as it was classified,
 * including a `try-again` and a `wrong-value`. That is not an oversight and it
 * is not a second filter missing: what may be BELIEVED is decided in one place,
 * by `recordRefusal` reading `refusal.scope`, and a refusal that says nothing
 * about permission carries scope `none` and is dropped there. Filtering here as
 * well would be two mechanisms for one rule, and the second one to be edited
 * would be the one nobody remembered.
 */
export async function learnRefusal({
  registry,
  capability,
  target,
  refusal,
  reread,
}: {
  registry?: RefusalRecorder;
  capability: Capability;
  target?: string;
  refusal: Refusal;
  reread?: Reread;
}): Promise<Refusal> {
  if (refusal.reason === 'not-found' && reread && target) {
    let visible = false;
    try {
      visible = await reread();
    } catch {
      return refusal;
    }
    if (!visible) return refusal;
    const earned: Refusal = {
      ...refusal,
      reason: 'not-permitted',
      scope: 'target',
      retryable: false,
      message: `GitHub refused this write on ${target}: the board is not permitted to do it.`,
    };
    registry?.recordRefusal(capability, earned, target);
    return earned;
  }
  registry?.recordRefusal(capability, refusal, target);
  return refusal;
}
