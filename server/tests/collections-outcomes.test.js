/**
 * collections/outbound-voice/outcomes.js — pins:
 *  - ledger + case updates ride ONE transaction, version-guarded;
 *  - live conversations get the 7d suppression; a stated payment date
 *    LATER than 7d wins (stated-date + 1 business day);
 *  - every non-dispute outcome returns the case to the review queue
 *    ('proposed', approval cleared) — never auto-redial;
 *  - a dispute holds the case;
 *  - customer_intended_payment_date validation (never a raw model string).
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW()') };
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  fn.transaction = jest.fn();
  return fn;
});

const db = require('../models/db');
const {
  writeCallOutcome, addBusinessDays, normalizeIntendedPaymentDate, LIVE_CONVERSATION_OUTCOMES,
} = require('../services/collections/outbound-voice/outcomes');

const NOW = new Date('2026-08-12T15:00:00Z'); // Wed
const CALL_ROW = {
  id: 'cl-1',
  metadata: JSON.stringify({ collectionCaseId: 'case-1', caseVersion: 3, ledgerId: 'ledger-1' }),
};

function firstChain(row) {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => row);
  return q;
}

let trxCalls;
function makeTrx() {
  trxCalls = [];
  const trx = (table) => {
    const q = { _table: table };
    q.where = jest.fn((w) => { q._where = w; return q; });
    q.update = jest.fn(async (patch) => { trxCalls.push({ table, where: q._where, patch }); return 1; });
    return q;
  };
  trx.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  trx.fn = { now: jest.fn(() => 'NOW()') };
  return trx;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => firstChain(CALL_ROW));
  db.transaction.mockImplementation(async (fn) => fn(makeTrx()));
});

describe('normalizeIntendedPaymentDate', () => {
  test('accepts a near-future ISO date', () => {
    expect(normalizeIntendedPaymentDate('2026-08-20', NOW)).toBe('2026-08-20');
  });
  test('rejects past, far-future, and junk', () => {
    expect(normalizeIntendedPaymentDate('2026-08-01', NOW)).toBeNull();
    expect(normalizeIntendedPaymentDate('2027-08-01', NOW)).toBeNull();
    expect(normalizeIntendedPaymentDate('next Friday', NOW)).toBeNull();
    expect(normalizeIntendedPaymentDate('2026-13-45', NOW)).toBeNull();
    expect(normalizeIntendedPaymentDate(null, NOW)).toBeNull();
  });
});

test('addBusinessDays skips weekends', () => {
  // Fri + 1 business day = Mon
  expect(addBusinessDays(new Date('2026-08-14T12:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-08-17');
});

test('live outcome ⇒ one transaction updating ledger metadata AND the version-guarded case', async () => {
  const res = await writeCallOutcome('cl-1', { outcome: 'conversation_completed', now: NOW });
  expect(res.ok).toBe(true);
  expect(db.transaction).toHaveBeenCalledTimes(1);
  const ledger = trxCalls.find((c) => c.table === 'collections_contact_ledger');
  const caseUpd = trxCalls.find((c) => c.table === 'collection_cases');
  expect(ledger.where).toEqual({ id: 'ledger-1' });
  expect(caseUpd.where).toEqual({ id: 'case-1', case_version: 3 });
  // Back to the review queue with the 7d suppression.
  expect(caseUpd.patch.current_state).toBe('proposed');
  expect(caseUpd.patch.approved_at).toBeNull();
  expect(caseUpd.patch.approval_expires_at).toBeNull();
  expect(caseUpd.patch.next_eligible_at.toISOString().slice(0, 10)).toBe('2026-08-19');
  // Ledger metadata merge carries the outcome.
  const merged = JSON.parse(ledger.patch.metadata.bindings[0]);
  expect(merged.outcome).toBe('conversation_completed');
  expect(merged.live_conversation).toBe(true);
});

test('stated payment date later than 7d ⇒ stated-date + 1 business day wins', async () => {
  await writeCallOutcome('cl-1', {
    outcome: 'conversation_completed',
    captures: { customerIntendedPaymentDate: '2026-08-28' }, // Fri, +1bd = Mon 08-31
    now: NOW,
  });
  const caseUpd = trxCalls.find((c) => c.table === 'collection_cases');
  expect(caseUpd.patch.next_eligible_at.toISOString().slice(0, 10)).toBe('2026-08-31');
  const ledger = trxCalls.find((c) => c.table === 'collections_contact_ledger');
  const merged = JSON.parse(ledger.patch.metadata.bindings[0]);
  expect(merged.customer_intended_payment_date).toBe('2026-08-28');
  // The ruled vocabulary: never "promise to pay".
  expect(JSON.stringify(merged)).not.toMatch(/promise/i);
});

test('dispute ⇒ case held', async () => {
  await writeCallOutcome('cl-1', {
    outcome: 'conversation_dispute',
    captures: { disputeSummary: 'says the visit never happened' },
    now: NOW,
  });
  const caseUpd = trxCalls.find((c) => c.table === 'collection_cases');
  expect(caseUpd.patch.current_state).toBe('held');
  expect(caseUpd.patch.hold_reason).toBe('dispute_raised_on_call');
});

test('non-live outcome (voicemail) ⇒ review queue, NO 7d stamp', async () => {
  expect(LIVE_CONVERSATION_OUTCOMES.has('voicemail_left')).toBe(false);
  await writeCallOutcome('cl-1', { outcome: 'voicemail_left', now: NOW });
  const caseUpd = trxCalls.find((c) => c.table === 'collection_cases');
  expect(caseUpd.patch.current_state).toBe('proposed');
  expect(caseUpd.patch.next_eligible_at).toBeNull();
});

test('transaction failure reports not-ok (caller treats as unpersisted)', async () => {
  db.transaction.mockRejectedValue(new Error('trx failed'));
  const res = await writeCallOutcome('cl-1', { outcome: 'conversation_completed', now: NOW });
  expect(res.ok).toBe(false);
});
