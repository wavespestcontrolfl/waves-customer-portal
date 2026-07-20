jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe-banking', () => ({
  createInstantPayout: jest.fn(),
  createStandardPayout: jest.fn(),
}));

const StripeBanking = require('../services/stripe-banking');
const { executeBankingTool } = require('../services/intelligence-bar/banking-tools');

describe('intelligence bar banking tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // The payout executors refuse before anything else unless the caller
  // carries server-derived context.confirmed (only /execute attaches it).
  test.each([
    ['request_instant_payout', 'createInstantPayout'],
    ['request_standard_payout', 'createStandardPayout'],
  ])('%s refuses without a confirmed context — guard fires before validation', async (toolName, createMethod) => {
    const result = await executeBankingTool(toolName, { amount: 50 });

    expect(result.error).toMatch(/confirmation is required/i);
    expect(StripeBanking[createMethod]).not.toHaveBeenCalled();
  });

  test.each([
    ['request_instant_payout', 'createInstantPayout'],
    ['request_standard_payout', 'createStandardPayout'],
  ])('%s rejects numeric string amounts before creating a payout', async (toolName, createMethod) => {
    const result = await executeBankingTool(toolName, { amount: '50' }, { confirmed: true });

    expect(result).toEqual({ error: 'Amount must be a positive number.' });
    expect(StripeBanking[createMethod]).not.toHaveBeenCalled();
  });

  test('instant payout accepts a numeric amount and formats the response after creation', async () => {
    StripeBanking.createInstantPayout.mockResolvedValue({ payout_id: 'po_instant', status: 'pending' });

    const result = await executeBankingTool('request_instant_payout', { amount: 50 }, { confirmed: true });

    expect(StripeBanking.createInstantPayout).toHaveBeenCalledWith(50);
    expect(result).toMatchObject({
      payout_id: 'po_instant',
      estimated_fee: 0.75,
      net_after_fee: 49.25,
    });
    expect(result.note).toContain('Instant payout of $50.00 requested');
  });

  test('standard payout accepts a numeric amount and formats the response after creation', async () => {
    StripeBanking.createStandardPayout.mockResolvedValue({ payout_id: 'po_standard', status: 'pending' });

    const result = await executeBankingTool('request_standard_payout', { amount: 75 }, { confirmed: true });

    expect(StripeBanking.createStandardPayout).toHaveBeenCalledWith(75);
    expect(result).toMatchObject({
      payout_id: 'po_standard',
      estimated_fee: 0,
      net_after_fee: 75,
    });
    expect(result.note).toContain('Standard payout of $75.00 requested');
  });

  test('standard payout forwards idempotency key and actor when provided', async () => {
    StripeBanking.createStandardPayout.mockResolvedValue({ payout_id: 'po_standard', status: 'pending' });

    await executeBankingTool('request_standard_payout', {
      amount: 75,
      idempotencyKey: 'spo_confirm_123',
      requestedBy: 'admin-1',
    }, { confirmed: true });

    expect(StripeBanking.createStandardPayout).toHaveBeenCalledWith(75, {
      idempotencyKey: 'spo_confirm_123',
      requestedBy: 'admin-1',
    });
  });
});
