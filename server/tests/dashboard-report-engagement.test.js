'use strict';
/**
 * get_report_engagement — the first READ of the service-report telemetry
 * (service_report_events / service_report_deliveries.sent_at /
 * service_records.report_viewed_at). Protects: ET day bounds are passed as
 * real Dates (the timestamptz window trap), the ROLLUP total row is split
 * from the per-line rows, Postgres strings become numbers, the open-rate
 * and median guards, and bad input never reaches the DB.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const rawCalls = [];
let rawRows = [];
const mockDb = jest.fn(() => { throw new Error('get_report_engagement must not use the builder'); });
mockDb.raw = jest.fn((sql, bindings) => {
  rawCalls.push({ sql, bindings });
  return Promise.resolve({ rows: rawRows });
});
jest.mock('../models/db', () => mockDb);

const { executeDashboardTool, DASHBOARD_TOOLS } = require('../services/intelligence-bar/dashboard-tools');
const { etDateString } = require('../utils/datetime-et');

beforeEach(() => {
  rawCalls.length = 0;
  rawRows = [];
});

describe('get_report_engagement', () => {
  test('is declared with optional ET date bounds', () => {
    const decl = DASHBOARD_TOOLS.find((t) => t.name === 'get_report_engagement');
    expect(decl).toBeTruthy();
    expect(decl.input_schema.required).toBeUndefined();
    expect(Object.keys(decl.input_schema.properties).sort()).toEqual(['date_from', 'date_to']);
  });

  test('binds the window as real Dates spanning ET midnight to the day after date_to', async () => {
    await executeDashboardTool('get_report_engagement', { date_from: '2026-08-01', date_to: '2026-08-31' });
    expect(rawCalls).toHaveLength(1);
    const [fromTs, toTs] = rawCalls[0].bindings;
    expect(fromTs).toBeInstanceOf(Date);
    expect(toTs).toBeInstanceOf(Date);
    // 2026-08-01 00:00 ET is 04:00Z (EDT); the upper bound is the NEXT ET
    // midnight after date_to, so the whole of Aug 31 ET is inside.
    expect(fromTs.toISOString()).toBe('2026-08-01T04:00:00.000Z');
    expect(toTs.toISOString()).toBe('2026-09-01T04:00:00.000Z');
    expect(rawCalls[0].sql).toMatch(/first_sent_at >= \? AND snd\.first_sent_at < \?/);
  });

  test('defaults to the last 30 ET days ending today', async () => {
    const res = await executeDashboardTool('get_report_engagement', {});
    expect(res.period.to).toBe(etDateString(new Date()));
    const fromMs = rawCalls[0].bindings[0].getTime();
    const toMs = rawCalls[0].bindings[1].getTime();
    // 31 ET days inclusive (30 days ago through today) → 31 × 24h ± DST hour.
    const days = (toMs - fromMs) / 86400000;
    expect(days).toBeGreaterThanOrEqual(30.9);
    expect(days).toBeLessThanOrEqual(31.1);
  });

  test('splits the ROLLUP total from the per-line rows and parses Postgres strings', async () => {
    rawRows = [
      { service_line: null, is_total: 1, sent: '40', opened: '25', median_minutes_to_open: '42.4', pdf_downloaded: '3', photo_opened: '8', map_interacted: '2', reentry_timer_viewed: '9', review_request_clicked: '3', referral_cta_clicked: '1', cross_sell_requested: '0', followup_requested: '1', report_question_asked: '2' },
      { service_line: 'pest', is_total: 0, sent: '25', opened: '18', median_minutes_to_open: '30', pdf_downloaded: '2', photo_opened: '6', map_interacted: '2', reentry_timer_viewed: '9', review_request_clicked: '2', referral_cta_clicked: '1', cross_sell_requested: '0', followup_requested: '0', report_question_asked: '1' },
      { service_line: 'lawn', is_total: 0, sent: '15', opened: '7', median_minutes_to_open: null, pdf_downloaded: '1', photo_opened: '2', map_interacted: '0', reentry_timer_viewed: '0', review_request_clicked: '1', referral_cta_clicked: '0', cross_sell_requested: '0', followup_requested: '1', report_question_asked: '1' },
    ];
    const res = await executeDashboardTool('get_report_engagement', { date_from: '2026-08-01', date_to: '2026-08-31' });
    expect(res.period).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(res.total).toMatchObject({ sent: 40, opened: 25, open_rate_pct: 63, median_minutes_to_open: 42, photo_opened: 8, review_request_clicked: 3 });
    expect(res.by_service_line).toHaveLength(2);
    expect(res.by_service_line[0]).toMatchObject({ service_line: 'pest', sent: 25, opened: 18, open_rate_pct: 72, median_minutes_to_open: 30 });
    expect(res.by_service_line[1]).toMatchObject({ service_line: 'lawn', sent: 15, opened: 7, open_rate_pct: 47, median_minutes_to_open: null });
    // Every value the model will read is a number or null — never a string.
    for (const row of [res.total, ...res.by_service_line]) {
      for (const [k, v] of Object.entries(row)) {
        if (k === 'service_line') continue;
        expect(v === null || typeof v === 'number').toBe(true);
      }
    }
  });

  test('an empty window returns zeros, not NaN', async () => {
    rawRows = [];
    const res = await executeDashboardTool('get_report_engagement', { date_from: '2026-08-01', date_to: '2026-08-31' });
    expect(res.total).toMatchObject({ sent: 0, opened: 0, open_rate_pct: 0, median_minutes_to_open: null });
    expect(res.by_service_line).toEqual([]);
  });

  test('rejects malformed or inverted dates before touching the DB', async () => {
    expect(await executeDashboardTool('get_report_engagement', { date_from: 'last month' })).toEqual({ error: 'date_from and date_to must be YYYY-MM-DD' });
    expect(await executeDashboardTool('get_report_engagement', { date_from: '2026-09-02', date_to: '2026-09-01' })).toEqual({ error: 'date_from must be on or before date_to' });
    expect(rawCalls).toHaveLength(0);
  });
});
