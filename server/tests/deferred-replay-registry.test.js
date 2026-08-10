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
  resolveExemption: jest.fn(async () => ({ exempt: false })),
  // Mirrors the real module's canonical live-status list — the card
  // recheck imports it so the replay and the request path can never
  // disagree on what a live visit is.
  LIVE_VISIT_STATUSES: ['pending', 'confirmed'],
}));
const mockGetAppointmentContacts = jest.fn(() => [{ phone: '+19415557777' }]);
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: (...a) => mockGetAppointmentContacts(...a),
}));
const mockFilterRecipientsByOptin = jest.fn(async (contacts) => contacts);
jest.mock('../services/recipient-optin', () => ({
  filterRecipientsByOptin: (...a) => mockFilterRecipientsByOptin(...a),
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

  test('deferred invoice texts (r17 audit): a payer-billed invoice suppresses the homeowner replay', async () => {
    // Third-party Bill-To adopted overnight — AR routes to the payer's AP
    // inbox and billing texts must never reach the homeowner.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: 'payer-7' }));
    const payerBilled = await recheckDeferredReplay('invoice_send_deferred', { invoice_id: 'inv-1' });
    expect(payerBilled.eligible).toBe(false);
    expect(payerBilled.reason).toBe('payer-billed');

    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null }));
    const selfPay = await recheckDeferredReplay('invoice_send_deferred', { invoice_id: 'inv-1' });
    expect(selfPay.eligible).toBe(true);
  });

  test('call-booking contact confirmation (r17): dead or past visits suppress the fan-out replay', async () => {
    db.mockReturnValueOnce(firstChain({ status: 'cancelled', scheduled_date: '2026-08-09' }));
    const dead = await recheckDeferredReplay('call_booking_contact_confirmation_deferred', { scheduled_service_id: 'ss-1' });
    expect(dead.eligible).toBe(false);
    expect(dead.reason).toBe('visit-cancelled');

    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2099-01-01' }));
    const live = await recheckDeferredReplay('call_booking_contact_confirmation_deferred', { scheduled_service_id: 'ss-1' });
    expect(live.eligible).toBe(true);
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

  test('card request recheck (r19): payer exemption re-runs — exempt visits suppress the queued bearer link', async () => {
    const { resolveExemption } = require('../services/appointment-card-request');

    // Third-party payer adopted (or autopay enrolled) overnight — the
    // homeowner must not be asked for a card, same policy the immediate
    // path enforces before any capture machinery.
    db.mockReturnValueOnce(firstChain({ status: 'confirmed', card_link_sent_at: null, customer_id: 'cust-1' }));
    resolveExemption.mockResolvedValueOnce({ exempt: true, reason: 'payer_billed' });
    const exempt = await recheckDeferredReplay('appointment_card_request_deferred', { scheduled_service_id: 'ss-1' });
    expect(exempt.eligible).toBe(false);
    expect(exempt.reason).toBe('exempt:payer_billed');
    expect(resolveExemption).toHaveBeenCalledWith({ customerId: 'cust-1', scheduledServiceId: 'ss-1' });

    db.mockReturnValueOnce(firstChain({ status: 'confirmed', card_link_sent_at: null, customer_id: 'cust-1' }));
    resolveExemption.mockResolvedValueOnce({ exempt: false });
    const stillOn = await recheckDeferredReplay('appointment_card_request_deferred', { scheduled_service_id: 'ss-1' });
    expect(stillOn.eligible).toBe(true);
  });

  test('contact confirmation recheck (r19): the queued phone must still be an authorized, opted-in contact', async () => {
    const meta = { scheduled_service_id: 'ss-1', customer_id: 'cust-1', to_phone: '+19415557777' };

    // Slot intact (formatting differences aside): replay eligible.
    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2099-01-01' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    db.mockReturnValueOnce(firstChain({ customer_id: 'cust-1' }));
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '941-555-7777' }]);
    const present = await recheckDeferredReplay('call_booking_contact_confirmation_deferred', meta);
    expect(present.eligible).toBe(true);
    expect(mockGetAppointmentContacts).toHaveBeenCalled();

    // Contact removed/replaced overnight: the frozen number no longer
    // occupies a notification slot — suppress, never text a third party.
    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2099-01-01' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    db.mockReturnValueOnce(firstChain(null));
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '+19415550000' }]);
    const removed = await recheckDeferredReplay('call_booking_contact_confirmation_deferred', meta);
    expect(removed.eligible).toBe(false);
    expect(removed.reason).toBe('contact-removed');

    // Rows without the executor's to_phone/customer_id merge keep the
    // visit-only gate (no blind suppression on missing linkage).
    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2099-01-01' }));
    const legacy = await recheckDeferredReplay('call_booking_contact_confirmation_deferred', { scheduled_service_id: 'ss-1' });
    expect(legacy.eligible).toBe(true);
  });

  test('completion terminal (r19): restore failure propagates AFTER arming the review fallback', async () => {
    const { terminalDeferredCompletionSend } = require('../services/dispatch-completion-deferred');
    const { markInlineRetryable } = require('../services/review-request');
    terminalDeferredCompletionSend.mockRejectedValueOnce(new Error('service_records down'));
    const res = await onTerminalDeferredReplay('dispatch_completion_deferred', {
      service_record_id: 'rec-1', bundled_review_request_id: 'rev-1',
    });
    // ok:false keeps terminal_pending stamped → the bounded sweep retries
    // the restore; a success here would strand the record at 'deferred'.
    expect(res.ok).toBe(false);
    // The review fallback still armed — the customer-facing obligation
    // does not wait on the bookkeeping retry.
    expect(markInlineRetryable).toHaveBeenCalledWith('rev-1', expect.any(Date));
  });

  test('voicemail terminal (r19): a swallowed-false claim release fails the hook onto the sweep', async () => {
    mockVmClaims.releasePhoneClaim.mockResolvedValueOnce(false);
    const res = await onTerminalDeferredReplay('voicemail_lead_sms_deferred', {
      lead_id: 'lead-1', voicemail_phone: '+15551234567',
    });
    expect(res.ok).toBe(false);
    // Both releases were still ATTEMPTED — no short-circuit skips the phone.
    expect(mockVmClaims.clearLeadClaim).toHaveBeenCalledWith('lead-1');
    expect(mockVmClaims.releasePhoneClaim).toHaveBeenCalledWith('+15551234567');
  });

  test('cancellation confirmation (r19): a transient email failure fails the hook; deterministic skips settle', async () => {
    const { sendCancellationReceived } = require('../services/account-membership-email');
    const request = { id: 'req-1', customer_id: 'cust-1' };
    const meta = { is_cancellation: true, service_request_id: 'req-1', waves_customer_id: 'cust-1' };

    // Transient provider/template failure reports {ok:false} without
    // throwing — the hook must fail so the sweep retries, else the
    // deactivated customer gets neither channel and no retry obligation.
    db.mockReturnValueOnce(firstChain(request));
    sendCancellationReceived.mockResolvedValueOnce({ ok: false, error: 'smtp 500' });
    const transient = await onTerminalDeferredReplay('customer_service_request_deferred', meta);
    expect(transient.ok).toBe(false);

    // Deterministic skip (no email on file): retrying cannot fix it — settle.
    db.mockReturnValueOnce(firstChain(request));
    sendCancellationReceived.mockResolvedValueOnce({ ok: false, skipped: true, reason: 'missing_email' });
    const skipped = await onTerminalDeferredReplay('customer_service_request_deferred', meta);
    expect(skipped.ok).toBe(true);
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
    const { runTerminalHookDurably, requiresTerminalHook, TERMINAL_HOOK_ENTRY_POINTS } = require('../services/messaging/deferred-replay-registry');
    // The executor's terminal flips stamp terminal_pending atomically for
    // exactly the hooked entry points (r18) — derived from the registry.
    expect(TERMINAL_HOOK_ENTRY_POINTS).toEqual(expect.arrayContaining([
      'dispatch_completion_deferred',
      'voicemail_lead_sms_deferred',
      'customer_service_request_deferred',
      'appointment_tagger_prep_deferred',
    ]));
    for (const ep of TERMINAL_HOOK_ENTRY_POINTS) {
      expect(requiresTerminalHook(ep)).toBe(true);
    }
    expect(requiresTerminalHook('estimate_follow_up_deferred')).toBe(false);
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

  test('billing notice (r21): a PI that no longer resolves to an invoice is superseded, not invoice-less', async () => {
    // Tender switch overnight repoints the invoice to a new card PI and
    // pays it — the old PI resolves to nothing, and a frozen bank-failure
    // text over a settled invoice is the failure this guard prevents.
    db.mockReturnValueOnce(firstChain(null));
    const superseded = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'ach_retry_notice',
      stripe_payment_intent_id: 'pi_old',
    });
    expect(superseded.eligible).toBe(false);
    expect(superseded.reason).toBe('pi-association-superseded');

    // New rows carry the stable invoice id, so the collectibility check
    // owns the decision: paid overnight → suppressed.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'paid', payer_id: null }));
    const paid = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'ach_retry_notice',
      invoice_id: 'inv-1',
      stripe_payment_intent_id: 'pi_old',
    });
    expect(paid.eligible).toBe(false);

    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null }));
    const stillOwed = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'ach_retry_notice',
      invoice_id: 'inv-1',
      stripe_payment_intent_id: 'pi_old',
    });
    expect(stillOwed.eligible).toBe(true);

    // Setup-intent notices never carried a PI — unaffected by the guard.
    db.mockReturnValueOnce(firstChain(null));
    const setupFailure = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'bank_verification_failed',
      stripe_setup_intent_id: 'seti_1',
      waves_customer_id: 'cust-1',
    });
    expect(setupFailure.eligible).toBe(true);
  });

  test("card request recheck (r20): a 'rescheduled' pending-rebook placeholder suppresses — the replay must not consume the claim the re-slotted visit needs", async () => {
    db.mockReturnValueOnce(firstChain({ status: 'rescheduled', card_link_sent_at: null, customer_id: 'cust-1' }));
    const res = await recheckDeferredReplay('appointment_card_request_deferred', { scheduled_service_id: 'ss-1' });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe('visit-rescheduled');
  });

  test("visit-anchored replays (r20): 'rescheduled' is non-upcoming for the shared gate", async () => {
    db.mockReturnValueOnce(firstChain({ status: 'rescheduled', scheduled_date: '2099-01-01' }));
    const prep = await recheckDeferredReplay('appointment_tagger_prep_deferred', { scheduled_service_id: 's1' });
    expect(prep.eligible).toBe(false);
    expect(prep.reason).toBe('visit-rescheduled');
  });

  test('appointment notice contact (r20): held fan-out rows revalidate the contact slot like the call-booking secondary', async () => {
    const meta = { scheduled_service_id: 'ss-1', customer_id: 'cust-1', to_phone: '+19415557777' };

    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2099-01-01' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    db.mockReturnValueOnce(firstChain({ customer_id: 'cust-1' }));
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '941-555-7777' }]);
    const present = await recheckDeferredReplay('appointment_notice_contact_deferred', meta);
    expect(present.eligible).toBe(true);

    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2099-01-01' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    db.mockReturnValueOnce(firstChain(null));
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '+19415550000' }]);
    const removed = await recheckDeferredReplay('appointment_notice_contact_deferred', meta);
    expect(removed.eligible).toBe(false);
    expect(removed.reason).toBe('contact-removed');

    db.mockReturnValueOnce(firstChain({ status: 'rescheduled', scheduled_date: '2099-01-01' }));
    const moved = await recheckDeferredReplay('appointment_notice_contact_deferred', meta);
    expect(moved.eligible).toBe(false);
    expect(moved.reason).toBe('visit-rescheduled');
  });

  test('v2 invite terminal (r20): only the missing-table error is swallowed — transient failures keep terminal_pending stamped', async () => {
    const meta = { promoter_id: 'p-1', invite_phone: '+19415551234' };

    // Transient DB failure: the hook must report ok:false so the durable
    // wrapper leaves terminal_pending for the sweep — a swallowed error
    // here strands the /invite cooldown on an undelivered invite for 24h.
    const transient = firstChain(null);
    transient.del = jest.fn(async () => { const e = new Error('conn reset'); e.code = 'ECONNRESET'; throw e; });
    db.mockReturnValueOnce(transient);
    const failed = await onTerminalDeferredReplay('referrals_v2_invite_deferred', meta);
    expect(failed.ok).toBe(false);

    // Missing table mirrors the route's read fallback: ignorable, ok:true.
    const missing = firstChain(null);
    missing.del = jest.fn(async () => { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; });
    db.mockReturnValueOnce(missing);
    const tolerated = await onTerminalDeferredReplay('referrals_v2_invite_deferred', meta);
    expect(tolerated.ok).toBe(true);

    // Clean release still succeeds.
    const clean = firstChain(null);
    clean.del = jest.fn(async () => 1);
    db.mockReturnValueOnce(clean);
    const ok = await onTerminalDeferredReplay('referrals_v2_invite_deferred', meta);
    expect(ok.ok).toBe(true);
  });
});
