/**
 * Deferred-replay registry — the single home for what happens around a
 * quiet-hours-deferred SMS when the scheduled-SMS executor replays it.
 *
 * Every send path that requeues a held text (QUIET_HOURS_HOLD →
 * sms_log status 'scheduled') registers its entry_point here with up to
 * three hooks, and the executor consults the registry generically:
 *
 *   recheck(claimMeta)   — BEFORE dispatch: is this message still valid?
 *                          The world moves overnight — estimates get
 *                          accepted, invoices paid, visits cancelled, leads
 *                          advance — and replaying a stale message texts a
 *                          customer about a state that no longer exists.
 *                          Returns { eligible:false, reason } to suppress,
 *                          { eligible:false, retryable:true } to hold for a
 *                          bounded re-check (used when the state READ
 *                          failed — fail closed, never send unverified),
 *                          or { eligible:true }.
 *   finalize(claimMeta, ctx) — AFTER the provider accepts: the state
 *                          transitions the immediate path would have run
 *                          inline (invoice draft→sent, review delivered
 *                          mark, lead contacted stamp, claim settlement).
 *                          Idempotent by contract — entries listed in
 *                          DURABLE_FINALIZE_ENTRY_POINTS get the
 *                          finalize_pending stamp + finalize_only bounded
 *                          retry rail, so a crash between settlement and
 *                          finalization is always recovered.
 *   onTerminal(claimMeta) — when the replay is terminally blocked: undo or
 *                          hand off the obligation (release a once-ever
 *                          claim, arm a fallback sender, flip a status back
 *                          into an admin retry lane).
 *
 * Adding a new deferral site = one registry entry; the executor needs no
 * new branches. Every hook is best-effort from the executor's perspective
 * (a throwing recheck is treated as retryable-ineligible; finalize
 * failures ride the durable retry rail; onTerminal failures only log).
 */

const db = require('../../models/db');
const logger = require('../logger');

// Sequence-ending states a customer REPLY produces — 'completed' is the
// final step's own natural advance (it marks completed right after queueing
// its held SMS) and must NOT suppress that queued final message.
const CANCELLATION_REPLY_END_STATES = new Set(['converted', 'escalated', 'cancelled', 'stopped']);

const CONTRACT_TERMINAL_STATUSES = new Set(['signed', 'cancelled', 'voided', 'expired']);

const failClosed = (label, id, err) => {
  logger.warn(`[deferred-replay] ${label} recheck failed for ${id} (holding for retry): ${err.message}`);
  return { eligible: false, reason: 'recheck-failed', retryable: true };
};

