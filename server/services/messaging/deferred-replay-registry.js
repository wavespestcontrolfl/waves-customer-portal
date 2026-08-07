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
  },

  lead_response_auto_reply_deferred: {
    async recheck(meta) {
      // Mirror the immediate path's liveness gate: an admin-deleted lead
      // must not be texted at 8:00 AM.
      try {
        if (!meta.lead_id) return { eligible: true };
        const lead = await db('leads').where({ id: meta.lead_id }).whereNull('deleted_at').first('id');
        if (!lead) return { eligible: false, reason: 'lead-deleted' };
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
      // The ask is only valid while the recipient row is still pending —
      // another save may have re-asked, or the recipient may have been
      // removed/confirmed/declined overnight.
      try {
        if (!meta.optin_phone_key) return { eligible: true };
        const row = await db('recipient_optin')
          .where({ phone_key: meta.optin_phone_key, customer_id: meta.optin_customer_id || null })
          .first('status');
        if (!row) return { eligible: false, reason: 'optin-row-missing' };
        if (String(row.status) !== 'pending') return { eligible: false, reason: `optin-${row.status}` };
        return { eligible: true };
      } catch (err) {
        return failClosed('recipient-optin', meta.optin_phone_key, err);
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
      // admin retry lane instead of leaving it falsely 'contacted'.
      if (!meta.referral_id) return;
      await db('referrals').where({ id: meta.referral_id }).update({ status: 'sms_failed', updated_at: new Date() });
      logger.info(`[deferred-replay] referral invite ${meta.referral_id} terminally blocked — status sms_failed for admin retry`);
    },
  },

  referrals_legacy_invite_deferred: {
    async onTerminal(meta) {
      if (!meta.referral_id) return;
      await db('referrals').where({ id: meta.referral_id }).update({ status: 'sms_failed', updated_at: new Date() });
      logger.info(`[deferred-replay] legacy referral invite ${meta.referral_id} terminally blocked — status sms_failed for admin retry`);
    },
  },

  referrals_v2_invite_deferred: {
    // v2 invites track promoter cooldowns only (no referrals row) — nothing
    // to unwind on terminal block.
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
