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
    if (existing) return { parked: false, skipped: 'open_or_recent_clarify', draftId: existing.id };

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
          }),
        })
        .returning(['id']);
    } catch (insertErr) {
      // The partial unique index (message_drafts_clarify_open_uniq) makes
      // one-open-clarify-per-phone a DB invariant — a concurrent producer
      // winning the race is the deduped outcome, not an error.
      if (insertErr.code === '23505') {
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

module.exports = {
  clarifyAsksEnabled,
  parkClarifyAsk,
  _private: { composeClarifyBody, ASKABLE_MISSING, RECENT_SENT_WINDOW_MS },
};
