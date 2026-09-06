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

// Composer-carried prep links: the provider call AND the tagger's replay
// marker (markPrepGuidesSent) run under the manual sender's own
// per-customer `prep-send:<customer>` lock, so a manual send for the same
// customer never interleaves with this dispatch's claim → send → stamp
// (GH Codex #3856 r22 P0; the sender no longer re-keys reservations at all,
// r23 P0). The links are re-validated INSIDE the lock right before dispatch
// (`recheck`): the pre-lock bearer check can have verified a manual send's
// provisional page that failed and was released before the lock was ours
// (pre-push Codex P1 on 7f82e7564); a refusal is a not-sent result. A held lease is an operator-facing "try again",
// never a wait — reported as a not-sent result so the route's own no-send
// exit releases every claim taken before dispatch. A throw the provider
// accepted (err.providerOutcome.sent === true) still writes the marker
// before propagating; a lost marker never fails a text that already left.
async function dispatchPrepLinkSend(preps, dispatch, actorId, recheck) {
  const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
  // The bookkeeping uses the entries the in-lock recheck resolved — the
  // guide each page renders NOW — never the pre-lock ones (pre-push Codex
  // P1 on e8b68e9cc).
  let live = preps;
  const mark = async (label) => {
    try {
      await require('../services/composer-customer-links').markPrepGuidesSent(live, actorId);
    } catch (stampErr) {
      logger.warn(`[communications] prep sent marker failed ${label}: ${stampErr.message}`);
    }
  };
  const customerIds = [...new Set(preps.map((p) => p.customerId))];
  const locked = async (i) => {
    if (i < customerIds.length) {
      return runExclusive(`prep-send:${customerIds[i]}`, () => locked(i + 1), { recordHealth: false, waitForSlot: false });
    }
    const fresh = await recheck();
    if (!fresh.ok) return { sent: false, blocked: false, reason: fresh.error };
    if (fresh.preps) live = fresh.preps;
    let result;
    try {
      result = await dispatch();
    } catch (err) {
      if (err?.providerOutcome?.sent === true) await mark('after a throw');
      throw err;
    }
    if (result?.sent && require('../services/sms-auto-send').isRealProviderSend(result)) await mark('(text already sent)');
    return result;
  };
  const outcome = await locked(0);
  if (wasLockSkipped(outcome)) {
    return { sent: false, blocked: false, reason: 'A prep guide is being sent to this customer right now — try again in a moment.' };
  }
  return outcome;
}

