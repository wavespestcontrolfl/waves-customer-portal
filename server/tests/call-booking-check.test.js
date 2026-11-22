/**
 * Call booking check (owner 2026-11-22, "fix"), the pure part: what a call-booked visit and the reading of its call
 * say about the service and about the price (problem, agrees or unknown), when an open bell closes, and the bell
 * copy through the real composeAdminAlert. The SQL side runs in call-booking-check-postgres.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { composeAdminAlert } = require('../services/admin-alert-compose');
const { runCallBookingCheck, _private } = require('../services/call-booking-check');

const { judgeService, judgePrice, problemOf, closeKeyFor, specFor, detailFor, priceSpecFor, priceDetailFor, CLOSED } = _private;

const BILLING = new Map([
  ['one-time pest control service', 'one_time'],
  ['monthly pest control service', 'recurring'],
  ['shared name', null],
]);

// The 2026-11-21 call as it was stored: the reading names a one-time service for a treatment, not a plan ask.
const reading = (over = {}) => ({
  service_request: { specific_service_name: 'One-Time Pest Control Service', service_intent: 'active_infestation_treatment', ...over },
});
const visit = (over = {}) => ({
  id: '11111111-2222-4333-8444-555555555555', customer_id: 'c1', status: 'confirmed', visit_date: '2026-11-21',
  service_type: 'One-Time Pest Control Service',
  row_name: 'One-Time Pest Control Service', row_service_key: 'one_time_pest_control', row_billing_type: 'one_time',
  v2_extraction_status: 'valid', ai_extraction_enriched: reading(),
  ...over,
});
const planVisit = (over = {}) => visit({
  service_type: 'Monthly Pest Control Service', row_name: 'Monthly Pest Control Service',
  row_service_key: 'pest_general_monthly', row_billing_type: 'recurring', ...over,
});
const heardAs = (over) => planVisit({ ai_extraction_enriched: reading(over) });
// One side cannot be read: the call's reading, the name it holds, or the visit's catalog row.
const UNREADABLE = [
  planVisit({ v2_extraction_status: 'schema_failed' }),
  ...[null, 'not json', {}, { service_request: 'text' }].map((stored) => planVisit({ ai_extraction_enriched: stored })),
  ...['Some Service Nobody Sells', 'Shared Name', null].map((name) => heardAs({ specific_service_name: name })),
  planVisit({ row_name: null, row_service_key: null, row_billing_type: null }),
  // The reading disagrees with itself: a one-time service, and the caller's choice of a plan's billing.
  ...['annual_prepay', 'per_application'].map((choice) => heardAs({ billing_choice: choice })),
];

describe('what a visit and the reading of its call say about the service', () => {
  const verdict = (row) => judgeService(row, BILLING).verdict;

  test('a plan visit for a call that named a one-time service: problem', () => {
    expect(judgeService(planVisit(), BILLING)).toEqual({ verdict: 'problem', heard: 'One-Time Pest Control Service' });
    // The stored reading may be a JSON string, and the name may carry stray spaces or another case.
    expect(verdict(planVisit({ ai_extraction_enriched: JSON.stringify(reading()) }))).toBe('problem');
    expect(verdict(heardAs({ specific_service_name: ' one-time  pest control SERVICE ' }))).toBe('problem');
  });

  test('they agree: a visit that is not a plan visit, a reading that names a plan, a reading that heard a plan ask', () => {
    expect(verdict(visit())).toBe('agrees');
    // A free visit (an assessment) is not a plan visit either.
    expect(verdict(planVisit({ row_billing_type: 'free' }))).toBe('agrees');
    // A corrected visit agrees whatever became of the reading.
    expect(verdict(visit({ v2_extraction_status: 'schema_failed', ai_extraction_enriched: null }))).toBe('agrees');
    expect(verdict(heardAs({ specific_service_name: 'Monthly Pest Control Service' }))).toBe('agrees');
    expect(verdict(heardAs({ service_intent: 'recurring_membership_inquiry' }))).toBe('agrees');
    // A billing choice the reading does not know is no evidence of a plan.
    expect(verdict(heardAs({ billing_choice: 'unsure' }))).toBe('problem');
  });

  test('unknown when one side cannot be read: never a problem, never an agreement', () => {
    for (const row of UNREADABLE) expect(verdict(row)).toBe('unknown');
  });
});

// The 2026-11-21 price: staff said "One-time service is $250, but it varies" and the caller booked. The reading
// holds it as one accepted one-time term, with no strict total.
const statedTerm = (over = {}) => ({ amount_usd: 250, amount_max_usd: null, unit: 'one_time', accepted: true, stated_by: 'agent', ...over });
const pricedReading = (over = {}, top = {}) => {
  const prices = over.prices || [statedTerm()];
  return { ...reading({ quoted_price_usd: null, price: prices[0], prices, ...over }), ...top };
};
// A one-time visit with no price whose call holds a price.
const unpriced = (over = {}) => visit({ estimated_price: null, ai_extraction_enriched: pricedReading(), ...over });
const pricedAs = (over, top) => unpriced({ ai_extraction_enriched: pricedReading(over, top) });
// One-time catalog rows a call booking never prices, each named by the call that booked it.
const namedVisit = (name, key) => unpriced({
  service_type: name, row_name: name, row_service_key: key, ai_extraction_enriched: pricedReading({ specific_service_name: name }),
});
const ASSESSMENT_AND_RE_SERVICE = [
  namedVisit('Waves Assessment', 'lawn_inspection'),
  namedVisit('Waves Assessment', 'some_other_key'),
  namedVisit('Renamed Look-Before-Quote Visit', 'lawn_inspection'),
  namedVisit('Pest Control Re-Service', 'pest_re_service'),
  namedVisit('Lawn Re-Service', 'lawn_re_service'),
];

describe('what a visit and the reading of its call say about the price', () => {
  const verdict = (row) => judgePrice(row, BILLING).verdict;

  test('a one-time visit with no price for a call that holds a stated price for that job: problem', () => {
    expect(judgePrice(unpriced(), BILLING)).toEqual({ verdict: 'problem', amount: 250 });
    // The 2026-11-21 reading: no total, and proof fields that speak of a total that is not there.
    expect(judgePrice(pricedAs({ price_offered_by_staff: false, price_accepted_by_caller: null, price_is_final: false, price_discussed: true }), BILLING))
      .toEqual({ verdict: 'problem', amount: 250 });
    expect(verdict(pricedAs({ service_intent: 'preventative_one_time' }))).toBe('problem');
    // The stored reading may be a JSON string, and the name may carry stray spaces or another case.
    expect(verdict(unpriced({ ai_extraction_enriched: JSON.stringify(pricedReading()) }))).toBe('problem');
    expect(verdict(pricedAs({ specific_service_name: ' one-time  pest control SERVICE ' }))).toBe('problem');
  });

  test('a call with an agreed total is not this check\'s case: the booking\'s own price rule reads that total', () => {
    for (const total of [350, 250, 0]) expect(verdict(pricedAs({ quoted_price_usd: total }))).toBe('unknown');
    expect(verdict(pricedAs({ quoted_price_usd: 350, prices: [], price: null }))).toBe('unknown');
  });

  test('agrees: the visit needs no price from the call', () => {
    // It has a price as completion billing reads one: a positive amount on the visit, or a stamped $0 next to a
    // line price (a free visit on purpose).
    for (const over of [{ estimated_price: 250 }, { estimated_price: '250.00' }, { estimated_price: 0, primary_line_price: '250.00' }]) {
      expect(verdict(unpriced(over))).toBe('agrees');
    }
    // No price of the visit's own: a line price alone, a discount alone. Completion has no amount to bill.
    for (const over of [{ primary_line_price: '250.00' }, { primary_line_price: 0 }, { discount_id: 'd1', discount_type: 'percent' }]) {
      expect(verdict(unpriced(over))).toBe('problem');
    }
    // It is not a one-time visit: a plan visit bills through the plan, a free visit bills nothing.
    expect(verdict(planVisit({ estimated_price: null, ai_extraction_enriched: pricedReading() }))).toBe('agrees');
    expect(verdict(unpriced({ row_billing_type: 'free' }))).toBe('agrees');
    // A free callback never takes a price.
    expect(verdict(unpriced({ is_callback: true }))).toBe('agrees');
    // The office made the visit recurring; the schedule editor keeps the one-time catalog row. It is a plan's visit now.
    expect(verdict(unpriced({ is_recurring: true }))).toBe('agrees');
    expect(verdict(unpriced({ recurring_parent_id: 'p1' }))).toBe('agrees');
    // A call booking never prices a Waves Assessment (by its key or its name) or a free re-service, even when
    // the call names that visit and speaks of a treatment price: that price is the quote, not this visit's charge.
    for (const row of ASSESSMENT_AND_RE_SERVICE) expect(verdict(row)).toBe('agrees');
    // Completion billing always treats these labels as free, on a one-time catalog row too: a price would be skipped.
    for (const label of ['Waves Pest Control Appointment Service', 'Estimate Visit', 'Pest Follow-Up']) {
      expect(verdict(namedVisit(label, 'general_appointment'))).toBe('agrees');
    }
    // The visit's own facts need no catalog row: a schedule edit can clear the row and make the visit a callback,
    // an appointment or a recurring visit.
    const noRow = { row_name: null, row_service_key: null, row_billing_type: null };
    for (const over of [{ is_callback: true }, { service_type: 'Waves Pest Control Appointment Service' }, { is_recurring: true }, { service_type: 'Waves Assessment' }, { service_type: 'Pest Re-Service' }]) {
      expect(verdict(unpriced({ ...noRow, ...over }))).toBe('agrees');
      expect(closeKeyFor('price', unpriced({ ...noRow, ...over }), BILLING)).toBe('noPriceNeeded');
    }
    // The label alone was changed to a Waves Assessment, and the one-time catalog row stayed.
    expect(verdict(unpriced({ service_type: 'Waves Assessment' }))).toBe('agrees');
    // A visit with a price agrees whatever became of the reading, and when its catalog row is gone.
    expect(verdict(unpriced({ estimated_price: 250, v2_extraction_status: 'schema_failed', ai_extraction_enriched: null }))).toBe('agrees');
    expect(verdict(unpriced({ estimated_price: 250, row_name: null, row_service_key: null, row_billing_type: null }))).toBe('agrees');
  });

  test('a bare $0 is a price only when completion billing honors it (GATE_STAMPED_ZERO_FREE)', () => {
    const before = process.env.GATE_STAMPED_ZERO_FREE;
    try {
      delete process.env.GATE_STAMPED_ZERO_FREE;
      expect(verdict(unpriced({ estimated_price: 0 }))).toBe('problem');
      process.env.GATE_STAMPED_ZERO_FREE = 'true';
      expect(verdict(unpriced({ estimated_price: 0 }))).toBe('agrees');
      expect(closeKeyFor('price', unpriced({ estimated_price: 0 }), BILLING)).toBe('price');
    } finally {
      if (before === undefined) delete process.env.GATE_STAMPED_ZERO_FREE; else process.env.GATE_STAMPED_ZERO_FREE = before;
    }
  });

  test('unknown when a side cannot be read, or the reading holds no price: never a problem, never an agreement', () => {
    const rows = [
      unpriced({ row_name: null, row_service_key: null, row_billing_type: null }),
      unpriced({ v2_extraction_status: 'schema_failed' }),
      ...[null, 'not json', {}, { service_request: 'text' }].map((stored) => unpriced({ ai_extraction_enriched: stored })),
      // No price on the call.
      unpriced({ ai_extraction_enriched: reading() }),
      pricedAs({ prices: [] , price: null }),
      // The reading says no price was discussed, and holds one.
      pricedAs({ price_discussed: false }),
      // An amount outside the booking's bounds is not a price.
      pricedAs({ prices: [statedTerm({ amount_usd: 3 })] }),
      // Nothing can tell which term stands: a range, two staff terms, a plan rate, the caller's own number, not accepted.
      pricedAs({ prices: [statedTerm({ amount_max_usd: 300 })] }),
      pricedAs({ prices: [statedTerm(), statedTerm({ amount_usd: 150, accepted: false })] }),
      pricedAs({ prices: [statedTerm({ unit: 'per_month' })] }),
      pricedAs({ prices: [statedTerm({ stated_by: 'caller' })] }),
      pricedAs({ prices: [statedTerm({ accepted: false })] }),
    ];
    for (const row of rows) expect(verdict(row)).toBe('unknown');
  });

  test('unknown unless the reading says the call was about a one-time job, with no plan on the call', () => {
    // Any other intent: a plan ask, an inspection, a quote, a follow-up, a complaint, a cancellation, none.
    for (const intent of ['recurring_membership_inquiry', 'inspection_only', 'quote_only', 'follow_up_existing_service', 'complaint_or_callback', 'cancellation_request', null, undefined]) {
      expect(verdict(pricedAs({ service_intent: intent }))).toBe('unknown');
    }
    // A plan on the call: a bundle category, a tier the caller named, the caller's choice of a plan's billing.
    expect(verdict(pricedAs({ primary_service_category: 'bundled_waveguard' }))).toBe('unknown');
    expect(verdict(pricedAs({ primary_service_category: 'pest_general' }))).toBe('problem');
    expect(verdict(pricedAs({ waveguard_tier_mentioned: 'gold' }))).toBe('unknown');
    for (const choice of ['annual_prepay', 'per_application']) expect(verdict(pricedAs({ billing_choice: choice }))).toBe('unknown');
    // A billing choice the reading does not know is no evidence of a plan.
    expect(verdict(pricedAs({ billing_choice: 'unsure' }))).toBe('problem');
    // A one-time fee the reading ties to a plan tier or to an annual prepay is the plan's fee. The mark counts on
    // any price term, the caller's own number too: the call spoke of a Waves plan.
    const callersNumber = (over = {}) => statedTerm({ amount_usd: 40, unit: 'per_month', stated_by: 'caller', accepted: false, ...over });
    for (const mark of [{ tier_mentioned: 'gold' }, { prepay_term: 'annual' }]) {
      expect(verdict(pricedAs({ prices: [statedTerm(mark)] }))).toBe('unknown');
      expect(verdict(pricedAs({ prices: [statedTerm(), callersNumber(mark)] }))).toBe('unknown');
    }
    // An entry with no amount that records a plan talk counts too.
    for (const mark of [{ tier_mentioned: 'silver' }, { prepay_term: 'annual' }]) {
      expect(verdict(pricedAs({ prices: [statedTerm(), { amount_usd: null, amount_max_usd: null, unit: null, accepted: null, stated_by: 'agent', ...mark }] }))).toBe('unknown');
    }
    // No plan mark: a prepay the call ruled out, and what the caller pays another company each month.
    expect(verdict(pricedAs({ prices: [statedTerm({ prepay_term: 'none', tier_mentioned: null })] }))).toBe('problem');
    expect(verdict(pricedAs({ prices: [statedTerm(), callersNumber()] }))).toBe('problem');
  });

  test('unknown when the price cannot be tied to this visit: another service, a second service, or a second property', () => {
    // The call spoke of a second service: the one accepted price can be that service's.
    expect(verdict(pricedAs({ secondary_categories: ['lawn_care'] }))).toBe('unknown');
    expect(verdict(pricedAs({ secondary_categories: [] }))).toBe('problem');
    // The reading's price block is call-wide. The call named one service; the visit is another.
    expect(verdict(unpriced({ row_name: 'Rodent Exclusion Service', service_type: 'Rodent Exclusion Service' }))).toBe('unknown');
    // The schedule editor can change the label alone: the catalog row still matches the call, the visit does not.
    expect(verdict(unpriced({ service_type: 'Rodent Exclusion Service' }))).toBe('unknown');
    expect(verdict(unpriced({ service_type: ' one-time pest control service' }))).toBe('problem');
    expect(verdict(pricedAs({ specific_service_name: 'Cockroach Treatment Service' }))).toBe('unknown');
    expect(verdict(pricedAs({ specific_service_name: null }))).toBe('unknown');
    // The catalog holds the name under two billing types: the price can be the plan's.
    expect(verdict(namedVisit('Shared Name', 'shared_one_time'))).toBe('unknown');
    // The catalog does not hold the name the visit and the reading share.
    expect(verdict(namedVisit('Some Service Nobody Sells', 'nobody'))).toBe('unknown');
    // The call spoke of a second property: the price can be the other one's.
    expect(verdict(pricedAs({}, { property: { additional_properties: [{ city: 'Venice' }] } }))).toBe('unknown');
    expect(verdict(pricedAs({}, { triage_flags: ['multi_property_call'] }))).toBe('unknown');
    // The reading itself could not tell the service, and still names the visit's.
    expect(verdict(pricedAs({}, { triage_flags: ['ambiguous_pest_or_service'] }))).toBe('unknown');
    expect(verdict(pricedAs({}, { property: { additional_properties: [] }, triage_flags: ['quote_promised'] }))).toBe('problem');
  });

  test('a visit has one problem at a time: the service first, the price once the visit is a one-time visit', () => {
    expect(problemOf(planVisit({ estimated_price: null, ai_extraction_enriched: pricedReading() }), BILLING))
      .toEqual({ kind: 'service', heard: 'One-Time Pest Control Service' });
    expect(problemOf(unpriced(), BILLING)).toEqual({ kind: 'price', amount: 250 });
    expect(problemOf(unpriced({ estimated_price: 250 }), BILLING)).toBeNull();
    expect(problemOf(visit(), BILLING)).toBeNull();
  });
});

describe('when an open bell closes', () => {
  test('it stays open while its problem stands, while the visit waits for a new time, and while a side cannot be read', () => {
    expect(closeKeyFor('service', planVisit(), BILLING)).toBeNull();
    expect(closeKeyFor('service', planVisit({ status: 'rescheduled' }), BILLING)).toBeNull();
    for (const row of UNREADABLE) expect(closeKeyFor('service', row, BILLING)).toBeNull();
  });

  test('it closes when the service was corrected', () => {
    expect(closeKeyFor('service', visit(), BILLING)).toBe('service');
  });

  test('it closes when the visit is done, cancelled or gone', () => {
    for (const status of ['completed', 'cancelled', 'canceled', 'no_show', 'skipped']) {
      expect(closeKeyFor('service', planVisit({ status }), BILLING)).toBe('visitClosed');
    }
    expect(closeKeyFor('service', undefined, BILLING)).toBe('gone');
    for (const key of ['service', 'price', 'noPriceNeeded', 'visitClosed', 'gone']) expect(CLOSED[key].text).toMatch(/^The visit /);
  });

  test('a price bell stays open while the visit has no price, whatever became of the reading', () => {
    expect(closeKeyFor('price', unpriced(), BILLING)).toBeNull();
    expect(closeKeyFor('price', unpriced({ status: 'rescheduled' }), BILLING)).toBeNull();
    // The call is being processed again, or its reading holds no price now: the visit still has no price.
    expect(closeKeyFor('price', unpriced({ v2_extraction_status: 'schema_failed' }), BILLING)).toBeNull();
    expect(closeKeyFor('price', unpriced({ ai_extraction_enriched: reading() }), BILLING)).toBeNull();
    // A discount with no amount: completion still has nothing to bill.
    expect(closeKeyFor('price', unpriced({ discount_id: 'd1', discount_type: 'percent' }), BILLING)).toBeNull();
    // The call was read again: another number, an agreed total, another service. The bell says the visit has no
    // price, and that is still so.
    expect(closeKeyFor('price', pricedAs({ prices: [statedTerm({ amount_usd: 300 })] }), BILLING)).toBeNull();
    expect(closeKeyFor('price', pricedAs({ quoted_price_usd: 350 }), BILLING)).toBeNull();
    expect(closeKeyFor('price', unpriced({ row_name: 'Rodent Exclusion Service', service_type: 'Rodent Exclusion Service' }), BILLING)).toBeNull();
    expect(closeKeyFor('price', unpriced({ service_type: 'Rodent Exclusion Service' }), BILLING)).toBeNull();
    expect(closeKeyFor('price', unpriced({ row_name: null, row_service_key: null, row_billing_type: null }), BILLING)).toBeNull();
  });

  test('a price bell closes when the visit has a price, when it is no longer a one-time visit, and when it is done, cancelled or gone', () => {
    expect(closeKeyFor('price', unpriced({ estimated_price: 275 }), BILLING)).toBe('price');
    expect(closeKeyFor('price', unpriced({ estimated_price: 0, primary_line_price: 275 }), BILLING)).toBe('price');
    // A line price alone is no price of the visit's own: completion does not bill it.
    expect(closeKeyFor('price', unpriced({ primary_line_price: 275 }), BILLING)).toBeNull();
    // The office changed the visit to an appointment, which completion never bills: no price is needed.
    expect(closeKeyFor('price', unpriced({ service_type: 'Waves Pest Control Appointment Service' }), BILLING)).toBe('noPriceNeeded');
    // Staff set a price on a visit whose catalog row is gone: the bell still closes.
    expect(closeKeyFor('price', unpriced({ estimated_price: 275, row_name: null, row_service_key: null, row_billing_type: null }), BILLING)).toBe('price');
    for (const row of ASSESSMENT_AND_RE_SERVICE) expect(closeKeyFor('price', row, BILLING)).toBe('noPriceNeeded');
    expect(closeKeyFor('price', planVisit({ estimated_price: null, ai_extraction_enriched: pricedReading() }), BILLING)).toBe('noPriceNeeded');
    expect(closeKeyFor('price', unpriced({ is_callback: true }), BILLING)).toBe('noPriceNeeded');
    expect(closeKeyFor('price', unpriced({ is_recurring: true }), BILLING)).toBe('noPriceNeeded');
    expect(closeKeyFor('price', unpriced({ status: 'completed' }), BILLING)).toBe('visitClosed');
    expect(closeKeyFor('price', undefined, BILLING)).toBe('gone');
  });
});

describe('the bell copy passes the notification rule', () => {
  const heard = 'One-Time Pest Control Service';

  test('the name, both services, and a link that opens the visit', () => {
    const composed = composeAdminAlert(specFor({ visit: planVisit(), heard, name: 'Pat Synthetic' }));
    expect(composed.headline).toBe("Schedule — check the service on Pat Synthetic's visit");
    expect(composed.why).toBe('Booked as Monthly Pest Control Service; the call asked for One-Time Pest Control Service.');
    expect(composed.link).toBe('/admin/dispatch?tab=schedule&date=2026-11-21&appointment=11111111-2222-4333-8444-555555555555');
    expect(composed.metadata).toMatchObject({ area: 'Schedule', severity: 'needs-you', who: 'person', doneWhen: 'visit_service_one_time', subject: { type: 'visit', id: '11111111-2222-4333-8444-555555555555' } });
  });

  test('a long name, no name and long service names still fit', () => {
    const longService = 'General Pest Control Service With A Very Long Catalog Name (Bi-Monthly)';
    for (const name of ['Bartholomew Featherstonehaugh-Montgomery', '']) {
      const spec = specFor({ visit: planVisit({ row_name: longService }), heard: longService, name });
      expect(() => composeAdminAlert(spec)).not.toThrow();
    }
    expect(composeAdminAlert(specFor({ visit: planVisit(), heard, name: '' })).headline).toBe('Schedule — check the service on a phone-booked visit');
  });

  test('the detail says what to do and that nothing was changed', () => {
    expect(detailFor({ visit: planVisit(), heard, name: 'Pat Synthetic' }))
      .toBe('Pat Synthetic: the visit booked from a phone call for 2026-11-21 is "Monthly Pest Control Service", a plan visit. The call\'s reading names "One-Time Pest Control Service", a one-time service. Change the visit\'s service if the caller asked for a one-time job. Nothing was changed and the customer was not contacted.');
    expect(detailFor({ visit: planVisit(), heard, name: '' })).toMatch(/^A customer: /);
  });
});

describe('the price bell copy passes the notification rule', () => {
  test('the name, a why with no number, and a link that opens the visit', () => {
    const composed = composeAdminAlert(priceSpecFor({ visit: unpriced(), name: 'Pat Synthetic' }));
    expect(composed.headline).toBe("Schedule — set the price on Pat Synthetic's visit");
    // A row is never rewritten and the call can be read again: the headline and the why hold no number.
    expect(composed.why).toBe('The visit has no price; when this bell rang, its call held a price for the service it had then.');
    expect(`${composed.headline} ${composed.why}`).not.toMatch(/\d/);
    expect(composed.link).toBe('/admin/dispatch?tab=schedule&date=2026-11-21&appointment=11111111-2222-4333-8444-555555555555');
    expect(composed.metadata).toMatchObject({ area: 'Schedule', severity: 'needs-you', who: 'person', doneWhen: 'visit_priced', subject: { type: 'visit', id: '11111111-2222-4333-8444-555555555555' } });
  });

  test('a long name and no name still fit', () => {
    for (const name of ['Bartholomew Featherstonehaugh-Montgomery', '']) {
      expect(() => composeAdminAlert(priceSpecFor({ visit: unpriced(), name }))).not.toThrow();
    }
    expect(composeAdminAlert(priceSpecFor({ visit: unpriced(), name: '' })).headline).toBe('Schedule — set the price on a phone-booked visit');
  });

  test('the detail names the invoice switch only while it is off', () => {
    expect(priceDetailFor({ visit: unpriced({ create_invoice_on_complete: true }), amount: 250, name: 'Pat Synthetic' }))
      .toMatch(/then set the visit's price before it is billed\. Nothing was changed and the customer was not contacted\.$/);
  });

  test('the detail gives the number as a dated fact, sends the reader to the call, and says nothing was changed', () => {
    expect(priceDetailFor({ visit: unpriced(), amount: 250, name: 'Pat Synthetic' }))
      .toBe('Pat Synthetic: the visit booked from a phone call for 2026-11-21 is "One-Time Pest Control Service", a one-time visit with no price. When this bell rang, the reading of the call held $250 for that service: a price staff stated and the caller accepted, not confirmed as final (it can vary, or a charge was added). Check the call and the visit as it is now, then set the visit\'s price before it is billed. "Create invoice on completion" is off on this visit: check how the visit bills when you set the price. Nothing was changed and the customer was not contacted.');
    expect(priceDetailFor({ visit: unpriced(), amount: 149.5, name: '' }))
      .toBe('A customer: the visit booked from a phone call for 2026-11-21 is "One-Time Pest Control Service", a one-time visit with no price. When this bell rang, the reading of the call held $149.50 for that service: a price staff stated and the caller accepted, not confirmed as final (it can vary, or a charge was added). Check the call and the visit as it is now, then set the visit\'s price before it is billed. "Create invoice on completion" is off on this visit: check how the visit bills when you set the price. Nothing was changed and the customer was not contacted.');
  });
});

describe('the run', () => {
  test('it stands down, before any read, when alert episodes are off', async () => {
    const gates = require('../config/feature-gates');
    const live = jest.spyOn(gates, 'alertEpisodesLive').mockReturnValue(false);
    await expect(runCallBookingCheck()).resolves.toEqual({ skipped: 'episodes_off' });
    expect(require('../models/db')).not.toHaveBeenCalled();
    live.mockRestore();
  });
});
