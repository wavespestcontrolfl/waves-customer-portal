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
      // The completion text (and the bundled review link inside it) will
      // never deliver — arm the standalone review sender. Armed ONLY here,
      // never on a timer, so it can't race a still-retryable replay.
      if (!meta.bundled_review_request_id) return;
      const ReviewService = require('../review-request');
      await ReviewService.markInlineRetryable(
        meta.bundled_review_request_id,
        new Date(Date.now() + 5 * 60 * 1000),
      );
      logger.info(`[deferred-replay] completion terminally blocked — standalone review fallback armed for ${meta.bundled_review_request_id}`);
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
      const { _deferredClaims } = require('../voicemail-lead-sms');
      if (meta.lead_id) await _deferredClaims.stampStatus(meta.lead_id, 'sent');
      if (meta.voicemail_phone) await _deferredClaims.stampPhoneClaim(meta.voicemail_phone, 'sent');
      return { ok: true };
    },
    async onTerminal(meta) {
      // The text-back provably never delivered — release BOTH one-shot
      // claims so a repeat caller (or the suppressed-replay path) can
      // re-arm instead of the phone staying consumed with no text sent.
      const { _deferredClaims } = require('../voicemail-lead-sms');
      if (meta.lead_id) await _deferredClaims.clearLeadClaim(meta.lead_id);
      if (meta.voicemail_phone) await _deferredClaims.releasePhoneClaim(meta.voicemail_phone);
      logger.info(`[deferred-replay] voicemail text-back for lead ${meta.lead_id || 'unknown'} terminally blocked — claims released`);
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
          .first('status', 'card_link_sent_at');
        if (!svc) return { eligible: false, reason: 'visit-missing' };
        const status = String(svc.status || '').toLowerCase();
        if (['cancelled', 'completed', 'skipped'].includes(status)) {
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

  appointment_tagger_prep_deferred: {
    async recheck(meta) {
      // Prep instructions are for an upcoming visit — a cancellation or
      // completion overnight makes them noise.
      try {
        if (!meta.scheduled_service_id) return { eligible: true };
        const svc = await db('scheduled_services')
          .where({ id: meta.scheduled_service_id })
          .first('status', 'scheduled_date');
        if (!svc) return { eligible: false, reason: 'visit-missing' };
        const status = String(svc.status || '').toLowerCase();
        if (['cancelled', 'completed', 'skipped'].includes(status)) {
          return { eligible: false, reason: `visit-${status}` };
        }
        const ymd = svc.scheduled_date instanceof Date
          ? svc.scheduled_date.toISOString().slice(0, 10)
          : String(svc.scheduled_date || '').slice(0, 10);
        const { etDateString } = require('../../utils/datetime-et');
        if (ymd && ymd < etDateString()) return { eligible: false, reason: 'visit-past' };
        return { eligible: true };
      } catch (err) {
        return failClosed('prep', meta.scheduled_service_id, err);
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
      await db('referral_invites')
        .where({ promoter_id: meta.promoter_id, phone: meta.invite_phone })
        .del()
        .catch(() => { /* table may not exist yet — mirrors the route */ });
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

// Shared: deferred invoice pay-link/dunning replays must confirm the
// invoice is still collectible and (for dunning) the sequence not stopped.
async function invoiceStillCollectible(meta) {
  try {
    if (!meta.invoice_id) return { eligible: true };
    const { isTerminalInvoice } = require('../invoice-followups');
    const inv = await db('invoices').where({ id: meta.invoice_id }).first();
    if (!inv) return { eligible: false, reason: 'invoice-missing' };
    if (isTerminalInvoice(inv)) return { eligible: false, reason: `invoice-terminal:${inv.status}` };
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
  if (!entry || typeof entry.onTerminal !== 'function') return;
  try {
    await entry.onTerminal(claimMeta);
  } catch (err) {
    logger.warn(`[deferred-replay] onTerminal failed for ${entryPoint}: ${err.message}`);
  }
}

function requiresDurableFinalize(entryPoint) {
  const entry = entryFor(entryPoint);
  return !!(entry && entry.durableFinalize === true && typeof entry.finalize === 'function');
}

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
  requiresDurableFinalize,
  DURABLE_FINALIZE_ENTRY_POINTS,
  _registry: REGISTRY,
};
