// A visit booked by address only (customer_id NULL, no reservation hold) cannot be completed or billed:
// service_records and invoices both need a customer. The closeout refuses it with a 409 before any claim
// or write, and the invoice writers refuse it with the same typed error. A visit that has a customer is
// untouched. Mocked database; the visit it reads is the only fixture.
process.env.JWT_SECRET = 'completion-service-test-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => sql);
  db.schema = { hasColumn: jest.fn(async () => false), hasTable: jest.fn(async () => false) };
  db.transaction = jest.fn(async (callback) => callback(db));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/completion-attempts', () => ({
  COMPLETION_SMS_DEFINITE_REJECTION_PREFIX: jest.requireActual('../services/completion-attempts').COMPLETION_SMS_DEFINITE_REJECTION_PREFIX,
  STALE_SIDE_EFFECTS_MS: jest.requireActual('../services/completion-attempts').STALE_SIDE_EFFECTS_MS,
  claimCompletionAttempt: jest.fn(),
  hashCompletionRequest: jest.fn(() => 'synthetic-request-hash'),
  markCompletionAttemptFailed: jest.fn(async () => {}),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({})),
}));
jest.mock('../services/visit-groups', () => ({ lockStopForRow: jest.fn(async () => {}), stopBaseKey: jest.fn(() => 'fixture-stop') }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: jest.fn(async () => null) }));

const db = require('../models/db');
const attempts = require('../services/completion-attempts');
const { completeScheduledService } = require('../services/complete-scheduled-service');
const InvoiceService = require('../services/invoice');
const { mintScheduledServiceInvoiceWithDeposit } = require('../services/scheduled-invoice-mint');
const { VISIT_NO_CUSTOMER_CODE, VISIT_NO_CUSTOMER_MESSAGE } = require('../services/invoice-helpers');
const { etDateString } = require('../utils/datetime-et');
const completionObservationCatalog = require('../../shared/service-completion-observations.json');

const SERVICE_ID = '00000000-0000-4000-8000-000000000501';
const TECH_ID = '00000000-0000-4000-8000-000000000502';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000503';
const actor = { techRole: 'technician', technicianId: TECH_ID };
let service;
let builder;

beforeEach(() => {
  jest.clearAllMocks();
  service = {
    id: SERVICE_ID,
    customer_id: null,
    technician_id: TECH_ID,
    service_type: 'Every 6 Weeks Lawn Care Service',
    scheduled_date: etDateString(),
    status: 'on_site',
  };
  builder = {};
  for (const method of ['where', 'leftJoin', 'select', 'orderBy', 'whereNot', 'whereIn', 'whereRaw', 'forUpdate', 'whereNotNull', 'whereNull', 'limit']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.first = jest.fn(async () => service);
  builder.columnInfo = jest.fn(async () => ({}));
  builder.insert = jest.fn(() => builder);
  builder.update = jest.fn(async () => 1);
  builder.returning = jest.fn(async () => []);
  builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  db.mockImplementation(() => builder);
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'proceed', attempt: { id: 'fixture-attempt' } });
});

const complete = (body = {}) => completeScheduledService({ serviceId: SERVICE_ID, body, actor });
// A closeout that passes the customer check meets the next refusal down the line (mutually exclusive
// observations, a 422 raised before any write), which proves the request got past it.
const conflicting = completionObservationCatalog.lawn.filter(([id]) => ['dry-root-zone', 'saturated-soil'].includes(id)).map(([, label]) => label);

describe('completion of a visit with no customer yet', () => {
  test('is refused with a 409 and the office message, before any claim or write', async () => {
    const result = await complete({ structuredObservations: conflicting });

    expect(result).toEqual({ status: 409, body: { error: 'This visit has no customer yet. Link a customer before completing it.', code: 'visit_has_no_customer' } });
    expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(builder.insert).not.toHaveBeenCalled();
    expect(builder.update).not.toHaveBeenCalled();
  });

  test('a visit that has a customer is not refused and reaches the next ordinary check', async () => {
    service.customer_id = CUSTOMER_ID;

    const result = await complete({ structuredObservations: conflicting });

    expect(result).toMatchObject({ status: 422, body: { code: 'conflicting_structured_observations' } });
  });
});

describe('invoice writers refuse a visit with no customer yet', () => {
  test('the scheduled-visit mint throws the typed 409 under the visit lock, after the ownership recheck, before it builds an invoice', async () => {
    const buildCreateParams = jest.fn();
    const assertEligibleInTrx = jest.fn(async () => {});

    await expect(mintScheduledServiceInvoiceWithDeposit({ svc: { id: SERVICE_ID, customer_id: null }, buildCreateParams, assertEligibleInTrx }))
      .rejects.toMatchObject({ message: VISIT_NO_CUSTOMER_MESSAGE, status: 409, statusCode: 409, isOperational: true, code: VISIT_NO_CUSTOMER_CODE });
    // The ownership hook runs first, so an unowned tech still gets its 404 (admin-tech-role-scoping covers that order).
    expect(assertEligibleInTrx).toHaveBeenCalledTimes(1);
    expect(buildCreateParams).not.toHaveBeenCalled();
    expect(builder.insert).not.toHaveBeenCalled();
  });

  test('InvoiceService.create throws the same typed 409 for a visit with no customer, before any read', async () => {
    await expect(InvoiceService.create({ customerId: null, scheduledServiceId: SERVICE_ID, lineItems: [] }))
      .rejects.toMatchObject({ message: VISIT_NO_CUSTOMER_MESSAGE, status: 409, isOperational: true, code: VISIT_NO_CUSTOMER_CODE });
    expect(db).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a visit that has a customer goes past the refusal into its normal mint transaction', async () => {
    service.customer_id = CUSTOMER_ID;

    const outcome = await mintScheduledServiceInvoiceWithDeposit({ svc: { id: SERVICE_ID, customer_id: CUSTOMER_ID }, buildCreateParams: jest.fn() })
      .catch((err) => err);

    expect(db.transaction).toHaveBeenCalled();
    expect(outcome?.code).not.toBe(VISIT_NO_CUSTOMER_CODE);
  });
});
