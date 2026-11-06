/**
 * WDO report attention sweep — exception-based bell for reports stalled
 * before send. Covers the pure helpers (item identity, prior-bell coverage,
 * summary copy), the gate short-circuit, and the ring/dedupe decision.
 */
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({}),
  adminBodyColumns: jest.fn((_category, body) => ({ body, detail: null })),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: jest.fn().mockResolvedValue([]),
  closeAdminAlertKeys: jest.fn().mockResolvedValue(0),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), wdoAttentionRingsLive: jest.fn(() => false) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((_name, fn) => fn()) }));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const episodes = require('../services/admin-alert-episodes');
const logger = require('../services/logger');
const featureGates = require('../config/feature-gates');
const { isEnabled } = featureGates;
const { runWdoReportAttentionSweep, _private } = require('../services/wdo-report-attention');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    join: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  NotificationService.notifyAdmin.mockResolvedValue({});
  featureGates.wdoAttentionRingsLive.mockReturnValue(false);
  episodes.openAdminAlertKeys.mockResolvedValue([]);
  episodes.closeAdminAlertKeys.mockResolvedValue(0);
});

describe('itemIds / summarize', () => {
  const items = {
    signedUnsent: [{ id: 'p1' }],
    stuckAppts: [{ id: 'a1' }, { id: 'a2' }],
  };

  test('itemIds is stable and namespaced', () => {
    expect(_private.itemIds(items)).toEqual(['signed_unsent:p1', 'stuck_appt:a1', 'stuck_appt:a2']);
  });

  test('summarize names each flavor with counts', () => {
    const text = _private.summarize(items);
    expect(text).toContain('1 WDO report signed but never sent');
    expect(text).toContain('2 WDO inspections past date without a completed report');
  });
});

describe('findAttentionItems — reports marked sent another way', () => {
  test('the signed-unsent query excludes a report marked sent outside the portal', async () => {
    const projects = chain({ select: jest.fn().mockResolvedValue([]) });
    db.mockImplementation((table) => (table === 'projects' ? projects : chain()));
    await _private.findAttentionItems(new Date('2026-11-02T12:00:00Z'));
    expect(projects.whereNull).toHaveBeenCalledWith('sent_at');
    expect(projects.whereNull).toHaveBeenCalledWith('sent_outside_portal_at');
    expect(projects.whereNotNull).toHaveBeenCalledWith('wdo_signature');
  });
});

