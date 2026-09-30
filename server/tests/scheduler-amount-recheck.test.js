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
beforeEach(() => { jest.clearAllMocks(); db.mockReset(); });

describe('recheckScheduledSmsAmounts', () => {
  test('(c) a human reply with no figure, Zelle offer or payment claim does no reads at all', async () => {
    await expect(recheckScheduledSmsAmounts({ msg: { id: 'm1', customer_id: 'c1', message_body: 'Sounds good, see you Tuesday!' }, claimMeta }))
      .resolves.toEqual({ stale: false, reason: null });
    expect(db).not.toHaveBeenCalled();
    expect(recheck.outgoingAmountsStale).not.toHaveBeenCalled();
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
      await expect(recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: body }, claimMeta })).resolves.toEqual({ stale: false, reason: null });
    }
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledTimes(3);
  });

  // Codex round-30 P1: every scheduled body the gate selects gets the clause-aware status / receipt check, any prompt version.
  test('the scheduler always asks for the strict status / receipt check, for pre-v12 non-human decisions too', async () => {
    dbReturning({ prompt_version: 'house_voice_v11', input_snapshot: null });
    recheck.outgoingAmountsStale.mockResolvedValue({ stale: false });
    await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: 'Your payment failed.' }, claimMeta: { agent_decision_id: 'd1', human_authored: false } });
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ promptVersion: 'house_voice_v11', trustOwedAmounts: false, strictStatusClaims: true }));
    recheck.outgoingAmountsStale.mockClear();
    await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: 'c1', message_body: 'Your balance is $95.' }, claimMeta }); // human edit
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ trustOwedAmounts: true, strictStatusClaims: true }));
  });

  test('a row with NO customer_id falls back to the linked decision\'s customer', async () => {
    dbReturning({ prompt_version: null, input_snapshot: null, customer_id: 'c-from-decision' });
    recheck.outgoingAmountsStale.mockResolvedValue({ stale: false });
    await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: 'You can Zelle us at pay@example.com.' }, claimMeta });
    expect(recheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c-from-decision' }));
  });

  test('no customer anywhere: a Zelle offer / payment claim fails closed with a specific reason; a non-payment reply is untouched', async () => {
    const { outgoingAmountsStale: real } = jest.requireActual('../services/sms-amount-recheck');
    dbReturning({ prompt_version: null, input_snapshot: null, customer_id: null });
    recheck.outgoingAmountsStale.mockImplementation(real);
    delete process.env.ZELLE_RECIPIENT;
    const zelle = await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: 'You can Zelle us at pay@example.com.' }, claimMeta });
    expect(zelle.stale).toBe(true);
    expect(zelle.reason).toMatch(/^zelle_/);
    const status = await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: "You're paid up!" }, claimMeta: { ...claimMeta, agent_decision_id: 'd1' } });
    // Codex round-13: a HUMAN-edited status claim is now rechecked even pre-v12 => no customer fails closed
    expect(status).toEqual({ stale: true, reason: 'amount_recheck_no_customer' });
    const agentDrafted = await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: "You're paid up!" }, claimMeta: { agent_decision_id: 'd1', human_authored: false } });
    // round 30: the clause-aware status / receipt check now runs for EVERY selected body, pre-v12 agent drafts included
    expect(agentDrafted).toEqual({ stale: true, reason: 'amount_recheck_no_customer' });
    const amount = await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: 'Your balance is $95.' }, claimMeta });
    expect(amount).toEqual({ stale: true, reason: 'amount_recheck_no_customer' });
    db.mockClear();
    const plain = await recheckScheduledSmsAmounts({ msg: { id: 'm', customer_id: null, message_body: 'See you Tuesday!' }, claimMeta });
    expect(plain).toEqual({ stale: false, reason: null });
    expect(db).not.toHaveBeenCalled();
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
