/**
 * Stale-visit sweep — nightly detection bell for past-dated open visits.
 * Covers the pure helpers (signature, summary copy, prior-bell coverage),
 * the gate short-circuit, the query classification, and the ring/dedupe
 * decision. Detection-only: the sweep must never touch scheduled_services
 * beyond the read.
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
const { runStaleVisitSweep, _private } = require('../services/stale-visit-sweep');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue([]),
    first: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
    ...overrides,
  };
}

const BACKLOG = [
  { id: 'a', status: 'pending', scheduled_date: '2026-07-10', customer_id: 'c1' },
  { id: 'b', status: 'pending', scheduled_date: '2026-07-12', customer_id: 'c2' },
  { id: 'c', status: 'on_site', scheduled_date: '2026-05-02', customer_id: 'c3' },
];

beforeEach(() => {
  jest.clearAllMocks();
  NotificationService.notifyAdmin.mockResolvedValue({});
});

describe('summarySignature / summarize', () => {
  test('signature covers total, per-status counts, and the oldest date', () => {
    const sig = _private.summarySignature(BACKLOG);
    expect(sig).toContain('total:3');
    expect(sig).toContain('pending:2');
    expect(sig).toContain('on_site:1');
    expect(sig).toContain('oldest:2026-05-02');
  });

  test('signature is stable across row order and normalizes Date objects', () => {
    const asDates = [...BACKLOG].reverse().map((v) => ({
      ...v,
      // pg returns plain DATE columns as Date objects.
      scheduled_date: new Date(`${v.scheduled_date}T00:00:00Z`),
    }));
    expect(_private.summarySignature(asDates)).toBe(_private.summarySignature(BACKLOG));
  });

  test('summarize names non-zero statuses with counts and the oldest date', () => {
    const text = _private.summarize(BACKLOG);
    expect(text).toContain('3 past-dated visits still open');
    expect(text).toContain('2 pending');
    expect(text).toContain('1 on site');
    expect(text).not.toContain('confirmed');
    expect(text).toContain('oldest 2026-05-02');
  });
});

describe('priorBellCovers', () => {
  const now = new Date('2026-07-19T12:00:00Z');
  const sig = _private.summarySignature(BACKLOG);

  test('recent bell with the same signature covers', () => {
    expect(_private.priorBellCovers({ signature: sig, createdAt: '2026-07-18T12:00:00Z' }, sig, now)).toBe(true);
  });

  test('a changed picture is never covered', () => {
    expect(_private.priorBellCovers({ signature: 'total:2|other', createdAt: '2026-07-18T12:00:00Z' }, sig, now)).toBe(false);
  });

  test('no prior bell → not covered', () => {
    expect(_private.priorBellCovers(null, sig, now)).toBe(false);
  });

  test('a same-signature bell older than REMIND_DAYS re-rings (a frozen backlog must not go silent)', () => {
    expect(_private.priorBellCovers({ signature: sig, createdAt: '2026-07-01T12:00:00Z' }, sig, now)).toBe(false);
  });
});

describe('runStaleVisitSweep', () => {
  test('gated off → skipped, no queries', async () => {
    isEnabled.mockReturnValue(false);
    const r = await runStaleVisitSweep();
    expect(r).toEqual({ skipped: true, reason: 'gated_off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('clean backlog → no bell', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation(() => chain());
    const r = await runStaleVisitSweep();
    expect(r.clean).toBe(true);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('backlog with no prior bell rings ONE bell with the summary fingerprint', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ select: jest.fn().mockResolvedValue(BACKLOG) });
      return chain();
    });
    const r = await runStaleVisitSweep();
    expect(r.rang).toBe(true);
    expect(r.items).toBe(3);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('stale_visit_sweep');
    expect(title).toContain('Stale visits');
    expect(body).toContain('3 past-dated visits still open');
    expect(opts.link).toBe('/admin/dashboard');
    expect(opts.metadata.summary_signature).toBe(_private.summarySignature(BACKLOG));
    expect(opts.metadata.counts).toEqual({ pending: 2, confirmed: 0, en_route: 0, on_site: 1 });
    expect(opts.metadata.oldest_date).toBe('2026-05-02');
  });

  test('an unchanged backlog covered by a recent bell stays silent', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ select: jest.fn().mockResolvedValue(BACKLOG) });
      if (table === 'notifications') {
        return chain({
          first: jest.fn().mockResolvedValue({
            metadata: { summary_signature: _private.summarySignature(BACKLOG) },
            created_at: new Date(Date.now() - 24 * 3600e3),
          }),
        });
      }
      return chain();
    });
    const r = await runStaleVisitSweep();
    expect(r.deduped).toBe(true);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a changed backlog re-rings even with a recent bell', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ select: jest.fn().mockResolvedValue(BACKLOG) });
      if (table === 'notifications') {
        return chain({
          first: jest.fn().mockResolvedValue({
            // Yesterday's picture had one fewer row — the summary changed.
            metadata: { summary_signature: _private.summarySignature(BACKLOG.slice(0, 2)) },
            created_at: new Date(Date.now() - 24 * 3600e3),
          }),
        });
      }
      return chain();
    });
    const r = await runStaleVisitSweep();
    expect(r.rang).toBe(true);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('query classifies on the open-status allowlist and an ET calendar-date cutoff', async () => {
    isEnabled.mockReturnValue(true);
    let visitChain;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') {
        visitChain = chain();
        return visitChain;
      }
      return chain();
    });
    await runStaleVisitSweep();
    // Allowlist, not a terminal-state blocklist — rescheduled/skipped/any
    // future terminal status must never ring.
    expect(visitChain.whereIn).toHaveBeenCalledWith('status', ['pending', 'confirmed', 'en_route', 'on_site']);
    // scheduled_date is an ET wall-clock DATE — the cutoff must be an ET
    // calendar-date string, never a JS Date instant.
    expect(visitChain.where).toHaveBeenCalledWith(
      'scheduled_date',
      '<',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    // Detection-only: the sweep must never mutate the rows it found.
    expect(visitChain.update).not.toHaveBeenCalled();
  });

  test('a query failure fails the sweep loudly instead of reporting clean', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') {
        return chain({ select: jest.fn().mockRejectedValue(new Error('relation missing')) });
      }
      return chain();
    });
    await expect(runStaleVisitSweep()).rejects.toThrow('relation missing');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a failed bell insert fails the sweep instead of recording a ring', async () => {
    isEnabled.mockReturnValue(true);
    NotificationService.notifyAdmin.mockResolvedValue(null); // insert failed
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ select: jest.fn().mockResolvedValue(BACKLOG) });
      return chain();
    });
    await expect(runStaleVisitSweep()).rejects.toThrow('bell not recorded');
  });
});
