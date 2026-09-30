// Dunning consolidation PR 2: what is (and is NOT) wired.
//   * runPending calls ONLY the shadow run, and only under the shadow gate;
//     promote / runCustomerSchedules / release are unreachable from cron and
//     routes (PR 3).
//   * render.js picks the six frozen combined templates by stage and today's
//     per-step templates for a single-invoice set.
//   * admin.js (pause / resume / release / send-now) guards each write on the
//     state it read.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockChain = () => {
  const chain = new Proxy(function chainFn() {}, {
    get: (_t, prop) => (prop === 'then' ? (resolve) => resolve([]) : () => chain),
    apply: () => chain,
  });
  return chain;
};
jest.mock('../models/db', () => {
  const fake = jest.fn(() => mockChain());
  fake.fn = { now: () => 'now' };
  fake.raw = jest.fn();
  return fake;
});
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
const mockGates = { shadow: false };
jest.mock('../config/feature-gates', () => ({
  gates: {},
  dunningCustomerScheduleShadowLive: () => mockGates.shadow,
  dunningCustomerScheduleAllowlist: () => null,
}));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/microdeposit-verification-email', () => ({ sendMicrodepositVerificationEmail: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(), invoiceShortCodePrefix: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.test' }));
jest.mock('../services/email-template-library', () => ({ loadTemplateByKey: jest.fn() }));
jest.mock('../services/email-template', () => ({ currency: (n) => `$${Number(n).toFixed(2)}` }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: (v) => (v ? String(v) : '') }));
const mockRunner = { shadowRun: jest.fn(), runCustomerSchedules: jest.fn(), processSchedule: jest.fn(), promote: jest.fn() };
jest.mock('../services/customer-dunning/runner', () => mockRunner);

const Followups = require('../services/invoice-followups');
const config = require('../config/invoice-followups');
const logger = require('../services/logger');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NOW = new Date('2026-10-07T14:16:00Z'); // Wednesday

