/**
 * Ask-the-customer loop (GATE_ESTIMATE_CLARIFY_ASKS, default OFF).
 *
 * When automated quote drafting dead-ends on a MACHINE-READABLE missing
 * item (no service address, no concrete service), park ONE clarifying SMS
 * as a message_drafts row (status 'pending', intent 'estimate_clarify')
 * for the owner's one-click approval in the /admin/drafts queue. THIS
 * SERVICE NEVER SENDS ANYTHING — the draft row is the terminal artifact;
 * only the owner's approve/revise click in admin-drafts puts a message on
 * the wire, through the full sendCustomerMessage consent pipeline
 * (suppression, consent, compliance), with the clarify gate re-checked at
 * approval time.
 *
 * Copy is deterministic template text, not LLM — the asks are enumerable,
 * the owner can revise before sending, and boring copy can't hallucinate
 * claims. Dedupe is phone-scoped via source_ref ('clarify:<last10>'): one
 * OPEN clarify per phone, and no re-ask within RECENT_SENT_WINDOW_MS of a
 * sent one — a customer who didn't answer must not get nagged.
 *
 * Design note: the original scope named the dormant outbox_messages table,
 * but that table is a worker-drained AUTO-SEND outbox with no approval
 * concept — structurally opposed to "never auto-send". message_drafts +
 * /admin/drafts is the live owner-approval queue, so the loop rides it.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

const RECENT_SENT_WINDOW_MS = 7 * 86400000;

// The only items an SMS can ask for. 'phone' is structurally unaskable
// here (no phone = no SMS), and free-text composer uncertainties are not a
// stable vocabulary — both stay operator-bell territory.
const ASKABLE_MISSING = new Set(['street_address', 'specific_service']);

function clarifyAsksEnabled() {
  return isEnabled('estimateClarifyAsks');
}

function firstNameGreeting(firstName) {
  const name = String(firstName || '').trim().split(/\s+/)[0];
  return name && name.toLowerCase() !== 'unknown' ? `Hi ${name}, ` : 'Hi, ';
}

// Deterministic, neighborly, compliant: company name in full, one concrete
// question, no service claims. The owner can revise any of it before send.
function composeClarifyBody({ missing, firstName }) {
  const greeting = firstNameGreeting(firstName);
  const wantsAddress = missing.includes('street_address');
  const wantsService = missing.includes('specific_service');
  if (wantsAddress && wantsService) {
    return `${greeting}it's Waves Pest Control — happy to get your quote started. Two quick things: what's the service address (street + city), and which service are you looking for (pest control, lawn care, mosquito, or something else)?`;
  }
  if (wantsAddress) {
    return `${greeting}it's Waves Pest Control — happy to put your quote together. What's the service address (street + city)?`;
  }
  return `${greeting}it's Waves Pest Control — glad to get you a quote. Which service are you looking for — pest control, lawn care, mosquito, or something else?`;
}

// Every flags mutation for one phone's clarify lifecycle serializes under
// an advisory transaction lock — merges, reply bookkeeping, and
// answer stamps all read-modify-write the same jsonb, and interleaving
// writers could drop each other's items. Same pattern as the estimator
// engine's per-call advisory lock.
function withClarifyLock(digits, callback) {
  return db.transaction(async (trx) => {
    await trx.raw(
      'select pg_advisory_xact_lock(hashtext(?), hashtext(?))',
      ['estimate_clarify', String(digits)],
    );
    return callback(trx);
  });
}

// Rewrite an unclaimed pending clarify with the union of missing items and
// the NEWEST request's linkage. Runs under the clarify lock (trx), so the
// flags read is serialized. Linkage is REPLACED, not backfilled: the
// newest request is authoritative, and a deliberately-null customerId
// (ambiguous shared phone) must not inherit the old draft's customer — a
// later reply would overwrite the wrong CRM record. Guarded on status so
// a claim landing before the lock wins.
async function mergePendingClarify(trx, existing, { askable, firstName, linkage }) {
  let existingFlags = {};
  try {
    existingFlags = typeof existing.flags === 'string' ? JSON.parse(existing.flags) : (existing.flags || {});
  } catch { existingFlags = {}; }
  const existingMissing = Array.isArray(existingFlags.missing) ? existingFlags.missing : [];
  const merged = [...new Set([...existingMissing, ...askable])];
  const changed = await trx('message_drafts')
    .where({ id: existing.id, status: 'pending' })
    .update({
      customer_id: linkage.customerId || null,
      draft_response: composeClarifyBody({ missing: merged, firstName }),
      flags: JSON.stringify({
        ...existingFlags,
        missing: merged,
        lead_id: linkage.leadId || null,
        estimate_id: linkage.estimateId || null,
        source: linkage.source,
        channel_provenance: linkage.channelProvenance || null,
      }),
    });
  // 0 rows = the claim landed first; the caller must NOT report a merge
  // (the new item would silently vanish from flags.missing).
  return { changed: changed > 0, merged };
}

/**
 * Park one clarifying-question draft. Fail-soft by contract: callers sit on
 * quote dead-end paths that must never break because calibration/outreach
 * plumbing hiccupped. Returns { parked, draftId? , skipped? }.
 *
 * @param {object} args
 *   missing        — machine missing-items (only ASKABLE ones are used)
 *   phone          — customer/lead phone (required; SMS is the channel)
 *   firstName      — for the greeting (optional)
 *   customerId     — customers.id when one exists (optional)
 *   leadId         — leads.id linkage for the answer to resume against
 *   estimateId     — draft estimate id when one exists
 *   source         — producer tag ('estimator_engine_red' | 'lead_intake' |
 *                    'lead_webhook_blocked' | 'email_inquiry_not_ready')
 *   channelProvenance — how Waves got this phone ('sms' | 'voice' |
 *                    'web_form' | 'email'). The approve route only asserts
 *                    a transactional consentBasis for sms/voice/web_form;
 *                    an email-extracted phone asserts nothing and the
 *                    messaging validator's fail-closed path owns the
 *                    verdict.
 *   contextSummary — operator-facing "why this draft exists" line
 */
