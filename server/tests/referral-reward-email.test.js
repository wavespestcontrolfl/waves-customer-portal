/**
 * Referral thank-you email at the next 9:00 AM ET (owner 2026-10-29, "we just
 * do the email moving forward"): a referral credit sends the referrer ONE
 * email at the next 9:00 AM after it posts, and no reward text, on every path
 * that posts the credit (first visit, quiet issued-invoice closeout, late
 * confirm). Drives the REAL engine over a mocked knex.
 */
const fs = require('fs');
const path = require('path');

const mockState = { credits: [], messages: {}, promoters: {}, ledgerCalls: [] };
function mockBuilder(table) {
  const calls = [];
  const builder = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'select' && table === 'customer_credit_ledger as l') {
        return (...args) => { calls.push(['select', args]); mockState.ledgerCalls = calls; return Promise.resolve(mockState.credits); };
      }
      if (prop === 'first') {
        return async () => {
          const where = (calls.find(([m]) => m === 'where') || [null, [{}]])[1][0] || {};
          if (table === 'email_messages') return mockState.messages[where.idempotency_key];
          if (table === 'referral_promoters') return mockState.promoters[where.id];
          return undefined;
        };
      }
      return (...args) => { calls.push([prop, args]); return builder; };
    },
  });
  return builder;
}
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => mockBuilder(table));
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/customer-credit', () => ({ postCreditMovement: jest.fn(), round2: (n) => Math.round(n * 100) / 100 }));
const mockSendTemplate = jest.fn(async () => ({ sent: true }));
// The library's own retry rule decides what counts as already sent; only the
// provider call is stubbed.
jest.mock('../services/email-template-library', () => ({
  sendTemplate: (...args) => mockSendTemplate(...args),
  shouldRetryExistingMessage: (message) => !['sent', 'delivered', 'opened', 'clicked', 'blocked', 'dropped', 'bounced', 'bounce', 'spam_report', 'spamreport', 'unsubscribed', 'complained']
    .includes(String(message?.status || '').toLowerCase()),
  redactEmailAddresses: (s) => s,
}));

const engine = require('../services/referral-engine');

const credit = (over = {}) => ({
  id: 'ref-1', promoter_id: 'pro-1', referrer_customer_id: 'cust-lea', referee_name: 'Ames Fielder',
  status: 'credited', credit_dollars: '25.00', credited_at: '2026-11-04T19:15:00.000Z', ...over,
});

beforeEach(() => {
  mockSendTemplate.mockClear();
  mockState.credits = [];
  mockState.messages = {};
  mockState.promoters = { 'pro-1': { id: 'pro-1', first_name: 'Lea', customer_email: 'lea@example.com' } };
  mockState.ledgerCalls = [];
});

describe('nextRewardEmailAt: the next 9:00 AM ET at or after the credit', () => {
  test.each([
    ['after 9:00 AM: the next morning (EST)', '2026-11-04T19:15:00.000Z', '2026-11-05T14:00:00.000Z'],
    ['before 9:00 AM: the same morning', '2026-11-05T12:40:00.000Z', '2026-11-05T14:00:00.000Z'],
    ['exactly 9:00 AM: at once', '2026-11-05T14:00:00.000Z', '2026-11-05T14:00:00.000Z'],
    ['across the Nov 1 clock change: 9:00 AM EST', '2026-10-31T19:00:00.000Z', '2026-11-01T14:00:00.000Z'],
    ['in daylight time: 9:00 AM EDT', '2026-10-30T11:00:00.000Z', '2026-10-30T13:00:00.000Z'],
    ['late evening ET (next UTC day): the next ET morning', '2026-11-05T02:30:00.000Z', '2026-11-05T14:00:00.000Z'],
  ])('%s', (_label, creditedAt, expected) => {
    expect(engine.nextRewardEmailAt(new Date(creditedAt)).toISOString()).toBe(expected);
  });
});

