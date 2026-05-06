jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn((url) => Promise.resolve(url)),
}));
jest.mock('../services/tech-photo', () => ({
  resolveTechPhotoUrl: jest.fn(),
}));

const db = require('../models/db');
const { resolveTechPhotoUrl } = require('../services/tech-photo');
const ReviewService = require('../services/review-request');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    count: jest.fn().mockResolvedValue([{ count: 0 }]),
    ...overrides,
  };
}

describe('review request tech photo resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveTechPhotoUrl.mockResolvedValue(null);
  });

  test('uses canonical technician photo fields without dispatch_technicians fallback', async () => {
    const reviewRequest = chain({
      first: jest.fn().mockResolvedValue({
        id: 'review-1',
        token: 'token-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        tech_name: 'Tech One',
        service_type: 'General Pest',
        service_date: '2026-05-05',
        status: 'sent',
        open_count: 0,
      }),
    });
    const reviewUpdate = chain();
    const customer = chain({
      first: jest.fn().mockResolvedValue({
        first_name: 'Van',
        last_name: 'Lee',
        city: 'Bradenton',
        zip: '34202',
      }),
    });
    const technician = chain({
      first: jest.fn().mockResolvedValue({
        photo_s3_key: null,
        photo_url: null,
      }),
    });
    const reviewCount = chain();
    const googleCount = chain();
    const reviewRequestQueries = [reviewRequest, reviewUpdate, reviewCount];

    db.mockImplementation((table) => {
      if (table === 'review_requests') return reviewRequestQueries.shift();
      if (table === 'customers') return customer;
      if (table === 'technicians') return technician;
      if (table === 'google_reviews') return googleCount;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await ReviewService.getByToken('token-1');

    expect(result).toMatchObject({
      id: 'review-1',
      techName: 'Tech One',
      techPhoto: null,
      customerFirstName: 'Van',
    });
    expect(resolveTechPhotoUrl).toHaveBeenCalledWith(null, null);
    expect(db.mock.calls.map(([table]) => table)).not.toContain('dispatch_technicians');
  });
});
