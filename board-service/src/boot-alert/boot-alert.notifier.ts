import { configuredRepository } from '../config/github-destination';
import { Logger, LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { buildOctokitClient } from '../sources/github-client';
import { classifyGithubError } from '../capability/github-refusal';
import { learnRefusal } from '../capability/learn-refusal';
import type { CapabilityRegistry } from '../capability/capability.registry';
import { CapturedLog } from './boot-error-recorder';
import { composeComment, composeIssue } from './boot-alert.vm';
import type { AuditRecorder } from '../audit/audit.types';
import { BOOT_ALERT_REPO_UNSET } from '../config/github-orgs';

/**
 * Reports a boot error as a Github issue (#592).
 *
 * The platform's only alert primitive is a cpu/memory/disk threshold with
 * nowhere to send anything, so an error logged on the way up reached nobody.
 * This reuses the write path the feedback form already runs on — same Octokit
 * factory, same repo, same credential.
 *
 * Two things switch it on and they are already set in production: writes have to
 * be enabled and a Github credential has to exist. Where either is missing — a
 * laptop, a CI job — the whole feature is silent, which is what makes it safe to
 * leave switched on everywhere.
 *
 * WHERE it reports was configuration-by-default until #1175, and is now
 * `BOOT_ALERT_REPO`, required of any board that can write. The default was this
 * board's own repository, which was renamed twice in two days; a report filed at
 * a guessed address under the shared write token is the one thing this feature
 * must not do.
 *
 * Nothing in here may cost the service its boot. It runs after `listen` has
 * resolved, so the service is already serving, and every path out of it returns
 * rather than throws.
 *
 * Both writes are audited under `boot.alert` (#781). This is board's one Github
 * write on nobody's behalf, so the actor is `system` rather than a person — the
 * same name `identity.seed` records under. It is audited rather than exempted
 * because the README claim #774 earned ("a board that can write cannot run
 * without the trail") was false of exactly this file, and an operator reading
 * the trail should find the comment the board posted about its own failed boot.
 */
export async function reportBootErrors(
  config: ConfigService,
  captured: CapturedLog[],
  logger: LoggerService = new Logger('BootAlert'),
  dropped = 0,
  /** #584 — a plain function parameter, not a Nest one, so no DI metadata is
   *  involved. Optional because `boot-alert.spec.ts` calls this directly, and a
   *  required fifth argument in every one of those calls would buy nothing. */
  registry?: CapabilityRegistry,
  /** #781 — optional for the same reason `registry` is: the specs drive this
   *  function directly. `main.ts` passes `app.get(AuditService)`. */
  audit?: AuditRecorder,
): Promise<void> {
  if (captured.length === 0) return;
  try {
    if (!config.get<boolean>('GITHUB_WRITE_ENABLED', false)) return;
    if (!hasGithubCredential(config)) return;
    // The notifier is the one routeless Github write, so no guard can stand in
    // front of it and it consults the registry itself. Without this,
    // GITHUB_CAPABILITIES_DENY=boot-alert.file is accepted, reported refused,
    // and the notifier writes anyway.
    if (registry?.state('boot-alert.file').state === 'refused') {
      logger.log('boot error not reported: boot-alert.file is refused');
      return;
    }
    await file(config, captured, logger, dropped, registry, audit);
  } catch (err) {
    // A report that cannot be filed is worth a line, and worth nothing more —
    // the service is up and serving, and this is the last thing between here
    // and that being true.
    try {
      logger.error(`could not report the boot error to Github: ${asMsg(err)}`);
    } catch {
      /* the logger itself is gone; there is nowhere left to say so */
    }
  }
}

async function file(
  config: ConfigService,
  captured: CapturedLog[],
  logger: LoggerService,
  dropped: number,
  registry?: CapabilityRegistry,
  audit?: AuditRecorder,
): Promise<void> {
  let target = repoFrom(config);
  if (!target) {
    // Nothing in here may cost the service its boot, so this says so and
    // returns. A deployment cannot reach it: Joi requires the key wherever
    // writes are on, and writes being on is what got us this far.
    logger.log(`boot error not reported: ${BOOT_ALERT_REPO_UNSET}`);
    return;
  }
  const label = config.get<string>('BOOT_ALERT_LABEL', 'boot-error').trim();
  if (!label) return;
  const configuredAssignee = config.get<string>('BOOT_ALERT_ASSIGNEE');
  if (configuredAssignee == null) {
    // Startup validation owns the operator-visible refusal; protect direct callers too.
    logger.error('BOOT_ALERT_ASSIGNEE is not set; cannot assign boot alerts. Set BOOT_ALERT_ASSIGNEE.');
    return;
  }
  const assignee = configuredAssignee.trim();

  const boot = {
    at: new Date().toISOString(),
    version: config.get<string>('APP_VERSION') || null,
    environment: config.get<string>('NODE_ENV') || null,
    dropped,
  };

  // A write client (#584). One client serves the dedupe read below as well as
  // the two writes, and that is on purpose: the read exists only to decide
  // which of the two writes to make, and asking it under a different credential
  // could find an issue the writing credential cannot comment on.
  const octokit = buildOctokitClient(config, 'write');
  target = await configuredRepository(config, 'BOOT_ALERT_REPO', octokit);

  /**
   * Around the two WRITE calls and nothing else (#584).
   *
   * `reportBootErrors`'s outer catch also wraps the dedupe read below, and
   * recording from there would file a read failure as a write refusal — which
   * would take `boot-alert.file` dark on a credential that can write perfectly
   * well.
   *
   * `target` is the `{ owner, repo }` this function already resolved; `where` is
   * the `owner/repo` STRING the classifier and the registry key on. Two names
   * because one of them is an object.
   *
   * No re-read is passed: the notifier addresses a repository named in config,
   * and a 404 there is a misconfigured BOOT_ALERT_REPO rather than a permission,
   * so learning nothing from it is right.
   */
  const write = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const where = `${target.owner}/${target.repo}`;
      await learnRefusal({
        registry,
        capability: 'boot-alert.file',
        target: where,
        refusal: classifyGithubError(err, { capability: 'boot-alert.file', target: where }),
      });
      throw err;
    }
  };

  // Dedupe before writing. A crash loop restarts the service every few seconds,
  // and each restart logs the same error; one issue with a comment per restart
  // is a thing somebody can read, a hundred issues is not.
  const open = await octokit.issues.listForRepo({
    ...target,
    state: 'open',
    labels: label,
    per_page: 1,
  });
  const existing = open.data[0];

  if (existing) {
    const comment = await write(() =>
      octokit.issues.createComment({
        ...target,
        issue_number: existing.number,
        body: composeComment(captured, boot),
      }),
    );
    logger.log(`boot error added to ${comment.data.html_url}`);
    await record(audit, existing.number, `Commented a boot error on #${existing.number}`);
    return;
  }

  const issue = composeIssue(captured, boot);
  const created = await write(() =>
    octokit.issues.create({
      ...target,
      title: issue.title,
      body: issue.body,
      labels: [label],
      ...(assignee ? { assignees: [assignee] } : {}),
    }),
  );
  logger.log(`boot error filed as ${created.data.html_url}`);
  await record(audit, created.data.number, `Filed a boot error as #${created.data.number}`);
}