async function parkClarifyAsk({
  missing = [],
  phone,
  firstName = null,
  customerId = null,
  leadId = null,
  estimateId = null,
  source = 'unknown',
  channelProvenance = null,
  contextSummary = null,
}) {
  try {
    if (!clarifyAsksEnabled()) return { parked: false, skipped: 'gate_off' };
    const askable = missing.filter((item) => ASKABLE_MISSING.has(item));
    if (!askable.length) return { parked: false, skipped: 'nothing_askable' };
    // A REAL US destination or nothing: exactly 10 digits, or 11 with a
    // leading country 1. Shorter fragments, extensions ("… ext 9"), and
    // non-US lengths must not queue a draft that fails at Twilio after the
    // owner already approved it. toPhone derives from THESE digits, never a
    // normalizer's unvalidated passthrough.
    const allDigits = String(phone || '').replace(/\D/g, '');
    const digits = allDigits.length === 10
      ? allDigits
      : (allDigits.length === 11 && allDigits.startsWith('1') ? allDigits.slice(1) : null);
    if (!digits) return { parked: false, skipped: 'no_usable_phone' };

    const sourceRef = `clarify:${digits}`;
    const linkage = { customerId, leadId, estimateId, source, channelProvenance };
    // The whole dedupe→merge→insert sequence holds the clarify lock, so
    // producers for one phone serialize completely — no lost merges, no
    // 23505 recovery dance (the unique index remains as the DB backstop;
    // hitting it under the lock is a genuine anomaly and rolls back into
    // the outer fail-soft catch).
    const outcome = await withClarifyLock(digits, async (trx) => {
    // One OPEN clarify per phone; no re-ask soon after a sent one. "Open"
    // means sent_at IS NULL — the admin send path stamps sent_at but leaves
    // status 'approved'/'revised', so status alone would read a delivered
    // clarify as open forever. "Recently sent" keys on sent_at directly for
    // the same reason.
    const existing = await trx('message_drafts')
      .where({ intent: 'estimate_clarify', source_ref: sourceRef })
      .where(function openOrRecentlySent() {
        this.where(function stillOpen() {
          this.whereIn('status', ['pending', 'approved', 'revised']).whereNull('sent_at');
        }).orWhere('sent_at', '>=', new Date(Date.now() - RECENT_SENT_WINDOW_MS));
      })
      // An open draft (sent_at null) outranks a recently sent one for the
      // merge path.
      .orderByRaw('sent_at asc nulls first')
      .first();
    if (existing) {
      // Merge, don't discard: an unclaimed 'pending' draft is ALWAYS
      // rewritten on a dedupe hit — union of missing items (a new dead-end
      // can carry a question the draft doesn't ask yet) AND linkage
      // refreshed to the NEWEST request, so the approval guard judges
      // staleness against the request that still needs the question rather
      // than one whose lead closed. approved/revised are mid-send and a
      // recently-sent one is a cooldown — untouched.
      if (existing.status === 'pending') {
        const mergeResult = await mergePendingClarify(trx, existing, { askable, firstName, linkage });
        if (mergeResult.changed) {
          return {
            parked: false,
            skipped: 'merged_into_open_clarify',
            draftId: existing.id,
            covers: mergeResult.merged,
          };
        }
        // Claim landed mid-merge — the draft is being sent with its OLD
        // items; report a plain dedupe covering only those, so callers
        // don't assume the new item was asked (a later dead-end re-asks it
        // via the consumed-ask exception below).
        let claimedFlags = {};
        try {
          claimedFlags = typeof existing.flags === 'string' ? JSON.parse(existing.flags) : (existing.flags || {});
        } catch { claimedFlags = {}; }
        return {
          parked: false,
          skipped: 'open_or_recent_clarify',
          draftId: existing.id,
          covers: Array.isArray(claimedFlags.missing) ? claimedFlags.missing : [],
        };
      }
      // Recent-sent cooldown — with two exceptions: (a) the ask was
      // PARTIALLY answered and this request covers only what is still
      // unanswered (the other half must not be silenced for seven days);
      // (b) the ask was fully CONSUMED — the contact is responsive, and a
      // NEW dead-end's different question deserves a fresh ask.
      let sentFlags = {};
      try {
        sentFlags = typeof existing.flags === 'string' ? JSON.parse(existing.flags) : (existing.flags || {});
      } catch { sentFlags = {}; }
      const remaining = Array.isArray(sentFlags.missing) ? sentFlags.missing : [];
      const recordedItems = Array.isArray(sentFlags.answer_recorded) ? sentFlags.answer_recorded : [];
      const partiallyAnswered = recordedItems.length > 0;
      const consumed = !!sentFlags.answered_at;
      const asksOnlyRemaining = remaining.length > 0 && askable.every((item) => remaining.includes(item));
      if (!((partiallyAnswered && asksOnlyRemaining) || consumed)) {
        return {
          parked: false,
          skipped: 'open_or_recent_clarify',
          draftId: existing.id,
          // What that sent ask actually covered — remaining + answered.
          covers: [...new Set([...remaining, ...recordedItems])],
        };
      }
      // fall through: park a fresh ask (the partial unique index only
      // covers OPEN drafts, so the sent row won't conflict).
    }

    const [draft] = await trx('message_drafts')
      .insert({
        customer_id: customerId || null,
        draft_response: composeClarifyBody({ missing: askable, firstName }),
        intent: 'estimate_clarify',
        status: 'pending',
        source_ref: sourceRef,
        context_summary: contextSummary
          || `Quote request is missing ${askable.join(' + ')} (${source}). Clarifying question drafted — review and approve to send.`,
        flags: JSON.stringify({
          estimate_clarify: true,
          missing: askable,
          toPhone: `+1${digits}`,
          lead_id: leadId || null,
          estimate_id: estimateId || null,
          source,
          channel_provenance: channelProvenance || null,
        }),
      })
      .returning(['id']);
    return { parked: true, draftId: draft.id, covers: askable };
    });

    // Bell OUTSIDE the lock/transaction — a slow or failing notification
    // must not hold the phone's lifecycle lock or roll back the draft.
    if (outcome.parked) {
      try {
        await require('./notification-service').notifyAdmin(
          'lead',
          'Clarifying question drafted — approve to send',
          `A quote request is missing ${askable.join(' and ').replace(/_/g, ' ')}. A clarifying text is waiting for your approval in the drafts queue.`,
          {
            link: '/admin/communications',
            metadata: { estimate_clarify: true, draftId: outcome.draftId, source, leadId, estimateId },
          },
        );
      } catch (bellErr) {
        logger.warn(`[estimate-clarify] bell failed (draft stands): ${bellErr.message}`);
      }
      logger.info('[estimate-clarify] clarify draft parked', { draftId: outcome.draftId, source, missing: askable });
    }
    return outcome;
  } catch (err) {
    logger.warn(`[estimate-clarify] park failed: ${err.message}`);
    return { parked: false, skipped: `error: ${err.message}` };
  }
}

