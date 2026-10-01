// Day 90 follow-up ladder (GATE_DUNNING_LADDER_90, dunning unification,
// owner rulings 2026-09-27): Day 3/10/17/30/60/90 with touches a week or
// more apart, Day 90 the only final notice, and a finished sequence still
// owns its invoice so the late-payment checker never picks it up afterwards.
// Gate off: the legacy Day 3/7/14/30 ladder, byte-identical.
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
// ../config/invoice-followups stays REAL: both cadence tables are the contract.

const db = require('../models/db');
const config = require('../config/invoice-followups');
const {
  runPending, hasActiveSequence, followupSteps, liveNextTouchAt,
} = require('../services/invoice-followups');

// Wednesday 2026-08-05 10:16 AM ET, inside the Tue–Fri send window.
const NOW = new Date('2026-08-05T14:16:00Z');
const tenAmET = (day) => new Date(`${day}T14:00:00Z`); // 10:00 EDT

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  delete process.env.GATE_DUNNING_LADDER_90;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_DUNNING_LADDER_90;
});

// Each `invoice_followup_sequences as s` read is answered in order (the
// revival read comes before the send batch when the gate is on).
function setupDb({ joinedReads = [], seqUpdateResult = 1 }) {
  const reads = [...joinedReads];
  const joined = [];
  const seqUpdates = [];
  const transaction = jest.fn(async () => {});
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  db.transaction = transaction;
  db.mockImplementation((table) => {
    if (table === 'invoice_followup_sequences as s') {
      const rows = reads.shift() || [];
      const q = { wheres: [] };
      for (const method of ['join', 'whereNotIn', 'whereIn', 'whereNull', 'select']) q[method] = jest.fn(() => q);
      q.where = jest.fn((...args) => { q.wheres.push(args); return q; });
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      joined.push(q);
      return q;
    }
    if (table === 'invoice_followup_sequences') {
      const q = { wheres: [] };
      q.where = jest.fn((...args) => { q.wheres.push(args); return q; });
      q.whereIn = jest.fn((...args) => { q.whereInArgs = args; return q; });
      q.first = jest.fn(async () => undefined);
      q.update = jest.fn(async (patch) => { seqUpdates.push({ wheres: q.wheres, patch }); return seqUpdateResult; });
      return q;
    }
    throw new Error(`unexpected table in test: ${table}`);
  });
  return { joined, seqUpdates, transaction };
}

function seqRow(overrides = {}) {
  return {
    id: 'seq-1',
    invoice_id: 'inv-1',
    customer_id: 'cust-1',
    status: 'active',
    step_index: 0,
    touches_sent: 0,
    anchor_at: null,
    created_at: tenAmET('2026-07-29'),
    invoice_sent_at: tenAmET('2026-07-29'), // Wed 07-29
    invoice_sms_sent_at: null,
    invoice_created_at: tenAmET('2026-07-29'),
    ...overrides,
  };
}

describe('the cadence', () => {
  test('gate off: the legacy Day 3/7/14/30 ladder', () => {
    expect(followupSteps().map((s) => s.daysAfterSend)).toEqual([3, 7, 14, 30]);
    expect(followupSteps()).toBe(config.steps);
  });

  test('gate on: Day 3/10/17/30/60/90, the first four keeping their ids', () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const steps = followupSteps();
    expect(steps.map((s) => s.daysAfterSend)).toEqual([3, 10, 17, 30, 60, 90]);
    expect(steps.slice(0, 4).map((s) => s.id)).toEqual(config.steps.map((s) => s.id));
    expect(steps.filter((s) => /final/i.test(s.label)).map((s) => s.daysAfterSend)).toEqual([90]);
    // A week or more between consecutive touches.
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].daysAfterSend - steps[i - 1].daysAfterSend).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('which sequences own their invoice', () => {
  // Records the ownership query, including the whereNot clause's inner where().
  function ownershipQuery(first) {
    const recorded = { whereIn: null, notClauses: [] };
    db.mockImplementation(() => {
      const q = {
        where: jest.fn(() => q),
        whereIn: jest.fn((...args) => { recorded.whereIn = args; return q; }),
        whereNot: jest.fn((fn) => {
          const clause = [];
          const b = { where: jest.fn((...args) => { clause.push(args); return b; }) };
          fn.call(b, b);
          recorded.notClauses.push(clause);
          return q;
        }),
        first: jest.fn(async () => first),
      };
      return q;
    });
    return recorded;
  }

  test('gate off: live sequences, except an active one the Day 90 ladder moved past Day 30', async () => {
    const recorded = ownershipQuery(undefined);
    await hasActiveSequence('inv-1');
    expect(recorded.whereIn).toEqual(['status', ['active', 'paused', 'autopay_hold']]);
    expect(recorded.notClauses).toEqual([[['status', 'active'], ['step_index', '>=', 4]]]);
  });

  test('gate on: a sequence finished past the Day 30 end counts too; a payment finish before it does not', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const recorded = ownershipQuery({ id: 'seq-1' });
    await expect(hasActiveSequence('inv-1')).resolves.toBe(true);
    expect(recorded.whereIn).toEqual(['status', ['active', 'paused', 'autopay_hold', 'completed']]);
    expect(recorded.notClauses).toEqual([[['status', 'completed'], ['step_index', '<', 4]]]);
  });
});