describe('runWdoReportAttentionSweep', () => {
  test('gated off → skipped, no queries', () => {
    isEnabled.mockReturnValue(false);
    return runWdoReportAttentionSweep().then((r) => {
      expect(r).toEqual({ skipped: true, reason: 'gated_off' });
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('clean lane → no bell', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation(() => chain());
    const r = await runWdoReportAttentionSweep();
    expect(r.clean).toBe(true);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('uncovered stall rings one bell with item metadata', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'projects') {
        // The projects query is signedUnsent: return one signed-unsent row.
        return chain({
          whereNotNull: jest.fn().mockReturnThis(),
          select: jest.fn().mockResolvedValue([{ id: 'p1', customer_id: 'c1', project_date: '2026-07-15', updated_at: '2026-07-17' }]),
        });
      }
      if (table === 'notifications') return chain({ select: jest.fn().mockResolvedValue([]) });
      return chain();
    });
    const r = await runWdoReportAttentionSweep();
    expect(r.rang).toBe(true);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('wdo_report_attention');
    expect(title).toContain('WDO');
    expect(body).toContain('signed but never sent');
    expect(opts.metadata.item_ids).toEqual(['signed_unsent:p1']);
  });

  test('already-covered items stay silent', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'projects') {
        return chain({
          select: jest.fn().mockResolvedValue([{ id: 'p1' }]),
        });
      }
      if (table === 'notifications') {
        return chain({
          select: jest.fn().mockResolvedValue([{ metadata: { item_ids: ['signed_unsent:p1'] } }]),
        });
      }
      return chain();
    });
    const r = await runWdoReportAttentionSweep();
    expect(r.deduped).toBe(true);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a query failure fails the sweep loudly instead of reporting clean', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'projects') {
        return chain({ select: jest.fn().mockRejectedValue(new Error('relation missing')) });
      }
      return chain();
    });
    await expect(runWdoReportAttentionSweep()).rejects.toThrow('relation missing');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('stuck-appt query allowlists active visit states', async () => {
    isEnabled.mockReturnValue(true);
    let apptChain;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as ss') {
        apptChain = chain();
        return apptChain;
      }
      return chain();
    });
    await runWdoReportAttentionSweep();
    // Allowlist, not a terminal-state blocklist — rescheduled/skipped/any
    // future terminal status must never ring.
    expect(apptChain.whereIn).toHaveBeenCalledWith('ss.status', ['pending', 'confirmed', 'en_route', 'on_site']);
    // scheduled_date is an ET wall-clock DATE — the cutoff must be an ET
    // calendar-date string, never a JS Date instant.
    expect(apptChain.where).toHaveBeenCalledWith(
      'ss.scheduled_date',
      '<',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    // LEFT join — an inner join would drop legacy rows with null service_id
    // (their WDO-ness lives in the free-text service_type fallback).
    expect(apptChain.leftJoin).toHaveBeenCalledWith('services as s', 's.id', 'ss.service_id');
  });

  test('a failed bell insert fails the sweep instead of recording a ring', async () => {
    isEnabled.mockReturnValue(true);
    NotificationService.notifyAdmin.mockResolvedValue(null); // insert failed
    db.mockImplementation((table) => {
      if (table === 'projects') {
        return chain({
          select: jest.fn().mockResolvedValue([{ id: 'p1' }]),
        });
      }
      if (table === 'notifications') return chain({ select: jest.fn().mockResolvedValue([]) });
      return chain();
    });
    await expect(runWdoReportAttentionSweep()).rejects.toThrow('bell not recorded');
  });
});

