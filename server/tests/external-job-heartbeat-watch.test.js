/**
 * External job heartbeat watch — one standing bell per silence EPISODE when an
 * outside daily job has no complete run today (ET) by its due time; closes
 * itself when a complete run lands; nothing when the lane is dark.
 */
let jobRow = null;
const mockDb = jest.fn(() => {
  const q = {
    where: jest.fn(() => q),
    first: jest.fn(async () => jobRow),
  };
  return q;
});
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => true) }));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(),
  closeAdminAlertKeys: jest.fn(async () => 0),
  openAdminAlertKeys: jest.fn(async () => []),
}));

const { gateEnvValue } = require('../config/feature-gates');
const alertEpisodes = require('../services/admin-alert-episodes');
const { runExternalHeartbeatWatch, EXTERNAL_JOBS, sanitizeError } = require('../services/external-job-heartbeat-watch');

const AFTER_DUE = new Date('2026-10-28T12:00:00.000Z'); // 08:00 ET (EDT)
const BEFORE_DUE = new Date('2026-10-28T10:30:00.000Z'); // 06:30 ET
const PREFIX = 'external-heartbeat:appt-sweep:';

// Stand-in for the SQL: remembers which keys were raised, so a second tick
// of the same episode is a silent dedupe (rang: false), as in production.
let standing;

beforeEach(() => {
  jest.clearAllMocks();
  gateEnvValue.mockReturnValue(true);
  jobRow = null;
  standing = new Set();
  alertEpisodes.openAdminAlertKeys.mockImplementation(async () => [...standing]);
  alertEpisodes.closeAdminAlertKeys.mockImplementation(async (_conn, keys) => {
    keys.forEach((k) => standing.delete(k));
    return keys.length;
  });
  alertEpisodes.raiseAdminAlertWithReopen.mockImplementation(async (_cat, _title, _body, opts) => {
    const fresh = !standing.has(opts.dedupeKey);
    standing.add(opts.dedupeKey);
    return fresh ? { id: 'n1', rang: true } : { id: 'n1', deduped: true, rang: false };
  });
});

test('registry: first entry is the office Mac appt-sweep due 07:00', () => {
  expect(EXTERNAL_JOBS[0]).toEqual({
    jobName: 'appt-sweep',
    dueBy: '07:00',
    label: 'Daily plan gap sweep (office Mac)',
    where: '~/ops-oneshots/appt-sweep/run.log',
    link: '/admin/schedule',
  });
});

