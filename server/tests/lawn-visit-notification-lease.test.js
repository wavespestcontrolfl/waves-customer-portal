// The lawn health notification is the one non-idempotent customer effect in
// confirmed delivery. Recovery hands the sender its lease check; a worker that
// lost ownership must not dispatch, and the loss must surface to the caller
// instead of being swallowed as a generic send failure.
const updates = [];
const rows = {
  lawn_assessments: { id: 'a-1', customer_id: 'c-1', confirmed_by_tech: true, notification_sent: false },
  customers: { id: 'c-1', first_name: 'Pat' },
};
jest.mock('../models/db', () => {
  const table = (name) => ({
    where: () => ({
      first: async () => rows[name],
      update: async (fields) => { updates.push([name, fields]); return 1; },
    }),
  });
  return table;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'Your report is ready') }));
jest.mock('../services/notification-dispatcher', () => ({ notify: jest.fn(async () => ({ sent: true, results: { sms: 'sent' } })) }));

const NotificationDispatcher = require('../services/notification-dispatcher');
const LawnIntel = require('../services/lawn-intelligence');

const ownershipLost = () => Object.assign(new Error('Lawn delivery ownership lost'), { code: 'LAWN_DELIVERY_OWNERSHIP_LOST' });

describe('sendAssessmentNotification lease check', () => {
  beforeEach(() => {
    updates.length = 0;
    jest.clearAllMocks();
    jest.spyOn(LawnIntel, 'computeAssessmentScoreParts').mockResolvedValue({ overall: 72, deltaStr: '', tip: null });
  });

  test('a worker whose lease is gone never dispatches and reports the loss', async () => {
    const beforeSend = jest.fn(async () => { throw ownershipLost(); });
    await expect(LawnIntel.sendAssessmentNotification('a-1', { beforeSend })).rejects.toMatchObject({ code: 'LAWN_DELIVERY_OWNERSHIP_LOST' });
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(NotificationDispatcher.notify).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('a valid lease sends once and stamps the assessment', async () => {
    const beforeSend = jest.fn(async () => {});
    const result = await LawnIntel.sendAssessmentNotification('a-1', { beforeSend });
    expect(result).toMatchObject({ sent: true });
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(NotificationDispatcher.notify).toHaveBeenCalledTimes(1);
    expect(NotificationDispatcher.notify.mock.invocationCallOrder[0]).toBeGreaterThan(beforeSend.mock.invocationCallOrder[0]);
    expect(updates).toEqual([['lawn_assessments', expect.objectContaining({ notification_sent: true })]]);
  });

  test('other send failures are still swallowed as before', async () => {
    NotificationDispatcher.notify.mockRejectedValueOnce(new Error('carrier down'));
    await expect(LawnIntel.sendAssessmentNotification('a-1')).resolves.toBeNull();
    expect(updates).toEqual([]);
  });
});
