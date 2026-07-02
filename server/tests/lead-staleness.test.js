/**
 * Lead staleness sweep (services/lead-staleness.js).
 *
 * Daily cron that flips `new` leads to `unresponsive` after
 * LEAD_STALENESS_DAYS (default 21) with no contact. The eligibility rules
 * live in one set-based UPDATE, so the WHERE semantics are pinned by
 * compiling the real builder with knex (no DB needed):
 *   - status = 'new' and created_at <= now - N days
 *   - no lead_activities row inside the window (recent activity skips)
 *   - next_follow_up_at NULL or past (future callback skips)
 *   - NOT EXISTS scheduled_services for the linked customer (booked
 *     customer skips — pending won-conversion, not unresponsive)
 * Effects (activity rows, summary counts, env off switch) are covered with
 * the chain-mock style used by the other sweep tests.
 */
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const logger = require('../services/logger');
const {
  runLeadStalenessSweep,
  getThresholdDays,
  buildStaleLeadUpdate,
} = require('../services/lead-staleness');

const NOW = new Date('2026-07-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeUpdateChain(result) {
  const chain = {};
  chain.where = jest.fn(() => chain);
  chain.whereNotExists = jest.fn(() => chain);
  chain.update = jest.fn(() => chain);
  chain.returning = jest.fn(() => chain);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function installDb({ flipped = [] } = {}) {
  const leadsChain = makeUpdateChain(flipped);
  const activityInsert = jest.fn(async () => {});
  const trx = jest.fn((table) => {
    if (table === 'leads') return leadsChain;
    if (table === 'lead_activities') return { insert: activityInsert };
    throw new Error(`unexpected table ${table}`);
  });
  mockDb.transaction = jest.fn(async (cb) => cb(trx));
  return { leadsChain, activityInsert, trx };
}

describe('lead staleness sweep', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    delete process.env.LEAD_STALENESS_DAYS;
    mockDb.mockReset();
    logger.info.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.LEAD_STALENESS_DAYS;
    jest.clearAllMocks();
  });

  describe('threshold env parsing', () => {
    test('defaults to 21 when unset', () => {
      expect(getThresholdDays()).toBe(21);
    });

    test('reads a custom threshold', () => {
      process.env.LEAD_STALENESS_DAYS = '30';
      expect(getThresholdDays()).toBe(30);
    });

    test('falsy / zero / non-numeric values are the off switch', () => {
      for (const off of ['', '0', '-5', 'off', 'false']) {
        process.env.LEAD_STALENESS_DAYS = off;
        expect(getThresholdDays()).toBe(0);
      }
    });
  });

  describe('WHERE semantics (compiled SQL)', () => {
    test('one UPDATE carries every eligibility rule', () => {
      // Real knex compilation — pins that a recent-activity lead, a
      // future-callback lead, and a booked-customer lead are all excluded
      // by the query itself, and that unlinked leads (customer_id NULL)
      // pass the scheduled_services NOT EXISTS.
      const knex = require('knex')({ client: 'pg' });
      const cutoff = new Date(NOW.getTime() - 21 * DAY_MS);
      const { sql, bindings } = buildStaleLeadUpdate(knex, { now: NOW, cutoff }).toSQL();

      expect(sql).toBe(
        'update "leads" set "status" = ?, "updated_at" = ? '
        + 'where "leads"."status" = ? and "leads"."created_at" <= ? '
        + 'and ("leads"."next_follow_up_at" is null or "leads"."next_follow_up_at" <= ?) '
        + 'and not exists (select 1 from "lead_activities" '
        + 'where lead_activities.lead_id = leads.id and "lead_activities"."created_at" >= ?) '
        + 'and not exists (select 1 from "scheduled_services" '
        + 'where scheduled_services.customer_id = leads.customer_id) '
        + 'returning "id"'
      );
      expect(bindings).toEqual(['unresponsive', NOW, 'new', cutoff, NOW, cutoff]);

      return knex.destroy();
    });
  });

  describe('runLeadStalenessSweep', () => {
    test('transitions eligible leads and writes one activity row per flip', async () => {
      const { leadsChain, activityInsert } = installDb({
        flipped: [{ id: 'lead-1' }, { id: 'lead-2' }],
      });

      const result = await runLeadStalenessSweep();

      expect(result).toEqual({ disabled: false, marked: 2 });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(leadsChain.update).toHaveBeenCalledWith({ status: 'unresponsive', updated_at: NOW });
      expect(leadsChain.returning).toHaveBeenCalledWith('id');

      // Default 21-day cutoff lands on the created_at bound.
      const cutoff = new Date(NOW.getTime() - 21 * DAY_MS);
      expect(leadsChain.where).toHaveBeenCalledWith('leads.status', 'new');
      expect(leadsChain.where).toHaveBeenCalledWith('leads.created_at', '<=', cutoff);

      expect(activityInsert).toHaveBeenCalledTimes(1);
      expect(activityInsert).toHaveBeenCalledWith([
        {
          lead_id: 'lead-1',
          activity_type: 'status_change',
          description: 'Auto-marked unresponsive after 21 days with no contact',
          performed_by: 'system',
          metadata: JSON.stringify({ auto: true, threshold_days: 21 }),
        },
        {
          lead_id: 'lead-2',
          activity_type: 'status_change',
          description: 'Auto-marked unresponsive after 21 days with no contact',
          performed_by: 'system',
          metadata: JSON.stringify({ auto: true, threshold_days: 21 }),
        },
      ]);

      // One summary line: count + threshold.
      expect(logger.info).toHaveBeenCalledWith('[lead-staleness] thresholdDays=21 marked=2');
    });

    test('custom LEAD_STALENESS_DAYS drives the cutoff and the activity copy', async () => {
      process.env.LEAD_STALENESS_DAYS = '30';
      const { leadsChain, activityInsert } = installDb({ flipped: [{ id: 'lead-9' }] });

      const result = await runLeadStalenessSweep();

      expect(result).toEqual({ disabled: false, marked: 1 });
      const cutoff = new Date(NOW.getTime() - 30 * DAY_MS);
      expect(leadsChain.where).toHaveBeenCalledWith('leads.created_at', '<=', cutoff);
      expect(activityInsert).toHaveBeenCalledWith([
        expect.objectContaining({
          lead_id: 'lead-9',
          description: 'Auto-marked unresponsive after 30 days with no contact',
        }),
      ]);
    });

    test('no eligible leads: no activity insert, marked 0', async () => {
      const { activityInsert } = installDb({ flipped: [] });

      const result = await runLeadStalenessSweep();

      expect(result).toEqual({ disabled: false, marked: 0 });
      expect(activityInsert).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('[lead-staleness] thresholdDays=21 marked=0');
    });

    test('disabled via env: never touches the database', async () => {
      installDb({ flipped: [{ id: 'should-not-flip' }] });

      for (const off of ['', '0', 'off']) {
        process.env.LEAD_STALENESS_DAYS = off;
        const result = await runLeadStalenessSweep();
        expect(result).toEqual({ disabled: true, marked: 0 });
      }

      expect(mockDb).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });
});
