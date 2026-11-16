/**
 * Out-of-area hold (2026-11-03: a hot lead held by the V2 hard veto kept no label, no recorded
 * promise and no alert). When out_of_service_area is the veto's ONLY canonical-write blocker, the
 * hold records the call's commitments, writes a disposition and raises one Leads alert for a hot
 * or warm caller. It never creates a customer, lead, appointment or message. Every other blocker,
 * alone or beside out_of_service_area, keeps the silent return. A full processRecording() run
 * cannot be mocked end to end (see call-legacy-geographic-veto.test.js), so the helpers are tested
 * behaviorally and the wiring is pinned structurally. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'), isEnabled: jest.fn(() => false) }));
jest.mock('../services/call-commitments', () => ({
  recordCallCommitments: jest.fn(async () => ({ seeds: 1, model: 0, written: 1, dropped: 0 })),
  staleAiRowSql: jest.fn(() => 'false'),
}));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'n1' })),
}));

const fs = require('fs');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { recordCallCommitments } = require('../services/call-commitments');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
const { _test } = require('../services/call-recording-processor');

const { isOutOfAreaOnlyHold, outOfAreaHoldDisposition, buildOutOfAreaHoldAlert, keepOutOfAreaHoldRecords } = _test;

const CALL = { id: 'call-1', twilio_call_sid: 'CA1' };
const AV = { status: 'out_of_service_area', county: 'Example', normalized: { city: 'Sampleton' } };
const V2 = { status: 'valid', extraction: { service_request: { quote_requested: false, quote_promised: false } } };
const args = (over = {}) => ({
  call: CALL,
  callSid: 'CA1',
  transcription: 'Agent: We will send over a quote. Caller: Thanks.',
  extracted: { first_name: 'Pat', lead_quality: 'hot', is_lead: true, matched_service: 'Lawn Care' },
  v2Result: V2,
  procGeneration: 4,
  addressValidation: AV,
  ...over,
});

let tables;
let writes;
function primeDb({ wavesPromise = false, disposition = 1, updateFails = false } = {}) {
  tables = [];
  writes = [];
  db.mockImplementation((table) => {
    tables.push(table);
    const b = {
      where: jest.fn(() => b),
      whereIn: jest.fn(() => b),
      whereRaw: jest.fn(() => b),
      first: jest.fn(async () => (table === 'call_commitments'
        ? (wavesPromise ? { id: 'cc1' } : undefined)
        : { transcript_structured: null, processing_status: 'processed' })),
      update: jest.fn(async (u) => { if (updateFails) throw new Error('db down'); writes.push({ table, u, where: b.where.mock.calls.map((c) => c[0]) }); return disposition; }),
    };
    return b;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((k) => k === 'callCommitments' || k === 'callDispositionV1');
  primeDb();
});

describe('isOutOfAreaOnlyHold', () => {
  test('out_of_service_area as the only blocker (other flags beside it do not count)', () => {
    expect(isOutOfAreaOnlyHold(['out_of_service_area'])).toBe(true);
    expect(isOutOfAreaOnlyHold(['out_of_service_area', 'address_unverified', 'voicemail'])).toBe(true);
  });
  test.each([
    [['spam_or_wrong_number']],
    [['do_not_contact_requested']],
    [['out_of_service_area', 'do_not_contact_requested']],
    [['out_of_service_area', 'spam_or_wrong_number']],
    [['address_unverified']],
    [[]],
    [null],
  ])('%j is not an out-of-area-only hold', (flags) => {
    expect(isOutOfAreaOnlyHold(flags)).toBe(false);
  });
});

describe('outOfAreaHoldDisposition', () => {
  const none = { first_name: 'Pat', lead_quality: 'cold', is_lead: false };
  test('a cold, non-lead call with no ask is no_action_needed', () => {
    expect(outOfAreaHoldDisposition({ extracted: none })).toEqual({ disposition: 'no_action_needed', reason: 'out_of_service_area_hold' });
  });
  test.each([
    ['V1 lead', { ...none, is_lead: true }, null, false],
    ['hot', { ...none, lead_quality: 'hot' }, null, false],
    ['warm', { ...none, lead_quality: 'warm' }, null, false],
    ['V1 quote requested', { ...none, quote_requested: true }, null, false],
    ['V2 quote promised', none, { service_request: { quote_promised: true } }, false],
    ['V2 quote requested', none, { service_request: { quote_requested: true } }, false],
    ['a Waves callback promise recorded', none, null, true],
  ])('%s -> callback_task_created', (_n, extracted, v2Extraction, wavesPromiseRecorded) => {
    expect(outOfAreaHoldDisposition({ extracted, v2Extraction, wavesPromiseRecorded })).toEqual({ disposition: 'callback_task_created', reason: 'out_of_service_area_hold' });
  });

  // 2026-11-09: staff told two callers Waves does not go there; V2 closed both as no_action_needed.
  describe('a call that ended with nothing to do', () => {
    const lead = { first_name: 'Pat', lead_quality: 'cold', is_lead: true };
    const closed = (over = {}) => ({
      recommended_disposition: 'no_action_needed',
      scheduling: { status: 'none', follow_up_mentioned: false },
      service_request: { quote_requested: false, quote_promised: false },
      ...over,
    });
    const NO_ACTION = { disposition: 'no_action_needed', reason: 'out_of_service_area_hold' };
    const CALLBACK = { disposition: 'callback_task_created', reason: 'out_of_service_area_hold' };

    test('a lead the model closed with no open thread and no promise is no_action_needed', () => {
      expect(outOfAreaHoldDisposition({ extracted: lead, v2Extraction: closed(), wavesPromiseRecorded: false })).toEqual(NO_ACTION);
      expect(outOfAreaHoldDisposition({ extracted: lead, v2Extraction: closed() })).toEqual(NO_ACTION);
    });
    test('a hot or warm caller on such a call is no_action_needed too (the alert is raised elsewhere)', () => {
      expect(outOfAreaHoldDisposition({ extracted: { ...lead, lead_quality: 'hot' }, v2Extraction: closed() })).toEqual(NO_ACTION);
    });
    test('a recorded Waves promise keeps callback_task_created', () => {
      expect(outOfAreaHoldDisposition({ extracted: lead, v2Extraction: closed(), wavesPromiseRecorded: true })).toEqual(CALLBACK);
    });
    test('a quote promised or requested keeps callback_task_created', () => {
      expect(outOfAreaHoldDisposition({ extracted: lead, v2Extraction: closed({ service_request: { quote_promised: true } }) })).toEqual(CALLBACK);
      expect(outOfAreaHoldDisposition({ extracted: lead, v2Extraction: closed({ service_request: { quote_requested: true } }) })).toEqual(CALLBACK);
      expect(outOfAreaHoldDisposition({ extracted: { ...lead, quote_requested: true }, v2Extraction: closed() })).toEqual(CALLBACK);
    });
    test('a hot caller whose call did NOT end with nothing to do keeps callback_task_created', () => {
      const hot = { ...lead, lead_quality: 'hot' };
      expect(outOfAreaHoldDisposition({ extracted: hot, v2Extraction: closed({ recommended_disposition: 'callback_task_created' }) })).toEqual(CALLBACK);
      expect(outOfAreaHoldDisposition({ extracted: hot, v2Extraction: closed({ scheduling: { status: 'none', follow_up_mentioned: true } }) })).toEqual(CALLBACK);
    });
    test('no valid V2 extraction keeps the old rule', () => {
      expect(outOfAreaHoldDisposition({ extracted: lead, v2Extraction: null })).toEqual(CALLBACK);
    });
    test('a voicemail keeps the old rule', () => {
      expect(outOfAreaHoldDisposition({ extracted: lead, v2Extraction: closed({ meta: { is_voicemail: true } }) })).toEqual(CALLBACK);
    });
  });
});

describe('buildOutOfAreaHoldAlert', () => {
  test('passes the composer rules and names the place and the ask', () => {
    const alert = buildOutOfAreaHoldAlert({ call: CALL, extracted: args().extracted, addressValidation: AV });
    const composed = composeAdminAlert(alert.spec);
    expect(alert.category).toBe('lead');
    expect(composed.headline).toBe("Leads — check Pat's out-of-area hold");
    expect(composed.why).toContain('Sampleton, Example County');
    expect(composed.why).toContain('Lawn Care');
    expect(composed.link).toBe('/admin/communications#tab=calls&call=call-1');
    expect(composed.metadata).toMatchObject({ area: 'Leads', severity: 'needs-you', who: 'person', subject: { type: 'call', id: 'call-1' } });
    expect(alert.opts.dedupeKey).toBe('call-out-of-area:call-1');
    expect(alert.opts.detail).toContain('Confirm the area and follow up.');
    expect(alert.opts.detail).toContain('outside the service area');
    expect(alert.opts.dedupeOpenOnly).toBeUndefined();
  });
  test('a county that already ends in County is named once', () => {
    const alert = buildOutOfAreaHoldAlert({ call: CALL, extracted: args().extracted, addressValidation: { ...AV, county: 'Manatee County', normalized: { city: 'Bradenton' } } });
    expect(composeAdminAlert(alert.spec).why).toContain('Bradenton, Manatee County;');
    expect(composeAdminAlert(alert.spec).why).not.toMatch(/County County/);
    expect(alert.opts.detail).toContain('(Bradenton, Manatee County)');
  });
  test('an unnamed caller with no ask or place still composes', () => {
    const alert = buildOutOfAreaHoldAlert({ call: CALL, extracted: { lead_quality: 'warm' }, addressValidation: null });
    expect(composeAdminAlert(alert.spec).headline).toBe("Leads — check the caller's out-of-area hold");
  });
});

describe('keepOutOfAreaHoldRecords', () => {
  test('hot lead: commitments recorded, callback_task_created written (null-only, this generation), one alert', async () => {
    await keepOutOfAreaHoldRecords(args());
    expect(recordCallCommitments).toHaveBeenCalledWith(expect.objectContaining({ procGeneration: 4, transcript: expect.any(String), automationHold: true }));
    const dispo = writes.find((w) => w.u.disposition);
    expect(dispo.u).toMatchObject({ disposition: 'callback_task_created' });
    expect(dispo.where).toEqual(expect.arrayContaining([{ id: 'call-1' }, { disposition: null }, { processing_generation: 4 }]));
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert.mock.calls[0][0]).toBe('lead');
    expect(raiseAdminAlert.mock.calls[0][2].dedupeKey).toBe('call-out-of-area:call-1');
  });

  test('warm raises an alert; cold does not, and a cold call with no ask is no_action_needed', async () => {
    await keepOutOfAreaHoldRecords(args({ extracted: { first_name: 'Pat', lead_quality: 'warm', is_lead: true } }));
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    raiseAdminAlert.mockClear();
    await keepOutOfAreaHoldRecords(args({ extracted: { first_name: 'Pat', lead_quality: 'cold', is_lead: false } }));
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(writes.at(-1).u).toMatchObject({ disposition: 'no_action_needed' });
  });

  test('a recorded Waves quote promise makes a cold call a callback', async () => {
    primeDb({ wavesPromise: true });
    await keepOutOfAreaHoldRecords(args({ extracted: { first_name: 'Pat', lead_quality: 'cold', is_lead: false } }));
    expect(writes.at(-1).u).toMatchObject({ disposition: 'callback_task_created' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('writes only call_log disposition + reads commitments: no customer, lead, appointment or message table is touched', async () => {
    await keepOutOfAreaHoldRecords(args());
    expect(new Set(tables)).toEqual(new Set(['call_log', 'call_commitments']));
    expect(writes.every((w) => w.table === 'call_log' && Object.keys(w.u).sort().join() === 'disposition,updated_at')).toBe(true);
  });

  test('disposition switch off: no label written, commitments and the alert still happen', async () => {
    isEnabled.mockImplementation((k) => k === 'callCommitments');
    await keepOutOfAreaHoldRecords(args());
    expect(writes).toEqual([]);
    expect(recordCallCommitments).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('each record step stands alone: a failed label write or commitments pass still raises the alert', async () => {
    primeDb({ updateFails: true });
    await expect(keepOutOfAreaHoldRecords(args())).resolves.toBeUndefined();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    raiseAdminAlert.mockClear();
    primeDb();
    recordCallCommitments.mockRejectedValueOnce(new Error('boom'));
    await keepOutOfAreaHoldRecords(args());
    expect(writes.some((w) => w.u.disposition)).toBe(true);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('a failure in a step never throws out of the hold', async () => {
    recordCallCommitments.mockRejectedValueOnce(new Error('boom'));
    await expect(keepOutOfAreaHoldRecords(args())).resolves.toBeUndefined();
    raiseAdminAlert.mockRejectedValueOnce(new Error('bell down'));
    await expect(keepOutOfAreaHoldRecords(args())).resolves.toBeUndefined();
  });
});

describe('wiring', () => {
  const src = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  test('the hold is set only from the veto flags, and run only inside the hard-veto return, before it returns', () => {
    expect(src).toContain('v2OutOfAreaOnlyHold = v2CanonicalWriteBlocked && isOutOfAreaOnlyHold(finalFlags);');
    const start = src.indexOf('    if (v2CanonicalWriteBlocked) {');
    const ret = src.indexOf("return { success: true, skipped: true, reason: 'v2_canonical_write_blocked' };", start);
    const block = src.slice(start, ret);
    expect(block).toContain('if (v2OutOfAreaOnlyHold && !extracted.is_spam) {');
    expect(block).toContain('await keepOutOfAreaHoldRecords(');
    expect(src.split('keepOutOfAreaHoldRecords(').length - 1).toBe(2); // definition + this call
    // the fenced terminal write precedes it
    expect(block.indexOf("trx('call_log')")).toBeLessThan(block.indexOf('keepOutOfAreaHoldRecords('));
  });

  test('the hold helpers send nothing and raise only through the composer', () => {
    const from = src.indexOf('const OUT_OF_AREA_HOLD_REASON');
    const to = src.indexOf('const CallRecordingProcessor = {');
    const code = src.slice(from, to);
    expect(code).not.toMatch(/sendSMS|sendEmail|sendCustomerMessage|notifyAdmin\(|twilio/i);
    expect(code).toContain('raiseAdminAlert(');
  });
});
