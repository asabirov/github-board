import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { AuditService, redactDsn } from './audit.service';
import { AuditEventRow, AuditRepository, RecordAudit } from './audit.types';

function repo(over: Partial<AuditRepository> = {}): AuditRepository & { recorded: RecordAudit[] } {
  const recorded: RecordAudit[] = [];
  return {
    recorded,
    enabled: true,
    record: async (e: RecordAudit) => { recorded.push(e); },
    list: async () => [] as AuditEventRow[],
    // The trail counts its own gap rows (#812), so a fake that records into an
    // array counts them out of the same array — a marker written by the service
    // under test is a marker the next health read sees, which is the whole
    // mechanism and would be faked away by a hard-coded zero.
    countGaps: async () => {
      const gaps = recorded.filter((e) => e.action === 'audit.gap');
      return { events: gaps.length, lastAt: gaps.length ? new Date('2026-09-02T02:05:00.000Z') : null };
    },
    ...over,
  } as AuditRepository & { recorded: RecordAudit[] };
}

describe('AuditService (#212)', () => {
  it('records an event through the repository', async () => {
    const r = repo();
    await new AuditService(r).record({ actorEmail: 'a@x.io', action: 'token.mint', summary: 'Minted x' });
    expect(r.recorded).toEqual([{ actorEmail: 'a@x.io', action: 'token.mint', summary: 'Minted x' }]);
  });

  it('SWALLOWS a record failure — auditing must never fail the audited action', async () => {
    const svc = new AuditService(repo({ record: async () => { throw new Error('db down'); } }));
    await expect(svc.record({ actorEmail: 'a@x.io', action: 'agent.revoke', summary: 'x' })).resolves.toBeUndefined();
  });

  it('delegates list to the repository', async () => {
    const rows: AuditEventRow[] = [
      { id: '1', at: new Date(), actorEmail: 'a@x.io', action: 'feedback.submit', summary: 'x', targetType: 'feedback', targetId: '7' },
    ];
    const svc = new AuditService(repo({ list: async () => rows }));
    expect(await svc.list({ actor: 'a' })).toBe(rows);
  });
});

/**
 * A lost record is countable, not silent (#781).
 *
 * `record` swallowing the failure is the only ordering that can work — the
 * Github write has already happened by then, and failing the action would undo
 * nothing. What it cost was visibility: a `db` board with unreachable Postgres
 * performed writes, recorded none, and rendered the same "No audit events yet"
 * a genuinely quiet board renders. `health()` is what tells those two apart.
 *
 * The count is since boot and never clears. A transient that already lost rows
 * leaves a gap in an append-only trail, and the gap does not heal when Postgres
 * comes back.
 */
describe('AuditService.health — telling a quiet board from a failing one (#781)', () => {
  it('reports ok while records are landing', async () => {
    expect(await new AuditService(repo()).health()).toMatchObject({
      recording: 'ok',
      failures: 0,
      lastFailureAt: null,
      gaps: { events: 0, lastAt: null },
    });
  });

  it('reports disabled when there is no database, rather than ok', async () => {
    // Distinct from 'ok': nothing is recorded here either, and an empty log on a
    // no-DB board is the truth rather than a symptom.
    expect((await new AuditService(repo({ enabled: false })).health()).recording).toBe('disabled');
  });

  it('counts every failed record and stays failing afterwards', async () => {
    let down = true;
    const svc = new AuditService(repo({ record: async () => { if (down) throw new Error('db down'); } }));

    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'x' });
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'y' });
    down = false;
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'z' });

    const h = await svc.health();
    expect(h.recording).toBe('failing');
    expect(h.failures).toBe(2);
    expect(h.lastFailureAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the database error message out of what an admin page can read', async () => {
    // Prisma names the host, the port and the user it could not reach. That
    // belongs in the server log, not in a JSON body (#781).
    const svc = new AuditService(repo({
      record: async () => { throw new Error('Can\'t reach postgresql://board:hunter2@db.internal:5432'); },
    }));
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'x' });

    expect(JSON.stringify(await svc.health())).not.toContain('hunter2');
  });
});

