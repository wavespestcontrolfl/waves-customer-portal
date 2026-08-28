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
  acceptedOnboardingKey: (estimateId, acceptanceId) => `estimate.accepted_onboarding:${estimateId}:acc:${acceptanceId}`,
  ACCEPTANCE_COPY_MARKER: 'You accepted electronically',
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })) }));
jest.mock('../services/estimate-converter', () => ({
  recurringServicesFromEstimateData: () => [{ name: 'Pest Control' }],
  estimateOneTimeItemsFromData: () => [],
}));

const db = require('../models/db');
const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');
const { runAcceptanceCopySweep } = require('../services/lifecycle-email-sweeps');

const { notifyAdmin } = require('../services/notification-service');

const ACCEPTANCE = { id: 'acc-1', estimate_id: 'est-1', customer_id: 'cust-1', accepted_at: new Date(Date.now() - 2 * 3600000).toISOString(), copy_escalated_at: null };
const ESTIMATE = { id: 'est-1', customer_id: 'cust-1', customer_name: 'Pat', address: '1 Main', estimate_data: '{"result":{}}' };

let emailRows;
let acceptanceRows;
let acceptanceUpdate;

function chainResolving(rows) {
  const q = {};
  ['where', 'whereNull', 'whereIn', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => rows[0]);
  q.update = acceptanceUpdate;
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  emailRows = { delivered: [], wedged: [] };
  acceptanceRows = [ACCEPTANCE];
  acceptanceUpdate = jest.fn(async () => 1);
  let emailCall = 0;
  db.mockImplementation((table) => {
    if (table === 'estimate_acceptances') return chainResolving(acceptanceRows);
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
  expect(result).toEqual({ sent: 1, checked: 1, escalated: 0 });
  expect(sendEstimateAcceptedOnboarding).toHaveBeenCalledTimes(1);
  expect(sendEstimateAcceptedOnboarding.mock.calls[0][0]).toMatchObject({
    customerId: 'cust-1', estimateId: 'est-1', acceptanceId: 'acc-1', serviceLabel: 'Pest Control', idempotencyKey: 'estimate.accepted_onboarding:est-1:acc:acc-1',
  });
});

test('wedged failed row under the stable key → resend under a day-scoped key', async () => {
  emailRows.wedged = [{ id: 'm1', status: 'failed' }];
  await runAcceptanceCopySweep();
  expect(sendEstimateAcceptedOnboarding).toHaveBeenCalledTimes(1);
  expect(sendEstimateAcceptedOnboarding.mock.calls[0][0].idempotencyKey).toMatch(/^estimate\.accepted_onboarding:est-1:acc:acc-1:\d{4}-\d{2}-\d{2}$/);
});

test('a sent-ish row that carries the copy → fulfilment stamped, never emailed twice', async () => {
  emailRows.delivered = [{ id: 'm1', text_snapshot: 'Hi Pat. You accepted electronically on …' }];
  const result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 0, checked: 1, escalated: 0 });
  expect(sendEstimateAcceptedOnboarding).not.toHaveBeenCalled();
  expect(acceptanceUpdate).toHaveBeenCalledWith(expect.objectContaining({ copy_emailed_at: expect.any(Date) }));
});

test('a sent-ish row WITHOUT the copy (template lost the block) → escalated now, never stamped as emailed', async () => {
  emailRows.delivered = [{ id: 'm1', text_snapshot: 'Hi Pat, your plan is confirmed.', html_snapshot: '<p>no note</p>' }];
  const result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 0, checked: 1, escalated: 1 });
  expect(sendEstimateAcceptedOnboarding).not.toHaveBeenCalled();
  expect(notifyAdmin.mock.calls[0][2]).toContain('{{acceptance_note}}');
  expect(acceptanceUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ copy_emailed_at: expect.any(Date) }));
  expect(acceptanceUpdate).toHaveBeenCalledWith(expect.objectContaining({ copy_escalated_at: expect.any(Date) }));
});

test('a fresh send that rendered without the copy → escalated now, not counted as sent', async () => {
  sendEstimateAcceptedOnboarding.mockResolvedValue({ sent: true, copyMissing: true });
  const result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 0, checked: 1, escalated: 1 });
  expect(notifyAdmin).toHaveBeenCalledTimes(1);
});

test('no usable email: escalated to the office ONCE after 7 days, not before', async () => {
  sendEstimateAcceptedOnboarding.mockResolvedValue({ sent: false, outcome: 'no_address' });
  // 2 hours old: no escalation yet.
  let result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 0, checked: 1, escalated: 0 });
  expect(notifyAdmin).not.toHaveBeenCalled();
  // 8 days old: escalate + stamp.
  acceptanceRows = [{ ...ACCEPTANCE, accepted_at: new Date(Date.now() - 8 * 86400000).toISOString() }];
  result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 0, checked: 1, escalated: 1 });
  expect(notifyAdmin).toHaveBeenCalledTimes(1);
  expect(acceptanceUpdate).toHaveBeenCalledWith(expect.objectContaining({ copy_escalated_at: expect.any(Date) }));
  // Already escalated: silent.
  acceptanceRows = [{ ...acceptanceRows[0], copy_escalated_at: new Date().toISOString() }];
  result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 0, checked: 1, escalated: 0 });
  expect(notifyAdmin).toHaveBeenCalledTimes(1);
});

test('a suppression-blocked send is undeliverable too → escalated after 7 days', async () => {
  sendEstimateAcceptedOnboarding.mockResolvedValue({ sent: false, blocked: true, reason: 'Email suppressed' });
  acceptanceRows = [{ ...ACCEPTANCE, accepted_at: new Date(Date.now() - 8 * 86400000).toISOString() }];
  const result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 0, checked: 1, escalated: 1 });
  expect(notifyAdmin.mock.calls[0][2]).toContain('suppressed');
});

test('a transient failure is retried, never escalated as "no email"', async () => {
  sendEstimateAcceptedOnboarding.mockResolvedValue({ sent: false, outcome: 'failed', reason: 'SendGrid 503' });
  acceptanceRows = [{ ...ACCEPTANCE, accepted_at: new Date(Date.now() - 30 * 86400000).toISOString() }];
  const result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 0, checked: 1, escalated: 0 });
  expect(notifyAdmin).not.toHaveBeenCalled();
  expect(acceptanceUpdate).not.toHaveBeenCalled();
});

test('a policy-suppressed alert is NOT stamped — retried next sweep', async () => {
  sendEstimateAcceptedOnboarding.mockResolvedValue({ sent: false, outcome: 'no_address' });
  notifyAdmin.mockResolvedValueOnce({ id: null, suppressed: true, reason: 'bell_policy' });
  acceptanceRows = [{ ...ACCEPTANCE, accepted_at: new Date(Date.now() - 8 * 86400000).toISOString() }];
  const result = await runAcceptanceCopySweep();
  expect(result).toEqual({ sent: 0, checked: 1, escalated: 0 });
  expect(acceptanceUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ copy_escalated_at: expect.any(Date) }));
});

test('table absent → no-op', async () => {
  db.schema.hasTable.mockResolvedValueOnce(false);
  expect(await runAcceptanceCopySweep()).toEqual({ sent: 0, checked: 0, escalated: 0 });
});
