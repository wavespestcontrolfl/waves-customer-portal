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
  const query = (name) => ({
    first: async () => rows[name],
    update: async (fields) => {
      const settling = Object.keys(fields).length === 1 && fields.notification_sent_at instanceof Date;
      if (settling && rows.failSettle) throw new Error('settle write failed');
      updates.push([name, fields]);
      return 1;
    },
    // The claim's second .where((q) => …) narrows an unsent row; the fixture row is unsent.
    where: () => query(name),
  });
  return (name) => ({ where: () => query(name) });
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
    // Claimed before the wire (no settle mark), settled only once it is known.
    expect(updates.map(([, f]) => f)).toEqual([
      expect.objectContaining({ notification_sent: true, notification_sent_at: null }),
      expect.objectContaining({ notification_sent_at: expect.any(Date) }),
    ]);
  });

  test('a dispatcher that definitely delivered nothing releases the claim for a re-send', async () => {
    NotificationDispatcher.notify.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'not_sent', results: { sms: 'blocked' } });
    await expect(LawnIntel.sendAssessmentNotification('a-1')).resolves.toMatchObject({ sent: false });
    expect(updates.map(([, f]) => f.notification_sent)).toEqual([true, false]);
  });

  test('ownership lost during provider preparation releases the unsent claim', async () => {
    const beforeSend = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(ownershipLost());
    NotificationDispatcher.notify.mockImplementationOnce(async (_customerId, _type, { preSendCheck }) => {
      // The canonical provider normalizes a refused/throwing final guard to
      // proven non-delivery; no provider request has started.
      await expect(preSendCheck()).rejects.toMatchObject({ code: 'LAWN_DELIVERY_OWNERSHIP_LOST' });
      return { sent: false, deliveryOutcome: 'not_sent', results: { sms: 'blocked' } };
    });
    await expect(LawnIntel.sendAssessmentNotification('a-1', { beforeSend })).resolves.toMatchObject({ sent: false });
    expect(beforeSend).toHaveBeenCalledTimes(2);
    expect(updates.map(([, f]) => f.notification_sent)).toEqual([true, false]);
  });

  test.each(['uncertain', 'accepted'])('a %s handoff keeps its claim rather than risking a second text', async (deliveryOutcome) => {
    // Twilio may already hold the message; recovery must not send again to find out.
    NotificationDispatcher.notify.mockResolvedValueOnce({ sent: false, deliveryOutcome, results: { sms: 'error: audit write failed' } });
    await LawnIntel.sendAssessmentNotification('a-1');
    // Claim then settle: never retried, and never mistaken for an open claim.
    expect(updates.map(([, f]) => f)).toEqual([
      expect.objectContaining({ notification_sent: true, notification_sent_at: null }),
      expect.objectContaining({ notification_sent_at: expect.any(Date) }),
    ]);
  });

  test('a service-linked assessment never gets the standalone text, whoever calls', async () => {
    rows.lawn_assessments.service_id = 'svc-1';
    try {
      await expect(LawnIntel.sendAssessmentNotification('a-1')).resolves.toBeNull();
    } finally { delete rows.lawn_assessments.service_id; }
    expect(NotificationDispatcher.notify).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('a settle write that fails after dispatch keeps the claim rather than re-sending', async () => {
    rows.failSettle = true;
    try {
      await expect(LawnIntel.sendAssessmentNotification('a-1')).resolves.toBeNull();
    } finally { delete rows.failSettle; }
    // The text went out; only its timestamp is missing. Releasing here would
    // hand the customer a second copy.
    expect(updates.map(([, f]) => f.notification_sent)).toEqual([true]);
  });

  test('a throw out of the dispatcher happened before any handoff, so the claim comes back', async () => {
    NotificationDispatcher.notify.mockRejectedValueOnce(new Error('prefs lookup failed'));
    await expect(LawnIntel.sendAssessmentNotification('a-1')).resolves.toBeNull();
    // Provider failures arrive in the result; a throw means nothing was sent.
    expect(updates.map(([, f]) => f.notification_sent)).toEqual([true, false]);
    expect(updates[1][1].notification_sent_at).toBeNull();
  });
});
