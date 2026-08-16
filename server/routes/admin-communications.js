const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { resolveLocation } = require('../config/locations');
const logger = require('../services/logger');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('../services/llm/call');
const { normalizePhone } = require('../utils/phone');
const { mediaFromOutboundAttachments, signMediaForClient } = require('../services/sms-media');
const { alertTwilioFailure } = require('../services/twilio-failure-alerts');
const { parseETDateTime, etDateString, etParts } = require('../utils/datetime-et');
const { ARRIVAL_WINDOW_MINUTES } = require('../utils/sms-time-format');
const { buildRescheduleLink } = require('../services/reschedule-link');
const smsTemplatesRouter = require('./admin-sms-templates');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');
const { purposeForScheduledMessageType } = require('../services/scheduler');
const { normalizePhone: normalizeCompliancePhone, phoneHash } = require('../services/messaging/compliance-contact-checks');
const { isEnabled } = require('../config/feature-gates');
const {
  SUGGEST_WORKFLOW,
  HUMAN_REPLY_TYPES,
  revertDraftsToShadow,
  markSuggestionScheduled,
  parkThreadSuggestions,
  reopenScheduledSuggestions,
  ignoreParkedSuggestions,
  lockSuggestThread,
  suggestionAnchorIsStale,
  supersedeStaleDecision,
} = require('../services/sms-suggest-mode');
const autoSendExecutor = require('../services/sms-auto-send');

router.use(adminAuthenticate, requireTechOrAdmin);

const ADMIN_PHONE_RAW = '9415993489';
const ADMIN_PHONES = [
  `+1${ADMIN_PHONE_RAW}`, `1${ADMIN_PHONE_RAW}`, ADMIN_PHONE_RAW,
  ...(process.env.ADAM_PHONE ? [process.env.ADAM_PHONE] : []),
];
const DEFAULT_SMS_LOG_LIMIT = 500;
const MAX_SMS_LOG_LIMIT = 500;

function notifyTwilioFailure(payload) {
  void alertTwilioFailure(payload).catch((alertErr) => {
    logger.error(`[twilio-alerts] async notification failed: ${alertErr.message}`);
  });
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

// Guards raw query params destined for uuid columns — a malformed string
// makes Postgres throw a cast error instead of returning no rows.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function maskPhone(value) {
  const digits = phoneDigits(value);
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePhoneLast10(value) {
  const digits = phoneDigits(value);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeReplyForComparison(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Shared by the immediate /sms and /schedule-sms routes: an Agent Review
// draft may only resolve a decision the sender actually owns — pending,
// phone-matched through its inbound sms_log or customer record, and (when a
// customer is selected) belonging to that customer.
async function verifyAgentDecisionForSend({ agentDecisionId, to, trustedCustomerId, outgoingBody }) {
  try {
    const sentPhoneLast10 = normalizePhoneLast10(to);
    const decision = await db('agent_decisions as ad')
      .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
      .leftJoin('customers as c', 'ad.customer_id', 'c.id')
      .where({ 'ad.id': agentDecisionId, 'ad.status': 'pending_review' })
      .select(
        'ad.id',
        'ad.customer_id',
        'ad.sms_log_id',
        'ad.suggested_message',
        's.created_at as inbound_created_at',
        's.from_phone as sms_from_phone',
        's.to_phone as sms_to_phone',
        'c.phone as customer_phone'
      )
      .first();
    const decisionPhoneMatches = sentPhoneLast10 && [
      decision?.sms_from_phone,
      decision?.sms_to_phone,
      decision?.customer_phone,
    ].some((phone) => normalizePhoneLast10(phone) === sentPhoneLast10);
    const customerMatches = !trustedCustomerId || decision?.customer_id === trustedCustomerId;
    if (!(decision?.id && customerMatches && decisionPhoneMatches)) return null;

    // House rule at the send boundary: check the OUTGOING body — the text
    // that will actually reach the customer — not the stored suggestion.
    // (The former price-quote refusal here is retired — owner ruling
    // 2026-07-30, house_voice_v10: real dollar amounts from the customer's
    // BILLING facts may be texted. The operator reviewing the card is the
    // gate; the drafter's verifier checks every figure against the facts
    // block; auto-send still refuses amount-bearing drafts.)

    // STALENESS: a card is only sendable while its anchoring inbound is
    // still the newest customer message on the thread. Drafting lanes that
    // never publish (scheduling, escalation, withheld/priced drafts, LLM
    // latency, failures) leave older cards pending — this send-time check is
    // the one gate that covers every lane. Verification failure 409s with a
    // "refresh the thread" message, which is exactly right here.
    if (decision.inbound_created_at) {
      const threadLast10 = normalizePhoneLast10(decision.sms_from_phone) || sentPhoneLast10;
      const newerInbound = await db('sms_log')
        .where({ direction: 'inbound' })
        .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10])
        .where('created_at', '>', decision.inbound_created_at)
        .whereNot('id', decision.sms_log_id)
        .first('id');
      if (newerInbound) {
        logger.info(`[agent-review] decision ${decision.id} is stale (newer inbound on thread) — refusing send`);
        // Retire it now, guardedly — otherwise a newer inbound whose own lane
        // produced no replacement card (withheld draft, reaction, failure)
        // leaves this card resurfacing after every "refresh" 409, forever.
        await require('../services/sms-suggest-mode').supersedeStaleDecision({ decisionId: decision.id });
        return null;
      }
    }
    return decision;
  } catch (verifyErr) {
    logger.warn(`[agent-review] failed to verify inbox draft decision ownership: ${verifyErr.message}`);
  }
  return null;
}

async function findSingleCustomerForPhone(phone) {
  // Compare on the last 10 digits so stored formats ('+19415551234',
  // '9415551234', '(941) 555-1234') all match the same dialable number —
  // full-digit equality misses customers stored without the country code.
  const last10 = normalizePhoneLast10(normalizePhone(phone) || phone);
  if (!last10) return null;

  const matches = await db('customers')
    .whereNull('deleted_at')
    .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
    .orderBy('updated_at', 'desc')
    .limit(2);

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    logger.warn(`[admin-call] ${matches.length} customers share outbound phone ${maskPhone(phone)}; require selected customerId to link call_log`);
  }
  return null;
}

function customerDisplayName(customer) {
  if (!customer) return null;
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || null;
}

async function resolveSmsLogCustomerFallbacks(rows) {
  const phones = new Map();
  for (const row of rows || []) {
    if (row.customer_id || row.first_name) continue;
    const contactPhone = row.contact_phone || row.customer_phone;
    const key = normalizePhoneLast10(normalizePhone(contactPhone) || contactPhone);
    if (key && !phones.has(key)) phones.set(key, contactPhone);
  }
  if (!phones.size) return new Map();

  const resolved = new Map();
  await Promise.all([...phones.entries()].map(async ([key, phone]) => {
    const customer = await findSingleCustomerForPhone(phone);
    if (customer) resolved.set(key, customer);
  }));
  return resolved;
}