const REGISTRY = {
  estimate_follow_up_deferred: {
    async recheck(meta) {
      if (!meta.estimate_id) return { eligible: true };
      const { deferredFollowupStillEligible } = require('../estimate-follow-up');
      return deferredFollowupStillEligible(meta.estimate_id);
    },
  },

  estimate_extension_deferred: {
    async recheck(meta) {
      // The refreshed-link text is moot once the estimate goes terminal
      // overnight (accepted/declined/expired/converted) — the same
      // safetyGate the follow-up engine uses.
      if (!meta.estimate_id) return { eligible: true };
      const { deferredFollowupStillEligible } = require('../estimate-follow-up');
      return deferredFollowupStillEligible(meta.estimate_id);
    },
  },

  invoice_send_deferred: {
    async recheck(meta) {
      return invoiceStillCollectible(meta);
    },
    async finalize(meta) {
      const { finalizeDeferredCompletionSend } = require('../dispatch-completion-deferred');
      return finalizeDeferredCompletionSend(meta);
    },
    durableFinalize: true,
  },

  invoice_followup_deferred: {
    async recheck(meta) {
      return invoiceStillCollectible(meta);
    },
  },

  dispatch_completion_deferred: {
    async finalize(meta, ctx = {}) {
      const { finalizeDeferredCompletionSend } = require('../dispatch-completion-deferred');
      return finalizeDeferredCompletionSend(meta, { retry: ctx.retry === true });
    },
    async onTerminal(meta) {
      // Reset the record's 'deferred' status to 'failed' FIRST — the
      // completion dedupe treats 'deferred' as an owned obligation, so a
      // dead replay must hand the send back to the next completion attempt
      // (same restore the decline-notice entry runs). A transient restore
      // failure is captured (not swallowed) and rethrown AFTER the review
      // fallback arms: a hook that reported success on a failed restore
      // would clear terminal_pending and strand the record at 'deferred'
      // forever — the bounded terminal sweep must retry the restore.
      const { terminalDeferredCompletionSend } = require('../dispatch-completion-deferred');
      let restoreErr = null;
      try {
        await terminalDeferredCompletionSend(meta);
      } catch (err) {
        restoreErr = err;
        logger.warn(`[deferred-replay] completion terminal status restore failed for record ${meta.service_record_id || 'unknown'} — will retry via terminal sweep: ${err.message}`);
      }
      // The completion text (and the bundled review link inside it) will
      // never deliver — arm the standalone review sender. Armed ONLY here,
      // never on a timer, so it can't race a still-retryable replay.
      // Idempotent, so a restore-retry re-run re-arms harmlessly.
      if (meta.bundled_review_request_id) {
        const ReviewService = require('../review-request');
        await ReviewService.markInlineRetryable(
          meta.bundled_review_request_id,
          new Date(Date.now() + 5 * 60 * 1000),
        );
        logger.info(`[deferred-replay] completion terminally blocked — standalone review fallback armed for ${meta.bundled_review_request_id}`);
      }
      if (restoreErr) throw restoreErr;
    },
    durableFinalize: true,
  },

  autopay_completion_decline_deferred: {
    async recheck(meta) {
      // The decline notice carries an amount + pay link for a SPECIFIC
      // failed charge — suppress once the invoice went terminal overnight
      // (customer paid through another rail, admin voided) or moved onto a
      // third-party payer (the AP contact owns collection, and billing
      // texts must never reach the homeowner on payer-billed invoices).
      try {
        if (!meta.invoice_id) return { eligible: true };
        const { isTerminalInvoice } = require('../invoice-followups');
        const inv = await db('invoices').where({ id: meta.invoice_id }).first();
        if (!inv) return { eligible: false, reason: 'invoice-missing' };
        if (isTerminalInvoice(inv)) return { eligible: false, reason: `invoice-terminal:${inv.status}` };
        if (inv.payer_id) return { eligible: false, reason: 'payer-billed' };
        return { eligible: true };
      } catch (err) {
        return failClosed('decline-notice', meta.invoice_id, err);
      }
    },
    async finalize(meta) {
      const { finalizeDeferredDeclineNotice } = require('../dispatch-completion-deferred');
      return finalizeDeferredDeclineNotice(meta);
    },
    async onTerminal(meta) {
      const { terminalDeferredDeclineNotice } = require('../dispatch-completion-deferred');
      await terminalDeferredDeclineNotice(meta);
    },
    durableFinalize: true,
  },

  lead_webhook_auto_reply_deferred: {
    async recheck(meta) {
      // The intake menu opens the state machine; if the lead independently
      // texted in overnight, the inbound handler already advanced
      // lead_intake_status past 'awaiting_service' — replaying the opening
      // question would restart a live conversation with stale instructions.
      try {
        const customerId = meta.customer_id;
        if (!customerId) return { eligible: true };
        const customer = await db('customers').where({ id: customerId }).first('lead_intake_status');
        if (!customer) return { eligible: false, reason: 'customer-missing' };
        if (customer.lead_intake_status && customer.lead_intake_status !== 'awaiting_service') {
          return { eligible: false, reason: `intake-advanced:${customer.lead_intake_status}` };
        }
        return { eligible: true };
      } catch (err) {
        return failClosed('lead-menu', meta.customer_id, err);
      }
    },
    async finalize(meta, ctx = {}) {
      // Settle the once-ever claim: a real provider sid stamps it (this
      // phone got its one menu); anything else releases the null-sid claim
      // so a later form submission re-arms.
      if (!meta.lead_auto_reply_phone_digits) return { ok: true };
      const sid = String(ctx.providerMessageId || '');
      if (/^(SM|MM)/.test(sid)) {
        await db('lead_auto_reply_sends')
          .where({ phone_digits: meta.lead_auto_reply_phone_digits })
          .whereNull('twilio_sid')
          .update({ twilio_sid: sid });
      } else {
        await db('lead_auto_reply_sends')
          .where({ phone_digits: meta.lead_auto_reply_phone_digits })
          .whereNull('twilio_sid')
          .del();
      }
      return { ok: true };
    },
    async onTerminal(meta) {
      // Release the once-ever claim so this phone's NEXT form submission
      // can re-arm — a null-sid claim would suppress the menu forever.
      if (!meta.lead_auto_reply_phone_digits) return;
      await db('lead_auto_reply_sends')
        .where({ phone_digits: meta.lead_auto_reply_phone_digits })
        .whereNull('twilio_sid')
        .del();
      // A suppressed skip (recheck) also lands here via the executor's
      // blocked write — same release semantics.
    },
    // The claim stamp/release is idempotent (whereNull twilio_sid guards) —
    // durable so a DB blip after Twilio's accept can't strand a null-SID
    // claim that suppresses every future menu for this phone.
    durableFinalize: true,
  },

  lead_response_auto_reply_deferred: {
    async recheck(meta) {
      // Mirror the immediate path's liveness gate — and suppress once the
      // lead ADVANCED overnight: an operator contact or a pipeline move
      // past the pre-contact states makes the queued opening auto-reply
      // redundant (and its finalizer's response-time stamp would record a
      // phantom first-contact).
      try {
        if (!meta.lead_id) return { eligible: true };
        const lead = await db('leads').where({ id: meta.lead_id }).whereNull('deleted_at').first('id', 'status');
        if (!lead) return { eligible: false, reason: 'lead-deleted' };
        const status = String(lead.status || '').toLowerCase();
        if (status && !['new', 'pending', 'started'].includes(status)) {
          return { eligible: false, reason: `lead-${status}` };
        }
        return { eligible: true };
      } catch (err) {
        return failClosed('lead-response', meta.lead_id, err);
      }
    },
    async finalize(meta, ctx = {}) {
      const { recordLeadAutoReplyDelivered } = require('../lead-response-tools');
      await recordLeadAutoReplyDelivered({
        leadId: meta.lead_id || null,
        customerId: ctx.customerId || null,
      });
      return { ok: true };
    },
    durableFinalize: true,
  },

  recipient_optin_deferred: {
    async recheck(meta) {
      // The ask is only valid while (a) the recipient row is still pending
      // — another save may have re-asked, or the recipient confirmed/
      // declined overnight — AND (b) the phone still occupies one of the
      // customer's live contact slots: the enqueue stamped dispatched_at,
      // which removes the row from the undispatched recovery sweep, so a
      // removed/replaced contact would otherwise still be texted the ask.
      try {
        if (!meta.optin_phone_key) return { eligible: true };
        const row = await db('recipient_optin')
          .where({ phone_key: meta.optin_phone_key, customer_id: meta.optin_customer_id || null })
          .first('status');
        if (!row) return { eligible: false, reason: 'optin-row-missing' };
        if (String(row.status) !== 'pending') return { eligible: false, reason: `optin-${row.status}` };
        if (meta.optin_customer_id) {
          const customer = await db('customers').where({ id: meta.optin_customer_id }).first();
          if (!customer) return { eligible: false, reason: 'customer-missing' };
          const { getAppointmentContacts } = require('../customer-contact');
          const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
          const stillPresent = getAppointmentContacts(customer, {}, { skipConsentGate: true })
            .some((c) => digits(c.phone) === String(meta.optin_phone_key));
          if (!stillPresent) return { eligible: false, reason: 'contact-removed' };
        }
        return { eligible: true };
      } catch (err) {
        return failClosed('recipient-optin', meta.optin_phone_key, err);
      }
    },
    async onTerminal(meta) {
      // A suppressed/terminally-blocked ask means this recipient was never
      // asked — release the pending row to ask_failed so a future contact
      // save re-claims it instead of it blocking texts forever.
      if (!meta.optin_phone_key) return;
      await db('recipient_optin')
        .where({ phone_key: meta.optin_phone_key, customer_id: meta.optin_customer_id || null, status: 'pending' })
        .update({ status: 'ask_failed', updated_at: new Date() });
    },
  },

  stripe_webhook_billing_deferred: {
    async recheck(meta) {
      // An ACH failure / action-required notice queued at night can resolve
      // before 8:00 AM (the customer retried and the success webhook
      // updated the invoice) — a frozen failure message must not follow a
      // successful payment. Suppress when the linked invoice went terminal
      // (paid/prepaid/void). Setup-verification failure notices carry no
      // invoice, so their staleness signal is the customer's CURRENT bank
      // state: setup_intent.succeeded flips the saved method's ach_status
      // to 'verified' (and removed methods are hard-deleted), so any
      // verified bank row means the customer fixed it overnight and
      // "bank verification failed" would contradict the portal. Other
      // no-invoice notices stay eligible — their copy directs to the
      // billing page, which always shows current state.
      try {
        let invoiceId = meta.invoice_id || null;
        if (!invoiceId && meta.stripe_payment_intent_id) {
          const inv = await db('invoices')
            .where({ stripe_payment_intent_id: meta.stripe_payment_intent_id })
            .first('id');
          invoiceId = inv?.id || null;
        }
        // ACH processing acknowledgment: 'processing' is this notice's LIVE
        // state, but it sits in the shared terminal list — the generic
        // collectibility check below would suppress EVERY replay while the
        // consumed one-shot claim blocks any other attempt. Eligible
        // exactly while the invoice still processes THIS payment intent;
        // any other state (cleared, failed-and-reset, superseded PI) has
        // its own notice and makes this one stale.
        if (invoiceId && meta.original_message_type === 'ach_payment_processing') {
          const inv = await db('invoices')
            .where({ id: invoiceId })
            .first('status', 'stripe_payment_intent_id');
          if (!inv) return { eligible: false, reason: 'invoice-missing' };
          if (String(inv.status) !== 'processing') return { eligible: false, reason: `invoice-${inv.status}` };
          if (meta.stripe_payment_intent_id && inv.stripe_payment_intent_id !== meta.stripe_payment_intent_id) {
            return { eligible: false, reason: 'pi-superseded' };
          }
          return { eligible: true };
        }
        if (!invoiceId) {
          // A notice that CARRIED a PaymentIntent but resolves to no
          // invoice is a superseded association, not an invoice-less
          // notice (codex r21): the replacement-tender flow repoints the
          // invoice onto a new PI and may have PAID it overnight, and
          // this row's whole premise is that invoice's state. Enqueue now
          // persists invoice_id, so this is the legacy/lookup-race path —
          // fail CLOSED rather than text a frozen failure notice over a
          // settled invoice. ('ach_payment_processing' returned above;
          // customer-level notices that never carried a PI are unaffected.)
          if (meta.stripe_payment_intent_id) {
            return { eligible: false, reason: 'pi-association-superseded' };
          }
          if (meta.original_message_type === 'bank_verification_failed' && meta.waves_customer_id) {
            const verified = await db('payment_methods')
              .where({ customer_id: meta.waves_customer_id })
              .whereIn('method_type', ['ach', 'us_bank_account'])
              .where({ ach_status: 'verified' })
              .first('id');
            if (verified) return { eligible: false, reason: 'bank-method-verified' };
          }
          return { eligible: true };
        }
        return invoiceStillCollectible({ invoice_id: invoiceId });
      } catch (err) {
        return failClosed('stripe-billing', meta.stripe_payment_intent_id || meta.invoice_id, err);
      }
    },
  },

  voicemail_lead_sms_deferred: {
    async recheck(meta) {
      // The quote link is a speed play for a fresh voicemail — a lead
      // deleted, converted, or already contacted overnight makes the 8 AM
      // bearer link stale (and possibly wrong-audience).
      try {
        if (!meta.lead_id) return { eligible: true };
        const lead = await db('leads').where({ id: meta.lead_id }).whereNull('deleted_at').first('id', 'status');
        if (!lead) return { eligible: false, reason: 'lead-deleted' };
        const status = String(lead.status || '').toLowerCase();
        if (status && !['new', 'pending', 'started'].includes(status)) {
          return { eligible: false, reason: `lead-${status}` };
        }
        return { eligible: true };
      } catch (err) {
        return failClosed('voicemail-text-back', meta.lead_id, err);
      }
    },
    async finalize(meta) {
      // Claim settlement (lead stamp 'sent' + phone-claim outcome 'sent') —
      // the helpers swallow their own DB errors by design for the inline
      // path, so check their returned success and report ok:false to ride
      // the durable finalize_only rail: a crash or transient DB failure
      // here must not strand the claims as 'scheduled' after delivery
      // (a stale 'scheduled' lead stamp also blocks the atomic re-claim
      // and misroutes the bounce handler's claimed-lead correlation).
      const { _deferredClaims } = require('../voicemail-lead-sms');
      let ok = true;
      if (meta.lead_id) {
        ok = (await _deferredClaims.stampStatus(meta.lead_id, 'sent')) && ok;
      }
      if (meta.voicemail_phone) {
        ok = (await _deferredClaims.stampPhoneClaim(meta.voicemail_phone, 'sent')) && ok;
      }
      return { ok };
    },
    durableFinalize: true,
    async onTerminal(meta) {
      // The text-back provably never delivered — release BOTH one-shot
      // claims so a repeat caller (or the suppressed-replay path) can
      // re-arm instead of the phone staying consumed with no text sent.
      // The helpers swallow their own DB errors and return false — a
      // failed release reported as success would clear terminal_pending
      // with the lead/phone permanently marked consumed, so either false
      // fails the hook onto the bounded terminal sweep (releases are
      // idempotent deletes/clears; re-running is harmless).
      const { _deferredClaims } = require('../voicemail-lead-sms');
      let ok = true;
      if (meta.lead_id) ok = (await _deferredClaims.clearLeadClaim(meta.lead_id)) && ok;
      if (meta.voicemail_phone) ok = (await _deferredClaims.releasePhoneClaim(meta.voicemail_phone)) && ok;
      if (!ok) throw new Error(`voicemail claim release incomplete for lead ${meta.lead_id || 'unknown'} — retrying via terminal sweep`);
      logger.info(`[deferred-replay] voicemail text-back for lead ${meta.lead_id || 'unknown'} terminally blocked — claims released`);
    },
  },

  customer_service_request_deferred: {
    async onTerminal(meta) {
      // Only the CANCELLATION confirmation needs a terminal fallback: the
      // route deactivated the account before queueing this text, so the
      // customer can neither receive the replay (it terminally died) nor
      // open the portal to see the request — without this hook they get no
      // confirmation at all. Ordinary request confirmations already sent
      // the "request received" email inline, and an active customer can
      // see the request in the portal.
      if (meta.is_cancellation !== true || !meta.service_request_id) return;
      const request = await db('service_requests').where({ id: meta.service_request_id }).first();
      if (!request) {
        logger.warn(`[deferred-replay] cancellation confirmation fallback skipped — service request ${meta.service_request_id} missing`);
        return;
      }
      const AccountMembershipEmail = require('../account-membership-email');
      // Idempotent by its own key (account.cancellation_received:<request id>),
      // so a double-fired terminal hook can't double-email. The sender
      // reports transient provider/template failures as {ok:false} rather
      // than throwing — treat those as hook failure so the bounded terminal
      // sweep retries (else the deactivated customer gets neither channel
      // and no retry obligation). Deterministic skips ({skipped:true}: no
      // email on file, customer missing) settle — retrying cannot fix them.
      const emailRes = await AccountMembershipEmail.sendCancellationReceived({
        customerId: meta.waves_customer_id || request.customer_id,
        request,
      });
      if (emailRes?.ok === false && emailRes?.skipped !== true) {
        throw new Error(`cancellation confirmation fallback email failed for request ${request.id}: ${emailRes?.error || 'unknown'}`);
      }
      if (emailRes?.skipped === true) {
        logger.warn(`[deferred-replay] cancellation confirmation for request ${request.id} terminally blocked — email fallback skipped (${emailRes.reason || 'unknown'}); no reachable channel`);
      } else {
        logger.info(`[deferred-replay] cancellation confirmation for request ${request.id} terminally blocked — cancellation-safe email fallback sent`);
      }
    },
  },

  appointment_card_request_deferred: {
    async recheck(meta) {
      // A bearer card link must not replay if the card was captured, a
      // newer claim took over texting, or the visit died overnight.
      try {
        if (!meta.scheduled_service_id) return { eligible: true };
        const svc = await db('scheduled_services')
          .where({ id: meta.scheduled_service_id })
          .first('status', 'card_link_sent_at', 'customer_id');
        if (!svc) return { eligible: false, reason: 'visit-missing' };
        const status = String(svc.status || '').toLowerCase();
        // The canonical request path's OWN live-status test: anything
        // outside LIVE_VISIT_STATUSES (notably 'rescheduled', the
        // pending-rebook placeholder that keeps the obsolete date/window)
        // must not replay — a send against it would carry the stale date
        // AND consume the one-text claim the re-slotted visit needs.
        // Suppression runs onTerminal, which releases the stamp-guarded
        // claim + owned pending row for a fresh later trigger.
        const { LIVE_VISIT_STATUSES } = require('../appointment-card-request');
        if (!LIVE_VISIT_STATUSES.includes(status)) {
          return { eligible: false, reason: `visit-${status}` };
        }
        if (meta.card_claim_stamp) {
          const stampMs = new Date(meta.card_claim_stamp).getTime();
          const currentMs = svc.card_link_sent_at ? new Date(svc.card_link_sent_at).getTime() : null;
          if (currentMs !== stampMs) return { eligible: false, reason: 'claim-superseded' };
        }
        if (meta.card_row_token) {
          const row = await db('appointment_card_requests')
            .where({ scheduled_service_id: meta.scheduled_service_id, token: meta.card_row_token })
            .first('status', 'stripe_setup_intent_id');
          if (!row) return { eligible: false, reason: 'card-row-missing' };
          if (String(row.status) !== 'pending' || row.stripe_setup_intent_id) {
            return { eligible: false, reason: 'card-captured' };
          }
        }
        // Re-run the policy exemption the immediate path enforces: a
        // third-party payer assigned (or autopay enrolled) while the row
        // sat overnight means the homeowner must not be asked for a card.
        // Same fail-closed direction as requestCardForAppointment —
        // resolveExemption exempts on payer-lookup uncertainty, and an
        // exempt verdict suppresses the replay (onTerminal releases the
        // claim, so the previsit backstop re-evaluates fresh if policy
        // changes back).
        if (svc.customer_id) {
          const { resolveExemption } = require('../appointment-card-request');
          const exemption = await resolveExemption({
            customerId: svc.customer_id,
            scheduledServiceId: meta.scheduled_service_id,
          });
          if (exemption?.exempt) return { eligible: false, reason: `exempt:${exemption.reason || 'policy'}` };
        }
        return { eligible: true };
      } catch (err) {
        return failClosed('card-request', meta.scheduled_service_id, err);
      }
    },
    async finalize(meta) {
      // The owner's both-channels rule: the replayed SMS just delivered,
      // so send the email twin now (the immediate path fires it right
      // after a confirmed SMS dispatch; the held path skipped it). Best-
      // effort by the same contract as the inline fire-and-forget — not
      // durable, and never ok:false, because an email miss must not fake
      // an undelivered SMS back onto a retry rail.
      const { sendDeferredInvitationEmailLeg } = require('../appointment-card-request');
      return sendDeferredInvitationEmailLeg(meta);
    },
    async onTerminal(meta) {
      // The link provably never delivered — release the stamp-guarded
      // one-text claim and the owned pending row so a later trigger (or
      // the previsit backstop) can retry with a fresh link.
      if (!meta.scheduled_service_id) return;
      if (meta.card_claim_stamp) {
        await db('scheduled_services')
          .where({ id: meta.scheduled_service_id, card_link_sent_at: new Date(meta.card_claim_stamp) })
          .update({ card_link_sent_at: null, updated_at: new Date() });
      }
      if (meta.card_row_token) {
        await db('appointment_card_requests')
          .where({ scheduled_service_id: meta.scheduled_service_id, status: 'pending', token: meta.card_row_token })
          .whereNull('stripe_setup_intent_id')
          .del();
      }
      logger.info(`[deferred-replay] card request for visit ${meta.scheduled_service_id} terminally blocked — claim released for retry`);
    },
  },

  estimate_accept_onetime_booking_deferred: {
    async recheck(meta) {
      // The acceptance email carried the same booking link, so the
      // customer may have booked overnight — "book your service" the next
      // morning after a live appointment exists reads broken. Suppress
      // when any non-cancelled visit already traces to this estimate.
      try {
        if (!meta.estimate_id) return { eligible: true };
        const booked = await db('scheduled_services')
          .where({ source_estimate_id: meta.estimate_id })
          .whereNotIn('status', ['cancelled', 'skipped'])
          .first('id');
        if (booked) return { eligible: false, reason: 'already-booked' };
        const est = await db('estimates').where({ id: meta.estimate_id }).first('id');
        if (!est) return { eligible: false, reason: 'estimate-missing' };
        return { eligible: true };
      } catch (err) {
        return failClosed('accept-booking', meta.estimate_id, err);
      }
    },
  },

  notification_dispatcher_deferred: {
    async recheck(meta) {
      // The dispatcher's per-type toggle, channel choice, and CUSTOMER
      // quiet hours can all change between enqueue and 8:00 AM — re-run
      // them so the replay honors exactly what the immediate dispatcher
      // would (which drops on all three without retrying).
      const { deferredNotificationStillWanted } = require('../notification-dispatcher');
      return deferredNotificationStillWanted(meta.notification_type, meta.notify_customer_id || null);
    },
  },

  public_quote_booking_sms_deferred: {
    async recheck(meta) {
      // The immediate EMAIL carried the same booking link, so the lead may
      // have booked (or been deleted) overnight — "book online" the next
      // morning after they already booked reads broken.
      try {
        if (!meta.lead_id) return { eligible: true };
        const lead = await db('leads').where({ id: meta.lead_id }).whereNull('deleted_at').first('status');
        if (!lead) return { eligible: false, reason: 'lead-missing' };
        if (['converted', 'won', 'booked'].includes(String(lead.status || '').toLowerCase())) {
          return { eligible: false, reason: `lead-${lead.status}` };
        }
        return { eligible: true };
      } catch (err) {
        return failClosed('quote-booking', meta.lead_id, err);
      }
    },
  },

  document_request_reminder_deferred: {
    async recheck(meta) {
      // A contract signed/voided/expired overnight must not be reminded.
      try {
        if (!meta.contract_id) return { eligible: true };
        const contract = await db('customer_contracts')
          .where({ id: meta.contract_id })
          .first('status', 'signed_at');
        if (!contract) return { eligible: false, reason: 'contract-missing' };
        if (contract.signed_at || CONTRACT_TERMINAL_STATUSES.has(String(contract.status || '').toLowerCase())) {
          return { eligible: false, reason: `contract-${contract.status || 'signed'}` };
        }
        return { eligible: true };
      } catch (err) {
        return failClosed('document-reminder', meta.contract_id, err);
      }
    },
  },

  cancellation_save_deferred: {
    async recheck(meta) {
      // A customer reply overnight (1 = converted, 2 = escalated,
      // CANCEL = cancelled) ends the sequence — a queued step must not
      // reopen it. 'completed' is exempt: the final step marks completed
      // right after queueing its own held SMS.
      try {
        if (!meta.sequence_id) return { eligible: true };
        const seq = await db('sms_sequences').where({ id: meta.sequence_id }).first('status');
        if (!seq) return { eligible: false, reason: 'sequence-missing' };
        if (CANCELLATION_REPLY_END_STATES.has(String(seq.status || ''))) {
          return { eligible: false, reason: `sequence-${seq.status}` };
        }
        return { eligible: true };
      } catch (err) {
        return failClosed('cancellation-save', meta.sequence_id, err);
      }
    },
  },

  // Booking-confirmation fan-out to a SECONDARY service contact whose send
  // crossed the 20:00 cutoff after the primary already delivered. The
  // queued row carries the contact's own rendered body/phone (frozen at
  // enqueue — no send-time refresh, the row belongs to the CONTACT's
  // number), so the morning replay re-runs the SAME contact resolution the
  // fan-out used: the queued phone must still occupy an authorized,
  // opted-in contact slot. A contact removed or replaced overnight would
  // otherwise receive a personalized confirmation + appointment link for a
  // household they no longer represent. The executor merges the row's
  // to_phone/customer_id into the recheck meta, so pre-fix queued rows
  // revalidate too.
  call_booking_contact_confirmation_deferred: {
    async recheck(meta) {
      const visit = await visitStillUpcoming(meta.scheduled_service_id, 'call-contact-confirmation');
      if (visit.eligible === false) return visit;
      return contactSlotStillAuthorized(meta, 'call-contact-confirmation');
    },
  },

  // A reminder/confirmation/notice fan-out that PARTIALLY delivered: an
  // earlier contact was provider-accepted before the 20:00 cutoff, a later
  // contact crossed it, and the caller finalized the notice as sent — so
  // ONLY the held recipient rides the rail (safeSendAppointment queues it).
  // Same frozen-recipient + slot-revalidation contract as the call-booking
  // secondary above; 24h reminders never reach this entry (skipped at
  // enqueue per the owner's same-day ruling).
  appointment_notice_contact_deferred: {
    async recheck(meta) {
      const visit = await visitStillUpcoming(meta.scheduled_service_id, 'notice-contact');
      if (visit.eligible === false) return visit;
      return contactSlotStillAuthorized(meta, 'notice-contact');
    },
  },

  appointment_tagger_prep_deferred: {
    async recheck(meta) {
      // Prep instructions are for an upcoming visit — a cancellation or
      // completion overnight makes them noise.
      return visitStillUpcoming(meta.scheduled_service_id, 'prep');
    },
    async onTerminal(meta) {
      // The queued prep text never delivered (stale-suppressed or
      // terminally failed) — remove the booking-time dedupe marker, or
      // hasSentPrepSms (a PERMANENT per-customer+pest guard, not
      // per-visit) suppresses prep for every later valid booking of the
      // same pest. Scoped to the held-variant body written at enqueue so
      // a marker from an actually-delivered send (inline or the manual
      // Communications sender) is never removed.
      if (!meta.waves_customer_id || !meta.pest_type) return;
      const removed = await db('customer_interactions')
        .where({
          customer_id: meta.waves_customer_id,
          interaction_type: 'sms_outbound',
          subject: `${meta.pest_type} prep info sent`,
        })
        .where('body', 'like', 'Prep SMS held outside the 8AM-8PM ET send window%')
        .del();
      if (removed) {
        logger.info(`[deferred-replay] queued ${meta.pest_type} prep for customer ${meta.waves_customer_id} terminally blocked — dedupe marker released`);
      }
    },
  },

  referral_engine_invite_deferred: {
    async onTerminal(meta) {
      // The invite provably never delivered — flip the referral into the
      // admin retry lane. GUARDED to pre-conversion statuses: the
      // recipient can sign up through a separately shared link while the
      // replay is pending, and a converted/rewarded row must never be
      // downgraded to sms_failed.
      if (!meta.referral_id) return;
      await db('referrals')
        .where({ id: meta.referral_id })
        .whereIn('status', ['pending', 'contacted'])
        .update({ status: 'sms_failed', updated_at: new Date() });
      logger.info(`[deferred-replay] referral invite ${meta.referral_id} terminally blocked — pre-conversion status flipped to sms_failed for admin retry`);
    },
  },

  referrals_legacy_invite_deferred: {
    async onTerminal(meta) {
      if (!meta.referral_id) return;
      await db('referrals')
        .where({ id: meta.referral_id })
        .whereIn('status', ['pending', 'contacted'])
        .update({ status: 'sms_failed', updated_at: new Date() });
      logger.info(`[deferred-replay] legacy referral invite ${meta.referral_id} terminally blocked — pre-conversion status flipped to sms_failed for admin retry`);
    },
  },

  referrals_v2_invite_deferred: {
    async onTerminal(meta) {
      // The invite never delivered — remove the cooldown reservation the
      // route wrote at enqueue, or a retry to the same phone reads as
      // deduped for 24 hours while the recipient was never contacted.
      // (last_share_at is left alone: other shares may own it, and it is
      // cosmetic history rather than a send gate.)
      if (!meta.promoter_id || !meta.invite_phone) return;
      try {
        await db('referral_invites')
          .where({ promoter_id: meta.promoter_id, phone: meta.invite_phone })
          .del();
      } catch (err) {
        // Only the missing-table state is ignorable (mirrors the route's
        // read fallback). A transient DB failure must THROW: the durable
        // wrapper keeps terminal_pending stamped and the sweep retries the
        // release — swallowing it would clear the hook as "done" while the
        // /invite cooldown keeps treating the undelivered invite as sent
        // for 24 hours.
        if (err.code !== '42P01') throw err;
      }
      logger.info(`[deferred-replay] v2 invite for promoter ${meta.promoter_id} terminally blocked — cooldown reservation released`);
    },
  },

  project_report_hold_release_deferred: {
    async onTerminal(meta) {
      // The queued report text provably never delivered. If the email leg
      // carried the release the record stays honest; an SMS-only release
      // must fall back onto the operator's radar — restore the hold so the
      // payment-settled sweep re-attempts inside the window.
      if (!meta.project_id || meta.email_delivered === true) return;
      await db('projects').where({ id: meta.project_id, report_hold_status: 'released' }).update({
        report_hold_status: 'held',
        report_hold_last_error: 'Deferred report SMS terminally blocked — release reverted for retry',
        updated_at: new Date(),
      });
      logger.warn(`[deferred-replay] project ${meta.project_id} report release reverted to held — deferred SMS terminally blocked with no delivered email leg`);
    },
  },
};

