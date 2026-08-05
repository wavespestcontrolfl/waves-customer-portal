// Stale-touch skip (owner ruling 2026-08-04): a dunning touch fires on its
// scheduled calendar day or not at all. After the 07-29→08-04 cron outage the
// revived tick must advance overdue sequences along their anchored timeline
// WITHOUT sending — never burst a week of stale payment reminders.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/invoice-helpers', () => ({ invoiceAmountDue: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {} }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/microdeposit-verification-email', () => ({
  sendMicrodepositVerificationEmail: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(),
  invoiceShortCodePrefix: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn() }));
jest.mock('../services/email-template-library', () => ({}));
jest.mock('../services/customer-contact', () => ({ getInvoiceEmailRecipients: jest.fn() }));
jest.mock('../services/email-template', () => ({ currency: jest.fn() }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: jest.fn() }));
// ../config/invoice-followups stays REAL — the cadence table (3/7/14/30 days
// after send, 10 AM NY) is the contract under test.

const db = require('../models/db');
const {
  runPending,
  skipStaleTouches,
  firstEligibleFireAt,
  STALE_TOUCH_GRACE_MS,
} = require('../services/invoice-followups');

// Pin the clock to Wednesday 2026-08-05 10:16 AM ET (14:16 UTC) — inside the
// Tue–Fri send window, matching the staggered cron tick.
const NOW = new Date('2026-08-05T14:16:00Z');
// A 10:00 AM EDT touch on the given day.
const touchAt = (day) => new Date(`${day}T14:00:00Z`);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

function setupDb({ batchRows, seqUpdateResult = 1 }) {
  const seqUpdate = jest.fn(async () => seqUpdateResult);
  const transaction = jest.fn(async () => {});
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  db.transaction = transaction;
  db.mockImplementation((table) => {
    if (table === 'invoice_followup_sequences as s') {
      const q = {
        join: jest.fn(() => q),
        where: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        select: jest.fn(() => q),
        then: (resolve, reject) => Promise.resolve(batchRows).then(resolve, reject),
      };
      return q;
    }
    if (table === 'invoice_followup_sequences') {
      const q = {
        where: jest.fn(() => q),
        update: seqUpdate,
      };
      return q;
    }
    throw new Error(`unexpected table in test: ${table}`);
  });
  return { seqUpdate, transaction };
}

// Sequence row as runPending's batch select shapes it (s.* + invoice aliases).
function seqRow(overrides = {}) {
  return {
    id: 'seq-1',
    invoice_id: 'inv-1',
    customer_id: 'cust-1',
    status: 'active',
    step_index: 0,
    touches_sent: 0,
    anchor_at: null,
    created_at: touchAt('2026-07-26'),
    invoice_sent_at: new Date('2026-07-26T14:00:00Z'),
    invoice_sms_sent_at: null,
    invoice_created_at: new Date('2026-07-26T13:00:00Z'),
    ...overrides,
  };
}

