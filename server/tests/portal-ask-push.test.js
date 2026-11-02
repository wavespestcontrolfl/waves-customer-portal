// GATE_PORTAL_ASK_PUSH (owner 2026-11-02): the phone page for a customer's ask inside the app.
// services/portal-ask-push.js sends the portal_ask trigger pushOnly (the bell keeps its one row), only with the
// gate on, and never throws. The trigger itself: its text, its push tag, its bell-policy entry.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: false, push: { sent: 1 } })) }));

const { triggerNotification } = require('../services/notification-triggers');
const { pushPortalAsk, shortName } = require('../services/portal-ask-push');

const ask = { itemKey: 'request:r-1', title: 'Answer a portal request', body: 'Pat S. sent a pest control request', link: '/admin/customers?customerId=c-1', customerId: 'c-1' };

beforeEach(() => { jest.clearAllMocks(); delete process.env.GATE_PORTAL_ASK_PUSH; });
afterAll(() => { delete process.env.GATE_PORTAL_ASK_PUSH; });

describe('pushPortalAsk', () => {
  test.each([[undefined], [''], ['1'], ['on'], ['TRUE'], ['shadow']])('GATE_PORTAL_ASK_PUSH = %j sends nothing', async (value) => {
    if (value !== undefined) process.env.GATE_PORTAL_ASK_PUSH = value;
    await expect(pushPortalAsk(ask)).resolves.toEqual({ skipped: 'gate_off' });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('gate on: one portal_ask trigger, pushOnly, with the ask\'s text', async () => {
    process.env.GATE_PORTAL_ASK_PUSH = 'true';
    const out = await pushPortalAsk(ask);
    expect(out.sent).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(triggerNotification).toHaveBeenCalledWith('portal_ask', expect.objectContaining({
      itemKey: 'request:r-1', title: 'Answer a portal request', body: 'Pat S. sent a pest control request', link: '/admin/customers?customerId=c-1', customerId: 'c-1',
    }), { pushOnly: true });
  });

  test('a dispatch that throws is caught and reported', async () => {
    process.env.GATE_PORTAL_ASK_PUSH = 'true';
    triggerNotification.mockRejectedValueOnce(new Error('push provider down'));
    await expect(pushPortalAsk(ask)).resolves.toEqual({ sent: false, error: 'push provider down' });
  });

  test('a send that never answers is cut at the deadline and reported as ambiguous', async () => {
    jest.useFakeTimers();
    try {
      process.env.GATE_PORTAL_ASK_PUSH = 'true';
      triggerNotification.mockReturnValueOnce(new Promise(() => {}));
      const pending = pushPortalAsk(ask);
      await jest.advanceTimersByTimeAsync(11 * 1000);
      await expect(pending).resolves.toEqual({ sent: false, timedOut: true });
    } finally { jest.useRealTimers(); }
  });

  test('an ask with no key or no title is skipped, not sent', async () => {
    process.env.GATE_PORTAL_ASK_PUSH = 'true';
    await expect(pushPortalAsk({ title: 'x' })).resolves.toEqual({ skipped: 'incomplete' });
    await expect(pushPortalAsk({ itemKey: 'k' })).resolves.toEqual({ skipped: 'incomplete' });
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});

describe('shortName', () => {
  test.each([
    ['Pat', 'Sample', 'Pat S.'],
    ['pat', 'sample', 'pat S.'],
    ['Pat', '', 'Pat'],
    ['', 'Sample', 'S.'],
    ['', '', 'A customer'],
    [null, undefined, 'A customer'],
  ])('%j %j -> %j', (first, last, expected) => {
    expect(shortName(first, last)).toBe(expected);
  });
});
