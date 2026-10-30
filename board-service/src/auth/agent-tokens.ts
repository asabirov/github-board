import { timingSafeEqual } from 'crypto';

/**
 * Agent bearer tokens come from `BOARD_AGENT_TOKENS`: comma-separated
 * `name:secret` pairs where the secret is exactly 64 hex chars
 * (`openssl rand -hex 32`). Parsing throws on malformed input so a typo in
 * prod config fails the boot loudly instead of silently locking agents out.
 */
const SECRET_RE = /^[0-9a-f]{64}$/i;

/**
 * What a name may be: letters, digits, `_` and `-` (#525).
 *
 * The name is not a label. `jwt-auth.guard` writes it verbatim into the actor's
 * address as `agent:<name>`, and that address is carried, logged and compared
 * for the rest of the request. A name carrying an `@` produced `agent:claude@ci`
 * — shaped exactly like a person's address — so the shape of a string somebody
 * typed into an environment variable would be deciding what the caller IS.
 *
 * This is the second of two independent gates, not the only one. `isStaticAgent`
 * no longer reads the address at all: it keys on a flag set where the actor is
 * built (`static-agent.ts`), so a name that slipped through here could not
 * change what a caller is any more. This gate exists so a malformed name is
 * refused at the boundary it enters through, with the entry named, rather than
 * riding along into every log line and comparison downstream.
 *
 * The class is exactly the one `config/config.schema.ts` already enforces on
 * `BOARD_AGENT_TOKENS`, so no value passes one gate and fails the other. That
 * schema is why no such token could be configured in the first place; the two
 * stay written the same way so neither can quietly loosen alone.
 */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export function parseAgentTokens(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const trimmed = raw.trim();
  if (!trimmed) return out;
  for (const entry of trimmed.split(',')) {
    const sep = entry.indexOf(':');
    const name = sep === -1 ? '' : entry.slice(0, sep).trim();
    const secret = sep === -1 ? '' : entry.slice(sep + 1).trim();
    // Never echo the entry value: a bare secret without a colon would land in
    // the boot log otherwise.
    if (!name) throw new Error('BOARD_AGENT_TOKENS entry has no name before the colon');
    // JSON.stringify rather than bare quotes: an invalid name can carry a
    // newline or a control character, and a boot error has to stay one readable
    // line that shows exactly what was typed.
    if (!NAME_RE.test(name)) {
      throw new Error(
        `BOARD_AGENT_TOKENS name ${JSON.stringify(name)} may only contain letters, digits, "_" and "-". ` +
          'The name becomes the actor\'s address as `agent:<name>`, so anything else — an "@" above all — ' +
          'makes the token read as a person.',
      );
    }
    if (!SECRET_RE.test(secret)) {
      throw new Error(`BOARD_AGENT_TOKENS secret for "${name}" must be 64 hex chars`);
    }
    if (out.has(name)) throw new Error(`BOARD_AGENT_TOKENS has duplicate name "${name}"`);
    out.set(name, secret.toLowerCase());
  }
  return out;
}

/** Constant-time match of a presented bearer value against the token map. */
export function matchAgentToken(tokens: Map<string, string>, presented: string): string | null {
  if (!SECRET_RE.test(presented)) return null;
  const candidate = Buffer.from(presented.toLowerCase());
  for (const [name, secret] of tokens) {
    const expected = Buffer.from(secret);
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return name;
    }
  }
  return null;
}