function entryFor(entryPoint) {
  return REGISTRY[String(entryPoint || '')] || null;
}

// Shared: a visit-anchored replay (prep instructions, booking-confirmation
// fan-out) is noise once the visit dies or passes overnight.
async function visitStillUpcoming(scheduledServiceId, label) {
  try {
    if (!scheduledServiceId) return { eligible: true };
    const svc = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('status', 'scheduled_date');
    if (!svc) return { eligible: false, reason: 'visit-missing' };
    const status = String(svc.status || '').toLowerCase();
    // 'rescheduled' is the pending-rebook placeholder — the row keeps the
    // OBSOLETE date/window until re-slotted, so frozen confirmation/prep
    // copy for it is wrong the same way a cancelled visit's is.
    if (['cancelled', 'completed', 'skipped', 'rescheduled'].includes(status)) {
      return { eligible: false, reason: `visit-${status}` };
    }
    const ymd = svc.scheduled_date instanceof Date
      ? svc.scheduled_date.toISOString().slice(0, 10)
      : String(svc.scheduled_date || '').slice(0, 10);
    const { etDateString } = require('../../utils/datetime-et');
    if (ymd && ymd < etDateString()) return { eligible: false, reason: 'visit-past' };
    return { eligible: true };
  } catch (err) {
    return failClosed(label, scheduledServiceId, err);
  }
}

