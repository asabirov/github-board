/**
 * The shared person avatar + its colour helpers. Lifted out of the retired
 * roadmap module (was roadmap/RoadmapRows) so the roster, access list, project
 * table, and account chip can keep it after the roadmap page is gone.
 */

import { useState, type CSSProperties } from 'react';

const AV_PALETTE = ['#5f74a8', '#a884c9', '#c9a35a', '#c96f5a', '#7fa26d', '#7a9bd1'];

export function avatarColor(seed: string | null): string {
  if (!seed) return '#8e8b80';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AV_PALETTE[h % AV_PALETTE.length];
}

export function initialOf(name: string | null): string {
  return name && name.trim() ? name.trim()[0].toUpperCase() : '·';
}

/**
 * Person avatar (#95): real GitHub profile photo when a login is known
 * (github.com/<login>.png needs no API and no token), hash-colored initials
 * otherwise — and again if the photo 404s (deleted account, offline).
 */
export function Avatar({ name, login, className, style, px, showTitle = true }: {
  name: string | null;
  login?: string | null;
  /** Extra class for size overrides (e.g. the person header's pd-av). */
  className?: string;
  /** Per-instance paint the class can't carry — the member-colour ring on a
   *  clustered assignee (#477), where every avatar in the cluster differs. */
  style?: CSSProperties;
  /** Requested image resolution — bump for slots larger than the 24px default. */
  px?: number;
  /** The native name-on-hover title. Kept by default (a standalone avatar's only
   *  identity reveal); pass false when a wrapping control already carries a styled
   *  tooltip that names the person, so the two don't stack (#334). */
  showTitle?: boolean;
}) {
  // Track WHICH login 404'd, not a boolean: React reuses this instance across
  // people, so a plain `broken` flag would stick and hide the next person's photo.
  const [broken, setBroken] = useState<string | null>(null);
  const extra = className ? ` ${className}` : '';
  const title = showTitle ? name ?? login ?? undefined : undefined;
  if (login && broken !== login) {
    return (
      <img
        className={`rok-av rok-av-img${extra}`}
        style={style}
        src={`https://github.com/${encodeURIComponent(login)}.png?size=${px ?? 64}`}
        alt=""
        title={title}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(login)}
      />
    );
  }
  return (
    <span className={`rok-av${extra}`} style={{ background: avatarColor(name), ...style }} title={title}>
      {initialOf(name)}
    </span>
  );
}
