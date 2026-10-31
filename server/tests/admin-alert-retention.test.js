/**
 * Admin alert retention (server/services/admin-alert-retention.js): the rule
 * boundaries, the last-activity signal, the three gate states, the re-ring
 * accounting and the pin that keeps the re-ring list complete. The SQL runs
 * against Postgres in admin-alert-retention-db.test.js.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const retention = require('../services/admin-alert-retention');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2031-03-15T12:00:00.000Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY);

let seq = 0;
const row = (over = {}) => {
  seq += 1;
  const created = over.created_at || ago(40);
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    category: 'alert',
    created_at: created,
    created_at_cursor: new Date(created).toISOString(),
    read_at: null,
    version: `v${seq}`,
    metadata: {},
    ...over,
  };
};

describe('judgeRow: rule boundaries', () => {
  test('a needs-you row expires after 30 days, not at 29 or exactly 30', () => {
    expect(retention.judgeRow(row({ created_at: ago(29) }), NOW)).toEqual({ expire: false, reason: 'young' });
    expect(retention.judgeRow(row({ created_at: ago(30) }), NOW)).toEqual({ expire: false, reason: 'young' });
    expect(retention.judgeRow(row({ created_at: ago(31) }), NOW)).toEqual({ expire: true, rule: 'age30' });
  });

  test('read or unread makes no difference', () => {
    expect(retention.judgeRow(row({ created_at: ago(31), read_at: ago(1) }), NOW).expire).toBe(true);
    expect(retention.judgeRow(row({ created_at: ago(31), read_at: null }), NOW).expire).toBe(true);
  });

  test('an FYI row expires after 7 days (6 stays, 8 goes), by severity or by ops_digest audience', () => {
    const fyi = (days) => row({ created_at: ago(days), metadata: { severity: 'fyi' } });
    expect(retention.judgeRow(fyi(6), NOW).expire).toBe(false);
    expect(retention.judgeRow(fyi(8), NOW)).toEqual({ expire: true, rule: 'fyi7' });
    const digest = (days) => row({ category: 'ops_digest', created_at: ago(days), metadata: { audience: 'fyi' } });
    expect(retention.judgeRow(digest(6), NOW).expire).toBe(false);
    expect(retention.judgeRow(digest(8), NOW)).toEqual({ expire: true, rule: 'fyi7' });
    // An engineering digest is not FYI.
    expect(retention.judgeRow(row({ category: 'ops_digest', created_at: ago(8), metadata: { audience: 'engineering' } }), NOW).expire).toBe(false);
  });

  test('an Activity-feed row has no bell to leave: only the FYI rule reaches it', () => {
    expect(retention.judgeRow(row({ created_at: ago(90), metadata: { feed: 'activity' } }), NOW)).toEqual({ expire: false, reason: 'activity_only' });
    expect(retention.judgeRow(row({ created_at: ago(8), metadata: { feed: 'activity', severity: 'fyi' } }), NOW).rule).toBe('fyi7');
  });

  test('metadata may arrive as a JSON string; bad JSON reads as empty', () => {
    expect(retention.judgeRow(row({ created_at: ago(40), metadata: JSON.stringify({ severity: 'fyi' }) }), NOW).rule).toBe('fyi7');
    expect(retention.judgeRow(row({ created_at: ago(40), metadata: '{nope' }), NOW).rule).toBe('age30');
  });
});

describe('judgeRow: last activity', () => {
  test.each(['rungAt', 'observedAt', 'lastFailureAt'])('a recent %s keeps an old row', (key) => {
    const kept = row({ created_at: ago(90), metadata: { [key]: ago(2).toISOString() } });
    expect(retention.judgeRow(kept, NOW)).toEqual({ expire: false, reason: 'refreshed' });
  });

  test('a stamp past the limit does not keep the row', () => {
    const old = row({ created_at: ago(90), metadata: { rungAt: ago(31).toISOString() } });
    expect(retention.judgeRow(old, NOW).rule).toBe('age30');
  });

  test('a stamp 29 days old keeps it, 31 days old does not', () => {
    expect(retention.judgeRow(row({ created_at: ago(90), metadata: { rungAt: ago(29).toISOString() } }), NOW).expire).toBe(false);
    expect(retention.judgeRow(row({ created_at: ago(90), metadata: { rungAt: ago(31).toISOString() } }), NOW).expire).toBe(true);
  });

  test('a refreshed FYI row is judged on the 7-day limit from its stamp', () => {
    const base = { created_at: ago(40), metadata: { severity: 'fyi' } };
    expect(retention.judgeRow(row({ ...base, metadata: { ...base.metadata, rungAt: ago(6).toISOString() } }), NOW).expire).toBe(false);
    expect(retention.judgeRow(row({ ...base, metadata: { ...base.metadata, rungAt: ago(8).toISOString() } }), NOW).expire).toBe(true);
  });

  test('junk or far-future stamps are ignored, never keep a row alive', () => {
    for (const bad of ['not a date', '', 12345, null, new Date(NOW.getTime() + 10 * DAY).toISOString()]) {
      expect(retention.judgeRow(row({ created_at: ago(40), metadata: { rungAt: bad, observedAt: bad } }), NOW).rule).toBe('age30');
    }
  });
});

describe('re-ring list', () => {
  test('each emitter with dedupeOpenOnly has a decision, and its keys resolve to it', () => {
    const keyed = (dedupeKey) => row({ metadata: { dedupeKey } });
    expect(retention.ringRiskFor(keyed('lead-repeat-form:abc')).emitter).toBe('lead-repeat-form');
    expect(retention.ringRiskFor(keyed('stock-shortfall:p1')).emitter).toBe('stock-shortfall');
    expect(retention.ringRiskFor(keyed('ib:model-failure:tech')).emitter).toBe('ib-model-failure');
    expect(retention.ringRiskFor(keyed('series-price-guard:cancelled-root:r')).kind).toBe('periodic');
    expect(retention.ringRiskFor(keyed('series-price-guard:over-last-paid:r')).kind).toBe('event');
    expect(retention.ringRiskFor(keyed('sms-draft-canary:smsDraftDefault')).kind).toBe('periodic');
    expect(retention.ringRiskFor(keyed('sms-commitment-source:9')).live).toBe('promiseOpen');
    expect(retention.ringRiskFor(keyed('truck-kit:v1')).emitter).toBe('truck-kit');
    expect(retention.ringRiskFor(keyed('autopay_hold_charge:declined:inv-1')).kind).toBe('event');
    expect(retention.ringRiskFor(keyed('lead-agent-hold:lead-1')).emitter).toBe('lead-agent-hold');
    expect(retention.ringRiskFor(keyed('payroll-mercury-key')).kind).toBe('periodic');
    expect(retention.ringRiskFor(keyed('payroll-mercury-key-send')).emitter).toBe('payroll-mercury-key-send');
    expect(retention.ringRiskFor(keyed('something-else:1'))).toBeNull();
    expect(retention.ringRiskFor(row())).toBeNull();
  });

  // A new dedupeOpenOnly emitter must add its row to RERING (and decide).
  test('every source file that passes dedupeOpenOnly: true is covered by RERING', () => {
    const server = path.join(__dirname, '..');
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!['tests', 'node_modules', 'models'].includes(entry.name)) walk(full); }
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(server);
    const using = files
      .filter((f) => /dedupeOpenOnly:\s*true/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(server, f).split(path.sep).join('/'))
      .filter((f) => !['services/notification-service.js', 'services/admin-alert-retention.js'].includes(f));
    const covered = new Set(retention.RERING.flatMap((e) => e.files));
    expect(using.filter((f) => !covered.has(f))).toEqual([]);
    // And no RERING file went stale.
    for (const f of covered) expect(fs.existsSync(path.join(server, f))).toBe(true);
  });
});

// A fake database edge: pages by cursor over the given rows (oldest first).
function fakeIo(rows, { live = {}, backlog = 0, cursors = {} } = {}) {
  const sorted = [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const calls = { expire: [], record: [], live: [], pageCursors: [] };
  return {
    calls,
    cursors,
    loadCursor: async (mode) => cursors[mode] || null,
    saveCursor: async (mode, cursor) => { cursors[mode] = cursor; },
    page: async ({ cursor, limit }) => {
      calls.pageCursors.push(cursor ? cursor.id : null);
      const start = cursor ? sorted.findIndex((r) => r.id === cursor.id) + 1 : 0;
      return sorted.slice(start, start + limit);
    },
    live: async (name, subset) => { calls.live.push(name); return new Set(subset.filter((r) => live[r.id]).map((r) => r.id)); },
    expire: async (batch, rule) => { calls.expire.push({ rule, ids: batch.map((r) => r.id) }); return batch.length; },
    activityBacklog: async () => backlog,
    record: async (summary) => { calls.record.push(summary); },
  };
}

describe('runAdminAlertRetention: gate states', () => {
  const rows = () => [
    row({ created_at: ago(60), category: 'alert' }),
    row({ created_at: ago(35), category: 'billing', read_at: ago(34) }),
    row({ created_at: ago(20), category: 'alert' }),
    row({ created_at: ago(9), category: 'lead', metadata: { severity: 'fyi' } }),
    row({ created_at: ago(90), category: 'alert', metadata: { rungAt: ago(1).toISOString() } }),
  ];

  test('off (and any other value): no database call at all', async () => {
    const io = fakeIo(rows());
    io.page = jest.fn(io.page);
    for (const mode of ['off', undefined, false, 'false', '']) {
      expect(await retention.runAdminAlertRetention({ now: NOW, mode, io })).toEqual({ skipped: true, reason: 'gate_off' });
    }
    expect(io.page).not.toHaveBeenCalled();
    expect(io.calls.record).toHaveLength(0);
  });

  test('shadow: counts what would expire, records one summary, writes nothing', async () => {
    const io = fakeIo(rows(), { backlog: 7 });
    const summary = await retention.runAdminAlertRetention({ now: NOW, mode: 'shadow', io });
    expect(io.calls.expire).toHaveLength(0);
    expect(io.calls.record).toHaveLength(1);
    expect(summary).toMatchObject({
      mode: 'shadow', scanned: 5, written: 0, activityOnlyOpenOlderThan30: 7,
      kept: { refreshed: 1 }, expire: { total: 3, unread: 2, byRule: { age30: 2, fyi7: 1 }, byCategory: { alert: 1, billing: 1, lead: 1 } },
    });
  });

  test('true: expires by rule and records the run', async () => {
    const data = rows();
    const io = fakeIo(data);
    const summary = await retention.runAdminAlertRetention({ now: NOW, mode: 'true', io });
    expect(summary).toMatchObject({ mode: 'true', written: 3, expire: { total: 3 } });
    expect(io.calls.expire.map((c) => c.rule).sort()).toEqual(['age30', 'fyi7']);
    expect(io.calls.expire.find((c) => c.rule === 'age30').ids).toEqual([data[0].id, data[1].id]);
    expect(io.calls.expire.find((c) => c.rule === 'fyi7').ids).toEqual([data[3].id]);
    expect(io.calls.record[0].runId).toBe(NOW.toISOString());
  });

  test('a row its emitter keeps refreshing is counted as kept, not expired', async () => {
    const data = [row({ created_at: ago(90), metadata: { rungAt: ago(1).toISOString() } })];
    const io = fakeIo(data);
    const summary = await retention.runAdminAlertRetention({ now: NOW, mode: 'true', io });
    expect(summary.kept.refreshed).toBe(1);
    expect(io.calls.expire).toHaveLength(0);
  });

  test('pages through a backlog larger than one batch', async () => {
    const data = Array.from({ length: 25 }, (_, i) => row({ created_at: ago(100 - i * 0.1) }));
    const io = fakeIo(data);
    const summary = await retention.runAdminAlertRetention({ now: NOW, mode: 'true', io, batchSize: 10 });
    expect(summary.batches).toBe(3);
    expect(summary.written).toBe(25);
    expect(io.calls.expire.map((c) => c.ids.length)).toEqual([10, 10, 5]);
  });
});

describe('runAdminAlertRetention: re-ring accounting', () => {
  const keyed = (dedupeKey, over = {}) => row({ created_at: ago(40), metadata: { dedupeKey }, ...over });

  test('shadow counts, per emitter, the rows that could ring again', async () => {
    const data = [
      keyed('lead-repeat-form:a'), keyed('lead-repeat-form:b'), keyed('stock-shortfall:p'),
      keyed('sms-draft-canary:smsDraftDefault'), keyed('plain:1'), row({ created_at: ago(40) }),
    ];
    const summary = await retention.runAdminAlertRetention({ now: NOW, mode: 'shadow', io: fakeIo(data) });
    expect(summary.ringRisk.couldRingAgain).toBe(4);
    expect(summary.ringRisk.ringsWithoutNewEvent).toBe(1);
    expect(summary.ringRisk.emitters['lead-repeat-form']).toMatchObject({ kind: 'event', expire: 2, couldRingAgain: 2, ringsWithoutNewEvent: 0 });
    expect(summary.ringRisk.emitters['sms-draft-canary']).toMatchObject({ kind: 'periodic', expire: 1, ringsWithoutNewEvent: 1 });
    expect(summary.keyed).toEqual({ registry: 4, other: 1, none: 1 });
  });

  test('periodic emitters are capped per run (oldest first); the rest wait for the next run', async () => {
    const data = Array.from({ length: 14 }, (_, i) => keyed(`sms-draft-canary:r${i}`, { created_at: ago(100 - i) }));
    const io = fakeIo(data);
    const summary = await retention.runAdminAlertRetention({ now: NOW, mode: 'true', io });
    expect(summary.written).toBe(10);
    expect(summary.deferred.ringRiskCap).toBe(4);
    expect(summary.ringRisk.emitters['sms-draft-canary']).toMatchObject({ expire: 10, deferred: 4 });
    expect(io.calls.expire[0].ids).toEqual(data.slice(0, 10).map((r) => r.id));
  });

  test('event emitters are not capped', async () => {
    const data = Array.from({ length: 30 }, (_, i) => keyed(`lead-repeat-form:${i}`));
    const summary = await retention.runAdminAlertRetention({ now: NOW, mode: 'true', io: fakeIo(data) });
    expect(summary.written).toBe(30);
    expect(summary.deferred.ringRiskCap).toBe(0);
  });

  test('an overdue-promise row whose promise is still open is held, never expired', async () => {
    const open = keyed('sms-commitment-source:1');
    const closed = keyed('sms-commitment-source:2');
    const io = fakeIo([open, closed], { live: { [open.id]: true } });
    const summary = await retention.runAdminAlertRetention({ now: NOW, mode: 'true', io });
    expect(io.calls.live).toEqual(['promiseOpen']);
    expect(summary.held.livePromise).toBe(1);
    expect(io.calls.expire[0].ids).toEqual([closed.id]);
    expect(summary.ringRisk.emitters['promise-overdue']).toMatchObject({ held: 1, expire: 1 });
  });
});

describe('scan budget and the continuation cursor', () => {
  // 25 old promise rows whose promise is still open (kept for now), then one eligible alert behind them.
  const setup = () => {
    const held = Array.from({ length: 25 }, (_, i) => row({ created_at: ago(200 - i), metadata: { dedupeKey: `sms-commitment-source:${i}` } }));
    const eligible = row({ created_at: ago(100), metadata: { dedupeKey: 'plain:eligible' } });
    const live = Object.fromEntries(held.map((r) => [r.id, true]));
    return { held, eligible, cursors: {}, live };
  };
  const nightly = (ctx, extra = {}) => {
    const io = fakeIo([...ctx.held, ctx.eligible], { live: ctx.live, cursors: ctx.cursors });
    return retention.runAdminAlertRetention({ now: NOW, mode: 'true', io, batchSize: 10, maxBatches: 1, ...extra }).then((summary) => ({ summary, io }));
  };

  test('repeated capped runs walk past rows that are kept for now and reach the eligible alert', async () => {
    const ctx = setup();
    const first = await nightly(ctx);
    expect(first.summary).toMatchObject({ scanned: 10, written: 0, cursor: 'saved', resumedFrom: null });
    expect(first.summary.held.livePromise).toBe(10);
    expect(ctx.cursors.true.id).toBe(ctx.held[9].id);

    const second = await nightly(ctx);
    expect(second.io.calls.pageCursors).toEqual([ctx.held[9].id]);
    expect(second.summary).toMatchObject({ scanned: 10, written: 0, cursor: 'saved', resumedFrom: ctx.held[9].id });

    const third = await nightly(ctx);
    expect(third.summary).toMatchObject({ scanned: 6, written: 1, cursor: 'reset' });
    expect(third.io.calls.expire[0].ids).toEqual([ctx.eligible.id]);
  });

  test('a run that reaches the end clears the cursor, and the next run starts at the oldest row', async () => {
    const ctx = setup();
    ctx.cursors.true = { at: ctx.held[19].created_at_cursor, id: ctx.held[19].id };
    const finishing = await nightly(ctx);
    expect(finishing.summary.cursor).toBe('reset');
    expect(ctx.cursors.true).toBeNull();
    const next = await nightly(ctx);
    expect(next.io.calls.pageCursors).toEqual([null]);
    expect(next.summary.resumedFrom).toBeNull();
  });

  test('a run that ends exactly on a full last page still resets on the next empty read', async () => {
    const ctx = { held: [], eligible: row({ created_at: ago(100) }), cursors: {}, live: {} };
    const first = await nightly(ctx, { batchSize: 1, maxBatches: 1 });
    expect(first.summary.cursor).toBe('saved');
    const second = await nightly(ctx, { batchSize: 1, maxBatches: 1 });
    expect(second.summary.cursor).toBe('reset');
  });

  test('shadow and live keep separate places', async () => {
    const ctx = setup();
    const io = fakeIo([...ctx.held, ctx.eligible], { live: ctx.live, cursors: ctx.cursors });
    await retention.runAdminAlertRetention({ now: NOW, mode: 'shadow', io, batchSize: 10, maxBatches: 1 });
    expect(ctx.cursors.shadow.id).toBe(ctx.held[9].id);
    expect(ctx.cursors.true).toBeUndefined();
  });
});

describe('the sweep never takes a row lock', () => {
  test('no forUpdate / forShare / FOR UPDATE in the module', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'admin-alert-retention.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/forUpdate|forShare|FOR UPDATE|FOR SHARE|skipLocked/);
  });
});

describe('gate reader', () => {
  const { alertRetentionMode } = require('../config/feature-gates');
  const saved = process.env.GATE_ALERT_RETENTION;
  afterEach(() => { if (saved === undefined) delete process.env.GATE_ALERT_RETENTION; else process.env.GATE_ALERT_RETENTION = saved; });

  test.each([
    [undefined, 'off'], ['', 'off'], ['false', 'off'], ['1', 'off'], ['on', 'off'],
    ['shadow', 'shadow'], [' Shadow ', 'shadow'], ['true', 'true'], ['TRUE', 'true'],
  ])('GATE_ALERT_RETENTION=%p reads as %s', (value, expected) => {
    if (value === undefined) delete process.env.GATE_ALERT_RETENTION; else process.env.GATE_ALERT_RETENTION = value;
    expect(alertRetentionMode()).toBe(expected);
  });
});
