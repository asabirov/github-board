/**
 * The code the auth layer puts on a 503 that means "keep what you have, ask
 * again later" (#1066).
 *
 * It travels in the body beside the message, the way `PROJECTS_NOT_NOW_CODE`
 * and `ADMINS_UNREAD_CODE` do, because a 503 alone says nothing about which
 * verdict it is. The browser draws its saved copy over a 503 only when the body
 * carries a code it knows (`board-frontend/src/projects/projects-last-good.ts`),
 * so an uncoded 503 empties the Projects strip and deletes every saved copy of
 * it. Five 503s were uncoded and none of them is about the reader: two are a
 * refresh genuinely in flight on another instance, one is an access check with
 * too little left to start a long read on, one is a discovery that ran past its
 * own window, and one is a session store that could not be read.
 *
 * ONE code for all five, rather than one per site. They are thrown by the auth
 * layer before any read has run, so none of them can say anything about the
 * surface the browser asked for; what they all say is that board could not
 * establish who the reader is right now. The browser needs exactly that one
 * fact, and a per-site code would ask every read to learn five names for it.
 *
 * ONLY from those five. This layer sends five other 503s and every one of them
 * is a WITHDRAWAL — `github-expiry.interceptor.ts` withholding a sensitive
 * answer its access check has outlived, that same interceptor finding the
 * access key moved under a read, a board with no Github connection configured,
 * a disconnect that could not reach Github to revoke the grant, and the
 * credential path's lost claim on a refresh lease — and a copy drawn over one
 * of those shows a reader a board the answer itself withheld. The 403s this
 * layer sends are uncoded for the same reason and could not draw that copy
 * anyway: it is read off a 503. `access-not-now-code.spec.ts` pins the set,
 * because every auth and projects spec asserts its own status and message and
 * none of them asks what else rides in the body. Its header is where the shapes
 * that pin cannot read are written down. Must match `ACCESS_NOT_NOW_CODE` in
 * board-frontend's `projects/projects-last-good.ts`.
 */
export const ACCESS_NOT_NOW_CODE = 'access_not_now';
