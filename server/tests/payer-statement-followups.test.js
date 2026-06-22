// P4 statement-level dunning engine. The db is mocked as a stateful per-table
// store; the email lib / sendgrid / AP-recipient resolver / gate / clock are
// stubbed so we exercise the cadence + state machine without IO.

let mockGateOn = true;
let mockDow = 2; // Tuesday (in the send window)
let mockSendTemplate = async () => ({ sent: true });
let mockResolveAp = async () => ({ apEmail: 'ap@payer.com', company: 'West Bay' });
let mockDbHandler = () => { throw new Error('db handler not configured'); };

jest.mock('../models/db', () => {
  const fn = jest.fn((...args) => mockDbHandler(...args));
  fn.fn = { now: () => 'NOW' };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => mockGateOn }));
jest.mock('../utils/datetime-et', () => ({
  etParts: () => ({ dayOfWeek: mockDow }),
  etDateString: () => '2026-06-21',
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: (...a) => mockSendTemplate(...a) }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: () => true }));
jest.mock('../services/payer-statement-email', () => ({
  resolveApRecipient: (...a) => mockResolveAp(...a),
  // forceRetry path walks to a fresh key; the test stub returns the base key.
  forcedRetryKey: async (base) => base,
}));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.test' }));

const Followups = require('../services/payer-statement-followups');

// ── stateful store ──────────────────────────────────────────────
let statements;     // { [id]: row }
let followups;      // { [statement_id]: row }
let joinRows;       // rows returned by the runPending join
let nextFollowupId;
let sentEmails;

function handler(table) {
  if (table === 'payer_statements as s') {
    return {
      leftJoin() { return this; },
      whereIn() { return this; },
      whereNotNull() { return this; },
      where() { return this; },
      select() { return this; },
      then(resolve, reject) { return Promise.resolve(joinRows).then(resolve, reject); },
    };
  }
  if (table === 'payer_statements') {
    let where = null;
    return {
      where(c) { where = c; return this; },
      async first() { const r = statements[where.id]; return r ? { ...r } : undefined; },
      async update(patch) { if (statements[where.id]) Object.assign(statements[where.id], patch); return 1; },
    };
  }
  if (table === 'payer_statement_followups') {
    let where = null;
    let whereInClause = null;
    let insertRow = null;
    const findById = (id) => Object.values(followups).find((r) => r.id === id);
    return {
      where(c) { where = c; return this; },
      whereIn(col, vals) { whereInClause = { col, vals }; return this; },
      async first() {
        if (where?.statement_id != null) { const r = followups[where.statement_id]; return r ? { ...r } : undefined; }
        if (where?.id != null) { const r = findById(where.id); return r ? { ...r } : undefined; }
        return undefined;
      },
      insert(row) { insertRow = row; return this; },
      async returning() {
        const created = { id: nextFollowupId++, status: 'active', step_index: 0, touches_sent: 0, ...insertRow };
        followups[created.statement_id] = created;
        return [created];
      },
      async update(patch) {
        let row;
        if (where?.id != null) row = findById(where.id);
        else if (where?.statement_id != null) row = followups[where.statement_id];
        if (!row) return 0;
        if (whereInClause && !whereInClause.vals.includes(row.status)) return 0;
        Object.assign(row, patch);
        return 1;
      },
    };
  }
  throw new Error(`unexpected table ${table}`);
}

beforeEach(() => {
  mockGateOn = true;
  mockDow = 2;
  mockSendTemplate = async (args) => { sentEmails.push(args); return { sent: true }; };
  mockResolveAp = async () => ({ apEmail: 'ap@payer.com', company: 'West Bay' });
  statements = {};
  followups = {};
  joinRows = [];
  nextFollowupId = 1;
  sentEmails = [];
  mockDbHandler = handler;
});

