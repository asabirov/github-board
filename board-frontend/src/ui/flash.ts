import { toast } from './kit';

/** Keep clipboard and mutation callers on one API while the kit owns presentation. */
export function flash(message: string, tone: 'default' | 'danger' = 'default'): void {
  if (tone === 'danger') toast.error(message);
  else toast(message);
}