describe('when the next touch really fires (liveNextTouchAt)', () => {
  test('gate off: the stored time, the legacy day for a ladder-scheduled touch, and nothing past the legacy cadence', async () => {
    const anchored = { anchor_at: tenAmET('2026-07-29') };
    const legacyDay7 = tenAmET('2026-08-05');
    await expect(liveNextTouchAt('inv-1', { ...anchored, step_index: 1, next_touch_at: legacyDay7 }, NOW)).resolves.toBe(legacyDay7);
    // Ladder Day 10 (Sat 08-08) goes back to legacy Day 7 (Wed 08-05), which is today and still sendable.
    await expect(liveNextTouchAt('inv-1', { ...anchored, step_index: 1, next_touch_at: tenAmET('2026-08-08') }, NOW))
      .resolves.toEqual(legacyDay7);
    // Steps timed alike by both cadences need no anchor.
    await expect(liveNextTouchAt('inv-1', { step_index: 0, next_touch_at: legacyDay7 }, NOW)).resolves.toBe(legacyDay7);
    await expect(liveNextTouchAt('inv-1', { step_index: 4, next_touch_at: legacyDay7 }, NOW)).resolves.toBeNull();
  });

  test('gate on: a legacy Day 7 touch really fires on its Day 10; a touch past the ladder fires nothing', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    db.mockImplementation((table) => {
      if (table !== 'invoices') throw new Error(`unexpected table ${table}`);
      const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ sent_at: tenAmET('2026-07-29'), sms_sent_at: null, created_at: tenAmET('2026-07-29') })) };
      return q;
    });
    await expect(liveNextTouchAt('inv-1', { step_index: 1, next_touch_at: tenAmET('2026-08-05') }))
      .resolves.toEqual(tenAmET('2026-08-08'));
    // An admin-shifted anchor needs no invoice read.
    await expect(liveNextTouchAt('inv-1', { step_index: 0, anchor_at: tenAmET('2026-08-02'), next_touch_at: tenAmET('2026-08-05') }))
      .resolves.toEqual(tenAmET('2026-08-05'));
    await expect(liveNextTouchAt('inv-1', { step_index: 6, next_touch_at: tenAmET('2026-08-05') })).resolves.toBeNull();
  });

  test('gate on: a finish at the Day 60 step awaiting revival fires on the first step not already past its day', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const finished = (sentDay) => ({ status: 'completed', step_index: 4, anchor_at: tenAmET(sentDay), next_touch_at: null });
    // Sent Mon 06-08: Day 60 = Fri 08-07, still ahead of NOW (Wed 08-05).
    await expect(liveNextTouchAt('inv-1', finished('2026-06-08'), NOW)).resolves.toEqual(tenAmET('2026-08-07'));
    // Sent Mon 05-11: Day 60 (Fri 07-10) is long past, so the run passes it
    // over to Day 90 = Sun 08-09 (first fires Tue 08-11).
    await expect(liveNextTouchAt('inv-1', finished('2026-05-11'), NOW)).resolves.toEqual(tenAmET('2026-08-09'));
    // Both past: the run finishes it, no touch.
    await expect(liveNextTouchAt('inv-1', finished('2026-03-01'), NOW)).resolves.toBeNull();
    // A payment finish before the Day 30 end is not revived.
    await expect(liveNextTouchAt('inv-1', { ...finished('2026-06-08'), step_index: 2 }, NOW)).resolves.toBeNull();
  });

  test('gate off: a finished sequence has no next touch', async () => {
    await expect(liveNextTouchAt('inv-1', { status: 'completed', step_index: 4, anchor_at: tenAmET('2026-06-08'), next_touch_at: null }, NOW))
      .resolves.toBeNull();
  });
});

