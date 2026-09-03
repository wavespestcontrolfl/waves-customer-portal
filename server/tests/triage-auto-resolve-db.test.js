// The sweep on a real Postgres: the evidence gate closes a not_confirmed
// card on a booking created AFTER the card, stamps resolution_source='auto',
// and mirrors call_log.review_status — and a booking that PREDATES the card
// (stale provenance) leaves it open. Runs only with DATABASE_URL (CI's
// DB-gated step); fixtures are fictitious (555-01xx, fake SIDs).
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: (_name, fn) => fn() }));

const SID = 'CA' + '7'.repeat(30) + 'e2';
const PHONE = '+15555550188';

maybeDescribe('triage auto-resolve sweep (live Postgres)', () => {
  let db;
  let sweep;
  const ids = { customers: [], calls: [], visits: [], estimates: [] };
  const OLD_ENV = { base: process.env.GATE_TRIAGE_AUTO_RESOLVE, ev: process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE };

  beforeAll(async () => {
    process.env.GATE_TRIAGE_AUTO_RESOLVE = 'true';
    process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE = 'true';
    db = require('../models/db');
    sweep = require('../services/triage-auto-resolve');
    await db('call_log').where({ twilio_call_sid: SID }).del();
  });

  // One customer per case: the association arm is same-customer by design,
  // so a live booking from one case must not bleed into another.
  async function seedCustomer(tag) {
    const [cust] = await db('customers').insert({
      first_name: 'Sweep', last_name: `Fixture ${tag}`, phone: PHONE, email: `sweep-fixture-${tag}@example.invalid`,
      pipeline_stage: 'active_customer', address_line1: '1234 Fixture Ave', zip: '34205',
      created_at: new Date(Date.now() - 30 * 86400000),
    }).returning('id');
    ids.customers.push(cust.id);
    return cust.id;
  }

  afterAll(async () => {
    if (ids.visits.length) await db('scheduled_services').whereIn('id', ids.visits).del();
    if (ids.estimates.length) await db('estimates').whereIn('id', ids.estimates).del();
    if (ids.calls.length) await db('triage_items').whereIn('call_log_id', ids.calls).del();
    if (ids.calls.length) await db('call_log').whereIn('id', ids.calls).del();
    if (ids.customers.length) await db('customers').whereIn('id', ids.customers).del();
    if (OLD_ENV.base === undefined) delete process.env.GATE_TRIAGE_AUTO_RESOLVE; else process.env.GATE_TRIAGE_AUTO_RESOLVE = OLD_ENV.base;
    if (OLD_ENV.ev === undefined) delete process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE; else process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE = OLD_ENV.ev;
    await db.destroy();
  });

  async function seedCall(sid, { cardAgeMin, bookingAgeMin, bookingStatus = 'confirmed', bookingDayOffset = 2 }) {
    const customerId = await seedCustomer(sid.slice(-2));
    const callAt = new Date(Date.now() - (cardAgeMin + 5) * 60000);
    const [call] = await db('call_log').insert({
      twilio_call_sid: sid, direction: 'inbound', from_phone: PHONE, to_phone: '+15555550100',
      status: 'completed', duration_seconds: 120, processing_status: 'processed',
      customer_id: customerId, review_status: 'open', created_at: callAt,
      ai_extraction_enriched: JSON.stringify({ service_request: { primary_service_category: 'pest_control' }, scheduling: { status: 'requested' } }),
    }).returning('id');
    ids.calls.push(call.id);
    const cardAt = new Date(Date.now() - cardAgeMin * 60000);
    const requestedDay = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const [card] = await db('triage_items').insert({
      call_log_id: call.id, category: 'time_ambiguous', severity: 'blocking', reason_code: 'not_confirmed',
      status: 'open', summary: 'fixture', created_at: cardAt, updated_at: cardAt,
      payload: JSON.stringify({ flag: 'not_confirmed', scheduling_window: { status: 'requested', requested_date_range_start: requestedDay, requested_service_categories: ['pest_control'] } }),
    }).returning('id');
    const [visit] = await db('scheduled_services').insert({
      customer_id: customerId, service_type: 'Quarterly Pest Control', status: bookingStatus,
      scheduled_date: new Date(Date.now() + bookingDayOffset * 86400000).toISOString().slice(0, 10),
      created_at: new Date(Date.now() - bookingAgeMin * 60000),
    }).returning('id');
    ids.visits.push(visit.id);
    return { callId: call.id, cardId: card.id };
  }

  // quote_promised: a card + an estimate stamped with the call's id
  // (estimator provenance), sent at the given age.
  async function seedQuoteCall(sid, { cardAgeMin, estimateAgeMin }) {
    const customerId = await seedCustomer(sid.slice(-2));
    const callAt = new Date(Date.now() - (cardAgeMin + 5) * 60000);
    const [call] = await db('call_log').insert({
      twilio_call_sid: sid, direction: 'inbound', from_phone: PHONE, to_phone: '+15555550100',
      status: 'completed', duration_seconds: 120, processing_status: 'processed',
      customer_id: customerId, review_status: 'open', created_at: callAt,
    }).returning('id');
    ids.calls.push(call.id);
    const cardAt = new Date(Date.now() - cardAgeMin * 60000);
    const [card] = await db('triage_items').insert({
      call_log_id: call.id, category: 'time_ambiguous', severity: 'blocking', reason_code: 'quote_promised',
      status: 'open', summary: 'fixture', created_at: cardAt, updated_at: cardAt,
      payload: JSON.stringify({ flag: 'quote_promised' }),
    }).returning('id');
    const [est] = await db('estimates').insert({
      customer_id: customerId, status: 'sent', sent_at: new Date(Date.now() - estimateAgeMin * 60000),
      estimate_data: JSON.stringify({ estimatorEngine: { callLogId: String(call.id) } }),
    }).returning('id');
    ids.estimates.push(est.id);
    return { callId: call.id, cardId: card.id };
  }

  test('quote_promised resolves on a call-stamped estimate sent after the card, not one sent before it', async () => {
    const fresh = await seedQuoteCall(SID.replace(/e2$/, 'q1'), { cardAgeMin: 60, estimateAgeMin: 10 });
    const stale = await seedQuoteCall(SID.replace(/e2$/, 'q2'), { cardAgeMin: 10, estimateAgeMin: 60 });
    const result = await sweep.runTriageAutoResolve({ now: new Date() });
    expect(result.skipped).toBe(false);
    const closed = await db('triage_items').where({ id: fresh.cardId }).first();
    expect(closed.status).toBe('resolved');
    expect(closed.resolution_source).toBe('auto');
    expect(closed.resolution_note).toBe(sweep.RULE_NOTES.quote_fulfilled);
    const open = await db('triage_items').where({ id: stale.cardId }).first();
    expect(open.status).toBe('open');
  });

  test('booking after the card on the requested day resolves it as auto; a pre-card, skipped, or off-day booking leaves it open', async () => {
    const fresh = await seedCall(SID, { cardAgeMin: 60, bookingAgeMin: 10 });
    const stale = await seedCall(SID.replace(/e2$/, 'e3'), { cardAgeMin: 10, bookingAgeMin: 60 });
    const skipped = await seedCall(SID.replace(/e2$/, 'e4'), { cardAgeMin: 60, bookingAgeMin: 10, bookingStatus: 'skipped' });
    const offDay = await seedCall(SID.replace(/e2$/, 'e5'), { cardAgeMin: 60, bookingAgeMin: 10, bookingDayOffset: 5 });

    const result = await sweep.runTriageAutoResolve({ now: new Date() });
    expect(result.skipped).toBe(false);

    const closed = await db('triage_items').where({ id: fresh.cardId }).first();
    expect(closed.status).toBe('resolved');
    expect(closed.resolution_source).toBe('auto');
    expect(closed.resolution_note).toBe(sweep.RULE_NOTES.booking_created);
    const closedCall = await db('call_log').where({ id: fresh.callId }).first('review_status');
    expect(closedCall.review_status).toBe('resolved');

    const open = await db('triage_items').where({ id: stale.cardId }).first();
    expect(open.status).toBe('open');
    expect(open.resolution_source).toBeNull();
    const openCall = await db('call_log').where({ id: stale.callId }).first('review_status');
    expect(openCall.review_status).toBe('open');

    const skippedCard = await db('triage_items').where({ id: skipped.cardId }).first();
    expect(skippedCard.status).toBe('open');
    const offDayCard = await db('triage_items').where({ id: offDay.cardId }).first();
    expect(offDayCard.status).toBe('open');
  });
});