describe('runPending gating', () => {
  test('no-ops when the gate is off', async () => {
    mockGateOn = false;
    const r = await Followups.runPending();
    expect(r).toMatchObject({ skippedGate: true, sent: 0 });
    expect(sentEmails).toHaveLength(0);
  });

  test('skips outside the Tue–Fri send window', async () => {
    mockDow = 1; // Monday
    statements[10] = { id: 10, payer_id: 5, status: 'sent', total: 100, due_date: '2026-06-01', token: 'tok', terms_snapshot: 'net30' };
    joinRows = [{ id: 10, due_date: '2026-06-01', f_status: null, f_step_index: null }];
    const r = await Followups.runPending();
    expect(r).toMatchObject({ sent: 0, skipped: 0 });
    expect(sentEmails).toHaveLength(0);
  });
});

describe('runPending firing', () => {
  test('fires step 0 for a past-due sent statement and advances the sequence', async () => {
    statements[10] = { id: 10, payer_id: 5, status: 'sent', total: 100, due_date: '2026-06-01', token: 'tok', terms_snapshot: 'net30' };
    joinRows = [{ id: 10, due_date: '2026-06-01', f_status: null, f_step_index: null }];

    const r = await Followups.runPending();
    expect(r.sent).toBe(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({
      templateKey: 'payer.statement.followup',
      to: 'ap@payer.com',
      idempotencyKey: 'payer_statement_followup:10:due0_reminder',
    });
    // No online-pay CTA yet (no client statement-pay page) — must not leak a pay_url.
    expect(sentEmails[0].payload.pay_url).toBeUndefined();
    // sequence advanced to step 1, still active (more steps remain)
    expect(followups[10]).toMatchObject({ step_index: 1, touches_sent: 1, status: 'active' });
  });

  test('does not fire a later step before it is due', async () => {
    // step 1 fires at due+15; due 2026-06-20 → 2026-07-05, after "today" (06-21).
    statements[10] = { id: 10, payer_id: 5, status: 'sent', total: 100, due_date: '2026-06-20', token: 'tok', terms_snapshot: 'net30' };
    followups[10] = { id: 1, statement_id: 10, payer_id: 5, status: 'active', step_index: 1, touches_sent: 1 };
    joinRows = [{ id: 10, due_date: '2026-06-20', f_status: 'active', f_step_index: 1 }];

    const r = await Followups.runPending();
    expect(r.sent).toBe(0);
    expect(sentEmails).toHaveLength(0);
  });

  test('skips a paused sequence', async () => {
    statements[10] = { id: 10, payer_id: 5, status: 'sent', total: 100, due_date: '2026-06-01', token: 'tok', terms_snapshot: 'net30' };
    followups[10] = { id: 1, statement_id: 10, status: 'paused', step_index: 0, touches_sent: 0 };
    joinRows = [{ id: 10, due_date: '2026-06-01', f_status: 'paused', f_step_index: 0 }];

    const r = await Followups.runPending();
    expect(r.sent).toBe(0);
    expect(sentEmails).toHaveLength(0);
  });
});

describe('fireStep guards', () => {
  test('does not dun a non-dunnable (paid) statement', async () => {
    statements[10] = { id: 10, payer_id: 5, status: 'paid', total: 100, due_date: '2026-06-01', token: 'tok', terms_snapshot: 'net30' };
    const r = await Followups.fireStep(10, 0);
    expect(r).toMatchObject({ fired: false, reason: 'not_dunnable' });
    expect(sentEmails).toHaveLength(0);
  });

  test('pauses the sequence on a hard delivery failure', async () => {
    statements[10] = { id: 10, payer_id: 5, status: 'sent', total: 100, due_date: '2026-06-01', token: 'tok', terms_snapshot: 'net30' };
    mockSendTemplate = async () => ({ sent: false, blocked: true, reason: 'blocked' });
    const r = await Followups.fireStep(10, 0);
    expect(r.fired).toBe(false);
    expect(followups[10]).toMatchObject({ status: 'paused', paused_reason: 'blocked' });
  });

  test('a terminal-blocked dedupe pauses (does NOT silently advance the step)', async () => {
    // A previously-suppressed key comes back deduped+blocked+not-sent. This must
    // be treated as a failure (pause), never an advance — else the reminder is
    // silently skipped. (Regression: codex P2 on #1969.)
    statements[10] = { id: 10, payer_id: 5, status: 'sent', total: 100, due_date: '2026-06-01', token: 'tok', terms_snapshot: 'net30' };
    mockSendTemplate = async () => ({ deduped: true, sent: false, blocked: true, reason: 'blocked' });
    const r = await Followups.fireStep(10, 0);
    expect(r.fired).toBe(false);
    expect(followups[10]).toMatchObject({ status: 'paused', step_index: 0 }); // did NOT advance
  });

  test('an already-delivered dedupe advances without re-counting the touch', async () => {
    statements[10] = { id: 10, payer_id: 5, status: 'sent', total: 100, due_date: '2026-06-01', token: 'tok', terms_snapshot: 'net30' };
    followups[10] = { id: 1, statement_id: 10, payer_id: 5, status: 'active', step_index: 0, touches_sent: 0 };
    mockSendTemplate = async () => ({ deduped: true, sent: true });
    const r = await Followups.fireStep(10, 0);
    expect(followups[10]).toMatchObject({ step_index: 1, touches_sent: 0 }); // advanced, not re-counted
  });

  test('an in-flight send race does NOT advance or pause (winner owns the outcome)', async () => {
    // EMAIL_SEND_IN_PROGRESS: the winning attempt is only queued, not delivered.
    // Advancing here would skip the reminder if the winner later fails. (Regression
    // for codex P2 round 3 on #1969.)
    statements[10] = { id: 10, payer_id: 5, status: 'sent', total: 100, due_date: '2026-06-01', token: 'tok', terms_snapshot: 'net30' };
    followups[10] = { id: 1, statement_id: 10, payer_id: 5, status: 'active', step_index: 0, touches_sent: 0 };
    mockSendTemplate = async () => { const e = new Error('in flight'); e.code = 'EMAIL_SEND_IN_PROGRESS'; throw e; };
    const r = await Followups.fireStep(10, 0);
    expect(r).toMatchObject({ fired: false, reason: 'in_flight' });
    expect(followups[10]).toMatchObject({ status: 'active', step_index: 0, touches_sent: 0 }); // unchanged
  });

  test('pauses when there is no AP email (never falls back to the homeowner)', async () => {
    statements[10] = { id: 10, payer_id: 5, status: 'sent', total: 100, due_date: '2026-06-01', token: 'tok', terms_snapshot: 'net30' };
    mockResolveAp = async () => ({ apEmail: null, company: null });
    const r = await Followups.fireStep(10, 0);
    expect(r.fired).toBe(false);
    expect(followups[10]).toMatchObject({ status: 'paused', paused_reason: 'no_ap_email' });
    expect(sentEmails).toHaveLength(0);
  });
});

describe('stopOnStatementSettled', () => {
  test('completes an active/paused sequence', async () => {
    followups[10] = { id: 1, statement_id: 10, status: 'active', step_index: 1, next_touch_at: 'X' };
    await Followups.stopOnStatementSettled(10);
    expect(followups[10]).toMatchObject({ status: 'completed', next_touch_at: null });
  });

  test('leaves a stopped sequence untouched', async () => {
    followups[10] = { id: 1, statement_id: 10, status: 'stopped', step_index: 0 };
    await Followups.stopOnStatementSettled(10);
    expect(followups[10].status).toBe('stopped');
  });
});

describe('sendNextStepNow (operator override)', () => {
  test('refuses on a non-dunnable statement', async () => {
    statements[10] = { id: 10, payer_id: 5, status: 'finalized', total: 100, due_date: '2026-06-01', token: 'tok', terms_snapshot: 'net30' };
    const r = await Followups.sendNextStepNow(10);
    expect(r.ok).toBe(false);
    expect(sentEmails).toHaveLength(0);
  });

  test('fires the current step immediately, even before due', async () => {
    // not yet due (due in the future) — the override still sends.
    statements[10] = { id: 10, payer_id: 5, status: 'viewed', total: 100, due_date: '2026-12-01', token: 'tok', terms_snapshot: 'net30' };
    const r = await Followups.sendNextStepNow(10);
    expect(r.ok).toBe(true);
    expect(sentEmails).toHaveLength(1);
    expect(followups[10]).toMatchObject({ step_index: 1, touches_sent: 1 });
  });
});
