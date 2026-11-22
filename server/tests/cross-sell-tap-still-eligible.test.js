// The shared add-a-service tap on a LINK surface (receipt, tracker; #8262,
// pre-push audit P0 2026-11-22). The route reads the link's eligibility
// before the tap. The tap reads it again inside its write, with the customer
// row locked (AGENTS.md: the commit path re-checks the preflight read). This
// suite drives the REAL tap and the REAL writer over a fake database:
//   - a second read that says no answers the surface's own 404 and writes
//     nothing (no request row, no office bell);
//   - a second read that says yes records the request as before;
//   - the report passes no second read and is unchanged;
//   - the tap is bound to the link's customer: a service record that now
//     belongs to someone else is the 404 before any lock or write;
//   - a second read that throws never puts its error text (Knex binds the
//     link's token into it) in a log;
//   - the referral tap enrolls only after the lock and a yes.
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/cross-sell', () => ({ buildReportCrossSell: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => {}) }));
jest.mock('../services/referral-share', () => ({ buildReferralShareForCustomer: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const logger = require('../services/logger');
const { buildReportCrossSell } = require('../services/service-report/cross-sell');
const { triggerNotification } = require('../services/notification-triggers');
const referralShare = require('../services/referral-share');
const { handleCrossSellTap, referralShareIfStillEligible } = require('../services/service-report/cross-sell-tap');

const OFFER = {
  serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'priced', relationship: 'add', fingerprint: 'FP-1',
  option: { id: 'lawn-enhanced', perVisit: 57.6 },
};
const METADATA = {
  serviceKey: 'lawn_care', offerMode: 'priced', perApplication: 57.6, optionId: 'lawn-enhanced', fingerprint: 'FP-1',
};
const RECEIPT = Object.freeze({
  source: 'invoice_receipt', noun: 'receipt', title: 'invoice receipt', notFoundBody: { error: 'Receipt not found' },
});

// log: every step in order, so a test can read what ran before what.
function fakeDb() {
  const log = [];
  const handle = (kind) => {
    const q = (table) => {
      const chain = {
        leftJoin: () => chain,
        where: () => chain,
        whereIn: () => chain,
        whereNotIn: () => chain,
        orderBy: () => chain,
        select: () => chain,
        forUpdate: () => { log.push(`${kind}:lock:${table}`); return chain; },
        update: async () => { log.push(`${kind}:update:${table}`); return 1; },
        insert: (row) => {
          log.push(`${kind}:insert:${table}`);
          return { returning: async () => [{ id: 'req-new', ...row }] };
        },
        first: async () => {
          log.push(`${kind}:read:${table}`);
          if (table === 'service_records as sr') return { id: 'sr-1', customer_id: 'cust-1', first_name: 'Pat', last_name: 'Q' };
          if (table === 'customers') return { id: 'cust-1' };
          return null; // no open request
        },
      };
      return chain;
    };
    q.raw = (sql) => sql;
    return q;
  };
  const db = handle('db');
  const trx = handle('trx');
  db.transaction = async (work) => work(trx);
  return { db, trx, log };
}

beforeEach(() => {
  jest.clearAllMocks();
  buildReportCrossSell.mockResolvedValue(OFFER);
});

describe('handleCrossSellTap with a second eligibility read', () => {
  test('the second read says no → the surface\'s own 404, nothing written, no bell', async () => {
    const { db, trx, log } = fakeDb();
    const stillEligible = jest.fn(async () => { log.push('second-read'); return false; });
    const answer = await handleCrossSellTap({
      db, serviceRecordId: 'sr-1', metadata: METADATA, surface: RECEIPT, stillEligible,
    });
    expect(answer).toEqual({ status: 404, body: { error: 'Receipt not found' } });
    expect(stillEligible).toHaveBeenCalledWith(trx);
    // The customer row is locked first; the second read follows; nothing else runs.
    expect(log.slice(log.indexOf('trx:lock:customers'))).toEqual(['trx:lock:customers', 'trx:read:customers', 'second-read']);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('the second read says yes → the request is recorded and the office is told', async () => {
    const { db, log } = fakeDb();
    const answer = await handleCrossSellTap({
      db, serviceRecordId: 'sr-1', metadata: METADATA, surface: RECEIPT,
      stillEligible: async () => { log.push('second-read'); return true; },
    });
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    expect(log.indexOf('second-read')).toBeGreaterThan(log.indexOf('trx:lock:customers'));
    expect(log.indexOf('second-read')).toBeLessThan(log.indexOf('trx:insert:service_requests'));
    expect(triggerNotification).toHaveBeenCalledWith('bundle_quote_requested', expect.objectContaining({ customerId: 'cust-1' }));
  });

  test.each([
    ['a database error with a code', { code: '08006' }, '08006'],
    ['an error with no code', {}, 'recheck_failed'],
  ])('a second read that fails (%s) is "try again": nothing recorded, no token in the log', async (_label, extra, logged) => {
    const { db, log } = fakeDb();
    const TOKEN = 'a'.repeat(64);
    const answer = await handleCrossSellTap({
      db, serviceRecordId: 'sr-1', metadata: METADATA, surface: RECEIPT,
      stillEligible: async () => { throw Object.assign(new Error(`select ... where "i"."token" = '${TOKEN}' - failed`), extra); },
    });
    expect(answer.status).toBe(503);
    expect(log).not.toContain('trx:insert:service_requests');
    expect(triggerNotification).not.toHaveBeenCalled();
    const text = logger.warn.mock.calls.flat().join(' ');
    expect(text).toContain(logged);
    expect(text).not.toContain(TOKEN);
  });

  // Pre-push audit P0 (2026-11-22): the route read the link for one
  // customer; the record the offer is recomputed from must still be theirs.
  test('the service record now belongs to another customer → the 404, before any offer, lock or write', async () => {
    const { db, log } = fakeDb();
    const stillEligible = jest.fn(async () => true);
    const answer = await handleCrossSellTap({
      db, serviceRecordId: 'sr-1', metadata: METADATA, surface: RECEIPT, stillEligible, linkCustomerId: 'cust-other',
    });
    expect(answer).toEqual({ status: 404, body: { error: 'Receipt not found' } });
    expect(buildReportCrossSell).not.toHaveBeenCalled();
    expect(stillEligible).not.toHaveBeenCalled();
    expect(log.some((step) => step.startsWith('trx:'))).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('the link\'s own customer taps → recorded, and the locked customer is the link\'s', async () => {
    const { db, log } = fakeDb();
    const answer = await handleCrossSellTap({
      db, serviceRecordId: 'sr-1', metadata: METADATA, surface: RECEIPT, stillEligible: async () => true, linkCustomerId: 'cust-1',
    });
    expect(answer.status).toBe(200);
    expect(log).toContain('trx:lock:customers');
    expect(triggerNotification).toHaveBeenCalledWith('bundle_quote_requested', expect.objectContaining({ customerId: 'cust-1' }));
  });

  test('the report passes no second read and records as before', async () => {
    const { db, log } = fakeDb();
    const answer = await handleCrossSellTap({
      db, serviceRecordId: 'sr-1', metadata: METADATA,
      surface: { source: 'service_report', noun: 'report', title: 'service report' },
    });
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    expect(log).toContain('trx:insert:service_requests');
  });
});

describe('referralShareIfStillEligible', () => {
  test('locks the customer row, then reads, then enrolls on the same transaction', async () => {
    const { db, trx, log } = fakeDb();
    referralShare.buildReferralShareForCustomer.mockImplementation(async () => { log.push('enroll'); return { code: 'WAVES-1' }; });
    const share = await referralShareIfStillEligible(db, 'cust-1', async (handle) => {
      log.push(handle === trx ? 'second-read' : 'second-read-off-transaction');
      return true;
    });
    expect(share).toEqual({ code: 'WAVES-1' });
    expect(log).toEqual(['trx:lock:customers', 'trx:read:customers', 'second-read', 'enroll']);
    expect(referralShare.buildReferralShareForCustomer).toHaveBeenCalledWith('cust-1', { conn: trx });
  });

  test('a second read that says no enrolls nobody', async () => {
    const { db } = fakeDb();
    expect(await referralShareIfStillEligible(db, 'cust-1', async () => false)).toBeNull();
    expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
  });
});