// POST /api/admin/communications/sms — send an SMS from admin
router.post('/sms', async (req, res, next) => {
  let claimedDecisionId = null;
  let manualReservationId = null;
  let parkedThreadIds = [];
  const clearManualReservation = async () => {
    if (!manualReservationId) return;
    const id = manualReservationId;
    manualReservationId = null;
    await db('sms_log').where({ id }).del().catch((delErr) => {
      // A leftover reservation is bounded — reconcileAutoSendClaims sweeps
      // stale 'sending' reservation rows — so a failed delete is non-fatal.
      logger.warn(`[sms-auto-send] manual reservation cleanup failed (${id}): ${delErr.message}`);
    });
  };
  try {
    const {
      to,
      body,
      customerId,
      messageType,
      fromNumber,
      mediaUrls,
      mediaAttachments,
      agentDecisionId,
      agentDraft,
    } = req.body;
    const cleanBody = typeof body === 'string' ? body.trim() : '';
    const cleanMediaUrls = Array.isArray(mediaUrls) ? mediaUrls.filter((u) => typeof u === 'string' && u.trim()) : [];
    const media = mediaFromOutboundAttachments(mediaAttachments, cleanMediaUrls);
    if (!to || (!cleanBody && media.length === 0)) {
      return res.status(400).json({ error: 'to and body or media required' });
    }
    // Twilio caps a single MMS at 5MB total across all media (not per file), so
    // a batch of otherwise-valid sub-5MB images can still be rejected at send.
    // Reject here with a clear message instead of bubbling up a Twilio error.
    const MAX_TOTAL_MEDIA_BYTES = 5 * 1024 * 1024;
    const totalMediaBytes = media.reduce((sum, m) => sum + (Number(m.size) || 0), 0);
    if (media.length > 0 && totalMediaBytes > MAX_TOTAL_MEDIA_BYTES) {
      return res.status(413).json({
        error: `Attachments total ${(totalMediaBytes / 1024 / 1024).toFixed(1)}MB, over Twilio's 5MB per-message limit`,
      });
    }
    if (fromNumber && !TWILIO_NUMBERS.findByNumber(fromNumber)) {
      return res.status(400).json({ error: 'fromNumber must be a Waves Twilio number' });
    }
    let trustedCustomerId;
    if (customerId) {
      const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id', 'phone');
      if (!customer) return res.status(404).json({ error: 'customerId not found' });
      const normalizedTo = normalizePhone(to);
      const normalizedCustomerPhone = normalizePhone(customer.phone);
      if (!normalizedTo || !normalizedCustomerPhone || normalizedTo !== normalizedCustomerPhone) {
        return res.status(400).json({ error: 'to must match the selected customer phone' });
      }
      trustedCustomerId = customer.id;
    }

    let verifiedAgentDecision = null;
    if (agentDecisionId && agentDraft) {
      verifiedAgentDecision = await verifyAgentDecisionForSend({ agentDecisionId, to, trustedCustomerId, outgoingBody: body });
      // A supplied draft id that fails verification means the card the
      // operator is acting on is stale — most often another operator just
      // handled the same suggestion. Sending anyway risks a duplicate reply.
      if (!verifiedAgentDecision) {
        return res.status(409).json({ error: 'This Agent Review draft was just handled elsewhere — refresh the thread before sending.' });
      }
    }
    const verifiedAgentDraft = normalizeReplyForComparison(verifiedAgentDecision?.suggested_message)
      ? verifiedAgentDecision.suggested_message
      : null;

    if (verifiedAgentDecision) {
      // Claim BEFORE the provider send — verification alone lets two admins
      // pass on the same pending card and both text the customer. The
      // guarded single UPDATE is the atomic claim; the loser 409s.
      // 'scheduled' = claimed-for-send: reopened below on blocked/failed/
      // exception, resolved accepted/corrected on success, and the orphan
      // sweep reopens it if the process dies in between.
      const claimed = await db('agent_decisions')
        .where({ id: verifiedAgentDecision.id, status: 'pending_review' })
        .update({
          status: 'scheduled',
          correction_note: 'Claimed for an immediate send from the SMS inbox.',
          updated_at: new Date(),
        });
      if (!claimed) {
        return res.status(409).json({ error: 'This Agent Review draft was just handled elsewhere — refresh the thread before sending.' });
      }
      claimedDecisionId = verifiedAgentDecision.id;
    }

    // Park the thread's OTHER pending suggestions before the provider call
    // (same as the scheduled path): the post-send sweep can't protect the
    // seconds while Twilio runs, and a parallel admin could still fetch and
    // send the same card. Success resolves them as ignored; blocked/failed/
    // exception reopens them; a crash mid-send is bounded by the 30-min
    // orphan recovery.
    let autoSendInFlight = false;
    let staleAtClaim = false;
    // The auto-send interlock only matters when Phase E auto-send is enabled.
    // Gated so the manual send path carries ZERO extra work while the feature
    // is dormant (the usual state): no claim lookup, no reservation row.
    const autoSendInterlock = isEnabled('smsAutoSend');
    try {
      const parkPhoneLast10 = normalizePhoneLast10(to);
      if (parkPhoneLast10) {
        parkedThreadIds = await db.transaction(async (trx) => {
          await lockSuggestThread(trx, parkPhoneLast10);
          if (claimedDecisionId) {
            // FINAL freshness gate, under the thread lock and AFTER the
            // claim: Twilio inbound inserts don't take this lock, so an
            // inbound committed between verification and the claim is only
            // visible here — the last point before the provider window.
            if (await suggestionAnchorIsStale({ decisionId: claimedDecisionId, dbi: trx })) {
              staleAtClaim = true;
              return [];
            }
          }
          if (autoSendInterlock) {
            // An autonomous house-voice reply (Phase E) may be mid-send to this
            // thread — it claimed under THIS same lock. Don't let a manual send
            // race its provider window; both would reach the customer. Under
            // the lock the check is atomic with the auto-send's claim: whoever
            // takes the lock first wins, the other backs off.
            if (await autoSendExecutor.hasActiveAutoSendClaim(trx, { threadLast10: parkPhoneLast10, customerId: trustedCustomerId })) {
              autoSendInFlight = true;
              return [];
            }
            // ...and the symmetric direction: persist a human-typed 'sending'
            // marker the auto-send's own guard (threadHasLiveAnswer) sees, so an
            // auto-send claiming AFTER we release the lock won't fire during our
            // provider window. Deleted once the send resolves (below / in catch).
            // sms_log.from_phone is NOT NULL, but the route lets callers omit
            // fromNumber (TwilioService picks the location default at send).
            // The reservation is a transient marker (deleted after send, never
            // customer-visible), so its from only needs to be non-null — use
            // the main-line default. getOutboundNumber() with no location falls
            // back to the main line.
            const reservationFrom = fromNumber || TWILIO_NUMBERS.getOutboundNumber();
            const [resv] = await trx('sms_log')
              .insert({
                customer_id: trustedCustomerId || null,
                direction: 'outbound',
                from_phone: reservationFrom,
                to_phone: to,
                message_body: cleanBody,
                status: 'sending',
                message_type: 'manual',
                admin_user_id: req.technicianId || null,
                metadata: JSON.stringify({ manual_send_reservation: true }),
              })
              .returning('id');
            manualReservationId = resv?.id || null;
          }
          return parkThreadSuggestions(
            { phoneLast10: parkPhoneLast10, excludeDecisionId: verifiedAgentDecision?.id }, trx
          );
        });
      }
    } catch (parkErr) {
      // FAIL CLOSED: proceeding would leave the thread's cards actionable
      // during the provider call AND unrecorded in parkedDecisionIds, so
      // crash recovery couldn't settle them. Release the claim and make the
      // operator retry — same contract as a lost claim.
      logger.warn(`[sms-suggest] pre-send park failed — aborting send: ${parkErr.message}`);
      if (claimedDecisionId) {
        await reopenScheduledSuggestions({
          decisionIds: [claimedDecisionId],
          reason: 'Pre-send reservation failed — suggestion reopened.',
        });
      }
      return res.status(503).json({ error: 'Could not reserve this conversation for sending — try again in a moment.' });
    }

    if (staleAtClaim) {
      // A newer inbound (or a colleague's reply) landed between verification
      // and our claim — retire the card rather than reopen it: its context
      // is stale and the newer message's own lane decides what happens next.
      await supersedeStaleDecision({ decisionId: claimedDecisionId, fromStatus: 'scheduled' });
      return res.status(409).json({ error: 'A newer message just arrived on this thread — refresh before sending.' });
    }

    if (autoSendInFlight) {
      // The reply never left — release the claimed card so it can be resent
      // after the autonomous reply lands.
      if (claimedDecisionId) {
        await reopenScheduledSuggestions({
          decisionIds: [claimedDecisionId],
          reason: 'An automated reply is going out to this thread — suggestion reopened.',
        });
      }
      return res.status(409).json({ error: 'An automated reply is going out to this conversation right now — refresh in a moment and resend if it is still needed.' });
    }

    const sendStartedAt = new Date();
    // Human-authored only when the operator typed the body, not when an
    // unedited AI suggestion is being sent through. The stale-month guard
    // exemption rides on this; an unchanged agent draft stays month-checked
    // (an LLM is the likely source of a hallucinated stale month). Same
    // normalized comparison used below to mark the decision as sent-as-is.
    const bodyIsUnchangedAgentDraft =
      !!verifiedAgentDraft &&
      normalizeReplyForComparison(cleanBody) === normalizeReplyForComparison(verifiedAgentDraft);
    const result = await sendCustomerMessage({
      to,
      body: cleanBody,
      channel: 'sms',
      audience: trustedCustomerId ? 'customer' : 'lead',
      purpose: 'conversational',
      customerId: trustedCustomerId || undefined,
      identityTrustLevel: trustedCustomerId ? 'phone_matches_customer' : 'phone_provided_unverified',
      entryPoint: 'admin_communications_manual_sms',
      metadata: {
        original_message_type: messageType || 'manual',
        adminUserId: req.technicianId,
        agentDecisionId: verifiedAgentDecision?.id || undefined,
        // Parked ids ride into the provider-created sms_log row (same as
        // the scheduled path) so a crash between Twilio's accept and the
        // post-send resolution recovers as ignored, not reopened.
        parkedDecisionIds: parkedThreadIds.length ? parkedThreadIds : undefined,
        agentDraft: verifiedAgentDraft || undefined,
        suggestedReply: verifiedAgentDraft || undefined,
        fromNumber: fromNumber || undefined,
        mediaUrls: cleanMediaUrls.length ? cleanMediaUrls : undefined,
        allowMediaUrls: cleanMediaUrls.length > 0,
        media,
        // Operator hand-typed (or edited) this body in the Comms composer —
        // exempt it from the stale-month guard so an intentional reference to
        // a past visit ("Adam visited back in April") isn't rejected as a
        // stale template render. NOT set for an unchanged AI draft. Scoped to
        // this human-compose route, never inferred from messageType.
        // See services/sms-guard.js.
        humanAuthored: !bodyIsUnchangedAgentDraft,
      },
    });
    // The reservation has done its job — the real provider row now exists (on
    // success) or no send happened (on failure). Clear it so it can't linger as
    // a stuck 'sending' row blocking auto-sends to the thread.
    await clearManualReservation();
    if (result.blocked || result.sent === false) {
      // The reply never left — release the claim and the parked cards.
      await reopenScheduledSuggestions({
        decisionIds: [claimedDecisionId, ...parkedThreadIds],
        reason: 'Send was blocked or failed — suggestion reopened.',
      });
      return res.status(422).json({
        ...result,
        error: result.reason || result.code || 'SMS send blocked/failed',
      });
    }

    // A reply from the Comms composer is a first response to any open lead
    // with this phone — stamp the Speed-to-Lead clock (SLA truth only; lead
    // status/linkage untouched). Operator-approved AI drafts count too: a
    // human chose to send them. Gated on a REAL provider send —
    // sendCustomerMessage reports sent:true with a sentinel providerMessageId
    // on suppression paths (gate off, template disabled, owner-SMS kill)
    // where nothing actually left. Fail-soft — bookkeeping never breaks a send.
    try {
      const { isRealProviderSend } = require('../services/sms-auto-send');
      if (isRealProviderSend(result)) {
        const { stampFirstResponseByContact } = require('../services/lead-estimate-link');
        await stampFirstResponseByContact({
          phone: to,
          performedBy: req.technicianId ? `admin:${req.technicianId}` : 'admin',
        });
      }
    } catch (stampErr) {
      logger.warn(`[admin-communications] first-response stamp failed: ${stampErr.message}`);
    }

    if (verifiedAgentDecision && verifiedAgentDraft) {
      const draftMatched = normalizeReplyForComparison(cleanBody) === normalizeReplyForComparison(verifiedAgentDraft);
      try {
        await db('agent_decisions')
          .where({ id: verifiedAgentDecision.id })
          .whereIn('status', ['scheduled', 'pending_review'])
          .update({
            status: draftMatched ? 'accepted' : 'corrected',
            human_verdict: draftMatched ? 'accepted' : 'corrected',
            correction_note: draftMatched
              ? 'Agent Review draft sent from SMS inbox.'
              : 'Agent Review draft edited and sent from SMS inbox.',
            reviewed_by: req.technicianId || 'Admin',
            reviewed_at: new Date(),
            updated_at: new Date(),
          });
      } catch (reviewErr) {
        logger.warn(`[agent-review] failed to mark inbox draft decision reviewed: ${reviewErr.message}`);
      }
    }

    // Suggestions parked before the provider call resolve as ignored — the
    // operator saw them and chose their own reply; their drafts return to
    // the judge pool against the reply that just went out.
    if (parkedThreadIds.length) {
      await ignoreParkedSuggestions({ decisionIds: parkedThreadIds, reviewedBy: req.technicianId || 'Admin' });
    }

    // Belt-and-braces sweep for cards published BETWEEN the park commit and
    // send completion (the thread lock releases when the park transaction
    // commits, and a publish can land while Twilio runs). Phone-scoped
    // through the suggestion's inbound sms_log row — the same ownership
    // match the composer card fetch uses. Cutoff on the INBOUND's timestamp
    // vs send start: a suggestion for a customer message that arrived while
    // the send was in flight was never on the operator's screen and must
    // keep its card.
    const runStaleSweep = async () => {
      const ignoredPhoneLast10 = normalizePhoneLast10(to);
      if (!ignoredPhoneLast10) return;
      await db.transaction(async (trx) => {
        // Same thread lock the drafter's publish takes: a publish that
        // hasn't committed yet will land AFTER this sweep and re-check
        // the (now committed) outbound in its answered guard.
        await lockSuggestThread(trx, ignoredPhoneLast10);

        // s is always the suggestion's INBOUND row — from_phone is the
        // customer; matching to_phone (the Waves line) would sweep every
        // suggestion that arrived on that line.
        const staleQuery = trx('agent_decisions as ad')
          .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
          .where({ 'ad.workflow': SUGGEST_WORKFLOW, 'ad.status': 'pending_review' })
          .where('s.created_at', '<', sendStartedAt)
          .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(s.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ignoredPhoneLast10]);
        if (verifiedAgentDecision?.id) staleQuery.whereNot('ad.id', verifiedAgentDecision.id);
        const stale = await staleQuery.select('ad.id', 'ad.entity_id');
        if (stale.length) {
          // Revert only rows the guarded UPDATE actually changed: a parallel
          // operator can send one of these suggestions between the SELECT
          // and the UPDATE, and that draft must stay out of the judge pool.
          const ignored = await trx('agent_decisions')
            .whereIn('id', stale.map((r) => r.id))
            .where('status', 'pending_review')
            .update({
              status: 'ignored',
              human_verdict: 'ignored',
              correction_note: 'Staff sent their own reply from the SMS inbox.',
              reviewed_by: req.technicianId || 'Admin',
              reviewed_at: new Date(),
              updated_at: new Date(),
            })
            .returning(['id', 'entity_id']);
          await revertDraftsToShadow(trx, ignored.map((r) => r.entity_id));
        }
      });
    };
    // Retried once: this sweep is the only path that resolves cards
    // published between the park commit and send completion — cards it
    // misses have no recovery linkage and stay actionable on an answered
    // thread until the next staff send on the thread or the 48h expiry.
    try {
      await runStaleSweep();
    } catch (sweepErr) {
      logger.warn(`[sms-suggest] stale-card sweep failed, retrying once: ${sweepErr.message}`);
      try {
        await runStaleSweep();
      } catch (retryErr) {
        logger.error(`[sms-suggest] stale-card sweep failed twice — pending cards may linger on an answered thread until the next send or expiry: ${retryErr.message}`);
      }
    }

    res.json(result);
  } catch (err) {
    // Release the in-flight reservation so a throw mid-send can't strand a
    // 'sending' row that blocks auto-sends to the thread.
    await clearManualReservation();
    // Guarded reopen: anything the send actually resolved before the throw
    // is no longer 'scheduled' and no-ops here.
    if (claimedDecisionId || parkedThreadIds.length) {
      await reopenScheduledSuggestions({
        decisionIds: [claimedDecisionId, ...parkedThreadIds],
        reason: 'Send errored — suggestion reopened.',
      });
    }
    notifyTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      phase: 'send_api',
      status: 'failed',
      errorMessage: err.message,
      from: req.body?.fromNumber,
      to: req.body?.to,
      link: '/admin/communications',
    });
    next(err);
  }
});

