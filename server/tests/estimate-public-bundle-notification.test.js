const { fireBundleQuoteRequestedNotification } = require('../routes/estimate-public');

describe('estimate bundle quote notification', () => {
  test('fires centralized trigger for fallback inquiry with enriched metadata', async () => {
    const trigger = jest.fn(async () => ({ bellWritten: true, push: null }));
    const estimate = {
      id: 'estimate-123',
      customer_id: 'customer-456',
      customer_name: 'Existing Appointment Demo',
      waveguard_tier: 'Bronze',
      monthly_total: '50.00',
    };

    await fireBundleQuoteRequestedNotification({
      estimate,
      suggestedService: 'Lawn Care',
      bundled: null,
    }, trigger);

    expect(trigger).toHaveBeenCalledWith('bundle_quote_requested', {
      estimateId: 'estimate-123',
      customerId: 'customer-456',
      customerName: 'Existing Appointment Demo',
      suggestedService: 'Lawn Care',
      bundled: false,
      previousTier: 'Bronze',
      previousMonthly: 50,
      newTier: null,
      newMonthly: null,
    });
  });

  test('fires centralized trigger for self-applied bundle with new tier totals', async () => {
    const trigger = jest.fn(async () => ({ bellWritten: true, push: { sent: 1 } }));
    const estimate = {
      id: 'estimate-123',
      customer_id: 'customer-456',
      customer_name: 'Existing Appointment Demo',
      waveguard_tier: 'Bronze',
      monthly_total: 50,
    };

    await fireBundleQuoteRequestedNotification({
      estimate,
      suggestedService: 'Lawn Care',
      bundled: {
        tier: 'Silver',
        newMonthly: 112.5,
      },
    }, trigger);

    expect(trigger).toHaveBeenCalledWith('bundle_quote_requested', {
      estimateId: 'estimate-123',
      customerId: 'customer-456',
      customerName: 'Existing Appointment Demo',
      suggestedService: 'Lawn Care',
      bundled: true,
      previousTier: 'Bronze',
      previousMonthly: 50,
      newTier: 'Silver',
      newMonthly: 112.5,
    });
  });
});