// Local address heuristics (mirrors lead-intake's leniency; duplicated
// because lead-intake requires THIS module — importing back would cycle).
const CLARIFY_STREET_SUFFIX_RE = /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|ter|terrace|cir|circle|pkwy|parkway|trl|trail|hwy|highway|loop)\b/i;
function extractAddressReply(body) {
  const text = String(body || '').trim();
  if (!text) return null;
  // Whole-body address reply ("123 Main St, Sarasota 34239").
  if (/^\s*\d{1,6}\s+[A-Za-z]/.test(text) && text.length <= 160) {
    const cut = text.split(/[.;!?\n]/)[0].trim();
    if (cut.length >= 6) return cut;
  }
  // Embedded ("it's 123 Main St, Sarasota") — suffix required, latest wins.
  let best = null;
  for (const match of text.matchAll(/\d{1,6}\s+[A-Za-z]/g)) {
    const candidate = text.slice(match.index).split(/[.;!?\n]/)[0].trim();
    if (candidate.length >= 6 && candidate.length <= 160 && CLARIFY_STREET_SUFFIX_RE.test(candidate)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Inbound reply routing for engine/email-originated asks (the intake state
 * machine routes its own replies). A text from a phone with a
 * recently-SENT clarify records the answered fields onto the linked
 * lead/customer rows — which is exactly what the approval-time staleness
 * guard re-derives from, so a stale re-send becomes impossible — and
 * resumes drafting through the SMS-thread engine with the intent gate and
 * cooldown bypassed (the thread now contains the answer). Never sends
 * anything itself; never blocks the webhook's normal handling (the message
 * still flows to the human inbox).
 *
 * Returns { handled } — handled=true means the reply answered a clarify
 * and the caller should skip its own general estimator trigger.
 */
async function handleClarifyReply({ phone, body }) {
  try {
    if (!clarifyAsksEnabled()) return { handled: false };
    const allDigits = String(phone || '').replace(/\D/g, '');
    const digits = allDigits.length === 10
      ? allDigits
      : (allDigits.length === 11 && allDigits.startsWith('1') ? allDigits.slice(1) : null);
    if (!digits || !String(body || '').trim()) return { handled: false };

    const awaiting = await db('message_drafts')
      .where({ intent: 'estimate_clarify', source_ref: `clarify:${digits}` })
      .whereNotNull('sent_at')
      .where('sent_at', '>=', new Date(Date.now() - RECENT_SENT_WINDOW_MS))
      // Consumed asks (every item answered) leave reply routing — later
      // chit-chat ("thanks, sounds good") must not overwrite real answers
      // or re-trigger drafting.
      .whereRaw("(flags->>'answered_at') is null")
      .orderBy('sent_at', 'desc')
      .first();
    if (!awaiting) return { handled: false };

    let flags = {};
    try {
      flags = typeof awaiting.flags === 'string' ? JSON.parse(awaiting.flags) : (awaiting.flags || {});
    } catch { flags = {}; }
    // flags.missing holds only the STILL-UNANSWERED items (recorded ones
    // are removed below), so partial-answer follow-ups route correctly.
    const missing = Array.isArray(flags.missing) ? flags.missing : [];
    if (!missing.length) return { handled: false };

    // PREP (unlocked): the snapshot decides what to ATTEMPT, and the slow
    // classifier runs outside the lock. The locked phase below re-reads
    // fresh state and only records what is STILL missing then — rapid
    // concurrent replies can't restore answered items or drop entries.
    const text = String(body).trim();
    const candidates = [];
    let capturedAddress = null;
    if (missing.includes('street_address')) {
      capturedAddress = extractAddressReply(text);
      if (capturedAddress) candidates.push('street_address');
    }
    let serviceText = null;
    if (missing.includes('specific_service')) {
      // The classifier is the acceptance bar — length alone would record
      // "thanks, sounds good" as the requested service. The RAW text is
      // stored (label semantics preserved); the classifier only vouches
      // that it actually names a service.
      serviceText = capturedAddress ? text.replace(capturedAddress, ' ') : text;
      serviceText = serviceText.replace(/\s+/g, ' ').replace(/^[\s,\-–—:]+|[\s,\-–—:]+$/g, '').trim();
      if (serviceText.length >= 3 && serviceText.length <= 80) {
        const { classifyServiceIntent } = require('./sms-service-intent');
        // Webhook-safe bound: the classifier's LLM fallback carries no
        // timeout of its own, and this path runs before TwiML returns.
        // Timeout ⇒ fail closed (not a service answer).
        const cls = await Promise.race([
          classifyServiceIntent(serviceText),
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 3500);
            if (typeof timer.unref === 'function') timer.unref();
          }),
        ]);
        if (cls?.interest) candidates.push('specific_service');
      }
    }
    if (!candidates.length) return { handled: false };

    // LOCKED phase: fresh re-read; CRM field writes and lifecycle
    // bookkeeping commit in one transaction. Recorded items leave the
    // missing set; the ask is consumed (answered_at) only when nothing
    // remains — a partial answer keeps the draft routable for its
    // remainder, and the park-time cooldown exception lets it be re-asked.
    const locked = await withClarifyLock(digits, async (trx) => {
      const fresh = await trx('message_drafts')
        .where({ id: awaiting.id })
        .whereRaw("(flags->>'answered_at') is null")
        .first();
      if (!fresh) return { recorded: [] };
      let freshFlags = {};
      try {
        freshFlags = typeof fresh.flags === 'string' ? JSON.parse(fresh.flags) : (fresh.flags || {});
      } catch { freshFlags = {}; }
      const freshMissing = Array.isArray(freshFlags.missing) ? freshFlags.missing : [];
      const recorded = candidates.filter((item) => freshMissing.includes(item));
      if (!recorded.length) return { recorded: [] };

      if (recorded.includes('street_address')) {
        if (freshFlags.lead_id) {
          await trx('leads').where({ id: freshFlags.lead_id }).whereNull('deleted_at')
            .update({ address: capturedAddress });
        }
        if (fresh.customer_id) {
          await trx('customers').where({ id: fresh.customer_id })
            .update({ address_line1: capturedAddress });
        }
      }
      if (recorded.includes('specific_service') && freshFlags.lead_id) {
        await trx('leads').where({ id: freshFlags.lead_id }).whereNull('deleted_at')
          .update({ service_interest: serviceText });
      }

      const remaining = freshMissing.filter((item) => !recorded.includes(item));
      await trx('message_drafts').where({ id: fresh.id }).update({
        flags: JSON.stringify({
          ...freshFlags,
          missing: remaining,
          answer_recorded: [...(Array.isArray(freshFlags.answer_recorded) ? freshFlags.answer_recorded : []), ...recorded],
          ...(remaining.length ? {} : { answered_at: new Date().toISOString() }),
        }),
      });
      return { recorded };
    });
    if (!locked.recorded.length) return { handled: false };
    const recorded = locked.recorded;

    // Resume drafting when the SMS engine lane is armed — the thread now
    // carries the answer, so the composer gets everything in one pass. The
    // engine's own duplicate guard and bell dedupe absorb re-runs.
    try {
      const { smsThreadDraftsEnabled, startSmsThreadDraft } = require('./estimator-engine/sms-thread');
      if (smsThreadDraftsEnabled()) {
        await startSmsThreadDraft({
          phone,
          triggerBody: body,
          skipIntentGate: true,
          skipCooldown: true,
        });
      }
    } catch (resumeErr) {
      logger.warn(`[estimate-clarify] resume failed (answer recorded): ${resumeErr.message}`);
    }

    logger.info('[estimate-clarify] clarify reply recorded', { draftId: awaiting.id, recorded });
    return { handled: true };
  } catch (err) {
    logger.warn(`[estimate-clarify] reply handling failed: ${err.message}`);
    return { handled: false };
  }
}