// POST /api/admin/communications/send-prep — manual prep-guide send for a
// customer picked by name ("Send prep guide" button). Smart channel: emails
// the formatted prep guide (plus the companion text) when the customer has an
// email on file, otherwise sends the self-contained prep text. All PREP_CONFIG
// pests are allowed — flea, bed bug, and cockroach templates all exist.
const { isSupportedPestType } = require('../services/prep-guide-sender');

function manualPrepMessage(result) {
  if (!result.ok) {
    switch (result.reason) {
      case 'customer_not_found': return 'That customer could not be found.';
      case 'no_email_or_phone': return 'This customer has no email or phone number on file, so there was nothing to send.';
      case 'unsupported_pest_type': return 'That prep type is not available yet.';
      default: return "Couldn't send the prep — check the customer's contact info and try again.";
    }
  }
  const parts = [];
  if (result.emailSent) parts.push(`emailed to ${result.emailAddress}`);
  if (result.smsSent) parts.push(`texted to ${result.phone}`);
  return `${result.label} prep ${parts.join(' and ')}.`;
}

router.post('/send-prep', async (req, res, next) => {
  try {
    const { customerId, pestType = 'flea' } = req.body || {};
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!isSupportedPestType(pestType)) {
      return res.status(400).json({ error: `Unsupported prep type: ${pestType}` });
    }
    const { sendPrepToCustomer } = require('../services/prep-guide-sender');
    const result = await sendPrepToCustomer({ customerId, pestType, actorId: req.technicianId || null });
    const message = manualPrepMessage(result);
    if (!result.ok) {
      const status = result.reason === 'customer_not_found' ? 404 : 400;
      return res.status(status).json({ error: message, result });
    }
    res.json({ success: true, message, result });
  } catch (err) { next(err); }
});