// POST /api/admin/communications/sms — send an SMS from admin
router.post('/sms', async (req, res, next) => {
  let claimedDecisionId = null;
  let manualReservationId = null;
  let parkedThreadIds = [];
  let claimedReviewRequestId = null;
  let claimedReviewClaimToken = null;
  let reviewEmailOutcome = null;
  // Quick Links "Both": once the text has really sent, the same ask goes out
  // by email too (ReviewService.sendInlineEmailCopy). Hoisted: the catch
  // below emails after an accepted-but-thrown send.
  let reviewRequestEmail = false;
  // Composer-carried card request links: the visit-level send claim won
  // before dispatch (claimCardRequestSends) — released on every no-send
  // exit, marked after a real provider send.
  let cardClaim = null;
  // Composer-carried project report links: the project send flow's own
  // delivery claim, taken before dispatch (claimProjectReportSends) and
  // handed back on every exit once the provider has answered — the text is
  // a re-share, never a delivery.
  let projectClaim = null;
  // Verified composer statement links — a real send is their first delivery.
  let statementLinkIds = null;
  // Verified composer prep links — a real send writes the tagger's dedupe marker.
  let prepLinkSends = null;
  // Composer-carried contract signing links: a prepared link is ACTIVATED
  // (delivered state stamped, windowed from the send) before the provider
  // call — handed back on every no-send exit, recorded after a real send.
  let contractActivations = null;
  const restoreContractLinks = async () => {
    if (!contractActivations) return;
    const activations = contractActivations;
    contractActivations = null;
    try {
      await require('./admin-contracts').restorePreparedShareLinks(activations, req, { reason: 'Send was not attempted, blocked, or failed' });
    } catch (restoreErr) {
      logger.warn(`[communications] prepared contract link restore failed (the row keeps its activated link until it expires): ${restoreErr.message}`);
    }
  };
  const releaseCardClaim = async () => {
    if (!cardClaim) return;
    const claim = cardClaim;
    cardClaim = null;
    try {
      await require('../services/composer-customer-links').releaseCardRequestSends(claim);
    } catch (releaseErr) {
      logger.warn(`[communications] card request claim release failed (the service's stale-claim lease recovers it): ${releaseErr.message}`);
    }
  };
  const releaseProjectClaim = async () => {
    if (!projectClaim) return;
    const claim = projectClaim;
    projectClaim = null;
    try {
      await require('../services/composer-customer-links').releaseProjectReportSends(claim);
    } catch (releaseErr) {
      logger.warn(`[communications] project report claim release failed (the send flow's stale-claim takeover recovers it): ${releaseErr.message}`);
    }
  };
  // AMBIGUOUS provider outcome (GH Codex #3851 r4 P1 — the card funnel's own
  // rule): a provider-phase retryable/deferred result (Twilio timeout, 5xx,
  // 429) is NOT a definitive no-send — the provider may already hold the
  // message. blocked:true is a validator stop and stays definitive. Bearer
  // state is kept consumed: the card claim finalizes through the service's
  // maybe-sent marker (no email twin — nothing is known to have left, and
  // the marker is what the stale lease reads), and an activated contract
  // link stays live for the customer who may hold it. A definitively-lost
  // send surfaces through the office lanes, never as a second bearer link.
  const holdBearerStateAmbiguous = async (result) => {
    const code = result?.code || 'no_code';
    if (contractActivations) {
      const ids = contractActivations.map((a) => a.id).join(', ');
      contractActivations = null;
      logger.error(`[communications] send outcome RETRYABLE-ambiguous (${code}) — prepared contract links stay activated (${ids})`);
    }
    // The project delivery claim stays too (GH Codex #3893 r12 P1): the
    // provider may still hold the text, and restoring the row's state would
    // let a resend start inside that window. The send flow's own stale-claim
    // takeover (ten minutes) recovers the row, as after a crashed send.
    if (projectClaim) {
      const claim = projectClaim;
      projectClaim = null;
      logger.error(`[communications] send outcome RETRYABLE-ambiguous (${code}) — keeping the project report delivery claim for projects ${claim.projects.map((p) => p.id).join(', ')}`);
    }
    if (cardClaim) {
      const claim = cardClaim;
      cardClaim = null;
      logger.error(`[communications] send outcome RETRYABLE-ambiguous (${code}) — keeping the card request claim for visits ${claim.cards.map((c) => c.scheduledServiceId).join(', ')}`);
      try {
        await require('../services/composer-customer-links').markCardRequestSends(claim, { emailTwin: false });
      } catch (markErr) {
        logger.warn(`[communications] card request maybe-sent marker failed (the service's lease + park recover it): ${markErr.message}`);
      }
    }
  };
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
      // Composer Quick Links: a pending inline review_requests row whose link
      // rides in this body — marked delivered after a real send (below).
      reviewRequestId,
      // Composer Insert Link: the contract a freshly inserted (unwritten)
      // signing link belongs to — activated before the provider call.
      contractId,
    } = req.body;
    reviewRequestEmail = req.body.reviewRequestEmail === true;
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

    // A composer-inserted review link rides this body — CLAIM the inline row
    // BEFORE the provider call. createInline deliberately hands every
    // composer the SAME pending unscheduled row (single live token), so two
    // tabs or operators can both reach here holding this id before either's
    // post-send mark lands; the conditional claim lets exactly one through
    // and rejects the loser here, so at most one ask ever texts the
    // customer. FAIL CLOSED on EVERY validation miss: a supplied
    // reviewRequestId that doesn't verify completely (real inline row, its
    // link in this body, the recipient owning it, the claim won) aborts the
    // send — the tokenized review page carries customer/service data, so a
    // mismatched recipient must never receive it, and an unverifiable state
    // must never send untracked. Only a request with NO reviewRequestId
    // sends unclaimed.
    // Shared by the review-link and Auto Pay-link pre-send seams below.
    const abortUnsent = async (status, error) => {
      await clearManualReservation();
      await releaseCardClaim();
      await releaseProjectClaim();
      await restoreContractLinks();
      await reopenScheduledSuggestions({
        decisionIds: [claimedDecisionId, ...parkedThreadIds],
        reason: 'Send was not attempted — suggestion reopened.',
      });
      return res.status(status).json({ error });
    };
    // Composer-inserted Auto Pay setup link (or a pasted one): re-run the
    // check BEFORE the review claim below, so a refusal never strands a
    // claimed review row in 'sending' (GH Codex #3812 r4 P2). Re-run the
    // canonical levers + row liveness + ownership NOW (the insert-time check
    // is stale once a draft sits open) and reclassify the send so
    // send-customer-message's Auto Pay gate applies at delivery. FAIL CLOSED
    // on any miss (GH Codex #3812 r2 P1/P2).
    let autopayLinkTokens = null;
    try {
      const { autopayLinkSendCheck } = require('../services/composer-customer-links');
      const autopayCheck = await autopayLinkSendCheck(cleanBody, normalizePhoneLast10(to), { trustedCustomerId: trustedCustomerId || null });
      if (autopayCheck.present && !autopayCheck.ok) return abortUnsent(409, autopayCheck.error);
      if (autopayCheck.present) autopayLinkTokens = autopayCheck.tokens;
    } catch (autopayErr) {
      logger.warn(`[communications] Auto Pay link pre-send check failed — aborting send: ${autopayErr.message}`);
      return abortUnsent(503, 'Could not verify the inserted Auto Pay setup link — try again in a moment.');
    }
    // The other per-row bearers (contract signing, visit-lane card request,
    // prep guide, payer statement): liveness + recipient ownership NOW, fail
    // closed — same bar as above. A prepared contract link is then ACTIVATED
    // (GH Codex #3844 r3 P1 — delivery state stamped before the provider
    // call, as the document delivery does; rotated meanwhile refuses) and a
    // live card request CLAIMED before the provider call — the visit's
    // one-text-ever claim, exactly as the service's own SMS path takes it
    // (GH Codex #3844 r1 P1 + pre-push P1): a lost claim (another tab
    // mid-send, or a text already out) refuses here; every later exit
    // restores/releases or records/marks them.
    try {
      const { bearerLinkSendCheck, claimCardRequestSends, claimProjectReportSends } = require('../services/composer-customer-links');
      const bearerCheck = await bearerLinkSendCheck(cleanBody, normalizePhoneLast10(to), {
        trustedCustomerId: trustedCustomerId || null,
        // The seam binds by the last ten digits; a non-US E.164 destination
        // sharing them with a customer's US number is a different phone.
        usDestination: /^\+1\d{10}$/.test(String(normalizePhone(to) || '')),
        contractId: contractId && UUID_RE.test(String(contractId)) ? String(contractId) : null,
      });
      if (!bearerCheck.ok) return abortUnsent(409, bearerCheck.error);
      if (bearerCheck.statements) statementLinkIds = bearerCheck.statements;
      if (bearerCheck.preps) prepLinkSends = bearerCheck.preps;
      // A bearer send to a number exactly one live customer owns is that
      // customer's text (a pasted URL never passes /customer-link to adopt
      // its owner): trust the row the seam verified so the recipient's own
      // consent policy applies, never the unverified-lead one (GH Codex
      // #3844 r9 P1). The seam already refused an ambiguous number.
      if (!trustedCustomerId && bearerCheck.customerId) trustedCustomerId = bearerCheck.customerId;
      if (bearerCheck.contracts) {
        const activation = await require('./admin-contracts').activatePreparedShareLinks(bearerCheck.contracts, req);
        if (!activation.ok) return abortUnsent(409, activation.error);
        contractActivations = activation.activations;
      }
      if (bearerCheck.cards) {
        const claim = await claimCardRequestSends(bearerCheck.cards);
        if (!claim.ok) return abortUnsent(409, claim.error);
        cardClaim = claim.claim;
      }
      // The project send flow's delivery claim, held through the provider
      // handoff (GH Codex #3893 r11 P1): a resend that starts now 409s on
      // its own claim instead of texting the same report twice.
      if (bearerCheck.projectReports) {
        const claim = await claimProjectReportSends(bearerCheck.projectReports);
        if (!claim.ok) return abortUnsent(409, claim.error);
        projectClaim = claim.claim;
      }
    } catch (bearerErr) {
      logger.warn(`[communications] bearer link pre-send check failed — aborting send: ${bearerErr.message}`);
      return abortUnsent(503, 'Could not verify a customer link in this message — try again in a moment.');
    }

    if (reviewRequestId) {
      try {
        const ReviewService = require('../services/review-request');
        const rr = await db('review_requests')
          .where({ id: String(reviewRequestId) })
          .first('id', 'customer_id', 'status', 'sms_sent_at', 'triggered_by', 'token');
        if (!rr || rr.triggered_by !== 'auto_inline') {
          return abortUnsent(409, 'The inserted review link could not be verified — remove it from the message and re-insert.');
        }
        const { existingShortUrlFor } = require('../services/short-url');
        const short = await existingShortUrlFor({ kind: 'review', entityType: 'review_requests', entityId: rr.id });
        // Canonical match: scheme dropped and the HOST compared case-
        // insensitively (a host-case edit of a still-live URL must not read
        // as "link gone" and 409 a valid send), but the PATH exactly — review
        // tokens and short codes are case-sensitive, so a case-mangled path
        // is a dead link and must not verify as the ask.
        const bodyCarriesLink = (frag) => {
          const bare = String(frag).replace(/^https?:\/\//i, '');
          const slash = bare.indexOf('/');
          if (slash < 0) return cleanBody.includes(bare); // bare token — exact
          const host = bare.slice(0, slash).toLowerCase();
          const path = bare.slice(slash);
          for (let at = cleanBody.indexOf(path); at >= 0; at = cleanBody.indexOf(path, at + 1)) {
            if (at >= host.length && cleanBody.slice(at - host.length, at).toLowerCase() === host) return true;
          }
          return false;
        };
        const linkInBody = [short, rr.token].filter(Boolean).some(bodyCarriesLink);
        if (!linkInBody) {
          // The client forgets the tracked entry when the operator deletes
          // the line — an id arriving without its link is an anomaly, not a
          // flow.
          return abortUnsent(409, 'The review link is no longer in the message — remove the review request and try again.');
        }
        const owner = await db('customers').where({ id: rr.customer_id }).first('id', 'phone');
        if (!owner || normalizePhoneLast10(owner.phone) !== normalizePhoneLast10(to)) {
          return abortUnsent(422, 'This review link belongs to a different customer — remove it before sending.');
        }
        // Live consent + the ask gates + the claim, serialized under the same
        // per-customer review lock the mint runs under: a draft can sit open
        // for hours, so the MINT-time gate is stale — a cadence or one-off
        // ask may have delivered since (withdrawn unscheduled rows persist
        // and are invisible to the other gates), and the customer may have
        // switched review requests to email or off. Re-validate at the
        // delivery seam so this send can't breach the cooldown/cap or text an
        // email-only customer.
        const { runExclusive } = require('../utils/cron-lock');
        const seam = await runExclusive(
          `review-send:${rr.customer_id}`,
          async () => {
            const consent = await ReviewService.reviewSmsAllowedNow(rr.customer_id);
            if (!consent.allowed) return { consent };
            const gate = await ReviewService.checkUnscheduledAskGates(rr.customer_id);
            if (!gate.allowed) return { gate };
            // Both stamps the owed email leg on the claim itself, so the
            // Quick Links retry path has persisted evidence this ask asked
            // for an email (GH Codex #3856 r8 P1).
            return { claimed: await ReviewService.claimInlineForSend(rr.id, { emailRequested: reviewRequestEmail === true }) };
          },
          { recordHealth: false },
        );
        if (seam?.skipped) {
          return abortUnsent(409, 'A review request to this customer is already being sent — try again in a moment.');
        }
        if (seam.consent) {
          return abortUnsent(422, 'This customer can no longer receive a review request by text (preferences, already-reviewed flag, or the record was removed) — remove the review link before sending.');
        }
        if (seam.gate) {
          const { REVIEW_GATE_REASONS } = require('../services/composer-customer-links');
          return abortUnsent(409, `${REVIEW_GATE_REASONS[seam.gate.outcome] || 'Review request blocked'} — remove the review link before sending.`);
        }
        if (!seam.claimed) {
          return abortUnsent(409, 'This review link was already sent or canceled — remove it from the message and re-insert if still needed.');
        }
        claimedReviewRequestId = rr.id;
        claimedReviewClaimToken = seam.claimed;
        // Final pre-provider fence: the token we hold must still be the live
        // claim (a stale-claim reclaim by another send supersedes it).
        if (!(await ReviewService.inlineClaimStillHeld(rr.id, claimedReviewClaimToken))) {
          claimedReviewRequestId = null;
          return abortUnsent(409, 'This review link was just claimed by another send — remove it and re-insert if still needed.');
        }
      } catch (claimErr) {
        logger.warn(`[communications] inline review pre-send claim failed — aborting send (requestId=${reviewRequestId}): ${claimErr.message}`);
        // A claim already won before the throw (e.g. the fence re-check
        // errored) must be handed back, or the row sits 'sending' and blocks
        // retries for the whole stale window.
        if (claimedReviewRequestId) {
          try {
            await require('../services/review-request').releaseInlineClaim(claimedReviewRequestId, claimedReviewClaimToken);
          } catch (releaseErr) {
            logger.warn(`[communications] inline review claim release failed (requestId=${claimedReviewRequestId}): ${releaseErr.message}`);
          }
          claimedReviewRequestId = null;
        }
        return abortUnsent(503, 'Could not verify the inserted review link — try again in a moment.');
      }
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
    // A composer-carried card request link makes this the visit's card
    // request text itself: the canonical purpose (its policy allows the 3
    // segments a reused legacy 64-hex token reaches; the customer id and
    // phone-matched trust it requires are already enforced by the seam), the
    // template key the funnel stamps (reporting groups it with the funnel's
    // own sends) and the operator-initiated flag the funnel's admin trigger
    // carries. Under the conversational policy's 2-segment cap the send was
    // blocked — and the claim released — where the funnel accepts it (GH
    // Codex #3844 r5 P1). The composer inserts the BASE template copy.
    const cardVisitIds = cardClaim ? cardClaim.cards.map((c) => c.scheduledServiceId) : [];
    const dispatch = () => sendCustomerMessage({
      to,
      body: cleanBody,
      channel: 'sms',
      audience: trustedCustomerId ? 'customer' : 'lead',
      purpose: cardClaim ? 'card_request' : 'conversational',
      customerId: trustedCustomerId || undefined,
      identityTrustLevel: trustedCustomerId ? 'phone_matches_customer' : 'phone_provided_unverified',
      entryPoint: 'admin_communications_manual_sms',
      ...(cardClaim ? { operatorInitiated: true } : {}),
      metadata: {
        // An Auto Pay setup link makes this an Auto Pay customer SMS whatever
        // the composer called it — the classifier keys on this prefix; a
        // card request link, the funnel's own template key.
        original_message_type: autopayLinkTokens ? 'autopay_setup_link'
          : cardClaim ? require('../services/appointment-card-request').TEMPLATE_KEY
            : (messageType || 'manual'),
        ...(autopayLinkTokens ? { autopay_setup_tokens: autopayLinkTokens } : {}),
        ...(cardClaim ? { scheduled_service_id: cardVisitIds[0], trigger: 'admin', ...(cardVisitIds.length > 1 ? { scheduled_service_ids: cardVisitIds } : {}) } : {}),
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
    const result = prepLinkSends
      ? await dispatchPrepLinkSend(prepLinkSends, dispatch, req.technicianId || null, () => require('../services/composer-customer-links')
        .recheckPrepLinks(cleanBody, normalizePhoneLast10(to), {
          trustedCustomerId: trustedCustomerId || null,
          usDestination: /^\+1\d{10}$/.test(String(normalizePhone(to) || '')),
        }))
      : await dispatch();
    // The reservation has done its job — the real provider row now exists (on
    // success) or no send happened (on failure). Clear it so it can't linger as
    // a stuck 'sending' row blocking auto-sends to the thread.
    await clearManualReservation();
    if (result.blocked || result.sent === false) {
      if (!result.blocked && (result.retryable || result.deferred)) {
        await holdBearerStateAmbiguous(result);
      } else {
        // The reply never left — release the claims and the parked cards.
        await releaseCardClaim();
        await restoreContractLinks();
      }
      // Definitive no-send: the project delivery claim is handed back (an
      // ambiguous outcome kept it above — this is a no-op then).
      await releaseProjectClaim();
      if (claimedReviewRequestId) {
        await require('../services/review-request').releaseInlineClaim(claimedReviewRequestId, claimedReviewClaimToken);
      }
      await reopenScheduledSuggestions({
        decisionIds: [claimedDecisionId, ...parkedThreadIds],
        reason: 'Send was blocked or failed — suggestion reopened.',
      });
      return res.status(422).json({
        ...result,
        error: result.reason || result.code || 'SMS send blocked/failed',
      });
    }

    // A composer-inserted review link rode this body — the send that just
    // left IS the ask, so stamp the claimed inline row delivered (validation
    // — real inline row, recipient owns it, link in body — already ran at
    // the pre-send claim above; the claim is the key here). Guarded on a
    // REAL provider send (same sentinel rule as the SLA stamp below — a
    // suppressed send reports sent:true with nothing actually delivered, and
    // marking then would silently drop the ask); a suppressed send hands the
    // claim back instead. Fail-soft: bookkeeping never breaks a send that
    // already happened — a stranded 'sending' claim is reconciled by
    // claimInlineForSend on the next attempt (repaired to sent from the
    // outbound log, or released once the provider confirms nothing left).
    // Composer-carried Auto Pay links: stamp sent_at after a REAL provider
    // send, exactly as the service's own SMS path does (sent_at only —
    // updated_at is the completion lease token; a row that left 'pending'
    // meanwhile is left alone). Fail-soft: the text is already out
    // (pre-push Codex P1 on #3812).
    if (autopayLinkTokens && result?.sent) {
      try {
        const { isRealProviderSend } = require('../services/sms-auto-send');
        if (isRealProviderSend(result)) {
          await db('appointment_card_requests')
            .whereIn('token', autopayLinkTokens)
            .where({ status: 'pending' })
            .whereNull('sent_at')
            .update({ sent_at: new Date() });
        }
      } catch (stampErr) {
        logger.warn(`[communications] Auto Pay link sent_at stamp failed (text already sent): ${stampErr.message}`);
      }
    }
    // Composer-carried statement links: a REAL provider send is the
    // statement's first delivery — finalized → sent through the email
    // delivery's own writer (fail-soft: lifecycle bookkeeping, no resend
    // risk — the statement stays payable either way).
    if (statementLinkIds && result?.sent) {
      try {
        const { isRealProviderSend } = require('../services/sms-auto-send');
        if (isRealProviderSend(result)) await require('../services/composer-customer-links').markStatementsSent(statementLinkIds);
      } catch (stampErr) {
        logger.warn(`[communications] statement sent stamp failed (text already sent): ${stampErr.message}`);
      }
    }
    // Composer-carried contract signing links: a REAL provider send is the
    // delivery — record it on the contract's timeline (the row was
    // activated before the call); a suppressed send hands the prepared link
    // back. Fail-soft: bookkeeping never breaks a send that already left,
    // and a restore that misses leaves the row activated (inserts refuse
    // until the window closes — never a rotation).
    if (contractActivations) {
      const activations = contractActivations;
      contractActivations = null;
      try {
        const { isRealProviderSend } = require('../services/sms-auto-send');
        const contracts = require('./admin-contracts');
        if (isRealProviderSend(result)) await contracts.recordPreparedShareLinkSends(activations, req, result);
        else await contracts.restorePreparedShareLinks(activations, req, { reason: 'Send was suppressed (no provider delivery)' });
      } catch (bookErr) {
        logger.warn(`[communications] contract link send bookkeeping failed: ${bookErr.message}`);
      }
    }
    // Composer-carried card request links: a REAL provider send IS the
    // visit's one card-request text — mark the request row (the claim
    // stays); a suppressed send hands the claim back (same sentinel rule as
    // the review seam). The service's finalizer parks the claim and alerts
    // the office itself when the marker cannot land, so nothing here can
    // risk a second text.
    if (cardClaim) {
      const claim = cardClaim;
      cardClaim = null;
      try {
        const { isRealProviderSend } = require('../services/sms-auto-send');
        const links = require('../services/composer-customer-links');
        if (isRealProviderSend(result)) {
          if (!await links.markCardRequestSends(claim)) logger.warn('[communications] card request sent marker did not land (claim parked, office alerted)');
        } else {
          await links.releaseCardRequestSends(claim);
        }
      } catch (markErr) {
        logger.warn(`[communications] card request claim finalize failed (text already sent): ${markErr.message}`);
      }
    }
    // The text left — the project delivery claim has covered its window; the
    // row's delivery state is restored (the text is a re-share, not a delivery).
    await releaseProjectClaim();
    if (claimedReviewRequestId) {
      try {
        reviewEmailOutcome = await settleInlineReviewAfterSend({
          result, requestId: claimedReviewRequestId, claimToken: claimedReviewClaimToken, emailRequested: reviewRequestEmail === true,
        });
      } catch (markErr) {
        logger.warn(`[communications] inline review mark-delivered failed (requestId=${claimedReviewRequestId}): ${markErr.message}`);
        // Both: the text left but its delivery stamp (or the email copy)
        // threw — say the email leg did not go out rather than reporting a
        // bare "Message sent." (GH Codex #3856 r3 P2).
        if (reviewRequestEmail === true && !reviewEmailOutcome) {
          reviewEmailOutcome = { sent: false, reason: 'email_not_attempted' };
        }
      }
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

    res.json(reviewEmailOutcome ? { ...result, reviewEmail: reviewEmailOutcome } : result);
  } catch (err) {
    // Release the in-flight reservation so a throw mid-send can't strand a
    // 'sending' row that blocks auto-sends to the thread.
    await clearManualReservation();
    // Same for the inline review claim: a throw with NO confirmed provider
    // acceptance means the ask never left — hand the claim back so an
    // immediate retry isn't blocked for the 10-minute stale window. A throw
    // AFTER acceptance (err.providerOutcome.sent === true, the scheduler's
    // same convention) means the ask DID text: stamp it delivered instead so
    // it can never go out twice.
    if (claimedReviewRequestId) {
      try {
        await settleInlineReviewAfterThrow({
          err, requestId: claimedReviewRequestId, claimToken: claimedReviewClaimToken, emailRequested: reviewRequestEmail === true,
        });
      } catch (claimErr) {
        logger.warn(`[communications] inline review claim cleanup failed (requestId=${claimedReviewRequestId}): ${claimErr.message}`);
      }
    }
    // A throw carrying an AMBIGUOUS provider outcome (retryable/deferred,
    // not accepted, not a validator block — the audit write failed after a
    // Twilio timeout/5xx/429) holds the bearer state exactly as the
    // resolved-result branch does (GH Codex #3851 r5 P1): the provider may
    // hold the text, so the claim and the activated link stay consumed.
    if (err?.providerOutcome && err.providerOutcome.sent !== true && !err.providerOutcome.blocked
      && (err.providerOutcome.retryable || err.providerOutcome.deferred)) {
      await holdBearerStateAmbiguous({ code: err.providerOutcome.providerErrorCode || 'PROVIDER_FAILURE' });
    }
    // The project delivery claim is handed back on a throw too — accepted,
    // or definitively not sent; an ambiguous outcome kept it above.
    await releaseProjectClaim();
    // Same convention for the card request claim: accepted → mark, else release.
    if (cardClaim) {
      if (err?.providerOutcome?.sent === true) {
        const claim = cardClaim;
        cardClaim = null;
        try {
          await require('../services/composer-customer-links').markCardRequestSends(claim);
        } catch (markErr) {
          logger.warn(`[communications] card request claim finalize failed after a throw: ${markErr.message}`);
        }
      } else {
        await releaseCardClaim();
      }
    }
    // Same convention for the statement stamp (GH Codex #3844 r3 P1): an
    // accepted-then-thrown send DID deliver the statement.
    if (statementLinkIds && err?.providerOutcome?.sent === true) {
      try {
        await require('../services/composer-customer-links').markStatementsSent(statementLinkIds);
      } catch (stampErr) {
        logger.warn(`[communications] statement sent stamp failed after a throw: ${stampErr.message}`);
      }
    }
    // And for the activated contract links: accepted → record, else hand back.
    if (contractActivations) {
      if (err?.providerOutcome?.sent === true) {
        const activations = contractActivations;
        contractActivations = null;
        try {
          await require('./admin-contracts').recordPreparedShareLinkSends(activations, req, err.providerOutcome);
        } catch (bookErr) {
          logger.warn(`[communications] contract link send record failed after a throw: ${bookErr.message}`);
        }
      } else {
        await restoreContractLinks();
      }
    }
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
// the prep guide on the operator-chosen channel (email / sms / both — owner
// ruling 2026-09-03). All PREP_CONFIG pests are allowed — every prep.* guide.
const { isSupportedPestType, isSupportedChannel } = require('../services/prep-guide-sender');

// Operator copy for a prep send that delivered nothing, by reason.
const PREP_REFUSAL_COPY = {
  customer_not_found: () => 'That customer could not be found.',
  no_email: () => 'This customer has no email on file — choose Text instead.',
  no_phone: () => 'This customer has no phone number on file — choose Email instead.',
  no_upcoming_visit: () => 'This guide can only be texted as a link, and the customer has no upcoming visit of that type to attach it to — email it, or book the visit first.',
  // One prep page per visit: the row's page already renders another guide,
  // and re-keying it would flip every link already delivered.
  prep_page_taken: (r) => `This guide can only be texted as a link, and the customer's next visit already carries the ${r.takenBy || 'other'} prep page — email this guide instead.`,
  prep_link_failed: () => "Couldn't build the guide page link for this visit — try again.",
  prep_guide_inactive: (r) => `The ${r.label || 'prep'} guide has no active version in Email Templates — activate it before texting a prep link.`,
  prep_page_expired: () => 'The prep page link for this visit has expired — email this guide instead.',
  prep_send_pending: (r) => `The ${r.label || 'prep'} guide for this visit is already queued to send automatically — it will go out on its own.`,
  prep_send_busy: () => 'Another prep send for this customer is in progress — try again in a moment.',
  unsupported_pest_type: () => 'That prep type is not available yet.',
  unsupported_channel: () => 'Choose Email, Text, or Both.',
};
// Both delivered the email but not the text: why the text did not go, by the
// link's own reason (an unplanned text); anything else = the number.
const PREP_TEXT_DOWN_COPY = {
  no_upcoming_visit: () => 'The text was not sent — this guide can only be texted as a link, and the customer has no upcoming visit of that type to attach it to.',
  prep_page_taken: (r) => `The text was not sent — the customer's next visit already carries the ${r.takenBy || 'other'} prep page.`,
  prep_link_failed: () => 'The text was not sent — the guide page link could not be built; try Text again later.',
  prep_guide_inactive: (r) => `The text was not sent — the ${r.label || 'prep'} guide has no active version in Email Templates.`,
  prep_page_expired: () => 'The text was not sent — the prep page link for this visit has expired.',
};
// SendGrid MAY have accepted the email (post-dispatch throw): the page claim
// is kept and "try again" would double-send the guide (GH Codex #3856 r8 P2).
// The text leg is never uncertain (sendPrepSms).
const PREP_EMAIL_UNCERTAIN_COPY = "The prep email may or may not have gone out — check the customer's email log before sending it again.";

function manualPrepMessage(result) {
  if (!result.ok) {
    if (result.emailUncertain) return PREP_EMAIL_UNCERTAIN_COPY;
    const copy = PREP_REFUSAL_COPY[result.reason];
    return copy ? copy(result) : "Couldn't send the prep — check the customer's contact info and try again.";
  }
  const parts = [];
  if (result.emailSent) parts.push(`emailed to ${result.emailAddress}`);
  if (result.smsSent) parts.push(`texted to ${result.phone}`);
  const sent = `${result.label} prep ${parts.join(' and ')}.`;
  if (result.reason !== 'partial') return sent;
  if (result.failedChannel === 'sms') {
    const why = PREP_TEXT_DOWN_COPY[result.smsLinkReason];
    return `${sent} ${why ? why(result) : 'The text did not go out — send it again as Text once the number is confirmed.'}`;
  }
  return result.emailUncertain
    ? `${sent} The email may or may not have gone out — check the customer's email log before sending it again.`
    : `${sent} The email did not go out — send it again as Email once the address is confirmed.`;
}

router.post('/send-prep', async (req, res, next) => {
  try {
    const { customerId, pestType = 'flea', channel = 'both' } = req.body || {};
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!isSupportedPestType(pestType)) {
      return res.status(400).json({ error: `Unsupported prep type: ${pestType}` });
    }
    if (!isSupportedChannel(channel)) {
      return res.status(400).json({ error: 'channel must be one of email, sms, both' });
    }
    const { sendPrepToCustomer } = require('../services/prep-guide-sender');
    const result = await sendPrepToCustomer({ customerId, pestType, channel, actorId: req.technicianId || null });
    const message = manualPrepMessage(result);
    if (!result.ok) {
      const status = result.reason === 'customer_not_found' ? 404 : 400;
      return res.status(status).json({ error: message, result });
    }
    res.json({ success: true, partial: result.reason === 'partial', message, result });
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

    // Exact contact match for a lead that has no customer record yet. Never
    // use broad body/name search to choose the conversation or mark it read.
    if (req.query.phone !== undefined) {
      const contactPhone = normalizePhoneLast10(req.query.phone);
      if (!contactPhone) return res.status(400).json({ error: 'A valid contact phone is required' });
      query = query.whereRaw("RIGHT(regexp_replace(COALESCE(conversations.contact_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [contactPhone]);
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

    const { markInboundSmsRead } = require('../services/inbound-sms-read');
    const { updated, notificationsCleared } = await markInboundSmsRead({
      messageIds: ids, conversationIds, readBefore, adminUserId: req.technicianId || null, role: req.techRole,
    });
    res.json({ success: true, updated, notificationsCleared });
  } catch (err) { next(err); }
});

// Same conversation count consumed by Customer 360's one global badge.
router.get('/unread-count', requireAdmin, async (req, res, next) => {
  try {
    const { countUnreadInboundSms } = require('../services/inbound-sms-read');
    res.json(await countUnreadInboundSms({ excludePhones: ADMIN_PHONES }));
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
      laneId: 'sms_suggest',
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
  return String(svc.status || '').toLowerCase() === 'rescheduled' && isElapsedSameDayVisit(svc, now);
}
// The window math alone, status-agnostic: a same-day row whose quoted
// arrival window has elapsed. The card request pick skips these whatever
// their status (GH Codex #3851 r5 P2): the funnel rejects a date before
// today but not an elapsed time today, so a missed visit this morning
// would be minted for while a later eligible appointment exists.
function isElapsedSameDayVisit(svc, now = new Date()) {
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

// Soonest customer-facing upcoming visit across an account — the visit
// the reschedule, appointment, and card-request composer inserts all
// anchor on (one pick, one set of exclusions).
//
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
// `statuses`: the reschedule link rebooks a 'rescheduled' placeholder, so
// it is upcoming there; the appointment PAGE renders that status as
// pending_rebook (its retained date/window is stale — appointment-public),
// so the appointment link passes the statuses the page treats as upcoming
// (pre-push Codex P1).
// `skip`: the candidate predicate — the reschedule link skips only elapsed
// 'rescheduled' placeholders (a same-day pending/confirmed row past its
// window is a MISSED visit the rebook page serves); the appointment link
// skips whatever its page renders as 'past' (GH Codex #3844 r10 P1).
async function soonestUpcomingVisit(customerIds, { statuses = ['pending', 'confirmed', 'rescheduled'], skip = isElapsedSameDayReschedulePlaceholder } = {}) {
  const PAGE = 25;
  let svc = null;
  for (let offset = 0; ; offset += PAGE) {
    const candidates = await db('scheduled_services')
      .whereIn('customer_id', customerIds)
      .whereIn('status', statuses)
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
      .select('id', 'customer_id', 'scheduled_date', 'window_start', 'window_end', 'service_type', 'status', 'visit_id', 'source_action', 'customer_confirmed');
    // `skip` may be async (the composer's pick reads the grouped page state).
    svc = null;
    for (const c of candidates) {
      if (!(await skip(c))) { svc = c; break; }
    }
    if (svc || candidates.length < PAGE) break;
  }
  return svc;
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

    const svc = await soonestUpcomingVisit(customerIds);
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

// Quick Links review channel 'email' (owner ruling 2026-09-03): a SEND, not
// a link build — the gate-wrapped engine path emails the ask now and nothing
// is inserted into the text. strictChannel: the operator chose Email — never
// fall back to a text. Answers { status, body } for the route to send.
// The email went to the resolved email contact (a service contact when one
// is on file) — the toast names THAT person, not the phone's owner. A
// nicety: undefined when the row can't be read (the email already went).
async function emailContactFirstName(customerId) {
  try {
    const { getServiceContact, firstNameFrom, SERVICE_CONTACT_COLUMNS } = require('../services/customer-contact');
    const row = await db('customers').where({ id: customerId }).first('first_name', 'last_name', 'email', 'phone', ...SERVICE_CONTACT_COLUMNS);
    return row ? (firstNameFrom(getServiceContact(row).name) || undefined) : undefined;
  } catch {
    return undefined;
  }
}

// Email-leg refusals by reason — transient ones (prefs read, provider
// throw) are retryable and must not read as a missing address or an opt-out.
const EMAIL_LEG_REASONS = {
  prefs_unavailable: 'Notification preferences could not be read — try again',
  email_send_failed: 'The review email could not be sent — try again',
  opted_out: 'Review emails are turned off in this customer\'s notification preferences',
  email_off: 'Review emails are turned off in this customer\'s notification preferences',
  no_contact: 'No review email for this customer — no email on file',
  no_email: 'No review email for this customer — no email on file',
  email_blocked: 'The review email could not be sent — the address is suppressed',
  // Post-dispatch throw: the provider MAY hold it — never "try again".
  email_uncertain: "The review email may or may not have gone out — check the customer's email log before sending it again",
  already_reviewed: 'This customer is already marked as having left a review',
  no_customer: 'That customer could not be found',
  // The email WENT but the row could not be stamped (twice): the ask is
  // invisible to the cooldown, so the operator must not click again.
  email_sent_unrecorded: 'The review email was sent, but it could not be recorded — do not send it again',
  email_uncertain_unrecorded: "The review email may or may not have gone out and could not be recorded — do not send it again; check the customer's email log",
  // The address was rejected AND the retry marker could not be restored:
  // this ask cannot be retried from here, and the text's cooldown refuses a
  // fresh one — never "try again".
  email_retry_lost: 'The review email was not accepted, and this ask can no longer be retried from here — send a fresh review request after the cooldown',
};

// The inline review ask once the composer's send has RETURNED: a real send
// stamps the row delivered (retried once — a lost stamp after a real send is
// the one state that can double-text the ask; failing that, the stale-claim
// reconcile in claimInlineForSend repairs it from the outbound log) and, for
// Both, emails the SAME row — only after the text really went. A suppressed
// (sentinel) send releases the claim and withholds the email leg, or the
// composer would report "Message sent." for a Both ask that delivered
// nothing (GH Codex #3856 r1 P1). Returns the Both email outcome, null when
// no email was requested.
async function settleInlineReviewAfterSend({ result, requestId, claimToken, emailRequested }) {
  const { isRealProviderSend } = require('../services/sms-auto-send');
  const ReviewService = require('../services/review-request');
  if (!isRealProviderSend(result)) {
    await ReviewService.releaseInlineClaim(requestId, claimToken);
    return emailRequested ? { sent: false, reason: 'text_not_sent' } : null;
  }
  try {
    await ReviewService.markInlineDelivered(requestId, claimToken);
  } catch (firstErr) {
    logger.warn(`[communications] inline review mark-delivered failed, retrying once (requestId=${requestId}): ${firstErr.message}`);
    await ReviewService.markInlineDelivered(requestId, claimToken);
  }
  return emailRequested ? ReviewService.sendInlineEmailCopy(requestId) : null;
}

// The inline review ask once the composer's send has THROWN: a throw after
// provider acceptance (err.providerOutcome.sent === true, the scheduler's
// convention) means the ask DID text — stamp it delivered so it can never
// go out twice and, for Both, email the same row now as the happy path
// would have (the row is delivered, so no retry can reclaim it; GH Codex
// #3856 r5 P2), the outcome riding the error message the composer shows.
// Anything else releases the claim so an immediate retry isn't blocked for
// the 10-minute stale window.
async function settleInlineReviewAfterThrow({ err, requestId, claimToken, emailRequested }) {
  const ReviewService = require('../services/review-request');
  if (err?.providerOutcome?.sent !== true) {
    await ReviewService.releaseInlineClaim(requestId, claimToken);
    return;
  }
  await ReviewService.markInlineDelivered(requestId, claimToken);
  if (!emailRequested) return;
  const emailOutcome = await ReviewService.sendInlineEmailCopy(requestId);
  err.message = `${err.message} The text was accepted; ${emailOutcome?.sent
    ? 'the review email was sent too.'
    : `the review email was not sent (${emailOutcome?.reason || 'unknown'}).`}`;
}

async function emailReviewAskNow(primaryId) {
  const ReviewService = require('../services/review-request');
  // A Both ask whose text went out but whose email leg failed: the text
  // already started the cooldown, so a fresh ask would be refused — re-send
  // the SAME row's email copy instead (idempotent per row; GH Codex #3856 r7 P2).
  // Fail CLOSED on a lookup error: an unreadable owed-leg state is not
  // "absent" — falling through would refuse a plain Both row on cooldown or
  // mint a second ask beside a stranded one (GH Codex #3856 r11 P2).
  let awaiting;
  try {
    awaiting = await ReviewService.findInlineAwaitingEmail(primaryId);
  } catch (err) {
    logger.warn(`[communications] owed review-email lookup failed (customerId=${primaryId}): ${err.message}`);
    return { status: 409, body: { error: "Could not check this customer's pending review email — try again", outcome: 'error', reason: 'owed_lookup_failed' } };
  }
  if (awaiting?.id) {
    const copy = await ReviewService.sendInlineEmailCopy(awaiting.id);
    if (copy?.sent) {
      const firstName = await emailContactFirstName(primaryId);
      return { status: 200, body: { kind: 'review_request', channel: 'email', sent: true, requestId: awaiting.id, firstName, retriedInline: true } };
    }
    const error = EMAIL_LEG_REASONS[copy?.reason] || 'Review request email could not be sent';
    return { status: 409, body: { error, outcome: 'blocked', reason: copy?.reason || null } };
  }
  const ask = await ReviewService.sendGatedAsk({ customerId: primaryId, channel: 'email', triggeredBy: 'admin', strictChannel: true });
  if (ask.outcome === 'sent') {
    const firstName = await emailContactFirstName(primaryId);
    return { status: 200, body: { kind: 'review_request', channel: 'email', sent: true, requestId: ask.requestId, firstName } };
  }
  const outcomeReasons = {
    already_reviewed: 'This customer is already marked as having left a review',
    no_customer: 'That customer could not be found',
    archived: 'That customer is archived',
    concurrent: 'A review request to this customer is already being sent — try again in a moment',
    blocked: 'No review email for this customer — no email on file, or review emails are turned off in their notification preferences',
    deferred: 'A review request to this customer is already queued and will send automatically.',
  };
  const { REVIEW_GATE_REASONS } = require('../services/composer-customer-links');
  const error = REVIEW_GATE_REASONS[ask.outcome]
    || (ask.outcome === 'blocked' && EMAIL_LEG_REASONS[ask.reason])
    || outcomeReasons[ask.outcome]
    || 'Review request email could not be sent';
  return { status: ask.outcome === 'no_customer' ? 404 : 409, body: { error, outcome: ask.outcome } };
}

const REVIEW_LINK_CHANNELS = ['sms', 'email', 'both'];
// The channels on which the review ask is a SEND from /customer-link (the
// owner must be unambiguous — resolveLinkOwner's emailSend).
const EMAIL_SEND_CHANNELS = ['email', 'both'];

// POST /api/admin/communications/customer-link  { phone, customerId?, kind }
// The Insert Link sheet's other per-customer links — kind ∈ review_request |
// pay_balance | estimate | referral | autopay_setup | appointment |
// card_request | prep_guide | service_report | contract | statement |
// project_report. Same
// fail-closed recipient contract as
// /reschedule-link (requireAdmin, POST body, full last-10 phone, customerId
// cross-checked then expanded to the account, cross-account 409). Builders
// live in services/composer-customer-links.js; a kind with nothing to insert
// answers 404 with the builder's plain reason.
// review_request mints a real review_requests row via createInline with
// armSafetyNet:false — the row is UNSCHEDULED, so the operator's own POST
// /sms send (carrying the returned requestId) is the ONLY thing that can
// deliver it; an abandoned draft never auto-texts, and a withdrawn draft
// just forgets the row client-side (the pending row is SHARED across
// composers via createInline reuse, so canceling it would break a sibling
// operator's valid send — the next insert reuses it instead). channel
// 'email' sends the ask now instead (emailReviewAskNow); 'sms' and 'both'
// mint the inline row as before — for 'both' the composer's send carries
// reviewRequestEmail so the email goes out with the text.
// The statement kind of /customer-link. A payer statement covers the
// bill-to's whole book and goes to the PAYER's AP phone — which is normally
// no customer's phone at all, so the builder resolves the payer from the
// recipient number itself (GH Codex #3844 r2 P1). The statement is
// authorized against the payer, but the text goes to a phone that may also
// be a customer's — exactly one live row on the number rides back as
// customerId so the composer selects it and the /sms send carries it: the
// recipient's own consent policy then applies instead of the unverified-
// lead classification, whose exact-phone consent read can miss a
// differently formatted number on file (r6 P1). Several rows on the number
// → the one the composer selected (it owns the number, so the /sms send
// trusts it), else 409 — never a guess, and never the unverified-lead
// policy for a number one of those rows has opted out (r7 P1). A body
// customerId is otherwise irrelevant to the statement itself.
async function statementLinkInsert(builders, last10, bodyCustomerId) {
  const result = await builders.buildStatementLink(last10);
  if (!result?.url) return { status: 404, body: { error: result?.reason || 'No payable statement for that number' } };
  const owners = await db('customers')
    .whereNull('deleted_at')
    .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
    .select('id');
  const selected = owners.find((o) => String(o.id) === String(bodyCustomerId || ''));
  if (!selected && owners.length > 1) {
    return { status: 409, body: { error: 'That number is on file for more than one customer — pick the customer from the search dropdown before inserting a statement link.' } };
  }
  return {
    status: 200,
    body: {
      kind: 'statement',
      url: stripSmsLinkScheme(result.url),
      line: stripSmsLinkScheme(result.line),
      statement: result.statement || undefined,
      immediateOnly: result.immediateOnly || undefined,
      customerId: (selected || owners[0])?.id,
    },
  };
}

// /customer-link's recipient: the operator-selected customer (phone cross-
// checked, then expanded to its account), else every live row on the
// number — which must sit on ONE account (cross-account 409). Same fail-
// closed contract as /reschedule-link. Returns { customerIds } or
// { status, error }.
async function resolveComposerRecipient(customerId, last10) {
  if (customerId && UUID_RE.test(String(customerId))) {
    const customer = await db('customers')
      .where({ id: customerId })
      .whereNull('deleted_at')
      .first('id', 'phone', 'account_id');
    if (!customer) return { status: 404, error: 'Customer not found' };
    if (fullPhoneLast10(customer.phone) !== last10) return { status: 400, error: 'phone must match the selected customer' };
    const customerIds = await customerIdsForAccount(customer.account_id || customer.id);
    return customerIds.length ? { customerIds } : { status: 404, error: 'No customer found for that number' };
  }
  const matches = await db('customers')
    .whereNull('deleted_at')
    .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
    .select('id', 'account_id');
  if (!matches.length) return { status: 404, error: 'No customer found for that number' };
  const accountKeys = [...new Set(matches.map((m) => m.account_id || m.id))];
  if (accountKeys.length > 1) {
    return { status: 409, error: 'That number is on file for more than one customer account — pick the customer from the search dropdown first' };
  }
  const customerIds = await customerIdsForAccount(accountKeys[0]);
  return customerIds.length ? { customerIds } : { status: 404, error: 'No customer found for that number' };
}

// Per-kind builders for /customer-link. Visit-anchored kinds share the
// reschedule-link pick (one set of exclusions — dispatch-owned pendings,
// elapsed placeholders); the builder takes the picked row so the pick stays
// route-owned. Statement is handled by statementLinkInsert before any
// customer resolution (the key here only admits the kind).
function composerLinkBuilders() {
  const builders = require('../services/composer-customer-links');
  return {
    review_request: (ids, primaryId) => builders.buildReviewRequestLink(primaryId),
    pay_balance: (ids) => builders.buildPayBalanceLink(ids),
    estimate: (ids) => builders.buildLatestEstimateLink(ids),
    referral: (ids, primaryId) => builders.buildReferralLink(primaryId),
    // Auto Pay is per customer row (the phone's owner), same as referral.
    // The builder delegates to autopay-setup-link's single entry point —
    // gate, payer exemption, dedup and the saved-card auto-secure all
    // live there; a link_created outcome is the ONLY thing inserted.
    autopay_setup: (ids, primaryId) => builders.buildAutopaySetupLink(primaryId),
    // Visit-anchored kinds share the reschedule-link pick (one set of
    // exclusions — dispatch-owned pendings, elapsed placeholders); the
    // builder takes the picked row so the pick stays route-owned.
    appointment: async (ids) => builders.buildAppointmentPageLink(await soonestUpcomingVisit(ids, {
    statuses: ['pending', 'confirmed'],
    // The state the page would render — grouped (a sibling in pending rebook
    // or underway, or an unreadable membership) or the row's own — so the
    // pick never inserts a link the send seam then refuses while a later
    // genuinely upcoming visit goes unconsidered (GH Codex #3844 r14 P2).
    skip: async (svc) => (await require('./appointment-public').pageStateForVisit(svc)).state !== 'upcoming',
    })),
    // The prep page shows its customer's name and address and the /sms
    // send requires the recipient to own it (GH Codex #3844 r3 P2), so
    // the visit pick is the phone owner's row — never an account sibling's
    // (a sibling's visit would insert a link the send then refuses; pre-
    // push Codex P1). STRICT_OWNER_KINDS below.
    prep_guide: (ids, primaryId) => builders.buildPrepGuideLink([primaryId]),
    service_report: (ids) => builders.buildServiceReportLink(ids),
    // Bearer credentials for a payment-adjacent page (card request) or a
    // signable document (contract) are per customer ROW — the phone's
    // owner only, never an account sibling (pre-push Codex P0: the
    // document delivery's SMS_RECIPIENT_UNTRUSTED bar is the customer's
    // own phone, not any phone on the account). STRICT_OWNER_KINDS below.
    // The card funnel only accepts its own live statuses — a soonest
    // 'rescheduled' placeholder would be picked here and then rejected
    // there, hiding a later eligible visit (GH Codex #3844 r1 P1).
    // A same-day row whose window elapsed is skipped whatever its status
    // (GH Codex #3851 r5 P2) — the funnel would mint for the missed visit.
    card_request: async (ids, primaryId) => builders.buildCardRequestLink(
      await soonestUpcomingVisit([primaryId], { statuses: require('../services/appointment-card-request').LIVE_VISIT_STATUSES, skip: isElapsedSameDayVisit }),
    ),
    contract: (ids, primaryId) => builders.buildContractSigningLink([primaryId]),
    // Handled by statementLinkInsert before any customer resolution (the
    // key here only admits the kind).
    statement: null,
    // A project report is the account's, like a service report.
    project_report: (ids) => builders.buildProjectReportLink(ids),
  };
}

// Auto Pay is money-affecting and per row (a consented saved card can enroll
// on the spot) — never guess the row. The body's customerId is NOT proof of
// an operator pick (opening a thread auto-fills whichever sibling the latest
// message carried — see firstNameForPhone), so the check runs whether or not
// one was supplied: the phone must belong to exactly ONE row on the account,
// else 409 to the customer's own profile card (GH Codex #3812 r1 P1 +
// pre-push P0). A prep page is the owner's too (name + address on the page,
// ownership re-checked at /sms).
// Card requests and contract signing links are the same class of bearer
// (per row, money- or signature-adjacent) and take the same rule.
const STRICT_OWNER_KINDS = ['autopay_setup', 'card_request', 'contract', 'prep_guide'];
// Appointment pages and service reports are account-scoped (any sibling's
// visit or report) but the TEXT is a customer-specific bearer, so the
// resolved phone owner rides back for them too: the /sms send then carries
// customerId and the recipient's own consent policy applies — without it a
// typed-in number sends as an unverified conversational lead, whose consent
// read can miss the customer's notification_prefs entirely when the number
// is formatted differently on file (GH Codex #3844 r4 P1).
const OWNER_RIDES_BACK_KINDS = [...STRICT_OWNER_KINDS, 'appointment', 'service_report', 'project_report'];

// The row a /customer-link kind targets: the operator-selected row first,
// else the account row whose phone matches the number, else the first
// sibling (sorted — the account expansion has no ORDER BY of its own).
// Returns { primaryId } or { status, error }.
// emailSend: the kind is not a text link but an email SEND to the resolved
// row's own contact (a Quick Links review ask by Email / Both) — strict
// like a prep page, whatever the kind: a number two siblings share must
// never pick the row whose inbox receives it (GH Codex #3856 r21 P1).
async function resolveLinkOwner(kind, customerIds, customerId, last10, { emailSend = false } = {}) {
  const selectedId = customerIds.find((id) => String(id).toLowerCase() === String(customerId || '').toLowerCase()) || null;
  const strictOwner = STRICT_OWNER_KINDS.includes(kind) || emailSend;
  if (selectedId && !strictOwner) return { primaryId: selectedId };
  const phoneRows = await db('customers')
    .whereNull('deleted_at')
    .whereIn('id', customerIds)
    .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [last10])
    .select('id');
  if (strictOwner && phoneRows.length !== 1) {
    return { status: 409, error: 'That number is on file for more than one customer on this account — send this link from that customer\'s profile instead' };
  }
  if (selectedId) return { primaryId: selectedId };
  // A number two live siblings on the account share: the owner that rides
  // back would be an arbitrary pick, and /sms would apply only that row's
  // consent — refuse, like the strict kinds, until the operator picks (GH
  // Codex #3844 r9 P1); the send seam refuses the same ambiguity.
  if (OWNER_RIDES_BACK_KINDS.includes(kind) && phoneRows.length > 1) {
    return { status: 409, error: 'That number is on file for more than one customer on this account — pick the customer from the search dropdown first' };
  }
  return { primaryId: phoneRows.map((r) => r.id).sort()[0] || [...customerIds].sort()[0] };
}

// Builder fields that ride to the composer verbatim when set. immediateOnly:
// the composer refuses to schedule or draft those kinds; /schedule-sms +
// drafts re-fence. standalone: the line is a complete greeted message,
// inserted as-is.
const LINK_RESULT_FIELDS = ['requestId', 'balance', 'estimate', 'appointment', 'prep', 'report', 'contract', 'statement', 'projectReport', 'expiresAt', 'immediateOnly', 'standalone'];

router.post('/customer-link', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const kind = String(body.kind || '');
    const builderByKind = composerLinkBuilders();
    if (!(kind in builderByKind)) {
      return res.status(400).json({ error: `kind must be one of ${Object.keys(builderByKind).join(', ')}` });
    }

    const last10 = fullPhoneLast10(body.phone);
    if (!last10) {
      return res.status(400).json({ error: 'Enter a full 10-digit phone number first' });
    }
    // Quick Links review channel (owner ruling 2026-09-03): sms | email | both.
    const channel = kind === 'review_request' ? String(body.channel || 'sms') : undefined;
    if (channel && !REVIEW_LINK_CHANNELS.includes(channel)) {
      return res.status(400).json({ error: 'channel must be one of sms, email, both' });
    }
    if (kind === 'statement') {
      const answer = await statementLinkInsert(require('../services/composer-customer-links'), last10, body.customerId);
      return res.status(answer.status).json(answer.body);
    }

    const { customerId } = body;
    const recipient = await resolveComposerRecipient(customerId, last10);
    if (recipient.error) return res.status(recipient.status).json({ error: recipient.error });
    const { customerIds } = recipient;

    const recipientFirstName = await firstNameForPhone(last10, customerIds);
    const owner = await resolveLinkOwner(kind, customerIds, customerId, last10, { emailSend: EMAIL_SEND_CHANNELS.includes(channel) });
    if (owner.error) return res.status(owner.status).json({ error: owner.error });
    const { primaryId } = owner;

    // Email: a SEND, not a link build — nothing is inserted into the text.
    if (channel === 'email') {
      const answer = await emailReviewAskNow(primaryId);
      return res.status(answer.status).json(answer.body);
    }

    const result = (await builderByKind[kind](customerIds, primaryId)) || {};
    // Auto Pay auto-secure: a consented saved card was enrolled instead of a
    // link being minted — a successful outcome with nothing to insert.
    if (result.autoSecured) {
      return res.json({ kind, url: null, line: '', autoSecured: true, firstName: recipientFirstName });
    }
    if (!result.url) {
      return res.status(404).json({ error: result.reason || 'Nothing to link for this customer' });
    }
    res.json({
      kind,
      channel,
      url: stripSmsLinkScheme(result.url),
      line: stripSmsLinkScheme(result.line),
      firstName: recipientFirstName,
      ...Object.fromEntries(LINK_RESULT_FIELDS.map((field) => [field, result[field] || undefined])),
      // Owner-bound kinds (and the account-scoped bearers above): the
      // resolved owner rides back so the composer can select it — the /sms
      // send then carries customerId and the link's owner policy applies
      // (GH Codex #3812 r3 P1).
      customerId: OWNER_RIDES_BACK_KINDS.includes(kind) ? primaryId : undefined,
    });
  } catch (err) {
    logger.error(`customer-link lookup failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/communications/link-library
// The Insert Link sheet's full searchable list (office review links computed
// live + stored manual/sitemap rows) — filtering happens client-side. Read
// stays at the router's tech-or-admin level: rows are public marketing URLs,
// nothing customer-scoped.
router.get('/link-library', async (req, res) => {
  try {
    const linkLibrary = require('../services/link-library');
    const [links, lastSyncedAt] = await Promise.all([
      linkLibrary.listLinks(),
      linkLibrary.sitemapLastSyncedAt(),
    ]);
    res.json({ links, lastSyncedAt });
  } catch (err) {
    logger.error(`link-library list failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/communications/link-library  { name, url, category?, clause?, keywords? }
// Settings ▸ Link Library — add a hand-managed row.
router.post('/link-library', requireAdmin, async (req, res) => {
  try {
    const linkLibrary = require('../services/link-library');
    const { id, error } = await linkLibrary.createManualLink(req.body || {});
    if (error) return res.status(400).json({ error });
    res.json({ id });
  } catch (err) {
    logger.error(`link-library create failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/communications/link-library/:id — manual rows only;
// synced rows follow their source (sitemap / office config).
router.delete('/link-library/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const linkLibrary = require('../services/link-library');
    const result = await linkLibrary.deleteManualLink(id);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    logger.error(`link-library delete failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/communications/link-library/sync — Settings "Sync now":
// re-pull the marketing site's sitemap on demand (the daily job in
// services/scheduler.js does the same on schedule). { force: true } accepts
// an over-cap shrinkage for THIS run — the admin-confirmed recovery path
// after a genuine site restructure; the nightly job never forces.
router.post('/link-library/sync', requireAdmin, async (req, res) => {
  try {
    const linkLibrary = require('../services/link-library');
    const force = req.body?.force === true;
    // Same advisory lock as the 2:50 AM job — an unlocked second execution
    // path (two "Sync now" clicks, or a manual run overlapping the cron)
    // reads the same snapshot and races inserts into the unique url index.
    const { runExclusive } = require('../utils/cron-lock');
    const result = await runExclusive(
      'link-library-sitemap-sync',
      () => linkLibrary.syncSitemapLinks({ force }),
      { recordHealth: false },
    );
    if (result?.skipped) {
      return res.status(409).json({ error: 'A sitemap sync is already running — try again in a moment' });
    }
    res.json(result);
  } catch (err) {
    logger.error(`link-library sync failed: ${err.message}`);
    if (err.shrinkage) {
      // Recoverable: the client offers a confirmed force re-run.
      return res.status(409).json({ error: `Sitemap sync refused — ${err.message}`, shrinkage: true });
    }
    res.status(502).json({ error: `Sitemap sync failed — ${err.message}` });
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
const BLOCKED_SCHEDULED_PURPOSES = new Set(['marketing', 'marketing_seasonal', 'retention']);

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
      { laneId: 'sms_tone', text: rewritePrompt, jsonMode: false, maxTokens: 500 },
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
// A tokenized review page link (/rate/:token or its /api/rate/:token/go
// short form), scheme-less or not — what buildReviewRequestLink inserts.
const REVIEW_LINK_RE = /\/(?:api\/)?rate\/[A-Za-z0-9_-]{6,}/i;
// Branded /l/:code short links — what buildReviewUrl normally hands out
// (shortenOrPassthrough); resolved through short_codes.kind below.
// {5,}: legacy five-character codes still resolve (short-url.js).
// Case-insensitive like REVIEW_LINK_RE: Express routing is case-insensitive
// and the public resolver lowercases the code, so /L/AbCdE resolves too
// (GH Codex #3856 r15 P1).
const SHORT_LINK_RE = /\/l\/([A-Za-z0-9_-]{5,})/gi;
const REVIEW_LINK_SCHEDULE_ERROR = 'Review request links can only go on an immediate send — send now, or remove the review link before scheduling';

// Links a scheduled text may NOT carry — every one is an immediate-send-only
// bearer or ask, re-checked only on the /sms path (the scheduler dispatches
// straight into sendCustomerMessage). The composer refuses client-side;
// this is the authoritative fence. Returns { status, error } or null.
async function scheduledSmsLinkRefusal(cleanBody, to) {
  // An Auto Pay setup link is a 30-day bearer credential with no
  // schedule-time re-check.
  const { autopayLinkSendCheck, immediateOnlyLinkSendCheck } = require('../services/composer-customer-links');
  const autopayCheck = await autopayLinkSendCheck(cleanBody, normalizePhoneLast10(to));
  if (autopayCheck.present) {
    return { status: 400, error: 'Auto Pay setup links expire — send them now, or remove the link before scheduling' };
  }
  // Same fence for the other per-row bearers the composer inserts
  // (contract signing, card request, statement pay, expiring prep pages)
  // (GH Codex #3844 r1 P1).
  const immediateOnly = await immediateOnlyLinkSendCheck(cleanBody);
  if (immediateOnly.present) {
    return { status: 400, error: `${immediateOnly.label} links are re-checked at delivery — send them now, or remove the link before scheduling` };
  }
  // A review ask rides the immediate /sms send only — that path claims and
  // marks the inline row and emails the Both copy; a scheduled row would
  // deliver it untracked (invisible to the cap and cooldown) and never
  // email (GH Codex #3856 r4 P1).
  if (REVIEW_LINK_RE.test(cleanBody)) return { status: 400, error: REVIEW_LINK_SCHEDULE_ERROR };
  // A pasted branded short link hides the /rate/ path — ask short_codes
  // what it points at (GH Codex #3856 r5 P1). Fail closed on a lookup miss.
  // Lowercased like the public resolver (public-shortlinks.js): short_codes.code
  // is case-sensitive, and a pasted /l/AbCdE still resolves for the customer
  // (GH Codex #3856 r12 P1).
  const shortCodes = [...cleanBody.matchAll(SHORT_LINK_RE)].map((m) => m[1].toLowerCase());
  if (!shortCodes.length) return null;
  let reviewCodes;
  try {
    reviewCodes = await db('short_codes').whereIn('code', shortCodes).where({ kind: 'review' }).select('code');
  } catch (lookupErr) {
    logger.warn(`[communications] short-link kind lookup failed — refusing to schedule: ${lookupErr.message}`);
    return { status: 503, error: 'Could not verify the links in this message — try again in a moment.' };
  }
  return reviewCodes.length ? { status: 400, error: REVIEW_LINK_SCHEDULE_ERROR } : null;
}

// The customer a scheduled text is linked to: the selected one, whose phone
// must match `to`; else a digit-normalized, deleted-filtered, ambiguity-aware
// lookup (a raw exact-string phone match misses formatting variants and can
// link the scheduled SMS to a soft-deleted or arbitrary duplicate customer).
// Returns { customerId } or { status, error }.
async function trustedCustomerForScheduledSms(customerId, to) {
  if (!customerId) {
    const fallback = await findSingleCustomerForPhone(to).catch(() => null);
    return { customerId: fallback ? fallback.id : null };
  }
  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id', 'phone');
  if (!customer) return { status: 404, error: 'customerId not found' };
  const normalizedTo = normalizePhone(to);
  const normalizedCustomerPhone = normalizePhone(customer.phone);
  if (!normalizedTo || !normalizedCustomerPhone || normalizedTo !== normalizedCustomerPhone) {
    return { status: 400, error: 'to must match the selected customer phone' };
  }
  return { customerId: customer.id };
}

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
    const linkRefusal = await scheduledSmsLinkRefusal(cleanBody, to);
    if (linkRefusal) return res.status(linkRefusal.status).json({ error: linkRefusal.error });

    // ET wall-clock parse — datetime-local strings without offset are
    // interpreted in ET, ISO strings pass through unchanged.
    const sendAt = parseETDateTime(scheduledFor);
    if (Number.isNaN(sendAt.getTime())) return res.status(400).json({ error: 'invalid scheduledFor' });
    if (sendAt <= new Date()) return res.status(400).json({ error: 'scheduledFor must be in the future' });

    const chosenFrom = fromNumber || from || TWILIO_NUMBERS.getOutboundNumber();
    if (!TWILIO_NUMBERS.findByNumber(chosenFrom)) {
      return res.status(400).json({ error: 'fromNumber must be a Waves Twilio number' });
    }

    const trusted = await trustedCustomerForScheduledSms(customerId, to);
    if (trusted.error) return res.status(trusted.status).json({ error: trusted.error });
    const trustedCustomerId = trusted.customerId;

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
      .first('id', 'customer_id', 'current_state', 'case_version', 'idempotency_key', 'hold_reason');
    if (!caseRow) return res.status(404).json({ error: 'case_not_found' });

    const actor = `admin:${req.technician?.email || req.technicianId || 'unknown'}`;
    let promotedByUs = false;
    if (caseRow.current_state === 'shadow' || caseRow.current_state === 'proposed') {
      const now = new Date();
      // Under the customer case lock (codex gh-r5): promotion is a
      // customer-level decision — the shadow sweep's rotation and the
      // auto-dial promote take the same lock, and another live/held case
      // for this customer refuses (two pipelines / dispute-hold bypass).
      const { withCaseLock } = require('../services/collections/case-lock');
      const promoted = await withCaseLock(caseRow.customer_id, async (trx) => {
        // Owner re-read IN the lock (codex gh-r8): a merge committed since
        // our read may have repointed the row — locking the stale owner
        // would govern the wrong customer. Update fences customer_id too.
        const current = await trx('collection_cases')
          .where({ id: caseRow.id })
          .first('customer_id');
        if (!current || String(current.customer_id) !== String(caseRow.customer_id)) return false;
        // Live states only for the SUPERVISED path: the admin endpoint IS
        // the release mechanism for supervised parks, so a parked sibling
        // must not block a human's deliberate retry — only genuinely live
        // pipeline states do.
        const liveElsewhere = await trx('collection_cases')
          .where({ customer_id: caseRow.customer_id })
          .whereIn('current_state', ['approved', 'dialing', 'held'])
          .whereNot('id', caseRow.id)
          .first('id');
        if (liveElsewhere) return 'live_elsewhere';
        const updated = await trx('collection_cases')
          .where({ id: caseRow.id, customer_id: caseRow.customer_id, current_state: caseRow.current_state, case_version: caseRow.case_version })
          .update({
            current_state: 'approved',
            approved_by: actor,
            approved_at: now,
            approval_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            hold_reason: null,
            updated_at: trx.fn.now(),
          });
        return updated > 0;
      });
      if (promoted === 'live_elsewhere') {
        return res.status(409).json({ error: 'another_case_live', detail: 'this customer already has an approved/dialing/held case' });
      }
      if (!promoted) {
        return res.status(409).json({ error: 'case_moved', detail: 'the case changed state while approving — reload and retry' });
      }
      promotedByUs = true;
    } else if (caseRow.current_state !== 'approved') {
      // held / cancelled / expired / dialing — never dialable from here.
      return res.status(409).json({ error: 'case_not_dialable', state: caseRow.current_state });
    }

    // Mirror of the sweep's revert (codex gh-r5): a pre-dial refusal or
    // throw leaves the row 'approved' — invisible to both sweeps and with
    // its card already retired — so OUR promotion is returned to the
    // queue. Fenced on state, version, and this request's actor; rows
    // origination moved are untouched.
    const revertOurPromotion = async () => {
      if (!promotedByUs) return;
      await db('collection_cases')
        .where({ id: caseRow.id, current_state: 'approved', case_version: caseRow.case_version, approved_by: actor })
        .update({
          current_state: 'proposed',
          approved_by: null,
          approved_at: null,
          approval_expires_at: null,
          // Restore the pre-promotion hold_reason (codex gh-r8): promotion
          // nulls it, and a dial_failed park that loses its marker through
          // promote+revert would re-enter the automatic queue silently.
          hold_reason: caseRow.hold_reason ?? null,
          updated_at: db.fn.now(),
        })
        .catch((err) => logger.warn(`[collections-dial] admin-promotion revert failed for case ${caseRow.id}: ${err.message} — approval expiry (24h) is the backstop`));
    };

    const { originateCollectionCall } = require('../services/collections/outbound-voice/origination');
    let result;
    try {
      result = await originateCollectionCall(caseRow.id);
    } catch (err) {
      await revertOurPromotion();
      throw err;
    }
    if (!result.dialed && result.reason !== 'dial_failed') {
      await revertOurPromotion(); // the fence no-ops when origination moved the row
    } else if (result.dialed) {
      // Retire the "no call will be placed" card only once a call actually
      // went out (codex gh-r6 P2 / gh-r7): during the shakedown the card is
      // the operator's only surface carrying the case id. dial_failed keeps
      // it too — origination parks that case for SUPERVISED reapproval (the
      // auto sweep excludes it), so the card is the retry path.
      const { retireProposalCard } = require('../services/collections/outbound-voice/dial-sweep');
      await retireProposalCard(caseRow.idempotency_key);
    }
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
  isElapsedSameDayVisit,
  normalizeRewriteRecentMessages,
  rowsToCsv,
};

module.exports = router;