/**
 * Bookkeeping-only stamp for flows that consume replies THEMSELVES (the
 * lead-intake state machine): when such a flow captures an item a sent
 * clarify asked for, the draft's lifecycle must reflect it — otherwise the
 * seven-day cooldown suppresses a later independent ask even though the
 * customer answered. Records nothing new on leads/customers and never
 * resumes anything; fail-soft.
 */
async function recordClarifyAnswer({ phone, items = [] }) {
  try {
    if (!clarifyAsksEnabled() || !items.length) return { recorded: false };
    const allDigits = String(phone || '').replace(/\D/g, '');
    const digits = allDigits.length === 10
      ? allDigits
      : (allDigits.length === 11 && allDigits.startsWith('1') ? allDigits.slice(1) : null);
    if (!digits) return { recorded: false };
    // Read + stamp under the clarify lock — same lost-update protection as
    // every other flags writer.
    return await withClarifyLock(digits, async (trx) => {
      const awaiting = await trx('message_drafts')
        .where({ intent: 'estimate_clarify', source_ref: `clarify:${digits}` })
        .whereNotNull('sent_at')
        .where('sent_at', '>=', new Date(Date.now() - RECENT_SENT_WINDOW_MS))
        .whereRaw("(flags->>'answered_at') is null")
        .orderBy('sent_at', 'desc')
        .first();
      if (!awaiting) return { recorded: false };
      let flags = {};
      try {
        flags = typeof awaiting.flags === 'string' ? JSON.parse(awaiting.flags) : (awaiting.flags || {});
      } catch { flags = {}; }
      const missing = Array.isArray(flags.missing) ? flags.missing : [];
      const recorded = missing.filter((item) => items.includes(item));
      if (!recorded.length) return { recorded: false };
      const remaining = missing.filter((item) => !recorded.includes(item));
      await trx('message_drafts').where({ id: awaiting.id }).update({
        flags: JSON.stringify({
          ...flags,
          missing: remaining,
          answer_recorded: [...(Array.isArray(flags.answer_recorded) ? flags.answer_recorded : []), ...recorded],
          ...(remaining.length ? {} : { answered_at: new Date().toISOString() }),
        }),
      });
      return { recorded: true, items: recorded };
    });
  } catch (err) {
    logger.warn(`[estimate-clarify] answer bookkeeping failed: ${err.message}`);
    return { recorded: false };
  }
}

module.exports = {
  clarifyAsksEnabled,
  parkClarifyAsk,
  handleClarifyReply,
  recordClarifyAnswer,
  _private: { composeClarifyBody, extractAddressReply, ASKABLE_MISSING, RECENT_SENT_WINDOW_MS },
};
