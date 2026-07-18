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

// Rewrite an unclaimed pending clarify with the union of missing items and
// the NEWEST request's linkage. Guarded on status so a claim landing
// mid-merge wins; the read-modify-write on flags has a tiny lost-update
// window between two simultaneous mergers, which the approval guard's
// staleness recheck absorbs (it re-derives what is still missing from the
// live rows, not from flags alone).
async function mergePendingClarify(existing, { askable, firstName, linkage }) {
  let existingFlags = {};
  try {
    existingFlags = typeof existing.flags === 'string' ? JSON.parse(existing.flags) : (existing.flags || {});
  } catch { existingFlags = {}; }
  const existingMissing = Array.isArray(existingFlags.missing) ? existingFlags.missing : [];
  const merged = [...new Set([...existingMissing, ...askable])];
  await db('message_drafts')
    .where({ id: existing.id, status: 'pending' })
    .update({
      customer_id: linkage.customerId || existing.customer_id || null,
      draft_response: composeClarifyBody({ missing: merged, firstName }),
      flags: JSON.stringify({
        ...existingFlags,
        missing: merged,
        lead_id: linkage.leadId || existingFlags.lead_id || null,
        estimate_id: linkage.estimateId || existingFlags.estimate_id || null,
        source: linkage.source,
        channel_provenance: linkage.channelProvenance || existingFlags.channel_provenance || null,
      }),
    });
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
    // One OPEN clarify per phone; no re-ask soon after a sent one. "Open"
    // means sent_at IS NULL — the admin send path stamps sent_at but leaves
    // status 'approved'/'revised', so status alone would read a delivered
    // clarify as open forever. "Recently sent" keys on sent_at directly for
    // the same reason.
    const existing = await db('message_drafts')
      .where({ intent: 'estimate_clarify', source_ref: sourceRef })
      .where(function openOrRecentlySent() {
        this.where(function stillOpen() {
          this.whereIn('status', ['pending', 'approved', 'revised']).whereNull('sent_at');
        }).orWhere('sent_at', '>=', new Date(Date.now() - RECENT_SENT_WINDOW_MS));
      })
      .first();
    const linkage = { customerId, leadId, estimateId, source, channelProvenance };
    if (existing) {
      // Merge, don't discard: an unclaimed 'pending' draft is ALWAYS
      // rewritten on a dedupe hit — union of missing items (a new dead-end
      // can carry a question the draft doesn't ask yet) AND linkage
      // refreshed to the NEWEST request, so the approval guard judges
      // staleness against the request that still needs the question rather
      // than one whose lead closed. approved/revised are mid-send and a
      // recently-sent one is a cooldown — untouched.
      if (existing.status === 'pending') {
        await mergePendingClarify(existing, { askable, firstName, linkage });
        return { parked: false, skipped: 'merged_into_open_clarify', draftId: existing.id };
      }
      return { parked: false, skipped: 'open_or_recent_clarify', draftId: existing.id };
    }

    const body = composeClarifyBody({ missing: askable, firstName });
    let draft;
    try {
      [draft] = await db('message_drafts')
        .insert({
          customer_id: customerId || null,
          draft_response: body,
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
    } catch (insertErr) {
      // The partial unique index (message_drafts_clarify_open_uniq) makes
      // one-open-clarify-per-phone a DB invariant. Losing the race must not
      // discard THIS request's items/linkage — merge them into the winner.
      if (insertErr.code === '23505') {
        const winner = await db('message_drafts')
          .where({ intent: 'estimate_clarify', source_ref: sourceRef, status: 'pending' })
          .whereNull('sent_at')
          .first();
        if (winner) {
          await mergePendingClarify(winner, { askable, firstName, linkage });
          return { parked: false, skipped: 'merged_into_open_clarify', draftId: winner.id };
        }
        // Winner already claimed or sent between the conflict and this read
        // — the standing draft/cooldown covers the phone.
        return { parked: false, skipped: 'open_or_recent_clarify' };
      }
      throw insertErr;
    }

    try {
      await require('./notification-service').notifyAdmin(
        'lead',
        'Clarifying question drafted — approve to send',
        `A quote request is missing ${askable.join(' and ').replace(/_/g, ' ')}. A clarifying text is waiting for your approval in the drafts queue.`,
        {
          link: '/admin/communications',
          metadata: { estimate_clarify: true, draftId: draft.id, source, leadId, estimateId },
        },
      );
    } catch (bellErr) {
      logger.warn(`[estimate-clarify] bell failed (draft stands): ${bellErr.message}`);
    }

    logger.info('[estimate-clarify] clarify draft parked', { draftId: draft.id, source, missing: askable });
    return { parked: true, draftId: draft.id };
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
      .orderBy('sent_at', 'desc')
      .first();
    if (!awaiting) return { handled: false };

    let flags = {};
    try {
      flags = typeof awaiting.flags === 'string' ? JSON.parse(awaiting.flags) : (awaiting.flags || {});
    } catch { flags = {}; }
    const missing = Array.isArray(flags.missing) ? flags.missing : [];
    if (!missing.length) return { handled: false };

    const text = String(body).trim();
    const recorded = [];
    let capturedAddress = null;
    if (missing.includes('street_address')) {
      capturedAddress = extractAddressReply(text);
      if (capturedAddress) {
        if (flags.lead_id) {
          await db('leads').where({ id: flags.lead_id }).whereNull('deleted_at')
            .update({ address: capturedAddress });
        }
        if (awaiting.customer_id) {
          await db('customers').where({ id: awaiting.customer_id })
            .update({ address_line1: capturedAddress });
        }
        recorded.push('street_address');
      }
    }
    if (missing.includes('specific_service')) {
      // Whatever isn't the address is the service answer — raw, bounded;
      // the composer and readiness gate judge concreteness downstream.
      let serviceText = capturedAddress ? text.replace(capturedAddress, ' ') : text;
      serviceText = serviceText.replace(/\s+/g, ' ').replace(/^[\s,\-–—:]+|[\s,\-–—:]+$/g, '').trim();
      if (serviceText.length >= 3 && serviceText.length <= 80) {
        if (flags.lead_id) {
          await db('leads').where({ id: flags.lead_id }).whereNull('deleted_at')
            .update({ service_interest: serviceText });
        }
        recorded.push('specific_service');
      }
    }
    if (!recorded.length) return { handled: false };

    // Answer bookkeeping so operators see WHY the draft resolved.
    await db('message_drafts').where({ id: awaiting.id }).update({
      flags: JSON.stringify({
        ...flags,
        answered_at: new Date().toISOString(),
        answer_recorded: recorded,
      }),
    });

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

module.exports = {
  clarifyAsksEnabled,
  parkClarifyAsk,
  handleClarifyReply,
  _private: { composeClarifyBody, extractAddressReply, ASKABLE_MISSING, RECENT_SENT_WINDOW_MS },
};
