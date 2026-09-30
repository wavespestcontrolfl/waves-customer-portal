jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe-banking', () => ({
  createInstantPayout: jest.fn(),
  createStandardPayout: jest.fn(),
  listPendingPayouts: jest.fn(),
  cancelPayout: jest.fn(),
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
    ['request_instant_payout', 'createInstantPayout', { amount: 50 }],
    ['request_standard_payout', 'createStandardPayout', { amount: 50 }],
    ['cancel_pending_payout', 'cancelPayout', { payout_id: 'po_synthetic_1' }],
  ])('%s refuses without a confirmed context — guard fires before validation', async (toolName, method, input) => {
    const result = await executeBankingTool(toolName, input);

    expect(result.error).toMatch(/confirmation is required/i);
    expect(StripeBanking[method]).not.toHaveBeenCalled();
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

  describe('list_pending_payouts', () => {
    test('returns the pending payouts from Stripe', async () => {
      StripeBanking.listPendingPayouts.mockResolvedValue({
        payouts: [{
          id: 'po_synthetic_1',
          amount: 250.5,
          currency: 'usd',
          arrival_date: '2026-10-01T00:00:00.000Z',
          method: 'standard',
          status: 'pending',
        }],
        total: 1,
        has_more: false,
      });

      const result = await executeBankingTool('list_pending_payouts', { limit: 5 });

      expect(StripeBanking.listPendingPayouts).toHaveBeenCalledWith(5);
      expect(result.total).toBe(1);
      expect(result.payouts[0]).toMatchObject({ id: 'po_synthetic_1', amount: 250.5, status: 'pending' });
    });

    test('surfaces a Stripe failure as a plain error object, not a throw', async () => {
      StripeBanking.listPendingPayouts.mockRejectedValue(new Error('Stripe not configured'));

      const result = await executeBankingTool('list_pending_payouts', {});

      expect(result).toEqual({ error: 'Could not list pending payouts: Stripe not configured' });
    });
  });

  describe('cancel_pending_payout', () => {
    test('requires a payout id even when confirmed', async () => {
      const result = await executeBankingTool('cancel_pending_payout', {}, { confirmed: true });

      expect(result).toEqual({ error: 'A Stripe payout id is required.' });
      expect(StripeBanking.cancelPayout).not.toHaveBeenCalled();
    });

    test('cancels a pending payout and returns the resulting status', async () => {
      StripeBanking.cancelPayout.mockResolvedValue({
        payout_id: 'po_synthetic_2',
        status: 'canceled',
        amount: 100,
        currency: 'usd',
        arrival_date: '2026-10-01T00:00:00.000Z',
        method: 'standard',
      });

      const result = await executeBankingTool(
        'cancel_pending_payout',
        { payout_id: 'po_synthetic_2' },
        { confirmed: true },
      );

      expect(StripeBanking.cancelPayout).toHaveBeenCalledWith('po_synthetic_2', {});
      expect(result).toMatchObject({ payout_id: 'po_synthetic_2', status: 'canceled' });
      expect(result.note).toContain('cancelled (status: canceled)');
    });

    test('forwards idempotency key and actor when provided', async () => {
      StripeBanking.cancelPayout.mockResolvedValue({ payout_id: 'po_synthetic_3', status: 'canceled' });

      await executeBankingTool('cancel_pending_payout', {
        payout_id: 'po_synthetic_3',
        idempotencyKey: 'cpo_confirm_123',
        requestedBy: 'admin-1',
      }, { confirmed: true });

      expect(StripeBanking.cancelPayout).toHaveBeenCalledWith('po_synthetic_3', {
        idempotencyKey: 'cpo_confirm_123',
        requestedBy: 'admin-1',
      });
    });

    // A retry after the cancel already succeeded (lost response) comes back
    // from the service as an already-completed success; the executor says so
    // instead of reporting a failure for a state that was reached.
    test('reports an already-cancelled payout as done, not as an error', async () => {
      StripeBanking.cancelPayout.mockResolvedValue({
        payout_id: 'po_synthetic_done', status: 'canceled', amount: 50, currency: 'usd',
        arrival_date: null, method: 'standard', already_canceled: true,
      });

      const result = await executeBankingTool(
        'cancel_pending_payout',
        { payout_id: 'po_synthetic_done' },
        { confirmed: true },
      );

      expect(result.error).toBeUndefined();
      expect(result.already_canceled).toBe(true);
      expect(result.note).toBe('Payout po_synthetic_done was already cancelled (status: canceled); nothing further was done.');
    });

    // Stripe refuses to cancel anything but a still-pending payout — the
    // executor surfaces that refusal as a plain error, not a thrown 500.
    test.each([
      ['in_transit', 'This payout is already in transit and can no longer be cancelled — only a payout still pending can be cancelled.'],
      ['paid', 'This payout is already paid and can no longer be cancelled — only a payout still pending can be cancelled.'],
      ['failed', 'This payout is already failed and can no longer be cancelled — only a payout still pending can be cancelled.'],
    ])('refuses a %s payout with a clear message', async (status, message) => {
      StripeBanking.cancelPayout.mockRejectedValue(new Error(message));

      const result = await executeBankingTool(
        'cancel_pending_payout',
        { payout_id: 'po_synthetic_4' },
        { confirmed: true },
      );

      expect(result).toEqual({ error: message });
    });

    test('refuses an instant payout', async () => {
      StripeBanking.cancelPayout.mockRejectedValue(
        new Error('Instant payouts settle within minutes and cannot be cancelled.'),
      );

      const result = await executeBankingTool(
        'cancel_pending_payout',
        { payout_id: 'po_synthetic_instant' },
        { confirmed: true },
      );

      expect(result).toEqual({ error: 'Instant payouts settle within minutes and cannot be cancelled.' });
    });
  });
});