describe('sendDueReferralRewardEmails', () => {
  test('a credit from yesterday afternoon sends one email at 9:00 AM: the referrer, account-credit wording, keyed by referral', async () => {
    mockState.credits = [credit()];
    const out = await engine.sendDueReferralRewardEmails({ now: new Date('2026-11-05T14:00:00.000Z') });
    expect(out).toEqual({ credits: 1, attempted: 1 });
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    const sent = mockSendTemplate.mock.calls[0][0];
    expect(sent).toMatchObject({
      templateKey: 'referral.reward_earned',
      to: 'lea@example.com',
      idempotencyKey: 'referral.reward_earned:ref-1',
      triggerEventId: 'referral.reward_earned:ref-1',
    });
    expect(sent.payload.reward_line).toBe('Your $25 referral reward has been added to your account as a credit — it applies automatically to your next invoice.');
    expect(sent.payload.cta_label).toBe('View my account credit');
  });

  test('before its 9:00 AM a credit waits: posted 10:00 AM, checked 10:15 AM the same day', async () => {
    mockState.credits = [credit({ credited_at: '2026-11-05T15:00:00.000Z' })];
    const out = await engine.sendDueReferralRewardEmails({ now: new Date('2026-11-05T15:15:00.000Z') });
    expect(out).toEqual({ credits: 1, attempted: 0 });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('an email already sent is not sent again; a failed one is tried again', async () => {
    mockState.credits = [credit({ id: 'ref-sent' }), credit({ id: 'ref-failed' })];
    mockState.messages = {
      'referral.reward_earned:ref-sent': { status: 'sent' },
      'referral.reward_earned:ref-failed': { status: 'failed' },
    };
    const out = await engine.sendDueReferralRewardEmails({ now: new Date('2026-11-05T14:15:00.000Z') });
    expect(out).toEqual({ credits: 2, attempted: 1 });
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate.mock.calls[0][0].idempotencyKey).toBe('referral.reward_earned:ref-failed');
  });

  test('no promoter row: nothing to send', async () => {
    mockState.credits = [credit({ promoter_id: 'pro-gone' })];
    const out = await engine.sendDueReferralRewardEmails({ now: new Date('2026-11-05T14:00:00.000Z') });
    expect(out).toEqual({ credits: 1, attempted: 0 });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('reads only the referrer\'s credit rows of credited referrals from the last 7 days', async () => {
    const now = new Date('2026-11-05T14:00:00.000Z');
    await engine.sendDueReferralRewardEmails({ now });
    const calls = mockState.ledgerCalls;
    const has = (method, ...args) => calls.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args));
    expect(has('join', 'referrals as r', 'r.id', 'l.referral_id')).toBe(true);
    expect(has('where', 'l.source', 'referral')).toBe(true);
    expect(has('where', 'l.delta', '>', 0)).toBe(true);
    expect(has('whereRaw', 'l.customer_id = r.referrer_customer_id')).toBe(true);
    expect(has('where', 'r.status', 'credited')).toBe(true);
    const since = calls.find(([m, a]) => m === 'where' && a[0] === 'l.created_at');
    expect(since[1][1]).toBe('>=');
    expect(since[1][2].toISOString()).toBe('2026-10-29T14:00:00.000Z');
  });
});

describe('the credit itself sends nothing; the scheduler sends the email', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('creditReferralOnFirstService takes no notify flag and sends no text or email', () => {
    const src = read('../services/referral-engine.js');
    const start = src.indexOf('async function creditReferralOnFirstService(');
    const end = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, end);
    expect(body.startsWith('async function creditReferralOnFirstService({ customerId, serviceId })')).toBe(true);
    expect(body).not.toMatch(/sendSMS|sendRewardEarnedEmail|renderReferralSms|notify/);
  });

  test('every caller drops the old notify flag', () => {
    expect(read('../services/complete-scheduled-service.js')).toMatch(/creditReferralOnFirstService\(\{ customerId: svc\.customer_id, serviceId: svc\.id \}\)/);
    expect(read('../services/referral-inbound.js')).toMatch(/creditReferralOnFirstService\(\{ customerId, serviceId: firstVisit\.id \}\)/);
  });

  test('scheduler: every 15 minutes 9:00-11:45 AM ET under its lock, after the cron-jobs switch', () => {
    const src = read('../services/scheduler.js');
    const job = src.indexOf("await runExclusive('referral-reward-email', () => require('./referral-engine').sendDueReferralRewardEmails())");
    expect(job).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, job - 200), job)).toMatch(/cron\.schedule\('\*\/15 9-11 \* \* \*', async \(\) => \{\s*try \{\s*$/);
    expect(job).toBeGreaterThan(src.indexOf("if (!isEnabled('cronJobs')) {"));
  });
});
