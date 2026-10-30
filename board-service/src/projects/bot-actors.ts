/**
 * Which Github logins are machines, for every Projects read that has to tell a
 * person's work from automation's.
 *
 * Two surfaces ask, and they must agree: the completion ring files a bot's
 * closes as `unattributed` rather than giving them a person's colour (#454), and
 * the rollup card's recency line steps over an issue a bot WROTE rather than
 * naming a version bump where a human's work belongs (#488). One list, one
 * predicate — a board that called dependabot a person in one place and a bot in
 * the other would be a card disagreeing with its own dial.
 *
 * The two ask it of different logins on purpose. The ring is a record of acts,
 * so it asks about the closer; the recency line is about what kind of work is
 * moving, so it asks about the author. Same list, different question.
 *
 * Github App identities close issues too (release bots, merge queues, the
 * board's own automation). GraphQL returns them as `Bot` actors, whose login is
 * sometimes bare (`github-actions`) and sometimes suffixed (`github-actions[bot]`)
 * depending on the surface, so both spellings are matched.
 */
const BOT_LOGINS = new Set(['github-actions', 'dependabot', 'renovate', 'copilot', 'copilot-swe-agent']);

/** True when this login is automation. A missing login is NOT a bot — nobody
 *  recorded who acted, which is a different fact, and each caller answers it its
 *  own way (the ring folds it in with the bots; the recency line still names the
 *  close, because the work behind it was somebody's). */
export function isBotActor(login: string): boolean {
  const l = login.toLowerCase();
  return l.endsWith('[bot]') || BOT_LOGINS.has(l);
}
