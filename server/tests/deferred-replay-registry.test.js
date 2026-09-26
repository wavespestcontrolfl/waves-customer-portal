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
  // queuePendingChannelReplay's own advisory-lock wrap (Codex round-4 P1
  // pre-push audit) calls db.transaction when it gets no override — the
  // mock just re-enters with the same handle, matching invoice-sms-
  // provider-handoff.test.js's own db mock shape.
  mockDb.transaction = jest.fn(async (callback) => callback(mockDb));
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/retry-collectibility', () => ({
  ...jest.requireActual('../services/retry-collectibility'),
  loadRetryContext: jest.fn(() => ({ lookupWarnings: [] })),
  classifyFailedPaymentRetry: jest.fn(async () => ({ disposition: 'charge' })),
}));
jest.mock('../services/invoice-followups', () => ({
  isTerminalInvoice: jest.fn((inv) => ['paid', 'prepaid', 'void'].includes(String(inv?.status || ''))),
}));
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(async () => true),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
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
jest.mock('../services/estimate-follow-up', () => ({
  // The extension recheck runs the follow-up safetyGate FIRST (r7); the
  // r26 expiry-pin tests exercise the stamp comparison behind it.
  deferredFollowupStillEligible: jest.fn(async () => ({ eligible: true })),
}));
jest.mock('../services/appointment-reminders', () => ({
  // Canonical DATE+TIME→ET composition the card recheck consults (r24).
  // Defaults to a future instant so pre-r24 pins keep exercising their own
  // suppression reasons; instant-sensitive tests override with ...Once.
  scheduledServiceApptTime: jest.fn(async () => new Date(Date.now() + 60 * 60 * 1000)),
  // Channel resolution the contact-slot recheck re-runs (r27). Default
  // 'sms' keeps pre-r27 pins untouched; channel pins override with ...Once.
  getReminderPrefs: jest.fn(async () => ({ confirmationChannel: 'sms', reminder72hChannel: 'sms' })),
  // The visit-aware prefs row the recipient recheck reads (app property
  // scope, PR 3): a plain row = today's profile answer.
  visitPrefsRow: jest.fn(async () => ({})),
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
const mockReplayBillingRetryEmail = jest.fn(async () => ({
  sent: true, channel: 'email', deliveryOutcome: 'accepted',
}));
jest.mock('../services/billing-retry-email-obligation', () => ({
  replayPaymentRetryNotice: (...args) => mockReplayBillingRetryEmail(...args),
}));

const db = require('../models/db');
const {
  invoiceStillCollectible,
  recheckDeferredReplay,
  dispatchDeferredReplay,
  finalizeDeferredReplay,
  onTerminalDeferredReplay,
  requiresDurableFinalize,
  DURABLE_FINALIZE_ENTRY_POINTS,
  _registry,
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
  beforeEach(() => {
    jest.clearAllMocks();
    delete _registry.test_dispatch_deferred;
  });

  test('invoice collectibility uses the injected database for the invoice and sequence reads', async () => {
    const heldDatabase = jest.fn((table) => {
      if (table === 'invoices') return firstChain({
        id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: null,
      });
      if (table === 'invoice_followup_sequences') return firstChain({ status: 'stopped' });
      throw new Error(`Unexpected table ${table}`);
    });
    await expect(invoiceStillCollectible({
      invoice_id: 'inv-1', followup_sequence_id: 'seq-1',
    }, heldDatabase)).resolves.toEqual({ eligible: false, reason: 'sequence-stopped' });
    expect(heldDatabase.mock.calls.map(([table]) => table))
      .toEqual(['invoices', 'invoice_followup_sequences']);
    expect(db).not.toHaveBeenCalled();
  });

  test('exports the canonical collectibility check for billing Email eligibility', async () => {
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'paid' }));
    await expect(invoiceStillCollectible({ invoice_id: 'inv-1' }))
      .resolves.toMatchObject({ eligible: false, reason: 'invoice-terminal:paid' });
    db.mockReturnValueOnce(throwChain());
    await expect(invoiceStillCollectible({ invoice_id: 'inv-1' }))
      .resolves.toMatchObject({ eligible: false, retryable: true });
  });

  test('registered dispatch owns the replay and receives its trusted claim metadata', async () => {
    const outcome = { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'fixture-provider-id' };
    const dispatch = jest.fn(async () => outcome);
    const fallback = jest.fn(async () => ({ sent: false }));
    _registry.test_dispatch_deferred = { dispatch };
    const meta = { scheduled_sms_log_id: 'queue-1', customer_id: 'customer-1' };

    await expect(dispatchDeferredReplay('test_dispatch_deferred', meta, fallback)).resolves.toBe(outcome);
    // defaultDispatch rides along as a second argument so an entry can
    // hand ordinary rows straight back to it (see stripe_webhook_billing_deferred).
    expect(dispatch).toHaveBeenCalledWith(meta, fallback);
    expect(fallback).not.toHaveBeenCalled();
  });

  test('only the Email-only replay and the Stripe billing hold are allowed to run without a recipient phone', () => {
    const { replaysWithoutPhone } = require('../services/messaging/deferred-replay-registry');
    expect(replaysWithoutPhone('billing_retry_email_deferred')).toBe(true);
    expect(replaysWithoutPhone('stripe_webhook_billing_deferred')).toBe(true);
    expect(replaysWithoutPhone('invoice_followup_deferred')).toBe(false);
    expect(replaysWithoutPhone(undefined)).toBe(false);
  });

  // PR #4843 Codex r6: stripe_webhook_billing_deferred registers a dispatch
  // hook only to satisfy dispatchDeferredReplay's requires_registered_dispatch
  // contract (see the "unknown ordinary entries" test below) — the hook
  // itself is a pure pass-through to defaultDispatch for EVERY row, whether
  // or not it carries the phone-less stamp, so a phone-bearing hold under
  // this entry point is byte-identical to having no dispatch hook at all.
  test('the Stripe billing hold dispatch hook always defers to defaultDispatch', async () => {
    const phoneBearingOutcome = { sent: true, deliveryOutcome: 'accepted', channel: 'sms' };
    const phoneLessOutcome = { sent: true, deliveryOutcome: 'accepted', channel: 'push' };
    const phoneBearingFallback = jest.fn(async () => phoneBearingOutcome);
    const phoneLessFallback = jest.fn(async () => phoneLessOutcome);

    await expect(dispatchDeferredReplay('stripe_webhook_billing_deferred', {
      entry_point: 'stripe_webhook_billing_deferred',
    }, phoneBearingFallback)).resolves.toBe(phoneBearingOutcome);
    expect(phoneBearingFallback).toHaveBeenCalledTimes(1);

    await expect(dispatchDeferredReplay('stripe_webhook_billing_deferred', {
      entry_point: 'stripe_webhook_billing_deferred', requires_registered_dispatch: true,
      billingDeliveryCategory: 'payment_issue',
    }, phoneLessFallback)).resolves.toBe(phoneLessOutcome);
    expect(phoneLessFallback).toHaveBeenCalledTimes(1);
  });

  test('billing retry Email obligations use their registered Email-only dispatcher', async () => {
    const fallback = jest.fn(async () => ({ sent: true, channel: 'sms' }));
    const meta = { customer_id: 'cust-1', payment_id: 'pay-1', retry_date: '2026-09-29' };
    await expect(dispatchDeferredReplay('billing_retry_email_deferred', meta, fallback)).resolves.toMatchObject({
      sent: true, channel: 'email', deliveryOutcome: 'accepted',
    });
    expect(mockReplayBillingRetryEmail).toHaveBeenCalledWith(meta);
    expect(fallback).not.toHaveBeenCalled();
  });

  test.each([
    ['refusal', async () => ({ sent: false, blocked: true, code: 'COPY_INVALID', deliveryOutcome: 'not_sent' })],
    ['throw', async () => { throw new Error('fresh preparation failed'); }],
  ])('a registered dispatch %s never falls back to the frozen body', async (kind, dispatch) => {
    const fallback = jest.fn(async () => ({ sent: true }));
    _registry.test_dispatch_deferred = { dispatch };
    const replay = dispatchDeferredReplay('test_dispatch_deferred', {}, fallback);
    if (kind === 'throw') await expect(replay).rejects.toThrow('fresh preparation failed');
    else await expect(replay).resolves.toMatchObject({ sent: false, code: 'COPY_INVALID' });
    expect(fallback).not.toHaveBeenCalled();
  });

  test('unknown ordinary entries use the default dispatcher, while required entries retry without it', async () => {
    const fallback = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
    await expect(dispatchDeferredReplay('unknown_deferred', {}, fallback))
      .resolves.toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
    expect(fallback).toHaveBeenCalledTimes(1);

    await expect(dispatchDeferredReplay('unknown_deferred', {
      requires_registered_dispatch: true,
    }, fallback)).resolves.toEqual({
      sent: false,
      blocked: true,
      code: 'DEFERRED_DISPATCH_UNAVAILABLE',
      retryable: true,
      deliveryOutcome: 'not_sent',
    });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ status: 'failed', retry_count: 1 }, true],
    [{ status: 'failed', retry_count: 2 }, false],
    [{ status: 'paid', retry_count: 1 }, false],
    [null, false],
  ])('billing failure replay checks current payment and retry stage: %j', async (payment, eligible) => {
    const q = firstChain(payment);
    db.mockReturnValueOnce(q);
    if (eligible) db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    expect(await recheckDeferredReplay('billing_failure_deferred', {
      payment_id: 'pay-1', customer_id: 'cust-1', retry_count: 1,
    })).toMatchObject({ eligible });
    expect(q.where).toHaveBeenCalledWith({ id: 'pay-1', customer_id: 'cust-1' });
  });

  test('billing failure replay retains its retry on a database outage', async () => {
    db.mockReturnValueOnce(throwChain());
    expect(await recheckDeferredReplay('billing_failure_deferred', {
      payment_id: 'pay-1', customer_id: 'cust-1', retry_count: 1,
    })).toMatchObject({ eligible: false, retryable: true });
  });

  test.each(['SUPERSEDE_BY_COLLECTOR', 'SELF_SUPERSEDE'])('billing failure replay suppresses an obligation resolved by %s', async (kind) => {
    db.mockReturnValueOnce(firstChain({ status: 'failed', retry_count: 1 }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    const rules = require('../services/retry-collectibility');
    rules.classifyFailedPaymentRetry.mockResolvedValueOnce({ disposition: rules.DISPOSITIONS[kind], reason: 'settled' });
    expect(await recheckDeferredReplay('billing_failure_deferred', {
      payment_id: 'pay-1', customer_id: 'cust-1', retry_count: 1,
    })).toEqual({ eligible: false, reason: 'settled' });
  });

  test('invoice_send_deferred replays without a phone and dispatches through the default sender', async () => {
    const { dispatchDeferredReplay, replaysWithoutPhone } = require('../services/messaging/deferred-replay-registry');
    expect(replaysWithoutPhone('invoice_send_deferred')).toBe(true);
    const fallback = jest.fn(async () => ({ sent: true }));
    await expect(dispatchDeferredReplay('invoice_send_deferred', { requires_registered_dispatch: true }, fallback))
      .resolves.toEqual({ sent: true });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  // Codex #4963 round 4 P2 (finding C): a partial_fanout_retry row
  // (invoice.js's queuePendingChannelReplay) carries neither
  // mark_invoice_delivery nor bundled_review_request_id, so
  // finalizeDeferredCompletionSend (mocked above) is a no-op for it —
  // finding C stamps the invoice's own email_sent_at/sms_sent_at directly
  // in the registry's finalize hook, keyed off THIS replay's own dispatch
  // result (ctx.channelResults), scoped to the marker so the wrapper's own
  // pre-existing invoice_send_deferred rows are untouched.
  describe('invoice_send_deferred finalize: partial-fanout replay stamping (finding C)', () => {
    function whereUpdateChain(updateSpy) {
      const q = {};
      q.where = jest.fn(() => q);
      q.whereNot = jest.fn(() => q);
      q.update = updateSpy;
      return q;
    }

    test('a delayed replay never stamps a voided invoice', async () => {
      const update = jest.fn(async () => 0);
      const chain = whereUpdateChain(update);
      db.mockReturnValueOnce(chain);
      await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', partial_fanout_retry: true, pending_channels: ['email'],
      }, { channelResults: { email: { sent: true, deliveryOutcome: 'accepted' } } });
      expect(chain.whereNot).toHaveBeenCalledWith({ status: 'void' });
    });

    test('a replay that accepted Email stamps email_sent_at only', async () => {
      const update = jest.fn(async () => 1);
      db.mockReturnValueOnce(whereUpdateChain(update));
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', partial_fanout_retry: true, pending_channels: ['email'],
      }, {
        channelResults: { email: { sent: true, deliveryOutcome: 'accepted' } },
      });
      expect(res).toEqual({ ok: true });
      expect(db).toHaveBeenCalledWith('invoices');
      expect(update).toHaveBeenCalledTimes(1);
      const payload = update.mock.calls[0][0];
      expect(payload).toHaveProperty('email_sent_at');
      expect(payload).not.toHaveProperty('sms_sent_at');
    });

    test('a replay that accepted Text stamps sms_sent_at only', async () => {
      const update = jest.fn(async () => 1);
      db.mockReturnValueOnce(whereUpdateChain(update));
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', partial_fanout_retry: true, pending_channels: ['sms'],
      }, {
        channelResults: { sms: { sent: true, deliveryOutcome: 'accepted' } },
      });
      expect(res).toEqual({ ok: true });
      const payload = update.mock.calls[0][0];
      expect(payload).toHaveProperty('sms_sent_at');
      expect(payload).not.toHaveProperty('email_sent_at');
    });

    test('App (push) acceptance also stamps sms_sent_at (App/Text share one timestamp)', async () => {
      const update = jest.fn(async () => 1);
      db.mockReturnValueOnce(whereUpdateChain(update));
      await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', partial_fanout_retry: true, pending_channels: ['push'],
      }, {
        channelResults: { push: { sent: true, deliveryOutcome: 'accepted' } },
      });
      expect(update.mock.calls[0][0]).toHaveProperty('sms_sent_at');
    });

    test('a replay whose dispatch is still pending/uncertain stamps nothing', async () => {
      await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', partial_fanout_retry: true, pending_channels: ['email'],
      }, {
        channelResults: { email: { sent: false, deliveryOutcome: 'uncertain' } },
      });
      // No 'invoices' update call at all — db was never invoked for the
      // stamp (finalizeDeferredCompletionSend is mocked and makes no real
      // db call either).
      expect(db).not.toHaveBeenCalledWith('invoices');
    });

    test('the wrapper\'s own pre-existing rows (no partial_fanout_retry marker) never touch the invoices table here — finalizeDeferredCompletionSend owns them byte-identically', async () => {
      const { finalizeDeferredCompletionSend } = require('../services/dispatch-completion-deferred');
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', mark_invoice_delivery: true,
      }, {
        channelResults: { sms: { sent: true, deliveryOutcome: 'accepted' } },
      });
      expect(finalizeDeferredCompletionSend).toHaveBeenCalledWith({ invoice_id: 'inv-1', mark_invoice_delivery: true });
      expect(db).not.toHaveBeenCalledWith('invoices');
      expect(res).toEqual({ ok: true });
    });

    test('a partial_fanout_retry row replayed with no ctx.channelResults (unregistered caller) stamps nothing and never throws', async () => {
      await expect(finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', partial_fanout_retry: true, pending_channels: ['sms'],
      })).resolves.toEqual({ ok: true });
      expect(db).not.toHaveBeenCalledWith('invoices');
    });

    test('a stamp failure is caught and reported as ok:false (durable finalize retry rail), never thrown', async () => {
      db.mockReturnValueOnce(whereUpdateChain(jest.fn(async () => { throw new Error('db down'); })));
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', partial_fanout_retry: true, pending_channels: ['email'],
      }, {
        channelResults: { email: { sent: true, deliveryOutcome: 'accepted' } },
      });
      expect(res).toEqual({ ok: false });
    });
  });

  // Codex #4963 round 4 pre-push audit (finding C continued): the REPLAY
  // itself can only partially succeed — e.g. it accepts Text while Email is
  // still retryable/held. Without a pending check on the replay's own
  // outcome, the executor sees smsResult.sent:true, calls finalize, gets
  // ok:true, and discharges the row — the still-outstanding channel is
  // silently dropped with no further retry ever queued.
  describe('invoice_send_deferred finalize: the replay itself only partially succeeds', () => {
    function chainable() {
      const q = {};
      for (const m of ['where', 'whereIn', 'whereRaw', 'whereNot', 'whereNull', 'forUpdate', 'clone']) q[m] = jest.fn(() => q);
      q.update = jest.fn(async () => 1);
      q.first = jest.fn(async () => undefined);
      q.insert = jest.fn(async () => [1]);
      return q;
    }
    function mockTables({ existingQueued, smsLogInserts } = {}) {
      db.mockImplementation((table) => {
        if (table === 'invoices') return chainable();
        if (table === 'sms_log') {
          const q = chainable();
          // Models the real WHERE id != excludedId: a .whereNot({id}) call
          // narrows a same-id existingQueued match away to none, exactly
          // like the actual SQL would exclude the row being finalized.
          let excludedId = null;
          q.whereNot = jest.fn((criteria) => { excludedId = criteria?.id ?? criteria; return q; });
          q.first = jest.fn(async () => {
            if (existingQueued && excludedId && existingQueued.id === excludedId) return undefined;
            return existingQueued || undefined;
          });
          q.insert = jest.fn((row) => { if (smsLogInserts) smsLogInserts.push(row); return Promise.resolve([1]); });
          return q;
        }
        throw new Error(`Unexpected table: ${table}`);
      });
    }
    const partialAcceptResults = {
      email: { sent: false, blocked: false, deliveryOutcome: 'not_sent', code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true },
      sms: { sent: true, deliveryOutcome: 'accepted' },
    };

    test('replay accepts Text with Email still retryable: queues ONE new row with replaySkipChannels [previous skip, sms] and attempt 2', async () => {
      const smsLogInserts = [];
      mockTables({ smsLogInserts });
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', customer_id: 'cust-1', partial_fanout_retry: true,
        pending_channels: ['email'], replaySkipChannels: ['push'], partial_fanout_attempt: 1,
      }, {
        channelResults: partialAcceptResults, smsLogId: 'row-1', toPhone: '+19415550101', body: 'Invoice ready',
      });
      expect(res).toEqual({ ok: true });
      expect(smsLogInserts).toHaveLength(1);
      const meta = JSON.parse(smsLogInserts[0].metadata);
      expect(meta.partial_fanout_retry).toBe(true);
      expect(meta.partial_fanout_attempt).toBe(2);
      expect(meta.pending_channels).toEqual(['email']);
      expect(meta.original_block_code).toBe('BILLING_CHANNEL_FAILED');
      // Union of the PREVIOUS skip list and whatever THIS replay newly
      // delivered — a channel accepted two attempts ago must never be
      // re-sent by the next replay either.
      expect(meta.replaySkipChannels.sort()).toEqual(['push', 'sms']);
      expect(smsLogInserts[0].to_phone).toBe('+19415550101');
      expect(smsLogInserts[0].message_body).toBe('Invoice ready');
    });

    test('an uncertain pending leg after a partial accept is surfaced but never requeued (no double-send)', async () => {
      const smsLogInserts = [];
      mockTables({ smsLogInserts });
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', customer_id: 'cust-1', partial_fanout_retry: true,
        pending_channels: ['email'], partial_fanout_attempt: 1,
      }, {
        channelResults: {
          email: { sent: false, deliveryOutcome: 'uncertain' },
          sms: { sent: true, deliveryOutcome: 'accepted' },
        },
        smsLogId: 'row-1', toPhone: '+19415550101', body: 'Invoice ready',
      });
      expect(res).toEqual({ ok: true });
      expect(smsLogInserts).toHaveLength(0);
    });

    test('attempt cap: a would-be 5th attempt is refused, logged for operator review, never queued', async () => {
      const smsLogInserts = [];
      mockTables({ smsLogInserts });
      const logger = require('../services/logger');
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', customer_id: 'cust-1', partial_fanout_retry: true,
        pending_channels: ['email'], partial_fanout_attempt: 4,
      }, {
        channelResults: partialAcceptResults, smsLogId: 'row-1', toPhone: '+19415550101', body: 'Invoice ready',
      });
      expect(res).toEqual({ ok: true });
      expect(smsLogInserts).toHaveLength(0);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('inv-1'));
    });

    test('the row currently being finalized is excluded from the dedupe check by id — it is not mistaken for an existing queued row', async () => {
      const smsLogInserts = [];
      // The row being finalized itself still reads as a live ('sending')
      // sms_log row for this invoice at this exact moment — without
      // excludeSmsLogId the dedupe check below would "find" it and skip
      // queuing the genuine new retry row.
      mockTables({ existingQueued: { id: 'row-1' }, smsLogInserts });
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', customer_id: 'cust-1', partial_fanout_retry: true,
        pending_channels: ['email'], partial_fanout_attempt: 1,
      }, {
        channelResults: partialAcceptResults, smsLogId: 'row-1', toPhone: '+19415550101', body: 'Invoice ready',
      });
      expect(res).toEqual({ ok: true });
      expect(smsLogInserts).toHaveLength(1);
    });

    test('a genuinely already-queued OTHER row is still adopted, never duplicated', async () => {
      const smsLogInserts = [];
      mockTables({ existingQueued: { id: 'row-other' }, smsLogInserts });
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', customer_id: 'cust-1', partial_fanout_retry: true,
        pending_channels: ['email'], partial_fanout_attempt: 1,
      }, {
        channelResults: partialAcceptResults, smsLogId: 'row-1', toPhone: '+19415550101', body: 'Invoice ready',
      });
      expect(res).toEqual({ ok: true });
      expect(smsLogInserts).toHaveLength(0);
    });

    test('a fully-accepted replay requeues nothing', async () => {
      const smsLogInserts = [];
      mockTables({ smsLogInserts });
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', customer_id: 'cust-1', partial_fanout_retry: true,
        pending_channels: ['email'], partial_fanout_attempt: 1,
      }, {
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: true, deliveryOutcome: 'accepted' },
        },
        smsLogId: 'row-1', toPhone: '+19415550101', body: 'Invoice ready',
      });
      expect(res).toEqual({ ok: true });
      expect(smsLogInserts).toHaveLength(0);
    });

    test('a permanently-blocked pending leg (no retryable/deferred flag) is surfaced but never requeued', async () => {
      const smsLogInserts = [];
      mockTables({ smsLogInserts });
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', customer_id: 'cust-1', partial_fanout_retry: true,
        pending_channels: ['email'], partial_fanout_attempt: 1,
      }, {
        channelResults: {
          email: { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'MISSING_BILLING_RECIPIENT' },
          sms: { sent: true, deliveryOutcome: 'accepted' },
        },
        smsLogId: 'row-1', toPhone: '+19415550101', body: 'Invoice ready',
      });
      expect(res).toEqual({ ok: true });
      expect(smsLogInserts).toHaveLength(0);
    });

    test('a queue-insert failure returns ok:false so the durable finalize retry rail redoes it', async () => {
      db.mockImplementation((table) => {
        if (table === 'invoices') return chainable();
        if (table === 'sms_log') {
          const q = chainable();
          q.first = jest.fn(async () => undefined);
          q.insert = jest.fn(() => { throw new Error('db down'); });
          return q;
        }
        throw new Error(`Unexpected table: ${table}`);
      });
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', customer_id: 'cust-1', partial_fanout_retry: true,
        pending_channels: ['email'], partial_fanout_attempt: 1,
      }, {
        channelResults: partialAcceptResults, smsLogId: 'row-1', toPhone: '+19415550101', body: 'Invoice ready',
      });
      expect(res).toEqual({ ok: false });
    });

    test('the finalize_only durable retry rail (bare ctx — no channelResults) recovers a previously-persisted copy and still requeues', async () => {
      // Mirrors scheduler.js's claimMeta.finalize_only branch: ctx carries
      // only retry/customerId/providerMessageId/smsLogId — channelResults/
      // toPhone/body are NOT there. They must come back from the row's OWN
      // metadata (persisted by the FIRST attempt below).
      const smsLogInserts = [];
      mockTables({ smsLogInserts });
      const res = await finalizeDeferredReplay('invoice_send_deferred', {
        invoice_id: 'inv-1', customer_id: 'cust-1', partial_fanout_retry: true,
        pending_channels: ['email'], partial_fanout_attempt: 1,
        replay_channel_results: partialAcceptResults,
        replay_to_phone: '+19415550101', replay_body: 'Invoice ready',
      }, {
        retry: true, customerId: 'cust-1', providerMessageId: null, smsLogId: 'row-1',
      });
      expect(res).toEqual({ ok: true });
      expect(smsLogInserts).toHaveLength(1);
      const meta = JSON.parse(smsLogInserts[0].metadata);
      expect(meta.partial_fanout_attempt).toBe(2);
      expect(smsLogInserts[0].to_phone).toBe('+19415550101');
    });
  });

  test.each([
    [{ status: 'paid' }, true],
    [{ status: 'refunded' }, false],
    [{ status: 'disputed' }, false],
    [{ status: 'canceled' }, false],
    [{ status: 'failed' }, false],
    [null, false],
  ])('billing receipt replay checks the payment is still paid: %j', async (payment, eligible) => {
    const q = firstChain(payment);
    db.mockReturnValueOnce(q);
    if (eligible) db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    expect(await recheckDeferredReplay('billing_receipt_deferred', {
      payment_id: 'pay-1', customer_id: 'cust-1',
    })).toMatchObject({ eligible });
    expect(q.where).toHaveBeenCalledWith({ id: 'pay-1', customer_id: 'cust-1' });
  });

  test.each([
    ['a partial refund amount', { status: 'paid', refund_amount: '12.50' }],
    ['a pending refund', { status: 'paid', refund_amount: 0, refund_status: 'pending' }],
    ['a succeeded refund', { status: 'paid', refund_amount: null, refund_status: 'succeeded' }],
  ])('billing receipt replay suppresses after %s on a still-paid payment', async (_label, payment) => {
    db.mockReturnValueOnce(firstChain(payment));
    expect(await recheckDeferredReplay('billing_receipt_deferred', {
      payment_id: 'pay-1', customer_id: 'cust-1',
    })).toEqual({ eligible: false, reason: 'payment-refunded' });
  });

  test.each([
    ['never refunded (NULL refund columns)', { status: 'paid', refund_amount: null, refund_status: null }],
    ['a failed refund that returned nothing', { status: 'paid', refund_amount: 0, refund_status: 'failed' }],
    ['a canceled refund', { status: 'paid', refund_amount: '0.00', refund_status: 'canceled' }],
  ])('billing receipt replay stays eligible when %s', async (_label, payment) => {
    db.mockReturnValueOnce(firstChain(payment));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1', deleted_at: null }));
    expect(await recheckDeferredReplay('billing_receipt_deferred', {
      payment_id: 'pay-1', customer_id: 'cust-1',
    })).toEqual({ eligible: true });
  });

  test.each([
    ['an object', { pending_refund_key: 'refund_pay-1_0' }],
    ['a JSON string', JSON.stringify({ pending_refund_key: 'refund_pay-1_0' })],
  ])('billing receipt replay holds for retry while a refund is unresolved (metadata as %s)', async (_label, metadata) => {
    db.mockReturnValueOnce(firstChain({ status: 'paid', refund_amount: null, refund_status: null, metadata }));
    expect(await recheckDeferredReplay('billing_receipt_deferred', {
      payment_id: 'pay-1', customer_id: 'cust-1',
    })).toEqual({ eligible: false, reason: 'refund-unresolved', retryable: true });
  });

  test('billing receipt replay holds for retry when payment metadata is unreadable', async () => {
    db.mockReturnValueOnce(firstChain({ status: 'paid', refund_amount: null, refund_status: null, metadata: '{not json' }));
    expect(await recheckDeferredReplay('billing_receipt_deferred', {
      payment_id: 'pay-1', customer_id: 'cust-1',
    })).toEqual({ eligible: false, reason: 'refund-state-unreadable', retryable: true });
  });

  test('billing receipt replay suppresses for a deleted customer', async () => {
    db.mockReturnValueOnce(firstChain({ status: 'paid' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1', deleted_at: new Date() }));
    expect(await recheckDeferredReplay('billing_receipt_deferred', {
      payment_id: 'pay-1', customer_id: 'cust-1',
    })).toEqual({ eligible: false, reason: 'customer-unavailable' });
  });

  test('billing receipt replay retains its retry on a database outage', async () => {
    db.mockReturnValueOnce(throwChain());
    expect(await recheckDeferredReplay('billing_receipt_deferred', {
      payment_id: 'pay-1', customer_id: 'cust-1',
    })).toMatchObject({ eligible: false, retryable: true });
  });

  test('billing_receipt_deferred replays without a phone and dispatches through the default sender', async () => {
    const { dispatchDeferredReplay, replaysWithoutPhone } = require('../services/messaging/deferred-replay-registry');
    expect(replaysWithoutPhone('billing_receipt_deferred')).toBe(true);
    const fallback = jest.fn(async () => ({ sent: true }));
    await expect(dispatchDeferredReplay('billing_receipt_deferred', { requires_registered_dispatch: true }, fallback))
      .resolves.toEqual({ sent: true });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

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

    // A WITHDRAWN combined-visit invoice keeps payer_id NULL and a collectible
    // status — the Bill-To move lives only in its stamp — so a reminder queued
    // before that change must suppress too.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: 'payer_billed:7:hold' }));
    const withdrawn = await recheckDeferredReplay('invoice_send_deferred', { invoice_id: 'inv-1' });
    expect(withdrawn.eligible).toBe(false);
    expect(withdrawn.reason).toBe('payer-billed-withdrawn');

    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null }));
    const selfPay = await recheckDeferredReplay('invoice_send_deferred', { invoice_id: 'inv-1' });
    expect(selfPay.eligible).toBe(true);
  });

  test('a queued follow-up text suppresses once its invoice is withdrawn to a payer', async () => {
    // The sequence is paused by the withdrawal, but a text queued BEFORE the
    // Bill-To change is already claimed — this recheck is what stops it.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'overdue', payer_id: null, scheduled_send_error: 'payer_billed:7:hold' }));
    const withdrawn = await recheckDeferredReplay('invoice_followup_deferred', { invoice_id: 'inv-1' });
    expect(withdrawn.eligible).toBe(false);
    expect(withdrawn.reason).toBe('payer-billed-withdrawn');
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
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '941-555-7777' }]);
    const present = await recheckDeferredReplay('call_booking_contact_confirmation_deferred', meta);
    expect(present.eligible).toBe(true);
    expect(mockGetAppointmentContacts).toHaveBeenCalled();
    // The prefs row is read through the visit (app property scope, PR 3) so a
    // NON-primary saved property's notify-primary decides the recipients.
    expect(require('../services/appointment-reminders').visitPrefsRow).toHaveBeenCalledWith('cust-1', 'ss-1');

    // Contact removed/replaced overnight: the frozen number no longer
    // occupies a notification slot — suppress, never text a third party.
    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2099-01-01' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
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

  test('completion recheck (round 9 #4634 finding 1): a stale invoice strips the pay link instead of suppressing the whole completion/report send', async () => {
    // Most completion replays carry no pay link at all — a no-op read.
    expect(await recheckDeferredReplay('dispatch_completion_deferred', { service_record_id: 'rec-1' }))
      .toEqual({ eligible: true });
    expect(db).not.toHaveBeenCalled();

    // Still collectible — nothing to strip.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null }));
    expect(await recheckDeferredReplay('dispatch_completion_deferred', { invoice_id: 'inv-1', pay_url: 'https://p' }))
      .toEqual({ eligible: true });

    // Settled zero-due overnight (or otherwise terminal): the report still
    // sends (eligible: true, never cancelled/suppressed — the owner's r8
    // ruling), but the frozen pay-link line is now stale.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'prepaid', payer_id: null }));
    expect(await recheckDeferredReplay('dispatch_completion_deferred', { invoice_id: 'inv-1', pay_url: 'https://p' }))
      .toEqual({ eligible: true, stripPayLink: true, reason: 'invoice-terminal:prepaid' });

    // Moved to a payer overnight: same treatment — strip, don't suppress.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: 'payer-1' }));
    expect(await recheckDeferredReplay('dispatch_completion_deferred', { invoice_id: 'inv-1', pay_url: 'https://p' }))
      .toEqual({ eligible: true, stripPayLink: true, reason: 'payer-billed' });
  });

  test('completion recheck (round 10 #4634 finding 3): a transient collectibility-read failure stays retryable-ineligible, never promoted to a strip', async () => {
    // invoiceStillCollectible's own db read throws — failClosed reports
    // { eligible: false, reason: 'recheck-failed', retryable: true }. The
    // round-9 bug converted EVERY ineligible result (this one included)
    // into { eligible: true, stripPayLink: true } — permanently stripping
    // a pay link that never had anything actually wrong with it, on
    // nothing more than a DB hiccup that the scheduler's bounded retry
    // ladder would otherwise have resolved on the next pass.
    db.mockReturnValueOnce(throwChain());
    await expect(recheckDeferredReplay('dispatch_completion_deferred', { invoice_id: 'inv-1', pay_url: 'https://p' }))
      .resolves.toEqual({ eligible: false, reason: 'recheck-failed', retryable: true });
  });

  test('completion recheck (round 10 #4634 finding 3): an invoice row that is simply gone is treated like a confirmed-terminal invoice (strip, never suppress)', async () => {
    db.mockReturnValueOnce(firstChain(undefined));
    await expect(recheckDeferredReplay('dispatch_completion_deferred', { invoice_id: 'inv-1', pay_url: 'https://p' }))
      .resolves.toEqual({ eligible: true, stripPayLink: true, reason: 'invoice-missing' });
  });

  test('completion recheck (round 10 #4634 finding 3): a withdrawn-from-customer invoice strips like payer-billed', async () => {
    // invoiceWithdrawnFromCustomer (invoice-helpers.js, real implementation)
    // keys on the payer_billed: prefix a packet withdrawal stamps on
    // scheduled_send_error — no mock needed, a real row triggers it.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null, scheduled_send_error: 'payer_billed: adopted 2026-09-20' }));
    await expect(recheckDeferredReplay('dispatch_completion_deferred', { invoice_id: 'inv-1', pay_url: 'https://p' }))
      .resolves.toEqual({ eligible: true, stripPayLink: true, reason: 'payer-billed-withdrawn' });
  });

  test('completion recheck (round 10 #4634 finding 3): a stopped follow-up sequence suppresses the whole replay instead of stripping the link', async () => {
    // sequence-stopped is a live stop signal on the invoice's own follow-up
    // sequence (a reply/opt-out), not "this one pay link went stale" — the
    // round-9 bug would have stripped the link and sent the rest of the
    // completion text anyway. It must take the same suppress/terminal path
    // every other genuinely-ineligible reason took before the round-8
    // strip carve-out.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null }));
    db.mockReturnValueOnce(firstChain({ status: 'stopped' }));
    await expect(recheckDeferredReplay('dispatch_completion_deferred', {
      invoice_id: 'inv-1', pay_url: 'https://p', followup_sequence_id: 'seq-1',
    })).resolves.toEqual({ eligible: false, reason: 'sequence-stopped' });
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
    expect(sendCancellationReceived).toHaveBeenCalledWith({ customerId: 'cust-1', request, processed: false });

    // H0: the route stamps the processor outcome on the scheduled row; a
    // completed cancel gets the completed outcome line in the fallback email.
    jest.clearAllMocks();
    db.mockReturnValueOnce(firstChain(request));
    await onTerminalDeferredReplay('customer_service_request_deferred', {
      is_cancellation: true, service_request_id: 'req-1', waves_customer_id: 'cust-1', cancellation_processed: true,
    });
    expect(sendCancellationReceived).toHaveBeenCalledWith({ customerId: 'cust-1', request, processed: true });

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
    const upd = { where: jest.fn(() => upd), whereRaw: jest.fn(() => upd), update: jest.fn(async () => 1) };

    // Retryable row: claimed (guarded lease UPDATE returns 1), hook
    // re-runs and succeeds.
    let first = true;
    const selectChain = makeSelectChain([{
      id: 'sms-9',
      metadata: JSON.stringify({ entry_point: 'voicemail_lead_sms_deferred', lead_id: 'lead-9', terminal_pending: true, terminal_attempts: 1 }),
    }]);
    db.mockImplementation(() => { if (first) { first = false; return selectChain; } return upd; });
    const res = await sweepPendingTerminalHooks({ now: new Date('2026-08-08T12:00:00Z') });
    expect(res).toEqual({ candidates: 1, reran: 1 });
    expect(mockVmClaims.clearLeadClaim).toHaveBeenCalledWith('lead-9');
    // 'cancelled' is swept too: an invoice unvoid cancels completion/decline
    // replays with the terminal_pending stamp — a crash before its
    // post-commit hook pass must land here (Codex #3493 r15).
    expect(selectChain.whereIn).toHaveBeenCalledWith('status', ['blocked', 'failed', 'cancelled']);

    // Lost claim race (r24): another pod's guarded UPDATE won — this pod
    // must NOT run the hook or burn an attempt.
    jest.clearAllMocks();
    first = true;
    const raced = makeSelectChain([{
      id: 'sms-11',
      metadata: JSON.stringify({ entry_point: 'voicemail_lead_sms_deferred', lead_id: 'lead-11', terminal_pending: true, terminal_attempts: 1 }),
    }]);
    const claimMiss = { where: jest.fn(() => claimMiss), whereRaw: jest.fn(() => claimMiss), update: jest.fn(async () => 0) };
    db.mockImplementation(() => { if (first) { first = false; return raced; } return claimMiss; });
    const resRaced = await sweepPendingTerminalHooks({ now: new Date('2026-08-08T12:00:00Z') });
    expect(resRaced).toEqual({ candidates: 1, reran: 0 });
    expect(mockVmClaims.clearLeadClaim).not.toHaveBeenCalled();

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

  test('notice contact (r22): a cancellation row checks the TERMINAL status, not visit liveness', async () => {
    const meta = {
      scheduled_service_id: 'ss-1',
      customer_id: 'cust-1',
      to_phone: '+19415557777',
      required_visit_statuses: ['cancelled', 'canceled'],
    };

    // Still cancelled → the held contact's cancellation replays (the
    // liveness predicate would have dropped it outright).
    db.mockReturnValueOnce(firstChain({ status: 'cancelled' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '941-555-7777' }]);
    const stillCancelled = await recheckDeferredReplay('appointment_notice_contact_deferred', meta);
    expect(stillCancelled.eligible).toBe(true);

    // Restored overnight → suppress; a frozen "your appointment was
    // cancelled" against a live visit is worse than silence.
    db.mockReturnValueOnce(firstChain({ status: 'confirmed' }));
    const restored = await recheckDeferredReplay('appointment_notice_contact_deferred', meta);
    expect(restored.eligible).toBe(false);
    expect(restored.reason).toBe('visit-confirmed');

    // No-show rows carry their own terminal status.
    db.mockReturnValueOnce(firstChain({ status: 'no_show' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '941-555-7777' }]);
    const noShow = await recheckDeferredReplay('appointment_notice_contact_deferred', {
      ...meta, required_visit_statuses: ['no_show'],
    });
    expect(noShow.eligible).toBe(true);
  });

  test('document reminder (r22): a rotated share token suppresses the queued dead link', async () => {
    db.mockReturnValueOnce(firstChain({ status: 'sent', signed_at: null, share_token_hash: 'hash-new' }));
    const rotated = await recheckDeferredReplay('document_request_reminder_deferred', {
      contract_id: 'ct-1', share_token_hash: 'hash-old',
    });
    expect(rotated.eligible).toBe(false);
    expect(rotated.reason).toBe('share-token-rotated');

    db.mockReturnValueOnce(firstChain({ status: 'sent', signed_at: null, share_token_hash: 'hash-old' }));
    const intact = await recheckDeferredReplay('document_request_reminder_deferred', {
      contract_id: 'ct-1', share_token_hash: 'hash-old',
    });
    expect(intact.eligible).toBe(true);

    // Legacy rows (queued before the hash was recorded) keep prior behavior.
    db.mockReturnValueOnce(firstChain({ status: 'sent', signed_at: null, share_token_hash: 'hash-new' }));
    const legacy = await recheckDeferredReplay('document_request_reminder_deferred', { contract_id: 'ct-1' });
    expect(legacy.eligible).toBe(true);
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

  test('card request recheck (r24): a passed appointment instant suppresses the bearer link', async () => {
    const { scheduledServiceApptTime } = require('../services/appointment-reminders');

    // The visit's ET instant has passed but its status still says
    // 'pending' (an early visit's status often lags the tech's arrival) —
    // the pre-visit card ask must not fire mid-service.
    db.mockReturnValueOnce(firstChain({ status: 'pending', card_link_sent_at: null, customer_id: 'cust-1', scheduled_date: '2026-08-11' }));
    scheduledServiceApptTime.mockResolvedValueOnce(new Date(Date.now() - 60 * 1000));
    const started = await recheckDeferredReplay('appointment_card_request_deferred', { scheduled_service_id: 'ss-1' });
    expect(started.eligible).toBe(false);
    expect(started.reason).toBe('visit-started');

    // No window_start on the row → calendar-day fallback: an earlier ET
    // day suppresses, same-day stays a useful pre-visit ask.
    db.mockReturnValueOnce(firstChain({ status: 'pending', card_link_sent_at: null, customer_id: 'cust-1', scheduled_date: '2000-01-01' }));
    scheduledServiceApptTime.mockResolvedValueOnce(null);
    const past = await recheckDeferredReplay('appointment_card_request_deferred', { scheduled_service_id: 'ss-1' });
    expect(past.eligible).toBe(false);
    expect(past.reason).toBe('visit-past');

    // Appt-time lookup failure holds the row (fail closed) — it must never
    // read as "no time on file → eligible".
    db.mockReturnValueOnce(firstChain({ status: 'pending', card_link_sent_at: null, customer_id: 'cust-1', scheduled_date: '2026-08-11' }));
    scheduledServiceApptTime.mockRejectedValueOnce(new Error('db down'));
    const held = await recheckDeferredReplay('appointment_card_request_deferred', { scheduled_service_id: 'ss-1' });
    expect(held).toEqual({ eligible: false, reason: 'recheck-failed', retryable: true });
  });

  test("card request recheck (r20): a 'rescheduled' pending-rebook placeholder suppresses — the replay must not consume the claim the re-slotted visit needs", async () => {
    db.mockReturnValueOnce(firstChain({ status: 'rescheduled', card_link_sent_at: null, customer_id: 'cust-1' }));
    const res = await recheckDeferredReplay('appointment_card_request_deferred', { scheduled_service_id: 'ss-1' });
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe('visit-rescheduled');
  });

  test('visit-anchored replays (r26): a same-day visit whose ET window already opened suppresses', async () => {
    const { etDateString } = require('../utils/datetime-et');
    const todayET = etDateString();

    // Window opened at 00:00 ET today — any replay after midnight is
    // at-or-after service start.
    db.mockReturnValueOnce(firstChain({ status: 'confirmed', scheduled_date: todayET, window_start: '00:00:00' }));
    const started = await recheckDeferredReplay('appointment_tagger_prep_deferred', { scheduled_service_id: 'ss-1' });
    expect(started.eligible).toBe(false);
    expect(started.reason).toBe('visit-started');

    // A future-dated visit with a window is untouched by the instant check.
    db.mockReturnValueOnce(firstChain({ status: 'confirmed', scheduled_date: '2099-01-01', window_start: '09:00:00' }));
    const future = await recheckDeferredReplay('appointment_tagger_prep_deferred', { scheduled_service_id: 'ss-1' });
    expect(future.eligible).toBe(true);
  });

  test('extension replay (r26): a re-extension before the window open suppresses the first grant\'s copy', async () => {
    // The stamped grant no longer matches the live expires_at — an admin
    // re-extended overnight and sent their own confirmation.
    db.mockReturnValueOnce(firstChain({ expires_at: '2026-09-01T00:00:00.000Z' }));
    const superseded = await recheckDeferredReplay('estimate_extension_deferred', {
      estimate_id: 'est-1',
      granted_expires_at: '2026-08-25T00:00:00.000Z',
    });
    expect(superseded.eligible).toBe(false);
    expect(superseded.reason).toBe('extension-superseded');

    // Matching grant replays.
    db.mockReturnValueOnce(firstChain({ expires_at: '2026-08-25T00:00:00.000Z' }));
    const current = await recheckDeferredReplay('estimate_extension_deferred', {
      estimate_id: 'est-1',
      granted_expires_at: '2026-08-25T00:00:00.000Z',
    });
    expect(current.eligible).toBe(true);

    // Read failure holds the row — never "can't verify → send".
    db.mockReturnValueOnce(throwChain());
    const held = await recheckDeferredReplay('estimate_extension_deferred', {
      estimate_id: 'est-1',
      granted_expires_at: '2026-08-25T00:00:00.000Z',
    });
    expect(held).toEqual({ eligible: false, reason: 'recheck-failed', retryable: true });
  });

  test('invoice replay amount pin (r27): a balance that moved overnight suppresses the frozen body', async () => {
    // Credit applied after enqueue: live due 75.00 ≠ rendered 100.00.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null, total: 100, credit_applied: 25 }));
    const changed = await recheckDeferredReplay('invoice_followup_deferred', { invoice_id: 'inv-1', rendered_amount: '100.00' });
    expect(changed.eligible).toBe(false);
    expect(changed.reason).toBe('amount-changed');

    // Unchanged balance replays; legacy rows without the stamp skip the pin.
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null, total: 100, credit_applied: 0 }));
    const same = await recheckDeferredReplay('invoice_followup_deferred', { invoice_id: 'inv-1', rendered_amount: '100.00' });
    expect(same.eligible).toBe(true);
  });

  test('notice-contact channel pin (r27): an email-only preference flipped overnight suppresses the SMS replay', async () => {
    const { getReminderPrefs } = require('../services/appointment-reminders');
    const meta = {
      scheduled_service_id: 'ss-1',
      customer_id: 'cust-1',
      to_phone: '+19415557777',
      replay_purpose: 'appointment_confirmation',
    };
    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2099-01-01' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '941-555-7777' }]);
    getReminderPrefs.mockResolvedValueOnce({ confirmationChannel: 'email', reminder72hChannel: 'sms' });
    const flipped = await recheckDeferredReplay('appointment_notice_contact_deferred', meta);
    expect(flipped.eligible).toBe(false);
    expect(flipped.reason).toBe('channel-email');
    expect(getReminderPrefs).toHaveBeenCalledWith('cust-1', { scheduledServiceId: 'ss-1' });

    // 'both' keeps the SMS leg; purposes without a channel pref never
    // consult the helper.
    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2099-01-01' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '941-555-7777' }]);
    getReminderPrefs.mockResolvedValueOnce({ confirmationChannel: 'both', reminder72hChannel: 'sms' });
    const both = await recheckDeferredReplay('appointment_notice_contact_deferred', meta);
    expect(both.eligible).toBe(true);
  });

  test('ACH ladder pin (r27): a failure count that advanced overnight supersedes the queued stage', async () => {
    // The PI failed again after this retry-notice queued — the customer
    // will get the NEWER stage's notice; this one is obsolete.
    db.mockReturnValueOnce(firstChain({ ach_failure_count: 2 }));
    const superseded = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'ach_retry_notice',
      recent_failures: 1,
      customer_id: 'cust-1',
      invoice_id: 'inv-1',
    });
    expect(superseded.eligible).toBe(false);
    expect(superseded.reason).toBe('ach-stage-superseded');

    // Count unchanged → the stage is current; falls through to the
    // collectibility check.
    db.mockReturnValueOnce(firstChain({ ach_failure_count: 1 }));
    db.mockReturnValueOnce(firstChain({ id: 'inv-1', status: 'sent', payer_id: null }));
    const current = await recheckDeferredReplay('stripe_webhook_billing_deferred', {
      original_message_type: 'ach_retry_notice',
      recent_failures: 1,
      customer_id: 'cust-1',
      invoice_id: 'inv-1',
    });
    expect(current.eligible).toBe(true);
  });

  test('notice-contact slot pin (r25): a second overnight move suppresses the frozen first-move copy', async () => {
    // SmartRebooker forces status straight back to 'confirmed', so the
    // status checks pass — only the stamped slot exposes the second move.
    db.mockReturnValueOnce(firstChain({ status: 'confirmed', scheduled_date: '2099-01-02', window_start: '09:00:00' }));
    const dateMoved = await recheckDeferredReplay('appointment_notice_contact_deferred', {
      scheduled_service_id: 'ss-1',
      slot_scheduled_date: '2099-01-01',
      slot_window_start: '09:00',
    });
    expect(dateMoved.eligible).toBe(false);
    expect(dateMoved.reason).toBe('slot-moved');

    // Same day, different window — still the wrong copy.
    db.mockReturnValueOnce(firstChain({ status: 'confirmed', scheduled_date: '2099-01-01', window_start: '13:00:00' }));
    const windowMoved = await recheckDeferredReplay('appointment_notice_contact_deferred', {
      scheduled_service_id: 'ss-1',
      slot_scheduled_date: '2099-01-01',
      slot_window_start: '09:00',
    });
    expect(windowMoved.eligible).toBe(false);
    expect(windowMoved.reason).toBe('slot-moved');

    // Matching slot proceeds to the contact-slot check; rows without a
    // snapshot (legacy) keep the status-only behavior.
    db.mockReturnValueOnce(firstChain({ status: 'confirmed', scheduled_date: '2099-01-01', window_start: '09:00:00' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '941-555-7777' }]);
    const stillGood = await recheckDeferredReplay('appointment_notice_contact_deferred', {
      scheduled_service_id: 'ss-1',
      customer_id: 'cust-1',
      to_phone: '+19415557777',
      slot_scheduled_date: '2099-01-01',
      slot_window_start: '09:00',
    });
    expect(stillGood.eligible).toBe(true);
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
    mockFilterRecipientsByOptin.mockResolvedValueOnce([{ phone: '941-555-7777' }]);
    const present = await recheckDeferredReplay('appointment_notice_contact_deferred', meta);
    expect(present.eligible).toBe(true);

    db.mockReturnValueOnce(firstChain({ status: 'scheduled', scheduled_date: '2099-01-01' }));
    db.mockReturnValueOnce(firstChain({ id: 'cust-1' }));
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

// Collections policy + ledger reservation on the invoice-followup replay
// (codex 2026-08-14 P1 ×2): the quiet-hours-held SMS re-proves the policy at
// ACTUAL delivery time, and the delivery-time ledger row is RESERVED before
// dispatch (idempotency-keyed — retries reuse it), then stamped delivered.
describe('invoice_followup_deferred × collections policy', () => {
  const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
  const ContactLedger = require('../services/collections/contact-ledger');
  const COLLECTIBLE = { id: 'inv-1', status: 'sent', payer_id: null, total: 100, credit_applied: 0 };
  const KEYED = {
    invoice_id: 'inv-1', customer_id: 'cust-1',
    ledger_reservation_key: 'rk-1', followup_sequence_id: 'seq-1',
  };

  beforeEach(() => { jest.clearAllMocks(); });
  afterEach(() => { delete process.env.GATE_COLLECTIONS_POLICY; });

  // KEYED metas carry followup_sequence_id, so collectibility does a SECOND
  // read (invoice_followup_sequences) — queue both chains.
  function armKeyedReads() {
    db.mockReturnValueOnce(firstChain(COLLECTIBLE));
    db.mockReturnValueOnce(firstChain({ status: 'active' }));
  }

  test('gate off + legacy keyless row: no consult, no resolution, no reservation — byte-identical', async () => {
    db.mockReturnValueOnce(firstChain(COLLECTIBLE));
    const result = await recheckDeferredReplay('invoice_followup_deferred', { invoice_id: 'inv-1' });
    expect(result.eligible).toBe(true);
    expect(collectionsChannelPermitted).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  });

  test('keyed row RESERVES its delivery-time ledger row before dispatch, gate-independent (always-on ledger)', async () => {
    armKeyedReads();
    const result = await recheckDeferredReplay('invoice_followup_deferred', KEYED);
    expect(result.eligible).toBe(true);
    expect(collectionsChannelPermitted).not.toHaveBeenCalled(); // gate off
    expect(ContactLedger.recordContact).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', channel: 'sms', purpose: 'late_payment',
      invoiceIds: ['inv-1'], source: 'invoice_followup_replay',
      idempotencyKey: 'followup-replay:rk-1',
      metadata: expect.objectContaining({ replay: true, followup_sequence_id: 'seq-1' }),
    }));
  });

  test('gate on + policy denial suppresses the replay of a still-collectible invoice, nothing reserved', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    collectionsChannelPermitted.mockResolvedValueOnce(false);
    armKeyedReads();
    const result = await recheckDeferredReplay('invoice_followup_deferred', KEYED);
    expect(result).toEqual({ eligible: false, reason: 'collections-policy-denied' });
    expect(collectionsChannelPermitted).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', invoiceId: 'inv-1', channel: 'sms', purpose: 'late_payment',
    }));
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  });

  test('gate on + legacy row without customer_id resolves the customer from the invoice', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    collectionsChannelPermitted.mockResolvedValueOnce(true);
    db.mockReturnValueOnce(firstChain(COLLECTIBLE));            // collectibility read
    db.mockReturnValueOnce(firstChain({ customer_id: 'cust-9' })); // customer resolution
    const result = await recheckDeferredReplay('invoice_followup_deferred', { invoice_id: 'inv-1' });
    expect(result.eligible).toBe(true);
    expect(collectionsChannelPermitted).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-9' }));
  });

  test('a reservation failure HOLDS the replay — no unledgered contact, ever', async () => {
    armKeyedReads();
    ContactLedger.recordContact.mockRejectedValueOnce(new Error('ledger down'));
    const result = await recheckDeferredReplay('invoice_followup_deferred', KEYED);
    expect(result).toEqual({ eligible: false, reason: 'recheck-failed', retryable: true });
  });

  test('gate on + customer resolution failure holds the row (fail closed, never send unverified)', async () => {
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    db.mockReturnValueOnce(firstChain(COLLECTIBLE));
    db.mockReturnValueOnce(throwChain());
    const result = await recheckDeferredReplay('invoice_followup_deferred', { invoice_id: 'inv-1' });
    expect(result).toEqual({ eligible: false, reason: 'recheck-failed', retryable: true });
  });

  test('finalize stamps the keyed reservation delivered; legacy keyless rows record at delivery; entry is durable', async () => {
    await finalizeDeferredReplay('invoice_followup_deferred', KEYED);
    expect(ContactLedger.markDelivered).toHaveBeenCalledWith('followup-replay:rk-1');
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();

    jest.clearAllMocks();
    await finalizeDeferredReplay('invoice_followup_deferred', {
      invoice_id: 'inv-1', customer_id: 'cust-1', followup_sequence_id: 'seq-1',
    });
    expect(ContactLedger.recordContact).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', source: 'invoice_followup_replay',
      metadata: expect.objectContaining({ replay: true }),
    }));
    expect(requiresDurableFinalize('invoice_followup_deferred')).toBe(true);
  });
});