describe('runPending under the Day 90 ladder', () => {
  test('gate off: no revival read, and a Day 7 touch fires as before', async () => {
    const row = seqRow({ step_index: 1, next_touch_at: tenAmET('2026-08-05') });
    const { joined, seqUpdates, transaction } = setupDb({ joinedReads: [[row]] });
    const result = await runPending();
    expect(joined).toHaveLength(1);
    expect(joined[0].wheres).toEqual(expect.arrayContaining([['s.status', 'active']]));
    expect(seqUpdates).toHaveLength(0);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  // codex #5126 r2: turning the ladder off restores the legacy day.
  test('gate off: a touch the ladder put on Day 10 goes back to its legacy Day 7', async () => {
    jest.setSystemTime(new Date('2026-08-04T14:16:00Z')); // Tue 08-04 10:16 ET
    // Sent Wed 07-29: ladder Day 10 = Sat 08-08, legacy Day 7 = Wed 08-05.
    const ladderRow = seqRow({ step_index: 1, next_touch_at: tenAmET('2026-08-08') });
    const { seqUpdates, transaction } = setupDb({ joinedReads: [[ladderRow]] });
    const result = await runPending();
    expect(seqUpdates).toHaveLength(1);
    expect(seqUpdates[0].wheres).toEqual([
      [{ id: 'seq-1', status: 'active', step_index: 1 }],
      ['next_touch_at', tenAmET('2026-08-08')],
    ]);
    expect(seqUpdates[0].patch.next_touch_at).toEqual(tenAmET('2026-08-05'));
    expect(transaction).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  test('gate off: a ladder touch whose legacy day is today is moved back and sent in the same run', async () => {
    // NOW Wed 08-05; sent Wed 07-29: legacy Day 7 = today 10:00.
    const ladderRow = seqRow({ step_index: 1, next_touch_at: tenAmET('2026-08-08') });
    const { seqUpdates, transaction } = setupDb({ joinedReads: [[ladderRow]] });
    const result = await runPending();
    expect(seqUpdates[0].patch.next_touch_at).toEqual(tenAmET('2026-08-05'));
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test('gate off: the ladder day stands when the legacy day already passed, and early legacy rows are left alone', async () => {
    // NOW Wed 08-05; sent Mon 07-27: legacy Day 7 = Mon 08-03 (first fire Tue 08-04, past its grace),
    // ladder Day 10 = Thu 08-06.
    const late = seqRow({ id: 'seq-2', step_index: 1, invoice_sent_at: tenAmET('2026-07-27'), next_touch_at: tenAmET('2026-08-06') });
    // A legacy-scheduled row not yet due (Day 14 = Wed 08-12) is not a ladder time.
    const legacy = seqRow({ id: 'seq-3', step_index: 2, next_touch_at: tenAmET('2026-08-07') });
    const { seqUpdates, transaction } = setupDb({ joinedReads: [[late, legacy]] });
    const result = await runPending();
    expect(seqUpdates).toHaveLength(0);
    expect(transaction).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 0 });
  });

  test('a sequence that finished at Day 30 on an open invoice resumes at its Day 60 step', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const finished = seqRow({ id: 'seq-9', status: 'completed', step_index: 4, invoice_sent_at: tenAmET('2026-06-20') });
    const { joined, seqUpdates, transaction } = setupDb({ joinedReads: [[finished], []] });
    await runPending();
    // The revival read selects finishes at Day 60 or Day 90 on open invoices.
    const revivalWheres = joined[0].wheres;
    expect(revivalWheres).toEqual(expect.arrayContaining([
      ['s.status', 'completed'], ['s.step_index', '>=', 4], ['s.step_index', '<', 6],
    ]));
    // Published/delivered statuses only (Fable pre-push P2 F) — same
    // whitelist adoptOrphanInvoices uses, not the wider "not terminal" test.
    expect(joined[0].whereIn).toHaveBeenCalledWith('i.status', ['sent', 'viewed', 'overdue']);
    expect(joined[0].whereNull).toHaveBeenCalledWith('i.payer_id');
    // Guarded on the row still being that finished sequence.
    expect(seqUpdates).toHaveLength(1);
    expect(seqUpdates[0].wheres).toEqual([[{ id: 'seq-9', status: 'completed', step_index: 4 }]]);
    expect(seqUpdates[0].patch).toMatchObject({ status: 'active', next_touch_at: tenAmET('2026-08-19') });
    expect(transaction).not.toHaveBeenCalled();
  });

  test('a touch stored on the legacy Day 7 waits for its Day 10, without sending', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const row = seqRow({ step_index: 1, next_touch_at: tenAmET('2026-08-05') });
    const { seqUpdates, transaction } = setupDb({ joinedReads: [[], [row]] });
    const result = await runPending();
    expect(transaction).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(seqUpdates).toHaveLength(1);
    expect(seqUpdates[0].wheres).toEqual([
      [{ id: 'seq-1', status: 'active', step_index: 1 }],
      ['next_touch_at', tenAmET('2026-08-05')],
    ]);
    // Wed 07-29 + 10 days = Sat 08-08 at 10:00 ET (it fires the next Tuesday).
    expect(seqUpdates[0].patch.next_touch_at).toEqual(tenAmET('2026-08-08'));
  });

  // codex #5126 r1: a payment finish at the Day 90 step whose invoice a
  // dispute reopened resumes at that step.
  test('a sequence finished at the Day 90 step on a reopened invoice resumes there', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const finished = seqRow({ id: 'seq-7', status: 'completed', step_index: 5, invoice_sent_at: tenAmET('2026-05-20') });
    const { seqUpdates } = setupDb({ joinedReads: [[finished], []] });
    await runPending();
    expect(seqUpdates[0].wheres).toEqual([[{ id: 'seq-7', status: 'completed', step_index: 5 }]]);
    // Wed 05-20 + 90 days = Tue 08-18 at 10:00 ET.
    expect(seqUpdates[0].patch).toMatchObject({ status: 'active', next_touch_at: tenAmET('2026-08-18') });
  });

  // Pre-push audit P1: a touch moved to a new day that is TODAY must go out
  // in this run; the next tick would find it past its stale grace.
  test('a legacy Day 7 touch whose Day 10 is today is moved and sent in the same run', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    jest.setSystemTime(new Date('2026-08-11T14:16:00Z')); // Tue 08-11 10:16 ET
    // Sent Sat 08-01: legacy Day 7 = Sat 08-08 (first fire Tue 08-11), Day 10 = Tue 08-11.
    const row = seqRow({ step_index: 1, invoice_sent_at: tenAmET('2026-08-01'), next_touch_at: tenAmET('2026-08-08') });
    const { seqUpdates, transaction } = setupDb({ joinedReads: [[], [row]] });
    const result = await runPending();
    expect(seqUpdates[0].patch.next_touch_at).toEqual(tenAmET('2026-08-11'));
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test('a sequence that changed since the batch select is left alone', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    jest.setSystemTime(new Date('2026-08-11T14:16:00Z'));
    const row = seqRow({ step_index: 1, invoice_sent_at: tenAmET('2026-08-01'), next_touch_at: tenAmET('2026-08-08') });
    const { transaction } = setupDb({ joinedReads: [[], [row]], seqUpdateResult: 0 });
    const result = await runPending();
    expect(transaction).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  test('a touch already on its new day fires normally', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    // Day 3 is the same in both cadences.
    const row = seqRow({ step_index: 0, invoice_sent_at: tenAmET('2026-08-02'), next_touch_at: tenAmET('2026-08-05') });
    const { transaction } = setupDb({ joinedReads: [[], [row]] });
    const result = await runPending();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });
});
