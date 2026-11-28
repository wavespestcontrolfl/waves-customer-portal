'use strict';

/**
 * Post-Visit SMS Re-Draft Revision Service (owner 2026-11-27 "ok go", Decision 4D).
 *
 * When a visit completes (`service_records` saved), checks whether the customer sent an
 * unanswered inbound SMS earlier the SAME ET calendar day whose original `house_voice` draft
 * was created before the visit finished. If so, generates ONE linked revision row
 * (`draft_trigger = 'post_visit_closeout'`, `supersedes_draft_id = priorDraft.id`) with the
 * fresh post-closeout visit findings — preserving the original intent, schedulingIntent, and
 * media safeguards, WITHOUT modifying the original `inbound` draft (keeping nightly judge and
 * sealed-exam baselines intact) and WITHOUT auto-sending any customer message.
 *
 * Spend discipline: live Railway drafting is gated behind `GATE_SMS_POST_VISIT_REDRAFT`
 * (`smsPostVisitRedraftLive()`, strict `=== 'true'`, dark by default). While off,
 * `draftPostVisitRevisionIfEligible()` returns `{ skipped: 'gate_off' }` with zero DB reads
 * and $0 API cost, while `findPostVisitRedraftCandidates()` serves the free Mac Max-plan runner.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, parseETDateTime, addETDays } = require('../utils/datetime-et');
const { validDateOnly } = require('../utils/date-only');
const { serviceDateOnly } = require('../utils/invoice-due-base-day');
const { phoneIdentityKey } = require('../utils/phone');
const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
const { SENT_STATUSES, threadHasLiveAnswer } = require('./sms-suggest-mode');

const INBOUND_TRIGGER = 'inbound';
const POST_VISIT_TRIGGER = 'post_visit_closeout';
const HOUSE_VOICE_DRAFTER = 'house_voice';
const AUTOMATED_REPLY_TYPES = ['ai_autosent', 'ai_gratitude'];
const IGNORED_INBOUND_TYPES = ['opt_out', 'opt_in', 'sms_reaction'];

function etDayBounds(visitDateET) {
  const raw = String(visitDateET || '').trim();
  const day = validDateOnly(raw) ? raw : etDateString(new Date());
  const start = parseETDateTime(`${day}T00:00`);
  const nextDay = etDateString(addETDays(parseETDateTime(`${day}T12:00`), 1));
  const end = parseETDateTime(`${nextDay}T00:00`);
  return { day, start, end };
}

/**
 * Fail-closed media detector on an inbound `sms_log` row's metadata.
 * Returns false ONLY when metadata cleanly confirms zero media attachments; any malformed
 * or ambiguous payload fails closed to true so photo-verification safeguards stay armed.
 */
function inboundHasMedia(metadata) {
  if (metadata === null || metadata === undefined || metadata === '') return false;
  let parsed = metadata;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return true; }
  }
  if (!parsed || typeof parsed !== 'object') return true;
  if (parsed.media === undefined || parsed.media === null) {
    const n = Number(parsed.num_media ?? parsed.NumMedia ?? parsed.mediaCount ?? 0);
    return !Number.isFinite(n) || n > 0;
  }
  return !Array.isArray(parsed.media) || parsed.media.length > 0;
}

