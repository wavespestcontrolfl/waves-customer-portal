/**
 * Cancel notice for New Appointment (GATE_CALL_CANCEL_GUARD, dark by default).
 *
 * 2026-10-30: a new lead agreed a visit on a 12:52 AM call that did not book (a "time unclear" card asking the office to
 * book it). At 7:08 AM she called back and canceled. Nothing was booked yet, so nothing was removed; the cancel filed a
 * cancellation_request card under the same "time unclear" label, and the 12:52 card stayed open. At 11:22 the office
 * booked her from New Appointment, which showed nothing about the cancel.
 *
 * latestCancelCall (GET /admin/schedule/cancel-call-notice) answers the customer's latest real conversation in the last
 * 14 days when that call's newest cancel card still stands, so the form can show "Canceled on a call" before the office
 * saves. A warning only: the booking route never reads it, and it never texts, emails, changes a visit or closes a card.
 * Closing the stale booking cards automatically was tried and dropped (#7152 Codex r1-r2): which address, which
 * services and whose authority a cancel covers is the office's call, so the cards stay for a person.
 */

const db = require('../models/db');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { parseExtraction, isRealConversation } = require('./call-held-visits');

const CANCEL_REASON = 'cancellation_request';
const NOTICE_WINDOW_DAYS = 14;
const NOTICE_SCAN_LIMIT = 20;
// A dismissed cancel card was thrown out (a rejected transcript, or a person who judged it not a cancel).
const COUNTED_CANCEL_CARD_STATUSES = ['open', 'in_progress', 'resolved'];
const DAY_MS = 86400 * 1000;

const realConversation = (call) => isRealConversation(call, parseExtraction(call.ai_extraction_enriched) || {});

/**
 * The customer's latest real conversation in the last 14 days, when the newest cancel card on that call was not
 * dismissed; else null. Voicemails and spam are skipped, even ones marked processed. A later real conversation
 * (inbound or outbound) hides it: the cancel is no longer the customer's latest word.
 * @returns {Promise<null|{callId:string, at:string, summary:string|null}>}
 */
async function latestCancelCall(customerId, { now = new Date() } = {}) {
  const recent = await db('call_log')
    .where({ customer_id: customerId, processing_status: 'processed' })
    .where('created_at', '>=', new Date(now.getTime() - NOTICE_WINDOW_DAYS * DAY_MS))
    .modify((qb) => whereNotSandboxCall(qb))
    .orderBy('created_at', 'desc')
    .limit(NOTICE_SCAN_LIMIT)
    .select('id', 'created_at', 'processing_status', 'answered_by', 'ai_extraction_enriched');
  const latest = recent.find(realConversation);
  if (!latest) return null;
  // The newest cancel card decides (a reprocess can file a second one; a dismissal of the newer one wins).
  const card = await db('triage_items')
    .where({ call_log_id: latest.id, reason_code: CANCEL_REASON })
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .first('summary', 'status');
  if (!card || !COUNTED_CANCEL_CARD_STATUSES.includes(card.status)) return null;
  return { callId: latest.id, at: new Date(latest.created_at).toISOString(), summary: card.summary || null };
}

module.exports = { latestCancelCall };