// Shared: a queued fan-out row belongs to a CONTACT's phone frozen at
// enqueue — the morning replay re-runs the same contact resolution the
// fan-out used: the queued phone must still occupy an authorized, opted-in
// contact slot. A contact removed or replaced overnight would otherwise
// receive a personalized notice + appointment link for a household they no
// longer represent. The executor merges the row's to_phone/customer_id
// into the recheck meta, so pre-fix queued rows revalidate too.
async function contactSlotStillAuthorized(meta, label) {
  try {
    if (!meta.customer_id || !meta.to_phone) return { eligible: true };
    const customer = await db('customers').where({ id: meta.customer_id }).first();
    if (!customer) return { eligible: false, reason: 'customer-missing' };
    const prefsRow = await db('notification_prefs').where({ customer_id: meta.customer_id }).first() || {};
    const { getAppointmentContacts } = require('../customer-contact');
    const { filterRecipientsByOptin } = require('../recipient-optin');
    const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
    const stillAuthorized = (await filterRecipientsByOptin(
      getAppointmentContacts(customer, prefsRow), meta.customer_id
    )).some((c) => digits(c.phone) === digits(meta.to_phone));
    if (!stillAuthorized) return { eligible: false, reason: 'contact-removed' };
    return { eligible: true };
  } catch (err) {
    return failClosed(label, meta.scheduled_service_id, err);
  }
}

