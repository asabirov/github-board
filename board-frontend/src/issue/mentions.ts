import type { Actor } from '../api/issues';
import type { Person } from '../api/people';

export interface MentionToken { start: number; end: number; query: string }

export function mentionAt(value: string, start: number, end: number): MentionToken | null {
  if (start !== end) return null;
  const match = /(?:^|[\s([{])@([\p{L}\p{N}_-]*)$/u.exec(value.slice(0, start));
  return match ? { start: start - match[1].length - 1, end: start, query: match[1] } : null;
}

export function mentionCandidates(participants: (Actor | null)[], assignable: Actor[], people: Person[], query = ''): Actor[] {
  const seen = new Map<string, Actor>();
  for (const actor of [...participants, ...assignable]) {
    if (!actor) continue;
    const key = actor.login.toLowerCase();
    const person = people.find(p => p.githubLogin?.toLowerCase() === key);
    const name = actor.name ?? person?.displayName ?? null;
    const previous = seen.get(key);
    if (!previous) seen.set(key, { login: actor.login, name });
    else if (!previous.name && name) seen.set(key, { ...previous, name });
  }
  const needle = query.toLowerCase();
  return [...seen.values()].filter(p => p.login.toLowerCase().includes(needle) || p.name?.toLowerCase().includes(needle));
}

export function insertMention(value: string, token: MentionToken, login: string) {
  const suffixLength = /^[\p{L}\p{N}_-]*/u.exec(value.slice(token.end))![0].length;
  const inserted = `@${login} `;
  return { value: value.slice(0, token.start) + inserted + value.slice(token.end + suffixLength), caret: token.start + inserted.length };
}
