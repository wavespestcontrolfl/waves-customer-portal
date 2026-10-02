/**
 * Scheduler fire-time amount/Zelle recheck (Codex round-11 P1, PR #5331):
 * (b) the SPECIFIC reason is surfaced, (c) no reads for a non-payment reply.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-amount-recheck', () => ({
  ...jest.requireActual('../services/sms-amount-recheck'),
  outgoingAmountsStale: jest.fn(),
}));
const db = require('../models/db');
const recheck = require('../services/sms-amount-recheck');
const { recheckScheduledSmsAmounts, amountsStaleNote } = require('../services/scheduler');

const claimMeta = { agent_decision_id: 'd1', human_authored: true };
const dbReturning = (row) => {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => row) };
  db.mockImplementation(() => q);
  return q;
};
let priorGate;
// real-answers on: the status-vocabulary pre-screen is a v12 feature (gate off it is main's - see the P2-4 test below)
beforeEach(() => { jest.clearAllMocks(); db.mockReset(); priorGate = process.env.GATE_SMS_REAL_ANSWERS; process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
afterEach(() => { if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = priorGate; });

describe('recheckScheduledSmsAmounts', () => {
  test('(c) a human reply with no figure, Zelle offer or payment claim does no reads at all', async () => {
    await expect(recheckScheduledSmsAmounts({ msg: { id: 'm1', customer_id: 'c1', message_body: 'Sounds good, see you Tuesday!' }, claimMeta }))
      .resolves.toEqual({ stale: false, reason: null });
    expect(db).not.toHaveBeenCalled();
    expect(recheck.outgoingAmountsStale).not.toHaveBeenCalled();
  });

  // independent review P2-4: with the gate off the pre-screen is main's, so a status-vocabulary body costs no agent_decisions read and a
  // read failure cannot block the row; amounts and Zelle claims are still rechecked
  test('gate off: a status-only body with NO linked decision does no reads at all (== main); a dollar figure is still rechecked', async () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    for (const body of ["You're paid up!", "Your payment isn't showing yet.", 'Your invoice is overdue.']) {
      await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: body }, claimMeta: { human_authored: true } })).resolves.toEqual({ stale: false, reason: null });
    }
    expect(db).not.toHaveBeenCalled();
    expect(recheck.outgoingAmountsStale).not.toHaveBeenCalled();
    dbReturning({ prompt_version: 'house_voice_v11', input_snapshot: null });
    recheck.outgoingAmountsStale.mockResolvedValue({ stale: false });
    await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: 'Your balance is $95.' }, claimMeta });
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledTimes(1);
  });

  // Codex round-45 P1: the pre-screen cannot see a v12 decision queued BEFORE GATE_SMS_REAL_ANSWERS was rolled back. A decision-linked row
  // whose body carries status vocabulary reads the decision (one indexed read), whatever the live gate says.
  test('ROLLBACK: gate off, v12 decision, status-only body => the decision is read and the strict recheck runs', async () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    const q = dbReturning({ prompt_version: 'house_voice_v12_real_answers5_cflvp', input_snapshot: JSON.stringify({ sms: { body: 'Do I owe anything?' }, payment_status_snapshot: { customer_id: 'c1', sentences: ['Your account has no balance due.'] } }) });
    recheck.outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'payment_status_changed' });
    const out = await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: 'Your account has no balance due.' }, claimMeta: { agent_decision_id: 'd1', human_authored: false } });
    expect(out).toEqual({ stale: true, reason: 'payment_status_changed' });
    expect(q.first).toHaveBeenCalledTimes(1); // ONE read, reused by the recheck
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ promptVersion: 'house_voice_v12_real_answers5_cflvp', inboundMessage: 'Do I owe anything?' }));
  });
  test('gate off, v11 (or version-less) decision, status-only body => one decision read, then no recheck (main\'s verdict)', async () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    for (const prompt_version of ['house_voice_v11', null]) {
      recheck.outgoingAmountsStale.mockClear();
      const q = dbReturning({ prompt_version, input_snapshot: null });
      await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: "You're paid up!" }, claimMeta })).resolves.toEqual({ stale: false, reason: null });
      expect(q.first).toHaveBeenCalledTimes(1);
      expect(recheck.outgoingAmountsStale).not.toHaveBeenCalled();
    }
  });
  test('the decision read FAILS => the row is blocked (fail closed), gate on or off', async () => {
    for (const gate of [undefined, 'true']) {
      if (gate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = gate;
      const q = { where: jest.fn(() => q), first: jest.fn(async () => { throw new Error('pg down'); }) };
      db.mockImplementation(() => q);
      recheck.outgoingAmountsStale.mockClear();
      await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: "You're paid up!" }, claimMeta })).resolves.toEqual({ stale: true, reason: 'amount_recheck_failed' });
      expect(recheck.outgoingAmountsStale).not.toHaveBeenCalled();
    }
  });
  test('a decision-linked row with NO status vocabulary keeps main\'s no-read path', async () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: 'Sounds good, see you Tuesday!' }, claimMeta })).resolves.toEqual({ stale: false, reason: null });
    expect(db).not.toHaveBeenCalled();
  });

  // Owner ruling 2026-10-01: staff edits. human_authored AND different from the decision's stored AI draft => the contract does not judge it.
  describe('staff edits (owner ruling 2026-10-01)', () => {
    const AI = 'Your account has no balance due.';
    const decisionRow = (over = {}) => ({ prompt_version: 'house_voice_v12_real_answers5_cflvp', suggested_message: AI, input_snapshot: JSON.stringify({ sms: { body: 'Did I pay?' }, payment_status_snapshot: { customer_id: 'c1', sentences: [AI] } }), ...over });
    const fire = (body, meta) => recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: body }, claimMeta: { agent_decision_id: 'd1', ...meta } });
    test('an edited body with free-text status is never blocked by the contract, gate on or off (the recheck is told it is a staff edit)', async () => {
      for (const gate of ['true', undefined]) {
        if (gate) process.env.GATE_SMS_REAL_ANSWERS = gate; else delete process.env.GATE_SMS_REAL_ANSWERS;
        dbReturning(decisionRow());
        recheck.outgoingAmountsStale.mockReset().mockResolvedValue({ stale: false });
        await expect(fire("Yes, we got your payment - you're all set!", { human_authored: true })).resolves.toMatchObject({ stale: false, reason: null });
        // gate on the pre-screen selects the body (status vocabulary) and the recheck stands the contract down; gate off nothing is selected
        if (gate) expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ humanEditedBody: true }));
        else expect(recheck.outgoingAmountsStale).not.toHaveBeenCalled();
      }
    });
    test('an edited body that still carries a figure or Zelle IS rechecked, flagged as a staff edit (amount/Zelle rules unchanged)', async () => {
      dbReturning(decisionRow());
      recheck.outgoingAmountsStale.mockResolvedValue({ stale: false });
      await fire('Yes we got it. You owe $95.', { human_authored: true });
      expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ humanEditedBody: true, trustOwedAmounts: true }));
    });
    test('human_authored but IDENTICAL to the stored AI draft, or no stored draft: STRICT', async () => {
      for (const row of [decisionRow(), decisionRow({ suggested_message: null })]) {
        dbReturning(row);
        recheck.outgoingAmountsStale.mockClear().mockResolvedValue({ stale: true, reason: 'payment_status_unauthorized' });
        const out = await fire(row.suggested_message ? AI : "Yes, we got your payment - you're all set!", { human_authored: true });
        expect(out).toEqual({ stale: true, reason: 'payment_status_unauthorized' });
        expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ humanEditedBody: false }));
      }
    });
    test('NOT human_authored (an unedited AI body): strict even when the text differs from the stored draft', async () => {
      dbReturning(decisionRow());
      recheck.outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'payment_status_unauthorized' });
      await expect(fire("Yes, we got your payment - you're all set!", { human_authored: false })).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
      expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ humanEditedBody: false }));
    });
  });

  test('(a) a human-edited Zelle offer IS rechecked, with trustOwedAmounts, and the specific reason comes back', async () => {
    dbReturning({ prompt_version: 'house_voice_v11', input_snapshot: JSON.stringify({ zelle_invoice_id: 'inv-9', sms: { body: 'How do I pay?' } }) });
    recheck.outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'zelle_invoice_unresolved' });
    const out = await recheckScheduledSmsAmounts({ msg: { id: 'm1', customer_id: 'c1', message_body: 'You can Zelle us at pay@example.com.' }, claimMeta });
    expect(out).toEqual({ stale: true, reason: 'zelle_invoice_unresolved' });
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'c1', zelleInvoiceId: 'inv-9', inboundMessage: 'How do I pay?', trustOwedAmounts: true,
    }));
  });

  test('a payment-status claim and a dollar figure are rechecked too; a clean verdict has no reason', async () => {
    dbReturning({ prompt_version: 'house_voice_v12_real_answers', input_snapshot: null });
    recheck.outgoingAmountsStale.mockResolvedValue({ stale: false });
    for (const body of ["You're paid up!", 'Your balance is $95.', "Your payment isn't showing yet."]) {
      await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: body }, claimMeta })).resolves.toMatchObject({ stale: false, reason: null, boundary: { customerId: 'c1', zelle: null } });
    }
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledTimes(3);
  });

  // PR #5331: the scheduler hands the recheck the decision's prompt version (which selects the strict rule), the customer's
  // inbound, and the payment-status sentences the draft copied; there is no separate "strict for every version" switch.
  test('the scheduler passes the decision\'s prompt version, inbound and payment_status_snapshot to the recheck', async () => {
    const snap = { customer_id: 'c1', sentences: ['Your account has no balance due.'] };
    dbReturning({ prompt_version: 'house_voice_v12_real_answers5_cflvp', input_snapshot: JSON.stringify({ sms: { body: 'Do I owe anything?' }, payment_status_snapshot: snap }) });
    recheck.outgoingAmountsStale.mockResolvedValue({ stale: false });
    await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: 'Your account has no balance due.' }, claimMeta: { agent_decision_id: 'd1', human_authored: false } });
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({
      promptVersion: 'house_voice_v12_real_answers5_cflvp', trustOwedAmounts: false, inboundMessage: 'Do I owe anything?', paymentStatusSnapshot: snap,
    }));
    expect(recheck.outgoingAmountsStale.mock.calls[0][0]).not.toHaveProperty('strictStatusClaims');
    recheck.outgoingAmountsStale.mockClear();
    await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: 'Your balance is $95.' }, claimMeta }); // human edit
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ trustOwedAmounts: true }));
  });

  test('a row with NO customer_id falls back to the linked decision\'s customer', async () => {
    dbReturning({ prompt_version: null, input_snapshot: null, customer_id: 'c-from-decision' });
    recheck.outgoingAmountsStale.mockResolvedValue({ stale: false });
    await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: 'You can Zelle us at pay@example.com.' }, claimMeta });
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c-from-decision' }));
  });

  test('no customer anywhere: a Zelle offer fails closed with a specific reason; a pre-v12 status/figure body is main\'s (untouched); a non-payment reply is untouched', async () => {
    const { outgoingAmountsStale: real } = jest.requireActual('../services/sms-amount-recheck');
    dbReturning({ prompt_version: null, input_snapshot: null, customer_id: null });
    recheck.outgoingAmountsStale.mockImplementation(real);
    delete process.env.ZELLE_RECIPIENT;
    delete process.env.GATE_SMS_REAL_ANSWERS;
    const zelle = await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: 'You can Zelle us at pay@example.com.' }, claimMeta });
    expect(zelle.stale).toBe(true);
    expect(zelle.reason).toMatch(/^zelle_/);
    // gate off + no prompt version: main's behavior - a human-edited status / figure is not rechecked
    await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: "You're paid up!" }, claimMeta })).resolves.toEqual({ stale: false, reason: null });
    await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: 'Your balance is $95.' }, claimMeta })).resolves.toEqual({ stale: false, reason: null }); // no customer: no boundary (it could only refuse)
    db.mockClear();
    const plain = await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: 'See you Tuesday!' }, claimMeta });
    expect(plain).toEqual({ stale: false, reason: null });
    expect(db).not.toHaveBeenCalled();
  });

  test('real answers on (live gate, no prompt version): an unsanctioned payment status is held with its specific reason - no customer needed', async () => {
    const { outgoingAmountsStale: real } = jest.requireActual('../services/sms-amount-recheck');
    dbReturning({ prompt_version: null, input_snapshot: null, customer_id: null });
    recheck.outgoingAmountsStale.mockImplementation(real);
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    try {
      const out = await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: "You're paid up!" }, claimMeta });
      expect(out).toEqual({ stale: true, reason: 'payment_status_unauthorized' });
      expect(amountsStaleNote(out.reason)).toMatch(/word-for-word copy/);
    } finally { delete process.env.GATE_SMS_REAL_ANSWERS; }
  });

  test('a read error fails closed with a specific reason', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: 'You can Zelle us.' }, claimMeta }))
      .resolves.toEqual({ stale: true, reason: 'amount_recheck_failed' });
  });

  test('a stale verdict with no reason still names one', async () => {
    dbReturning({ prompt_version: null, input_snapshot: null });
    recheck.outgoingAmountsStale.mockResolvedValue({ stale: true });
    await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: 'Your balance is $95.' }, claimMeta }))
      .resolves.toEqual({ stale: true, reason: 'amount_recheck_failed' });
  });
});

describe('amountsStaleNote (reviewer-facing)', () => {
  test('names the SPECIFIC reason, not a generic price block', () => {
    expect(amountsStaleNote('zelle_invoice_unresolved')).toMatch(/no longer resolves.*zelle_invoice_unresolved/);
    expect(amountsStaleNote('zelle_recipient_stale')).toMatch(/Zelle recipient.*zelle_recipient_stale/);
    expect(amountsStaleNote('credit_unverifiable')).toMatch(/account-credit.*credit_unverifiable/);
    expect(amountsStaleNote('payer_owned')).toMatch(/third-party payer/);
    expect(amountsStaleNote('amount_no_longer_authorized')).toMatch(/no longer matches the account/);
    expect(amountsStaleNote('something_new')).toMatch(/something_new/);
    expect(amountsStaleNote('zelle_invoice_unresolved')).not.toMatch(/house rule: no prices/);
  });
});

// Codex round-50 P1: scheduled replies get the same provider-boundary billing check as the immediate and auto-send paths
describe('scheduled replies: billing fingerprint before the recheck, checked again at the provider boundary', () => {
  test('the fingerprint is read BEFORE the recheck and rides back with the live Zelle facts the recheck stood on', async () => {
    const order = [];
    const ZELLE_FACTS = { state: 'offer', invoiceId: 'inv-9', invoiceNumber: 'WPC-2026-0009', recipient: 'pay@example.com' };
    const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ prompt_version: 'house_voice_v11', input_snapshot: null, customer_id: 'c1', suggested_message: 'x' })) };
    db.mockReset().mockImplementation(() => q);
    db.raw = jest.fn(async () => { order.push('fingerprint'); return { rows: [{ fingerprint: 'fp-1' }] }; });
    recheck.outgoingAmountsStale.mockReset().mockImplementation(async () => { order.push('recheck'); return { stale: false, zelle: ZELLE_FACTS }; });
    const verdict = await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: 'You can Zelle us at pay@example.com.' }, claimMeta });
    expect(order).toEqual(['fingerprint', 'recheck']);
    expect(verdict).toEqual({ stale: false, reason: null, boundary: { customerId: 'c1', fingerprint: `fp-1@${require('../utils/datetime-et').etDateString()}`, zelle: ZELLE_FACTS } });
    delete db.raw;
  });
  test('the replay composes the billing boundary check after the ETA one', () => {
    const src = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
    expect(src).toContain('billingBoundary = amountsVerdict.boundary || null;');
    expect(src).toContain("require('./billing-fingerprint').billingUnchangedProviderPreSendCheck(billingBoundary)");
  });
});

// Local Codex review pass 2: a customerless staff edit with only exempt status wording takes no billing boundary (it could only refuse)
test('a staff-edited status body with no customer: clean, and no boundary', async () => {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ prompt_version: 'house_voice_v12_real_answers5_cflvp', input_snapshot: null, customer_id: null, suggested_message: 'Thanks for reaching out!' })) };
  db.mockReset().mockImplementation(() => q);
  recheck.outgoingAmountsStale.mockReset().mockResolvedValue({ stale: false });
  const prev = process.env.GATE_SMS_REAL_ANSWERS;
  process.env.GATE_SMS_REAL_ANSWERS = 'true';
  try {
    await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: 'Yes, we got your payment, thanks!' }, claimMeta: { agent_decision_id: 'd1', human_authored: true } }))
      .resolves.toEqual({ stale: false, reason: null });
  } finally { if (prev === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prev; }
});

// Codex round-65 P2: a billing READ failure at fire time defers a decision-linked reply to a retryable provider-boundary refusal
describe('scheduled billing recheck outages ride the retry rail', () => {
  test('the scheduler un-stales an infrastructure reason for a decision-linked row and arms the boundary with no fingerprint', () => {
    const src = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
    const at = src.indexOf('const amountsVerdict = await recheckScheduledSmsAmounts({ msg, claimMeta });');
    const defer = src.indexOf("blockReasonIsBillingInfrastructure(`amount no longer authorized (${amountsReason})`)", at);
    expect(at).toBeGreaterThan(-1);
    expect(defer).toBeGreaterThan(at);
    expect(src.slice(defer, defer + 600)).toContain('billingBoundary = { customerId: msg.customer_id || null, fingerprint: null, zelle: null };');
    expect(src.slice(at, defer)).toContain('claimMeta.agent_decision_id');
  });
  test('a boundary armed with no fingerprint always refuses, retryably', async () => {
    const { billingUnchangedProviderPreSendCheck } = require('../services/billing-fingerprint');
    await expect(billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: null, zelle: null })({ dbi: { raw: async () => ({ rows: [{ fingerprint: 'x' }] }) } }))
      .resolves.toMatchObject({ ok: false, code: 'BILLING_CHANGED_AT_BOUNDARY', retryable: true });
  });
});

