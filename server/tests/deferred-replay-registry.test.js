// The deferred-replay registry is the single home for replay-time
// staleness rechecks, delivery-time finalization, and terminal-block
// obligation handoff for quiet-hours-deferred SMS. These tests pin the
// contract the executor depends on: unknown entry points are inert (null),
// read failures fail CLOSED as retryable, reply-ended sequences suppress
// while naturally-completed ones do not, and the durable-finalize set is
// derived from the registry itself.

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-followups', () => ({
  isTerminalInvoice: jest.fn((inv) => ['paid', 'prepaid', 'void'].includes(String(inv?.status || ''))),
}));
jest.mock('../services/dispatch-completion-deferred', () => ({
  finalizeDeferredCompletionSend: jest.fn(async () => ({ ok: true })),
  finalizeDeferredDeclineNotice: jest.fn(async () => ({ ok: true })),
  terminalDeferredCompletionSend: jest.fn(async () => {}),
  terminalDeferredDeclineNotice: jest.fn(async () => {}),
}));
jest.mock('../services/appointment-card-request', () => ({
  sendDeferredInvitationEmailLeg: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/review-request', () => ({
  markInlineRetryable: jest.fn(async () => {}),
  markInlineDelivered: jest.fn(async () => {}),
}));
const mockVmClaims = {
  stampStatus: jest.fn(async () => true),
  stampPhoneClaim: jest.fn(async () => true),
  clearLeadClaim: jest.fn(async () => true),
  releasePhoneClaim: jest.fn(async () => true),
};
jest.mock('../services/voicemail-lead-sms', () => ({ _deferredClaims: mockVmClaims }));
jest.mock('../services/account-membership-email', () => ({
  sendCancellationReceived: jest.fn(async () => ({ ok: true })),
}));

const db = require('../models/db');
const {
  recheckDeferredReplay,
  finalizeDeferredReplay,
  onTerminalDeferredReplay,
  requiresDurableFinalize,
  DURABLE_FINALIZE_ENTRY_POINTS,
} = require('../services/messaging/deferred-replay-registry');

function firstChain(row) {
  const q = {};
  for (const m of ['where', 'whereNull', 'whereIn']) q[m] = jest.fn(() => q);
  q.first = jest.fn(async () => row);
  return q;
}

function throwChain() {
  const q = {};
  for (const m of ['where', 'whereNull', 'whereIn']) q[m] = jest.fn(() => q);
  q.first = jest.fn(async () => { throw new Error('db down'); });
  return q;
}