// Shared: deferred invoice pay-link/dunning replays must confirm the
// invoice is still collectible and (for dunning) the sequence not stopped.
async function invoiceStillCollectible(meta) {
  try {
    if (!meta.invoice_id) return { eligible: true };
    const { isTerminalInvoice } = require('../invoice-followups');
    const inv = await db('invoices').where({ id: meta.invoice_id }).first();
    if (!inv) return { eligible: false, reason: 'invoice-missing' };
    if (isTerminalInvoice(inv)) return { eligible: false, reason: `invoice-terminal:${inv.status}` };
    // Third-party Bill-To adopted overnight: payer-billed invoices route
    // AR to the payer's AP inbox (email) and billing texts must never
    // reach the homeowner — same rule the decline-notice recheck and the
    // receipt paths enforce.
    if (inv.payer_id) return { eligible: false, reason: 'payer-billed' };
    if (meta.followup_sequence_id) {
      const seq = await db('invoice_followup_sequences')
        .where({ id: meta.followup_sequence_id })
        .first('status');
      if (seq && String(seq.status || '') === 'stopped') {
        return { eligible: false, reason: 'sequence-stopped' };
      }
    }
    return { eligible: true };
  } catch (err) {
    return failClosed('invoice', meta.invoice_id, err);
  }
}

