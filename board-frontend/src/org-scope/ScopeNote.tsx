/**
 * The one shape a quiet line about scope is drawn in (#714).
 *
 * `ScopeLine` established it for the flow strip and `OrgScopeNotice` for the
 * union's own missing orgs: 12.5px tertiary, no box, no border, no margin of its
 * own — the call site owns the gap to the numbers above. A second surface needed
 * the same line, so the markup lives here once rather than being copied into
 * each page that draws a sentence from `scope-copy.ts`.
 *
 * It holds no sentences and reads no hooks. What to say is `scope-copy.ts`'s
 * answer and whose page it is is the caller's; this only draws.
 */
import type { ReactElement } from 'react';
import { MetricHelp } from '../flow-strip/MetricHelp';

/** The line's own type ramp. Exported because `ScopeLine` is built on it. */
export const SCOPE_LINE = 'text-[12.5px] leading-[1.5] text-muted';
/** Github's own words, on their own line under the sentence that needs them —
 *  `OrgScopeNotice`'s shape, so every reason on this board reads as one voice. */
const REASON = 'block text-[12px] text-muted';

/**
 * `said` is every sentence for this line, in reading order; nulls are dropped,
 * so a caller composes with the `string | null` the copy functions return rather
 * than filtering at each call site. Renders NOTHING when nothing is left, which
 * is the union's case on every surface that uses this.
 */
export function ScopeNote({ said, reason = null, className = '', tooltip = false }: {
  tooltip?: boolean;
  said: readonly (string | null)[];
  reason?: string | null;
  className?: string;
}): ReactElement | null {
  const sentences = said.filter((s): s is string => s !== null && s !== '');
  if (sentences.length === 0) return null;
  if (tooltip && reason === null) return <div className={className}><MetricHelp align="left" label="Scope details">{sentences.join(' ')}</MetricHelp></div>;
  return (
    <p className={`${SCOPE_LINE} ${className}`}>
      {sentences.join(' ')}
      {reason != null && <span className={REASON}>{reason}</span>}
    </p>
  );
}
