/**
 * Reach rules A and B of the booking-link text (services/call-booking-link-text.js,
 * GATE_CALL_BOOKING_LINK_REACH=shadow, owner 2026-11-17 "link").
 *
 * Pins what the gate may and may not do:
 *   - a call that ONLY rule A (quote promised) or rule B (earlier customer row) stops is
 *     staged with the reach mark; any other call keeps today's outcome and today's reason;
 *   - a marked row NEVER reaches the link builder or the sender, in any gate state: it ends
 *     as a skip (`reach_shadow_would_send`, `fee_visit`, or the rule that stopped it);
 *   - the mark survives a deferral;
 *   - a row without the mark is sent, and stopped, exactly as today while the gate is on.
 * call-booking-link-text.test.js runs with no reader on its feature-gates mock, which is
 * the gate off: its 250+ cases are the proof that off is today's behavior.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../models/marker-db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => false), callBookingLinkReachMode: jest.fn(() => 'shadow'),
}));
jest.mock('../services/lead-consultation-link', () => ({
  buildLeadConsultationSmsLine: jest.fn(async () => ({ url: 'https://wavespest.co/l/abcd', line: 'Pick a time...\n\n' })),
  isUsPhone: jest.fn((phone) => /^\+?1?\d{10}$/.test(String(phone || '').replace(/[^0-9+]/g, ''))),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM_test_sid', deliveryOutcome: 'accepted' })),
}));
jest.mock('../services/sms-auto-send', () => ({
  isRealProviderSend: jest.fn((r) => !!r?.sent && !!r?.providerMessageId),
  isAmbiguousProviderOutcome: jest.fn(() => false),
}));
jest.mock('../services/outbound-call-reason', () => ({
  hasPriorContact: jest.fn(),
  nanpStoredPhoneClause: jest.requireActual('../services/outbound-call-reason').nanpStoredPhoneClause,
}));

const { callBookingLinkReachMode } = require('../config/feature-gates');
const { buildLeadConsultationSmsLine } = require('../services/lead-consultation-link');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { stagingIneligibleReason, stageOne, dispatchClaimedCall, _private } = require('../services/call-booking-link-text');

const { callerOnFile } = _private;
const KEY = 'call_booking_link_text';
const PHONE = '+19415550100';
const TRANSCRIPT = 'Caller: Hi, I have a bug problem.\nAgent: Sure, let me help with that.\nCaller: Can someone come out this week?\nAgent: Let me check the schedule.';

const extraction = (over = {}) => ({
  meta: { is_voicemail: false, is_spam: false },
  call_nature: 'new_lead',
  recommended_disposition: 'lead_response_flow_triggered',
  triage_flags: [],
  caller: { relationship_to_property: 'owner', preferred_contact_method: 'unspecified' },
  property: { property_type: 'single_family', service_address: { street_line_1: '123 Main St', city: 'Bradenton', postal_code: '34205' } },
  scheduling: { status: 'requested' },
  consent: { do_not_contact_request: false, sms_consent_given: true, sms_declined: false },
  sentiment_and_lead: { lead_quality: 'warm' },
  ...over,
  service_request: { service_intent: 'active_infestation_treatment', urgency: 'within_one_week', ...(over.service_request || {}) },
});
const QUOTE_PROMISED = { service_request: { quote_promised: true } };

// A knex stand-in. Every builder method records its call and returns the builder; a function
// handed to where() runs against the same recorder, so nested clauses are recorded too.
// `rows[table]` answers an awaited builder, `first[table]` answers .first(); either may be a
// function of the recorded calls. Writes to call_log are read back from conn.raw's bindings.
function fakeConn({ rows = {}, first = {} } = {}) {
  const queries = [];
  const written = [];
  const answer = (source, table, calls) => (typeof source[table] === 'function' ? source[table](calls) : source[table]);
  const conn = jest.fn((table) => {
    const calls = [];
    queries.push({ table, calls });
    const builder = new Proxy({}, {
      get(_target, method) {
        if (method === 'then') return (resolve, reject) => Promise.resolve(answer(rows, table, calls) || []).then(resolve, reject);
        if (method === 'first') return async () => answer(first, table, calls);
        if (method === 'pluck') return async () => [];
        if (method === 'update' || method === 'del') return async () => 1;
        if (method === 'insert') return () => Promise.resolve([]);
        return (...args) => {
          calls.push([method, ...args]);
          if (method !== 'modify' && typeof args[0] === 'function') args[0].call(builder, builder);
          return builder;
        };
      },
    });
    return builder;
  });
  conn.raw = jest.fn((sql, bindings) => { written.push(JSON.parse(bindings[0])[KEY]); return 'RAW'; });
  conn.transaction = jest.fn(async (fn) => fn(conn));
  conn.queried = (table) => queries.filter((q) => q.table === table);
  conn.written = written;
  return conn;
}

const called = (calls, method, ...args) => calls.some((c) => c[0] === method && args.every((a, i) => JSON.stringify(c[i + 1]) === JSON.stringify(a)));
// The records test's own queries, told apart from the lane's older reads of the same tables.
const recordsVisitQuery = (calls) => called(calls, 'whereIn', 'customer_id');
const recordsEstimateQuery = (calls) => !calls.some((c) => c[0] === 'orderBy');

beforeEach(() => {
  jest.clearAllMocks();
  callBookingLinkReachMode.mockReturnValue('shadow');
});

describe('stagingIneligibleReason with reach: true leaves out rules A and B only', () => {
  const call = { customer_id: null, duration_seconds: 90, ai_address_validation: { status: 'validated_accept', inServiceArea: true },
    direction: 'inbound', from_phone: PHONE, to_phone: '+19415550199', transcription: TRANSCRIPT };

  test('an earlier customer row, a promised quote and the quote_promised flag all pass', () => {
    expect(stagingIneligibleReason({ ...call, customer_id: 'cust-old' }, extraction(), 'lead-1', { reach: true })).toBeNull();
    expect(stagingIneligibleReason(call, extraction(QUOTE_PROMISED), 'lead-1', { reach: true })).toBeNull();
    expect(stagingIneligibleReason(call, extraction({ triage_flags: ['quote_promised'] }), 'lead-1')).toBe('triage_flag_quote_promised');
    expect(stagingIneligibleReason(call, extraction({ triage_flags: ['quote_promised'] }), 'lead-1', { reach: true })).toBeNull();
  });

  test('every other rule still stops the same call', () => {
    const commercial = extraction({ ...QUOTE_PROMISED, property: { property_type: 'commercial_office' } });
    expect(stagingIneligibleReason({ ...call, customer_id: 'cust-old' }, commercial, 'lead-1', { reach: true })).toBe('not_residential');
    const declined = extraction({ ...QUOTE_PROMISED, consent: { do_not_contact_request: false, sms_consent_given: false, sms_declined: true } });
    expect(stagingIneligibleReason(call, declined, 'lead-1', { reach: true })).toBe('sms_declined');
    const twoFlags = extraction({ triage_flags: ['quote_promised', 'cancellation_request'] });
    expect(stagingIneligibleReason(call, twoFlags, 'lead-1', { reach: true })).toBe('triage_flag_cancellation_request');
    expect(stagingIneligibleReason(call, extraction(QUOTE_PROMISED), null, { reach: true })).toBe('no_lead_linkage');
  });
});

describe('callerOnFile: is this caller already a customer, or already quoted or booked?', () => {
  const call = { id: 'call-1', direction: 'inbound', from_phone: PHONE, to_phone: '+19415550199', customer_id: 'cust-old', metadata: { lead_id: 'lead-1' } };
  const leadRow = { id: 'cust-old', pipeline_stage: 'new_lead', deleted_at: null };

  test('a lead-stage row with no history is not on file', async () => {
    const conn = fakeConn({ rows: { customers: [leadRow] } });
    expect(await callerOnFile(conn, { call, leadId: 'lead-1' })).toBeNull();
  });

  test('a live row past the lead stages is a customer, with no visit and no estimate needed', async () => {
    for (const stage of ['active_customer', 'won', 'at_risk', 'churned', 'past_customer', 'lost', null]) {
      const conn = fakeConn({ rows: { customers: [leadRow, { id: 'cust-import', pipeline_stage: stage, deleted_at: null }] } });
      expect(await callerOnFile(conn, { call, leadId: 'lead-1' })).toBe('customer_record');
      expect(conn.queried('scheduled_services')).toHaveLength(0);
    }
  });

  test('a deleted row: its stage is not read, its history still counts', async () => {
    const deleted = { id: 'cust-gone', pipeline_stage: 'active_customer', deleted_at: new Date('2026-06-01T00:00:00Z') };
    const quiet = fakeConn({ rows: { customers: [leadRow, deleted] } });
    expect(await callerOnFile(quiet, { call, leadId: 'lead-1' })).toBeNull();
    const [visits] = quiet.queried('scheduled_services');
    expect(called(visits.calls, 'whereIn', 'customer_id', ['cust-old', 'cust-gone'])).toBe(true);
    const withVisit = fakeConn({ rows: { customers: [leadRow, deleted] }, first: { scheduled_services: { id: 'visit-1' } } });
    expect(await callerOnFile(withVisit, { call, leadId: 'lead-1' })).toBe('visit');
  });

  test.each([
    ['visit', 'scheduled_services'], ['service_record', 'service_records'], ['invoice', 'invoices'], ['estimate', 'estimates'],
  ])('%s on file stops the text', async (found, table) => {
    const conn = fakeConn({ rows: { customers: [leadRow] }, first: { [table]: { id: 'row-1' } } });
    expect(await callerOnFile(conn, { call, leadId: 'lead-1' })).toBe(found);
  });

  test('only a cancelled visit is passed over; an estimate counts in any state, by customer, number or lead', async () => {
    const conn = fakeConn({ rows: { customers: [leadRow] } });
    await callerOnFile(conn, { call, leadId: 'lead-1' });
    expect(called(conn.queried('scheduled_services')[0].calls, 'whereNotIn', 'status', ['cancelled'])).toBe(true);
    const estimates = conn.queried('estimates')[0].calls;
    expect(called(estimates, 'orWhereIn', 'customer_id', ['cust-old'])).toBe(true);
    expect(called(estimates, 'orWhereRaw', "estimate_data->>'lead_id' = ?", ['lead-1'])).toBe(true);
    expect(estimates.filter((c) => c[0] === 'whereRaw').map((c) => c[2])).toEqual([['9415550100']]);
    expect(estimates.some((c) => /status|archived/.test(JSON.stringify(c)))).toBe(false);
  });

  test('a customer row this call did not make and that is not under the number is not judged: it stays a stop', async () => {
    const conn = fakeConn({ rows: { customers: [] } });
    expect(await callerOnFile(conn, { call, leadId: 'lead-1' })).toBe('linked_elsewhere');
    const lead = { id: 'lead-1', phone: PHONE, customer_id: 'cust-other' };
    const viaLead = fakeConn({ rows: { customers: [leadRow] } });
    expect(await callerOnFile(viaLead, { call, lead, leadId: 'lead-1' })).toBe('linked_elsewhere');
  });

  test('the customer row this call made is known even when it is not stored under the number', async () => {
    const made = { ...call, customer_id: 'cust-new', metadata: { lead_id: 'lead-1', created_customer_id: 'cust-new' } };
    const conn = fakeConn({ rows: { customers: [] } });
    expect(await callerOnFile(conn, { call: made, leadId: 'lead-1' })).toBeNull();
    expect(called(conn.queried('scheduled_services')[0].calls, 'whereIn', 'customer_id', ['cust-new'])).toBe(true);
  });

  test('no usable number, or a lead on another number, is never judged as "nothing on file"', async () => {
    const conn = fakeConn();
    expect(await callerOnFile(conn, { call: { ...call, from_phone: null, to_phone: null }, leadId: 'lead-1' })).toBe('phone_unusable');
    expect(await callerOnFile(conn, { call, lead: { id: 'lead-1', phone: '+19415550777', customer_id: null }, leadId: 'lead-1' })).toBe('other_number');
    expect(conn).not.toHaveBeenCalled();
  });
});

describe('stageOne under the gate', () => {
  const NOW = new Date('2026-11-17T16:00:00Z'); // 11:00 AM ET
  const stagedCall = (over = {}) => ({
    id: 'call-1', direction: 'inbound', from_phone: PHONE, to_phone: '+19415550199', created_at: new Date(NOW.getTime() - 60000),
    duration_seconds: 90, transcription: TRANSCRIPT, metadata: { lead_id: 'lead-1' }, customer_id: null,
    ai_extraction_enriched: extraction(), ai_address_validation: { status: 'validated_accept', inServiceArea: true },
    processing_token: null, updated_at: NOW, v2_extraction_status: 'valid', ...over,
  });

  test('rule A: a promised quote is staged with the mark, and the records are not read yet', async () => {
    const conn = fakeConn();
    expect(await stageOne(conn, stagedCall({ ai_extraction_enriched: extraction(QUOTE_PROMISED) }), NOW)).toBe('pending');
    expect(conn.written).toEqual([expect.objectContaining({ status: 'pending', lead_id: 'lead-1', reach: 'quote_promised' })]);
    expect(conn.queried('customers')).toHaveLength(0);
  });

  test('rule B: an earlier row that is only a lead record is staged with the mark', async () => {
    const conn = fakeConn({ rows: { customers: [{ id: 'cust-old', pipeline_stage: 'new_lead', deleted_at: null }] } });
    expect(await stageOne(conn, stagedCall({ customer_id: 'cust-old' }), NOW)).toBe('pending');
    expect(conn.written).toEqual([expect.objectContaining({ status: 'pending', reach: 'existing_customer' })]);
  });

  test('rule B: a real customer still ends at once, with what the records showed', async () => {
    const conn = fakeConn({ rows: { customers: [{ id: 'cust-old', pipeline_stage: 'active_customer', deleted_at: null }] } });
    expect(await stageOne(conn, stagedCall({ customer_id: 'cust-old' }), NOW)).toBe('skipped');
    expect(conn.written).toEqual([{ status: 'skipped', reason: 'existing_customer', staged_at: NOW.toISOString(), on_file: 'customer_record' }]);
  });

  test('a call another rule also stops keeps today\'s reason, and the records are never read', async () => {
    const conn = fakeConn();
    const commercial = extraction({ property: { property_type: 'commercial_office' } });
    expect(await stageOne(conn, stagedCall({ customer_id: 'cust-old', ai_extraction_enriched: commercial }), NOW)).toBe('skipped');
    expect(conn.written).toEqual([{ status: 'skipped', reason: 'existing_customer', staged_at: NOW.toISOString() }]);
    expect(conn.queried('customers')).toHaveLength(0);
  });

  test('a marked call that is too old to queue keeps today\'s reason: the weekly check must not read it as a missed text', async () => {
    const hoursAgo = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);
    const conn = fakeConn();
    expect(await stageOne(conn, stagedCall({ created_at: hoursAgo, ai_extraction_enriched: extraction(QUOTE_PROMISED) }), NOW)).toBe('skipped');
    expect(await stageOne(conn, stagedCall({ created_at: hoursAgo }), NOW)).toBe('skipped');
    expect(conn.written).toEqual([
      { status: 'skipped', reason: 'quote_promised', staged_at: NOW.toISOString() },
      { status: 'skipped', reason: 'stale_at_staging', staged_at: NOW.toISOString() },
    ]);
  });

  test('a call today\'s rules pass is staged with no mark', async () => {
    const conn = fakeConn();
    expect(await stageOne(conn, stagedCall(), NOW)).toBe('pending');
    expect(conn.written[0]).not.toHaveProperty('reach');
  });

  test('gate off: rules A and B stop the call at once, as today', async () => {
    callBookingLinkReachMode.mockReturnValue('off');
    const conn = fakeConn();
    expect(await stageOne(conn, stagedCall({ ai_extraction_enriched: extraction(QUOTE_PROMISED) }), NOW)).toBe('skipped');
    expect(await stageOne(conn, stagedCall({ customer_id: 'cust-old' }), NOW)).toBe('skipped');
    expect(conn.written).toEqual([
      { status: 'skipped', reason: 'quote_promised', staged_at: NOW.toISOString() },
      { status: 'skipped', reason: 'existing_customer', staged_at: NOW.toISOString() },
    ]);
    expect(conn.queried('customers')).toHaveLength(0);
  });
});

describe('dispatchClaimedCall: a marked row is recorded, never sent', () => {
  const NOW = new Date('2026-11-17T18:00:00Z'); // 1:00 PM ET, inside the send window
  const LEAD = { id: 'lead-1', status: 'new', converted_at: null, phone: PHONE, first_name: 'Jamie', customer_id: null,
    estimate_id: null, is_commercial: false, deleted_at: null };
  const claimed = ({ reach, ...over } = {}) => ({
    id: 'call-1', created_at: new Date('2026-11-17T15:30:00Z'), duration_seconds: 90, direction: 'inbound', from_phone: PHONE,
    to_phone: '+19415550199', transcription: TRANSCRIPT, v2_extraction_status: 'valid', processing_token: null, customer_id: null,
    ai_extraction_enriched: extraction(QUOTE_PROMISED), ai_address_validation: { status: 'validated_accept', inServiceArea: true },
    ...over,
    metadata: { lead_id: 'lead-1', ...(over.metadata || {}),
      [KEY]: { status: 'claimed', lead_id: 'lead-1', send_at: NOW.toISOString(), staged_at: '2026-11-17T15:40:00.000Z', ...(reach ? { reach } : {}) } },
  });
  const db = ({ lead = LEAD, customers = [], first = {} } = {}) => fakeConn({
    rows: { customers },
    first: {
      leads: lead,
      scheduled_services: (calls) => (recordsVisitQuery(calls) ? first.visit : first.booked),
      estimates: (calls) => (recordsEstimateQuery(calls) ? first.estimate : undefined),
      invoices: first.invoice,
    },
  });
  const expectNothingSent = () => {
    expect(buildLeadConsultationSmsLine).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  };

  test('rule A, nothing on file two hours later: the log says it would send, and nothing is sent', async () => {
    const conn = db();
    const result = await dispatchClaimedCall(conn, claimed({ reach: 'quote_promised' }), NOW);
    expect(result).toEqual({ sent: false, skipped: 'reach_shadow_would_send' });
    expect(conn.written).toEqual([expect.objectContaining({
      status: 'skipped', reason: 'reach_shadow_would_send', reach: 'quote_promised', staged_at: '2026-11-17T15:40:00.000Z',
    })]);
    expect(conn.queried('activity_log')).toHaveLength(0); // the office's activity feed does not change
    expectNothingSent();
  });

  test('rule A, an estimate now exists: the promise was kept, the call ends quote_promised', async () => {
    const conn = db({ first: { estimate: { id: 'est-1' } } });
    const result = await dispatchClaimedCall(conn, claimed({ reach: 'quote_promised' }), NOW);
    expect(result.skipped).toBe('quote_promised');
    expect(conn.written).toEqual([expect.objectContaining({ reason: 'quote_promised', on_file: 'estimate', reach: 'quote_promised' })]);
    expectNothingSent();
  });

  test('rule B, the earlier row is only a lead record: the log says it would send', async () => {
    const call = claimed({ reach: 'existing_customer', customer_id: 'cust-old', ai_extraction_enriched: extraction() });
    const conn = db({ lead: { ...LEAD, customer_id: 'cust-old' }, customers: [{ id: 'cust-old', pipeline_stage: 'new_lead', deleted_at: null }] });
    expect((await dispatchClaimedCall(conn, call, NOW)).skipped).toBe('reach_shadow_would_send');
    expectNothingSent();
  });

  test('rule B, a visit was booked for that customer before this call: the call ends existing_customer', async () => {
    const call = claimed({ reach: 'existing_customer', customer_id: 'cust-old', ai_extraction_enriched: extraction() });
    const conn = db({ lead: { ...LEAD, customer_id: 'cust-old' }, customers: [{ id: 'cust-old', pipeline_stage: 'new_lead', deleted_at: null }],
      first: { visit: { id: 'visit-1' } } });
    expect((await dispatchClaimedCall(conn, call, NOW)).skipped).toBe('existing_customer');
    expect(conn.written[0]).toEqual(expect.objectContaining({ on_file: 'visit' }));
    expectNothingSent();
  });

  test.each([
    ['the main request', { primary_service_category: 'wdo' }],
    ['a second request', { primary_service_category: 'pest_general', secondary_categories: ['rodent'] }],
  ])('a fee visit as %s is left out: fee_visit', async (_label, request) => {
    const call = claimed({ reach: 'quote_promised', ai_extraction_enriched: extraction({ service_request: { quote_promised: true, ...request } }) });
    expect((await dispatchClaimedCall(db(), call, NOW)).skipped).toBe('fee_visit');
    expectNothingSent();
  });

  test('a rule that stays stops it under its own reason, before the records are read', async () => {
    const conn = db({ lead: { ...LEAD, is_commercial: true } });
    expect((await dispatchClaimedCall(conn, claimed({ reach: 'quote_promised' }), NOW)).skipped).toBe('commercial_lead');
    expect(conn.queried('customers')).toHaveLength(0);
    const booked = db({ first: { booked: { id: 'visit-9' } } });
    expect((await dispatchClaimedCall(booked, claimed({ reach: 'quote_promised' }), NOW)).skipped).toBe('booked_since_call');
    expectNothingSent();
  });

  test('gate turned off after staging: the call ends the way today\'s rules end it', async () => {
    callBookingLinkReachMode.mockReturnValue('off');
    const conn = db();
    expect((await dispatchClaimedCall(conn, claimed({ reach: 'quote_promised' }), NOW)).skipped).toBe('quote_promised');
    expect(conn.queried('customers')).toHaveLength(0);
    expectNothingSent();
  });

  test('the mark decides, not the call: a row whose quote promise was later removed is still never sent', async () => {
    const conn = db();
    const call = claimed({ reach: 'quote_promised', ai_extraction_enriched: extraction() });
    expect((await dispatchClaimedCall(conn, call, NOW)).skipped).toBe('reach_shadow_would_send');
    callBookingLinkReachMode.mockReturnValue('off');
    expect((await dispatchClaimedCall(db(), call, NOW)).skipped).toBe('quote_promised');
    expectNothingSent();
  });

  test('a deferral keeps the mark: outside the send window the row waits, still marked', async () => {
    const conn = db();
    const night = new Date('2026-11-18T02:30:00Z'); // 9:30 PM ET
    const result = await dispatchClaimedCall(conn, claimed({ reach: 'existing_customer' }), night);
    expect(result).toEqual({ sent: false, skipped: 'outside_send_window', deferred: true });
    expect(conn.written).toEqual([expect.objectContaining({ status: 'pending', reach: 'existing_customer' })]);
    expectNothingSent();
  });

  test('a row without the mark is sent exactly as today while the gate is on', async () => {
    const conn = db();
    const result = await dispatchClaimedCall(conn, claimed({ ai_extraction_enriched: extraction() }), NOW);
    expect(result.sent).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(conn.written[0]).not.toHaveProperty('reach');
    expect(conn.queried('customers')).toHaveLength(0);
  });

  test('a row without the mark is stopped by rules A and B exactly as today while the gate is on', async () => {
    const quoted = db();
    expect((await dispatchClaimedCall(quoted, claimed(), NOW)).skipped).toBe('quote_promised');
    const tied = db({ lead: { ...LEAD, customer_id: 'cust-old' } });
    expect((await dispatchClaimedCall(tied, claimed({ ai_extraction_enriched: extraction() }), NOW)).skipped).toBe('existing_customer');
    expect(quoted.queried('customers')).toHaveLength(0);
    expect(tied.queried('customers')).toHaveLength(0);
    expect(quoted.queried('activity_log')).toHaveLength(1); // today's send-time skips still write their activity row
    expectNothingSent();
  });
});
