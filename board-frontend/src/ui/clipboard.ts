/**
 * Copy-to-clipboard with a quiet flash confirmation (#287/#291). Wraps the async
 * Clipboard API so callers get a one-liner; a denied/absent clipboard flashes an
 * error rather than failing silently.
 */
import { flash } from './flash';

export async function copyToClipboard(text: string, confirm: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash(confirm);
  } catch {
    flash('Couldn’t copy', 'danger');
  }
}