// null = no recheck registered for this entry point (dispatch proceeds).
async function recheckDeferredReplay(entryPoint, claimMeta = {}) {
  const entry = entryFor(entryPoint);
  if (!entry || typeof entry.recheck !== 'function') return null;
  try {
    return await entry.recheck(claimMeta);
  } catch (err) {
    return failClosed(entryPoint, claimMeta.invoice_id || claimMeta.estimate_id || 'unknown', err);
  }
}

// null = no finalize registered. { ok:false } rides the durable
// finalize_only retry rail for durableFinalize entry points.
async function finalizeDeferredReplay(entryPoint, claimMeta = {}, ctx = {}) {
  const entry = entryFor(entryPoint);
  if (!entry || typeof entry.finalize !== 'function') return null;
  try {
    const res = await entry.finalize(claimMeta, ctx);
    return res && typeof res.ok === 'boolean' ? res : { ok: true };
  } catch (err) {
    logger.warn(`[deferred-replay] finalize failed for ${entryPoint}: ${err.message}`);
    return { ok: false };
  }
}

async function onTerminalDeferredReplay(entryPoint, claimMeta = {}) {
  const entry = entryFor(entryPoint);
  if (!entry || typeof entry.onTerminal !== 'function') return { ok: true };
  try {
    await entry.onTerminal(claimMeta);
    return { ok: true };
  } catch (err) {
    logger.warn(`[deferred-replay] onTerminal failed for ${entryPoint}: ${err.message}`);
    return { ok: false };
  }
}

