import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { validateUpsert } from './identity.validation';

const base = {
  email: 'maria.lopez@example.com',
  displayName: 'Maria Lopez',
  emails: ['maria.lopez@example.com'],
};

describe('validateUpsert (#11)', () => {
  it('accepts and normalizes a valid payload', () => {
    const { keyEmail, data } = validateUpsert({
      ...base,
      email: 'Maria.Lopez@example.com',
      githubLogin: '@mlopez',
      clickupUserId: ' 48901234 ',
      clickupNames: [' Maria ', ''],
    });
    expect(keyEmail).toBe('maria.lopez@example.com');
    expect(data.githubLogin).toBe('mlopez'); // @ stripped
    expect(data.clickupUserId).toBe('48901234');
    expect(data.clickupNames).toEqual(['Maria']);
  });

  it('treats empty github / clickup as null (clearing a field)', () => {
    const { data } = validateUpsert({ ...base, githubLogin: '', clickupUserId: '' });
    expect(data.githubLogin).toBeNull();
    expect(data.clickupUserId).toBeNull();
  });

  it('requires a valid key email', () => {
    expect(() => validateUpsert({ ...base, email: 'not-an-email' })).toThrow(BadRequestException);
    expect(() => validateUpsert({ ...base, email: '' })).toThrow(BadRequestException);
  });

  it('requires a displayName and at least one email', () => {
    expect(() => validateUpsert({ ...base, displayName: '  ' })).toThrow(BadRequestException);
    expect(() => validateUpsert({ ...base, emails: [] })).toThrow(BadRequestException);
  });

  it('rejects a malformed email in the list', () => {
    expect(() => validateUpsert({ ...base, emails: ['ok@x.com', 'bad'] })).toThrow(BadRequestException);
  });

  it('rejects an out-of-charset GitHub login', () => {
    expect(() => validateUpsert({ ...base, githubLogin: 'bad handle!' })).toThrow(BadRequestException);
  });

  it('rejects a non-numeric ClickUp id', () => {
    expect(() => validateUpsert({ ...base, clickupUserId: 'abc' })).toThrow(BadRequestException);
  });

  it('caps array length', () => {
    const many = Array.from({ length: 50 }, (_, i) => `n${i}`);
    expect(() => validateUpsert({ ...base, clickupNames: many })).toThrow(BadRequestException);
  });

  it('rejects an over-long entry (megabyte-junk guard)', () => {
    const huge = `${'a'.repeat(300)}@x.com`;
    expect(() => validateUpsert({ ...base, emails: ['ok@x.com', huge] })).toThrow(BadRequestException);
  });
});