describe('runPending stale routing (the branch condition)', () => {
  test('a touch more than the grace overdue is skipped forward, never sent', async () => {
    // Due Wed 07-29 10:00 ET — 7 days stale. fireStep opens db.transaction;
    // the skip path must never get there.
    const row = seqRow({ next_touch_at: touchAt('2026-07-29') });
    const { seqUpdate, transaction } = setupDb({ batchRows: [row] });

    const result = await runPending();

    expect(transaction).not.toHaveBeenCalled(); // no send machinery engaged
    expect(seqUpdate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  test('a same-day touch (tick minutes after the 10:00 anchor) still fires', async () => {
    // Due today 10:00, tick 10:16 — 16 minutes overdue, well inside grace.
    const row = seqRow({ next_touch_at: touchAt('2026-08-05') });
    const { transaction } = setupDb({ batchRows: [row] });

    const result = await runPending();

    // The fire path engages (fireStep's claim transaction runs; with the stub
    // transaction claiming nothing, the touch is a no-op "sent" attempt).
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
  });

  test('a weekend/Monday-anchored touch fires on its first eligible Tuesday (Codex r1 P1)', async () => {
    // Due Monday 08-03 10:00 — no Monday run exists; Tuesday 10:16 is its
    // FIRST chance and must send, not stale-skip (routine weekend cadence).
    jest.setSystemTime(new Date('2026-08-04T14:16:00Z')); // Tue 10:16 ET
    const row = seqRow({ next_touch_at: touchAt('2026-08-03') });
    const { transaction } = setupDb({ batchRows: [row] });

    const result = await runPending();

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test('a stale skip landing on a step due today fires it in the same run (Codex r1 P2)', async () => {
    // Invoice sent Wed 07-29: d3 due Sat 08-01 (eligible Tue 08-04 — missed,
    // stale by Wed), d7 due today Wed 08-05. The skip persists step 1 due
    // today; leaving it unsent would strand it as stale on Thursday's tick.
    const row = seqRow({
      invoice_sent_at: new Date('2026-07-29T14:00:00Z'),
      invoice_created_at: new Date('2026-07-29T13:00:00Z'),
      created_at: touchAt('2026-07-29'),
      next_touch_at: touchAt('2026-08-01'),
    });
    const { seqUpdate, transaction } = setupDb({ batchRows: [row] });

    const result = await runPending();

    expect(seqUpdate).toHaveBeenCalledWith(expect.objectContaining({
      step_index: 1,
      next_touch_at: new Date('2026-08-05T14:00:00Z'),
      status: 'active',
    }));
    expect(transaction).toHaveBeenCalledTimes(1); // the landing d7 fires now
    expect(result).toEqual({ sent: 1, skipped: 1 });
  });
});

describe('firstEligibleFireAt', () => {
  test('Sat/Sun/Mon anchors roll to Tuesday 10:00 NY; Tue–Fri are themselves', () => {
    const tue = '2026-08-04T14:00:00.000Z';
    expect(firstEligibleFireAt(touchAt('2026-08-01')).toISOString()).toBe(tue); // Sat
    expect(firstEligibleFireAt(touchAt('2026-08-02')).toISOString()).toBe(tue); // Sun
    expect(firstEligibleFireAt(touchAt('2026-08-03')).toISOString()).toBe(tue); // Mon
    expect(firstEligibleFireAt(touchAt('2026-08-05')).toISOString()).toBe('2026-08-05T14:00:00.000Z'); // Wed
  });
});

describe('skipStaleTouches', () => {
  test('walks the anchored timeline past every missed step to the next future one', async () => {
    // Invoice sent Sun 07-26 → d3 due 07-29 (stale), d7 due 08-02 (stale),
    // d14 due 08-09 (future). Expect: advance to step 2, armed for 08-09.
    const row = seqRow({ next_touch_at: touchAt('2026-07-29') });
    const { seqUpdate } = setupDb({ batchRows: [] });

    const result = await skipStaleTouches(row, NOW);

    expect(result.skippedSteps).toEqual(['d3_friendly', 'd7_reminder']);
    expect(result.nextIndex).toBe(2);
    expect(result.nextAt.toISOString()).toBe('2026-08-09T14:00:00.000Z');
    expect(result.updated).toBe(true);
    expect(seqUpdate).toHaveBeenCalledWith(expect.objectContaining({
      step_index: 2,
      status: 'active',
      next_touch_at: new Date('2026-08-09T14:00:00Z'),
    }));
  });

  test('a stale final step completes the sequence instead of re-arming', async () => {
    // On the d30 final notice (step 3), due 07-29 and missed: no later step
    // exists, so the sequence completes silently.
    const row = seqRow({ step_index: 3, next_touch_at: touchAt('2026-07-29') });
    const { seqUpdate } = setupDb({ batchRows: [] });

    const result = await skipStaleTouches(row, NOW);

    expect(result.skippedSteps).toEqual(['d30_final']);
    expect(result.nextAt).toBeNull();
    expect(seqUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      next_touch_at: null,
    }));
  });

  test('a concurrently-changed sequence is left alone (guarded update no-ops)', async () => {
    const row = seqRow({ next_touch_at: touchAt('2026-07-29') });
    setupDb({ batchRows: [], seqUpdateResult: 0 });

    const result = await skipStaleTouches(row, NOW);

    expect(result.updated).toBe(false);
  });

  test('an admin-shifted anchor (anchor_at) drives the walk, not the send date', async () => {
    // Anchor moved to 08-01: d3 due 08-04 (stale by 1 day at 20h grace? 24h —
    // stale), d7 due 08-08 (future). The invoice_sent_at fallback (07-26)
    // must NOT be used — that would land on step 2 instead of step 1.
    const row = seqRow({
      anchor_at: new Date('2026-08-01T14:00:00Z'),
      next_touch_at: touchAt('2026-08-04'),
    });
    const { seqUpdate } = setupDb({ batchRows: [] });

    const result = await skipStaleTouches(row, NOW);

    expect(result.skippedSteps).toEqual(['d3_friendly']);
    expect(result.nextIndex).toBe(1);
    expect(result.nextAt.toISOString()).toBe('2026-08-08T14:00:00.000Z');
    expect(seqUpdate).toHaveBeenCalled();
  });
});

test('grace constant matches the fires-on-its-day-or-not-at-all contract', () => {
  // Must be longer than any same-day drift (anchor 10:00 → staggered tick)
  // and shorter than the 24h gap to the next day's tick.
  expect(STALE_TOUCH_GRACE_MS).toBeGreaterThan(6 * 3600 * 1000);
  expect(STALE_TOUCH_GRACE_MS).toBeLessThan(24 * 3600 * 1000);
});
