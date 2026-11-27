// A recipient lookup that throws is not "nobody is owed" (GATE_CALL_GIVEN_VISIT_TEXTS): ONE admin bell per visit and notice tells
// someone to text the person named on the call. No retry, no phone number, name or link in the bell, and the holder's result is
// unchanged (the function still answers true).
jest.mock('../models/db', () => {
  const fail = () => { throw Object.assign(new Error(`select * from "scheduled_services" where "id" = 'visit-1' and phone '+19415550002' - connection terminated`), { code: '57P01' }); };
  // The every-visit copy (materializeForVisit) runs first, in a transaction: it fails the same way.
  return Object.assign(jest.fn(fail), { transaction: jest.fn(async () => fail()) });
});
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

// The replay's WHOLE recheck (visit_text_recipient_deferred) runs inside the exhausted-attempt guard: the visit read runs BEFORE
// the person's permission read, so a visit read that fails on the last attempt must raise the bell too (it never reaches the
// module's own check). The database here throws on every read.
describe('a queued text whose replay recheck cannot read the visit', () => {
  const { SCHEDULED_SMS_MAX_ATTEMPTS } = require('../services/messaging/scheduled-sms-limits');
  const { recheckDeferredReplay } = require('../services/messaging/deferred-replay-registry');
  const META = {
    entry_point: 'visit_text_recipient_deferred', scheduled_service_id: 'visit-1', kind: 'confirmation', visit_recipient_id: 'r-1',
    claim_key: 'confirmation:2026-12-01T09:00', recipient_hint: 'Bob, ending 0002', recipient_customer_id: 'cust-1', to_phone: '+19415550002',
  };

  test('earlier attempts hold for a retry with no bell; the LAST attempt raises ONE deduped bell, naming the person by first name and last 4 only', async () => {
    const owed = jest.spyOn(VisitRecipient, 'recipientStillOwedDeferred');
    try {
      for (let attempt = 1; attempt < SCHEDULED_SMS_MAX_ATTEMPTS; attempt += 1) {
        expect(await recheckDeferredReplay('visit_text_recipient_deferred', { ...META, scheduled_sms_attempts: attempt })).toEqual({ eligible: false, reason: 'recheck-failed', retryable: true });
      }
      expect(notifyAdmin).not.toHaveBeenCalled();
      expect(await recheckDeferredReplay('visit_text_recipient_deferred', { ...META, scheduled_sms_attempts: SCHEDULED_SMS_MAX_ATTEMPTS })).toEqual({ eligible: false, reason: 'recheck-failed', retryable: true });
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      const opts = notifyAdmin.mock.calls[0][3];
      expect(opts.dedupeKey).toBe('visit-recipient-text-unsent:visit-1:confirmation');
      expect(opts.detail).toContain('Bob, ending 0002 was not sent this text');
      expect(JSON.stringify(notifyAdmin.mock.calls)).not.toContain('9415550002');
      // the visit read failed first: the permission check never ran, so only the guard around the whole recheck could ring
      expect(owed).not.toHaveBeenCalled();
    } finally { owed.mockRestore(); }
  });

  test('a check that THROWS is held for a retry with a code-only log, and rings only on the last attempt', async () => {
    const boom = () => Promise.reject(Object.assign(new Error('select where phone +19415550002'), { code: '57P01' }));
    expect(await VisitRecipient.deferredReplayRecheck({ ...META, scheduled_sms_attempts: 1 }, boom)).toEqual({ eligible: false, reason: 'recheck-failed', retryable: true });
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(await VisitRecipient.deferredReplayRecheck({ ...META, scheduled_sms_attempts: SCHEDULED_SMS_MAX_ATTEMPTS }, boom)).toMatchObject({ eligible: false, retryable: true });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('57P01');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('9415550002');
  });

  test('on the last attempt, a plain "no" or a retry the recheck scheduled itself (retryAt) rings nothing', async () => {
    const last = { ...META, scheduled_sms_attempts: SCHEDULED_SMS_MAX_ATTEMPTS };
    for (const verdict of [{ eligible: true }, { eligible: false, reason: 'recipient-not-owed' }, { eligible: false, reason: 'quiet', retryable: true, retryAt: '2026-12-01T13:00:00Z' }]) {
      expect(await VisitRecipient.deferredReplayRecheck(last, async () => verdict)).toBe(verdict);
    }
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});
