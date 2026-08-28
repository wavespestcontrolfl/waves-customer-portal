/**
 * Acceptance copy catch-up sweep (lifecycle-email-sweeps
 * runAcceptanceCopySweep): the accept route's post-commit onboarding email
 * carries the promised copy of the accepted terms but is fire-and-forget, so
 * the daily sweep re-attempts every recorded acceptance with no sent-ish
 * email_messages row for its key.
 *
 * Contract (mirrors the bond-renewal retry-key pattern):
 *  - no email row at all → resend under the STABLE key;
 *  - a wedged (failed/blocked) row under the stable key → resend under a
 *    day-scoped key;
 *  - any sent-ish row (stable or retry key) → skip, never email twice.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn(async () => true) };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-accepted-email', () => ({
  sendEstimateAcceptedOnboarding: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/estimate-converter', () => ({
  recurringServicesFromEstimateData: () => [{ name: 'Pest Control' }],
  estimateOneTimeItemsFromData: () => [],
}));

const db = require('../models/db');
const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');
const { runAcceptanceCopySweep } = require('../services/lifecycle-email-sweeps');

const ACCEPTANCE = { estimate_id: 'est-1', customer_id: 'cust-1' };
const ESTIMATE = { id: 'est-1', customer_id: 'cust-1', estimate_data: '{"result":{}}' };

let emailRows;

function chainResolving(rows) {
  const q = {};
  ['where', 'whereNull', 'whereIn', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => rows[0]);
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  emailRows = { delivered: [], wedged: [] };
  let emailCall = 0;
  db.mockImplementation((table) => {
    if (table === 'estimate_acceptances') return chainResolving([ACCEPTANCE]);
    if (table === 'estimates') return chainResolving([ESTIMATE]);
    if (table === 'email_messages') {
      // First query = the sent-ish lookup (LIKE key%), second = the stable-key row.
      emailCall += 1;
      return chainResolving(emailCall % 2 === 1 ? emailRows.delivered : emailRows.wedged);
    }
    throw new Error(`unexpected table ${table}`);
  });
});

test('no email row → resend under the stable key', async () => {
  const result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 1, checked: 1 });
  expect(sendEstimateAcceptedOnboarding).toHaveBeenCalledTimes(1);
  expect(sendEstimateAcceptedOnboarding.mock.calls[0][0]).toMatchObject({
    customerId: 'cust-1', estimateId: 'est-1', serviceLabel: 'Pest Control', idempotencyKey: 'estimate.accepted_onboarding:est-1',
  });
});

test('wedged failed row under the stable key → resend under a day-scoped key', async () => {
  emailRows.wedged = [{ id: 'm1', status: 'failed' }];
  await runAcceptanceCopySweep();
  expect(sendEstimateAcceptedOnboarding).toHaveBeenCalledTimes(1);
  expect(sendEstimateAcceptedOnboarding.mock.calls[0][0].idempotencyKey).toMatch(/^estimate\.accepted_onboarding:est-1:\d{4}-\d{2}-\d{2}$/);
});

test('a sent-ish row → skipped, never emailed twice', async () => {
  emailRows.delivered = [{ id: 'm1' }];
  const result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 0, checked: 1 });
  expect(sendEstimateAcceptedOnboarding).not.toHaveBeenCalled();
});

test('table absent → no-op', async () => {
  db.schema.hasTable.mockResolvedValueOnce(false);
  expect(await runAcceptanceCopySweep()).toEqual({ sent: 0, checked: 0 });
});
