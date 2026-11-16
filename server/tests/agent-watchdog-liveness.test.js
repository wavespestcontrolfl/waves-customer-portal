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
const { runWatchdogLivenessCheck: runCheck, DEFAULT_STALE_MINUTES, OPS_KEY, OPS_INBOX } = require('../services/agent-watchdog-liveness');

// The episode store (system_settings in production) as a plain value that outlives
// a "restart": each test gets a fresh one.
let store;
const newStore = () => { let v = null; return { get: jest.fn(async () => v), set: jest.fn(async (x) => { v = x; }) }; };
const runWatchdogLivenessCheck = (opts = {}) => runCheck({ store, ...opts });

const mockMailer = { isConfigured: jest.fn(() => true), sendOne: jest.fn(async () => ({ ok: true })) };

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
  store = newStore();
  mockMailer.isConfigured.mockReturnValue(true);
  mockMailer.sendOne.mockResolvedValue({ ok: true });
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
  const r = await runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer });
  expect(r).toEqual({ skipped: false, silent: true, ageMinutes: 90, limit: DEFAULT_STALE_MINUTES, channel: 'in_app' });
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
  // The fallback emails the office inbox once per episode, never a customer.
  await expect(args.sendEmail()).resolves.toMatchObject({ ok: true });
  expect(mockMailer.sendOne).toHaveBeenCalledTimes(1);
  expect(mockMailer.sendOne.mock.calls[0][0]).toMatchObject({ to: OPS_INBOX, subject: 'FIX: outside watchdog silent', text: args.text });
  await expect(args.sendEmail()).resolves.toMatchObject({ ok: true, skipped: 'already emailed this episode' });
  expect(mockMailer.sendOne).toHaveBeenCalledTimes(1);
});

test('digest gates off -> the email fallback reports the silence; the tick does not fail (Codex r7 P2)', async () => {
  lastRow = { at: minutesBefore(90) };
  mockDeliver.mockImplementation(async ({ sendEmail }) => {
    const result = await sendEmail();
    return { ok: result.ok !== false, channel: 'email', result };
  });
  const r = await runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer });
  expect(r).toMatchObject({ silent: true, channel: 'email' });
  expect(mockMailer.sendOne).toHaveBeenCalledTimes(1);
  // Same episode on the next tick: no second email, still a healthy tick.
  await expect(runWatchdogLivenessCheck({ now: new Date(NOW.getTime() + 23 * 60000), mailer: mockMailer })).resolves.toMatchObject({ channel: 'email' });
  expect(mockMailer.sendOne).toHaveBeenCalledTimes(1);
  // A new episode (a later last poll) emails again.
  lastRow = { at: minutesBefore(50, new Date(NOW.getTime() + 600 * 60000)) };
  await runWatchdogLivenessCheck({ now: new Date(NOW.getTime() + 600 * 60000), mailer: mockMailer });
  expect(mockMailer.sendOne).toHaveBeenCalledTimes(2);
});

test('an emailed silence gets one closing email when polling resumes; a failed send retries (Codex r10 P2)', async () => {
  lastRow = { at: minutesBefore(90) };
  mockDeliver.mockImplementation(async ({ sendEmail }) => {
    const result = await sendEmail();
    return { ok: result.ok !== false, channel: 'email', result };
  });
  await runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer });
  expect(mockMailer.sendOne).toHaveBeenCalledTimes(1);
  lastRow = { at: minutesBefore(5) };
  mockMailer.sendOne.mockResolvedValueOnce({ ok: false, error: 'smtp' });
  await expect(runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer })).resolves.toMatchObject({ silent: false, closingEmail: 'failed' });
  await expect(runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer })).resolves.toMatchObject({ silent: false, closingEmail: 'sent' });
  expect(mockMailer.sendOne).toHaveBeenCalledTimes(3);
  expect(mockMailer.sendOne.mock.calls[2][0]).toMatchObject({ to: OPS_INBOX, subject: 'Outside watchdog polling again' });
  // Closed: the next fresh tick sends nothing.
  const r = await runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer });
  expect(r).not.toHaveProperty('closingEmail');
  expect(mockMailer.sendOne).toHaveBeenCalledTimes(3);
});

test('the emailed episode survives a restart: the closing email still goes (Codex r11 P2)', async () => {
  lastRow = { at: minutesBefore(90) };
  mockDeliver.mockImplementation(async ({ sendEmail }) => {
    const result = await sendEmail();
    return { ok: result.ok !== false, channel: 'email', result };
  });
  await runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer });
  expect(store.set).toHaveBeenCalledWith(minutesBefore(90).toISOString());
  // A restart: the module is loaded fresh; only the stored value carries over.
  let fresh;
  jest.isolateModules(() => { fresh = require('../services/agent-watchdog-liveness'); });
  lastRow = { at: minutesBefore(5) };
  await expect(fresh.runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer, store })).resolves.toMatchObject({ closingEmail: 'sent' });
  expect(store.set).toHaveBeenLastCalledWith(null);
});

test('a row-only silence sends no closing email', async () => {
  lastRow = { at: minutesBefore(90) };
  await runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer });
  lastRow = { at: minutesBefore(5) };
  const r = await runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer });
  expect(r).not.toHaveProperty('closingEmail');
  expect(mockMailer.sendOne).not.toHaveBeenCalled();
});

test('digest gates off and the mailer is not configured -> THROWS, so job_health marks the job failing', async () => {
  lastRow = { at: minutesBefore(90) };
  mockMailer.isConfigured.mockReturnValue(false);
  mockDeliver.mockImplementation(async ({ sendEmail }) => {
    const result = await sendEmail();
    return { ok: result.ok !== false, channel: 'email', result };
  });
  await expect(runWatchdogLivenessCheck({ now: NOW, mailer: mockMailer })).rejects.toThrow('did not persist');
  expect(mockMailer.sendOne).not.toHaveBeenCalled();
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
  expect(r).toEqual({ skipped: false, silent: true, ageMinutes: null, limit: 20, channel: 'in_app' });
  const args = mockDeliver.mock.calls[0][0];
  expect(args.summary).toBe('It has never polled the portal since its lane was turned on.');
  expect(args.metadata).toMatchObject({ last_observed_at: null, limit_minutes: 20 });
});

test('a row that did not land THROWS, so job_health marks this job failing', async () => {
  lastRow = { at: minutesBefore(90) };
  mockDeliver.mockResolvedValue({ ok: false, channel: 'email', error: 'mailer not configured' });
  await expect(runWatchdogLivenessCheck({ now: NOW })).rejects.toThrow('did not persist');
});
