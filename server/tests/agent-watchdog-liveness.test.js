/**
 * Outside watchdog liveness — the reciprocal check: one engineering fault row
 * per silence EPISODE when the outside watchdog (the MacBook Air job) stops
 * polling; the first fresh poll retires it; nothing while the lane is dark.
 */
let lastRow = null;
const mockDb = jest.fn(() => {
  const q = {
    where: jest.fn(() => q),
    max: jest.fn(() => q),
    first: jest.fn(async () => lastRow),
  };
  return q;
});
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => true), isEnabled: jest.fn(() => true) }));
const mockDeliver = jest.fn();
jest.mock('../services/ops-digest', () => ({
  ...jest.requireActual('../services/ops-digest'),
  deliverOpsDigest: (...args) => mockDeliver(...args),
}));
const mockRetire = jest.fn();
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: (...args) => mockRetire(...args) }));

const { gateEnvValue, isEnabled } = require('../config/feature-gates');
const { runWatchdogLivenessCheck, DEFAULT_STALE_MINUTES, OPS_KEY } = require('../services/agent-watchdog-liveness');

const NOW = new Date('2026-09-03T18:00:00.000Z'); // Thu 2:00 PM ET
const minutesBefore = (n, from = NOW) => new Date(from.getTime() - n * 60000);

beforeEach(() => {
  jest.clearAllMocks();
  gateEnvValue.mockReturnValue(true);
  isEnabled.mockReturnValue(true);
  delete process.env.HERMES_WATCHDOG_STALE_MINUTES;
  lastRow = null;
  mockDeliver.mockResolvedValue({ ok: true, channel: 'in_app', id: 'row-1' });
  mockRetire.mockResolvedValue(0);
});

test('lane gate off → skipped: no read, no row, no retire', async () => {
  gateEnvValue.mockReturnValue(false);
  expect(await runWatchdogLivenessCheck({ now: NOW })).toEqual({ skipped: true });
  expect(gateEnvValue).toHaveBeenCalledWith('GATE_HERMES_WATCHDOG');
  expect(mockDb).not.toHaveBeenCalled();
  expect(mockDeliver).not.toHaveBeenCalled();
  expect(mockRetire).not.toHaveBeenCalled();
});

test('shared worker gate off → skipped (polls get a deliberate 403, so silence is not news)', async () => {
  isEnabled.mockReturnValue(false);
  expect(await runWatchdogLivenessCheck({ now: NOW })).toEqual({ skipped: true });
  expect(isEnabled).toHaveBeenCalledWith('hermesWorker');
  expect(mockDb).not.toHaveBeenCalled();
  expect(mockDeliver).not.toHaveBeenCalled();
});

test('a fresh poll → no row, and the standing silent row retires', async () => {
  lastRow = { at: minutesBefore(10) };
  mockRetire.mockResolvedValue(1);
  const r = await runWatchdogLivenessCheck({ now: NOW });
  expect(r).toEqual({ skipped: false, silent: false, closed: 1, ageMinutes: 10, limit: DEFAULT_STALE_MINUTES });
  expect(mockRetire).toHaveBeenCalledWith(OPS_KEY, { resolvedBy: 'outside-watchdog:polling' });
  expect(mockDeliver).not.toHaveBeenCalled();
});

test('a stale poll → one engineering fault row for Claude, never the owner bell', async () => {
  const last = minutesBefore(90);
  lastRow = { at: last };
  const r = await runWatchdogLivenessCheck({ now: NOW });
  expect(r).toEqual({ skipped: false, silent: true, ageMinutes: 90, limit: DEFAULT_STALE_MINUTES });
  expect(mockRetire).not.toHaveBeenCalled();
  expect(mockDeliver).toHaveBeenCalledTimes(1);
  const args = mockDeliver.mock.calls[0][0];
  expect(args).toMatchObject({
    key: OPS_KEY,
    subject: 'FIX: outside watchdog silent',
    headline: 'System — check the outside watchdog on the Air',
    summary: 'Its last poll was Thu, Sep 3 at 12:30 PM; the limit is 45 min.',
    audience: 'engineering',
    link: '/admin/agents?tab=queue',
    dedupeKey: OPS_KEY,
    refreshOnDedupe: true,
    fallOff: true,
  });
  // One standing row per episode: a window would split it into one row a day.
  expect(args).not.toHaveProperty('dedupeWindowMs');
  expect(args.metadata).toEqual({
    area: 'System',
    severity: 'broken',
    subject: { type: 'check', id: 'outside-watchdog' },
    doneWhen: 'watchdog_polling',
    who: 'claude',
    last_observed_at: last.toISOString(),
    limit_minutes: DEFAULT_STALE_MINUTES,
  });
  expect(args.text).toContain('com.waves.portal-watchdog');
  expect(args.text).toContain('ssh -tt adams-air railway login --browserless');
  expect(args.text).not.toMatch(/Hermes|Hostinger/);
  // The fallback has no email path: a lost row must fail the tick.
  await expect(args.sendEmail()).resolves.toMatchObject({ ok: false });
});

test('one silence episode writes the same words on every tick (no churn, no re-surface)', async () => {
  lastRow = { at: minutesBefore(90) };
  await runWatchdogLivenessCheck({ now: NOW });
  await runWatchdogLivenessCheck({ now: new Date(NOW.getTime() + 24 * 60 * 60000) });
  const [first, later] = mockDeliver.mock.calls.map(([a]) => a);
  for (const field of ['headline', 'summary', 'text', 'metadata', 'dedupeKey', 'link']) {
    expect(later[field]).toEqual(first[field]);
  }
});

test('never polled → the row says so; the env limit applies', async () => {
  process.env.HERMES_WATCHDOG_STALE_MINUTES = '20';
  const r = await runWatchdogLivenessCheck({ now: NOW });
  expect(r).toEqual({ skipped: false, silent: true, ageMinutes: null, limit: 20 });
  const args = mockDeliver.mock.calls[0][0];
  expect(args.summary).toBe('It has never polled the portal since its lane was turned on.');
  expect(args.metadata).toMatchObject({ last_observed_at: null, limit_minutes: 20 });
});

test('a row that did not land THROWS, so job_health marks this job failing', async () => {
  lastRow = { at: minutesBefore(90) };
  mockDeliver.mockResolvedValue({ ok: false, channel: 'email', error: 'the outside watchdog silent row has no email path' });
  await expect(runWatchdogLivenessCheck({ now: NOW })).rejects.toThrow('did not persist');
});
