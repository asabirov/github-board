import { describe, it, expect } from 'vitest';
import {
  completionPct,
  deriveProjectStatus,
  isSurfacedProjectName,
  relativeTime,
} from './project-derive';

const NOW = Date.parse('2026-07-24T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86400_000).toISOString();

describe('isSurfacedProjectName', () => {
  it('drops auto-named personal boards and the "Acme" umbrella (#202)', () => {
    expect(isSurfacedProjectName("@octocat's untitled project")).toBe(false);
    expect(isSurfacedProjectName('Acme')).toBe(false);
    expect(isSurfacedProjectName('  acme  ')).toBe(false); // trimmed, case-insensitive
  });

  it('keeps focused boards, including ones whose name starts with "Acme"', () => {
    expect(isSurfacedProjectName('Acme Go-To-Market')).toBe(true);
    expect(isSurfacedProjectName('Board re-platform')).toBe(true);
    expect(isSurfacedProjectName('Sanctions launch gate')).toBe(true);
  });
});

describe('completionPct', () => {
  it('is closed / (open + closed), rounded', () => {
    expect(completionPct(9, 88)).toBe(91);
    expect(completionPct(23, 21)).toBe(48);
    expect(completionPct(5, 13)).toBe(72);
  });
  it('is 0 for an empty board', () => {
    expect(completionPct(0, 0)).toBe(0);
  });
});

describe('deriveProjectStatus', () => {
  it('is active when something closed within 3 days', () => {
    expect(deriveProjectStatus({ open: 9, closed: 88, lastClosedAtISO: daysAgo(1) }, NOW)).toBe('active');
  });
  it('is just-started when at most one issue is closed', () => {
    expect(deriveProjectStatus({ open: 5, closed: 1, lastClosedAtISO: daysAgo(30) }, NOW)).toBe('just-started');
  });
  it('is stalled with open work and nothing closed in 45+ days', () => {
    expect(deriveProjectStatus({ open: 5, closed: 10, lastClosedAtISO: daysAgo(60) }, NOW)).toBe('stalled');
  });
  it('is in-progress for steady work in between', () => {
    expect(deriveProjectStatus({ open: 23, closed: 21, lastClosedAtISO: daysAgo(10) }, NOW)).toBe('in-progress');
  });
  it('treats a board that never closed anything as just-started', () => {
    expect(deriveProjectStatus({ open: 2, closed: 0, lastClosedAtISO: null }, NOW)).toBe('just-started');
  });
});

describe('relativeTime', () => {
  it('renders days and months', () => {
    expect(relativeTime(daysAgo(1), NOW)).toBe('1d ago');
    expect(relativeTime(daysAgo(45), NOW)).toBe('1mo ago');
  });
  it('returns empty for an unparseable time', () => {
    expect(relativeTime('nonsense', NOW)).toBe('');
  });
});

describe('a board whose work was all abandoned is not "just-started" (#1014)', () => {
  const OLD = '2026-01-01T00:00:00.000Z';
  const NOW = Date.parse('2026-09-10T12:00:00.000Z');

  it('refuses the word when issues were closed and none of them delivered', () => {
    // Since #1014 `closed` counts delivery, so a board that worked through ten
    // issues and dropped every one arrives as `closed: 0`. Called "just-started"
    // it makes a claim about a board nobody has touched, about one that has been
    // touched a great deal and got nowhere.
    expect(deriveProjectStatus({ open: 0, closed: 0, lastClosedAtISO: OLD, abandoned: 10 }, NOW)).not.toBe('just-started');
    // With open work still on it and nothing delivered for months, that is what
    // `stalled` is for.
    expect(deriveProjectStatus({ open: 4, closed: 0, lastClosedAtISO: OLD, abandoned: 10 }, NOW)).toBe('stalled');
  });

  it('still says just-started for a board where nothing has happened at all', () => {
    expect(deriveProjectStatus({ open: 4, closed: 0, lastClosedAtISO: null, abandoned: 0 }, NOW)).toBe('just-started');
    // Absent means zero — a caller without the figure asserts nothing, not none.
    expect(deriveProjectStatus({ open: 4, closed: 0, lastClosedAtISO: null }, NOW)).toBe('just-started');
  });

  it('lets recency win over both, as it always did', () => {
    const recent = new Date(NOW - 2 * 24 * 3600 * 1000).toISOString();
    expect(deriveProjectStatus({ open: 1, closed: 1, lastClosedAtISO: recent, abandoned: 5 }, NOW)).toBe('active');
  });
});
