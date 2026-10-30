import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { BootErrorRecorder } from './boot-error-recorder';
import { reportBootErrors } from './boot-alert.notifier';
import type { CapabilityRegistry } from '../capability/capability.registry';
import type { AuditRecorder, RecordAudit } from '../audit/audit.types';

// The notifier builds its Octokit lazily, exactly like the feedback source, so a
// stub here is the whole network. `vi.hoisted` so the spies exist before the
// mock factory runs.
const { create, createComment, listForRepo, buildOctokitClient } = vi.hoisted(() => ({
  create: vi.fn(),
  createComment: vi.fn(),
  listForRepo: vi.fn(),
  buildOctokitClient: vi.fn(),
}));
vi.mock('../sources/github-client', () => ({ buildOctokitClient }));

/** A config that answers the production defaults unless a test says otherwise. */
function cfg(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    GITHUB_WRITE_ENABLED: true,
    GITHUB_TOKEN: 'stub-credential',
    // Pinned rather than defaulted (#1166): the org in this file's expectations
    // is sample data, and it stopped being `BOOT_ALERT_REPO`'s default when the
    // organisation was renamed to `acme`.
    BOOT_ALERT_REPO: 'acme/board',
    BOOT_ALERT_REPO_ID: 42,
    BOOT_ALERT_ASSIGNEE: 'on-call',
    ...overrides,
  };
  return {
    get: (key: string, fallback?: unknown) => (values[key] === undefined ? fallback : values[key]),
  } as unknown as ConfigService;
}

/** A delegate that swallows output — the spec is not testing the console. */
function silentDelegate(): LoggerService {
  return {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    fatal: vi.fn(),
  } as unknown as LoggerService;
}

/**
 * One boot: install the recorder, let the modules log, then do what `main.ts`
 * does after `app.listen` resolves.
 */
async function boot(
  duringInit: (logger: LoggerService) => void,
  config: ConfigService = cfg(),
): Promise<void> {
  const recorder = new BootErrorRecorder(silentDelegate());
  duringInit(recorder);
  await reportBootErrors(config, recorder.drain());
}

const anOpenMarkerIssue = { number: 611, html_url: 'https://github.com/acme/board/issues/611' };

beforeEach(() => {
  vi.clearAllMocks();
  buildOctokitClient.mockImplementation(() => ({ issues: { create, createComment, listForRepo }, request: vi.fn().mockResolvedValue({ data: { id: 42, full_name: 'acme/board' } }) }));
  listForRepo.mockResolvedValue({ data: [] });
  create.mockResolvedValue({ data: { number: 612, html_url: 'https://github.com/x/y/issues/612' } });
  createComment.mockResolvedValue({ data: { html_url: 'https://github.com/x/y/issues/611#c1' } });
});