// Durable wrapper for the executor's terminal-status sites. A terminal row
// (blocked/failed) is never revisited by any sweep, so a hook that throws
// on a transient DB error — releasing a voicemail claim, restoring
// completion state, arming the cancellation email — would lose the
// obligation forever. Stamp `terminal_pending` on the row FIRST (durable
// obligation, attempts counted), run the hook, clear the stamp only on
// success; sweepPendingTerminalHooks re-runs stamped rows bounded. Hooks
// are idempotent by the registry contract (guarded deletes/updates,
// idempotency-keyed emails), so a crash between hook success and the
// clear re-runs harmlessly.
const TERMINAL_HOOK_MAX_ATTEMPTS = 5;

async function runTerminalHookDurably(msgId, entryPoint, claimMeta = {}) {
  const entry = entryFor(entryPoint);
  if (!entry || typeof entry.onTerminal !== 'function') return { ok: true };
  if (msgId) {
    await db('sms_log').where({ id: msgId }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('terminal_pending', true, 'terminal_attempts', COALESCE((metadata->>'terminal_attempts')::int, 0) + 1)"),
      updated_at: new Date(),
    }).catch((err) => {
      // Best-effort attempt counting only: the DURABLE obligation was
      // already stamped atomically with the terminal status flip at the
      // executor's call site (requiresTerminalHook), so a failure here
      // costs nothing but this run's attempt increment — the sweep still
      // finds the row.
      logger.warn(`[deferred-replay] terminal_pending stamp failed for ${msgId}: ${err.message}`);
    });
  }
  const res = await onTerminalDeferredReplay(entryPoint, claimMeta);
  if (res.ok && msgId) {
    await db('sms_log').where({ id: msgId }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('terminal_pending', false)"),
    }).catch((err) => {
      logger.warn(`[deferred-replay] terminal_pending clear failed for ${msgId}: ${err.message}`);
    });
  }
  return res;
}

