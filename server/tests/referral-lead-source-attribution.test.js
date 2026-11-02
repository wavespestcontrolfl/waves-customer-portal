/**
 * Referral-program leads attribute to the seeded 'Customer Referral' lead source
 * (source_type 'referral', active), the same row the call pipeline uses for a
 * caller who names a referrer. The lookup is fail-soft: a missing row or a
 * lookup error returns null, so submitReferral still creates the lead.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { findReferralLeadSourceId } = require('../services/referral-engine');

function lookup(result) {
  const calls = { where: [], orderBy: [] };
  db.mockImplementation((table) => {
    expect(table).toBe('lead_sources');
    const q = {
      where: jest.fn((arg) => { calls.where.push(arg); return q; }),
      orderBy: jest.fn((arg) => { calls.orderBy.push(arg); return q; }),
      first: jest.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      }),
    };
    return q;
  });
  return calls;
}

describe('findReferralLeadSourceId', () => {
  beforeEach(() => { jest.clearAllMocks(); db.mockReset(); });

  test('returns the active referral source, matched by source_type', async () => {
    const calls = lookup({ id: 'src-referral' });
    await expect(findReferralLeadSourceId()).resolves.toBe('src-referral');
    expect(calls.where).toEqual([{ source_type: 'referral', is_active: true }]);
    expect(calls.orderBy).toEqual(['created_at']);
  });

  test('no active referral source: null, lead stays unattributed', async () => {
    lookup(undefined);
    await expect(findReferralLeadSourceId()).resolves.toBeNull();
  });

  test('lookup error: null and a warning, never a throw', async () => {
    lookup(new Error('relation "lead_sources" does not exist'));
    await expect(findReferralLeadSourceId()).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('referral lead source lookup failed'));
  });
});
