import { BadRequestException } from '@nestjs/common';
import { IdentityData } from './identity.repository';
import { MemberRole, isMemberRole } from './role';

// Keep the store clean and avoid injecting junk into downstream GitHub/ClickUp
// lookups. Caps are generous for a small team; the point is to reject abuse.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/; // GitHub login charset
const CLICKUP_ID_RE = /^[0-9]{1,20}$/;
const MAX_ARRAY = 20;
const MAX_NAME = 120;
const MAX_STR = 200; // per-entry length cap (emails/names) — reject megabyte junk

/**
 * EVERY SENTENCE IN THIS FILE IS SHOWN, and that is why `field` is now the
 * dialog's own label rather than the wire key.
 *
 * `upsertIdentity` throws whatever the 400 carries (`api.ts:1739`, through
 * `readErrorReason`) and the Admin Access dialog draws it under the form,
 * unchanged (`AccessSection.tsx:424`). So `clickupUserId must be a numeric id`
 * and `emails: at least one is required` were being read by a person looking at
 * fields labelled ClickUp user ID and Emails, in the shape of a validator
 * talking to a client (#1056). The names below are the labels in that dialog,
 * so a refusal points at the field it is about.
 */
function cleanStrings(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new BadRequestException(`${field} did not arrive as a list.`);
  if (v.length > MAX_ARRAY) throw new BadRequestException(`${field} holds at most ${MAX_ARRAY} entries.`);
  return v.map((s) => {
    if (typeof s !== 'string') throw new BadRequestException(`Every entry under ${field} has to be text.`);
    const t = s.trim();
    if (t.length > MAX_STR) {
      throw new BadRequestException(`An entry under ${field} is at most ${MAX_STR} characters.`);
    }
    return t;
  }).filter(Boolean);
}

function validEmails(v: unknown): string[] {
  const emails = cleanStrings(v, 'Emails');
  if (emails.length === 0) throw new BadRequestException('A person needs at least one address under Emails.');
  for (const e of emails) {
    if (!EMAIL_RE.test(e)) throw new BadRequestException(`“${e}” is not an email address.`);
  }
  return emails;
}

function validHandle(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new BadRequestException(`${field} did not arrive as text.`);
  const h = v.trim().replace(/^@/, '');
  if (!h) return null;
  if (!HANDLE_RE.test(h)) throw new BadRequestException(`“${h}” is not a GitHub login.`);
  return h;
}

function validClickupId(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new BadRequestException('ClickUp user ID did not arrive as text.');
  const id = v.trim();
  if (!id) return null;
  if (!CLICKUP_ID_RE.test(id)) throw new BadRequestException('A ClickUp user ID is digits and nothing else.');
  return id;
}

/** A board-assigned role, or null to clear the override (#332). Only called when
 *  the `role` key is present; an absent key leaves the stored role untouched (see
 *  validateUpsert), so a partial edit can never silently wipe someone's role. */
function validRole(v: unknown): MemberRole | null {
  if (v === null || v === '') return null;
  // The one sentence in this file that names WIRE VALUES and not a dialog
  // label, because values are what it is about and the dialog cannot produce a
  // wrong one: `AccessSection`'s control offers `admin | writer | reader` and
  // maps them to Admin, Writer and Reader for the reader. So the only caller
  // who ever meets this sentence is one sending a role by hand, and telling
  // that caller "Admin" gets its next request refused too (#1080 review).
  if (!isMemberRole(v)) throw new BadRequestException('A role is admin, writer or reader.');
  return v;
}

function validName(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new BadRequestException('A person needs a display name.');
  if (v.trim().length > MAX_NAME) {
    throw new BadRequestException(`A display name is at most ${MAX_NAME} characters.`);
  }
  return v.trim();
}

function validKeyEmail(v: unknown): string {
  // The roster key, not the Emails field, and the sentence says so without
  // naming the key: whoever meets this has an edit the board cannot file
  // against anybody.
  if (typeof v !== 'string' || !v.trim()) {
    throw new BadRequestException('This edit does not say which person it is for.');
  }
  const e = v.trim().toLowerCase();
  // Not the same words as `validEmails`, on purpose. Both said "“{}” is not an
  // email address." and the record keys on the file and the sentence, so one
  // row stood for two fields and the census read 143 sentences where the tree
  // had 144 (#1080 review). This one is about WHICH PERSON the edit is for, and
  // it now says so.
  if (!EMAIL_RE.test(e)) {
    throw new BadRequestException(`This edit is for “${e}”, which is not an email address.`);
  }
  return e;
}

/**
 * Validate + normalize an upsert payload. `email` is the roster key (which
 * identity to write); the rest is the full identity to store. Throws BadRequest
 * on any bad field.
 */
export function validateUpsert(body: Record<string, unknown>): { keyEmail: string; data: IdentityData } {
  return {
    keyEmail: validKeyEmail(body.email),
    data: {
      displayName: validName(body.displayName),
      emails: validEmails(body.emails),
      githubLogin: validHandle(body.githubLogin, 'GitHub login'),
      clickupUserId: validClickupId(body.clickupUserId),
      clickupNames: body.clickupNames === undefined ? [] : cleanStrings(body.clickupNames, 'ClickUp names'),
      // Absent `role` key ⇒ undefined ⇒ the repo leaves the stored role unchanged
      // (a partial edit never wipes a role). An explicit null clears the override.
      role: 'role' in body ? validRole(body.role) : undefined,
    },
  };
}