/**
 * After the write, never before: a row claiming a write that then failed is
 * worse than no row. `AuditService.record` already swallows its own failures and
 * counts them (#781), so nothing here needs a try — but the notifier may be
 * handed any `AuditRecorder`, and one that throws must not cost the report that
 * has already been filed.
 */
async function record(audit: AuditRecorder | undefined, issueNumber: number, summary: string): Promise<void> {
  if (!audit) return;
  try {
    await audit.record({
      actorEmail: 'system',
      action: 'boot.alert',
      summary,
      targetType: 'issue',
      targetId: String(issueNumber),
    });
  } catch {
    /* the trail's own failure path owns this; the report is already filed */
  }
}

/**
 * Is there anything to authenticate with? `buildOctokitClient` prefers a token
 * and falls back to a Github App, so this asks the same question in the same
 * order — and asks it BEFORE building, so a machine with no credential makes no
 * client and therefore no call.
 */
function hasGithubCredential(config: ConfigService): boolean {
  if (read(config, 'GITHUB_TOKEN')) return true;
  return Boolean(
    read(config, 'GITHUB_APP_ID') &&
      read(config, 'GITHUB_PRIVATE_KEY') &&
      read(config, 'GITHUB_INSTALLATION_ID'),
  );
}

/**
 * The repo the report lands in — whichever one the deployment named.
 *
 * It defaulted to this board's own repository until #1175. What that default
 * promised is that being silent was safe, and the repository was renamed twice
 * in two days without anything here being told; the second rename took the
 * board's own name with it. So `config.schema.ts` requires the key of any board
 * that can write, and this answers `null` for anything else.
 */
function repoFrom(config: ConfigService): { owner: string; repo: string } | null {
  const full = config.get<string>('BOOT_ALERT_REPO');
  // The absent key is answered as absent rather than normalised to `''` first:
  // an unset key that becomes an empty string has been decided for, which is
  // the shape `github-orgs.spec.ts` census now refuses on all four settings.
  if (full == null) return null;
  const [owner, repo] = full.split('/').map((part) => part.trim());
  return owner && repo ? { owner, repo } : null;
}

function read(config: ConfigService, key: string): string {
  return (config.get<string>(key, '') ?? '').trim();
}

function asMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
