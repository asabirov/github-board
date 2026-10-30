const formats = new Map<string, Intl.DateTimeFormat>();

/** Date-only grid coordinate: local calendar parts encoded at UTC midnight. */
export function calendarDate(at: number, timeZone = 'UTC'): number {
  if (!Number.isFinite(at)) return NaN;
  if (timeZone === 'UTC') return Math.floor(at / 86_400_000) * 86_400_000;
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (formats.size >= 32) formats.clear();
    formats.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'));
}
