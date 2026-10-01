// A direct invoice notice's Email leg (#4963) stores a replay context, so a
// SendGrid provider retry re-runs the invoice checks instead of resending the
// frozen pay-link email. Only the immediate send and a queued
// invoice_send_deferred replay qualify; every other scheduled replay keeps
// the generic scheduled_sms_cron source and stores nothing.
jest.mock('../models/db', () => jest.fn());

const { buildBillingReplayContext, sanitizeBillingReplayContext } = require('../services/billing-email-replay-context');
const { payloadSnapshotForSend, readStoredBillingReplayContext } = require('../services/email-template-library');
const { isBillingEmailProviderReplay } = require('../services/billing-email-provider-replay');

const eventKey = 'invoice:inv-1:sent';
const authority = (overrides = {}) => ({
  customer: { id: 'cust-1' }, invoice: { id: 'inv-1' }, category: 'invoice', ...overrides,
});
const immediate = { entryPoint: 'invoice_send_via_sms', metadata: { notificationEventKey: eventKey } };
const scheduled = (originalEntryPoint) => ({
  entryPoint: 'scheduled_sms_cron',
  metadata: { notificationEventKey: eventKey, ...(originalEntryPoint ? { original_entry_point: originalEntryPoint } : {}) },
});
const expected = (source) => ({
  schema_version: 1, customer_id: 'cust-1', invoice_id: 'inv-1', category: 'invoice',
  source_entry_point: source, notificationEventKey: eventKey,
});

describe('direct invoice Email replay context', () => {
  test('the immediate invoice send stores an invoice-pinned context with no ledger id', () => {
    expect(buildBillingReplayContext(immediate, authority(), eventKey)).toEqual(expected('invoice_send_via_sms'));
  });

  test('a queued invoice_send_deferred replay maps back to its producer source', () => {
    expect(buildBillingReplayContext(scheduled('invoice_send_deferred'), authority(), eventKey))
      .toEqual(expected('invoice_send_deferred'));
  });

  test.each([
    ['another queued producer', 'dispatch_completion_deferred'],
    ['a row with no original entry point', undefined],
  ])('%s replayed by the scheduler stores no context', (_label, originalEntryPoint) => {
    expect(buildBillingReplayContext(scheduled(originalEntryPoint), authority(), eventKey)).toBeNull();
  });

  test.each([
    ['no invoice', authority({ invoice: null })],
    ['a non-invoice category', authority({ category: 'billing' })],
  ])('an invoice source with %s stores no context', (_label, context) => {
    expect(buildBillingReplayContext(immediate, context, eventKey)).toBeNull();
    expect(buildBillingReplayContext(scheduled('invoice_send_deferred'), context, eventKey)).toBeNull();
  });

  // Only a queued text whose own finalize marks the delivery may reach an
  // invoice not yet marked sent (invoice-send-replay-eligibility). A stored
  // Email context must never carry that exemption.
  test('a stored context drops the queued-text delivery flag', () => {
    const context = sanitizeBillingReplayContext({ ...expected('invoice_send_deferred'), mark_invoice_delivery: true });
    expect(context).toEqual(expected('invoice_send_deferred'));
  });

  // A queued invoice notice keeps the trusted dispute-hold exemption its immediate send carried (an
  // operator's send, the customer's own estimate accept) so a provider retry of its Email does not wait
  // out a plain dispute hold (Codex #5424 r14). Only those two values, only on a direct invoice source.
  test.each(['operator', 'customer'])('the queued replay stores the trusted %s hold exemption (scheduler forwards it as metadata.hold_exempt)', (exempt) => {
    const input = { ...scheduled('invoice_send_deferred'), metadata: { ...scheduled('invoice_send_deferred').metadata, hold_exempt: exempt } };
    expect(buildBillingReplayContext(input, authority(), eventKey)).toEqual({ ...expected('invoice_send_deferred'), hold_exempt: exempt });
    expect(buildBillingReplayContext({ ...immediate, holdExempt: exempt }, authority(), eventKey))
      .toEqual({ ...expected('invoice_send_via_sms'), hold_exempt: exempt });
  });

  test.each(['system', 'admin', '', 7])('an untrusted hold_exempt (%p) is never stored; a stored one is refused outright', (value) => {
    const input = { ...scheduled('invoice_send_deferred'), metadata: { ...scheduled('invoice_send_deferred').metadata, hold_exempt: value } };
    expect(buildBillingReplayContext(input, authority(), eventKey)).toEqual(expected('invoice_send_deferred'));
    expect(sanitizeBillingReplayContext({ ...expected('invoice_send_deferred'), hold_exempt: value })).toBeNull();
  });

  test('the exemption is stored for a direct invoice source only - never for a dunning source', () => {
    expect(sanitizeBillingReplayContext({
      schema_version: 1, customer_id: 'cust-1', invoice_id: 'inv-1', category: 'invoice', source_entry_point: 'late_payment_checker',
      notificationEventKey: eventKey, collections_ledger_id: 'led-1', hold_exempt: 'customer',
    })).toBeNull();
  });

  test('collections sources still require their reservation id', () => {
    expect(sanitizeBillingReplayContext({
      ...expected('late_payment_checker'), category: 'invoice',
    })).toBeNull();
  });

  test('the stored context survives the email snapshot and marks the row for the guarded retry', () => {
    const context = buildBillingReplayContext(immediate, authority(), eventKey);
    const facts = {
      templateKey: 'billing.notice', recipientType: 'customer', recipientId: 'cust-1',
      triggerEventId: eventKey, idempotencyKey: `billing_channel_email:${eventKey}:email`,
      categories: ['billing', 'invoice'],
    };
    const snapshot = payloadSnapshotForSend({ first_name: 'Pat' }, context, facts);
    const message = {
      template_key: 'billing.notice', payload_snapshot: JSON.stringify(snapshot),
      categories: JSON.stringify(facts.categories), recipient_email_snapshot: 'pat@example.com',
      recipient_type: 'customer', recipient_id: 'cust-1', trigger_event_id: eventKey,
      idempotency_key: facts.idempotencyKey,
    };
    expect(isBillingEmailProviderReplay(message)).toBe(true);
    expect(readStoredBillingReplayContext(message)).toEqual(expected('invoice_send_via_sms'));
  });

  test('an unrelated scheduled replay leaves the email on the ordinary retry path', () => {
    const context = buildBillingReplayContext(scheduled('dispatch_completion_deferred'), authority(), eventKey);
    const snapshot = payloadSnapshotForSend({ first_name: 'Pat' }, context, {});
    expect(isBillingEmailProviderReplay({ template_key: 'billing.notice', payload_snapshot: snapshot })).toBe(false);
  });
});