describe('a boot error reaches a person (#592)', () => {
  it('files exactly one issue when a module logs an error while starting', async () => {
    await boot((logger) => logger.error('cache warm refused by the store', 'at Store.warm (store.ts:31)', 'Store'));

    expect(create).toHaveBeenCalledTimes(1);
    expect(createComment).not.toHaveBeenCalled();
    const [args] = create.mock.calls[0];
    expect(args.owner).toBe('acme');
    expect(args.repo).toBe('board');
    expect(args.labels).toEqual(['boot-error']);
    expect(args.assignees).toEqual(['on-call']);
    expect(args.body).toContain('cache warm refused by the store');
    expect(args.body).toContain('Store');
  });

  it('reports a fatal the same way it reports an error', async () => {
    await boot((logger) => logger.fatal?.('the container gave up on a provider'));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].body).toContain('the container gave up on a provider');
  });

  it('files one issue however many errors the boot logged, and names them all', async () => {
    await boot((logger) => {
      logger.error('first thing that went wrong');
      logger.error('second thing that went wrong');
      logger.error('third thing that went wrong');
    });

    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0].body as string;
    expect(body).toContain('first thing that went wrong');
    expect(body).toContain('second thing that went wrong');
    expect(body).toContain('third thing that went wrong');
  });

  it('comments on the open marker issue instead of opening a second one', async () => {
    listForRepo.mockResolvedValue({ data: [anOpenMarkerIssue] });

    await boot((logger) => logger.error('the same failure, one restart later'));

    expect(create).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
    const [args] = createComment.mock.calls[0];
    expect(args.issue_number).toBe(611);
    expect(args.body).toContain('the same failure, one restart later');
  });

  it('asks Github only for open issues carrying the marker label', async () => {
    await boot((logger) => logger.error('anything at all'));

    expect(listForRepo).toHaveBeenCalledTimes(1);
    expect(listForRepo.mock.calls[0][0]).toMatchObject({
      owner: 'acme',
      repo: 'board',
      state: 'open',
      labels: 'boot-error',
    });
  });

  it('a crash loop leaves one issue and a comment per restart, never a second issue', async () => {
    await boot((logger) => logger.error('restart one'));
    expect(create).toHaveBeenCalledTimes(1);

    // Every later boot now finds what the first one filed.
    listForRepo.mockResolvedValue({ data: [anOpenMarkerIssue] });
    for (const restart of ['restart two', 'restart three', 'restart four']) {
      await boot((logger) => logger.error(restart));
    }

    expect(create).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledTimes(3);
  });
});

