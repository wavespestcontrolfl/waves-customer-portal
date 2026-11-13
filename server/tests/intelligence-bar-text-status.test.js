// get_customer_text_status (gap #23): "why is this customer not getting texts?" Read only.
// The per-type answer must come from the send path's own validators, so they are
// the seam here: this suite checks what the tool does with their verdicts and
// with its three side reads. The real validators against real rows are in
// intelligence-bar-text-status-postgres.test.js. Synthetic names only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/validators/consent', () => ({ loadContactState: jest.fn(), checkConsentForPurpose: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({ loadSuppressionState: jest.fn(), checkSuppression: jest.fn() }));

const db = require('../models/db');
const consent = require('../services/messaging/validators/consent');
const suppression = require('../services/messaging/validators/suppression');
const { COMMS_TOOLS, COMMS_READ_TOOLS, executeCommsTool } = require('../services/intelligence-bar/comms-tools');
const { TEXT_TYPES } = require('../services/customer-text-status');
const propertyPrefs = require('../services/property-notification-prefs');
const policy = require('../services/intelligence-bar/action-policy.json');

const CUSTOMER_ID = '11111111-2222-4333-8444-555555555555';
const VISIT_ID = '99999999-2222-4333-8444-555555555555';
const customer = (over = {}) => ({ id: CUSTOMER_ID, first_name: 'Fixture', last_name: 'Texts', phone: '+12025550143', account_id: null, is_primary_profile: true, ...over });

// A knex stand-in: every builder call returns the chain, awaiting it (or .first()) answers from `answer(table, calls)`.
function fakeDb(answer) {
  const queries = [];
  db.mockImplementation((table) => {
    const calls = [];
    queries.push({ table, calls });
    const rows = () => Promise.resolve().then(() => answer(table, calls));
    const chain = new Proxy({}, {
      get(_target, method) {
        if (method === 'then') return (resolve, reject) => rows().then(resolve, reject);
        if (method === 'first') return () => rows().then((result) => (Array.isArray(result) ? result[0] : result));
        return (...args) => { calls.push([method, ...args]); return chain; };
      },
    });
    return chain;
  });
  return queries;
}
const statusesOf = (calls) => (calls.find(([method, column]) => method === 'whereIn' && column === 'sms_log.status') || [])[2] || [];