/**
 * The password does not go in the log line either (#781 review).
 *
 * The body was already clean, and the test above pins that. What moved with
 * #781 was the LEVEL: the same Prisma message went from `warn` to `error`, and
 * `error` is the stream alerting reads, error-only retention keeps and a
 * third-party error tracker receives. Nobody decided to widen who can read
 * `DATABASE_URL`; raising the level did it as a side effect.
 *
 * `DSN` below is the shape the reviewer observed live against a board pointed
 * at a dead Postgres, password and all.
 */
const DSN = "Can't reach postgresql://board:hunter2@db.internal:5432/board";

describe('AuditService — a lost record does not log the password', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('logs the failure at error with the credentials taken out', async () => {
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => { logged.push(String(m)); });

    const svc = new AuditService(repo({ record: async () => { throw new Error(DSN); } }));
    await svc.record({ actorEmail: 'system', action: 'boot.alert', summary: 'x' });

    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain('hunter2');
    expect(logged[0]).not.toContain('board:hunter2');
    // The host and the port survive — they are what the line is FOR.
    expect(logged[0]).toContain('db.internal:5432');
    expect(logged[0]).toContain('audit record LOST (boot.alert by system)');
  });
});

describe('redactDsn', () => {
  it('takes both halves of the userinfo, keeping host and port', () => {
    expect(redactDsn(DSN)).toBe("Can't reach postgresql://***@db.internal:5432/board");
  });

  it('takes every connection string in a message, not just the first', () => {
    expect(redactDsn('primary postgresql://a:b@h1 replica postgresql://c:d@h2'))
      .toBe('primary postgresql://***@h1 replica postgresql://***@h2');
  });

  it('leaves a URL with no credentials alone', () => {
    expect(redactDsn('Can\'t reach postgresql://db.internal:5432/board'))
      .toBe('Can\'t reach postgresql://db.internal:5432/board');
  });

  it('leaves an @ in a path or query alone — that is not a credential', () => {
    // `[^@\s/]*` stops at the first `/`, so the host is not eaten by a link
    // that happens to carry an address further along it.
    expect(redactDsn('see https://support.example/t?cc=ops@x.io for the runbook'))
      .toBe('see https://support.example/t?cc=ops@x.io for the runbook');
  });

  it('leaves a bare email address alone', () => {
    expect(redactDsn('actor a@x.io lost a row')).toBe('actor a@x.io lost a row');
  });
});

/**
 * A count that dies with its process cannot speak for the board (#812).
 *
 * `failures` is since boot and never clears, which is right — a hole in an
 * append-only trail does not heal when Postgres comes back. It is also a count
 * for ONE process, and #781 reported it bare, so two readers got the wrong
 * answer from it. An operator's request lands on whichever board-api replica the
 * proxy picked, and a rolling deploy is a second replica for the length of the
 * overlap even at a target of one. And a board that lost rows at 02:00 and
 * restarted at 02:05 reported `ok` at 09:00 with the gap still missing.
 *
 * Two halves fix that and only together. The count now says whose it is and
 * from when, so nobody reads it as the board's. And a loss is written INTO the
 * trail as an `audit.gap` row once the store can take one, so it outlives the
 * process that suffered it and is readable from every replica.
 */
