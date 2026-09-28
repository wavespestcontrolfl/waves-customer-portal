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
const { runPending, hasActiveSequence, followupSteps } = require('../services/invoice-followups');

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
      for (const method of ['join', 'whereNotIn', 'whereNull', 'select']) q[method] = jest.fn(() => q);
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

describe('a finished sequence still owns its invoice', () => {
  test('gate off: only live sequences count', async () => {
    let whereInArgs;
    db.mockImplementation(() => {
      const q = { where: jest.fn(() => q), whereIn: jest.fn((...args) => { whereInArgs = args; return q; }), first: jest.fn(async () => undefined) };
      return q;
    });
    await hasActiveSequence('inv-1');
    expect(whereInArgs).toEqual(['status', ['active', 'paused', 'autopay_hold']]);
  });

  test('gate on: a completed sequence counts too', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    let whereInArgs;
    db.mockImplementation(() => {
      const q = { where: jest.fn(() => q), whereIn: jest.fn((...args) => { whereInArgs = args; return q; }), first: jest.fn(async () => ({ id: 'seq-1' })) };
      return q;
    });
    await expect(hasActiveSequence('inv-1')).resolves.toBe(true);
    expect(whereInArgs).toEqual(['status', ['active', 'paused', 'autopay_hold', 'completed']]);
  });
});

describe('runPending under the Day 90 ladder', () => {
  test('gate off: no revival read, and a Day 7 touch fires as before', async () => {
    const row = seqRow({ step_index: 1, next_touch_at: tenAmET('2026-08-05') });
    const { joined, transaction } = setupDb({ joinedReads: [[row]] });
    const result = await runPending();
    expect(joined).toHaveLength(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, skipped: 0 });
  });

  test('a sequence that finished at Day 30 on an open invoice resumes at its Day 60 step', async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const finished = seqRow({ id: 'seq-9', status: 'completed', step_index: 4, invoice_sent_at: tenAmET('2026-06-20') });
    const { joined, seqUpdates, transaction } = setupDb({ joinedReads: [[finished], []] });
    await runPending();
    // The revival read selects only natural Day 30 finishes on open invoices.
    const revivalWheres = joined[0].wheres;
    expect(revivalWheres).toEqual(expect.arrayContaining([['s.status', 'completed'], ['s.step_index', 4]]));
    expect(joined[0].whereNotIn).toHaveBeenCalledWith('i.status', expect.arrayContaining(['paid', 'void']));
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
