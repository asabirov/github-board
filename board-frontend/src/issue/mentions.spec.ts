import { describe, expect, it } from 'vitest';
import { mentionAt, mentionCandidates, insertMention } from './mentions';

describe('mention suggestions', () => {
  it('finds only a mention token at the caret, not email or a selection', () => {
    expect(mentionAt('Hello (@Ann!', 11, 11)).toEqual({ start: 7, end: 11, query: 'Ann' });
    expect(mentionAt('@', 1, 1)?.query).toBe('');
    for (const value of ['a@b', '@ann ', 'https://x/@ann', '@@ann']) expect(mentionAt(value, value.length, value.length)).toBeNull();
    expect(mentionAt('@ann', 4, 1)).toBeNull();
  });
  it('prioritizes issue participants, deduplicates logins and matches names case insensitively', () => {
    const people = mentionCandidates([{ login: 'Zoe', name: 'Zoë Smith' }, { login: 'ANN', name: null }], [{ login: 'ann', name: 'Ann Baker' }, { login: 'bert', name: 'Bert Smith' }], []);
    expect(people.map(p => p.login)).toEqual(['Zoe', 'ANN', 'bert']);
    expect(people[1].name).toBe('Ann Baker');
    expect(mentionCandidates(people, [], [], 'SMITH').map(p => p.login)).toEqual(['Zoe', 'bert']);
  });
  it('replaces the full token while retaining surrounding text and positions the caret', () => {
    expect(insertMention('Hi @anna, thanks', { start: 3, end: 6, query: 'an' }, 'ann')).toEqual({ value: 'Hi @ann , thanks', caret: 8 });
  });
});
