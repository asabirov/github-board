import type { ConfigService } from '@nestjs/config';

/**
 * `CAPABILITY_GUARD_ENFORCING`, read in ONE place (#626).
 *
 * Five sites read this key — the guard, the three envelope callers and
 * `/api/auth/me` — and they used to carry their own fallback and their own
 * argument for it. Two of those arguments were opposite: the guard defaulted
 * `true` and the report defaulted `false`, so a board that could not read the
 * env would have refused a write while telling the client nothing was refused.
 * One reading removes the disagreement rather than documenting it.
 *
 * The fallback is UNREACHABLE while ConfigModule validates: an absent key
 * returns the schema's applied default (`config.schema.ts:375`, `true`), and a
 * value Joi cannot read aborts `NestFactory.create` before any of the five call
 * sites runs. It is here because `get`'s signature invites one.
 *
 * It is `true` because the guard fails closed. A caller that cannot tell what
 * the guard will do must not answer as though nothing will be refused: the guard
 * would refuse, and a report that said otherwise would contradict the board's
 * own behaviour. Erring toward "a refusal is in force" costs a control that is
 * drawn disabled; erring the other way promises a write that then 403s.
 */
export function capabilityGuardEnforcing(config: ConfigService): boolean {
  return config.get<boolean>('CAPABILITY_GUARD_ENFORCING', true);
}
