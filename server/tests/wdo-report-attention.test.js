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
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({}) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((_name, fn) => fn()) }));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { isEnabled } = require('../config/feature-gates');
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
});

describe('itemIds / summarize', () => {
  const items = {
    signedUnsent: [{ id: 'p1' }],
    stuckAppts: [{ id: 'a1' }, { id: 'a2' }],
    stuckHolds: [],
  };

  test('itemIds is stable and namespaced', () => {
    expect(_private.itemIds(items)).toEqual(['signed_unsent:p1', 'stuck_appt:a1', 'stuck_appt:a2']);
  });

  test('summarize names each flavor with counts', () => {
    const text = _private.summarize(items);
    expect(text).toContain('1 WDO report signed but never sent');
    expect(text).toContain('2 WDO inspections past date without a completed report');
    expect(text).not.toContain('failing release');
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
        // First projects query = signedUnsent, second = stuckHolds. Return one
        // signed-unsent row on the whereNotNull('wdo_signature') variant only.
        return chain({
          whereNotNull: jest.fn().mockReturnThis(),
          select: jest.fn().mockImplementation(function selectImpl() {
            const wantsHolds = this.whereIn.mock.calls.length > 0;
            return Promise.resolve(wantsHolds ? [] : [{ id: 'p1', customer_id: 'c1', project_date: '2026-07-15', updated_at: '2026-07-17' }]);
          }),
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
          select: jest.fn().mockImplementation(function selectImpl() {
            const wantsHolds = this.whereIn.mock.calls.length > 0;
            return Promise.resolve(wantsHolds ? [] : [{ id: 'p1' }]);
          }),
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

  test('held pay-before-report drafts are excluded from signed-unsent', async () => {
    isEnabled.mockReturnValue(true);
    const projectsChains = [];
    db.mockImplementation((table) => {
      const c = chain();
      if (table === 'projects') projectsChains.push(c);
      return c;
    });
    await runWdoReportAttentionSweep();
    // First projects query = signedUnsent: held/releasing rows are parked by
    // design (pay-before-report), not stalled — they must not ring here.
    expect(projectsChains[0].whereRaw).toHaveBeenCalledWith(expect.stringContaining("NOT IN ('held', 'releasing')"));
  });

  test('a failed bell insert fails the sweep instead of recording a ring', async () => {
    isEnabled.mockReturnValue(true);
    NotificationService.notifyAdmin.mockResolvedValue(null); // insert failed
    db.mockImplementation((table) => {
      if (table === 'projects') {
        return chain({
          select: jest.fn().mockImplementation(function selectImpl() {
            const wantsHolds = this.whereIn.mock.calls.length > 0;
            return Promise.resolve(wantsHolds ? [] : [{ id: 'p1' }]);
          }),
        });
      }
      if (table === 'notifications') return chain({ select: jest.fn().mockResolvedValue([]) });
      return chain();
    });
    await expect(runWdoReportAttentionSweep()).rejects.toThrow('bell not recorded');
  });
});
