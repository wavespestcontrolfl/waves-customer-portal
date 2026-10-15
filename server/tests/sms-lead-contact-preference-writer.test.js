'use strict';

// A lead's CALL / TEXT reply goes through the SMS profile writer: the same
// newer-proposal guard, locked compare-and-set, proposal retirement and
// critical audit event an SMS fact gets. The helpers are mocked; the contract
// pinned here is the order, the arguments and the lock.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, work) => work()) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/data-hygiene/proposal-store', () => ({
  stalePendingExtractionProposals: jest.fn().mockResolvedValue([]),
  findPendingExtractionProposal: jest.fn().mockResolvedValue(null),
  upsertSensitiveProposal: jest.fn(),
  findSmsExtractionProposals: jest.fn(),
  buildIdempotencyKey: jest.fn(),
}));
jest.mock('../services/data-hygiene/property-preferences', () => ({
  resolvePropertyPreferencesTarget: jest.fn().mockResolvedValue({ id: 'pref-1' }),
  applyPropertyPreferenceValue: jest.fn().mockResolvedValue({ companions: {} }),
}));

const { recordAuditEvent } = require('../services/audit-log');
const { findPendingExtractionProposal, stalePendingExtractionProposals } = require('../services/data-hygiene/proposal-store');
const { resolvePropertyPreferencesTarget, applyPropertyPreferenceValue } = require('../services/data-hygiene/property-preferences');
const { lockPreferenceOwner, applyLeadContactPreference } = require('../services/sms-operational-actions');

const CUSTOMER_ID = '00000000-0000-4000-8000-000000000201';
const SOURCE_AT = '2026-10-14T15:00:00.000Z';

function fakeTrx(currentRow) {
  const calls = [];
  const trx = (table) => {
    const q = {
      where() { return q; },
      whereNull() { return q; },
      forUpdate() { calls.push(`${table}:forUpdate`); return q; },
      limit() { return q; },
      select: async () => (currentRow ? [currentRow] : []),
      first: async () => ({ id: CUSTOMER_ID }),
    };
    return q;
  };
  trx.raw = async (sql, bindings) => { calls.push({ raw: sql, bindings }); };
  trx.calls = calls;
  return trx;
}

beforeEach(() => jest.clearAllMocks());

test('lockPreferenceOwner takes the portal preference advisory lock, then the customer row', async () => {
  const trx = fakeTrx(null);
  expect(await lockPreferenceOwner(trx, CUSTOMER_ID)).toEqual({ id: CUSTOMER_ID });
  expect(trx.calls[0]).toEqual({ raw: 'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', bindings: ['property-preferences', CUSTOMER_ID] });
  expect(trx.calls[1]).toBe('customers:forUpdate');
});

test('applies through the shared writer: guard, locked row, CAS on the current value, retirement, critical audit', async () => {
  const trx = fakeTrx({ id: 'pref-1', contact_preference: 'text' });
  const result = await applyLeadContactPreference(trx, { customerId: CUSTOMER_ID, value: 'call', sourceAt: SOURCE_AT, twilioSid: 'SM-1', smsLogId: 'log-1' });
  expect(result).toBe('applied');
  expect(findPendingExtractionProposal).toHaveBeenCalledWith(expect.objectContaining({ scope_id: CUSTOMER_ID, field: 'contact_preference', newerThan: SOURCE_AT, sameMessageSid: 'SM-1' }));
  expect(resolvePropertyPreferencesTarget).toHaveBeenCalledWith(expect.objectContaining({
    proposal: { scope_id: CUSTOMER_ID, field: 'contact_preference', resource_id: 'pref-1' }, currentRaw: 'text',
  }));
  expect(applyPropertyPreferenceValue).toHaveBeenCalledWith(expect.objectContaining({ proposedRaw: 'call' }));
  expect(stalePendingExtractionProposals).toHaveBeenCalledWith(expect.objectContaining({ scope_id: CUSTOMER_ID, field: 'contact_preference' }));
  expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
    critical: true, actor_type: 'system', action: 'sms.property_preference.updated', resource_type: 'property_preferences', resource_id: 'pref-1',
    metadata: expect.objectContaining({ customer_id: CUSTOMER_ID, field: 'contact_preference', via: 'lead_call_text_reply', sms_log_id: 'log-1' }),
  }));
  // The audit never carries the reply text or the value's phone context.
  expect(JSON.stringify(recordAuditEvent.mock.calls[0][0])).not.toContain('+1');
});

test('no preferences row yet: CAS runs against an empty before value (the writer creates the row)', async () => {
  await applyLeadContactPreference(fakeTrx(null), { customerId: CUSTOMER_ID, value: 'text', sourceAt: SOURCE_AT });
  expect(resolvePropertyPreferencesTarget).toHaveBeenCalledWith(expect.objectContaining({
    proposal: { scope_id: CUSTOMER_ID, field: 'contact_preference', resource_id: null }, currentRaw: null,
  }));
});

test('a newer pending proposal outranks the reply: nothing is written', async () => {
  findPendingExtractionProposal.mockResolvedValueOnce({ id: 'prop-newer' });
  const result = await applyLeadContactPreference(fakeTrx({ id: 'pref-1', contact_preference: 'text' }), { customerId: CUSTOMER_ID, value: 'call', sourceAt: SOURCE_AT });
  expect(result).toBe('superseded');
  expect(applyPropertyPreferenceValue).not.toHaveBeenCalled();
  expect(stalePendingExtractionProposals).not.toHaveBeenCalled();
  expect(recordAuditEvent).not.toHaveBeenCalled();
});
