jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/email-template-automation-executor', () => ({
  processTrigger: jest.fn(async () => ({ automation_count: 1, results: [] })),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const AutomationExecutor = require('../services/email-template-automation-executor');
const { emitEstimateExpired, emitReviewLinked5Star } = require('../services/email-template-automation-emitters');

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
});

describe('emitReviewLinked5Star', () => {
  test('no-op below 5 stars', async () => {
    const result = await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', locationId: 'venice', starRating: 4 });
    expect(result).toBeNull();
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('no-op without a linked customer', async () => {
    const result = await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: null, locationId: 'venice', starRating: 5 });
    expect(result).toBeNull();
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test('fires review.linked_5star on a 5-star linked review', async () => {
    await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', locationId: 'venice', starRating: 5 });
    expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventKey: 'review.linked_5star',
      entityType: 'review',
      entityId: 'rev-1',
      recipient: { type: 'customer', id: 'cust-1' },
      payload: { review_id: 'rev-1', customer_id: 'cust-1', location_id: 'venice' },
    }));
  });
});

describe('emitEstimateExpired', () => {
  test('no-op without an id', async () => {
    const result = await emitEstimateExpired({});
    expect(result).toBeNull();
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
  });

  test("fires estimate.expired with the flipped row's fields", async () => {
    await emitEstimateExpired({
      id: 'est-1', customer_id: 'cust-1', customer_email: 'sam@example.com',
      category: 'RESIDENTIAL', service_interest: 'Pest Control', expires_at: '2026-06-01',
    });
    expect(AutomationExecutor.processTrigger).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventKey: 'estimate.expired',
      entityType: 'estimate',
      entityId: 'est-1',
      payload: expect.objectContaining({ estimate_id: 'est-1', category: 'RESIDENTIAL', service_interest: 'Pest Control' }),
    }));
  });
});

describe('gate off is a blanket no-op', () => {
  test('every emitter no-ops without calling the executor or the db', async () => {
    isEnabled.mockReturnValue(false);
    await emitEstimateExpired({ id: 'est-1', customer_email: 'sam@example.com' });
    await emitReviewLinked5Star({ reviewId: 'rev-1', customerId: 'cust-1', starRating: 5 });
    expect(AutomationExecutor.processTrigger).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });
});
