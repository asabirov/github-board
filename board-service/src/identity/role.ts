/**
 * A board-assigned member role (#332). Stored on the Identity row and
 * authoritative: an admin sets it in the person editor and it grants real
 * access (admin ⇒ board admin; writer/reader are the write posture). Decoupled
 * from Google-group ownership — the group is used only for membership. When a
 * member has no stored role, the effective role falls back to a default derived
 * from their linked GitHub login (writer if linked, else reader).
 */
export type MemberRole = 'admin' | 'writer' | 'reader';

export const MEMBER_ROLES: readonly MemberRole[] = ['admin', 'writer', 'reader'];

export function isMemberRole(v: unknown): v is MemberRole {
  return v === 'admin' || v === 'writer' || v === 'reader';
}
