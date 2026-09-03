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
  const ids = { customers: [], calls: [], visits: [], estimates: [], properties: [], emails: [] };
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
    // The sole ACTIVE property the schedule path stamps on new bookings.
    const [prop] = await db('customer_properties').insert({
      customer_id: cust.id, address_line1: '1234 Fixture Ave', zip: '34205', is_primary: true, active: true,
    }).returning('id');
    ids.properties.push(prop.id);
    return { customerId: cust.id, propertyId: prop.id };
  }

  afterAll(async () => {
    if (ids.visits.length) await db('scheduled_services').whereIn('id', ids.visits).del();
    if (ids.estimates.length) await db('estimates').whereIn('id', ids.estimates).del();
    if (ids.emails.length) await db('email_messages').whereIn('id', ids.emails).del();
    if (ids.calls.length) await db('triage_items').whereIn('call_log_id', ids.calls).del();
    if (ids.calls.length) await db('call_log').whereIn('id', ids.calls).del();
    if (ids.properties.length) await db('customer_properties').whereIn('id', ids.properties).del();
    if (ids.customers.length) await db('customers').whereIn('id', ids.customers).del();
    if (OLD_ENV.base === undefined) delete process.env.GATE_TRIAGE_AUTO_RESOLVE; else process.env.GATE_TRIAGE_AUTO_RESOLVE = OLD_ENV.base;
    if (OLD_ENV.ev === undefined) delete process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE; else process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE = OLD_ENV.ev;
    await db.destroy();
  });

  // confirmedHour: the card's snapshot CONFIRMED that ET hour on the
  // requested day; bookingWindowStart / recurringBooking shape the booking.
  async function seedCall(sid, { cardAgeMin, bookingAgeMin, bookingStatus = 'confirmed', bookingDayOffset = 2, categories = ['pest_control'], intent = 'preventative_one_time', confirmedHour = null, bookingWindowStart = null, recurringBooking = false }) {
    const { customerId, propertyId } = await seedCustomer(sid.slice(-2));
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
      payload: JSON.stringify({ flag: 'not_confirmed', scheduling_window: {
        status: confirmedHour ? 'confirmed' : 'requested',
        confirmed_start_at: confirmedHour ? `${requestedDay}T${confirmedHour}:00:00-04:00` : null,
        requested_date_range_start: requestedDay, requested_service_categories: categories, requested_service_intent: intent,
        requested_address: { street_line_1: null, street_line_2: null, city: null, postal_code: null, raw_text: null, additional_properties: 0 },
      } }),
    }).returning('id');
    const [visit] = await db('scheduled_services').insert({
      customer_id: customerId, property_id: propertyId, service_type: 'Quarterly Pest Control', status: bookingStatus,
      scheduled_date: new Date(Date.now() + bookingDayOffset * 86400000).toISOString().slice(0, 10),
      window_start: bookingWindowStart, is_recurring: recurringBooking,
      created_at: new Date(Date.now() - bookingAgeMin * 60000),
    }).returning('id');
    ids.visits.push(visit.id);
    return { callId: call.id, cardId: card.id };
  }

  // quote_promised: a card + an estimate stamped with the call's id
  // (estimator provenance), sent at the given age.
  // estimateOwner 'other': the stamped estimate belongs to a different
  // customer (the shape a relink leaves behind).
  async function seedQuoteCall(sid, { cardAgeMin, estimateAgeMin, deliveredAgeMin = estimateAgeMin, estimateOwner = 'call' }) {
    const { customerId } = await seedCustomer(sid.slice(-2));
    const ownerId = estimateOwner === 'other' ? (await seedCustomer(`${sid.slice(-2)}x`)).customerId : customerId;
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
      customer_id: ownerId, status: 'sent', sent_at: new Date(Date.now() - estimateAgeMin * 60000),
      estimate_data: JSON.stringify({
        estimatorEngine: { callLogId: String(call.id) },
        ...(deliveredAgeMin === null ? {} : { deliveryState: { lastDeliveredAt: new Date(Date.now() - deliveredAgeMin * 60000).toISOString() } }),
      }),
    }).returning('id');
    ids.estimates.push(est.id);
    return { callId: call.id, cardId: card.id };
  }

  // email_unverified: a card carrying its filing-time release target + an
  // engaged message to that address, sent to `recipientId` after the card.
  async function seedEmailCall(sid, { recipientOf }) {
    const { customerId } = await seedCustomer(sid.slice(-2));
    const target = `release-${sid.slice(-2).toLowerCase()}@example.invalid`;
    const callAt = new Date(Date.now() - 65 * 60000);
    const [call] = await db('call_log').insert({
      twilio_call_sid: sid, direction: 'inbound', from_phone: PHONE, to_phone: '+15555550100',
      status: 'completed', duration_seconds: 120, processing_status: 'processed',
      customer_id: customerId, review_status: 'open', created_at: callAt,
    }).returning('id');
    ids.calls.push(call.id);
    const cardAt = new Date(Date.now() - 60 * 60000);
    const [card] = await db('triage_items').insert({
      call_log_id: call.id, category: 'contact_ambiguous', severity: 'blocking', reason_code: 'email_unverified',
      status: 'open', summary: 'fixture', created_at: cardAt, updated_at: cardAt,
      payload: JSON.stringify({ flag: 'email_unverified', email_release_target: target }),
    }).returning('id');
    const [msg] = await db('email_messages').insert({
      recipient_type: 'customer', recipient_id: String(recipientOf(customerId)), recipient_email_snapshot: target,
      status: 'sent', sent_at: new Date(Date.now() - 10 * 60000), opened_at: new Date(Date.now() - 5 * 60000),
    }).returning('id');
    ids.emails.push(msg.id);
    return { cardId: card.id };
  }

  test('email_unverified resolves on an engaged message sent to THIS customer at the release target — never on another customer\'s message to the same address', async () => {
    const mine = await seedEmailCall(SID.replace(/e2$/, 'm1'), { recipientOf: (id) => id });
    const { customerId: stranger } = await seedCustomer('m9');
    const other = await seedEmailCall(SID.replace(/e2$/, 'm2'), { recipientOf: () => stranger });
    const result = await sweep.runTriageAutoResolve({ now: new Date() });
    expect(result.skipped).toBe(false);
    const closed = await db('triage_items').where({ id: mine.cardId }).first();
    expect(closed.status).toBe('resolved');
    expect(closed.resolution_note).toBe(sweep.RULE_NOTES.email_engaged);
    const open = await db('triage_items').where({ id: other.cardId }).first();
    expect(open.status).toBe('open');
  });

  test('quote_promised resolves on a call-stamped estimate DELIVERED after the card — not one sent before it, a suppressed send, or another customer\'s estimate', async () => {
    const fresh = await seedQuoteCall(SID.replace(/e2$/, 'q1'), { cardAgeMin: 60, estimateAgeMin: 10 });
    const stale = await seedQuoteCall(SID.replace(/e2$/, 'q2'), { cardAgeMin: 10, estimateAgeMin: 60 });
    const suppressed = await seedQuoteCall(SID.replace(/e2$/, 'q3'), { cardAgeMin: 60, estimateAgeMin: 10, deliveredAgeMin: null });
    const foreign = await seedQuoteCall(SID.replace(/e2$/, 'q4'), { cardAgeMin: 60, estimateAgeMin: 10, estimateOwner: 'other' });
    const result = await sweep.runTriageAutoResolve({ now: new Date() });
    expect(result.skipped).toBe(false);
    const closed = await db('triage_items').where({ id: fresh.cardId }).first();
    expect(closed.status).toBe('resolved');
    expect(closed.resolution_source).toBe('auto');
    expect(closed.resolution_note).toBe(sweep.RULE_NOTES.quote_fulfilled);
    const open = await db('triage_items').where({ id: stale.cardId }).first();
    expect(open.status).toBe('open');
    const suppressedCard = await db('triage_items').where({ id: suppressed.cardId }).first();
    expect(suppressedCard.status).toBe('open');
    // Stamped with this call but owned by another customer (a relink moved
    // the call, not the estimate): not this customer's proof.
    const foreignCard = await db('triage_items').where({ id: foreign.cardId }).first();
    expect(foreignCard.status).toBe('open');
  });

  test('a CONFIRMED call closes only on a booking at the confirmed hour; a recurring-plan ask only on a recurring series', async () => {
    const atHour = await seedCall(SID.replace(/e2$/, 'h1'), { cardAgeMin: 60, bookingAgeMin: 10, confirmedHour: '10', bookingWindowStart: '10:00:00' });
    const offHour = await seedCall(SID.replace(/e2$/, 'h2'), { cardAgeMin: 60, bookingAgeMin: 10, confirmedHour: '10', bookingWindowStart: '14:00:00' });
    const noHour = await seedCall(SID.replace(/e2$/, 'h3'), { cardAgeMin: 60, bookingAgeMin: 10, confirmedHour: '10' });
    const planOneTime = await seedCall(SID.replace(/e2$/, 'h4'), { cardAgeMin: 60, bookingAgeMin: 10, intent: 'recurring_membership_inquiry' });
    const planSeries = await seedCall(SID.replace(/e2$/, 'h5'), { cardAgeMin: 60, bookingAgeMin: 10, intent: 'recurring_membership_inquiry', recurringBooking: true });
    const result = await sweep.runTriageAutoResolve({ now: new Date() });
    expect(result.skipped).toBe(false);
    const statusOf = async (c) => (await db('triage_items').where({ id: c.cardId }).first('status')).status;
    expect(await statusOf(atHour)).toBe('resolved');
    expect(await statusOf(offHour)).toBe('open');
    expect(await statusOf(noHour)).toBe('open');
    expect(await statusOf(planOneTime)).toBe('open');
    expect(await statusOf(planSeries)).toBe('resolved');
  });

  test('booking after the card on the requested day resolves it as auto; a pre-card, skipped, or off-day booking leaves it open', async () => {
    const fresh = await seedCall(SID, { cardAgeMin: 60, bookingAgeMin: 10 });
    const stale = await seedCall(SID.replace(/e2$/, 'e3'), { cardAgeMin: 10, bookingAgeMin: 60 });
    const skipped = await seedCall(SID.replace(/e2$/, 'e4'), { cardAgeMin: 60, bookingAgeMin: 10, bookingStatus: 'skipped' });
    const offDay = await seedCall(SID.replace(/e2$/, 'e5'), { cardAgeMin: 60, bookingAgeMin: 10, bookingDayOffset: 5 });
    const partial = await seedCall(SID.replace(/e2$/, 'e6'), { cardAgeMin: 60, bookingAgeMin: 10, categories: ['pest_control', 'lawn_care'] });

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
    // A pest-only booking does not answer a pest + lawn ask.
    const partialCard = await db('triage_items').where({ id: partial.cardId }).first();
    expect(partialCard.status).toBe('open');
  });
});