// POST /api/admin/communications/call — initiate an outbound call via Twilio
router.post('/call', async (req, res, next) => {
  let attemptedFrom = req.body?.fromNumber || null;
  let attemptedTo = req.body?.to || null;
  try {
    const { to, fromNumber, customerId, source: rawSource, relatedCallId } = req.body;
    if (!to) return res.status(400).json({ error: 'to number required' });
    if (fromNumber && !TWILIO_NUMBERS.findByNumber(fromNumber)) {
      return res.status(400).json({ error: 'fromNumber must be a Waves Twilio number' });
    }

    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('twilioVoice')) {
      return res.json({ success: false, error: 'Voice gate is disabled' });
    }

    const twilio = require('twilio');
    const config = require('../config');
    if (!config.twilio.accountSid || !config.twilio.authToken) {
      return res.status(500).json({ error: 'Twilio not configured' });
    }
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);

    // All outbound calls present the main company line, regardless of which
    // endpoint the UI picker selected (fromNumber is still validated above so
    // garbage input fails loudly rather than silently dialing as main).
    const from = TWILIO_NUMBERS.mainLine.number;
    attemptedFrom = from;
    const domain = process.env.SERVER_DOMAIN || 'portal.wavespestcontrol.com';
    const source = rawSource === 'call-log-callback' ? 'admin-callback' : 'admin-click';
    const metadata = relatedCallId ? { relatedCallId } : null;

    const adminPhone = process.env.ADAM_PHONE || '+19415993489';
    const toLast10 = normalizePhoneLast10(to);
    const adminPhoneKeys = new Set(
      [...ADMIN_PHONES, adminPhone].map(normalizePhoneLast10).filter(Boolean),
    );
    if (toLast10 && adminPhoneKeys.has(toLast10)) {
      return res.status(400).json({ error: 'to must be a customer phone, not the admin bridge phone' });
    }
    attemptedTo = adminPhone;

    // Prefer the explicit customer picked in the UI. Phone-only lookup is
    // ambiguous when spouses/contacts share a number, so auto-link only when
    // exactly one active customer owns the dialed number.
    let customer = null;
    if (customerId) {
      customer = await db('customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first();
      if (!customer) return res.status(404).json({ error: 'customerId not found' });
      const normalizedTo = normalizePhone(to);
      const normalizedCustomerPhone = normalizePhone(customer.phone);
      if (!normalizedTo || !normalizedCustomerPhone || normalizedTo !== normalizedCustomerPhone) {
        return res.status(400).json({ error: 'to must match the selected customer phone' });
      }
    } else {
      customer = await findSingleCustomerForPhone(to).catch((e) => {
        logger.warn(`[admin-call] customer lookup failed for ${maskPhone(to)}: ${e.message}`);
        return null;
      });
    }
    const leadName = customer
      ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
      : '';

    // Insert call_log FIRST so outbound-admin-prompt / outbound-connect can
    // update the row reliably. Twilio typically fires those webhooks 2–5s
    // after calls.create() returns, but racing the insert is cheap to avoid.
    const [callLogRow] = await db('call_log')
      .insert({
        customer_id: customer?.id || null,
        direction: 'outbound',
        from_phone: from,
        to_phone: to,
        status: 'initiated',
        source,
        metadata: metadata ? JSON.stringify(metadata) : null,
      })
      .returning(['id']);
    const callLogId = callLogRow?.id;

    const promptParams = new URLSearchParams({
      customerNumber: to,
      callerIdNumber: from,
    });
    if (callLogId) promptParams.set('callLogId', callLogId);
    if (leadName) promptParams.set('leadName', leadName);

    // Step 1: Call the admin first. When admin picks up and presses 1, dial the customer.
    const call = await client.calls.create({
      to: adminPhone,
      from,
      url: `https://${domain}/api/webhooks/twilio/outbound-admin-prompt?${promptParams.toString()}`,
      statusCallback: `https://${domain}/api/webhooks/twilio/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    // Backfill the Twilio CallSid now that we have it.
    if (callLogId) {
      await db('call_log').where({ id: callLogId }).update({
        twilio_call_sid: call.sid,
        updated_at: new Date(),
      }).catch(() => {});
    }
    require('../services/conversations').recordTouchpoint({
      customerId: customer?.id || null,
      channel: 'voice',
      ourEndpointId: from,
      contactPhone: customer ? null : to,
      direction: 'outbound',
      authorType: 'admin',
      adminUserId: req.technicianId,
      twilioSid: call.sid,
      deliveryStatus: 'initiated',
    }).catch(() => {});

    res.json({ success: true, callSid: call.sid, callLogId });
  } catch (err) {
    notifyTwilioFailure({
      channel: 'voice',
      direction: 'outbound',
      phase: 'send_api',
      status: 'failed',
      errorMessage: err.message,
      from: attemptedFrom,
      to: attemptedTo,
      link: '/admin/communications',
    });
    next(err);
  }
});

// GET /api/admin/communications/log — SMS history (reads unified messages
// table since PR 2; sms_log still gets dual-written for legacy consumers).
router.get('/log', async (req, res, next) => {
  try {
    const { customerId, direction, messageType, page, limit, search } = req.query;

    let query = db('messages')
      .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
      .leftJoin('customers', 'conversations.customer_id', 'customers.id')
      .where('messages.channel', 'sms')
      .select(
        'messages.id', 'messages.conversation_id', 'messages.direction', 'messages.body',
        'messages.delivery_status as status', 'messages.message_type',
        'messages.created_at', 'messages.media', 'messages.is_read', 'messages.read_at',
        'conversations.customer_id', 'conversations.our_endpoint_id',
        'conversations.contact_phone',
        'customers.first_name', 'customers.last_name', 'customers.phone as customer_phone'
      )
      .orderBy('messages.created_at', 'desc');

    // Exclude internal admin phone messages from either side of the conversation.
    for (const phone of ADMIN_PHONES) {
      query = query
        .whereNot('conversations.our_endpoint_id', phone)
        .where(b => b.whereNot('conversations.contact_phone', phone)
          .orWhereNull('conversations.contact_phone'))
        .where(b => b.whereNot('customers.phone', phone)
          .orWhereNull('customers.phone'));
    }

    if (customerId) query = query.where('conversations.customer_id', customerId);
    if (direction) query = query.where('messages.direction', direction);
    if (messageType) query = query.where('messages.message_type', messageType);

    const searchTerm = typeof search === 'string' ? search.trim() : '';
    if (searchTerm) {
      const like = `%${searchTerm}%`;
      query = query.where(b => b
        .where('customers.first_name', 'ilike', like)
        .orWhere('customers.last_name', 'ilike', like)
        .orWhereRaw("(customers.first_name || ' ' || customers.last_name) ILIKE ?", [like])
        .orWhere('conversations.contact_phone', 'ilike', like)
        .orWhere('conversations.our_endpoint_id', 'ilike', like)
        .orWhere('customers.phone', 'ilike', like)
        .orWhere('messages.body', 'ilike', like)
      );
    }

    const requestedPage = parsePositiveInt(page) || 1;
    const requestedLimit = parsePositiveInt(limit) || DEFAULT_SMS_LOG_LIMIT;
    const effectiveLimit = Math.min(requestedLimit, MAX_SMS_LOG_LIMIT);
    const rowsPlusOne = await query
      .limit(effectiveLimit + 1)
      .offset((requestedPage - 1) * effectiveLimit);
    const hasMore = rowsPlusOne.length > effectiveLimit;
    const rows = hasMore ? rowsPlusOne.slice(0, effectiveLimit) : rowsPlusOne;

    const fallbackCustomers = await resolveSmsLogCustomerFallbacks(rows);

    const messages = await Promise.all(rows.map(async (m) => {
      const initialContact = m.contact_phone || m.customer_phone;
      const fallbackCustomer = !m.customer_id && initialContact
        ? fallbackCustomers.get(normalizePhoneLast10(normalizePhone(initialContact) || initialContact))
        : null;
      const customerName = m.first_name
        ? `${m.first_name} ${m.last_name || ''}`.trim()
        : customerDisplayName(fallbackCustomer);
      const ours = m.our_endpoint_id;
      const contact = m.contact_phone || m.customer_phone || fallbackCustomer?.phone;
      const from = m.direction === 'inbound' ? contact : ours;
      const to = m.direction === 'inbound' ? ours : contact;
      return {
        id: m.id, conversationId: m.conversation_id, direction: m.direction, from, to,
        body: m.body, status: m.status, messageType: m.message_type,
        customerId: m.customer_id || fallbackCustomer?.id || null, customerName,
        createdAt: m.created_at,
        isRead: !!m.is_read,
        readAt: m.read_at,
        media: await signMediaForClient(m.media),
      };
    }));

    res.json({
      messages,
      page: requestedPage,
      limit: effectiveLimit,
      hasMore,
      nextPage: hasMore ? requestedPage + 1 : null,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/agent-draft — latest pending Agent Review draft for composer
router.get('/agent-draft', async (req, res, next) => {
  try {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId.trim() : '';
    const phoneLast10 = normalizePhoneLast10(req.query.phone);
    if (!customerId && !phoneLast10) {
      return res.status(400).json({ error: 'customerId or phone required' });
    }

    let q = db('agent_decisions as ad')
      .leftJoin('sms_log as s', 'ad.sms_log_id', 's.id')
      .leftJoin('customers as c', 'ad.customer_id', 'c.id')
      .where('ad.source_channel', 'sms')
      .where('ad.status', 'pending_review')
      .whereNotNull('ad.suggested_message')
      .whereRaw("NULLIF(TRIM(ad.suggested_message), '') IS NOT NULL");

    // Fail closed on rollback: with the suggest-mode gate off, existing
    // pending house-voice cards must stop surfacing too — not just stop
    // being created.
    if (!isEnabled('smsSuggestMode')) q = q.whereNot('ad.workflow', SUGGEST_WORKFLOW);

    q = q
      .select(
        'ad.id',
        'ad.workflow',
        'ad.detected_intent',
        'ad.confidence',
        'ad.confidence_label',
        'ad.suggested_message',
        'ad.reasoning_summary',
        'ad.input_snapshot',
        'ad.created_at'
      )
      .orderBy('ad.created_at', 'desc')
      .limit(1);

    if (phoneLast10) {
      q = q.andWhere(function byActivePhoneThread() {
        this.whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(s.from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phoneLast10])
          .orWhereRaw("RIGHT(REGEXP_REPLACE(COALESCE(s.to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phoneLast10]);
      });
      if (customerId) q = q.andWhere('ad.customer_id', customerId);
    } else {
      q = q.andWhere('ad.customer_id', customerId);
    }

    const row = await q.first();
    if (!row) return res.json({ draft: null });

    const input = parseJson(row.input_snapshot, {});
    res.json({
      draft: {
        decisionId: row.id,
        workflow: row.workflow,
        detectedIntent: row.detected_intent,
        confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
        confidenceLabel: row.confidence_label || null,
        suggestedMessage: row.suggested_message,
        reasoningSummary: row.reasoning_summary || null,
        scenarioLabel: input?.reply_training_hint?.scenarioLabel || null,
        inboundMessage: input?.sms?.body || null,
        // Deterministic comms-lint failures recorded at publish time — the
        // card must show WHY a draft was flagged (it may have been demoted
        // from auto-send), never present it as clean.
        lintFailures: Array.isArray(input?.comms_lint) ? input.comms_lint : [],
        createdAt: row.created_at,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/communications/messages/read — mark inbound SMS as read
router.post('/messages/read', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.messageIds)
      ? req.body.messageIds.filter((id) => typeof id === 'string' && id.trim())
      : [];
    const conversationIds = Array.isArray(req.body?.conversationIds)
      ? req.body.conversationIds.filter((id) => typeof id === 'string' && id.trim())
      : [];
    const readBefore = req.body?.readBefore ? new Date(req.body.readBefore) : null;
    if (!ids.length && !conversationIds.length) {
      return res.status(400).json({ error: 'messageIds or conversationIds required' });
    }
    if (conversationIds.length && (!readBefore || Number.isNaN(readBefore.getTime()))) {
      return res.status(400).json({ error: 'readBefore required when marking a conversation read' });
    }

    const now = new Date();
    let q = db('messages')
      .where({ channel: 'sms', direction: 'inbound' })
      .andWhere(function unreadOnly() {
        this.where({ is_read: false }).orWhereNull('is_read');
      });
    q = q.andWhere(function byMessageOrConversation() {
      if (ids.length) this.whereIn('id', ids);
      if (conversationIds.length) {
        this.orWhere(function visibleConversationRows() {
          this.whereIn('conversation_id', conversationIds)
            .where('created_at', '<=', readBefore);
        });
      }
    });
    const updated = await q.update({
      is_read: true,
      read_at: now,
      read_by_admin_user_id: req.technicianId || null,
      updated_at: now,
    });

    res.json({ success: true, updated });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/stats — channel analytics
router.get('/stats', async (req, res, next) => {
  try {
    const som = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

    // Read from unified messages joined to conversations so we can filter
    // out internal-admin-phone traffic on either endpoint side.
    const baseSms = () => db('messages')
      .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
      .leftJoin('customers', 'conversations.customer_id', 'customers.id')
      .where('messages.channel', 'sms')
      .where('messages.created_at', '>=', som);

    const excludeAdmin = (q) => {
      for (const phone of ADMIN_PHONES) {
        q = q.whereNot('conversations.our_endpoint_id', phone)
          .where(b => b.whereNot('conversations.contact_phone', phone).orWhereNull('conversations.contact_phone'))
          .where(b => b.whereNot('customers.phone', phone).orWhereNull('customers.phone'));
      }
      return q;
    };

    const [sentTotal] = await excludeAdmin(baseSms().where('messages.direction', 'outbound')).count('* as count');
    const [receivedTotal] = await excludeAdmin(baseSms().where('messages.direction', 'inbound')).count('* as count');

    const stats = await db('messages')
      .where('messages.channel', 'sms')
      .where('messages.direction', 'outbound')
      .where('messages.created_at', '>=', som)
      .select('message_type')
      .count('* as sent')
      .groupBy('message_type')
      .orderBy('sent', 'desc');

    // Per-Waves-number counts (channel-agnostic across sms+voice).
    const allNumbers = TWILIO_NUMBERS.allNumbers;
    const locationStats = await Promise.all(
      allNumbers.map(async (n) => {
        try {
          const sent = await db('messages')
            .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
            .where('messages.channel', 'sms')
            .where('messages.direction', 'outbound')
            .where('conversations.our_endpoint_id', n.number)
            .where('messages.created_at', '>=', som)
            .count('* as count').first();
          const received = await db('messages')
            .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
            .where('messages.channel', 'sms')
            .where('messages.direction', 'inbound')
            .where('conversations.our_endpoint_id', n.number)
            .where('messages.created_at', '>=', som)
            .count('* as count').first();
          const lastInboundRow = await db('messages')
            .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
            .where('messages.direction', 'inbound')
            .where('conversations.our_endpoint_id', n.number)
            .orderBy('messages.created_at', 'desc')
            .select('messages.created_at')
            .first();
          const inboundThisMonthRow = await db('messages')
            .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
            .where('messages.direction', 'inbound')
            .where('conversations.our_endpoint_id', n.number)
            .where('messages.created_at', '>=', som)
            .count('* as count').first();
          return {
            ...n,
            sent: parseInt(sent?.count || 0),
            received: parseInt(received?.count || 0),
            inboundThisMonth: parseInt(inboundThisMonthRow?.count || 0),
            lastInboundDate: lastInboundRow?.created_at ? new Date(lastInboundRow.created_at).toISOString() : null,
          };
        } catch { return { ...n, sent: 0, received: 0, inboundThisMonth: 0, lastInboundDate: null }; }
      })
    );

    res.json({
      totalSent: parseInt(sentTotal.count),
      totalReceived: parseInt(receivedTotal.count),
      channelStats: stats.map(s => ({ type: s.message_type, sent: parseInt(s.sent) })),
      locationStats,
      phoneNumbers: {
        locations: TWILIO_NUMBERS.locations,
        tracking: TWILIO_NUMBERS.tracking,
        otherVerticals: TWILIO_NUMBERS.otherVerticals,
        reserve: TWILIO_NUMBERS.reserve,
        tollFree: TWILIO_NUMBERS.tollFree,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/communications/ai-draft — generate AI reply for a customer message
router.post('/ai-draft', async (req, res, next) => {
  try {
    const { customerPhone, lastMessage } = req.body;
    if (!customerPhone) return res.status(400).json({ error: 'customerPhone required' });

    // Look up customer context
    const cleanPhone = customerPhone.replace(/\D/g, '').slice(-10);
    const customer = await db('customers').where('phone', 'like', `%${cleanPhone}`).first();

    // Get recent SMS history for context
    const recentSms = await db('sms_log')
      .where(function () {
        this.where('from_phone', 'like', `%${cleanPhone}`).orWhere('to_phone', 'like', `%${cleanPhone}`);
      })
      .orderBy('created_at', 'desc')
      .limit(5);

    const conversationContext = recentSms.reverse().map(s =>
      `${s.direction === 'inbound' ? 'Customer' : 'Waves'}: ${s.message_body}`
    ).join('\n');

    const msg = await dispatchWithFallback(MODELS.TEXT_POLICIES.customerCopy, {
      maxTokens: 200,
      jsonMode: false,
      text: `You are responding as Waves Pest Control via SMS. Write a short, friendly reply (under 160 characters).

About Waves Pest Control:
- Family-owned pest control and lawn care in Southwest Florida
- Services: pest control, lawn care, mosquito control, termite protection, rodent removal
- Locations: Lakewood Ranch, Sarasota, Parrish, Venice
- Phone: (941) 318-7612
- Tone: Professional but warm, neighborly, genuine. Use "we" and "our".
- Always helpful and solution-oriented

${customer ? `Customer: ${customer.first_name} ${customer.last_name}, ${customer.city || ''}, ${customer.waveguard_tier || ''} tier` : `Customer phone: ${customerPhone}`}

${conversationContext ? `Recent conversation:\n${conversationContext}` : ''}

${lastMessage ? `Customer's last message: "${lastMessage}"` : 'No specific message to reply to — write a friendly check-in.'}

Write ONLY the SMS reply text. Keep it under 160 characters. No quotes or labels.`,
    }, {
      validate: (result) => {
        const draft = String(result.text || '').trim();
        return draft && draft.length <= 320 ? null : 'invalid_sms_draft';
      },
    });
    if (!msg.ok) return res.status(503).json({ error: 'AI drafting is temporarily unavailable' });
    const draft = String(msg.text || '').trim();
    res.json({ draft });
  } catch (err) {
    logger.error(`AI draft failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// pg returns DATE columns as a JS Date or a 'YYYY-MM-DD' string depending on
// parser config — normalize (same idiom as reschedule-public's apptDateStr).
function scheduledDateStr(value) {
  if (!value) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

// Mirrors the same-day 'rescheduled' leg of reschedule-public's eligibility:
// a 'rescheduled' row is a pending-rebook PLACEHOLDER, and once its quoted
// arrival window — max(window_end, window_start + ARRIVAL_WINDOW_MINUTES) —
// has elapsed, the public page rejects it as 'past'. Picking it here would
// insert a link that dead-ends even when a later usable visit exists, so the
// candidate walk skips it. Same-day pending/confirmed rows whose window
// elapsed stay pickable on purpose: those are MISSED visits and the public
// page offers the "we missed each other" rebook for them.
function isElapsedSameDayReschedulePlaceholder(svc, now = new Date()) {
  if (String(svc.status || '').toLowerCase() !== 'rescheduled') return false;
  if (scheduledDateStr(svc.scheduled_date) !== etDateString(now)) return false;
  const toMin = (t) => {
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };
  const bounds = [];
  const end = toMin(svc.window_end);
  const start = toMin(svc.window_start);
  if (end != null) bounds.push(end);
  if (start != null) bounds.push(start + ARRIVAL_WINDOW_MINUTES);
  // No window on the row → can't prove the quoted window elapsed; the public
  // page treats it as still reschedulable, so keep it pickable here too.
  if (!bounds.length) return false;
  const nowEt = etParts(now);
  return Math.max(...bounds) <= nowEt.hour * 60 + nowEt.minute;
}

// All live customer rows under one account. Self-adoption sets
// account_id = id, and rows created by webhook/call paths can carry NULL
// until the lazy login-time adoption (backfill 20260721000000) — callers
// pass the effective key (account_id || id).
async function customerIdsForAccount(accountKey) {
  const rows = await db('customers')
    .whereNull('deleted_at')
    .where((qb) => qb.where({ account_id: accountKey }).orWhere({ id: accountKey }))
    .select('id');
  return rows.map((r) => r.id);
}

// The greeting name for the composer prefill: the first name the given rows
// AGREE on (trimmed, case-insensitive; blank rows don't break agreement), or
// null when they name different people. A "first row" pick would be
// arbitrary and could greet the wrong household member on a shared number.
function agreedFirstName(rows) {
  const named = rows.map((r) => String(r.first_name || '').trim()).filter(Boolean);
  return named.length && new Set(named.map((n) => n.toLowerCase())).size === 1
    ? named[0]
    : null;
}

// The agreement set for the greeting: live rows that BOTH match the phone's
// exact last-10 digits AND belong to the resolved account (customerIds).
// The composer's customerId is NOT proof of an explicit operator pick
// (opening a thread auto-selects whichever row the latest message happened
// to carry — codex P2 #3340), so BOTH resolution paths clear name agreement
// across the number. The account scope matters on the customerId path:
// phone-only resolution 409s on a cross-account number, but customerId
// deliberately proceeds as the operator's disambiguation — a stranger's row
// sharing a reused number must never supply the greeting (codex P1 r2).
async function firstNameForPhone(last10, customerIds) {
  const rows = await db('customers')
    .whereNull('deleted_at')
    .whereIn('id', customerIds)
    .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
    .select('first_name');
  return agreedFirstName(rows);
}

// Composer link inserts are SMS bodies the operator sends verbatim — they
// never pass through getTemplate, so the owned-host scheme strip (owner
// directive 2026-08-01: portal links go bare in SMS) has to happen here.
// Same renderer function as the template path (admin-sms-templates
// stripPortalUrlScheme) so the two paths can never disagree about which
// hosts go bare; third-party hosts keep their scheme.
const stripSmsLinkScheme = typeof smsTemplatesRouter.stripPortalUrlScheme === 'function'
  ? smsTemplatesRouter.stripPortalUrlScheme
  : (s) => s;

// POST /api/admin/communications/reschedule-link  { phone, customerId? }
// Composer helper: resolve the recipient's next upcoming reschedulable visit
// and return its self-serve /reschedule/:token short link for insertion into
// the SMS body. Read-only apart from the short-url row buildRescheduleLink
// mints. The reschedule token is a BEARER credential (AGENTS.md public-token
// section), so this fails closed on every axis:
//   - admin-only (requireAdmin): the comms composer is an admin surface, and
//     the tech portal must not be able to mint arbitrary customers' links;
//   - POST body, not query string — the request logger's :redacted-url does
//     not classify `phone` as sensitive, so a GET would write customer
//     phone numbers to the request logs;
//   - phone is always required and must normalize to a full 10 digits
//     (fullPhoneLast10) — no partial LIKE matching;
//   - customerId, when the composer knows it, must belong to a live customer
//     whose phone matches the request (same cross-check as /rewrite-sms).
//     It then expands to the row's whole account: thread rows supply
//     whichever property profile last messaged, so scoping to that one row
//     would falsely 404 when a sibling property owns the next visit;
//   - phone-only resolution matches on the EXACT last-10 digits across all
//     non-deleted customer rows; rows under ONE shared account expand to the
//     account, while digits spanning DIFFERENT accounts (number reuse,
//     duplicate CRM entry) 409 — the operator disambiguates via the
//     dropdown, which takes the customerId path.
// Final eligibility stays owned by the public /reschedule/:token page (e.g.
// a missed same-day visit still rebooks there) — this endpoint only picks
// WHICH visit the link points to.
router.post('/reschedule-link', requireAdmin, async (req, res) => {
  try {
    const last10 = fullPhoneLast10(req.body?.phone);
    if (!last10) {
      return res.status(400).json({ error: 'Enter a full 10-digit phone number first' });
    }

    const customerId = req.body?.customerId;
    let customerIds = [];
    if (customerId && UUID_RE.test(String(customerId))) {
      const customer = await db('customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first('id', 'phone', 'account_id');
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      if (fullPhoneLast10(customer.phone) !== last10) {
        return res.status(400).json({ error: 'phone must match the selected customer' });
      }
      customerIds = await customerIdsForAccount(customer.account_id || customer.id);
    } else {
      const matches = await db('customers')
        .whereNull('deleted_at')
        .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
        .select('id', 'account_id');
      if (!matches.length) {
        return res.status(404).json({ error: 'No customer found for that number' });
      }
      const accountKeys = [...new Set(matches.map((m) => m.account_id || m.id))];
      if (accountKeys.length > 1) {
        return res.status(409).json({
          error: 'That number is on file for more than one customer account — pick the customer from the search dropdown first',
        });
      }
      customerIds = await customerIdsForAccount(accountKeys[0]);
    }
    if (!customerIds.length) {
      return res.status(404).json({ error: 'No customer found for that number' });
    }

    // The greeting name for the prefill: agreement across this ACCOUNT's
    // rows on this NUMBER, on both resolution paths — see firstNameForPhone.
    // Never the visit owner's row: on a multi-property account a sibling row
    // may own the visit under a different contact name, but the text still
    // goes to the phone's owner.
    const recipientFirstName = await firstNameForPhone(last10, customerIds);

    // Candidate visits, soonest first. ET day frame: scheduled_date is a
    // DATE column, so comparing against the ET 'YYYY-MM-DD' string is exact
    // (same comparison reschedule-public makes). The status gate mirrors
    // RESCHEDULABLE_STATUSES there — live (en_route/on_site) and terminal
    // rows never match. Dispatch-owned pending call-pipeline bookings are
    // excluded with the same null-safe predicate /api/schedule uses: their
    // tentative times are hidden from the customer until the office
    // confirms, so this button must not hand out a bearer link to one.
    //
    // The elapsed-placeholder skip happens in JS (the time math doesn't
    // survive SQL TIME wrap-arounds cleanly), so page until a usable
    // candidate turns up or the candidate set is exhausted — a page full of
    // today's elapsed 'rescheduled' placeholders must not read as "no
    // upcoming appointment" when a later visit exists. Ordering is fully
    // deterministic (id tie-breaker), so offset pages can't skip or repeat
    // rows within a request.
    const PAGE = 25;
    let svc = null;
    for (let offset = 0; ; offset += PAGE) {
      const candidates = await db('scheduled_services')
        .whereIn('customer_id', customerIds)
        .whereIn('status', ['pending', 'confirmed', 'rescheduled'])
        .where('scheduled_date', '>=', etDateString())
        .where((qb) => qb
          .whereNull('source_action')
          .orWhereNotIn('source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS)
          .orWhereNot('status', 'pending')
          .orWhere('customer_confirmed', true))
        .orderBy([
          { column: 'scheduled_date', order: 'asc' },
          { column: 'window_start', order: 'asc' },
          // Stable tie-breaker: two properties' visits can share a date and
          // window, and without a unique key the "soonest" pick would be
          // whichever row Postgres returns first that day.
          { column: 'id', order: 'asc' },
        ])
        .limit(PAGE)
        .offset(offset)
        .select('id', 'customer_id', 'scheduled_date', 'window_start', 'window_end', 'service_type', 'status');
      svc = candidates.find((c) => !isElapsedSameDayReschedulePlaceholder(c)) || null;
      if (svc || candidates.length < PAGE) break;
    }
    if (!svc) return res.status(404).json({ error: 'No upcoming appointment for this customer' });

    const { url, line } = await buildRescheduleLink(svc.id, { customerId: svc.customer_id });
    // Null url = legacy pre-backfill row without a token (or shortener +
    // portal-url both unavailable) — nothing usable to insert.
    if (!url) return res.status(404).json({ error: 'This appointment has no reschedule link' });

    res.json({
      url: stripSmsLinkScheme(url),
      line: stripSmsLinkScheme(line),
      firstName: recipientFirstName,
      appointment: {
        id: svc.id,
        scheduledDate: scheduledDateStr(svc.scheduled_date),
        windowStart: svc.window_start ? String(svc.window_start).slice(0, 5) : null,
        serviceType: svc.service_type || null,
        status: svc.status,
      },
    });
  } catch (err) {
    logger.error(`reschedule-link lookup failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/communications/reservice-link  { phone, customerId? }
// Composer helper: resolve the recipient's self-serve /reservice/:token short
// link (customers.reservice_token — the standing free re-service scheduler)
// for insertion into the SMS body. Identity resolution mirrors
// /reschedule-link above exactly (POST body, full-10-digit phone,
// customerId↔phone cross-check, account expansion, multi-account 409) — the
// reservice token is the same class of BEARER credential. Two extra gates:
//   - 404 while GATE_RESERVICE_SELF_SERVE is dark (buildReserviceLink also
//     mints nothing then — belt and braces);
//   - the link only resolves for an account row with an ELIGIBLE lane
//     (services/reservice-scheduler.js) so the composer can't text a
//     link that lands on the not-eligible page. Final eligibility stays
//     owned by the public page — plan state can change after the text.
router.post('/reservice-link', requireAdmin, async (req, res) => {
  try {
    const { reserviceSelfServeEnabled, reserviceLanesForCustomer } = require('../services/reservice-scheduler');
    if (!reserviceSelfServeEnabled()) {
      return res.status(404).json({ error: 'Self-serve re-service links are not enabled' });
    }
    const last10 = fullPhoneLast10(req.body?.phone);
    if (!last10) {
      return res.status(400).json({ error: 'Enter a full 10-digit phone number first' });
    }

    const customerId = req.body?.customerId;
    let customerIds = [];
    if (customerId && UUID_RE.test(String(customerId))) {
      const customer = await db('customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first('id', 'phone', 'account_id');
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      if (fullPhoneLast10(customer.phone) !== last10) {
        return res.status(400).json({ error: 'phone must match the selected customer' });
      }
      customerIds = await customerIdsForAccount(customer.account_id || customer.id);
    } else {
      const matches = await db('customers')
        .whereNull('deleted_at')
        .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
        .select('id', 'account_id');
      if (!matches.length) {
        return res.status(404).json({ error: 'No customer found for that number' });
      }
      const accountKeys = [...new Set(matches.map((m) => m.account_id || m.id))];
      if (accountKeys.length > 1) {
        return res.status(409).json({
          error: 'That number is on file for more than one customer account — pick the customer from the search dropdown first',
        });
      }
      customerIds = await customerIdsForAccount(accountKeys[0]);
    }
    if (!customerIds.length) {
      return res.status(404).json({ error: 'No customer found for that number' });
    }

    // Greeting name = agreement across this ACCOUNT's rows on this NUMBER,
    // on both resolution paths (see firstNameForPhone) — whichever sibling
    // row ends up owning the eligible lane, the text goes to the phone's
    // owner.
    const recipientFirstName = await firstNameForPhone(last10, customerIds);

    // The operator-selected row is checked FIRST — the /reservice page
    // builds availability around the token row's ADDRESS, so on a
    // multi-property account the sibling scan below must never shadow the
    // property the operator actually picked (codex P2 #3194). Remaining
    // siblings follow in a sorted (deterministic) order —
    // customerIdsForAccount has no ORDER BY of its own. First eligible row
    // wins; none → nothing to insert.
    const selectedId = customerIds.find((id) => String(id).toLowerCase() === String(customerId || '').toLowerCase()) || null;
    const orderedIds = selectedId
      ? [selectedId, ...customerIds.filter((id) => id !== selectedId).sort()]
      : [...customerIds].sort();
    let eligible = null;
    let lanes = [];
    for (const id of orderedIds) {
      const row = await db('customers')
        .where({ id })
        .whereNull('deleted_at')
        .first('id', 'active', 'waveguard_tier', 'monthly_rate', 'reservice_token');
      if (!row || row.active === false || !row.reservice_token) continue;
      const rowLanes = await reserviceLanesForCustomer(row);
      if (rowLanes.length) {
        eligible = row;
        lanes = rowLanes;
        break;
      }
    }
    if (!eligible) {
      return res.status(404).json({ error: 'No active recurring plan on this account — a free re-service needs an active plan' });
    }

    const { buildReserviceLink } = require('../services/reservice-link');
    const { url, line } = await buildReserviceLink(eligible.id);
    if (!url) return res.status(404).json({ error: 'This customer has no re-service link' });

    res.json({
      url: stripSmsLinkScheme(url),
      line: stripSmsLinkScheme(line),
      customerId: eligible.id,
      lanes,
      firstName: recipientFirstName,
    });
  } catch (err) {
    logger.error(`reservice-link lookup failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/communications/ai-auto-reply-status
router.get('/ai-auto-reply-status', async (req, res) => {
  try {
    const row = await db('system_config').where({ key: 'ai_sms_auto_reply' }).first();
    res.json({ enabled: row?.value === 'true' });
  } catch { res.json({ enabled: false }); }
});

// POST /api/admin/communications/ai-auto-reply — toggle
router.post('/ai-auto-reply', async (req, res) => {
  try {
    const { enabled } = req.body;
    const value = enabled ? 'true' : 'false';
    const existing = await db('system_config').where({ key: 'ai_sms_auto_reply' }).first();
    if (existing) {
      await db('system_config').where({ key: 'ai_sms_auto_reply' }).update({ value, updated_at: new Date() });
    } else {
      await db('system_config').insert({ key: 'ai_sms_auto_reply', value });
    }
    res.json({ enabled: value === 'true' });
  } catch (err) { res.json({ enabled: false, error: err.message }); }
});

// Marketing/retention purposes require a real stored consent record per
// server/services/messaging/policy.js. This conversational-compose endpoint
// is not a marketing send path — reject any messageType whose scheduler
// mapping resolves to marketing or retention. Reusing the scheduler's
// mapper here (instead of a local regex) guarantees the route can't drift
// from the cron's classification.
const BLOCKED_SCHEDULED_PURPOSES = new Set(['marketing', 'retention']);

function csvEscape(value) {
  if (value == null) return '';
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const s = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows, columns) {
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((col) => csvEscape(row[col])).join(',')),
  ].join('\n');
}

const SMS_REWRITE_MAX_INPUT = 2000;

function compactPromptText(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function cleanSmsRewriteOutput(value) {
  return String(value || '')
    .trim()
    .replace(/^(rewritten sms|rewritten message|sms|draft|message|waves pest control|waves)\s*:\s*/i, '')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .trim();
}

function normalizeRewriteRecentMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.body === 'string' && m.body.trim())
    .slice(-8)
    .map((m) => ({
      direction: m.direction === 'inbound' ? 'Customer' : 'Waves',
      body: compactPromptText(m.body, 260),
    }));
}

function fullPhoneLast10(value) {
  const digits = phoneDigits(value);
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return '';
}

function rewriteCustomerSummary(customer) {
  if (!customer) return '';
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  const parts = [
    name && `name: ${name}`,
    customer.city && `city: ${customer.city}`,
    customer.waveguard_tier && `tier: ${customer.waveguard_tier}`,
  ].filter(Boolean);
  return parts.length ? `Customer context: ${parts.join(', ')}` : '';
}

function buildSmsRewritePrompt({ body, customer, lastInboundMessage, recentMessages }) {
  const recent = normalizeRewriteRecentMessages(recentMessages);
  const recentContext = recent.length
    ? `Recent thread:\n${recent.map((m) => `${m.direction}: ${m.body}`).join('\n')}`
    : '';
  const lastInbound = compactPromptText(lastInboundMessage, 500);
  const customerSummary = rewriteCustomerSummary(customer);

  return `Rewrite the SMS draft below for Waves Pest Control.

Goals:
- Make it more professional, polished, and easy to understand.
- Correct spelling, grammar, capitalization, and punctuation.
- Keep the Waves style: warm, neighborly, genuine, plain-spoken, and solution-oriented.
- Keep it concise for SMS. Do not make it longer unless clarity requires it.

Rules:
- Preserve the operator's exact meaning, facts, dates, prices, names, addresses, links, phone numbers, promises, and instructions.
- Do not invent details, offers, discounts, arrival windows, guarantees, diagnoses, or commitments.
- Do not add emojis, hashtags, markdown, labels, greetings that were not implied, or a sign-off unless the draft already has one.
- If the draft includes STOP/opt-out, payment, legal, safety, or scheduling language, keep that meaning intact.
- Return only the rewritten SMS body.

${customerSummary}
${lastInbound ? `Customer's latest inbound message: ${lastInbound}` : ''}
${recentContext}

Draft:
${body}`;
}

// POST /api/admin/communications/rewrite-sms — polish an operator-written SMS
// into Waves' customer-facing tone without changing facts or commitments.
router.post('/rewrite-sms', async (req, res) => {
  try {
    const cleanBody = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!cleanBody) return res.status(400).json({ error: 'body required' });
    if (cleanBody.length > SMS_REWRITE_MAX_INPUT) {
      return res.status(400).json({ error: `body must be ${SMS_REWRITE_MAX_INPUT} characters or fewer` });
    }

    let customer = null;
    const customerId = req.body?.customerId;
    if (customerId) {
      const requestedPhoneLast10 = fullPhoneLast10(req.body?.customerPhone);
      if (!requestedPhoneLast10) {
        return res.status(400).json({ error: 'customerPhone required with customerId' });
      }
      customer = await db('customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first('id', 'first_name', 'last_name', 'city', 'waveguard_tier', 'phone')
        .catch((err) => {
          logger.warn(`[sms-rewrite] customer lookup by id failed: ${err.message}`);
          return null;
        });
      if (!customer) return res.status(404).json({ error: 'customerId not found' });
      const customerPhoneLast10 = fullPhoneLast10(customer.phone);
      if (!customerPhoneLast10 || customerPhoneLast10 !== requestedPhoneLast10) {
        return res.status(400).json({ error: 'customerPhone must match the selected customer phone' });
      }
    } else if (req.body?.customerPhone) {
      const last10 = fullPhoneLast10(req.body.customerPhone);
      if (last10) {
        const matches = await db('customers')
          .whereNull('deleted_at')
          .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
          .orderBy('updated_at', 'desc')
          .limit(2)
          .select('id', 'first_name', 'last_name', 'city', 'waveguard_tier')
          .catch((err) => {
            logger.warn(`[sms-rewrite] customer lookup by phone failed: ${err.message}`);
            return [];
          });
        if (matches.length === 1) {
          customer = matches[0];
        } else if (matches.length > 1) {
          logger.warn(`[sms-rewrite] ${matches.length} customers matched ${maskPhone(req.body.customerPhone)}; skipping customer context`);
        }
      }
    }

    const rewritePrompt = buildSmsRewritePrompt({
      body: cleanBody,
      customer,
      lastInboundMessage: req.body?.lastInboundMessage,
      recentMessages: req.body?.recentMessages,
    });

    // Tone rewrite: the dedicated smsToneRewrite registry route (Claude Sonnet
    // via MODEL_SMS_SONNET — the same model/override the save-the-sale draft
    // lane and its canary monitor share), with OpenAI Terra as the
    // cross-provider backup. Dispatching MODEL_VOICE here instead would
    // silently detach rewrites from the SMS override/canary contract whenever
    // the two env vars diverge. Blank output is rejected so a content-filtered
    // success still reaches the other provider.
    const routed = await require('../services/llm/call').dispatchWithFallback(
      { name: 'smsToneRewrite', primary: MODELS.ROUTES.smsToneRewrite, fallback: MODELS.TEXT_POLICIES.customerCopy.fallback },
      { text: rewritePrompt, jsonMode: false, maxTokens: 500 },
      { validate: (result) => (String(result.text || '').trim() ? null : 'empty_response') },
    );
    const rewriteText = routed.ok ? routed.text : '';

    const rewritten = cleanSmsRewriteOutput(rewriteText);
    if (!rewritten) return res.status(502).json({ error: 'rewrite returned empty message' });
    res.json({ body: rewritten });
  } catch (err) {
    logger.error(`SMS rewrite failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/communications/schedule-sms — schedule SMS for later.
// The /5min scheduled-sms cron in server/services/scheduler.js picks up rows
// where status='scheduled' AND scheduled_for <= now() and dispatches them
// through sendCustomerMessage (same path as the immediate /sms route).
router.post('/schedule-sms', async (req, res, next) => {
  try {
    const { to, body, scheduledFor, customerId, fromNumber, from, messageType, agentDecisionId, agentDraft } = req.body || {};
    const cleanBody = typeof body === 'string' ? body.trim() : '';
    if (!to || !cleanBody || !scheduledFor) {
      return res.status(400).json({ error: 'to, body, scheduledFor required' });
    }
    if (messageType && BLOCKED_SCHEDULED_PURPOSES.has(purposeForScheduledMessageType(messageType))) {
      return res.status(400).json({ error: 'marketing/retention sends are not allowed on this endpoint' });
    }

    // ET wall-clock parse — datetime-local strings without offset are
    // interpreted in ET, ISO strings pass through unchanged.
    const sendAt = parseETDateTime(scheduledFor);
    if (Number.isNaN(sendAt.getTime())) return res.status(400).json({ error: 'invalid scheduledFor' });
    if (sendAt <= new Date()) return res.status(400).json({ error: 'scheduledFor must be in the future' });

    const chosenFrom = fromNumber || from || TWILIO_NUMBERS.getOutboundNumber();
    if (!TWILIO_NUMBERS.findByNumber(chosenFrom)) {
      return res.status(400).json({ error: 'fromNumber must be a Waves Twilio number' });
    }

    let trustedCustomerId = null;
    if (customerId) {
      const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id', 'phone');
      if (!customer) return res.status(404).json({ error: 'customerId not found' });
      const normalizedTo = normalizePhone(to);
      const normalizedCustomerPhone = normalizePhone(customer.phone);
      if (!normalizedTo || !normalizedCustomerPhone || normalizedTo !== normalizedCustomerPhone) {
        return res.status(400).json({ error: 'to must match the selected customer phone' });
      }
      trustedCustomerId = customer.id;
    } else {
      // Digit-normalized, deleted-filtered, ambiguity-aware lookup — a raw
      // exact-string phone match misses formatting variants and can link the
      // scheduled SMS to a soft-deleted or arbitrary duplicate customer.
      const fallback = await findSingleCustomerForPhone(to).catch(() => null);
      if (fallback) trustedCustomerId = fallback.id;
    }

    // An Agent Review draft can be scheduled instead of sent now. Carry the
    // verified decision id on the scheduled row so the 5-min dispatch cron
    // resolves it (accepted/corrected) when the send actually fires —
    // otherwise the suggestion stays pending and gets miscounted as
    // ignored/expired despite a human-approved send.
    let scheduledAgentDecision = null;
    if (agentDecisionId && agentDraft) {
      scheduledAgentDecision = await verifyAgentDecisionForSend({ agentDecisionId, to, trustedCustomerId, outgoingBody: body });
      // Stale card — most often another operator just handled the same
      // suggestion. Queueing anyway would schedule a duplicate reply with
      // no decision linkage to resolve or cancel.
      if (!scheduledAgentDecision) {
        return res.status(409).json({ error: 'This Agent Review draft was just handled elsewhere — refresh the thread before scheduling.' });
      }
    }

    // Operator hand-composed this scheduled SMS unless an unchanged AI draft
    // is being queued through. Persisted as provenance so the dispatch cron
    // can exempt the deferred send from the stale-month guard, same as the
    // immediate manual send. An unchanged agent draft stays month-checked.
    const scheduledBodyIsUnchangedAgentDraft =
      !!scheduledAgentDecision?.suggested_message &&
      normalizeReplyForComparison(cleanBody) === normalizeReplyForComparison(scheduledAgentDecision.suggested_message);
    const scheduledHumanAuthored = !scheduledBodyIsUnchangedAgentDraft;

    // Queue + park in ONE transaction: the used decision AND every other
    // pending house-voice suggestion on this thread move to 'scheduled', so
    // nothing stays actionable in the composer while the queued reply
    // waits. Fire resolves the used one and ignores the parked ones;
    // cancel/failure reopens them all. A park failure rolls the queue
    // insert back — never a queued send with a still-actionable card.
    let row;
    try {
      row = await db.transaction(async (trx) => {
        // Same thread lock as the drafter's publish and the post-send
        // sweep — park + queue commit atomically with respect to both.
        await lockSuggestThread(trx, normalizePhoneLast10(to) || to);

        // Don't queue a reply while an autonomous house-voice reply (Phase E)
        // is mid-send to this thread — it could land as a duplicate when this
        // one dispatches. The 'scheduled' sms_log row inserted below is itself
        // the marker the auto-send's guard sees, so this check only needs to
        // cover the reverse race (auto claimed first). Gated → no-op while
        // auto-send is dormant.
        if (isEnabled('smsAutoSend')
          && await autoSendExecutor.hasActiveAutoSendClaim(trx, { threadLast10: normalizePhoneLast10(to), customerId: trustedCustomerId })) {
          const conflict = new Error('An automated reply is going out to this conversation right now — refresh in a moment before scheduling.');
          conflict.statusCode = 409;
          throw conflict;
        }

        let usedDecisionId = null;
        if (scheduledAgentDecision) {
          const parkedUsed = await markSuggestionScheduled(
            { decisionId: scheduledAgentDecision.id, scheduledFor: sendAt }, trx
          );
          // 0 rows = a concurrent request claimed/resolved this decision
          // between verification and the guarded park. Queueing anyway
          // would double-send the same reply — abort and roll back.
          if (parkedUsed === 0) {
            const conflict = new Error('This Agent Review draft was just handled elsewhere — refresh the thread before sending.');
            conflict.statusCode = 409;
            throw conflict;
          }
          usedDecisionId = scheduledAgentDecision.id;
        }
        const parkedIds = await parkThreadSuggestions(
          { phoneLast10: normalizePhoneLast10(to), excludeDecisionId: scheduledAgentDecision?.id }, trx
        );

        const metaObj = {};
        if (usedDecisionId) metaObj.agent_decision_id = usedDecisionId;
        if (parkedIds.length) metaObj.parked_decision_ids = parkedIds;
        if (scheduledHumanAuthored) metaObj.human_authored = true;
        const metadata = Object.keys(metaObj).length ? JSON.stringify(metaObj) : null;

        const [inserted] = await trx('sms_log')
          .insert({
            customer_id: trustedCustomerId,
            direction: 'outbound',
            from_phone: chosenFrom,
            to_phone: to,
            message_body: cleanBody,
            status: 'scheduled',
            message_type: messageType || 'manual',
            admin_user_id: req.technicianId || null,
            scheduled_for: sendAt,
            metadata,
          })
          .returning(['id', 'scheduled_for']);
        return inserted;
      });
    } catch (scheduleErr) {
      if (scheduleErr.statusCode === 409) return res.status(409).json({ error: scheduleErr.message });
      throw scheduleErr;
    }

    // Scheduling a reply is the operator's response act — stamp the
    // Speed-to-Lead clock NOW (the scheduled-SMS cron replays human and
    // automation rows under one entry point, so fire time can't tell them
    // apart; the decision to respond already happened here). If the queued
    // send later fails, the failure alert lane surfaces it.
    try {
      const { stampFirstResponseByContact } = require('../services/lead-estimate-link');
      await stampFirstResponseByContact({
        phone: to,
        performedBy: req.technicianId ? `admin:${req.technicianId}` : 'admin',
      });
    } catch (stampErr) {
      logger.warn(`[admin-communications] scheduled-reply first-response stamp failed: ${stampErr.message}`);
    }

    res.json({ success: true, id: row?.id, scheduledFor: sendAt.toISOString() });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/scheduled — list scheduled messages
router.get('/scheduled', async (req, res, next) => {
  try {
    const scheduled = await db('sms_log')
      .where({ status: 'scheduled' })
      .leftJoin('customers', 'sms_log.customer_id', 'customers.id')
      .select('sms_log.*', 'customers.first_name', 'customers.last_name')
      .orderBy('scheduled_for', 'asc');

    res.json({
      messages: scheduled.map(m => ({
        id: m.id, to: m.to_phone, from: m.from_phone, body: m.message_body,
        customerName: m.first_name ? `${m.first_name} ${m.last_name || ''}`.trim() : null,
        scheduledFor: m.scheduled_for, createdAt: m.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// DELETE /api/admin/communications/scheduled/:id — cancel scheduled message
router.delete('/scheduled/:id', async (req, res, next) => {
  try {
    // Peek (no delete yet) just to learn the thread key for the lock.
    const peek = await db('sms_log')
      .where({ id: req.params.id, status: 'scheduled' })
      .first('id', 'to_phone');
    if (!peek) return res.json({ success: true });
    const threadLast10 = normalizePhoneLast10(peek.to_phone);

    // Lock the thread BEFORE deleting, and resolve the decisions before the
    // lock releases: in the gap between an unlocked delete and the decision
    // handling, a concurrent publish sees neither the queued row nor the
    // still-parked old decisions, inserts a fresh card, and a later reopen
    // would resurrect stale cards beside it. (The ignore/reopen helpers run
    // on their own connections but complete before this commit releases the
    // lock, so the next locked path reads final state.)
    await db.transaction(async (trx) => {
      if (threadLast10) await lockSuggestThread(trx, threadLast10);

      // Atomic delete-with-returning: if the dispatch cron claimed the row
      // (status flipped to 'sending') between the peek and this delete,
      // zero rows return and we must NOT touch the decisions — the SMS is
      // about to send and fire-time resolution owns them.
      const deleted = await trx('sms_log')
        .where({ id: req.params.id, status: 'scheduled' })
        .del(['id', 'metadata', 'created_at']);
      const row = deleted?.[0];
      if (!row) return;

      const meta = parseJson(row.metadata, {});
      const decisionIds = [
        meta.agent_decision_id,
        ...(Array.isArray(meta.parked_decision_ids) ? meta.parked_decision_ids : []),
      ].filter(Boolean);
      if (!decisionIds.length) return;

      if (threadLast10) {
        // Another queued staff reply on this thread will still answer the
        // customer — reopening now would put an actionable card on top of
        // it. Re-park the decisions behind the surviving row: its fire
        // ignores them, its cancel/failure reopens them. Prefer a
        // still-'scheduled' sibling: a 'sending' one has been claimed by
        // the cron, which re-reads metadata after every terminal update —
        // so a transfer onto it still resolves, but an unclaimed row
        // avoids even that window.
        const sibling = await trx('sms_log')
          .whereIn('status', ['scheduled', 'sending'])
          .whereIn('message_type', HUMAN_REPLY_TYPES)
          .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10])
          .orderByRaw("CASE WHEN status = 'scheduled' THEN 0 ELSE 1 END")
          .orderBy('scheduled_for', 'asc')
          .first('id');
        if (sibling) {
          await trx('sms_log')
            .where({ id: sibling.id })
            .update({
              metadata: trx.raw(
                `jsonb_set(COALESCE(metadata, '{}'::jsonb), '{parked_decision_ids}', COALESCE(metadata->'parked_decision_ids', '[]'::jsonb) || ?::jsonb)`,
                [JSON.stringify(decisionIds)]
              ),
            });
          return;
        }

        // No live sibling — but one may have JUST flipped sending→sent
        // while this cancel ran. The thread was answered since these
        // decisions were parked, so they resolve as ignored (drafts back
        // to the judge), not reopened onto an answered thread.
        const sentSibling = await trx('sms_log')
          .where({ direction: 'outbound' })
          .whereIn('status', ['queued', 'sent', 'delivered'])
          .whereIn('message_type', HUMAN_REPLY_TYPES)
          .whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10])
          .where('created_at', '>', row.created_at)
          .first('id');
        if (sentSibling) {
          await ignoreParkedSuggestions({ decisionIds, reviewedBy: req.technicianId || 'Admin' });
          return;
        }
      }

      // No surviving or just-sent reply — the customer was never answered,
      // the cards return to the composer.
      await reopenScheduledSuggestions({
        decisionIds,
        reason: 'Scheduled send cancelled from the SMS inbox — suggestion reopened.',
      });
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── Blocked numbers (PR 4 inbox/block UX) ──
 * These are thin wrappers over the PR-1 `blocked_numbers` schema — the voice
 * rejection path reads from the same table, and admin-call-recordings.js owns
 * the call-disposition-as-spam flow. Surfaced here so the SMS inbox can block
 * without routing through the calls tab. */

// GET /api/admin/communications/blocked-numbers — list + set for client-side filter
router.get('/blocked-numbers', async (req, res, next) => {
  try {
    const rows = await db('blocked_numbers').orderBy('blocked_at', 'desc');
    res.json({
      numbers: rows.map(r => ({
        number: r.number,
        blockType: r.block_type,
        reason: r.reason,
        autoBlocked: !!r.auto_blocked,
        blockedAt: r.blocked_at,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/communications/blocked-numbers — add a number
// Body: { number, blockType?, reason? }
router.post('/blocked-numbers', async (req, res, next) => {
  try {
    const { number, blockType, reason } = req.body;
    if (!number) return res.status(400).json({ error: 'number required' });

    const existing = await db('blocked_numbers').where({ number }).first();
    if (existing) return res.json({ success: true, alreadyBlocked: true });

    await db('blocked_numbers').insert({
      number,
      block_type: blockType || 'hard_block',
      blocked_by: req.technicianId,
      reason: reason || null,
      auto_blocked: false,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/communications/blocked-numbers/:number — unblock
router.delete('/blocked-numbers/:number', async (req, res, next) => {
  try {
    await db('blocked_numbers').where({ number: req.params.number }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/compliance-export
// Query: customerId?, phone?, days?, format=json|csv
router.get('/compliance-export', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parsePositiveInt(req.query.days) || 90, 1), 730);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const format = String(req.query.format || 'json').toLowerCase();
    const normalizedPhone = normalizeCompliancePhone(req.query.phone || '');

    let auditQuery = db('messaging_audit_log')
      .where({ channel: 'sms' })
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .limit(2000);

    if (req.query.customerId) auditQuery = auditQuery.where({ customer_id: req.query.customerId });
    if (normalizedPhone) auditQuery = auditQuery.where({ to_hash: phoneHash(normalizedPhone) });

    const auditRows = await auditQuery.select(
      'id',
      'created_at',
      'customer_id',
      'to_last4',
      'audience',
      'purpose',
      'entry_point',
      'identity_trust_level',
      'body_preview',
      'segment_count',
      'encoding',
      'consent_status',
      'consent_source',
      'consent_campaign',
      'validators_passed',
      'validators_failed',
      'blocked_code',
      'blocked_reason',
      'provider',
      'provider_message_id',
      'sent_at',
      'provider_error',
      'metadata'
    );

    let suppressionRows = [];
    if (normalizedPhone) {
      suppressionRows = await db('messaging_suppression')
        .where({ phone: normalizedPhone })
        .orderBy('created_at', 'desc')
        .limit(50)
        .catch((err) => {
          if (/does not exist|messaging_suppression/i.test(err.message)) return [];
          throw err;
        });
    }

    let contactChecks = [];
    if (normalizedPhone) {
      contactChecks = await db('sms_contact_compliance_checks')
        .where({ phone_hash: phoneHash(normalizedPhone) })
        .orderBy('checked_at', 'desc')
        .limit(50)
        .catch((err) => {
          if (/does not exist|sms_contact_compliance_checks/i.test(err.message)) return [];
          throw err;
        });
    }

    if (format === 'csv') {
      const columns = [
        'id', 'created_at', 'customer_id', 'to_last4', 'audience', 'purpose',
        'entry_point', 'identity_trust_level', 'body_preview', 'segment_count',
        'encoding', 'consent_status', 'consent_source', 'consent_campaign',
        'validators_passed', 'validators_failed', 'blocked_code', 'blocked_reason',
        'provider', 'provider_message_id', 'sent_at', 'provider_error', 'metadata',
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="waves-sms-compliance-${Date.now()}.csv"`);
      return res.send(rowsToCsv(auditRows, columns));
    }

    res.json({
      days,
      customerId: req.query.customerId || null,
      phoneLast4: normalizedPhone ? normalizedPhone.replace(/\D/g, '').slice(-4) : null,
      audit: auditRows,
      suppression: suppressionRows.map((row) => ({
        phoneLast4: String(row.phone || '').replace(/\D/g, '').slice(-4),
        reason: row.reason,
        active: !!row.active,
        source: row.source,
        capturedBody: row.captured_body,
        createdAt: row.created_at,
        clearedAt: row.cleared_at,
      })),
      contactChecks: contactChecks.map((row) => ({
        phoneLast4: row.phone_last4,
        source: row.source,
        lineType: row.line_type,
        carrier: row.carrier,
        dncListed: row.dnc_listed,
        reassignedRisk: row.reassigned_risk,
        checkedAt: row.checked_at,
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/template-performance?days=30
router.get('/template-performance', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parsePositiveInt(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await db('messaging_audit_log')
      .where({ channel: 'sms' })
      .where('created_at', '>=', since)
      .select(db.raw("COALESCE(metadata->>'original_message_type', purpose, 'unknown') as template_key"))
      .select(db.raw("COALESCE(metadata->>'sms_variant_key', '') as variant_key"))
      .count('* as attempts')
      .sum({ segments: 'segment_count' })
      .select(db.raw("SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) as sent"))
      .select(db.raw("SUM(CASE WHEN blocked_code IS NOT NULL THEN 1 ELSE 0 END) as blocked"))
      .select(db.raw("SUM(CASE WHEN provider_error IS NOT NULL THEN 1 ELSE 0 END) as provider_failures"))
      .groupByRaw("COALESCE(metadata->>'original_message_type', purpose, 'unknown'), COALESCE(metadata->>'sms_variant_key', '')")
      .orderBy('attempts', 'desc');

    res.json({
      days,
      templates: rows.map((row) => {
        const attempts = Number(row.attempts || 0);
        const sent = Number(row.sent || 0);
        const blocked = Number(row.blocked || 0);
        const providerFailures = Number(row.provider_failures || 0);
        return {
          templateKey: row.template_key,
          variantKey: row.variant_key || null,
          attempts,
          sent,
          blocked,
          providerFailures,
          segments: Number(row.segments || 0),
          sendRate: attempts ? sent / attempts : 0,
          blockRate: attempts ? blocked / attempts : 0,
        };
      }),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/communications/contact-compliance-checks
// Manual/provider-import scaffold for DNC/RND/line-type results.
router.post('/contact-compliance-checks', async (req, res, next) => {
  try {
    const normalized = normalizeCompliancePhone(req.body?.phone);
    if (!normalized) return res.status(400).json({ error: 'valid phone required' });
    const digits = normalized.replace(/\D/g, '');
    const [row] = await db('sms_contact_compliance_checks')
      .insert({
        phone_hash: phoneHash(normalized),
        phone_last4: digits.slice(-4),
        source: String(req.body.source || 'manual').slice(0, 40),
        line_type: req.body.lineType || req.body.line_type || null,
        carrier: req.body.carrier || null,
        dnc_listed: req.body.dncListed ?? req.body.dnc_listed ?? null,
        reassigned_risk: req.body.reassignedRisk ?? req.body.reassigned_risk ?? null,
        consent_checked_at: req.body.consentCheckedAt || req.body.consent_checked_at || null,
        raw_result: req.body.rawResult || req.body.raw_result || {},
      })
      .returning(['id', 'checked_at']);
    res.status(201).json({ success: true, id: row?.id, checkedAt: row?.checked_at });
  } catch (err) { next(err); }
});

// GET /api/admin/communications/collections-voice-status — kill-switch
// dashboard read for the collections outbound-voice lane (PR B). Read-only:
// gate states, case counts by state, and the last few call outcomes off the
// collections contact ledger (masked; no PII beyond what the admin bell
// already shows). Safe with the lane dark — every count is simply zero.
router.get('/collections-voice-status', async (req, res, next) => {
    let queryFailed = null;
  try {
    const { isVoiceLatePaymentEnabled, isPayLinkEnabled, isAutoDialEnabled } = require('../services/collections/outbound-voice/gates');
    const { retentionDays } = require('../services/collections/outbound-voice/retention');

    const caseRows = await db('collection_cases')
      .select('current_state')
      .count('* as count')
      .groupBy('current_state')
      .catch((err) => { queryFailed = err.message; return []; });
    const caseCounts = {};
    for (const row of caseRows) caseCounts[row.current_state] = parseInt(row.count, 10);

    const recent = await db('collections_contact_ledger')
      .where({ channel: 'voice', source: 'collections_voice' })
      .orderBy('occurred_at', 'desc')
      .limit(10)
      .select('id', 'customer_id', 'occurred_at', 'metadata')
      .catch((err) => { queryFailed = err.message; return []; });
    const lastOutcomes = recent.map((r) => {
      const meta = typeof r.metadata === 'string'
        ? (() => { try { return JSON.parse(r.metadata); } catch { return {}; } })()
        : (r.metadata || {});
      return {
        occurredAt: r.occurred_at,
        customerId: r.customer_id,
        outcome: meta.outcome || 'dialed',
        liveConversation: Boolean(meta.live_conversation),
        voicemailLeft: Boolean(meta.voicemail_left),
        payLinkSent: Boolean(meta.pay_link_sent),
        sendFailed: Boolean(meta.send_failed),
      };
    });

    if (queryFailed) {
      // A dashboard read failure must SURFACE (gh prb-r8), never render as
      // an empty-but-healthy lane.
      return res.status(503).json({ error: 'collections_status_unavailable', detail: queryFailed });
    }
    res.json({
      gates: {
        GATE_VOICE_LATE_PAYMENT: isVoiceLatePaymentEnabled(),
        GATE_VOICE_LATE_PAYMENT_PAYLINK: isPayLinkEnabled(),
        GATE_COLLECTIONS_POLICY: process.env.GATE_COLLECTIONS_POLICY === 'true',
        GATE_COLLECTIONS_SHADOW: process.env.GATE_COLLECTIONS_SHADOW === 'true',
        // Effective state (codex gh-r1 P2): an armed auto-dial and a
        // disabled sweep must never look identical on the kill-switch view.
        GATE_VOICE_LATE_PAYMENT_AUTODIAL: isAutoDialEnabled(),
      },
      retentionDays: retentionDays(),
      caseCounts,
      lastOutcomes,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/communications/collections-cases/:id/dial — the SUPERVISED
// single-dial lever (PR C): the shakedown tool and the standing manual
// escape hatch. Admin-only (requireAdmin — this places a phone call), and
// refuses entirely while the master gate is dark. Promotes a 'shadow' or
// 'proposed' case to 'approved' (guarded on state + case_version; a
// concurrent move loses cleanly) stamped with the acting admin, then hands
// it to originateCollectionCall — which re-runs the FULL contact policy at
// dial time and fails closed on every leg. This endpoint makes no
// eligibility judgment of its own; the policy engine is the boundary.
router.post('/collections-cases/:id/dial', requireAdmin, async (req, res, next) => {
  try {
    const { isVoiceLatePaymentEnabled } = require('../services/collections/outbound-voice/gates');
    if (!isVoiceLatePaymentEnabled()) {
      return res.status(409).json({ error: 'lane_dark', detail: 'GATE_VOICE_LATE_PAYMENT is off' });
    }
    // UUID guard (codex gh-r2): a malformed id would make Postgres throw a
    // 22P02 cast error and turn a bad identifier into a 500.
    if (!UUID_RE.test(String(req.params.id || ''))) {
      return res.status(400).json({ error: 'invalid_case_id' });
    }
    const caseRow = await db('collection_cases')
      .where({ id: req.params.id })
      .first('id', 'current_state', 'case_version', 'idempotency_key');
    if (!caseRow) return res.status(404).json({ error: 'case_not_found' });

    if (caseRow.current_state === 'shadow' || caseRow.current_state === 'proposed') {
      const now = new Date();
      const promoted = await db('collection_cases')
        .where({ id: caseRow.id, current_state: caseRow.current_state, case_version: caseRow.case_version })
        .update({
          current_state: 'approved',
          approved_by: `admin:${req.technician?.email || req.technicianId || 'unknown'}`,
          approved_at: now,
          approval_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          hold_reason: null,
          updated_at: db.fn.now(),
        });
      if (!promoted) {
        return res.status(409).json({ error: 'case_moved', detail: 'the case changed state while approving — reload and retry' });
      }
      // The shadow proposal card says "no call will be placed" — no longer
      // true once the promotion holds (codex gh-r2). Best-effort retire.
      const { retireProposalCard } = require('../services/collections/outbound-voice/dial-sweep');
      await retireProposalCard(caseRow.idempotency_key);
    } else if (caseRow.current_state !== 'approved') {
      // held / cancelled / expired / dialing — never dialable from here.
      return res.status(409).json({ error: 'case_not_dialable', state: caseRow.current_state });
    }

    const { originateCollectionCall } = require('../services/collections/outbound-voice/origination');
    const result = await originateCollectionCall(caseRow.id);
    // Refusals are the policy speaking — return them verbatim, 200: the
    // admin asked "try to dial", and "policy said no, case re-queued" is a
    // successful answer to that question.
    return res.json(result);
  } catch (err) { next(err); }
});

router._internals = {
  buildSmsRewritePrompt,
  cleanSmsRewriteOutput,
  csvEscape,
  fullPhoneLast10,
  isElapsedSameDayReschedulePlaceholder,
  normalizeRewriteRecentMessages,
  rowsToCsv,
};

module.exports = router;
