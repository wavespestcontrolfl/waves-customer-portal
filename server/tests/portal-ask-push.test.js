// GATE_PORTAL_ASK_PUSH (owner 2026-11-02): the phone page for a customer's ask inside the app.
// services/portal-ask-push.js sends the portal_ask trigger pushOnly (the bell keeps its one row), only with the
// gate on, and never throws. The trigger itself: its text, its push tag, its bell-policy entry.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: false, push: { sent: 1 } })) }));

const { triggerNotification } = require('../services/notification-triggers');
const {
  pushPortalAsk, shortName, PAGES_PER_CUSTOMER_PER_HOUR, PAGES_PER_HOUR, PAGES_IN_FLIGHT, __private,
} = require('../services/portal-ask-push');

const ask = { itemKey: 'request:r-1', title: 'Answer a portal request', body: 'Pat S. sent a pest control request', link: '/admin/customers?customerId=c-1', customerId: 'c-1' };

beforeEach(() => { jest.clearAllMocks(); delete process.env.GATE_PORTAL_ASK_PUSH; __private.resetPageLimits(); });
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

// Codex #7482 security review: a signed-in customer can open many asks, and a sweep can find many rows at once.
describe('page limits: a burst of asks cannot flood the phones or hold a caller', () => {
  const askFor = (customerId, n = 1) => ({ ...ask, itemKey: `request:${customerId}-${n}`, customerId });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  beforeEach(() => { process.env.GATE_PORTAL_ASK_PUSH = 'true'; });

  test('a customer gets at most PAGES_PER_CUSTOMER_PER_HOUR pages an hour; another customer still pages; after the hour it pages again', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-02T15:00:00Z'));
    try {
      for (let n = 1; n <= PAGES_PER_CUSTOMER_PER_HOUR; n += 1) expect((await pushPortalAsk(askFor('c-1', n))).sent).toBe(true);
      await expect(pushPortalAsk(askFor('c-1', 9))).resolves.toEqual({ skipped: 'rate_limited' });
      expect((await pushPortalAsk(askFor('c-2'))).sent).toBe(true);
      clock.mockReturnValue(Date.parse('2026-11-02T16:00:01Z'));
      expect((await pushPortalAsk(askFor('c-1', 10))).sent).toBe(true);
      expect(triggerNotification).toHaveBeenCalledTimes(PAGES_PER_CUSTOMER_PER_HOUR + 2);
    } finally { clock.mockRestore(); }
  });

  test('at most PAGES_PER_HOUR pages an hour in all', async () => {
    for (let n = 1; n <= PAGES_PER_HOUR; n += 1) expect((await pushPortalAsk(askFor(`c-${n}`))).sent).toBe(true);
    await expect(pushPortalAsk(askFor('c-new'))).resolves.toEqual({ skipped: 'rate_limited' });
    expect(triggerNotification).toHaveBeenCalledTimes(PAGES_PER_HOUR);
  });

  test('an ask with no customer is limited by its own key', async () => {
    const anonymous = { ...ask, customerId: null };
    for (let n = 1; n <= PAGES_PER_CUSTOMER_PER_HOUR; n += 1) expect((await pushPortalAsk(anonymous)).sent).toBe(true);
    await expect(pushPortalAsk(anonymous)).resolves.toEqual({ skipped: 'rate_limited' });
    expect((await pushPortalAsk({ ...anonymous, itemKey: 'request:another' })).sent).toBe(true);
  });

  test('PAGES_IN_FLIGHT go out at once; a newer ask from a customer whose page waits replaces its words: one page', async () => {
    const releases = [];
    for (let k = 0; k < 3; k += 1) {
      triggerNotification.mockImplementationOnce(() => new Promise((resolve) => releases.push(() => resolve({ push: { sent: 1 } }))));
    }
    const first = pushPortalAsk(askFor('c-1'));
    const second = pushPortalAsk(askFor('c-2'));
    const older = pushPortalAsk({ ...askFor('c-3', 1), body: 'Pat S. sent a request' });
    const newer = pushPortalAsk({ ...askFor('c-3', 2), body: 'Pat S. sent another request' });
    expect(triggerNotification).toHaveBeenCalledTimes(PAGES_IN_FLIGHT);
    releases[0]();
    await expect(first).resolves.toEqual(expect.objectContaining({ sent: true }));
    await flush();
    expect(triggerNotification).toHaveBeenCalledTimes(PAGES_IN_FLIGHT + 1);
    expect(triggerNotification.mock.calls[2][1]).toEqual(expect.objectContaining({ itemKey: 'request:c-3-2', body: 'Pat S. sent another request' }));
    releases[1]();
    releases[2]();
    await expect(second).resolves.toEqual(expect.objectContaining({ sent: true }));
    await expect(older).resolves.toEqual(expect.objectContaining({ sent: true }));
    await expect(newer).resolves.toEqual(expect.objectContaining({ sent: true, coalesced: true }));
    expect(triggerNotification).toHaveBeenCalledTimes(3);
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