function tables({ customerRow = customer(), visit = { id: VISIT_ID, scheduled_date: '2099-03-04', property_id: null }, blocked = [], undelivered = [], lastSent = [] } = {}) {
  return fakeDb((table, calls) => {
    if (table === 'customers') return [customerRow];
    if (table === 'scheduled_services') return visit ? [visit] : [];
    if (table === 'messaging_audit_log') return blocked;
    if (table === 'sms_log') return statusesOf(calls).includes('delivered') ? lastSent : undelivered;
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  consent.loadContactState.mockResolvedValue({ prefs: { sms_enabled: true }, customer: { id: CUSTOMER_ID }, propertyToggles: null });
  suppression.loadSuppressionState.mockImplementation(async (_input, state) => ({ ...state, suppressionLoaded: true }));
  suppression.checkSuppression.mockResolvedValue({ ok: true });
  consent.checkConsentForPurpose.mockResolvedValue({ ok: true });
});

test('registered as a record-scope READ tool on every admin page, with a typed customer_id', () => {
  const tool = COMMS_TOOLS.find((t) => t.name === 'get_customer_text_status');
  expect(tool.input_schema.properties.customer_id.format).toBe('uuid');
  expect(COMMS_READ_TOOLS.map((t) => t.name)).toContain('get_customer_text_status');
  expect(policy.get_customer_text_status).toMatchObject({ kind: 'read', scope: 'record', approval: null });
});

test('asks the send path validators once per text type, for the customer\'s number, and never through the path that writes', async () => {
  tables();
  const out = await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(out.text_types.map((t) => t.type)).toEqual(TEXT_TYPES.map(([type]) => type));
  expect(out.text_types.every((t) => t.allowed === true)).toBe(true);
  expect(consent.checkConsentForPurpose).toHaveBeenCalledTimes(TEXT_TYPES.length);
  const [input, sendPolicy] = consent.checkConsentForPurpose.mock.calls.find(([i]) => i.purpose === 'appointment_reminder_72h');
  expect(input).toMatchObject({ audience: 'customer', channel: 'sms', customerId: CUSTOMER_ID, to: '+12025550143' });
  expect(sendPolicy.prefsColumn).toBe('service_reminder_72h');
  // An appointmentId makes loadContactState resolve the visit's property through resolveAppointmentPrefs, which writes
  // the senders' decision log. A read-only tool must never pass one.
  for (const [loaded] of [...consent.loadContactState.mock.calls, ...consent.checkConsentForPurpose.mock.calls]) expect(loaded.appointmentId).toBeUndefined();
  expect(out).toMatchObject({
    customer_id: CUSTOMER_ID, customer_name: 'Fixture Texts', phone_last4: '…0143', additional_property_profile: false,
    opted_out_of_all_texts: false, do_not_text_list: null, checked_for_visit: { service_id: VISIT_ID, date: '2099-03-04' },
    appointment_text_recipients: [{ role: 'primary', phone_last4: '…0143' }],
    recent_blocked: [], recent_not_delivered: [], last_text_sent: null, window_days: 60,
  });
});

test('a text type switched off reads blocked with a plain reason; the others stay allowed', async () => {
  tables({ customerRow: customer({ account_id: 'acct-1', is_primary_profile: false }) });
  const off = new Set(['appointment_confirmation', 'appointment_reminder_72h', 'appointment_reminder_24h', 'tech_en_route', 'tech_arrived']);
  consent.checkConsentForPurpose.mockImplementation(async (input) => (off.has(input.purpose)
    ? { ok: false, code: 'PURPOSE_OPTED_OUT', reason: 'Recipient has disabled the "x" notification type' } : { ok: true }));
  const out = await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(out.additional_property_profile).toBe(true);
  expect(out.additional_property_note).toMatch(/five appointment texts/);
  expect(out.text_types.filter((t) => t.allowed === false).map((t) => t.type)).toEqual([...off]);
  expect(out.text_types.find((t) => t.type === 'tech_en_route')).toMatchObject({
    allowed: false, code: 'PURPOSE_OPTED_OUT', reason: 'This text type is switched off in the customer\'s notification settings.',
  });
  expect(out.text_types.find((t) => t.type === 'payment_receipt').allowed).toBe(true);
});

test('a STOP and a do-not-text row are named; an unknown code keeps the validator\'s own reason', async () => {
  tables();
  consent.loadContactState.mockResolvedValue({ prefs: { sms_enabled: false }, customer: { id: CUSTOMER_ID }, propertyToggles: null });
  suppression.loadSuppressionState.mockImplementation(async (_input, state) => ({
    ...state, suppressionLoaded: true, suppression: { reason: 'opt_out_keyword', created_at: '2026-01-02T03:04:05Z', source: 'twilio_webhook_STOP', captured_body: 'STOP' },
  }));
  suppression.checkSuppression.mockImplementation(async (input) => (input.purpose === 'billing'
    ? { ok: false, code: 'SOME_NEW_CODE', reason: 'a reason the tool has no words for' }
    : { ok: false, code: 'SUPPRESSED_OPT_OUT', reason: 'Recipient is suppressed' }));
  const out = await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(out.opted_out_of_all_texts).toBe(true);
  expect(out.do_not_text_list).toEqual({ reason: 'opt_out_keyword', since: '2026-01-02T03:04:05.000Z', source: 'twilio_webhook_STOP' });
  expect(JSON.stringify(out)).not.toContain('captured_body');
  expect(out.text_types.find((t) => t.type === 'conversational')).toMatchObject({ allowed: false, code: 'SUPPRESSED_OPT_OUT', reason: expect.stringMatching(/do-not-text list/) });
  expect(out.text_types.find((t) => t.type === 'billing')).toMatchObject({ allowed: false, code: 'SOME_NEW_CODE', reason: 'a reason the tool has no words for' });
  // The suppression check runs first: a blocked number never reaches the consent check.
  expect(consent.checkConsentForPurpose).not.toHaveBeenCalled();
});

test('a visit at a saved property: its toggles decide when the property rule is enforced, read without the decision log', async () => {
  const visit = { id: VISIT_ID, scheduled_date: '2099-03-04', property_id: 'prop-1' };
  const enforced = jest.spyOn(propertyPrefs, 'propertyTextsEnforced');
  const load = jest.spyOn(propertyPrefs, 'loadVisitProperties');
  const resolve = jest.spyOn(propertyPrefs, 'resolveAppointmentPrefs');

  // Not enforced (shadow mode): the customer row decides and the property is not read at all.
  tables({ visit });
  enforced.mockReturnValue(false);
  await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(load).not.toHaveBeenCalled();
  expect(consent.checkConsentForPurpose.mock.calls[0][2].propertyToggles).toBeNull();

  // Enforced: a rental's five appointment toggles (off by default) are laid over the customer row.
  jest.clearAllMocks();
  tables({ visit });
  enforced.mockReturnValue(true);
  load.mockResolvedValue(new Map([[VISIT_ID, { property: { id: 'prop-1', relationship: 'rental_owned' }, row: undefined }]]));
  await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(load).toHaveBeenCalledWith(db, [{ id: VISIT_ID, customer_id: CUSTOMER_ID, property_id: 'prop-1' }]);
  expect(consent.checkConsentForPurpose.mock.calls[0][2].propertyToggles).toMatchObject({ sms_enabled: true, tech_en_route: false, service_reminder_72h: false });
  expect(resolve).not.toHaveBeenCalled();

  // Unreadable under enforcement: the senders hold the text, so the state says the lookup failed and recipients are unknown.
  jest.clearAllMocks();
  tables({ visit });
  load.mockRejectedValue(new Error('read failed'));
  const out = await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(consent.checkConsentForPurpose.mock.calls[0][2].lookupFailed).toBe(true);
  expect(out.appointment_text_recipients).toBe('unavailable');
});

test('a do-not-text list that could not be read is "could not check", not "allowed"', async () => {
  // The REAL loader and validator: the loader swallows a failed read and the validator then fails open for a text.
  const actual = jest.requireActual('../services/messaging/validators/suppression');
  suppression.loadSuppressionState.mockImplementation(actual.loadSuppressionState);
  suppression.checkSuppression.mockImplementation(actual.checkSuppression);
  fakeDb((table) => {
    if (table === 'customers') return [customer()];
    if (table === 'messaging_suppression') throw new Error('connection reset');
    return [];
  });
  const out = await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(out.do_not_text_list).toBe('unavailable');
  expect(out.text_types).toHaveLength(TEXT_TYPES.length);
  expect(out.text_types.every((t) => t.allowed === null && t.note === 'Could not check this right now.')).toBe(true);
  expect(consent.checkConsentForPurpose).not.toHaveBeenCalled();
});

test('a failed lookup is "could not check", never a block on the customer', async () => {
  tables();
  consent.checkConsentForPurpose.mockResolvedValue({ ok: false, code: 'CONSENT_LOOKUP_FAILED', reason: 'retry advised' });
  const out = await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(out.text_types.every((t) => t.allowed === null && !t.code)).toBe(true);
});

test('lists the blocked sends, the undelivered texts and the last sent text; a quiet-hours hold is left out in the query', async () => {
  const queries = tables({
    blocked: [{ created_at: '2026-10-30T12:00:00Z', purpose: 'autopay', blocked_code: 'PROVIDER_FAILURE', blocked_reason: 'provider said no' },
      { created_at: '2026-10-29T12:00:00Z', purpose: 'tech_en_route', blocked_code: 'SMS_OPTED_OUT', blocked_reason: 'sms_enabled=false' }],
    undelivered: [{ created_at: '2026-10-28T12:00:00Z', message_type: 'reminder', status: 'undelivered' }],
    lastSent: [{ created_at: '2026-10-27T12:00:00Z', message_type: 'receipt', status: 'delivered' }],
  });
  const out = await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(out.recent_blocked).toEqual([
    { time: '2026-10-30T12:00:00.000Z', type: 'autopay', code: 'PROVIDER_FAILURE', reason: 'provider said no' },
    { time: '2026-10-29T12:00:00.000Z', type: 'tech_en_route', code: 'SMS_OPTED_OUT', reason: 'The customer opted out of all texts (STOP).' },
  ]);
  expect(out.recent_not_delivered).toEqual([{ time: '2026-10-28T12:00:00.000Z', type: 'reminder', status: 'undelivered' }]);
  expect(out.last_text_sent).toEqual({ time: '2026-10-27T12:00:00.000Z', type: 'receipt', status: 'delivered' });
  const audit = queries.find((q) => q.table === 'messaging_audit_log').calls;
  expect(audit).toContainEqual(['where', { customer_id: CUSTOMER_ID, channel: 'sms' }]);
  expect(audit).toContainEqual(['whereNotIn', 'blocked_code', ['QUIET_HOURS_HOLD']]);
  // Both sms_log reads are one customer's outbound rows.
  for (const q of queries.filter((entry) => entry.table === 'sms_log')) {
    expect(q.calls).toContainEqual(['where', { 'sms_log.customer_id': CUSTOMER_ID, 'sms_log.direction': 'outbound' }]);
  }
});

test('an unreadable side table says "unavailable" and keeps the rest of the answer', async () => {
  fakeDb((table) => {
    if (table === 'customers') return [customer()];
    if (table === 'scheduled_services') return [];
    throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
  });
  const out = await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(out).toMatchObject({ recent_blocked: 'unavailable', recent_not_delivered: 'unavailable', last_text_sent: 'unavailable', checked_for_visit: null });
  expect(out.text_types).toHaveLength(TEXT_TYPES.length);
});

test('no phone on file: says so and runs no check', async () => {
  tables({ customerRow: customer({ phone: null }) });
  const out = await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID });
  expect(out).toMatchObject({ customer_id: CUSTOMER_ID, no_phone: true });
  expect(out.text_types).toBeUndefined();
  expect(consent.loadContactState).not.toHaveBeenCalled();
});

test('an unknown customer and an ambiguous name answer like the other comms reads', async () => {
  fakeDb(() => []);
  expect(await executeCommsTool('get_customer_text_status', { customer_id: CUSTOMER_ID })).toEqual({ error: 'Customer not found' });
  fakeDb(() => [customer(), customer({ id: 'other', last_name: 'Other' })]);
  const out = await executeCommsTool('get_customer_text_status', { customer_name: 'Fixture' });
  expect(out).toMatchObject({ ambiguous: true });
  expect(out.candidates).toHaveLength(2);
  expect(consent.loadContactState).not.toHaveBeenCalled();
});