describe('what it does not report', () => {
  it('touches Github not at all on a clean boot', async () => {
    await boot((logger) => {
      logger.log('board service on :3000');
      logger.debug?.('a detail nobody needs');
    });

    expect(buildOctokitClient).not.toHaveBeenCalled();
    expect(listForRepo).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('leaves a warn alone — the trigger is severity, and warn is not it', async () => {
    await boot((logger) => logger.warn('a token expires in three days'));

    expect(buildOctokitClient).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the gate', () => {
  it('stays quiet when writes are disabled', async () => {
    await boot((logger) => logger.error('an error nobody may file'), cfg({ GITHUB_WRITE_ENABLED: false }));

    expect(buildOctokitClient).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('stays quiet when there is no Github credential to write with', async () => {
    await boot((logger) => logger.error('an error with no credential behind it'), cfg({ GITHUB_TOKEN: '' }));

    expect(buildOctokitClient).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts a Github App instead of a token', async () => {
    const app = cfg({
      GITHUB_TOKEN: '',
      GITHUB_APP_ID: '12345',
      GITHUB_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\\nstub\\n-----END RSA PRIVATE KEY-----',
      GITHUB_INSTALLATION_ID: '67890',
    });

    await boot((logger) => logger.error('an error with an app behind it'), app);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the label is empty, which is how an operator turns it off', async () => {
    // There is no BOOT_ALERT_ENABLED: the label is the switch, and `''` is off
    // while writes stay on. It was reachable only because the key was declared
    // nowhere and `allowUnknown` passed it through; declaring it kept `.allow('')`
    // so that a boot with alerting off is still a boot (#1244 review).
    await boot((logger) => logger.error('an error nobody asked to hear about'), cfg({ BOOT_ALERT_LABEL: '' }));

    expect(buildOctokitClient).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('files unassigned when the assignee is empty, rather than staying quiet', async () => {
    // The other empty an operator can write, and it means something different:
    // nobody on the issue, not no issue. Pinned so the two are not confused.
    await boot((logger) => logger.error('an error with nobody to send it to'), cfg({ BOOT_ALERT_ASSIGNEE: '' }));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty('assignees');
  });

  it('reports an unset recipient and never falls back to a person when validation is bypassed', async () => {
    const logger = silentDelegate();
    await reportBootErrors(cfg({ BOOT_ALERT_ASSIGNEE: undefined }),
      [{ level: 'error', message: 'boot failed', at: new Date().toISOString(), context: null, detail: null }], logger);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('cannot assign boot alerts'));
    expect(buildOctokitClient).not.toHaveBeenCalled();
  });

  it('trims an explicitly configured recipient', async () => {
    await boot((logger) => logger.error('boot failed'), cfg({ BOOT_ALERT_ASSIGNEE: '  on-call  ' }));
    expect(create.mock.calls[0][0].assignees).toEqual(['on-call']);
  });

  it('stays quiet on a half-configured Github App', async () => {
    const half = cfg({ GITHUB_TOKEN: '', GITHUB_APP_ID: '12345', GITHUB_PRIVATE_KEY: '' });

    await boot((logger) => logger.error('an error with half an app behind it'), half);

    expect(buildOctokitClient).not.toHaveBeenCalled();
  });
});

describe('it never breaks the boot', () => {
  it('swallows a create that throws', async () => {
    create.mockRejectedValue(new Error('403 from Github'));

    await expect(boot((logger) => logger.error('an error the write cannot file'))).resolves.toBeUndefined();
  });

  it('swallows a list that throws, and does not go on to write blind', async () => {
    listForRepo.mockRejectedValue(new Error('502 from Github'));

    await expect(boot((logger) => logger.error('an error the read cannot check'))).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('swallows a comment that throws', async () => {
    listForRepo.mockResolvedValue({ data: [anOpenMarkerIssue] });
    createComment.mockRejectedValue(new Error('410 from Github'));

    await expect(boot((logger) => logger.error('an error the comment cannot append'))).resolves.toBeUndefined();
  });

  it('swallows a client that cannot even be built', async () => {
    buildOctokitClient.mockImplementation(() => {
      throw new Error('bad private key');
    });

    await expect(boot((logger) => logger.error('an error with a broken client'))).resolves.toBeUndefined();
  });

  it('reports the failure to notify through the logger, and still returns', async () => {
    create.mockRejectedValue(new Error('403 from Github'));
    const heard = silentDelegate();

    const recorder = new BootErrorRecorder(heard);
    recorder.error('an error the write cannot file');
    await reportBootErrors(cfg(), recorder.drain(), recorder);

    expect(heard.error).toHaveBeenCalledTimes(2); // the boot error, then the failure to file it
  });
});

/**
 * The routeless writer, and the one that CONSULTS (#584 task 5).
 *
 * No route reaches this notifier, so no guard can stand in front of it: it is
 * the one Github write that both teaches the registry and reads it. Without the
 * read, `GITHUB_CAPABILITIES_DENY=boot-alert.file` would be accepted, reported
 * refused, and the notifier would write anyway.
 */
describe('the boot notifier and the capability registry (#584)', () => {
  /** Records what the notifier taught, and answers what it is told to answer. */
  const registryThat = (state: 'unknown' | 'refused' = 'unknown') => {
    const calls: { cap: string; target?: string; reason: string }[] = [];
    return {
      calls,
      registry: {
        state: () => ({ state }),
        recordRefusal: (cap: string, r: { reason: string }, target?: string) =>
          calls.push({ cap, target, reason: r.reason }),
        recordSuccess: () => {},
      } as unknown as CapabilityRegistry,
    };
  };

  const bootWith = async (registry: CapabilityRegistry): Promise<void> => {
    const recorder = new BootErrorRecorder(silentDelegate());
    recorder.error('an error on the way up');
    await reportBootErrors(cfg(), recorder.drain(), silentDelegate(), 0, registry);
  };

  it('does not write at all when boot-alert.file is refused', async () => {
    const { registry } = registryThat('refused');

    await bootWith(registry);

    expect(listForRepo).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('teaches the registry when the write itself is refused', async () => {
    const { calls, registry } = registryThat();
    create.mockRejectedValue(
      Object.assign(new Error('Resource not accessible by integration'), {
        status: 403,
        response: {
          headers: { 'x-accepted-github-permissions': 'issues=write' },
          data: { message: 'Resource not accessible by integration' },
        },
      }),
    );

    await bootWith(registry);

    expect(calls).toEqual([
      {
        cap: 'boot-alert.file',
        target: 'acme/board',
        reason: 'not-permitted',
      },
    ]);
  });

  it('teaches NOTHING when it is the dedupe READ that fails', async () => {
    // The trap this step walks into: the notifier's outer catch wraps the
    // `listForRepo` read as well as the two writes, and recording from there
    // files a read failure as a write refusal — which would take
    // `boot-alert.file` dark on a credential that can write perfectly well.
    const { calls, registry } = registryThat();
    listForRepo.mockRejectedValue(
      Object.assign(new Error('Forbidden'), {
        status: 403,
        response: { headers: {}, data: { message: 'Forbidden' } },
      }),
    );

    await bootWith(registry);

    expect(calls).toEqual([]);
  });
});

describe('the recorder', () => {
  it('passes every level through to the delegate untouched', () => {
    const delegate = silentDelegate();
    const recorder = new BootErrorRecorder(delegate);

    recorder.log('a line', 'Bootstrap');
    recorder.warn('a warning', 'Bootstrap');
    recorder.error('a failure', 'a stack', 'Bootstrap');
    recorder.fatal('a collapse', 'Bootstrap');
    recorder.debug?.('a detail');
    recorder.verbose?.('a whisper');

    expect(delegate.log).toHaveBeenCalledWith('a line', 'Bootstrap');
    expect(delegate.warn).toHaveBeenCalledWith('a warning', 'Bootstrap');
    expect(delegate.error).toHaveBeenCalledWith('a failure', 'a stack', 'Bootstrap');
    expect(delegate.fatal).toHaveBeenCalledWith('a collapse', 'Bootstrap');
    expect(delegate.debug).toHaveBeenCalledWith('a detail');
    expect(delegate.verbose).toHaveBeenCalledWith('a whisper');
  });

  it('captures error and fatal, and nothing else', () => {
    const recorder = new BootErrorRecorder(silentDelegate());

    recorder.log('a line');
    recorder.warn('a warning');
    recorder.debug?.('a detail');
    recorder.verbose?.('a whisper');
    recorder.error('a failure');
    recorder.fatal('a collapse');

    expect(recorder.drain().map((c) => c.level)).toEqual(['error', 'fatal']);
  });

  it('hands its records over once — a second read has nothing left to file', () => {
    const recorder = new BootErrorRecorder(silentDelegate());
    recorder.error('a failure');

    expect(recorder.drain()).toHaveLength(1);
    expect(recorder.drain()).toHaveLength(0);
  });

  it('records an Error object without losing its message', () => {
    const recorder = new BootErrorRecorder(silentDelegate());
    recorder.error(new Error('the store refused the connection'));

    expect(recorder.drain()[0].message).toContain('the store refused the connection');
  });

  it('survives a message that will not stringify', () => {
    const recorder = new BootErrorRecorder(silentDelegate());
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => recorder.error(circular)).not.toThrow();
    expect(recorder.drain()).toHaveLength(1);
  });

  it('stops growing under a flood, and says how many it dropped', () => {
    const recorder = new BootErrorRecorder(silentDelegate());
    for (let i = 0; i < 500; i += 1) recorder.error(`failure ${i}`);

    expect(recorder.drain().length).toBeLessThanOrEqual(25);
    expect(recorder.dropped).toBeGreaterThan(0);
  });
});

/**
 * The point of #592. A words rule broke because #588 reworded the sentence it
 * matched; this feature keys on severity, so the wording is free to change.
 */
describe('rewording the log line changes nothing', () => {
  it('files on a message that shares no word with the one before it', async () => {
    await boot((logger) => logger.error('sole owner list empty; refusing to grant'));
    expect(create).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    buildOctokitClient.mockImplementation(() => ({ issues: { create, createComment, listForRepo }, request: vi.fn().mockResolvedValue({ data: { id: 42, full_name: 'acme/board' } }) }));
    listForRepo.mockResolvedValue({ data: [] });
    create.mockResolvedValue({ data: { number: 613, html_url: 'https://github.com/x/y/issues/613' } });

    await boot((logger) => logger.error('нет доступных администраторов'));
    expect(create).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every Github write this notifier makes is in the trail (#781).
 *
 * #774 coupled writes to the audit trail and the README said "a board that can
 * write cannot run without the trail". The notifier was the counter-example: two
 * `issues.*` writes behind `GITHUB_WRITE_ENABLED` that `git grep AuditService`
 * never touched. The actor is `system` — the same name `identity.seed` records
 * under — because this write is board reporting itself, not a person acting.
 *
 * The first test counts rather than names: it asserts one audit record per
 * Github write, whichever of the two the dedupe read picked. A test that only
 * checked the create path would go green while the comment path stayed silent.
 */
describe('the boot notifier records what it writes (#781)', () => {
  const recorder = () => {
    const recorded: RecordAudit[] = [];
    return { recorded, audit: { record: async (e: RecordAudit) => { recorded.push(e); } } };
  };

  const bootWith = async (audit: AuditRecorder): Promise<void> => {
    const rec = new BootErrorRecorder(silentDelegate());
    rec.error('an error on the way up');
    await reportBootErrors(cfg(), rec.drain(), silentDelegate(), 0, undefined, audit);
  };

  it('leaves no Github write unrecorded, on either of its two write paths', async () => {
    for (const openIssues of [[], [anOpenMarkerIssue]]) {
      vi.clearAllMocks();
      buildOctokitClient.mockImplementation(() => ({ issues: { create, createComment, listForRepo }, request: vi.fn().mockResolvedValue({ data: { id: 42, full_name: 'acme/board' } }) }));
      listForRepo.mockResolvedValue({ data: openIssues });
      create.mockResolvedValue({ data: { number: 900, html_url: 'https://github.com/x/y/issues/900' } });
      createComment.mockResolvedValue({ data: { html_url: 'https://github.com/x/y/issues/611#c1' } });
      const { recorded, audit } = recorder();

      await bootWith(audit);

      const writes = create.mock.calls.length + createComment.mock.calls.length;
      expect(writes).toBe(1);
      expect(recorded).toHaveLength(writes);
      expect(recorded[0]).toMatchObject({ actorEmail: 'system', action: 'boot.alert', targetType: 'issue' });
    }
  });

  it('names the issue it filed, so the row leads back to what was written', async () => {
    listForRepo.mockResolvedValue({ data: [] });
    create.mockResolvedValue({ data: { number: 900, html_url: 'https://github.com/x/y/issues/900' } });
    const { recorded, audit } = recorder();

    await bootWith(audit);

    expect(recorded[0]).toMatchObject({ targetId: '900' });
    expect(recorded[0].summary).toContain('900');
  });

  it('records nothing when the dedupe read is all that ran', async () => {
    // boot-alert.file refused: no write happens, so no row may claim one did.
    const { recorded, audit } = recorder();
    const rec = new BootErrorRecorder(silentDelegate());
    rec.error('an error on the way up');
    await reportBootErrors(
      cfg(), rec.drain(), silentDelegate(), 0,
      { state: () => ({ state: 'refused' }) } as unknown as CapabilityRegistry,
      audit,
    );

    expect(recorded).toHaveLength(0);
  });

  it('files the report even when recording it throws', async () => {
    // Write-then-audit, and the audit never costs the report (#781). The loss is
    // counted by AuditService, not by silence here.
    listForRepo.mockResolvedValue({ data: [] });
    create.mockResolvedValue({ data: { number: 900, html_url: 'https://github.com/x/y/issues/900' } });

    const rec = new BootErrorRecorder(silentDelegate());
    rec.error('an error on the way up');
    await expect(
      reportBootErrors(cfg(), rec.drain(), silentDelegate(), 0, undefined, {
        record: async () => { throw new Error('db down'); },
      }),
    ).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledTimes(1);
  });
});
