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
 *   - NOT EXISTS a non-terminal scheduled_services row for the linked
 *     customer created on/after the lead (booked-from-this-courtship
 *     customer skips — pending won-conversion, not unresponsive; a
 *     cancelled/rescheduled/skipped/no_show visit or the customer's
 *     historical pre-lead services do NOT exempt)
 *   - deleted_at IS NULL, gated on the column existing (the leads
 *     soft-delete lane ships separately; either merge order must work)
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
// The bridge's own SQL is unit-tested in lead-funnel-bridge.test.js — here we
// only assert the sweep hands it the flipped ids on the same transaction.
jest.mock('../services/lead-funnel-bridge', () => ({
  bridgeLeadsFunnelStage: jest.fn(async () => ({ updated: 1 })),
}));

const logger = require('../services/logger');
const { bridgeLeadsFunnelStage } = require('../services/lead-funnel-bridge');
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
  chain.whereNull = jest.fn(() => chain);
  chain.modify = jest.fn((cb) => { cb(chain); return chain; });
  chain.whereNotExists = jest.fn(() => chain);
  chain.update = jest.fn(() => chain);
  chain.returning = jest.fn(() => chain);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function installDb({ flipped = [], hasDeletedAt = false } = {}) {
  const leadsChain = makeUpdateChain(flipped);
  const activityInsert = jest.fn(async () => {});
  const trx = jest.fn((table) => {
    if (table === 'leads') return leadsChain;
    if (table === 'lead_activities') return { insert: activityInsert };
    throw new Error(`unexpected table ${table}`);
  });
  mockDb.transaction = jest.fn(async (cb) => cb(trx));
  mockDb.schema = { hasColumn: jest.fn(async () => hasDeletedAt) };
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

    test('partially numeric values are the off switch too (parseInt prefix trap)', () => {
      // '21days' must NOT silently enable a 21-day sweep — an operator who
      // typed a malformed value expecting the documented fail-closed off
      // switch would otherwise have old leads auto-closed.
      for (const off of ['21days', '30 disabled', '7d']) {
        process.env.LEAD_STALENESS_DAYS = off;
        expect(getThresholdDays()).toBe(0);
      }
      // Surrounding whitespace alone is still a valid integer.
      process.env.LEAD_STALENESS_DAYS = ' 14 ';
      expect(getThresholdDays()).toBe(14);
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
        + 'where scheduled_services.customer_id = leads.customer_id '
        + 'and "scheduled_services"."status" not in (?, ?, ?, ?) '
        + "and scheduled_services.created_at >= COALESCE(leads.first_contact_at, leads.created_at) - interval '1 day') "
        + 'returning "id"'
      );
      expect(bindings).toEqual(['unresponsive', NOW, 'new', cutoff, NOW, cutoff, 'cancelled', 'rescheduled', 'skipped', 'no_show']);

      return knex.destroy();
    });

    test('excludeSoftDeleted adds deleted_at IS NULL', () => {
      const knex = require('knex')({ client: 'pg' });
      const cutoff = new Date(NOW.getTime() - 21 * DAY_MS);
      const { sql } = buildStaleLeadUpdate(knex, { now: NOW, cutoff, excludeSoftDeleted: true }).toSQL();

      expect(sql).toContain('"leads"."deleted_at" is null');

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

      // Funnel rows collapse to the lost bucket for the flipped leads, on the
      // SAME transaction (unresponsive is a closed status).
      expect(bridgeLeadsFunnelStage).toHaveBeenCalledWith(['lead-1', 'lead-2'], 'unresponsive', expect.any(Function));
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

    test('deleted_at column absent (pre-soft-delete-migration): no whereNull', async () => {
      const { leadsChain } = installDb({ flipped: [] });

      await runLeadStalenessSweep();

      expect(mockDb.schema.hasColumn).toHaveBeenCalledWith('leads', 'deleted_at');
      expect(leadsChain.whereNull).not.toHaveBeenCalledWith('leads.deleted_at');
    });

    test('deleted_at column present: soft-deleted leads are excluded', async () => {
      const { leadsChain } = installDb({ flipped: [], hasDeletedAt: true });

      await runLeadStalenessSweep();

      expect(leadsChain.whereNull).toHaveBeenCalledWith('leads.deleted_at');
    });

    test('no eligible leads: no activity insert, no funnel bridge, marked 0', async () => {
      const { activityInsert } = installDb({ flipped: [] });

      const result = await runLeadStalenessSweep();

      expect(result).toEqual({ disabled: false, marked: 0 });
      expect(activityInsert).not.toHaveBeenCalled();
      expect(bridgeLeadsFunnelStage).not.toHaveBeenCalled();
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