describe('AuditService.health — whose count it is, and since when (#812)', () => {
  it('names the instance and the window the count covers', async () => {
    const h = await new AuditService(repo()).health();
    expect(h.instance).toMatch(/^[0-9a-f]{8}$/);
    expect(h.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('gives two processes two different instance ids — a replica is not its sibling', async () => {
    const a = await new AuditService(repo()).health();
    const b = await new AuditService(repo()).health();
    expect(a.instance).not.toBe(b.instance);
  });
});

describe('AuditService — a loss outlives the process that suffered it (#812)', () => {
  /** A store that is down until `up()` is called — the transient this is about. */
  function flapping() {
    let down = true;
    const r = repo({
      record: async (e: RecordAudit) => {
        if (down) throw new Error('db down');
        (r as { recorded: RecordAudit[] }).recorded.push(e);
      },
    });
    return { r, up: () => { down = false; } };
  }

  it('writes an audit.gap row into the trail once the store comes back', async () => {
    const { r, up } = flapping();
    const svc = new AuditService(r);

    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'x' });
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'y' });
    up();
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'z' });

    const gaps = r.recorded.filter((e) => e.action === 'audit.gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].actorEmail).toBe('system');
    // It counts the stretch, not the marker: two records were lost, and the row
    // says two rather than standing in for one.
    expect(gaps[0].summary).toContain('2 audit records could not be written');
  });

  it('reports failing to an instance that has lost nothing — the replica case', async () => {
    // The trail is shared; the counter is not. This instance recorded cleanly
    // and must still not answer `ok` over a gap another one left behind.
    const { r, up } = flapping();
    up();
    r.recorded.push({ actorEmail: 'system', action: 'audit.gap', summary: '4 audit records could not be written' });

    const fresh = await new AuditService(r).health();
    expect(fresh.failures).toBe(0);
    expect(fresh.recording).toBe('failing');
    expect(fresh.gaps).toEqual({ events: 1, lastAt: '2026-09-02T02:05:00.000Z' });
  });

  it('survives the restart that used to zero the counter', async () => {
    // 02:00 the rows are lost, 02:05 the board restarts, 09:00 an operator
    // looks. The new process has a clean counter and the same hole in the trail.
    const { r, up } = flapping();
    const before = new AuditService(r);
    await before.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'x' });
    up();
    await before.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'y' });

    const after = await new AuditService(r).health();
    expect(after.failures).toBe(0);
    expect(after.recording).toBe('failing');
  });

  it('does NOT clear the instance count when it writes the marker', async () => {
    // The two are different facts about one outage: `failures` is what this
    // process lost, the row is where that outlives the process. Zeroing the
    // counter on a successful write would have them disagree.
    const { r, up } = flapping();
    const svc = new AuditService(r);
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'x' });
    up();
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'y' });

    expect((await svc.health()).failures).toBe(1);
  });

  it('writes ONE marker for one stretch, not one per record after it', async () => {
    const { r, up } = flapping();
    const svc = new AuditService(r);
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'x' });
    up();
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'y' });
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'z' });
    await svc.health();

    expect(r.recorded.filter((e) => e.action === 'audit.gap')).toHaveLength(1);
  });

  it('keeps carrying the loss when the marker itself cannot be written', async () => {
    // The store took the record and refused the marker — retry with the whole
    // stretch on the next write, rather than losing the count of it silently.
    const markers: string[] = [];
    let closes = 0;
    const r = repo({
      record: async (e: RecordAudit) => {
        if (e.action === 'audit.gap') {
          markers.push(e.summary);
          if (markers.length === 1) throw new Error('db down');
          return;
        }
        if (closes++ === 0) throw new Error('db down');
      },
    });
    const svc = new AuditService(r);
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'x' });
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'y' });
    expect(markers).toHaveLength(1);

    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'z' });
    expect(markers).toHaveLength(2);
    // The retry carries the WHOLE stretch, not what is left after a write that
    // did not land.
    expect(markers[1]).toContain('1 audit record could not be written');
  });

  it('answers gaps: null when the trail could not be asked, which is not "none"', async () => {
    // The same distinction AdminEmailCache draws between an empty read and no
    // read. A `0` here would be board inventing an all-clear it never got.
    const svc = new AuditService(repo({ countGaps: async () => { throw new Error('db down'); } }));
    expect((await svc.health()).gaps).toBeNull();
  });

  it('the marker write is best-effort — a failing marker never fails the record', async () => {
    // Same ordering argument as `record` itself: the action being audited has
    // already happened, so nothing downstream may be failed on its account.
    let closes = 0;
    const svc = new AuditService(repo({
      record: async (e: RecordAudit) => {
        if (e.action === 'audit.gap') throw new Error('db down');
        if (closes++ === 0) throw new Error('db down');
      },
    }));
    await svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'x' });
    await expect(svc.record({ actorEmail: 'a@x.io', action: 'issue.close', summary: 'y' }))
      .resolves.toBeUndefined();
  });
});
