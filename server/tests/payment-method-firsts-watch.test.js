// payment-method-firsts-watch — one ops email per "first", persisted marker,
// self-retiring, never marks a first the email failed to deliver.

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: () => 'NOW()' };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email', () => ({ send: jest.fn(async () => ({ ok: true })) }));

const db = require('../models/db');
const email = require('../services/email');
const { runPaymentMethodFirstsWatch, MARKER_PREFIX, OPS_TO } = require('../services/payment-method-firsts-watch');

let state;

function builderFor(table) {
  const b = {};
  const conds = [];
  const rows = () => (state[table] || []).filter((r) => conds.every((c) => c(r)));
  b.where = jest.fn((criteria) => {
    if (typeof criteria === 'object' && criteria !== null) {
      Object.entries(criteria).forEach(([k, v]) => conds.push((r) => r[k] === v));
    }
    return b;
  });
  b.whereIn = jest.fn((col, vals) => { conds.push((r) => vals.includes(r[col])); return b; });
  b.whereRaw = jest.fn((_sql, [templateKey]) => {
    conds.push((r) => {
      try { return JSON.parse(r.metadata).template_key === templateKey; } catch { return false; }
    });
    return b;
  });
  b.orderBy = jest.fn(() => b);
  b.select = jest.fn(() => b);
  b.first = jest.fn(async () => rows()[0] || null);
  b.insert = jest.fn(async (row) => { (state[table] = state[table] || []).push(row); return [1]; });
  b.update = jest.fn(async (vals) => { rows().forEach((r) => Object.assign(r, vals)); return rows().length; });
  b.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
  return b;
}

const interaction = (templateKey, extra = {}) => ({
  customer_id: 'cust-9', interaction_type: 'email_outbound', created_at: '2026-08-28T13:00:00.000Z',
  metadata: JSON.stringify({ template_key: templateKey, status: 'sent', payment_method_id: 'pm-9', provider_message_id: 'sg-1', ...extra }),
});

beforeEach(() => {
  delete process.env.PM_GUARD_FIRSTS_WATCH;
  state = { autopay_log: [], customer_interactions: [], system_settings: [] };
  db.mockClear();
  db.mockImplementation((table) => builderFor(table));
  email.send.mockClear();
  email.send.mockImplementation(async () => ({ ok: true }));
});

test('nothing happened yet → no email, no markers', async () => {
  const res = await runPaymentMethodFirstsWatch();
  expect(res).toEqual({ reported: [] });
  expect(email.send).not.toHaveBeenCalled();
  expect(state.system_settings).toEqual([]);
});

test('first refusal → one ops email with the ids, marker persisted, no repeat on the next tick', async () => {
  state.autopay_log.push({ event_type: 'removal_refused', customer_id: 'cust-1', payment_method_id: 'pm-live', details: JSON.stringify({ source: 'portal_delete', paused: true }), created_at: '2026-08-28T12:00:00.000Z' });
  const res = await runPaymentMethodFirstsWatch();
  expect(res).toEqual({ reported: ['removal_refused'] });
  expect(email.send).toHaveBeenCalledTimes(1);
  expect(email.send).toHaveBeenCalledWith(expect.objectContaining({
    to: OPS_TO,
    subject: expect.stringMatching(/^FIRST: First portal removal refused/),
    body: expect.stringContaining('customer_id: cust-1'),
  }));
  expect(email.send.mock.calls[0][0].body).toContain('paused: yes');
  expect(state.system_settings).toEqual([expect.objectContaining({ key: `${MARKER_PREFIX}removal_refused`, value: '2026-08-28T12:00:00.000Z' })]);

  email.send.mockClear();
  const again = await runPaymentMethodFirstsWatch();
  expect(again).toEqual({ reported: [] });
  expect(email.send).not.toHaveBeenCalled();
});

test('each lifecycle email first is matched by template_key and reported with its status', async () => {
  state.customer_interactions.push(interaction('payment.method_removed', { status: 'blocked', failure_reason: 'missing_email' }));
  state.customer_interactions.push(interaction('payment.autopay_disabled'));
  const res = await runPaymentMethodFirstsWatch();
  expect(res.reported.sort()).toEqual(['autopay_disabled_email', 'method_removed_email']);
  const bodies = email.send.mock.calls.map((c) => c[0].body).join('\n');
  expect(bodies).toContain('status: blocked (missing_email)');
  expect(bodies).toContain('status: sent');
});

test('an undelivered ops email leaves the first unmarked so the next tick retries', async () => {
  state.autopay_log.push({ event_type: 'removal_refused', customer_id: 'cust-1', payment_method_id: 'pm-live', details: '{}', created_at: '2026-08-28T12:00:00.000Z' });
  email.send.mockImplementation(async () => ({ ok: false, error: 'smtp down' }));
  const res = await runPaymentMethodFirstsWatch();
  expect(res).toEqual({ reported: [] });
  expect(state.system_settings).toEqual([]);
});

test('all three reported → the watch retires (no reads of the watched tables)', async () => {
  state.system_settings = ['removal_refused', 'autopay_disabled_email', 'method_removed_email']
    .map((n) => ({ key: `${MARKER_PREFIX}${n}`, value: 'x' }));
  const res = await runPaymentMethodFirstsWatch();
  expect(res).toEqual({ retired: true });
  expect(db).not.toHaveBeenCalledWith('autopay_log');
  expect(db).not.toHaveBeenCalledWith('customer_interactions');
});

test('kill switch PM_GUARD_FIRSTS_WATCH=off → no-op', async () => {
  process.env.PM_GUARD_FIRSTS_WATCH = 'off';
  state.autopay_log.push({ event_type: 'removal_refused', customer_id: 'c', created_at: '2026-08-28T12:00:00.000Z' });
  const res = await runPaymentMethodFirstsWatch();
  expect(res).toEqual({ skipped: true, reason: 'kill_switch' });
  expect(email.send).not.toHaveBeenCalled();
});

test('the scheduler registers the tick on the canary cadence under runExclusive', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
  expect(src).toMatch(/runExclusive\('pm-guard-firsts-watch', \(\) => require\('\.\/payment-method-firsts-watch'\)\.runPaymentMethodFirstsWatch\(\)\)/);
  expect(src).toMatch(/cron\.schedule\('49 \*\/6 \* \* \*', pmGuardFirstsTick, \{ timezone: 'America\/New_York' \}\)/);
});