describe('deferred-replay registry', () => {
  beforeEach(() => jest.clearAllMocks());

  test('unregistered entry points are inert', async () => {
    expect(await recheckDeferredReplay('some_future_unregistered_deferred', {})).toBeNull();
    expect(await finalizeDeferredReplay('some_future_unregistered_deferred', {}, {})).toBeNull();
    // No hook → ok:true (r16 durability contract: callers read .ok to
    // decide whether the terminal_pending stamp clears).
    await expect(onTerminalDeferredReplay('some_future_unregistered_deferred', {})).resolves.toEqual({ ok: true });
    expect(requiresDurableFinalize('some_future_unregistered_deferred')).toBe(false);
  });

  test('durable set is registry-derived and covers the finalizing entry points', () => {
    expect(DURABLE_FINALIZE_ENTRY_POINTS).toEqual(expect.arrayContaining([
      'dispatch_completion_deferred',
      'invoice_send_deferred',
      'lead_response_auto_reply_deferred',
    ]));
    for (const ep of DURABLE_FINALIZE_ENTRY_POINTS) {
      expect(requiresDurableFinalize(ep)).toBe(true);
    }
  });

  test('cancellation-save: reply-ended sequences suppress, natural completion does not', async () => {
    db.mockReturnValueOnce(firstChain({ status: 'converted' }));
    const ended = await recheckDeferredReplay('cancellation_save_deferred', { sequence_id: 'seq-1' });
    expect(ended.eligible).toBe(false);
    expect(ended.reason).toBe('sequence-converted');

    db.mockReturnValueOnce(firstChain({ status: 'completed' }));
    const completed = await recheckDeferredReplay('cancellation_save_deferred', { sequence_id: 'seq-1' });
    expect(completed.eligible).toBe(true);
  });

  test('lead menu: advanced intake suppresses, awaiting_service passes', async () => {
    db.mockReturnValueOnce(firstChain({ lead_intake_status: 'awaiting_address' }));
    const advanced = await recheckDeferredReplay('lead_webhook_auto_reply_deferred', { customer_id: 'c1' });
    expect(advanced.eligible).toBe(false);

    db.mockReturnValueOnce(firstChain({ lead_intake_status: 'awaiting_service' }));
    const waiting = await recheckDeferredReplay('lead_webhook_auto_reply_deferred', { customer_id: 'c1' });
    expect(waiting.eligible).toBe(true);
  });

  test('prep: cancelled or past visits suppress', async () => {
    db.mockReturnValueOnce(firstChain({ status: 'cancelled', scheduled_date: '2099-01-01' }));
    const cancelled = await recheckDeferredReplay('appointment_tagger_prep_deferred', { scheduled_service_id: 's1' });
    expect(cancelled.eligible).toBe(false);

    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2001-01-01' }));
    const past = await recheckDeferredReplay('appointment_tagger_prep_deferred', { scheduled_service_id: 's1' });
    expect(past.eligible).toBe(false);
    expect(past.reason).toBe('visit-past');
  });

  test('document reminder: signed/terminal contracts suppress', async () => {
    db.mockReturnValueOnce(firstChain({ status: 'signed', signed_at: null }));
    const signed = await recheckDeferredReplay('document_request_reminder_deferred', { contract_id: 'ct1' });
    expect(signed.eligible).toBe(false);

    db.mockReturnValueOnce(firstChain({ status: 'sent', signed_at: null }));
    const open = await recheckDeferredReplay('document_request_reminder_deferred', { contract_id: 'ct1' });
    expect(open.eligible).toBe(true);
  });

  test('read failures fail CLOSED as retryable, never eligible', async () => {
    db.mockReturnValueOnce(throwChain());
    const res = await recheckDeferredReplay('cancellation_save_deferred', { sequence_id: 'seq-1' });
    expect(res.eligible).toBe(false);
    expect(res.retryable).toBe(true);
  });

  test('decline notice (r14): terminal or payer-billed invoices suppress, open ones pass', async () => {
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'paid', payer_id: null }));
    const paid = await recheckDeferredReplay('autopay_completion_decline_deferred', { invoice_id: 'inv-1' });
    expect(paid.eligible).toBe(false);
    expect(paid.reason).toBe('invoice-terminal:paid');

    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: 'payer-9' }));
    const payerBilled = await recheckDeferredReplay('autopay_completion_decline_deferred', { invoice_id: 'inv-1' });
    expect(payerBilled.eligible).toBe(false);
    expect(payerBilled.reason).toBe('payer-billed');

    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null }));
    const open = await recheckDeferredReplay('autopay_completion_decline_deferred', { invoice_id: 'inv-1' });
    expect(open.eligible).toBe(true);
  });

  test('decline notice (r14): rides the durable finalize rail and delegates its hooks', async () => {
    expect(requiresDurableFinalize('autopay_completion_decline_deferred')).toBe(true);
    const { finalizeDeferredDeclineNotice, terminalDeferredDeclineNotice } = require('../services/dispatch-completion-deferred');
    const meta = { invoice_id: 'inv-1', service_record_id: 'rec-1', pay_url: 'https://p' };
    await finalizeDeferredReplay('autopay_completion_decline_deferred', meta, {});
    expect(finalizeDeferredDeclineNotice).toHaveBeenCalledWith(meta);
    await onTerminalDeferredReplay('autopay_completion_decline_deferred', meta);
    expect(terminalDeferredDeclineNotice).toHaveBeenCalledWith(meta);
  });

  test('setup-failure notice (r14): suppresses once the customer holds a VERIFIED bank method', async () => {
    db.mockReturnValueOnce(firstChain({ id: 'pm-1' }));
    const fixedOvernight = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'bank_verification_failed',
      waves_customer_id: 'cust-1',
    });
    expect(fixedOvernight.eligible).toBe(false);
    expect(fixedOvernight.reason).toBe('bank-method-verified');

    db.mockReturnValueOnce(firstChain(null));
    const stillBroken = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'bank_verification_failed',
      waves_customer_id: 'cust-1',
    });
    expect(stillBroken.eligible).toBe(true);

    // Legacy rows queued before the linkage existed keep today's behavior.
    const legacy = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'bank_verification_failed',
    });
    expect(legacy.eligible).toBe(true);
  });

  test('ach processing ack (r14 audit): eligible while THIS PI still processes, stale otherwise', async () => {
    // 'processing' sits in the shared terminal list, so the generic
    // collectibility recheck would suppress every replay of the one
    // notice whose live state IS processing.
    db.mockReturnValueOnce(firstChain({ status: 'processing', stripe_payment_intent_id: 'pi_1' }));
    const live = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'ach_payment_processing', invoice_id: 'inv-1', stripe_payment_intent_id: 'pi_1',
    });
    expect(live.eligible).toBe(true);

    db.mockReturnValueOnce(firstChain({ status: 'paid', stripe_payment_intent_id: 'pi_1' }));
    const cleared = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'ach_payment_processing', invoice_id: 'inv-1', stripe_payment_intent_id: 'pi_1',
    });
    expect(cleared.eligible).toBe(false);
    expect(cleared.reason).toBe('invoice-paid');

    db.mockReturnValueOnce(firstChain({ status: 'processing', stripe_payment_intent_id: 'pi_2' }));
    const superseded = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'ach_payment_processing', invoice_id: 'inv-1', stripe_payment_intent_id: 'pi_1',
    });
    expect(superseded.eligible).toBe(false);
    expect(superseded.reason).toBe('pi-superseded');
  });

  test('card request (r14): finalize delivers the email twin via the extracted leg', async () => {
    const { sendDeferredInvitationEmailLeg } = require('../services/appointment-card-request');
    const meta = { scheduled_service_id: 'ss-1', card_secure_url: 'https://s', card_template_key: 'secure_appointment_card' };
    const res = await finalizeDeferredReplay('appointment_card_request_deferred', meta, {});
    expect(sendDeferredInvitationEmailLeg).toHaveBeenCalledWith(meta);
    expect(res.ok).toBe(true);
    // Deliberately NOT durable: an email miss must never fake an
    // undelivered SMS back onto a retry rail.
    expect(requiresDurableFinalize('appointment_card_request_deferred')).toBe(false);
  });

  test('completion terminal (r15): resets the stuck deferred status FIRST, then arms the review fallback', async () => {
    const { terminalDeferredCompletionSend } = require('../services/dispatch-completion-deferred');
    const { markInlineRetryable } = require('../services/review-request');

    // No bundled review: the status reset must still run before the early return.
    await onTerminalDeferredReplay('dispatch_completion_deferred', { service_record_id: 'rec-1' });
    expect(terminalDeferredCompletionSend).toHaveBeenCalledWith({ service_record_id: 'rec-1' });
    expect(markInlineRetryable).not.toHaveBeenCalled();

    // Bundled review: reset runs first, then the standalone fallback arms.
    jest.clearAllMocks();
    const meta = { service_record_id: 'rec-1', bundled_review_request_id: 'rev-1' };
    await onTerminalDeferredReplay('dispatch_completion_deferred', meta);
    expect(terminalDeferredCompletionSend).toHaveBeenCalledWith(meta);
    expect(markInlineRetryable).toHaveBeenCalledWith('rev-1', expect.any(Date));
    expect(terminalDeferredCompletionSend.mock.invocationCallOrder[0])
      .toBeLessThan(markInlineRetryable.mock.invocationCallOrder[0]);
  });

  test('voicemail (r15): claim settlement rides the durable rail and propagates failed stamps', async () => {
    expect(requiresDurableFinalize('voicemail_lead_sms_deferred')).toBe(true);
    expect(DURABLE_FINALIZE_ENTRY_POINTS).toContain('voicemail_lead_sms_deferred');

    const meta = { lead_id: 'lead-1', voicemail_phone: '+15551234567' };
    const ok = await finalizeDeferredReplay('voicemail_lead_sms_deferred', meta, {});
    expect(ok.ok).toBe(true);
    expect(mockVmClaims.stampStatus).toHaveBeenCalledWith('lead-1', 'sent');
    expect(mockVmClaims.stampPhoneClaim).toHaveBeenCalledWith('+15551234567', 'sent');

    // A swallowed DB failure inside either helper must surface as ok:false
    // so the finalize_only retry rail re-runs the settlement.
    mockVmClaims.stampStatus.mockResolvedValueOnce(false);
    const failed = await finalizeDeferredReplay('voicemail_lead_sms_deferred', meta, {});
    expect(failed.ok).toBe(false);
  });

  test('cancellation confirmation (r15): terminal replay runs the cancellation-safe email fallback', async () => {
    const { sendCancellationReceived } = require('../services/account-membership-email');
    const request = { id: 'req-1', customer_id: 'cust-1', subject: 'Cancel my service', category: 'cancellation', created_at: '2026-08-07' };

    db.mockReturnValueOnce(firstChain(request));
    await onTerminalDeferredReplay('customer_service_request_deferred', {
      is_cancellation: true, service_request_id: 'req-1', waves_customer_id: 'cust-1',
    });
    expect(sendCancellationReceived).toHaveBeenCalledWith({ customerId: 'cust-1', request });

    // Ordinary request confirmations already emailed inline — no fallback.
    jest.clearAllMocks();
    await onTerminalDeferredReplay('customer_service_request_deferred', {
      is_cancellation: false, service_request_id: 'req-1', waves_customer_id: 'cust-1',
    });
    expect(sendCancellationReceived).not.toHaveBeenCalled();

    // Missing request row: skip loudly, never email an unlinked customer.
    db.mockReturnValueOnce(firstChain(null));
    await onTerminalDeferredReplay('customer_service_request_deferred', {
      is_cancellation: true, service_request_id: 'req-gone', waves_customer_id: 'cust-1',
    });
    expect(sendCancellationReceived).not.toHaveBeenCalled();
  });

  test('prep terminal (pre-push P1): releases the held-variant dedupe marker, never a delivered one', async () => {
    // The booking-time marker is a PERMANENT per-customer+pest guard —
    // a terminally-dead replay must release it or prep is suppressed for
    // every later valid booking. Scoped to the held-variant body.
    const del = { where: jest.fn(() => del), del: jest.fn(async () => 1) };
    db.mockReturnValueOnce(del);
    await onTerminalDeferredReplay('appointment_tagger_prep_deferred', {
      waves_customer_id: 'cust-1', pest_type: 'cockroach', scheduled_service_id: 'ss-1',
    });
    expect(del.where).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'cust-1',
      subject: 'cockroach prep info sent',
    }));
    expect(del.where).toHaveBeenCalledWith('body', 'like', 'Prep SMS held outside the 8AM-8PM ET send window%');
    expect(del.del).toHaveBeenCalled();

    // Legacy rows without the customer linkage: inert, no blind delete.
    await onTerminalDeferredReplay('appointment_tagger_prep_deferred', { pest_type: 'cockroach' });
    expect(del.del).toHaveBeenCalledTimes(1);
  });

  test('terminal hooks are durable (r16): obligation stamped first, cleared only on success', async () => {
    const { runTerminalHookDurably } = require('../services/messaging/deferred-replay-registry');
    const upd = { where: jest.fn(() => upd), update: jest.fn(async () => 1) };
    db.mockReturnValue(upd);

    // Success: stamp (terminal_pending true + attempts) THEN hook THEN clear.
    const ok = await runTerminalHookDurably('sms-1', 'voicemail_lead_sms_deferred', { lead_id: 'lead-1' });
    expect(ok.ok).toBe(true);
    expect(mockVmClaims.clearLeadClaim).toHaveBeenCalledWith('lead-1');
    expect(upd.update).toHaveBeenCalledTimes(2);

    // Hook failure: the stamp stays (no clear) so the sweep re-runs it.
    jest.clearAllMocks();
    db.mockReturnValue(upd);
    mockVmClaims.clearLeadClaim.mockRejectedValueOnce(new Error('db down'));
    const failed = await runTerminalHookDurably('sms-1', 'voicemail_lead_sms_deferred', { lead_id: 'lead-1' });
    expect(failed.ok).toBe(false);
    expect(upd.update).toHaveBeenCalledTimes(1);

    // No hook registered → inert, no stamps.
    jest.clearAllMocks();
    db.mockReturnValue(upd);
    const inert = await runTerminalHookDurably('sms-1', 'estimate_follow_up_deferred', {});
    expect(inert.ok).toBe(true);
    expect(upd.update).not.toHaveBeenCalled();
    db.mockReset();
  });

  test('terminal-hook sweep (r16): re-runs stamped rows bounded, clears loudly at exhaustion', async () => {
    const { sweepPendingTerminalHooks } = require('../services/messaging/deferred-replay-registry');
    const makeSelectChain = (rows) => {
      const q = {};
      for (const m of ['whereIn', 'whereRaw', 'where', 'orderBy', 'limit']) q[m] = jest.fn(() => q);
      q.select = jest.fn(async () => rows);
      q.update = jest.fn(async () => 1);
      return q;
    };
    const upd = { where: jest.fn(() => upd), update: jest.fn(async () => 1) };

    // Retryable row: hook re-runs and succeeds.
    let first = true;
    const selectChain = makeSelectChain([{
      id: 'sms-9',
      metadata: JSON.stringify({ entry_point: 'voicemail_lead_sms_deferred', lead_id: 'lead-9', terminal_pending: true, terminal_attempts: 1 }),
    }]);
    db.mockImplementation(() => { if (first) { first = false; return selectChain; } return upd; });
    const res = await sweepPendingTerminalHooks({ now: new Date('2026-08-08T12:00:00Z') });
    expect(res).toEqual({ candidates: 1, reran: 1 });
    expect(mockVmClaims.clearLeadClaim).toHaveBeenCalledWith('lead-9');

    // Exhausted row: cleared (no infinite loop), hook NOT re-run.
    jest.clearAllMocks();
    first = true;
    const exhausted = makeSelectChain([{
      id: 'sms-10',
      metadata: JSON.stringify({ entry_point: 'voicemail_lead_sms_deferred', lead_id: 'lead-10', terminal_pending: true, terminal_attempts: 5 }),
    }]);
    db.mockImplementation(() => { if (first) { first = false; return exhausted; } return upd; });
    const res2 = await sweepPendingTerminalHooks({ now: new Date('2026-08-08T12:00:00Z') });
    expect(res2).toEqual({ candidates: 1, reran: 0 });
    expect(mockVmClaims.clearLeadClaim).not.toHaveBeenCalled();
    expect(upd.update).toHaveBeenCalledTimes(1);
    db.mockReset();
  });

  test('lead-menu finalize stamps real sids and releases sentinel outcomes', async () => {
    const stamp = firstChain(null);
    stamp.update = jest.fn(async () => 1);
    db.mockReturnValueOnce(stamp);
    await finalizeDeferredReplay('lead_webhook_auto_reply_deferred', { lead_auto_reply_phone_digits: '5551234567' }, { providerMessageId: 'SM123' });
    expect(stamp.update).toHaveBeenCalledWith({ twilio_sid: 'SM123' });

    const release = firstChain(null);
    release.del = jest.fn(async () => 1);
    db.mockReturnValueOnce(release);
    await finalizeDeferredReplay('lead_webhook_auto_reply_deferred', { lead_auto_reply_phone_digits: '5551234567' }, { providerMessageId: 'owner-silence' });
    expect(release.del).toHaveBeenCalled();
  });
});