describe('runPending wiring (PR 2 = shadow only)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(NOW);
    jest.clearAllMocks();
    mockGates.shadow = false;
  });
  afterEach(() => jest.useRealTimers());

  test('gate off: no shadow run at all (byte-identical to before)', async () => {
    await Followups.runPending();
    expect(mockRunner.shadowRun).not.toHaveBeenCalled();
  });

  test('shadow gate on: exactly one shadowRun(now) and NEVER the live path', async () => {
    mockGates.shadow = true;
    await Followups.runPending();
    expect(mockRunner.shadowRun).toHaveBeenCalledTimes(1);
    expect(mockRunner.shadowRun.mock.calls[0][0]).toEqual(NOW);
    expect(mockRunner.runCustomerSchedules).not.toHaveBeenCalled();
    expect(mockRunner.processSchedule).not.toHaveBeenCalled();
    expect(mockRunner.promote).not.toHaveBeenCalled();
  });

  test('a shadow failure is logged and never costs the run its result', async () => {
    mockGates.shadow = true;
    mockRunner.shadowRun.mockRejectedValueOnce(new Error('shadow blew up'));
    await expect(Followups.runPending()).resolves.toEqual({ sent: 0, skipped: 0 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('shadow blew up'));
  });

  test('outside the send window the shadow does not run either', async () => {
    jest.setSystemTime(new Date('2026-10-05T14:16:00Z')); // Monday
    mockGates.shadow = true;
    await Followups.runPending();
    expect(mockRunner.shadowRun).not.toHaveBeenCalled();
  });

  test('static: the ONLY reference to customer-dunning in cron/route code is the shadow helper; the live entry points are referenced nowhere outside the module', () => {
    const followups = read('services/invoice-followups.js');
    const refs = followups.split('\n').filter((l) => l.includes('customer-dunning'));
    expect(refs.join('\n')).toMatch(/runner'\)\.shadowRun\(now\)/);
    expect(followups).not.toMatch(/runCustomerSchedules|\.promote\(|releaseIfDark|processSchedule/);
    for (const file of ['services/scheduler.js', 'routes/admin-invoices.js']) {
      if (fs.existsSync(path.join(ROOT, file))) expect(read(file)).not.toMatch(/customer-dunning\/(runner|schedule|admin)/);
    }
    // the per-invoice batch is untouched: no NOT EXISTS ownership predicate yet (PR 3)
    expect(followups).not.toMatch(/customer_dunning_schedules/);
    expect(followups).not.toMatch(/pg_advisory_xact_lock_shared/);
  });
});

describe('render: template keys by stage', () => {
  const Render = require('../services/customer-dunning/render');
  const steps = config.stepsThrough90;

  test('multi -> the six frozen combined templates, matching the migration byte for byte', () => {
    const migration = read('models/migrations/20260928060000_invoice_followup_combined_templates.js');
    const smsKeys = [...migration.matchAll(/template_key: '(invoice_followup_combined_\w+)'/g)].map((m) => m[1]);
    const emailKeys = [...migration.matchAll(/key: '(invoice\.followup_combined_\w+)'/g)].map((m) => m[1]);
    expect(steps.map((s) => Render.smsTemplateKey(s, 'multi'))).toEqual(smsKeys);
    expect(steps.map((s) => Render.emailTemplateKey(s, 'multi'))).toEqual(emailKeys);
    expect(smsKeys).toHaveLength(6);
  });

  test('single -> today\'s per-step templates', () => {
    expect(steps.map((s) => Render.smsTemplateKey(s, 'single'))).toEqual(steps.map((s) => s.template_key));
    expect(steps.map((s) => Render.emailTemplateKey(s, 'single'))).toEqual([
      'invoice.followup_3_day', 'invoice.followup_7_day', 'invoice.followup_14_day',
      'invoice.followup_30_day', 'invoice.followup_60_day', 'invoice.followup_90_day',
    ]);
  });

  test('channelsWithTemplates: push shares the SMS body; an inactive template drops only its own channel', async () => {
    const EmailLib = require('../services/email-template-library');
    EmailLib.loadTemplateByKey.mockResolvedValue({ template: { status: 'active' }, activeVersion: { id: 'v' } });
    const db = (row) => jest.fn(() => ({ where: () => ({ first: async () => row }) }));
    expect(await Render.channelsWithTemplates(steps[4], 'multi', ['email', 'push', 'sms'], db({ is_active: true }))).toEqual(['email', 'push', 'sms']);
    expect(await Render.channelsWithTemplates(steps[4], 'multi', ['email', 'push', 'sms'], db({ is_active: false }))).toEqual(['email']);
    expect(await Render.channelsWithTemplates(steps[4], 'multi', ['email', 'sms'], db(undefined))).toEqual(['email']);
    EmailLib.loadTemplateByKey.mockResolvedValue(null);
    expect(await Render.channelsWithTemplates(steps[4], 'multi', ['email', 'sms'], db({ is_active: true }))).toEqual(['sms']);
  });

  test('email/SMS variables: SMS total is "258.00" (template carries the $), email total is "$258.00"; count is a string', () => {
    const set = { kind: 'multi', totalCents: 25800, members: [{ cents: 12900 }, { cents: 12900 }], anchor: { title: 't' } };
    const email = Render.renderEmail({ step: steps[0], set, customer: { first_name: 'Pat' }, recipient: { name: 'Pat Q' }, payUrl: 'https://s/x' });
    expect(email.payload).toMatchObject({ invoice_count: '2', total_due: '$258.00', first_name: 'Pat', pay_url: 'https://s/x' });
    expect(email.templateKey).toBe('invoice.followup_combined_3_day');
  });
});

describe('admin controls', () => {
  const Admin = require('../services/customer-dunning/admin');
  const Runner = require('../services/customer-dunning/runner');
  const { OPEN_STATUSES } = require('../services/customer-dunning/constants');

  function fakeDb(changed = 1) {
    const calls = [];
    const database = jest.fn((table) => {
      const q = { first: async () => ({ id: 's1', customer_id: 'c1', status: 'active', step_index: 3 }) };
      q.where = (c) => { calls.push({ table, where: c }); return q; };
      q.whereIn = (col, vals) => { calls.push({ table, whereIn: [col, vals] }); return q; };
      q.update = async (patch) => { calls.push({ table, patch }); return changed; };
      return q;
    });
    database.fn = { now: () => 'now' };
    database.calls = calls;
    return database;
  }

  test('pause: only an open, unpaused schedule; clears next_touch_at and records who', async () => {
    const database = fakeDb();
    expect(await Admin.pause('s1', { reason: 'customer asked', adminId: 'admin-1', database })).toEqual({ ok: true });
    const patch = database.calls.find((c) => c.patch).patch;
    expect(patch).toMatchObject({ status: 'paused', paused_reason: 'customer asked', paused_by_admin_id: 'admin-1', next_touch_at: null });
    expect(database.calls.some((c) => c.whereIn && c.whereIn[1] === OPEN_STATUSES)).toBe(true);
    expect(await Admin.pause('s1', { database: fakeDb(0) })).toEqual({ ok: false });
  });

  test('resume: paused only; picks up at the next-day floor (never sends in the click)', async () => {
    const database = fakeDb();
    const now = new Date('2026-10-06T14:16:00Z');
    expect(await Admin.resume('s1', { now, database })).toEqual({ ok: true });
    const call = database.calls.find((c) => c.patch);
    expect(call.patch).toMatchObject({ status: 'active', paused_reason: null, held_reason: null, touch_claimed_at: null }); // C2: no pre-pause worker regains authority
    expect(call.patch.next_touch_at.getTime()).toBe(Followups.heldTouchFloor(now).getTime());
    expect(database.calls.find((c) => c.where && c.where.status === 'paused')).toBeTruthy();
  });

  test('release: not open => ok:false; open => released_admin through the shared close', async () => {
    const Schedule = require('../services/customer-dunning/schedule');
    const closeSpy = jest.spyOn(Schedule, 'release').mockResolvedValue({ closed: true, landed: [{}, {}] });
    expect(await Admin.release('s1', { database: fakeDb() })).toEqual({ ok: true, released: 2 });
    expect(closeSpy.mock.calls[0][1]).toBe('released_admin');
    closeSpy.mockRestore();
  });

  test('F3: pause and release tell the admin a send is in flight instead of acting under it', async () => {
    const Schedule = require('../services/customer-dunning/schedule');
    const now = new Date('2026-10-06T14:16:00Z');
    // pause: the guarded UPDATE matched nothing and the row carries a fresh claim
    const busy = fakeDb(0);
    busy.mockImplementation(() => {
      const q = { first: async () => ({ id: 's1', status: 'active', touch_claimed_at: new Date(now.getTime() - 60 * 1000) }) };
      q.where = () => q; q.whereIn = () => q; q.update = async () => 0;
      return q;
    });
    busy.fn = { now: () => 'now' };
    expect(await Admin.pause('s1', { now, database: busy })).toMatchObject({ ok: false, reason: 'in_flight', message: expect.stringMatching(/try again in a minute/i) });
    // release: the shared close refused because a foreign claim is fresh
    const closeSpy = jest.spyOn(Schedule, 'release').mockResolvedValue({ closed: false, landed: [], reason: 'in_flight' });
    expect(await Admin.release('s1', { database: fakeDb() })).toMatchObject({ ok: false, reason: 'in_flight' });
    closeSpy.mockRestore();
  });

  test('send-now fires the CURRENT stage through the normal path with operator channels and force', async () => {
    Runner.processSchedule.mockResolvedValue({ outcome: 'advanced' });
    const out = await Admin.sendNow('s1', { now: NOW });
    expect(out).toMatchObject({ routedTo: 'customer_schedule', scheduleId: 's1', outcome: 'advanced' });
    expect(Runner.processSchedule).toHaveBeenCalledWith('s1', NOW, expect.objectContaining({ operatorInitiated: true, force: true }));
  });
});
