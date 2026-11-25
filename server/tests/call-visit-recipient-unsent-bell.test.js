// A recipient lookup that throws is not "nobody is owed" (GATE_CALL_GIVEN_VISIT_TEXTS): ONE admin bell per visit and notice tells
// someone to text the person named on the call. No retry, no phone number, name or link in the bell, and the holder's result is
// unchanged (the function still answers true).
jest.mock('../models/db', () => jest.fn(() => {
  throw Object.assign(new Error(`select * from "scheduled_services" where "id" = 'visit-1' and phone '+19415550002' - connection terminated`), { code: '57P01' });
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n-1' })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const { notifyAdmin } = require('../services/notification-service');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const logger = require('../services/logger');
const VisitRecipient = require('../services/call-visit-recipient');

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
const gateBefore = process.env[GATE];
beforeEach(() => { jest.clearAllMocks(); process.env[GATE] = 'true'; });
afterAll(() => { if (gateBefore === undefined) delete process.env[GATE]; else process.env[GATE] = gateBefore; });

describe('the bell opens the visit on its own day', () => {
  test('the visit\'s scheduled date rides in the link as the dispatch page\'s own date parameter (when it can be read)', async () => {
    const db = require('../models/db');
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') {
        const q = { where: () => q, first: async () => ({ scheduled_date: '2026-12-01', status: 'confirmed', customer_id: 'c-1' }) };
        return q;
      }
      throw Object.assign(new Error('connection terminated'), { code: '57P01' });
    });
    try {
      await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: 'visit-1', kind: 'confirmation' });
      expect(notifyAdmin.mock.calls[0][3].link).toBe('/admin/dispatch?tab=schedule&date=2026-12-01&appointment=visit-1');
    } finally {
      db.mockImplementation(() => { throw Object.assign(new Error('connection terminated'), { code: '57P01' }); });
    }
  });
});

describe('an unreadable recipient lookup', () => {
  test.each(['confirmation', 'reminder_72h', 'reminder_24h', 'en_route'])('%s: one bell, the holder result unchanged, nothing sent, no retry timer', async (kind) => {
    jest.useFakeTimers();
    try {
      const result = await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: 'visit-1', kind, excludePhones: ['+19415550001'] });
      expect(result).toBe(true);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      const [category, title, body, opts] = notifyAdmin.mock.calls[0];
      expect(category).toBe('appointment');
      expect(title).toBe('Schedule — check the person named on the call before texting');
      expect(title.length).toBeLessThanOrEqual(60);
      // staff are told what to check before texting by hand: still on the visit, the time, and that they may be texted
      expect(body).toMatch(/ was not sent; check they are on the visit, its time and that they may be texted\.$/);
      expect(body.length).toBeLessThanOrEqual(110);
      expect(opts.dedupeKey).toBe(`visit-recipient-text-unsent:visit-1:${kind}`);
      expect(opts.bell).toBe(true);
      expect(opts.link).toBe('/admin/dispatch?tab=schedule&appointment=visit-1');
      expect(opts.metadata).toMatchObject({ severity: 'needs-you', subject: { type: 'visit', id: 'visit-1' }, doneWhen: 'visit_checked', who: 'person', kind });
      // no number, name or tracker/short link anywhere in what the bell carries
      expect(JSON.stringify(notifyAdmin.mock.calls)).not.toMatch(/\+?1?9415550\d{3}|\/track\/|\/l\//);
      // the lookup failed, so the recipients are unknown: staff are told to check every person named on the visit
      expect(opts.detail).toMatch(/Check every person the caller named on this visit before texting/);
      // the log has the driver code only; nothing is scheduled to run later
      expect(JSON.stringify(logger.warn.mock.calls)).toContain('57P01');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('9415550002');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the same notice raised twice carries the same dedupe key (one bell per visit and notice)', async () => {
    await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: 'visit-1', kind: 'confirmation' });
    await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: 'visit-1', kind: 'confirmation' });
    expect(notifyAdmin.mock.calls.map((c) => c[3].dedupeKey)).toEqual(['visit-recipient-text-unsent:visit-1:confirmation', 'visit-recipient-text-unsent:visit-1:confirmation']);
  });

  test('a bell that cannot be raised never throws into the sender and logs a code only', async () => {
    notifyAdmin.mockRejectedValueOnce(Object.assign(new Error('insert into notifications ... +19415550002'), { code: '57P01' }));
    await expect(VisitRecipient.notifyVisitRecipients({ scheduledServiceId: 'visit-1', kind: 'en_route' })).resolves.toBe(true);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('9415550002');
  });

  test('gate off: no read, no bell', async () => {
    delete process.env[GATE];
    expect(await VisitRecipient.notifyVisitRecipients({ scheduledServiceId: 'visit-1', kind: 'confirmation' })).toBe(true);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});
