/**
 * Call booking check (owner 2026-11-22, "fix"), the pure part: which problem a call-booked visit has (a plan visit
 * for a call that named a one-time service), when an open bell closes, and the bell copy through the real
 * composeAdminAlert. The SQL side runs in call-booking-check-postgres.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { composeAdminAlert } = require('../services/admin-alert-compose');
const { runCallBookingCheck, _private } = require('../services/call-booking-check');

const { problemOf, closeKeyFor, specFor, detailFor, CLOSED } = _private;

const BILLING = new Map([
  ['one-time pest control service', 'one_time'],
  ['monthly pest control service', 'recurring'],
  ['shared name', null],
]);

// The 2026-11-21 call as it was stored: the reading names a one-time service.
const reading = (over = {}) => ({ service_request: { specific_service_name: 'One-Time Pest Control Service', ...over } });
const visit = (over = {}) => ({
  id: '11111111-2222-4333-8444-555555555555', customer_id: 'c1', status: 'confirmed', visit_date: '2026-11-21',
  service_type: 'One-Time Pest Control Service',
  row_name: 'One-Time Pest Control Service', row_service_key: 'one_time_pest_control', row_billing_type: 'one_time',
  ai_extraction_enriched: reading(),
  ...over,
});
const planVisit = (over = {}) => visit({
  service_type: 'Monthly Pest Control Service', row_name: 'Monthly Pest Control Service',
  row_service_key: 'pest_general_monthly', row_billing_type: 'recurring', ...over,
});

describe('the problem a visit has', () => {
  test('a plan visit for a call that named a one-time service: service', () => {
    expect(problemOf(planVisit(), BILLING)).toEqual({ kind: 'service', heard: 'One-Time Pest Control Service' });
    // The stored reading may be a JSON string, and the name may carry stray spaces or another case.
    expect(problemOf(planVisit({ ai_extraction_enriched: JSON.stringify(reading()) }), BILLING).kind).toBe('service');
    expect(problemOf(planVisit({ ai_extraction_enriched: reading({ specific_service_name: ' one-time  pest control SERVICE ' }) }), BILLING).kind).toBe('service');
  });

  test('no problem when the visit agrees with the call', () => {
    expect(problemOf(visit(), BILLING)).toBeNull();
    // A plan visit for a call that named a plan.
    expect(problemOf(planVisit({ ai_extraction_enriched: reading({ specific_service_name: 'Monthly Pest Control Service' }) }), BILLING)).toBeNull();
  });

  test('a service the catalog does not hold, or holds under two billing types, is not a problem', () => {
    for (const name of ['Some Service Nobody Sells', 'Shared Name', null]) {
      expect(problemOf(planVisit({ ai_extraction_enriched: reading({ specific_service_name: name }) }), BILLING)).toBeNull();
    }
  });

  test('a visit with no catalog row has an unknown billing type: no problem', () => {
    expect(problemOf(planVisit({ row_name: null, row_service_key: null, row_billing_type: null }), BILLING)).toBeNull();
  });

  test('no stored reading, no problem', () => {
    for (const stored of [null, 'not json', {}, { service_request: 'text' }]) {
      expect(problemOf(planVisit({ ai_extraction_enriched: stored }), BILLING)).toBeNull();
    }
  });
});

describe('when an open bell closes', () => {
  test('it stays open while its problem stands', () => {
    expect(closeKeyFor('service', planVisit(), BILLING)).toBeNull();
  });

  test('it closes when the service was corrected', () => {
    expect(closeKeyFor('service', visit(), BILLING)).toBe('service');
  });

  test('it closes when the visit is done, cancelled or gone', () => {
    for (const status of ['completed', 'cancelled', 'rescheduled', 'skipped']) {
      expect(closeKeyFor('service', planVisit({ status }), BILLING)).toBe('visitClosed');
    }
    expect(closeKeyFor('service', undefined, BILLING)).toBe('gone');
    for (const key of ['service', 'visitClosed', 'gone']) expect(CLOSED[key].text).toMatch(/^The visit /);
  });
});

describe('the bell copy passes the notification rule', () => {
  const service = { kind: 'service', heard: 'One-Time Pest Control Service' };

  test('the name, both services, and a link that opens the visit', () => {
    const composed = composeAdminAlert(specFor({ visit: planVisit(), problem: service, name: 'Pat Synthetic' }));
    expect(composed.headline).toBe("Schedule — check the service on Pat Synthetic's visit");
    expect(composed.why).toBe('Booked as Monthly Pest Control Service; the call asked for One-Time Pest Control Service.');
    expect(composed.link).toBe('/admin/dispatch?tab=schedule&date=2026-11-21&appointment=11111111-2222-4333-8444-555555555555');
    expect(composed.metadata).toMatchObject({ area: 'Schedule', severity: 'needs-you', who: 'person', doneWhen: 'visit_service_one_time', subject: { type: 'visit', id: '11111111-2222-4333-8444-555555555555' } });
  });

  test('a long name, no name and long service names still fit', () => {
    const longService = 'General Pest Control Service With A Very Long Catalog Name (Bi-Monthly)';
    for (const name of ['Bartholomew Featherstonehaugh-Montgomery', '']) {
      const spec = specFor({ visit: planVisit({ row_name: longService }), problem: { ...service, heard: longService }, name });
      expect(() => composeAdminAlert(spec)).not.toThrow();
    }
    expect(composeAdminAlert(specFor({ visit: planVisit(), problem: service, name: '' })).headline).toBe('Schedule — check the service on a phone-booked visit');
  });

  test('the detail says what to do and that nothing was changed', () => {
    expect(detailFor({ visit: planVisit(), problem: service, name: 'Pat Synthetic' }))
      .toBe('Pat Synthetic: the visit booked from a phone call for 2026-11-21 is "Monthly Pest Control Service", a plan visit. The call\'s reading names "One-Time Pest Control Service", a one-time service. Change the visit\'s service if the caller asked for a one-time job. Nothing was changed and the customer was not contacted.');
    expect(detailFor({ visit: planVisit(), problem: service, name: '' })).toMatch(/^A customer: /);
  });
});

describe('the run', () => {
  test('it stands down, before any read, when alert episodes are off', async () => {
    const gates = require('../config/feature-gates');
    const live = jest.spyOn(gates, 'alertEpisodesLive').mockReturnValue(false);
    const database = jest.fn(() => { throw new Error('no read expected'); });
    await expect(runCallBookingCheck({ database })).resolves.toEqual({ skipped: 'episodes_off' });
    expect(database).not.toHaveBeenCalled();
    live.mockRestore();
  });
});
