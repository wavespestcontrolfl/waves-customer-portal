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
// The validated V2 extraction the composer reads: meta.call_summary and sentiment_and_lead.objections_raised.
const v2 = (objections, summary) => ({ meta: { call_summary: summary }, sentiment_and_lead: { objections_raised: objections } });
const V2 = v2(['The technician never showed up'], 'Customer says nobody came on Tuesday.');
// The V1 flat view of the same call, disagreeing with V2: the composer must never read it.
const V1_TEXT = { first_name: 'Someone Else', pain_points: 'Old V1 pain point about billing', call_summary: 'Old V1 summary about an invoice.' };
const GENERATION = 3;
const args = (over = {}) => ({ written: true, disposition: 'complaint_escalated', call: callRow(), callSid: 'CA1', customerId: CUSTOMER_ID, v2Extraction: V2, procGeneration: GENERATION, now: NOW, ...over });

// customers: the name lookup, on the plain connection (`.first().catch()`). call_log: the ownership check, which must run
// ONLY on the transaction, with a row lock, against `callState` (the row as it stands at the moment of the locked read;
// null = no row). `beforeLock` runs after the pre-transaction reads and before the transaction opens: a force-reprocess
// landing in that gap changes `callState` there. A where object filters the state like Postgres would.
let callState;
let fenceQueries;
let outsideCallLogReads;
let fakeTrx;
function primeDb({ customer = { first_name: 'Pat', last_name: 'Sample' }, fenceFails = false, beforeLock = null } = {}) {
  callState = { id: CALL_ID, processing_generation: GENERATION, disposition: 'complaint_escalated' };
  fenceQueries = [];
  outsideCallLogReads = 0;
  const builder = (table, onFirst) => {
    const q = { table, wheres: [], locked: false };
    const b = {
      where: jest.fn((w) => { q.wheres.push(w); return b; }),
      forUpdate: jest.fn(() => { q.locked = true; return b; }),
      first: jest.fn(() => onFirst(q)),
    };
    return b;
  };
  fakeTrx = Object.assign(
    jest.fn((table) => builder(table, (q) => {
      fenceQueries.push(q);
      if (fenceFails) return Promise.reject(new Error('db down'));
      const matches = callState && q.wheres.every((w) => Object.entries(w).every(([k, v]) => callState[k] === v));
      return Promise.resolve(matches ? { id: callState.id } : undefined);
    })),
    { raw: jest.fn(async () => ({})) },
  );
  db.transaction = jest.fn(async (cb) => cb(fakeTrx));
  db.mockImplementation((table) => builder(table, () => {
    if (table === 'call_log') { outsideCallLogReads += 1; return Promise.resolve(undefined); }
    if (beforeLock) beforeLock();
    return { catch: () => Promise.resolve(customer) };
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  primeDb();
});

describe('buildComplaintCallAlert', () => {
  const build = (over = {}) => buildComplaintCallAlert({ call: callRow(), customerId: CUSTOMER_ID, name: 'Pat Sample', v2Extraction: V2, now: NOW, ...over });

  test('passes the composer rules, names the customer on file, quotes the complaint and carries the Call button', () => {
    const alert = build();
    const composed = composeAdminAlert(alert.spec);
    expect(alert.category).toBe('customer');
    expect(composed.headline).toBe('Comms — call Pat Sample about a complaint');
    expect(composed.why).toBe('Complained on today\'s call: “The technician never showed up”.');
    expect(composed.why.length).toBeLessThanOrEqual(110);
    expect(composed.link).toBe(`/admin/communications#tab=calls&call=${CALL_ID}`);
    expect(composed.metadata).toMatchObject({
      area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'complaint_answered', contact: true, subject: { type: 'call', id: CALL_ID },
    });
    expect(composed.metadata.buttons).toMatchObject({ kind: 'call_back', items: [{ id: 'call', label: 'Call', args: { callLogId: CALL_ID } }] });
    expect(alert.opts).toMatchObject({
      bell: true, dedupeKey: `call-complaint:${CALL_ID}`, metadata: { callLogId: CALL_ID, customerId: CUSTOMER_ID, source: 'call_complaint' },
    });
    expect(alert.opts.detail).toMatch(/^The call at \d{1,2}:\d{2} (AM|PM) ET was labeled a complaint/);
    expect(alert.opts.detail).toContain('Objections raised: The technician never showed up');
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
    const alert = build({ v2Extraction: v2(['Call me at 941-555-0123 about 123 Main Street'], 'Phone 941-555-0123 and 123 Main Street.') });
    const composed = composeAdminAlert(alert.spec);
    expect(composed.why).not.toContain('555-0123');
    expect(alert.opts.detail).not.toContain('555-0123');
    expect(alert.opts.detail).not.toContain('123 Main Street');
  });

  test('with no pain points the call summary is the quote; a long quote is cut inside 110 characters', () => {
    const composed = composeAdminAlert(build({ v2Extraction: v2([], `Customer is upset ${'because the service was missed again and again '.repeat(5)}.`) }).spec);
    expect(composed.why).toContain('“Customer is upset');
    expect(composed.why.length).toBeLessThanOrEqual(110);
  });

  test('words that would break the copy rules stay out of the why (kept in the detail); no words at all still composes', () => {
    const alert = build({ v2Extraction: v2(['This is ridiculous!'], 'Angry caller.') });
    expect(composeAdminAlert(alert.spec).why).toBe('Complained on today\'s call.');
    expect(alert.opts.detail).toContain('This is ridiculous!');
    expect(composeAdminAlert(build({ v2Extraction: {} }).spec).why).toMatch(/call\.$/);
    expect(composeAdminAlert(build({ v2Extraction: null }).spec).headline).toBe('Comms — call Pat Sample about a complaint');
  });

  test('the why never carries a clock time: today\'s call, else the short date; the exact ET time is in the detail', () => {
    const today = build({ now: NOW });
    expect(today.spec.why).not.toMatch(/\d:\d{2}/);
    // The same call read the next ET day is named by its short date.
    const yesterday = build({ now: new Date(NOW.getTime() + 20 * 60 * 60 * 1000) });
    expect(composeAdminAlert(yesterday.spec).why).toBe('Complained on the Nov 9 call: “The technician never showed up”.');
    expect(yesterday.spec.why).not.toMatch(/\d:\d{2}/);
    expect(yesterday.opts.detail).toMatch(/^The call at \d{1,2}:\d{2} (AM|PM) ET was labeled/);
    expect(yesterday.opts.detail).toContain('at 1:00 PM ET');
  });

  test('V1 and V2 disagree: the alert follows V2 and carries nothing from the V1 flat view', async () => {
    const alert = buildComplaintCallAlert({ call: callRow(), customerId: CUSTOMER_ID, name: 'Pat Sample', v2Extraction: V2, extracted: V1_TEXT, now: NOW });
    const text = JSON.stringify([alert.spec, alert.opts]);
    for (const old of [V1_TEXT.pain_points, V1_TEXT.call_summary, V1_TEXT.first_name]) expect(text).not.toContain(old);
    expect(alert.spec.why).toContain('The technician never showed up');
    // Through the helper too, even if a V1 view were handed over.
    await keepComplaintCallAlert(args({ extracted: V1_TEXT }));
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(raiseAdminAlert.mock.calls)).not.toContain('Old V1');
  });

  test('no valid V2 (the label came from the V1 fallback rules): no quote, no V1 text, the detail points at the call record', () => {
    const alert = buildComplaintCallAlert({ call: callRow(), customerId: CUSTOMER_ID, name: 'Pat Sample', v2Extraction: null, extracted: V1_TEXT, now: NOW });
    expect(composeAdminAlert(alert.spec).why).toBe('Complained on today\'s call.');
    expect(alert.opts.detail).toContain('The summary is on the call record.');
    expect(JSON.stringify([alert.spec, alert.opts])).not.toContain('Old V1');
    expect(alert.spec.why).not.toContain('“');
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
    expect(await rings({ v2Extraction: { ...V2, meta: { ...V2.meta, is_voicemail: true } } })).toBe(1);
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

  test('the generation fence: this pass must still own the call at its generation with the label still complaint_escalated', async () => {
    expect(await rings()).toBe(1);
    expect(fenceQueries).toHaveLength(1);
    expect(fenceQueries[0].table).toBe('call_log');
    expect(fenceQueries[0].wheres).toEqual([{ id: CALL_ID, processing_generation: GENERATION, disposition: 'complaint_escalated' }]);
    // A newer force-reprocess took the call (a newer generation) or relabeled it: nothing rings.
    primeDb();
    callState.processing_generation = GENERATION + 1;
    expect(await rings()).toBe(0);
    primeDb();
    callState.disposition = 'existing_customer_routed';
    expect(await rings()).toBe(0);
    primeDb();
    callState = null;
    expect(await rings()).toBe(0);
    // No generation known: nothing rings, and nothing is read.
    primeDb();
    expect(await rings({ procGeneration: null })).toBe(0);
    expect(await rings({ procGeneration: undefined })).toBe(0);
    expect(fenceQueries).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
    // The locked read fails: no alert, a code-only log.
    primeDb({ fenceFails: true });
    expect(await rings()).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('the ownership check and the bell are one transaction: a row lock on the call, and the same trx handed to the raise', async () => {
    expect(await rings()).toBe(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(fenceQueries).toHaveLength(1);
    expect(fenceQueries[0].locked).toBe(true);
    expect(raiseAdminAlert.mock.calls[0][2].trx).toBe(fakeTrx);
    expect(raiseAdminAlert.mock.calls[0][2]).toMatchObject({ dedupeKey: `call-complaint:${CALL_ID}`, bell: true });
    // The call row is never read outside the transaction.
    expect(outsideCallLogReads).toBe(0);
    // The statement timeouts keep the lock short.
    expect(fakeTrx.raw.mock.calls.map((c) => c[0]).join(' ')).toMatch(/statement_timeout[\s\S]*idle_in_transaction_session_timeout/);
  });

  test('ownership changing during emission: a reprocess that lands after the name read and before the lock rings nothing', async () => {
    primeDb({ beforeLock: () => { callState.processing_generation = GENERATION + 1; } });
    expect(await rings()).toBe(0);
    expect(fenceQueries).toHaveLength(1);
    expect(fenceQueries[0].locked).toBe(true);
    // Same race, label changed instead of the generation.
    primeDb({ beforeLock: () => { callState.disposition = 'booked'; } });
    expect(await rings()).toBe(0);
    // No race: the same flow rings.
    primeDb({ beforeLock: () => {} });
    expect(await rings()).toBe(1);
  });

  test('the 24-hour cutoff uses the call timeline\'s end: a row inserted after the call with no Twilio end stamp never rings', async () => {
    const postCall = (over = {}) => callRow({ created_at: minutesAgo(30), metadata: { source: 'status_callback', inserted_on_status: 'completed', ...over } });
    expect(await rings({ call: postCall() })).toBe(0);
    expect(await rings({ call: postCall({ source: 'twilio_recording_status_recovered' }) })).toBe(0);
    // With Twilio's own end stamp the row is judged by it: recent rings, older than 24 h does not.
    expect(await rings({ call: postCall({ ended_at: minutesAgo(20).toISOString() }) })).toBe(1);
    expect(await rings({ call: postCall({ ended_at: minutesAgo(25 * 60).toISOString() }) })).toBe(0);
  });

  test('a failed name lookup keeps the alert; a failed raise never throws and logs a code only', async () => {
    primeDb({ customer: null });
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

  test('applyZeroTriageLayers hands the written flag, the label and the pass generation to the alert right after the label write, no new branch', () => {
    const write = src.indexOf('const written = await writeCallDisposition({ callId: call.id, disposition, reason, callSid });');
    expect(write).toBeGreaterThan(0);
    const next = src.slice(write, write + 400).split('\n')[1].trim();
    expect(next).toBe('await keepComplaintCallAlert({ written, disposition, call, callSid, customerId, v2Extraction: v2ForDisposition, procGeneration });');
  });

  test('both call sites pass the pass\'s procGeneration to applyZeroTriageLayers', () => {
    const calls = src.split('\n').filter((l) => l.includes('await applyZeroTriageLayers({'));
    expect(calls).toHaveLength(2);
    for (const line of calls) expect(line).toContain('procGeneration });');
  });

  test('the alert sends nothing to a customer and has no gate of its own', () => {
    const start = src.indexOf('function buildComplaintCallAlert(');
    const end = src.indexOf('const CallRecordingProcessor = {');
    const block = src.slice(start, end);
    expect(block).not.toMatch(/sendCustomerMessage|sendSMS|isEnabled\(|GATE_/);
    expect(block).not.toContain('notifyAdmin(');
  });
});
