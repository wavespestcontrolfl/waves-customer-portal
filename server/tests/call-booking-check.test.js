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
// The same visit for a call that agreed a total: the strict field, and the one accepted one-time term it names.
const totalAs = (over = {}, top) => pricedAs({ quoted_price_usd: 350, prices: [statedTerm({ amount_usd: 350 })], ...over }, top);
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

  test('a one-time visit with no price for a call that holds a price for that job: problem', () => {
    expect(judgePrice(unpriced(), BILLING)).toEqual({ verdict: 'problem', amount: 250, agreed: false });
    // The total the call agreed outranks any term.
    expect(judgePrice(totalAs(), BILLING)).toEqual({ verdict: 'problem', amount: 350, agreed: true });
    expect(judgePrice(pricedAs({ quoted_price_usd: 149.5, prices: [] }), BILLING)).toEqual({ verdict: 'problem', amount: 149.5, agreed: true });
    // The stored reading may be a JSON string, and the name may carry stray spaces or another case.
    expect(verdict(unpriced({ ai_extraction_enriched: JSON.stringify(pricedReading()) }))).toBe('problem');
    expect(verdict(pricedAs({ specific_service_name: ' one-time  pest control SERVICE ' }))).toBe('problem');
  });

  test('a total reads as agreed only when the reading does not mark it as changed after it was accepted', () => {
    const proofs = { price_offered_by_staff: true, price_accepted_by_caller: true };
    expect(judgePrice(totalAs({ ...proofs, price_is_final: true }), BILLING)).toEqual({ verdict: 'problem', amount: 350, agreed: true });
    // An older reading carries no proof fields.
    expect(judgePrice(totalAs(), BILLING).agreed).toBe(true);
    // A later correction or an added charge: the number is shown, never as the agreed total.
    expect(judgePrice(totalAs({ ...proofs, price_is_final: false }), BILLING)).toEqual({ verdict: 'problem', amount: 350, agreed: false });
    // The 2026-11-21 reading: no total, the proof fields speak of a total that is not there. The stated price stands.
    expect(judgePrice(pricedAs({ price_offered_by_staff: false, price_accepted_by_caller: null, price_is_final: false, price_discussed: true }), BILLING))
      .toEqual({ verdict: 'problem', amount: 250, agreed: false });
  });

  test('agrees: the visit needs no price from the call', () => {
    // It has a stored amount, on the visit or on its primary line; a stored $0 too (a free visit is a decision).
    for (const over of [{ estimated_price: 250 }, { estimated_price: '250.00' }, { estimated_price: 0 }, { primary_line_price: '250.00' }, { primary_line_price: 0 }]) {
      expect(verdict(unpriced(over))).toBe('agrees');
    }
    // A discount alone is no price: completion still has no amount to bill.
    expect(verdict(unpriced({ discount_id: 'd1', discount_type: 'percent' }))).toBe('problem');
    // It is not a one-time visit: a plan visit bills through the plan, a free visit bills nothing.
    expect(verdict(planVisit({ estimated_price: null, ai_extraction_enriched: pricedReading() }))).toBe('agrees');
    expect(verdict(unpriced({ row_billing_type: 'free' }))).toBe('agrees');
    // A free callback never takes a price.
    expect(verdict(unpriced({ is_callback: true }))).toBe('agrees');
    // A call booking never prices a Waves Assessment (by its key or its name) or a free re-service, even when
    // the call names that visit and speaks of a treatment price: that price is the quote, not this visit's charge.
    for (const row of ASSESSMENT_AND_RE_SERVICE) expect(verdict(row)).toBe('agrees');
    // A visit with a price agrees whatever became of the reading, and when its catalog row is gone.
    expect(verdict(unpriced({ estimated_price: 250, v2_extraction_status: 'schema_failed', ai_extraction_enriched: null }))).toBe('agrees');
    expect(verdict(unpriced({ estimated_price: 250, row_name: null, row_service_key: null, row_billing_type: null }))).toBe('agrees');
  });

  test('unknown when a side cannot be read, or the reading holds no price: never a problem, never an agreement', () => {
    const rows = [
      unpriced({ row_name: null, row_service_key: null, row_billing_type: null }),
      unpriced({ v2_extraction_status: 'schema_failed' }),
      ...[null, 'not json', {}, { service_request: 'text' }].map((stored) => unpriced({ ai_extraction_enriched: stored })),
      // No price on the call.
      unpriced({ ai_extraction_enriched: reading() }),
      pricedAs({ prices: [] , price: null }),
      // The reading disputes its own total: staff did not offer it, or the caller did not accept it.
      totalAs({ price_offered_by_staff: false }),
      totalAs({ price_accepted_by_caller: false }),
      // The schema writes null in a proof when no price was discussed: a total next to it contradicts it.
      totalAs({ price_offered_by_staff: null, price_accepted_by_caller: null, price_is_final: null }),
      totalAs({ price_offered_by_staff: true, price_accepted_by_caller: true, price_is_final: null }),
      // The reading says no price was discussed, and holds one.
      pricedAs({ price_discussed: false }),
      totalAs({ price_discussed: false }),
      // A $0 total is a free booking; an amount outside the booking's bounds is not a price.
      pricedAs({ quoted_price_usd: 0, prices: [] }),
      pricedAs({ quoted_price_usd: 3, prices: [] }),
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

  test('a total is a one-time total only when the terms the caller accepted do not say otherwise', () => {
    // The one accepted term is the total's own one-time amount, or an older reading carries no term at all.
    expect(verdict(totalAs())).toBe('problem');
    expect(verdict(totalAs({ prices: [], price: null }))).toBe('problem');
    // "$350" next to an accepted "$350 per quarter" is a plan rate; a term with no unit says nothing.
    for (const unit of ['per_quarter', 'per_month', 'per_application', 'per_year', 'unknown', null]) {
      expect(verdict(totalAs({ prices: [statedTerm({ amount_usd: 350, unit })] }))).toBe('unknown');
    }
    // A second accepted term, a range, or a term with another amount: the visit's share is not known.
    expect(verdict(totalAs({ prices: [statedTerm({ amount_usd: 350 }), statedTerm({ amount_usd: 31, unit: 'per_month' })] }))).toBe('unknown');
    expect(verdict(totalAs({ prices: [statedTerm({ amount_usd: 350, amount_max_usd: 400 })] }))).toBe('unknown');
    expect(verdict(totalAs({ prices: [statedTerm({ amount_usd: 250 })] }))).toBe('unknown');
    // A term nobody accepted does not count against the total, next to the one the caller accepted.
    expect(verdict(totalAs({ prices: [statedTerm({ amount_usd: 350 }), statedTerm({ amount_usd: 99, unit: 'per_month', accepted: false })] }))).toBe('problem');
    // Terms of which the caller accepted none contradict a total: the price was declined, or got no answer.
    expect(verdict(totalAs({ prices: [statedTerm({ amount_usd: 350, accepted: false, caller_response: 'declined' })] }))).toBe('unknown');
    expect(verdict(totalAs({ prices: [statedTerm({ amount_usd: 350, accepted: null, caller_response: 'no_response' })] }))).toBe('unknown');
  });

  test('unknown when the reading records a plan ask or a plan billing choice: the price can be the plan\'s', () => {
    expect(verdict(pricedAs({ service_intent: 'recurring_membership_inquiry' }))).toBe('unknown');
    for (const choice of ['annual_prepay', 'per_application']) {
      expect(verdict(pricedAs({ billing_choice: choice }))).toBe('unknown');
      expect(verdict(totalAs({ billing_choice: choice }))).toBe('unknown');
    }
    // A billing choice the reading does not know is no evidence of a plan.
    expect(verdict(pricedAs({ billing_choice: 'unsure' }))).toBe('problem');
  });

  test('unknown when the price cannot be tied to this visit: another service, a second service, or a second property', () => {
    // The call spoke of a second service: the one accepted price can be that service's.
    expect(verdict(pricedAs({ secondary_categories: ['lawn_care'] }))).toBe('unknown');
    expect(verdict(totalAs({ secondary_categories: ['lawn_care'] }))).toBe('unknown');
    expect(verdict(pricedAs({ secondary_categories: [] }))).toBe('problem');
    // The reading's price block is call-wide. The call named one service; the visit is another.
    expect(verdict(unpriced({ row_name: 'Rodent Exclusion Service', service_type: 'Rodent Exclusion Service' }))).toBe('unknown');
    expect(verdict(pricedAs({ specific_service_name: 'Cockroach Treatment Service' }))).toBe('unknown');
    expect(verdict(pricedAs({ specific_service_name: null }))).toBe('unknown');
    // The catalog holds the name under two billing types: the price can be the plan's.
    expect(verdict(namedVisit('Shared Name', 'shared_one_time'))).toBe('unknown');
    // The catalog does not hold the name the visit and the reading share.
    expect(verdict(namedVisit('Some Service Nobody Sells', 'nobody'))).toBe('unknown');
    // The call spoke of a second property: the price can be the other one's.
    expect(verdict(pricedAs({}, { property: { additional_properties: [{ city: 'Venice' }] } }))).toBe('unknown');
    expect(verdict(totalAs({}, { property: { additional_properties: [{ city: 'Venice' }] } }))).toBe('unknown');
    expect(verdict(pricedAs({}, { property: { additional_properties: [] } }))).toBe('problem');
  });

  test('a visit has one problem at a time: the service first, the price once the visit is a one-time visit', () => {
    expect(problemOf(planVisit({ estimated_price: null, ai_extraction_enriched: pricedReading() }), BILLING))
      .toEqual({ kind: 'service', heard: 'One-Time Pest Control Service' });
    expect(problemOf(unpriced(), BILLING)).toEqual({ kind: 'price', amount: 250, agreed: false });
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
    // The call was read again: another number, a disputed total, another service. The bell says the visit has no
    // price, and that is still so.
    expect(closeKeyFor('price', totalAs({ quoted_price_usd: 300, prices: [statedTerm({ amount_usd: 300 })] }), BILLING)).toBeNull();
    expect(closeKeyFor('price', totalAs({ price_accepted_by_caller: false }), BILLING)).toBeNull();
    expect(closeKeyFor('price', unpriced({ row_name: 'Rodent Exclusion Service', service_type: 'Rodent Exclusion Service' }), BILLING)).toBeNull();
    expect(closeKeyFor('price', unpriced({ row_name: null, row_service_key: null, row_billing_type: null }), BILLING)).toBeNull();
  });

  test('a price bell closes when the visit has a price, when it is no longer a one-time visit, and when it is done, cancelled or gone', () => {
    expect(closeKeyFor('price', unpriced({ estimated_price: 275 }), BILLING)).toBe('price');
    expect(closeKeyFor('price', unpriced({ estimated_price: 0 }), BILLING)).toBe('price');
    expect(closeKeyFor('price', unpriced({ primary_line_price: 275 }), BILLING)).toBe('price');
    // Staff set a price on a visit whose catalog row is gone: the bell still closes.
    expect(closeKeyFor('price', unpriced({ estimated_price: 275, row_name: null, row_service_key: null, row_billing_type: null }), BILLING)).toBe('price');
    for (const row of ASSESSMENT_AND_RE_SERVICE) expect(closeKeyFor('price', row, BILLING)).toBe('noPriceNeeded');
    expect(closeKeyFor('price', planVisit({ estimated_price: null, ai_extraction_enriched: pricedReading() }), BILLING)).toBe('noPriceNeeded');
    expect(closeKeyFor('price', unpriced({ is_callback: true }), BILLING)).toBe('noPriceNeeded');
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
    const composed = composeAdminAlert(priceSpecFor({ visit: unpriced(), amount: 250, agreed: false, name: 'Pat Synthetic' }));
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
    expect(composeAdminAlert(priceSpecFor({ visit: unpriced(), amount: 250, agreed: false, name: '' })).headline).toBe('Schedule — set the price on a phone-booked visit');
  });

  test('the detail gives the number as a dated fact, sends the reader to the call, and says nothing was changed', () => {
    expect(priceDetailFor({ visit: unpriced(), amount: 250, agreed: false, name: 'Pat Synthetic' }))
      .toBe('Pat Synthetic: the visit booked from a phone call for 2026-11-21 is "One-Time Pest Control Service", a one-time visit with no price. When this bell rang, the reading of the call held $250 for that service: a price staff stated and the caller accepted, not confirmed as final (it can vary, or a charge was added). Check the call and the visit as it is now, then set the visit\'s price before it is billed. Nothing was changed and the customer was not contacted.');
    expect(priceDetailFor({ visit: unpriced(), amount: 149.5, agreed: true, name: '' }))
      .toBe('A customer: the visit booked from a phone call for 2026-11-21 is "One-Time Pest Control Service", a one-time visit with no price. When this bell rang, the reading of the call held $149.50 for that service: the total the caller accepted. Check the call and the visit as it is now, then set the visit\'s price before it is billed. Nothing was changed and the customer was not contacted.');
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
