/**
 * An assessment is NOT a win (owner ruling 2026-09-08).
 *
 * Pins the shared predicate (services/assessment-booking.js) and the
 * customer-stage promotion helper's refusal: booking a Waves Assessment must
 * leave the customer row in its lead stage with no member_since stamp. Route-
 * level coverage lives in admin-leads-convert-dupes.test.js (leads page) and
 * call-lead-booking-conversion.test.js (phone booking).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-09-08' }));

const db = require('../models/db');
const {
  isAssessmentServiceType,
  isAssessmentServiceRow,
  isAssessmentBooking,
} = require('../services/assessment-booking');
const { promoteCustomerOnBooking } = require('../services/customer-stages');

describe('assessment-booking predicate', () => {
  test('matches the catalog name case-insensitively and trimmed, nothing broader', () => {
    expect(isAssessmentServiceType('  waves assessment ')).toBe(true);
    expect(isAssessmentServiceType('Waves Assessment')).toBe(true);
    expect(isAssessmentServiceType('Waves Assessment Plus')).toBe(false);
    expect(isAssessmentServiceType('WDO Inspection Service')).toBe(false); // paid inspection = a sale
    expect(isAssessmentServiceType(null)).toBe(false);
  });

  test('matches the catalog row by service_key or name', () => {
    expect(isAssessmentServiceRow({ service_key: 'lawn_inspection', name: 'Renamed' })).toBe(true);
    expect(isAssessmentServiceRow({ service_key: 'pest_control', name: 'Waves Assessment' })).toBe(true);
    expect(isAssessmentServiceRow({ service_key: 'pest_control', name: 'Quarterly Pest Control' })).toBe(false);
    expect(isAssessmentServiceRow(null)).toBe(false);
  });

  test('a booking row resolves by denormalized name first, then the catalog FK', async () => {
    const first = jest.fn(async () => ({ service_key: 'lawn_inspection' }));
    const database = jest.fn(() => ({ where: () => ({ first }) }));
    expect(await isAssessmentBooking({ service_type: 'Waves Assessment', service_id: 'svc-1' }, database)).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(await isAssessmentBooking({ service_type: 'Consultation', service_id: 'svc-1' }, database)).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(await isAssessmentBooking({ service_type: 'Consultation', service_id: null }, database)).toBe(false);
  });
});

describe('promoteCustomerOnBooking — assessments promote nothing', () => {
  function makeDb(customer) {
    const update = jest.fn(async () => 1);
    const first = jest.fn(async () => customer);
    const database = jest.fn(() => ({ where: () => ({ first, update }) }));
    return { database, update, first };
  }

  test('a Waves Assessment booking returns false before reading the row', async () => {
    const { database, update, first } = makeDb({ id: 'c1', pipeline_stage: 'new_lead', active: true, churned_at: null });
    expect(await promoteCustomerOnBooking(database, 'c1', { serviceType: 'Waves Assessment' })).toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('any other booking still promotes a lead-stage row to won', async () => {
    const { database, update } = makeDb({ id: 'c1', pipeline_stage: 'new_lead', active: true, churned_at: null, member_since: null });
    expect(await promoteCustomerOnBooking(database, 'c1', { serviceType: 'Quarterly Pest Control Service' })).toBe(true);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ pipeline_stage: 'won', member_since: '2026-09-08' }));
  });

  test('callers that pass no service keep the historical promotion', async () => {
    const { database, update } = makeDb({ id: 'c1', pipeline_stage: 'contacted', active: true, churned_at: null });
    expect(await promoteCustomerOnBooking(database, 'c1')).toBe(true);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ pipeline_stage: 'won' }));
    expect(db).not.toHaveBeenCalled();
  });
});
