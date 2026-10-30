/**
 * The hard bound on how long a webhook delivery may be held (#1007, V5).
 *
 * Github gives up on a delivery after 10 seconds and does not send it again, so
 * board has to answer inside that whatever the store is doing. The transaction
 * options in `issue-store.ts` are not enough on their own: Prisma's `timeout`
 * is checked between statements, so a transaction that already holds a
 * connection and is waiting on a server that took the query and stopped
 * answering is not cut by it at all. A frozen store was measured holding one
 * delivery for 45 seconds in isolation, and 300 in the running service.
 *
 * So the answer is bounded here, above the transaction, where nothing the store
 * does can reach. A delivery past this deadline is answered 503, which is what
 * Github's delivery log needs to show it failed and offer a redelivery.
 */
export const WEBHOOK_DEADLINE = 'WEBHOOK_DEADLINE';

/**
 * Comfortably inside Github's 10 seconds, and above the worst a store that is
 * merely slow can legitimately take: a delivery waits for its delivery slot
 * inside the process, holding no connection, and its transaction may then run
 * 5 seconds (`issue-store.ts`). A delivery that reaches this deadline is one
 * whose slot never freed or one Prisma's own timeout did not cut.
 */
export const WEBHOOK_DEADLINE_MS = 8_000;

/** The delivery's outcome, or a rejection at `ms` — whichever comes first. The
 *  work carries on; what is bounded is the wait, because the connection it
 *  holds is the store's problem and the answer to Github is board's. What the
 *  work does when it settles late is the caller's to handle: see the controller,
 *  which still moves the store's signal for a delivery that lands after the
 *  503 (#1070). */
export function answerWithin<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the webhook store did not answer within ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
