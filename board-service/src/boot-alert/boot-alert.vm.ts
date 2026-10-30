// Pure composition (#592): captured boot errors → the Github issue fields.
// No I/O — the notifier writes; this shapes.

import { CapturedLog } from './boot-error-recorder';

/** What the report says about the boot itself, beside what was logged. */
export interface BootContext {
  at: string;
  version: string | null;
  environment: string | null;
  dropped: number;
}

/** One title, because the marker label is what dedupes, not the wording. */
export const BOOT_ALERT_TITLE = 'board-service logged an error while starting';

const FENCE = '```';

/**
 * The lead. It says what happened and why an issue is how it reached you, since
 * whoever opens this may not know the service files its own.
 */
const LEAD =
  'board-service started, and something logged an error on the way up. Nothing watches production ' +
  'for us, so the service reports its own — one open issue under its marker label, and a comment on ' +
  'that issue for every restart after it.';

const REPEAT_LEAD =
  'board-service restarted and logged an error again. Same marker, so it lands here rather than as a ' +
  'second issue.';

export function composeIssue(captured: CapturedLog[], boot: BootContext): { title: string; body: string } {
  return { title: BOOT_ALERT_TITLE, body: [LEAD, '', ...report(captured, boot)].join('\n') };
}

export function composeComment(captured: CapturedLog[], boot: BootContext): string {
  return [REPEAT_LEAD, '', ...report(captured, boot)].join('\n');
}

function report(captured: CapturedLog[], boot: BootContext): string[] {
  const lines = [
    `- Reported: ${boot.at}`,
    `- Image version: ${boot.version ?? 'not stamped'}`,
    `- Environment: ${boot.environment ?? 'unknown'}`,
    `- Logged at error or above: ${captured.length + boot.dropped}`,
  ];
  if (boot.dropped > 0) {
    lines.push(
      '',
      `Only the first ${captured.length} are below. The other ${boot.dropped} arrived after the report ` +
        'filled up, which on its own says the failure is repeating.',
    );
  }
  for (const [index, entry] of captured.entries()) lines.push('', ...section(index + 1, entry));
  return lines;
}

function section(position: number, entry: CapturedLog): string[] {
  const where = entry.context ? ` — ${entry.context}` : '';
  const lines = [`### ${position}. ${entry.level}${where}`, '', fenced(entry.message)];
  if (entry.detail) lines.push('', '<details><summary>Detail</summary>', '', fenced(entry.detail), '', '</details>');
  return lines;
}

/** Fenced, because a logged message is text the service produced, not prose. */
function fenced(text: string): string {
  return [FENCE, text.replace(/```/g, "'''"), FENCE].join('\n');
}