// Executor-tick sweep: re-run terminal hooks whose stamp never cleared
// (hook threw, or the process died mid-hook). Bounded per row; exhaustion
// CLEARS the stamp loudly — else the sweep loops on the row forever (same
// lesson as the stranded-finalization sweep). Age floor keeps it off
// rows whose first inline pass is still in flight.
async function sweepPendingTerminalHooks({ limit = 25, now = new Date() } = {}) {
  let rows = [];
  try {
    rows = await db('sms_log')
      .whereIn('status', ['blocked', 'failed'])
      .whereRaw("metadata->>'terminal_pending' = 'true'")
      .where('updated_at', '<', new Date(now.getTime() - 5 * 60 * 1000))
      .orderBy('updated_at', 'asc')
      .limit(limit)
      .select('id', 'metadata');
  } catch (err) {
    logger.warn(`[deferred-replay] terminal-hook sweep query failed: ${err.message}`);
    return { candidates: 0, reran: 0 };
  }
  let reran = 0;
  for (const row of rows) {
    let meta = row.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    meta = meta || {};
    const attempts = Number(meta.terminal_attempts) || 1;
    if (!meta.entry_point || attempts >= TERMINAL_HOOK_MAX_ATTEMPTS) {
      await db('sms_log').where({ id: row.id }).update({
        metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('terminal_pending', false)"),
        updated_at: new Date(),
      }).catch(() => {});
      logger.error(`[deferred-replay] terminal hook ${meta.entry_point ? 'EXHAUSTED' : 'has no entry_point'} for ${row.id} (${meta.entry_point || 'unknown'}) — obligation handoff may need manual sync`);
      continue;
    }
    const res = await runTerminalHookDurably(row.id, meta.entry_point, meta);
    if (res.ok) reran += 1;
  }
  return { candidates: rows.length, reran };
}

function requiresDurableFinalize(entryPoint) {
  const entry = entryFor(entryPoint);
  return !!(entry && entry.durableFinalize === true && typeof entry.finalize === 'function');
}

// True when the entry point registers an onTerminal hook — the executor's
// terminal-status writes stamp `terminal_pending` ATOMICALLY with the flip
// for these (same contract as finalize_pending: the obligation must be
// durable BEFORE the hook runs, or a crash/throw between the flip and the
// hook loses it where no sweep can see it).
function requiresTerminalHook(entryPoint) {
  const entry = entryFor(entryPoint);
  return !!(entry && typeof entry.onTerminal === 'function');
}

// Concrete list for the stale-claim recovery SQL's WHERE IN (same pattern
// as DURABLE_FINALIZE_ENTRY_POINTS below).
const TERMINAL_HOOK_ENTRY_POINTS = Object.entries(REGISTRY)
  .filter(([, entry]) => typeof entry.onTerminal === 'function')
  .map(([key]) => key);

// Entry points whose finalize rides the finalize_pending durability rail —
// consumed by the executor's settlement sites and the stranded-finalization
// recovery query (which needs the concrete list for its WHERE IN).
const DURABLE_FINALIZE_ENTRY_POINTS = Object.entries(REGISTRY)
  .filter(([, entry]) => entry.durableFinalize === true && typeof entry.finalize === 'function')
  .map(([key]) => key);

module.exports = {
  recheckDeferredReplay,
  finalizeDeferredReplay,
  onTerminalDeferredReplay,
  runTerminalHookDurably,
  sweepPendingTerminalHooks,
  requiresDurableFinalize,
  requiresTerminalHook,
  DURABLE_FINALIZE_ENTRY_POINTS,
  TERMINAL_HOOK_ENTRY_POINTS,
  _registry: REGISTRY,
};