// GATE_WDO_ATTENTION_RINGS (owner 2026-11-05): the bell rings again under GATE_ADMIN_BELL_POLICY, a muted result is not a
// ring, a clean lane closes the sweep's own rows, and a standing row's count follows the set.
describe('runWdoReportAttentionSweep — GATE_WDO_ATTENTION_RINGS', () => {
  const NOW = new Date('2026-11-06T12:00:00Z');
  const KEY = (...ids) => `wdo_report_attention:${ids.join('|')}`;

  // db fake: `signed` ids from projects, `priors` for the cover read, `standing` for the open-row read. Each
  // db('notifications') call is its own query; one that orders (standingRows) reads `standing`, the other `priors`.
  function setup({ signed = [], priors = [], standing = [] } = {}) {
    const calls = { updates: [], whereRaw: [] };
    db.mockImplementation((table) => {
      if (table === 'projects') return chain({ select: jest.fn().mockResolvedValue(signed.map((id) => ({ id }))) });
      if (table !== 'notifications') return chain();
      let ordered = false;
      const q = {
        where: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        whereRaw: jest.fn((sql) => { calls.whereRaw.push(sql); return q; }),
        orderBy: jest.fn(() => { ordered = true; return q; }),
        select: jest.fn(async () => (ordered ? standing : priors)),
        update: jest.fn(async (patch) => { calls.updates.push(patch); return 1; }),
      };
      return q;
    });
    return calls;
  }
  const standingRow = (id, ids) => ({ id, metadata: { dedupeKey: KEY(...ids), item_ids: ids } });

  beforeEach(() => {
    isEnabled.mockReturnValue(true);
    featureGates.wdoAttentionRingsLive.mockReturnValue(true);
  });

  test('gate on: the ring carries bellDefault; the rest of the call is what it was', async () => {
    setup({ signed: ['p1'] });
    const r = await runWdoReportAttentionSweep({ now: NOW });
    expect(r).toEqual({ ok: true, rang: true, items: 1 });
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('wdo_report_attention');
    expect(title).toBe('WDO reports need attention');
    expect(body).toContain('1 WDO report signed but never sent');
    expect(opts).toEqual({
      link: '/admin/projects',
      bellDefault: true,
      metadata: { dedupeKey: KEY('signed_unsent:p1'), item_ids: ['signed_unsent:p1'], signed_unsent: ['p1'], stuck_appointments: [] },
    });
  });

  test('gate off: no bellDefault, a muted result still counts as rung, nothing is closed or read', async () => {
    featureGates.wdoAttentionRingsLive.mockReturnValue(false);
    const calls = setup({ signed: ['p1'], standing: [standingRow('n1', ['signed_unsent:p0'])] });
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true });
    const r = await runWdoReportAttentionSweep({ now: NOW });
    expect(r).toEqual({ ok: true, rang: true, items: 1 });
    expect(NotificationService.notifyAdmin.mock.calls[0][3]).not.toHaveProperty('bellDefault');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(calls.updates).toEqual([]);
    expect(calls.whereRaw).toEqual([]);
  });

  test('gate off, lane clean: nothing is closed', async () => {
    featureGates.wdoAttentionRingsLive.mockReturnValue(false);
    setup();
    expect(await runWdoReportAttentionSweep({ now: NOW })).toEqual({ ok: true, clean: true });
    expect(episodes.openAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a feature-gates mock without the reader reads as off', async () => {
    const reader = featureGates.wdoAttentionRingsLive;
    delete featureGates.wdoAttentionRingsLive;
    try {
      setup({ signed: ['p1'] });
      const r = await runWdoReportAttentionSweep({ now: NOW });
      expect(r).toEqual({ ok: true, rang: true, items: 1 });
      expect(NotificationService.notifyAdmin.mock.calls[0][3]).not.toHaveProperty('bellDefault');
    } finally {
      featureGates.wdoAttentionRingsLive = reader;
    }
  });

  test('gate on: a muted result is not a ring (warn log, rang false, nothing closed)', async () => {
    setup({ signed: ['p1'], standing: [standingRow('n1', ['signed_unsent:p0'])] });
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true, deduped: false });
    const r = await runWdoReportAttentionSweep({ now: NOW });
    expect(r).toEqual({ ok: true, rang: false, suppressed: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('muted');
    expect(logger.info).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('gate on: a failed insert still fails the sweep', async () => {
    setup({ signed: ['p1'] });
    NotificationService.notifyAdmin.mockResolvedValue(null);
    await expect(runWdoReportAttentionSweep({ now: NOW })).rejects.toThrow('bell not recorded');
  });

  test('gate on: the cover read ignores rows the sweep closed; gate off still counts them', async () => {
    const on = setup({ signed: ['p1'], priors: [{ metadata: { item_ids: ['signed_unsent:p1'] } }] });
    const r = await runWdoReportAttentionSweep({ now: NOW });
    expect(r).toEqual(expect.objectContaining({ deduped: true, items: 1 }));
    expect(on.whereRaw.some((sql) => sql.includes("'autoCleared'"))).toBe(true);
    featureGates.wdoAttentionRingsLive.mockReturnValue(false);
    const off = setup({ signed: ['p1'], priors: [{ metadata: { item_ids: ['signed_unsent:p1'] } }] });
    await runWdoReportAttentionSweep({ now: NOW });
    expect(off.whereRaw).toEqual([]);
  });

  test('gate on, lane clean: the sweep closes its own open rows with a plain resolution', async () => {
    setup();
    episodes.openAdminAlertKeys.mockResolvedValue([KEY('signed_unsent:p1'), KEY('signed_unsent:p1', 'signed_unsent:p2')]);
    episodes.closeAdminAlertKeys.mockResolvedValue(2);
    const r = await runWdoReportAttentionSweep({ now: NOW });
    expect(r).toEqual({ ok: true, clean: true, closed: 2 });
    expect(episodes.openAdminAlertKeys).toHaveBeenCalledWith(db, 'wdo_report_attention:');
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(
      db,
      [KEY('signed_unsent:p1'), KEY('signed_unsent:p1', 'signed_unsent:p2')],
      'wdo_reports_clear',
      { now: NOW, resolution: 'All WDO reports are sent and no WDO inspection is waiting.' },
    );
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('gate on, lane clean, no open row: nothing to close', async () => {
    setup();
    expect(await runWdoReportAttentionSweep({ now: NOW })).toEqual({ ok: true, clean: true, closed: 0 });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('gate on, the set shrank (one report marked sent another way): the open row is rewritten in place, quietly', async () => {
    const calls = setup({
      signed: ['p2'],
      priors: [{ metadata: { item_ids: ['signed_unsent:p1', 'signed_unsent:p2'] } }],
      standing: [standingRow('n1', ['signed_unsent:p1', 'signed_unsent:p2'])],
    });
    const r = await runWdoReportAttentionSweep({ now: NOW });
    expect(r).toEqual({ ok: true, deduped: true, items: 1, refreshed: 1, closed: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].body).toContain('1 WDO report signed but never sent');
    expect(calls.updates[0].body).not.toContain('2 WDO');
    const [sql, [json]] = [calls.updates[0].metadata.sql, calls.updates[0].metadata.bindings];
    expect(sql).toContain("COALESCE(metadata, '{}'::jsonb) || ?::jsonb");
    expect(JSON.parse(json)).toEqual({
      dedupeKey: KEY('signed_unsent:p2'), item_ids: ['signed_unsent:p2'], signed_unsent: ['p2'], stuck_appointments: [],
    });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('gate on, the same set is still open: nothing is rewritten or closed', async () => {
    const calls = setup({
      signed: ['p1'],
      priors: [{ metadata: { item_ids: ['signed_unsent:p1'] } }],
      standing: [standingRow('n1', ['signed_unsent:p1'])],
    });
    const r = await runWdoReportAttentionSweep({ now: NOW });
    expect(r).toEqual({ ok: true, deduped: true, items: 1, refreshed: 0, closed: 0 });
    expect(calls.updates).toEqual([]);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('gate on, a row with exactly the current set is open beside a stale one: the stale one is closed, not rewritten', async () => {
    const calls = setup({
      signed: ['p2'],
      priors: [{ metadata: { item_ids: ['signed_unsent:p2'] } }],
      standing: [standingRow('n2', ['signed_unsent:p2']), standingRow('n1', ['signed_unsent:p1', 'signed_unsent:p2'])],
    });
    const r = await runWdoReportAttentionSweep({ now: NOW });
    expect(r).toEqual(expect.objectContaining({ refreshed: 0, closed: 0 }));
    expect(calls.updates).toEqual([]);
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(
      db, [KEY('signed_unsent:p1', 'signed_unsent:p2')], 'wdo_superseded', { now: NOW, resolution: 'Replaced by a newer WDO alert.' },
    );
  });

  test('gate on, the set grew: it rings once, then the smaller row is closed as replaced', async () => {
    setup({
      signed: ['p1', 'p2'],
      priors: [{ metadata: { item_ids: ['signed_unsent:p1'] } }],
      standing: [standingRow('n1', ['signed_unsent:p1'])],
    });
    const r = await runWdoReportAttentionSweep({ now: NOW });
    expect(r).toEqual({ ok: true, rang: true, items: 2 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(
      db, [KEY('signed_unsent:p1')], 'wdo_superseded', { now: NOW, resolution: 'Replaced by a newer WDO alert.' },
    );
  });

  test('gate on, an uncovered item with a muted ring leaves the open row alone', async () => {
    setup({ signed: ['p1', 'p2'], standing: [standingRow('n1', ['signed_unsent:p1'])] });
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true });
    await runWdoReportAttentionSweep({ now: NOW });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});
