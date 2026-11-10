/**
 * Complaint-call alert: a call whose final label is complaint_escalated rings ONE Comms alert (it rang nothing
 * before). Pins the alert copy against the composer rules, every condition that must hold, the one-bell-per-call
 * dedupe shape, and the wiring in applyZeroTriageLayers. A full processRecording() run cannot be mocked end to
 * end (see call-out-of-area-hold.test.js), so the helpers are tested behaviorally and the wiring structurally.
 * Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'n1' })),
}));

const fs = require('fs');
const db = require('../models/db');
const logger = require('../services/logger');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
const { INTERNAL_TEST_CUSTOMER_IDS } = require('../services/internal-test-customers');
const { _test } = require('../services/call-recording-processor');

const { buildComplaintCallAlert, keepComplaintCallAlert } = _test;

const NOW = new Date('2026-11-09T18:30:00Z');
const CALL_ID = '11111111-2222-4333-8444-555555555555';
const CUSTOMER_ID = '99999999-2222-4333-8444-555555555555';
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000);
const callRow = (over = {}) => ({ id: CALL_ID, customer_id: CUSTOMER_ID, direction: 'inbound', source: null, duration_seconds: 120, created_at: minutesAgo(30), ...over });
const EXTRACTED = { first_name: 'Someone Else', pain_points: ['The technician never showed up'], call_summary: 'Customer says nobody came on Tuesday.' };
const args = (over = {}) => ({ written: true, disposition: 'complaint_escalated', call: callRow(), callSid: 'CA1', customerId: CUSTOMER_ID, extracted: EXTRACTED, now: NOW, ...over });

function primeCustomer(row = { first_name: 'Pat', last_name: 'Sample' }) {
  db.mockImplementation(() => {
    const b = { where: jest.fn(() => b), first: jest.fn(() => ({ catch: () => Promise.resolve(row) })) };
    return b;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  primeCustomer();
});

describe('buildComplaintCallAlert', () => {
  const build = (over = {}) => buildComplaintCallAlert({ call: callRow(), customerId: CUSTOMER_ID, name: 'Pat Sample', extracted: EXTRACTED, ...over });

  test('passes the composer rules, names the customer on file, quotes the complaint and carries the Call button', () => {
    const alert = build();
    const composed = composeAdminAlert(alert.spec);
    expect(alert.category).toBe('customer');
    expect(composed.headline).toBe('Comms — call Pat Sample about a complaint');
    expect(composed.why).toMatch(/^Complained on the \d{1,2}:\d{2} (AM|PM) call: “The technician never showed up”\.$/);
    expect(composed.why.length).toBeLessThanOrEqual(110);
    expect(composed.link).toBe(`/admin/communications#tab=calls&call=${CALL_ID}`);
    expect(composed.metadata).toMatchObject({
      area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'complaint_answered', contact: true, subject: { type: 'call', id: CALL_ID },
    });
    expect(composed.metadata.buttons).toMatchObject({ kind: 'call_back', items: [{ id: 'call', label: 'Call', args: { callLogId: CALL_ID } }] });
    expect(alert.opts).toMatchObject({
      bell: true, dedupeKey: `call-complaint:${CALL_ID}`, metadata: { callLogId: CALL_ID, customerId: CUSTOMER_ID, source: 'call_complaint' },
    });
    expect(alert.opts.detail).toContain('Pain points: The technician never showed up');
    expect(alert.opts.detail).toContain('Summary: Customer says nobody came on Tuesday.');
  });

  test('one bell per call, ever: no open-only dedupe and no refresh option', () => {
    const { opts } = build();
    for (const key of ['dedupeOpenOnly', 'refreshOnDedupe', 'bumpOnRefresh', 'ringOnRefresh', 'dedupeWindowMs']) expect(opts[key]).toBeUndefined();
  });

  test('no name on file reads "the customer"; the extraction\'s caller name is never used', () => {
    const composed = composeAdminAlert(build({ name: null }).spec);
    expect(composed.headline).toBe('Comms — call the customer about a complaint');
    expect(JSON.stringify(build({ name: null }))).not.toContain('Someone Else');
  });

  test('a long name still fits the 60-character headline', () => {
    const composed = composeAdminAlert(build({ name: 'Bartholomew Montgomery-Featherstonehaugh III' }).spec);
    expect(composed.headline.length).toBeLessThanOrEqual(60);
  });

  test('a phone number or street address in the complaint is masked, in the why and the detail', () => {
    const extracted = { pain_points: ['Call me at 941-555-0123 about 123 Main Street'], call_summary: 'Phone 941-555-0123 and 123 Main Street.' };
    const alert = build({ extracted });
    const composed = composeAdminAlert(alert.spec);
    expect(composed.why).not.toContain('555-0123');
    expect(alert.opts.detail).not.toContain('555-0123');
    expect(alert.opts.detail).not.toContain('123 Main Street');
  });

  test('with no pain points the call summary is the quote; a long quote is cut inside 110 characters', () => {
    const extracted = { call_summary: `Customer is upset ${'because the service was missed again and again '.repeat(5)}.` };
    const composed = composeAdminAlert(build({ extracted }).spec);
    expect(composed.why).toContain('“Customer is upset');
    expect(composed.why.length).toBeLessThanOrEqual(110);
  });

  test('words that would break the copy rules stay out of the why (kept in the detail); no words at all still composes', () => {
    const shouting = { pain_points: ['This is ridiculous!'], call_summary: 'Angry caller.' };
    const alert = build({ extracted: shouting });
    expect(composeAdminAlert(alert.spec).why).toMatch(/^Complained on the [\d:]+ [AP]M call\.$/);
    expect(alert.opts.detail).toContain('This is ridiculous!');
    expect(composeAdminAlert(build({ extracted: {} }).spec).why).toMatch(/call\.$/);
    expect(composeAdminAlert(build({ extracted: null }).spec).headline).toBe('Comms — call Pat Sample about a complaint');
  });

  test('a call id that is not a record id leaves the Call button off and still composes', () => {
    const alert = build({ call: callRow({ id: 'call-1' }) });
    expect(alert.spec.buttons).toBeUndefined();
    expect(composeAdminAlert(alert.spec).metadata.buttons).toBeUndefined();
  });
});

describe('keepComplaintCallAlert', () => {
  const rings = async (over) => {
    raiseAdminAlert.mockClear();
    await keepComplaintCallAlert(args(over));
    return raiseAdminAlert.mock.calls.length;
  };

  test('rings once when the label was written, with the name read from the customer record', async () => {
    expect(await rings()).toBe(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('customer');
    expect(spec.action).toBe('call Pat Sample about a complaint');
    expect(opts.metadata.customerId).toBe(CUSTOMER_ID);
  });

  test('the customer id comes from the pass, else from the call; neither means no alert', async () => {
    expect(await rings({ customerId: null })).toBe(1);
    expect(await rings({ customerId: null, call: callRow({ customer_id: null }) })).toBe(0);
  });

  test('every missing condition is silent: label not written by this pass, another label, internal test customer, sandbox call, old call', async () => {
    expect(await rings({ written: false })).toBe(0);
    expect(await rings({ disposition: 'existing_customer_routed' })).toBe(0);
    expect(await rings({ customerId: INTERNAL_TEST_CUSTOMER_IDS[0] })).toBe(0);
    expect(await rings({ call: callRow({ source: 'voice_relay_sandbox' }) })).toBe(0);
    expect(await rings({ call: callRow({ source: 'tech_voice' }) })).toBe(0);
    // Ended 25 hours ago (created, plus its length): a reprocess of an old call never rings.
    expect(await rings({ call: callRow({ created_at: minutesAgo(25 * 60) }) })).toBe(0);
    expect(await rings({ call: callRow({ created_at: undefined }) })).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('the window counts from the end of the call, not its start', async () => {
    // Started 24h30m ago, 1 hour long: it ended 23h30m ago.
    expect(await rings({ call: callRow({ created_at: minutesAgo(24 * 60 + 30), duration_seconds: 3600 }) })).toBe(1);
    expect(await rings({ call: callRow({ created_at: minutesAgo(24 * 60 + 90), duration_seconds: 3600 }) })).toBe(0);
  });

  test('a voicemail is not skipped: its own callback bell does not always ring', async () => {
    expect(await rings({ extracted: { ...EXTRACTED, is_voicemail: true } })).toBe(1);
  });

  test('a reprocess raises the same key again with no open-only option, so the bell table keeps one row', async () => {
    await keepComplaintCallAlert(args());
    await keepComplaintCallAlert(args());
    const [first, second] = raiseAdminAlert.mock.calls.map((c) => c[2]);
    expect(first.dedupeKey).toBe(`call-complaint:${CALL_ID}`);
    expect(second.dedupeKey).toBe(first.dedupeKey);
    expect(second.dedupeOpenOnly).toBeUndefined();
    expect(second.refreshOnDedupe).toBeUndefined();
  });

  test('a failed name lookup keeps the alert; a failed raise never throws and logs a code only', async () => {
    db.mockImplementation(() => {
      const b = { where: jest.fn(() => b), first: jest.fn(() => ({ catch: (fn) => Promise.resolve(fn(new Error('db down'))) })) };
      return b;
    });
    expect(await rings()).toBe(1);
    expect(raiseAdminAlert.mock.calls[0][1].action).toBe('call the customer about a complaint');
    raiseAdminAlert.mockRejectedValueOnce(Object.assign(new Error('bell down for +19415550123'), { code: 'ECONNRESET' }));
    await expect(keepComplaintCallAlert(args())).resolves.toBeNull();
    const logged = logger.warn.mock.calls.at(-1)[0];
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain('555');
  });
});

describe('wiring', () => {
  const src = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  test('applyZeroTriageLayers hands the written flag and the label to the alert right after the label write, no new branch', () => {
    const write = src.indexOf('const written = await writeCallDisposition({ callId: call.id, disposition, reason, callSid });');
    expect(write).toBeGreaterThan(0);
    const next = src.slice(write, write + 400).split('\n')[1].trim();
    expect(next).toBe('await keepComplaintCallAlert({ written, disposition, call, callSid, customerId, extracted });');
  });

  test('the alert sends nothing to a customer and has no gate of its own', () => {
    const start = src.indexOf('function buildComplaintCallAlert(');
    const end = src.indexOf('const CallRecordingProcessor = {');
    const block = src.slice(start, end);
    expect(block).not.toMatch(/sendCustomerMessage|sendSMS|isEnabled\(|GATE_/);
    expect(block).not.toContain('notifyAdmin(');
  });
});
