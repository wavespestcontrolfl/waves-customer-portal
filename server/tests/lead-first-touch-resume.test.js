/**
 * The single release point for the held first-touch sends (2026-07-30 lane):
 * consent is re-checked (do-not-contact veto from the call extraction, active
 * email suppressions) before the new_lead drip enrolls or the newsletter DOI
 * fires, and every failure degrades to { resumed: false } — never throws
 * into the caller's transition/fanout.
 */

let mockDncRow = null;
let mockSuppressionRow = null;
let mockCustomerRow = { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', email: 'pat@example.com' };
jest.mock('../models/db', () => {
  const handler = (table) => {
    const chain = {
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      first: jest.fn(async () => {
        if (table === 'customers') return mockCustomerRow;
        if (table === 'call_log') return mockDncRow;
        if (table === 'email_suppressions') return mockSuppressionRow;
        return null;
      }),
    };
    return chain;
  };
  const db = jest.fn(handler);
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockEnroll = jest.fn(async () => ({ enrolled: true }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: (...a) => mockEnroll(...a) }));

const mockNewsletter = jest.fn(async () => ({ subscribed: true }));
jest.mock('../services/call-recording-processor', () => ({
  resumeNewsletterForCallCustomer: (...a) => mockNewsletter(...a),
}));

const { resumeHeldFirstTouch } = require('../services/lead-first-touch-resume');

beforeEach(() => {
  jest.clearAllMocks();
  mockDncRow = null;
  mockSuppressionRow = null;
  mockCustomerRow = { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', email: 'pat@example.com' };
});

describe('resumeHeldFirstTouch', () => {
  test('enrolls the drip and resumes the newsletter when consent is clear', async () => {
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1' });
    expect(res.resumed).toBe(true);
    expect(res.enrolled).toBe(true);
    expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'new_lead',
      customer: expect.objectContaining({ email: 'pat@example.com', id: 'cust-1' }),
    }));
    expect(mockNewsletter).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1' }));
  });

  test('do-not-contact veto from the call extraction blocks the resume', async () => {
    mockDncRow = { id: 'call-1' };
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1' });
    expect(res).toMatchObject({ resumed: false, skipped: 'do_not_contact' });
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockNewsletter).not.toHaveBeenCalled();
  });

  test('an active email suppression blocks the resume', async () => {
    mockSuppressionRow = { id: 'sup-1' };
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1' });
    expect(res).toMatchObject({ resumed: false, skipped: 'email_suppressed' });
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  test('failures degrade — an enroll error never throws into the caller', async () => {
    mockEnroll.mockRejectedValueOnce(new Error('automation db down'));
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1' });
    expect(res).toMatchObject({ resumed: false, skipped: 'error' });
  });

  test('no email anywhere → skip without side effects', async () => {
    mockCustomerRow = { id: 'cust-1', first_name: 'Pat', last_name: null, email: null };
    const res = await resumeHeldFirstTouch({ customerId: 'cust-1' });
    expect(res).toMatchObject({ resumed: false, skipped: 'no_email' });
    expect(mockEnroll).not.toHaveBeenCalled();
  });
});
