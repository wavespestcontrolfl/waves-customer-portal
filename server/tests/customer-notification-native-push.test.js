const mockReturning = jest.fn();
const mockInsert = jest.fn(() => ({ returning: mockReturning }));
const mockDb = jest.fn(() => ({ insert: mockInsert }));
const mockSendToCustomer = jest.fn();

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/internal-test-customers', () => ({
  isInternalTestCustomerId: () => false,
}));
jest.mock('../services/push-notifications', () => ({
  sendToCustomer: mockSendToCustomer,
}));

const NotificationService = require('../services/notification-service');

beforeEach(() => {
  jest.clearAllMocks();
  mockReturning.mockResolvedValue([{ id: 'notification-1' }]);
  mockSendToCustomer.mockResolvedValue({ subscriptions: 1, sent: 1 });
});

test('a durable customer bell event dispatches the matching native push', async () => {
  const result = await NotificationService.notifyCustomer(
    'customer-1',
    'service',
    'Service completed',
    'Your service report is ready.',
    { link: '/?tab=documents', icon: 'home' },
  );

  expect(result).toEqual({ id: 'notification-1', push: { queued: true } });
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
    recipient_type: 'customer',
    recipient_id: 'customer-1',
    category: 'service',
    title: 'Service completed',
    link: '/?tab=documents',
  }));
  expect(mockSendToCustomer).toHaveBeenCalledWith('customer-1', {
    title: 'Service completed',
    body: 'Your service report is ready.',
    url: '/?tab=documents',
    category: 'service',
    notificationId: 'notification-1',
    tag: 'customer-notification:notification-1',
  });
});

test('native push failure never turns a stored in-app notification into a failed operation', async () => {
  mockSendToCustomer.mockRejectedValueOnce(new Error('APNs offline'));

  await expect(NotificationService.notifyCustomer(
    'customer-1',
    'billing',
    'Payment received',
    'Thank you.',
  )).resolves.toEqual({ id: 'notification-1', push: { queued: true } });
});
