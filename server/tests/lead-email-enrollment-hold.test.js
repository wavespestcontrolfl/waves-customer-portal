/**
 * Owner rule 2026-07-30 (the spelled-email bounce incident): a call whose extracted email this
 * run flagged for read-back (open email_unverified / email_invalid review
 * card) must NOT be enrolled in the new_lead email drip — the address is a
 * transcription guess, and the first drip send hard-bounced within a minute,
 * minting a SendGrid suppression on a wrong address. Lookup failure holds
 * (bounces burn sender reputation; a held drip is recoverable).
 */

let mockFirstResult = null;
let mockFirstError = null;
let mockInsertError = null;
let mockUpdateError = null;
jest.mock('../models/db', () => {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    first: jest.fn(() => (mockFirstError ? Promise.reject(mockFirstError) : Promise.resolve(mockFirstResult))),
    insert: jest.fn(() => { if (mockInsertError) throw mockInsertError; return chain; }),
    onConflict: jest.fn(() => chain),
    ignore: jest.fn(async () => 1),
    // The r43/r44 fresh-review claim invalidation runs after the recovery
    // marker insert — a plain fence-bumping hold update.
    update: jest.fn(() => (mockUpdateError ? Promise.reject(mockUpdateError) : Promise.resolve(1))),
  };
  const db = jest.fn(() => chain);
  db._chain = chain;
  db.raw = jest.fn((x) => x);
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-routing-gates', () => ({ buildTriageItem: (x) => x }));

const db = require('../models/db');
const { _test } = require('../services/call-recording-processor');

const { shouldHoldLeadEmailEnrollment } = _test;

beforeEach(() => {
  mockFirstResult = null;
  mockFirstError = null;
  mockInsertError = null;
  mockUpdateError = null;
  jest.clearAllMocks();
});

describe('shouldHoldLeadEmailEnrollment', () => {
  test('open email read-back card holds enrollment', async () => {
    mockFirstResult = { id: 'triage-1' };
    await expect(shouldHoldLeadEmailEnrollment('call-1')).resolves.toBe(true);
    expect(db._chain.where).toHaveBeenCalledWith({ call_log_id: 'call-1' });
    // in_progress counts as live — the canonical open-review set.
    expect(db._chain.whereIn).toHaveBeenCalledWith('status', ['open', 'in_progress']);
    expect(db._chain.whereIn).toHaveBeenCalledWith('reason_code', ['email_unverified', 'email_invalid']);
  });

  test('no open card → enrollment proceeds', async () => {
    mockFirstResult = null;
    await expect(shouldHoldLeadEmailEnrollment('call-1')).resolves.toBe(false);
  });

  test('lookup failure fails toward HOLD and persists a recovery marker', async () => {
    mockFirstError = new Error('db down');
    await expect(shouldHoldLeadEmailEnrollment('call-1')).resolves.toBe(true);
    // The marker is what a later resume path releases — a silent hold with
    // no card would strand the lead outside the drip forever.
    expect(db._chain.insert).toHaveBeenCalled();
  });

  test('lookup + marker failure fails the run — never a silent, invisible hold', async () => {
    mockFirstError = new Error('db down');
    mockInsertError = new Error('still down');
    await expect(shouldHoldLeadEmailEnrollment('call-1')).rejects.toMatchObject({
      emailReviewStateUnavailable: true,
    });
  });

  test('marker persisted but claim invalidation failing fails the run too (r44)', async () => {
    // The recovery card is a live review — with the card durably inserted
    // and an in-flight claimant's fence NOT invalidated, that claimant
    // could send the unreviewed address (Codex #3084 r44). The failure
    // routes into the extraction_failed retry, which re-runs both writes.
    mockFirstError = new Error('db down');
    mockUpdateError = new Error('write down');
    await expect(shouldHoldLeadEmailEnrollment('call-1')).rejects.toMatchObject({
      emailReviewStateUnavailable: true,
    });
    expect(db._chain.insert).toHaveBeenCalled();
  });
});
