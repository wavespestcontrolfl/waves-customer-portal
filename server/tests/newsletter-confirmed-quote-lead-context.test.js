/**
 * maybeEnrollConfirmedQuoteLead (routes/public-newsletter.js) — the deferred
 * new_lead enrollment after double opt-in carries the quote lead persisted
 * with the pending flag (Codex #4813 r1 P1) and clears both on success.
 */
const mockEnroll = jest.fn();
jest.mock('../services/automation-runner', () => ({ enrollCustomer: (...a) => mockEnroll(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockUpdate = jest.fn(async () => 1);
const mockWhere = jest.fn(() => ({ update: mockUpdate }));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where: mockWhere }));
  db.raw = jest.fn();
  return db;
});

const { _test } = require('../routes/public-newsletter');

describe('maybeEnrollConfirmedQuoteLead', () => {
  beforeEach(() => { jest.clearAllMocks(); mockEnroll.mockResolvedValue({ enrolled: true }); });

  test('passes the persisted quote lead as context.leadId and clears flag + lead id', async () => {
    await _test.maybeEnrollConfirmedQuoteLead({
      id: 'sub-1', email: 'lead@example.com', first_name: 'Sam', last_name: null, customer_id: null,
      quote_lead_automation_pending: true, quote_lead_id: 'lead-777',
    });
    expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'new_lead',
      context: { leadId: 'lead-777' },
    }));
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ quote_lead_automation_pending: false, quote_lead_id: null }));
  });

  test('a pending flag that predates the column enrolls with context.leadId null', async () => {
    await _test.maybeEnrollConfirmedQuoteLead({ id: 'sub-2', email: 'lead@example.com', quote_lead_automation_pending: true });
    expect(mockEnroll).toHaveBeenCalledWith(expect.objectContaining({ context: { leadId: null } }));
  });

  test('no pending flag → nothing happens', async () => {
    await _test.maybeEnrollConfirmedQuoteLead({ id: 'sub-3', email: 'x@example.com', quote_lead_automation_pending: false, quote_lead_id: 'lead-1' });
    expect(mockEnroll).not.toHaveBeenCalled();
    expect(mockWhere).not.toHaveBeenCalled();
  });
});
