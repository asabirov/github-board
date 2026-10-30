/**
 * The words the board uses about a read that did not land (#512, #1055). One
 * set, in one place: before this, `/admin` said "Session expired — reload.",
 * `/projects` said "Couldn't load projects: unauthenticated", and each page
 * invented its own answer to the same condition.
 *
 * What the sentence may NOT hold is the second half of that (#1055). Every one
 * of these reads throws a string api.ts wrote for api.ts — `unauthenticated`
 * and `forbidden` by name, and `<route> <status>` for the rest — and the line
 * used to end on it, so a person read "Couldn't load project: project-items
 * 500". A route name is not a thing on their screen and a status code is not
 * something they can act on. The sentence names what is missing and what to do;
 * `logLoadFailure` keeps the rest.
 */

export const SESSION_ENDED_TITLE = 'Your session ended.';
export const SESSION_ENDED_NOTE = 'Nothing on this page is live until you sign in again.';

/**
 * One line for a surface that failed to load, given the board's own name for
 * that surface and the message the read rejected with.
 *
 * Three answers, because there are three things a reader can do. An expired
 * session already has its own bar over the page, so that arm says why the
 * surface stopped and leaves the way back to the bar. A refusal offers nothing:
 * a second read is refused the same way, and a sentence asking for one would be
 * the page disagreeing with itself. Everything else could be a hiccup, and a
 * reload is the retry — none of the five surfaces that call this has a retry
 * control of its own and none of them polls, so a reload is the only true offer
 * there is to make. A surface that grows one can grow an arm here with it.
 *
 * THE REFUSAL ARM SAYS WHOSE REFUSAL IT IS NOT (#1081 review, B1). It said "You
 * aren't allowed to see X", and that is a claim about the READER that every 403
 * these five surfaces can actually meet contradicts. All five fetchers collapse
 * any 403 to the one sentinel `forbidden`, so nothing here can tell them apart;
 * what the service produces, enumerated per route rather than assumed:
 *
 *   - `/api/issues/mine` — `GithubPrincipalGuard` answers 403 "Sign in with GitHub
 *     to use this surface" to a signed-in person whose Github credential is
 *     absent or gone, and `github-client.ts`'s `tokenFor` throws the same. That
 *     is a missing credential, not a verdict on the reader. It is the one 403 a
 *     browser session can actually reach on any of the three surfaces this arm
 *     is live on, and the review reproduced it.
 *   - `/api/account/tokens`, `/api/account/clients` — `HumanOnlyGuard` and
 *     `RequiredScopesGuard` refuse a SCOPED actor, which a browser session is
 *     not. Neither is reachable from a page.
 *   - `/api/admin/access`, `/api/admin/audit` — `AdminGuard`'s 403 "admin
 *     access required" is about the reader, and it never arrives here:
 *     `AccessSection` and `AuditSection` both intercept `forbidden` into their
 *     own "for admins only" pane before this is called.
 *   - every route — `TeamAccessGuard` refuses a non-member, but it refuses
 *     `/api/auth/me` first, so that reader is behind `AuthScreen`'s "Access
 *     restricted" gate and no pane of the board is drawn at all.
 *
 * So the sentence names nobody. "The read was refused" is true whether the
 * reader, the board's credential or a connection nobody has made is what the
 * service was answering about, and it still withholds the reload the generic
 * arm offers, which is the half of the old sentence that was right.
 *
 * IT NAMES THE READ AND NOT THE SUBJECT (#979). The arm said "Access to it was
 * refused", and `it` had to stand for whatever `subject` is — which is plural
 * on three of the five callers, so "Couldn't load your tokens. Access to it was
 * refused" disagreed with itself one sentence apart. Naming the read instead
 * costs the sentence nothing: what was refused is the same thing either way,
 * and this way there is no pronoun to agree with.
 *
 * `subject` is the reader's name for the thing, not the code's: it is read
 * aloud inside the sentence, so "the access model" is as much a leak as a
 * status code is.
 *
 * AN ERROR WITH NO WORDS IS STILL A FAILED READ (#1082), which is why `message`
 * takes an empty string, `undefined` and `null` and answers all three. It is
 * the inverse of #1055: that one said too much, and this one said nothing at
 * all. Since #1055 the words are not in the sentence — what is missing and what
 * to do are both known from `subject` — so a rejection carrying nothing to say
 * loses nothing by arriving here, and the generic arm is the true answer to it.
 *
 * WHICH LEAVES ONE RULE FOR A CALLER: ask whether the read FAILED, never
 * whether this had anything to read. `''` is falsy and is a failure, so a
 * `{error && …}` guard files it under "nothing went wrong" and draws the screen
 * for a read that is still in flight. Two panes did exactly that, which is what
 * #1082 is. The signature takes the null so that a guarded call site can hand
 * over what it holds without re-narrowing it.
 */
export function loadFailureText(subject: string, message: string | null | undefined): string {
  if (message === 'unauthenticated') return `Your session ended, so ${subject} stopped loading.`;
  if (message === 'forbidden') {
    return `Couldn’t load ${subject}. The read was refused, and a reload won’t change that.`;
  }
  return `Couldn’t load ${subject}. Reload the page to try again.`;
}

/**
 * Whatever a rejected promise carried, as something a person can read.
 *
 * One reader for every surface that catches one (#1082). It is written with
 * `?.` and `??` and NOT as `e.message ?? e`, because a promise can reject with
 * `undefined` — `Promise.reject()`, an `await` on a thenable that calls its
 * reject with nothing — and reading `.message` off that throws INSIDE the
 * handler. The rejection then never reaches the state the page branches on, so
 * the pane sits on its first-load arm for the rest of the session, which is the
 * same screen the empty message produced and the reason both are one issue.
 *
 * It can answer `''`, and that is not a bug to paper over here: an error whose
 * message is empty is a failed read like any other, and `loadFailureText` says
 * what could not be loaded without reading these words at all. It can also
 * answer `'undefined'`, `'null'` or `'[object Object]'`, for the same reason and
 * with the same standing: `logLoadFailure` is where those go, and on a console
 * line "undefined" is the honest answer to what the read rejected with.
 *
 * A CALLER THAT DRAWS THESE WORDS OWNS THAT (#1104 review, S3). None does. One
 * did until #1079 — the revoke line set them inside a sentence of its own, and
 * a rejection carrying nothing read "Couldn't revoke Claude Desktop - . It
 * still has access." That frame is gone: the write path reads the status off
 * the `ApiError` and writes its own words, which one collapsed string cannot
 * carry. Both callers left hand what arrives here to `loadFailureText`, which
 * branches on it and never prints it, and to `logLoadFailure`. A caller that
 * draws them again owns the check, because only a caller knows whether the
 * words are read aloud or only logged; anything here would put a sentence for a
 * reader into the string the console gets.
 */
export function reasonOf(e: unknown): string {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return String(m ?? e);
}

/**
 * The developer's half of the sentence above: what the read actually answered.
 *
 * Called from the handler that caught the rejection, never from a render — a
 * render that logs logs again on every re-render, and twice under React's
 * development double-render. `new-project.tsx` keeps the service's own refusal
 * this way for the same reason.
 */
export function logLoadFailure(subject: string, message: string): void {
  console.warn(`load failed: ${subject}: ${message}`);
}
