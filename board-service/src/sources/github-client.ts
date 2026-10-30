import { withGithubWriteIdentity } from './github-write-identity';
import { ForbiddenException } from '@nestjs/common';
import { githubPrincipal } from '../auth/github-principal';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createHash } from 'node:crypto';
import { withGithubRequestMetrics } from './github-request-metrics';
import { withGithubQuota } from './github-quota';
import { withGithubEtags } from './github-etag';

/** Both purposes use the acting person's token. Deployment jobs may keep
 * separate read/write credentials. */
export type OctokitPurpose = 'read' | 'write';

/** A present request is never allowed to fall back to deployment credentials. */
export function tokenFor(config: ConfigService, purpose: OctokitPurpose): string {
  const person = githubPrincipal();
  if (person) {
    if (!person.token) throw new ForbiddenException('Sign in with GitHub to use this surface');
    return person.token;
  }
  const write = config.get<string>('GITHUB_WRITE_TOKEN', '') ?? '';
  if (purpose === 'write' && write) return write;
  return config.get<string>('GITHUB_TOKEN', '') ?? '';
}

/** Whose Github budget and whose stored answers a person's request uses. `||`
 *  and not `??`: an empty id would otherwise be one key shared by everybody. */
export function personIdentity(githubUserId: string | null | undefined, email: string): string {
  return `user:${githubUserId || email.toLowerCase()}`;
}

/** Sources call this inside the principal context. Boot jobs and explicitly
 * detached login derivation use the deployment PAT or installation App. */
export function buildOctokitClient(config: ConfigService, purpose: OctokitPurpose = 'read'): Octokit {
  const token = tokenFor(config, purpose);
  const person = githubPrincipal();
  const identity = person
    ? personIdentity(person.githubUserId, person.email)
    : token
      ? `token:${createHash('sha256').update(token).digest('hex')}`
      : `app:${config.get<string>('GITHUB_APP_ID')}:${config.get<string>('GITHUB_INSTALLATION_ID')}`;
  const client = token
    ? new Octokit({ auth: token })
    : new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.get<string>('GITHUB_APP_ID'),
        privateKey: (config.get<string>('GITHUB_PRIVATE_KEY') ?? '').replace(/\\n/g, '\n'),
        installationId: Number(config.get<string>('GITHUB_INSTALLATION_ID')),
      },
    });
  if (purpose === 'write') withGithubWriteIdentity(client, config);
  return withGithubEtags(withGithubQuota(withGithubRequestMetrics(client, identity, 'surface'), identity), identity);
}
