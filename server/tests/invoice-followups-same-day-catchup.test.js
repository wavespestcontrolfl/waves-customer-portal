// GATE_MONEY_NOTICE_CATCHUP, invoice follow-ups (owner 2026-11-06, "jobs 1-6"): a
// second same-day run at 1:16 PM ET (scheduler.js) calls runPending({ catchUp: true }).
// It must stay inside the 2026-08-04 ruling (a touch goes out on its first eligible
// day or not at all) and never send a touch the 10:16 run already sent:
//  - a touch due today at 10:00 is 3h16m old at 1:16, inside the 20-hour grace: sent;
//  - a touch due yesterday is past the grace at 1:16, exactly as at 10:16: skipped;
//  - a row the 10:16 run sent has moved to its next step, whose first eligible day is
//    never today (pinned below for both cadences);
//  - a row still claimed (an interrupted 10:16 send) is not taken by the catch-up query.
// Harness copied from invoice-followups-stale-skip.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-helpers', () => ({
  invoiceAmountDue: jest.fn(),
  invoiceWithdrawnFromCustomer: (invoice) => /^payer_billed:/.test(String(invoice?.scheduled_send_error || '')),
}));
jest.mock('../routes/admin-sms-templates', () => ({}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {} }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/microdeposit-verification-email', () => ({ sendMicrodepositVerificationEmail: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(), invoiceShortCodePrefix: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn() }));
jest.mock('../services/email-template-library', () => ({}));
jest.mock('../services/customer-contact', () => ({ getInvoiceEmailRecipients: jest.fn() }));
jest.mock('../services/email-template', () => ({ currency: jest.fn() }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: jest.fn() }));
// ../config/invoice-followups stays REAL: the cadence table is the contract under test.

const db = require('../models/db');
const config = require('../config/invoice-followups');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const {
  runPending, firstEligibleFireAt, computeNextTouchAt, isStaleTouch,
} = require('../services/invoice-followups');

// Wednesday 2026-08-05 1:16 PM EDT (17:16 UTC): the catch-up tick.
const CATCH_UP_NOW = new Date('2026-08-05T17:16:00Z');
const touchAt = (day) => new Date(`${day}T14:00:00Z`); // 10:00 AM EDT

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(CATCH_UP_NOW);
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

// The batch select records whether runPending's catch-up filter added the claim test.
function setupDb({ batchRows }) {
  const seqUpdate = jest.fn(async () => 1);
  const transaction = jest.fn(async () => {});
  const claimFilter = [];
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  db.transaction = transaction;
  let sReads = 0;
  db.mockImplementation((table) => {
    if (table === 'invoice_followup_sequences as s') {
      if (sReads++ === 0) {
        const empty = new Proxy({}, { get: (_t, prop) => (prop === 'then'
          ? (resolve, reject) => Promise.resolve([]).then(resolve, reject)
          : () => empty) });
        return empty;
      }
      const q = {
        join: jest.fn(() => q),
        where: jest.fn((arg) => {
          if (typeof arg === 'function' && arg.name === 'unclaimedOnCatchUp') {
            arg.call({ whereNull: (col) => { claimFilter.push(col); } });
          }
          return q;
        }),
        whereNotIn: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        select: jest.fn(() => q),
        then: (resolve, reject) => Promise.resolve(batchRows).then(resolve, reject),
      };
      return q;
    }
    if (table === 'invoice_followup_sequences') {
      const q = { where: jest.fn(() => q), update: seqUpdate };
      return q;
    }
    throw new Error(`unexpected table in test: ${table}`);
  });
  return { seqUpdate, transaction, claimFilter };
}

function seqRow(overrides = {}) {
  return {
    id: 'seq-1', invoice_id: 'inv-1', customer_id: 'cust-1', status: 'active',
    step_index: 0, touches_sent: 0, anchor_at: null, created_at: touchAt('2026-07-26'),
    invoice_sent_at: new Date('2026-07-26T14:00:00Z'), invoice_sms_sent_at: null,
    invoice_created_at: new Date('2026-07-26T13:00:00Z'),
    ...overrides,
  };
}

test('nothing due at 1:16: nothing is fired, nothing is sent', async () => {
  const { transaction, seqUpdate } = setupDb({ batchRows: [] });
  await expect(runPending({ catchUp: true })).resolves.toEqual({ sent: 0, skipped: 0 });
  expect(transaction).not.toHaveBeenCalled();
  expect(seqUpdate).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('a touch due today that the 10:16 run never reached fires at 1:16 (inside the 20-hour grace)', async () => {
  const { transaction } = setupDb({ batchRows: [seqRow({ next_touch_at: touchAt('2026-08-05') })] });
  await expect(runPending({ catchUp: true })).resolves.toEqual({ sent: 1, skipped: 0 });
  expect(transaction).toHaveBeenCalledTimes(1); // fireStep's claim transaction: the fire path ran
});

test('a touch due yesterday is stale at 1:16 too: skipped forward, never sent late', async () => {
  const { transaction, seqUpdate } = setupDb({ batchRows: [seqRow({ next_touch_at: touchAt('2026-08-04') })] });
  await expect(runPending({ catchUp: true })).resolves.toEqual({ sent: 0, skipped: 1 });
  expect(transaction).not.toHaveBeenCalled();
  expect(seqUpdate).toHaveBeenCalledTimes(1);
});

test('the catch-up query never takes a claimed row; the 10:16 query is unchanged', async () => {
  let { claimFilter } = setupDb({ batchRows: [] });
  await runPending({ catchUp: true });
  expect(claimFilter).toEqual(['s.touch_claimed_at']);

  ({ claimFilter } = setupDb({ batchRows: [] }));
  await runPending();
  expect(claimFilter).toEqual([]);
});

test('the grace that lets 1:16 send today\'s touch rejects the same touch on any later day', () => {
  expect(isStaleTouch(touchAt('2026-08-05'), CATCH_UP_NOW)).toBe(false);
  expect(isStaleTouch(touchAt('2026-08-05'), new Date('2026-08-06T14:16:00Z'))).toBe(true); // Thu 10:16
  expect(isStaleTouch(touchAt('2026-08-05'), new Date('2026-08-06T17:16:00Z'))).toBe(true); // Thu 1:16
});

// A sent touch advances the row to step N+1 at computeNextTouchAt(anchor, N+1). If that
// step's first eligible day could equal step N's, the 1:16 run would send a second touch
// the same day. Every consecutive pair, on both cadences, for an anchor on each weekday.
test.each([['legacy', config.steps], ['Day 90 ladder', config.stepsThrough90]])(
  'no two consecutive %s steps share a first eligible send day', (_name, steps) => {
    for (let d = 0; d < 7; d++) {
      const anchor = new Date(Date.UTC(2026, 7, 2 + d, 14, 0, 0)); // Sun 08-02 .. Sat 08-08, 10:00 EDT
      for (let i = 0; i + 1 < steps.length; i++) {
        const thisDay = firstEligibleFireAt(computeNextTouchAt(anchor, i, steps)).toISOString().slice(0, 10);
        const nextDay = firstEligibleFireAt(computeNextTouchAt(anchor, i + 1, steps)).toISOString().slice(0, 10);
        expect(nextDay > thisDay).toBe(true);
      }
    }
  },
);