test('gate off -> skipped, no DB read, nothing raised or closed', async () => {
  gateEnvValue.mockReturnValue(false);
  const r = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  expect(r).toEqual({ skipped: true });
  expect(gateEnvValue).toHaveBeenCalledWith('GATE_EXTERNAL_HEARTBEAT_WATCH');
  expect(mockDb).not.toHaveBeenCalled();
  expect(alertEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  expect(alertEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
});

test('before 07:00 ET with no row -> nothing raised, nothing closed', async () => {
  standing.add(`${PREFIX}never`);
  const r = await runExternalHeartbeatWatch({ now: BEFORE_DUE });
  expect(r.skipped).toBe(false);
  expect(r.alerted).toBe(0);
  expect(alertEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  expect(alertEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
});

test('before 07:00 ET with yesterday\'s success -> nothing raised, nothing closed', async () => {
  jobRow = { last_status: 'success', last_success_at: new Date('2026-10-27T11:00:00.000Z') };
  const r = await runExternalHeartbeatWatch({ now: BEFORE_DUE });
  expect(r.alerted).toBe(0);
  expect(alertEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  expect(alertEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
});

test('after 07:00 ET with no row -> one alert keyed "never"', async () => {
  const r = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  expect(r.alerted).toBe(1);
  expect(alertEpisodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
  const [category, title, body, opts] = alertEpisodes.raiseAdminAlertWithReopen.mock.calls[0];
  expect(category).toBe('system');
  expect(title).toBe('FIX: Daily plan gap sweep did not finish today');
  expect(body).toContain('never');
  expect(body.length).toBeLessThanOrEqual(110);
  expect(opts.dedupeKey).toBe(`${PREFIX}never`);
  expect(opts.link).toBe('/admin/schedule');
  expect(opts.bell).toBe(true);
  expect(opts.detail).toContain('~/ops-oneshots/appt-sweep/run.log');
  expect(opts.detail).toMatch(/asleep or off/);
  expect(opts.detail).toMatch(/Railway login expired/);
  expect(opts.metadata.dedupeKey).toBe(`${PREFIX}never`);
});

test('yesterday\'s success after 07:00 -> alert keyed to that success', async () => {
  const yesterday = new Date('2026-10-27T11:02:00.000Z'); // 07:02 ET Oct 27
  jobRow = { last_status: 'success', last_success_at: yesterday, last_error: null };
  const r = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  expect(r.alerted).toBe(1);
  const [, , body, opts] = alertEpisodes.raiseAdminAlertWithReopen.mock.calls[0];
  expect(opts.dedupeKey).toBe(`${PREFIX}${yesterday.toISOString()}`);
  expect(body).toMatch(/October 27, 7:02 AM ET/);
});

test('last_status failed today -> alert, with a sanitized short error', async () => {
  jobRow = {
    last_status: 'failed',
    last_success_at: new Date('2026-10-27T11:02:00.000Z'),
    last_error: 'partial: upstream jobs not finished\ntoken=abcdefghijklmnopqrstuvwxyz0123456789 ops@example.com',
    consecutive_failures: 1,
  };
  const r = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  expect(r.alerted).toBe(1);
  const [, , body, opts] = alertEpisodes.raiseAdminAlertWithReopen.mock.calls[0];
  expect(body).toContain('failed');
  expect(opts.detail).toContain('partial: upstream jobs not finished');
  expect(opts.detail).not.toMatch(/abcdefghijklmnopqrstuvwxyz/);
  expect(opts.detail).not.toContain('ops@example.com');
  expect(opts.detail).not.toContain('\n');
});

test('a failed run that follows an earlier success today still counts as not complete', async () => {
  jobRow = { last_status: 'failed', last_success_at: new Date('2026-10-28T11:02:00.000Z'), last_error: 'boom' };
  const r = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  expect(r.alerted).toBe(1);
});

test('complete today -> no alert and every open alert of the job is closed', async () => {
  jobRow = { last_status: 'success', last_success_at: new Date('2026-10-28T11:05:00.000Z') };
  standing.add(`${PREFIX}never`);
  standing.add(`${PREFIX}2026-10-26T11:00:00.000Z`);
  const r = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  expect(r).toMatchObject({ skipped: false, alerted: 0, closed: 2 });
  expect(alertEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  expect(alertEpisodes.openAdminAlertKeys).toHaveBeenCalledWith(mockDb, PREFIX);
  expect(alertEpisodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
  expect(alertEpisodes.closeAdminAlertKeys.mock.calls[0][1].sort()).toEqual([
    `${PREFIX}2026-10-26T11:00:00.000Z`, `${PREFIX}never`,
  ]);
  expect(standing.size).toBe(0);
});

test('complete today before the due time still closes a standing alert', async () => {
  jobRow = { last_status: 'success', last_success_at: new Date('2026-10-28T10:20:00.000Z') }; // 06:20 ET
  standing.add(`${PREFIX}never`);
  const r = await runExternalHeartbeatWatch({ now: BEFORE_DUE });
  expect(r.closed).toBe(1);
});

test('complete today with nothing open -> no close call', async () => {
  jobRow = { last_status: 'success', last_success_at: new Date('2026-10-28T11:05:00.000Z') };
  const r = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  expect(r).toMatchObject({ alerted: 0, closed: 0 });
  expect(alertEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
});

test('same episode on a second tick -> no second alert (dedupe)', async () => {
  const first = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  const second = await runExternalHeartbeatWatch({ now: new Date(AFTER_DUE.getTime() + 3600000) });
  expect(first.alerted).toBe(1);
  expect(second.alerted).toBe(0);
  const keys = alertEpisodes.raiseAdminAlertWithReopen.mock.calls.map((c) => c[3].dedupeKey);
  expect(new Set(keys).size).toBe(1);
  expect(standing.size).toBe(1);
});

test('a multi-day outage keeps ONE episode key (next day, same last success)', async () => {
  const lastOk = new Date('2026-10-26T11:00:00.000Z');
  jobRow = { last_status: 'success', last_success_at: lastOk };
  await runExternalHeartbeatWatch({ now: AFTER_DUE });
  const nextDay = await runExternalHeartbeatWatch({ now: new Date('2026-10-29T12:00:00.000Z') });
  expect(nextDay.alerted).toBe(0);
  expect(standing).toEqual(new Set([`${PREFIX}${lastOk.toISOString()}`]));
});

test('a new silence episode closes the older episode key of the same job', async () => {
  standing.add(`${PREFIX}never`);
  jobRow = { last_status: 'success', last_success_at: new Date('2026-10-27T11:00:00.000Z') };
  const r = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  expect(r).toMatchObject({ alerted: 1, closed: 1 });
  expect(standing).toEqual(new Set([`${PREFIX}2026-10-27T11:00:00.000Z`]));
});

test('ET date boundary: a success at 23:30 ET yesterday (03:30Z today) counts as YESTERDAY', async () => {
  const lateYesterday = new Date('2026-10-28T03:30:00.000Z'); // 23:30 ET Oct 27 (EDT)
  jobRow = { last_status: 'success', last_success_at: lateYesterday };
  const r = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  expect(r.alerted).toBe(1);
  expect(alertEpisodes.raiseAdminAlertWithReopen.mock.calls[0][3].dedupeKey).toBe(`${PREFIX}${lateYesterday.toISOString()}`);
  expect(alertEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
});

test('a bell that did not persist throws so the cron records the failure', async () => {
  alertEpisodes.raiseAdminAlertWithReopen.mockResolvedValue(null);
  await expect(runExternalHeartbeatWatch({ now: AFTER_DUE })).rejects.toThrow(/did not persist/);
});

test('an internal-test suppression is a success without a row', async () => {
  alertEpisodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: null, suppressed: true, rang: false });
  const r = await runExternalHeartbeatWatch({ now: AFTER_DUE });
  expect(r.alerted).toBe(0);
});

test('sanitizeError: one short line, no emails, links or long tokens', () => {
  const out = sanitizeError(`line one\nsee https://example.com/x?y=1 ${'a'.repeat(300)}`);
  expect(out).not.toContain('\n');
  expect(out).not.toContain('https://');
  expect(out.length).toBeLessThanOrEqual(120);
});