describe('recruiting_comms_deferred (PR #4623)', () => {
  const { recheckDeferredReplay, finalizeDeferredReplay, onTerminalDeferredReplay } = require('../services/messaging/deferred-replay-registry');
  const db = require('../models/db');
  const gates = require('../config/feature-gates');
  const meta = { job_application_id: 'app-1', stage: 'interview_invite', interview_token: 'a'.repeat(64), interview_at: null, ledger_entry_id: 'e-1' };
  const ENTRY = 'recruiting_comms_deferred';

  function rowChain(row) {
    const q = { where: jest.fn(() => q), first: jest.fn(async () => row) };
    return q;
  }

  test('gate off -> ineligible (kill switch honored on replay)', async () => {
    const spy = jest.spyOn(gates, 'isEnabled').mockImplementation(() => false);
    expect(await recheckDeferredReplay(ENTRY, meta)).toMatchObject({ eligible: false, reason: 'recruiting-gate-off' });
    spy.mockRestore();
  });

  test('withdrawn application / changed token / rebooked time -> ineligible; matching state -> eligible', async () => {
    const spy = jest.spyOn(gates, 'isEnabled').mockImplementation(() => true);
    const recSpy = jest.spyOn(require('../services/recruiting-comms'), 'reconcileCommsHistoryEntryByOutcome').mockResolvedValue(undefined);
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'withdrawn', interview_token: 'a'.repeat(64) }));
    expect(await recheckDeferredReplay(ENTRY, meta)).toMatchObject({ eligible: false, reason: 'application-withdrawn' });
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'interview', interview_token: 'b'.repeat(64) }));
    expect(await recheckDeferredReplay(ENTRY, meta)).toMatchObject({ eligible: false, reason: 'interview-token-changed' });
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'interview', interview_token: 'a'.repeat(64), interview_at: '2027-03-16T20:00:00.000Z' }));
    expect(await recheckDeferredReplay(ENTRY, { ...meta, stage: 'interview_confirmation', interview_at: '2027-03-16T21:00:00.000Z' })).toMatchObject({ eligible: false, reason: 'interview-rebooked' });
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'interview', interview_token: 'a'.repeat(64), interview_at: '2027-03-16T20:00:00.000Z', interview_mode: 'in_person' }));
    expect(await recheckDeferredReplay(ENTRY, { ...meta, stage: 'interview_confirmation', interview_at: '2027-03-16T20:00:00.000Z', interview_mode: 'phone' })).toMatchObject({ eligible: false, reason: 'interview-mode-changed' });
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'interview', interview_token: 'a'.repeat(64), interview_at: '2027-03-16T20:00:00.000Z', interview_mode: 'phone' }));
    expect(await recheckDeferredReplay(ENTRY, { ...meta, stage: 'interview_confirmation', interview_at: '2027-03-16T20:00:00.000Z', interview_mode: 'phone' })).toMatchObject({ eligible: true });
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'reviewed', interview_token: null }));
    expect(await recheckDeferredReplay(ENTRY, { ...meta, stage: 'application_received', interview_token: null })).toMatchObject({ eligible: true });
    // Append position is the total order (Codex r23 P2): a resend appended in
    // the SAME millisecond as the claimed entry still supersedes it.
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'interview', interview_token: 'a'.repeat(64), comms_history: [
      { id: meta.ledger_entry_id, at: '2027-03-16T02:00:00.000Z', stage: 'interview_invite', channel: 'sms', outcome: 'deferred' },
      { id: 'resend', at: '2027-03-16T02:00:00.000Z', stage: 'interview_invite', channel: 'sms', outcome: 'pending' },
    ] }));
    expect(await recheckDeferredReplay(ENTRY, meta)).toMatchObject({ eligible: false, reason: 'superseded-by-newer-attempt' });
    // A queued invite is moot once the applicant booked (Codex r24 P2), or
    // once a confirmation is already live after it.
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'interview', interview_token: 'a'.repeat(64), interview_booked_at: '2027-03-16T03:00:00.000Z', comms_history: [] }));
    expect(await recheckDeferredReplay(ENTRY, meta)).toMatchObject({ eligible: false, reason: 'interview-already-booked' });
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'interview', interview_token: 'a'.repeat(64), comms_history: [
      { id: meta.ledger_entry_id, at: '2027-03-16T02:00:00.000Z', stage: 'interview_invite', channel: 'sms', outcome: 'deferred' },
      { id: 'conf', at: '2027-03-16T03:00:00.000Z', stage: 'interview_confirmation', channel: 'sms', outcome: 'deferred' },
    ] }));
    expect(await recheckDeferredReplay(ENTRY, meta)).toMatchObject({ eligible: false, reason: 'superseded-by-confirmation' });
    // A queued receipt yields once the owner moved on (Codex r17 P2): the
    // application advanced past review, or a later-stage / owner text is live.
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'interview', interview_token: 'a'.repeat(64) }));
    expect(await recheckDeferredReplay(ENTRY, { ...meta, stage: 'application_received', interview_token: null })).toMatchObject({ eligible: false, reason: 'application-advanced-interview' });
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'new', interview_token: null, comms_history: [
      { id: meta.ledger_entry_id, at: '2027-03-16T02:00:00.000Z', stage: 'application_received', channel: 'sms', outcome: 'deferred' },
      { id: 'owner-1', at: '2027-03-16T03:00:00.000Z', stage: 'owner_reply', channel: 'sms', outcome: 'sent' },
    ] }));
    expect(await recheckDeferredReplay(ENTRY, { ...meta, stage: 'application_received', interview_token: null })).toMatchObject({ eligible: false, reason: 'superseded-by-later-stage' });
    recSpy.mockRestore();
    spy.mockRestore();
  });

  test('the locked handoff refuses (no provider call) when the application went stale between claim and provider', async () => {
    const gatesSpy = jest.spyOn(gates, 'isEnabled').mockImplementation(() => true);
    const { deferredSmsHandoff } = require('../services/messaging/deferred-replay-registry');
    const handoff = deferredSmsHandoff(ENTRY, meta);
    const lockChain = rowChain({ id: 'app-1', status: 'withdrawn', interview_token: 'a'.repeat(64) });
    lockChain.forUpdate = jest.fn(() => lockChain);
    db.transaction = jest.fn(async (fn) => fn(jest.fn(() => lockChain)));
    const dispatch = jest.fn(async () => ({ sent: true }));
    await expect(handoff(dispatch)).resolves.toMatchObject({ sent: false, blocked: true, code: 'RECRUITING_STALE_AT_HANDOFF' });
    expect(dispatch).not.toHaveBeenCalled();
    gatesSpy.mockRestore();
  });

  test('a newer attempt of the same stage in the ledger supersedes this queued invite (even if already claimed)', async () => {
    const spy = jest.spyOn(gates, 'isEnabled').mockImplementation(() => true);
    const history = [
      { id: 'e-1', channel: 'sms', stage: 'interview_invite', outcome: 'deferred', at: '2027-03-16T03:00:00.000Z' },
      { id: 'e-2', channel: 'sms', stage: 'interview_invite', outcome: 'sent', at: '2027-03-16T14:00:00.000Z' },
    ];
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'interview', interview_token: 'a'.repeat(64), comms_history: history }));
    expect(await recheckDeferredReplay(ENTRY, meta)).toMatchObject({ eligible: false, reason: 'superseded-by-newer-attempt' });
    spy.mockRestore();
  });

  test('a database error fails CLOSED', async () => {
    const spy = jest.spyOn(gates, 'isEnabled').mockImplementation(() => true);
    db.mockReturnValueOnce({ where: () => { throw Object.assign(new Error('boom'), { code: '57014' }); } });
    expect(await recheckDeferredReplay(ENTRY, meta)).toMatchObject({ eligible: false });
    spy.mockRestore();
  });

  test('recheck never stamps; the locked smsHandoff stamps deferred -> handoff immediately before dispatch', async () => {
    const gatesSpy = jest.spyOn(gates, 'isEnabled').mockImplementation(() => true);
    const comms = require('../services/recruiting-comms');
    const spy = jest.spyOn(comms, 'reconcileCommsHistoryEntryByOutcome').mockResolvedValue(undefined);
    db.mockReturnValueOnce(rowChain({ id: 'app-1', status: 'reviewed', interview_token: null }));
    expect(await recheckDeferredReplay(ENTRY, { ...meta, stage: 'application_received', interview_token: null })).toMatchObject({ eligible: true });
    expect(spy).not.toHaveBeenCalled();
    const { deferredSmsHandoff } = require('../services/messaging/deferred-replay-registry');
    const handoff = deferredSmsHandoff(ENTRY, meta);
    // the handoff runs in a transaction that holds the application row FOR UPDATE through dispatch
    const lockChain = rowChain({ id: 'app-1', status: 'interview', interview_token: 'a'.repeat(64), comms_history: [], contact_snapshot: { phone: '9415550142' } });
    const order = [];
    lockChain.forUpdate = jest.fn(() => { order.push('row-lock'); return lockChain; });
    const trx = jest.fn(() => lockChain);
    // the shared SMS phone lock is taken BEFORE the application row (Codex r30 P1)
    trx.raw = jest.fn(async (sql, bindings) => { if (/pg_advisory_xact_lock/.test(sql) && /twilio_21610/.test(sql)) order.push(`phone-lock:${bindings[0]}`); });
    db.transaction = jest.fn(async (fn) => fn(trx));
    spy.mockImplementation(async () => { order.push('stamp'); });
    const dispatch = jest.fn(async () => { order.push('dispatch'); return { sent: true }; });
    await expect(handoff(dispatch)).resolves.toEqual({ sent: true });
    expect(lockChain.forUpdate).toHaveBeenCalled();
    expect(order.slice(0, 2)).toEqual(['phone-lock:+19415550142', 'row-lock']);
    expect(dispatch).toHaveBeenCalledWith(trx);
    expect(spy).toHaveBeenCalledWith('app-1', 'e-1', { deferred: expect.objectContaining({ outcome: 'handoff' }) }, expect.anything());
    expect(order.slice(2)).toEqual(['stamp', 'dispatch']);
    spy.mockRestore(); gatesSpy.mockRestore();
  });

  test('finalize -> sent; terminal never downgrades: deferred -> blocked, handoff (attempted, ambiguous) -> uncertain', async () => {
    const comms = require('../services/recruiting-comms');
    const fin = jest.spyOn(comms, 'finalizeCommsHistoryEntry').mockResolvedValue(undefined);
    const rec = jest.spyOn(comms, 'reconcileCommsHistoryEntryByOutcome').mockResolvedValue(undefined);
    await finalizeDeferredReplay(ENTRY, meta);
    expect(fin).toHaveBeenCalledWith('app-1', 'e-1', expect.objectContaining({ outcome: 'sent', sent_by: 'scheduled_sms_cron' }));
    await onTerminalDeferredReplay(ENTRY, meta);
    expect(rec).toHaveBeenCalledWith('app-1', 'e-1', {
      deferred: expect.objectContaining({ outcome: 'blocked', code: 'deferred_terminal' }),
      handoff: expect.objectContaining({ outcome: 'uncertain', code: 'deferred_terminal_after_attempt' }),
    });
    // an entry already 'sent' or 'uncertain' has no transition — evidence retained
    const terminalCall = rec.mock.calls.find((c) => c[2] && c[2].handoff);
    expect(Object.keys(terminalCall[2])).toEqual(['deferred', 'handoff']);
    fin.mockRestore(); rec.mockRestore();
  });
});
