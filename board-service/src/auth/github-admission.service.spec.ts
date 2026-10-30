import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { GithubAdmissionService, parseGithubAllowList } from './github-admission.service';

const getByUsername = vi.fn();
const getMembership = vi.fn();
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    rest = {
      users: { getByUsername },
      orgs: { getMembershipForAuthenticatedUser: getMembership },
    };
  },
}));

function svc(raw: string, extra: Record<string, string> = {}): GithubAdmissionService {
  return new GithubAdmissionService(new ConfigService({ BOARD_ALLOWED_GITHUB: raw, ...extra }));
}

afterEach(() => {
  getByUsername.mockReset();
  getMembership.mockReset();
});

describe('parseGithubAllowList', () => {
  it('separates numeric ids, plain logins and org: entries, case-insensitively', () => {
    expect(parseGithubAllowList('octocat, 12345, org:Acme, Org:Other,  OCTOCAT ')).toEqual({
      ids: ['12345'],
      logins: ['octocat', 'octocat'],
      orgs: ['acme', 'other'],
    });
  });

  it('drops empty entries and an org: prefix with nothing after it', () => {
    expect(parseGithubAllowList(' , org:, octocat')).toEqual({ ids: [], logins: ['octocat'], orgs: [] });
  });
});

describe('the GitHub sign-in allow list', () => {
  it('admits every GitHub user when the list is empty', async () => {
    const s = svc('');
    expect(s.empty()).toBe(true);
    await expect(s.admits('12345', 'anyone', { token: 'user-token' })).resolves.toBe(true);
    expect(getByUsername).not.toHaveBeenCalled();
    expect(getMembership).not.toHaveBeenCalled();
  });

  it('admits a numeric id and refuses another without a GitHub call', async () => {
    const s = svc('12345');
    await expect(s.admits('12345', 'octocat', { token: 'user-token' })).resolves.toBe(true);
    await expect(s.admits('99999', 'octocat', { token: 'user-token' })).resolves.toBe(false);
    expect(getByUsername).not.toHaveBeenCalled();
    expect(getMembership).not.toHaveBeenCalled();
  });

  it('resolves a named login to its id once and admits the account that owns it after a rename', async () => {
    const s = svc('octocat', { GITHUB_TOKEN: 'machine-token' });
    getByUsername.mockResolvedValue({ data: { id: 12345, login: 'octocat' } });
    // The person renamed their login, so it no longer matches the entry; the
    // stable id resolved from the entry still does.
    await expect(s.admits('12345', 'renamed-user', { token: 'user-token' })).resolves.toBe(true);
    await expect(s.admits('12345', 'renamed-user', { token: 'user-token' })).resolves.toBe(true);
    expect(getByUsername).toHaveBeenCalledTimes(1); // second answer came from the cache
    // A different account is not admitted by the same entry.
    await expect(s.admits('99999', 'renamed-user', { token: 'user-token' })).resolves.toBe(false);
  });

  it('fails closed when a named login cannot be resolved', async () => {
    const s = svc('octocat', { GITHUB_TOKEN: 'machine-token' });
    getByUsername.mockRejectedValueOnce(new Error('network down'));
    await expect(s.admits('12345', 'octocat', { token: 'user-token' })).resolves.toBe(false);
  });

  it('refuses a named login rule when no machine token is configured', async () => {
    const s = svc('octocat');
    await expect(s.admits('12345', 'octocat', { token: 'user-token' })).resolves.toBe(false);
    expect(getByUsername).not.toHaveBeenCalled();
  });

  it('admits an active organisation member and refuses a pending one', async () => {
    const s = svc('org:acme');
    getMembership.mockResolvedValueOnce({ data: { state: 'active' } });
    await expect(s.admits('12345', 'member', { token: 'user-token', credentialVersion: 'v1' })).resolves.toBe(true);
    getMembership.mockResolvedValueOnce({ data: { state: 'pending' } });
    await expect(s.admits('99999', 'outsider', { token: 'user-token', credentialVersion: 'v1' })).resolves.toBe(false);
    expect(getMembership).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the membership check cannot be read', async () => {
    const s = svc('org:acme');
    getMembership.mockRejectedValueOnce(new Error('network down'));
    await expect(s.admits('12345', 'member', { token: 'user-token' })).resolves.toBe(false);
  });

  it('refuses an org rule for a caller with no credential token', async () => {
    const s = svc('org:acme');
    await expect(s.admits('12345', 'member')).resolves.toBe(false);
    expect(getMembership).not.toHaveBeenCalled();
  });

  it('caches a membership answer briefly, then re-checks when the credential version moves', async () => {
    const s = svc('org:acme');
    getMembership.mockResolvedValue({ data: { state: 'active' } });
    await expect(s.admits('12345', 'member', { token: 'user-token', credentialVersion: 'v1' })).resolves.toBe(true);
    await expect(s.admits('12345', 'member', { token: 'user-token', credentialVersion: 'v1' })).resolves.toBe(true);
    expect(getMembership).toHaveBeenCalledTimes(1); // second answer came from the cache

    // A refreshed credential carries a new version, so the answer is re-read.
    await expect(s.admits('12345', 'member', { token: 'user-token', credentialVersion: 'v2' })).resolves.toBe(true);
    expect(getMembership).toHaveBeenCalledTimes(2);
  });
});