async function threadHasAutomatedAnswer(dbh, { threadLast10, customerId, inboundSmsLogId, inboundCreatedAt }) {
  const after = inboundSmsLogId && typeof dbh.raw === 'function'
    ? dbh.raw('(SELECT created_at FROM sms_log WHERE id = ?)', [inboundSmsLogId])
    : inboundCreatedAt;
  const row = await dbh('sms_log')
    .where({ direction: 'outbound' })
    .where((w) => {
      if (threadLast10) {
        w.whereRaw("RIGHT(REGEXP_REPLACE(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [threadLast10]);
      } else {
        w.where({ customer_id: customerId });
      }
    })
    .whereIn('message_type', AUTOMATED_REPLY_TYPES)
    .whereIn('status', [...SENT_STATUSES, 'scheduled', 'sending'])
    .where('created_at', '>', after)
    .first('id');
  return Boolean(row);
}

/**
 * Find the newest unanswered same-ET-day inbound SMS for `customerId` whose original
 * `house_voice` inbound draft predates `completedAt` and has no `post_visit_closeout` revision yet.
 */
async function findEligibleInboundForPostVisitRedraft(dbh, { customerId, completedAt, visitDateET }, deps = {}) {
  if (!dbh || !customerId) return null;
  const doneAt = completedAt instanceof Date ? completedAt : new Date(completedAt || Date.now());
  if (Number.isNaN(doneAt.getTime())) return null;
  const { start, end } = etDayBounds(visitDateET);

  const inbound = await dbh('sms_log as s')
    .where('s.customer_id', customerId)
    .where('s.direction', 'inbound')
    .where('s.created_at', '>=', start)
    .where('s.created_at', '<', end)
    .where('s.created_at', '<=', doneAt)
    .where((w) => w.whereNull('s.message_type').orWhereNotIn('s.message_type', IGNORED_INBOUND_TYPES))
    .whereRaw("COALESCE(s.message_type, '') NOT LIKE 'job\\_%'")
    .whereRaw("TRIM(COALESCE(s.message_body, '')) <> ''")
    .orderBy('s.created_at', 'desc')
    .first('s.id', 's.from_phone', 's.message_body', 's.created_at', 's.metadata');

  if (!inbound) return null;

  // Reuse sms-suggest-mode's phone-thread answer / in-flight / newer-inbound check, plus automated replies.
  const threadLast10 = phoneIdentityKey(inbound.from_phone) || null;
  const checkLiveAnswer = deps.threadHasLiveAnswer || threadHasLiveAnswer;
  const liveAnswer = await checkLiveAnswer(dbh, {
    threadLast10,
    customerId,
    inboundCreatedAt: inbound.created_at,
    inboundSmsLogId: inbound.id,
  });
  if (liveAnswer) return null;

  const autoAnswered = await threadHasAutomatedAnswer(dbh, {
    threadLast10,
    customerId,
    inboundSmsLogId: inbound.id,
    inboundCreatedAt: inbound.created_at,
  });
  if (autoAnswered) return null;

  // Must have an original house_voice inbound draft that predates visit completion.
  const priorDraft = await dbh('message_drafts')
    .where({ sms_log_id: inbound.id, drafter: HOUSE_VOICE_DRAFTER, draft_trigger: INBOUND_TRIGGER })
    .where('created_at', '<', doneAt)
    .orderBy('created_at', 'desc')
    .first('id', 'created_at', 'intent', 'intent_confidence', 'scheduling_intent');
  if (!priorDraft) return null;

  // Idempotent: at most ONE post-visit revision per inbound text.
  const existingRevision = await dbh('message_drafts')
    .where({ sms_log_id: inbound.id, draft_trigger: POST_VISIT_TRIGGER })
    .first('id');
  if (existingRevision) return null;

  return {
    smsLogId: inbound.id,
    fromPhone: inbound.from_phone,
    inboundMessage: inbound.message_body,
    inboundAt: inbound.created_at,
    priorDraftId: priorDraft.id,
    intent: {
      intent: priorDraft.intent || 'GENERAL',
      confidence: priorDraft.intent_confidence ?? null,
    },
    schedulingIntent: Boolean(priorDraft.scheduling_intent),
    hasMedia: inboundHasMedia(inbound.metadata),
  };
}

/**
 * Read-only paginated batch candidate query for the Mac Max-plan late drafter ($0 API cost).
 * Pages through all same-day closeouts until `limit` eligible candidates are found or the day ends.
 */
async function findPostVisitRedraftCandidates(dbh, { visitDateET, limit = 25, pageSize = null } = {}, deps = {}) {
  const { day, start, end } = etDayBounds(visitDateET);
  const batchSize = Number(pageSize) > 0
    ? Math.min(200, Number(pageSize))
    : Math.min(200, Math.max(limit * 2, 50));
  const seenCustomers = new Set();
  const candidates = [];
  let offset = 0;

  while (candidates.length < limit) {
    const records = await dbh('service_records')
      .where('service_date', day)
      .whereNotNull('customer_id')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .offset(offset)
      .limit(batchSize)
      .select('id', 'customer_id', 'created_at');

    if (!records.length) break;

    for (const rec of records) {
      if (seenCustomers.has(rec.customer_id)) continue;
      seenCustomers.add(rec.customer_id);
      const eligible = await findEligibleInboundForPostVisitRedraft(dbh, {
        customerId: rec.customer_id,
        completedAt: rec.created_at,
        visitDateET: day,
      }, deps);
      if (eligible) {
        candidates.push({
          ...eligible,
          customerId: rec.customer_id,
          serviceRecordId: rec.id,
          window: { start, end },
        });
      }
      if (candidates.length >= limit) break;
    }

    if (records.length < batchSize) break;
    offset += batchSize;
  }

  return candidates;
}

async function generateClaimedRevision({ dbh, customer, eligible, draftFn }) {
  const already = await dbh('message_drafts')
    .where({ sms_log_id: eligible.smsLogId, draft_trigger: POST_VISIT_TRIGGER })
    .first('id');
  if (already) return { skipped: 'already_revised' };

  const drafter = draftFn || ((args) => require('./sms-shadow-drafter').draftShadowReply(args));
  const draftId = await drafter({
    inboundMessage: eligible.inboundMessage,
    fromPhone: eligible.fromPhone,
    customer,
    smsLogId: eligible.smsLogId,
    intent: eligible.intent,
    schedulingIntent: eligible.schedulingIntent,
    hasMedia: eligible.hasMedia,
    draftTrigger: POST_VISIT_TRIGGER,
    supersedesDraftId: eligible.priorDraftId,
    skipAutoSend: true,
  });
  return { drafted: Boolean(draftId), draftId: draftId || null, supersedesDraftId: eligible.priorDraftId };
}

/**
 * Post-commit hook for visit completion. Never throws, never sends any customer message.
 * Gated behind GATE_SMS_POST_VISIT_REDRAFT (dark by default) and claims per-inbound advisory
 * lock before calling the paid drafter so concurrent closeouts cannot duplicate LLM spend.
 */
async function draftPostVisitRevisionIfEligible({
  customerId,
  completedAt,
  visitDateET,
  dbh = db,
  gates = null,
  draftFn = null,
  lockFn = null,
  threadHasLiveAnswerFn = null,
} = {}) {
  if (!customerId) return { skipped: 'missing_customer' };
  const featureGates = gates || require('../config/feature-gates');
  if (featureGates.smsPostVisitRedraftLive?.() !== true) return { skipped: 'gate_off' };

  const deps = threadHasLiveAnswerFn ? { threadHasLiveAnswer: threadHasLiveAnswerFn } : {};
  const eligible = await findEligibleInboundForPostVisitRedraft(dbh, { customerId, completedAt, visitDateET }, deps);
  if (!eligible) return { skipped: 'none_eligible' };

  const customer = await dbh('customers').where({ id: customerId }).first();
  if (!customer) return { skipped: 'customer_not_found' };

  try {
    const acquire = lockFn || runExclusive;
    const locked = await acquire(`sms-post-visit-redraft:${eligible.smsLogId}`, () => (
      generateClaimedRevision({ dbh, customer, eligible, draftFn })
    ));
    if (wasLockSkipped(locked)) return { skipped: 'claim_in_flight' };
    return locked;
  } catch (err) {
    if (err?.code === '23505') return { skipped: 'already_revised' };
    logger.warn(`[sms-post-visit-redraft] revision draft failed for customer ${customerId}: ${err?.code || err?.name || 'error'}`);
    return { skipped: 'error' };
  }
}

/**
 * Fire-and-forget wrapper invoked from `complete-scheduled-service.js` after visit commit.
 */
function triggerOnVisitComplete({ isBackfillCompletion, svc, record } = {}) {
  if (isBackfillCompletion || !svc?.customer_id || !record?.id) return;
  draftPostVisitRevisionIfEligible({
    customerId: svc.customer_id,
    completedAt: record.created_at || new Date(),
    visitDateET: serviceDateOnly(record.service_date || svc.scheduled_date) || etDateString(),
  }).catch((err) => {
    logger.warn(`[dispatch] post-visit SMS redraft skipped for customer ${svc.customer_id}: ${err?.code || err?.name || 'error'}`);
  });
}

module.exports = {
  INBOUND_TRIGGER,
  POST_VISIT_TRIGGER,
  HOUSE_VOICE_DRAFTER,
  etDayBounds,
  inboundHasMedia,
  findEligibleInboundForPostVisitRedraft,
  findPostVisitRedraftCandidates,
  draftPostVisitRevisionIfEligible,
  triggerOnVisitComplete,
};
