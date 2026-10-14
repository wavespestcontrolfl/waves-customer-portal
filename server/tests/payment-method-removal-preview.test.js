// removalPreview (admin Remove dialog): the soonest future secured visit a
// card holds, from the portal's own lookup (liveHoldsForPaymentMethods),
// scoped to the customer's own method row; a failed lookup is reported,
// never thrown, so the dialog can still offer removal.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
let mockRow;
jest.mock('../models/db', () => {
  const fn = jest.fn(() => {
    const q = { where: () => q, first: async () => mockRow };
    return q;
  });
  fn.transaction = jest.fn();
  return fn;
});
const mockHolds = jest.fn();
jest.mock('../services/estimate-card-holds', () => ({ liveHoldsForPaymentMethods: (...a) => mockHolds(...a) }));

const { removalPreview } = require('../services/payment-method-removal');

beforeEach(() => { mockRow = { id: 'pm-1', stripe_payment_method_id: 'pm_stripe_1' }; mockHolds.mockReset(); });

test('reports the soonest held visit with its agreed fee', async () => {
  const soon = { start: new Date('2026-10-08T13:00:00Z'), serviceType: 'pest_control', feeAmount: 49 };
  const later = { start: new Date('2026-11-08T13:00:00Z'), serviceType: 'lawn', feeAmount: 49 };
  mockHolds.mockResolvedValue(new Map([['pm_stripe_1', [soon, later]]]));
  const preview = await removalPreview({ customerId: 'cust-1', methodId: 'pm-1' });
  expect(mockHolds).toHaveBeenCalledWith({ customerId: 'cust-1', stripePaymentMethodIds: ['pm_stripe_1'] });
  expect(preview.holdLookupFailed).toBe(false);
  expect(preview.holdsAppointment).toMatchObject({ start: '2026-10-08T13:00:00.000Z', feeAmount: 49 });
  expect(preview.holdsAppointment.serviceType).toEqual(expect.any(String));
});

test('no hold → null; another customer\'s method → null preview; a failed lookup is flagged', async () => {
  mockHolds.mockResolvedValue(new Map());
  expect(await removalPreview({ customerId: 'cust-1', methodId: 'pm-1' })).toEqual({ holdsAppointment: null, holdLookupFailed: false });

  mockRow = undefined;
  expect(await removalPreview({ customerId: 'cust-2', methodId: 'pm-1' })).toBeNull();

  mockRow = { id: 'pm-1', stripe_payment_method_id: 'pm_stripe_1' };
  mockHolds.mockRejectedValue(new Error('rail read failed'));
  expect(await removalPreview({ customerId: 'cust-1', methodId: 'pm-1' })).toEqual({ holdsAppointment: null, holdLookupFailed: true });
});
