'use strict';

/**
 * Post-Visit SMS Re-Draft Revision Service (owner 2026-11-27 "ok go", Decision 4D).
 *
 * When a non-backfill, completed visit closes out (`service_records` saved), checks each
 * phone thread on the account for an unanswered inbound SMS earlier the SAME ET calendar day
 * whose original `house_voice` draft predated closeout. If found, generates ONE linked shadow
 * revision row (`draft_trigger = 'post_visit_closeout'`, `supersedes_draft_id = priorDraft.id`)
 * with fresh post-closeout visit findings — preserving intent, schedulingIntent, and fail-closed
 * media safeguards, WITHOUT modifying the original draft/card and WITHOUT auto-sending.
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
const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
const { mediaCountFromMetadata } = require('./sms-gratitude-context');
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
 * Matches `publishSuggestion`'s last-10 phone normalization (works for US and international numbers).
 */
function lastTenPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * Fail-closed media check matching `sms-late-drafter.js`: only a confirmed zero-attachment
 * metadata payload sets `hasMedia = false`; missing/null/empty metadata fails closed to `true`.
 */
function inboundHasMedia(metadata) {
  return mediaCountFromMetadata(metadata) !== 0;
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

async function evaluateInboundCandidate(dbh, inbound, { customerId, doneAt, checkLiveAnswer }) {
  const threadLast10 = lastTenPhone(inbound.from_phone);
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

  const priorDraft = await dbh('message_drafts')
    .where({ sms_log_id: inbound.id, drafter: HOUSE_VOICE_DRAFTER, draft_trigger: INBOUND_TRIGGER })
    .where('created_at', '<', doneAt)
    .orderBy('created_at', 'desc')
    .first('id', 'created_at', 'intent', 'intent_confidence', 'scheduling_intent');
  if (!priorDraft) return null;

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
 * Checks the newest same-ET-day inbound SMS per distinct phone thread on `customerId` so a
 * newer answered text from a second contact cannot hide an unanswered thread from the first.
 */
async function findEligibleInboundForPostVisitRedraft(dbh, { customerId, completedAt, visitDateET }, deps = {}) {
  if (!dbh || !customerId) return null;
  const doneAt = completedAt instanceof Date ? completedAt : new Date(completedAt || Date.now());
  if (Number.isNaN(doneAt.getTime())) return null;
  const { start, end } = etDayBounds(visitDateET);

  const inbounds = await dbh('sms_log as s')
    .where('s.customer_id', customerId)
    .where('s.direction', 'inbound')
    .where('s.created_at', '>=', start)
    .where('s.created_at', '<', end)
    .where('s.created_at', '<=', doneAt)
    .where((w) => w.whereNull('s.message_type').orWhereNotIn('s.message_type', IGNORED_INBOUND_TYPES))
    .whereRaw("COALESCE(s.message_type, '') NOT LIKE 'job\\_%'")
    .whereRaw("TRIM(COALESCE(s.message_body, '')) <> ''")
    .orderBy('s.created_at', 'desc')
    .limit(20)
    .select('s.id', 's.from_phone', 's.message_body', 's.created_at', 's.metadata');

  if (!inbounds.length) return null;

  const checkLiveAnswer = deps.threadHasLiveAnswer || threadHasLiveAnswer;
  const seenThreads = new Set();
  for (const inbound of inbounds) {
    const threadKey = lastTenPhone(inbound.from_phone) || `row:${inbound.id}`;
    if (seenThreads.has(threadKey)) continue;
    seenThreads.add(threadKey);
    const eligible = await evaluateInboundCandidate(dbh, inbound, { customerId, doneAt, checkLiveAnswer });
    if (eligible) return eligible;
  }
  return null;
}

/**
 * Read-only paginated batch candidate query for the Mac Max-plan late drafter ($0 API cost).
 * Excludes backfills and incomplete visits before pagination so candidates match the live hook.
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
      .whereRaw("COALESCE(structured_notes->>'backfill', 'false') <> 'true'")
      .whereRaw("COALESCE(structured_notes->>'visitOutcome', 'completed') <> 'incomplete'")
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

async function resolveRevisionInputs({ customerId, completedAt, visitDateET, dbh, threadHasLiveAnswerFn }) {
  const deps = threadHasLiveAnswerFn ? { threadHasLiveAnswer: threadHasLiveAnswerFn } : {};
  const eligible = await findEligibleInboundForPostVisitRedraft(dbh, { customerId, completedAt, visitDateET }, deps);
  if (!eligible) return { skipped: 'none_eligible' };
  const customer = await dbh('customers').where({ id: customerId }).first();
  if (!customer) return { skipped: 'customer_not_found' };
  return { eligible, customer };
}

/**
 * Post-commit hook for visit completion. Never throws, never sends any customer message.
 * Gated behind GATE_SMS_POST_VISIT_REDRAFT (dark by default) and claims a per-inbound advisory
 * lock (`recordHealth: false`) before generating so concurrent closeouts cannot duplicate spend.
 */
async function draftPostVisitRevisionIfEligible(opts = {}) {
  const { customerId, completedAt, visitDateET, dbh = db, gates, draftFn, lockFn, threadHasLiveAnswerFn } = opts;
  if (!customerId) return { skipped: 'missing_customer' };
  const featureGates = gates || require('../config/feature-gates');
  if (featureGates.smsPostVisitRedraftLive?.() !== true) return { skipped: 'gate_off' };

  const resolved = await resolveRevisionInputs({ customerId, completedAt, visitDateET, dbh, threadHasLiveAnswerFn });
  if (resolved.skipped) return resolved;

  try {
    const acquire = lockFn || runExclusive;
    const locked = await acquire(
      `sms-post-visit-redraft:${resolved.eligible.smsLogId}`,
      () => generateClaimedRevision({ dbh, customer: resolved.customer, eligible: resolved.eligible, draftFn }),
      { recordHealth: false },
    );
    return wasLockSkipped(locked) ? { skipped: 'claim_in_flight' } : locked;
  } catch (err) {
    if (err?.code === '23505') return { skipped: 'already_revised' };
    logger.warn(`[sms-post-visit-redraft] revision draft failed for customer ${customerId}: ${err?.code || err?.name || 'error'}`);
    return { skipped: 'error' };
  }
}

/**
 * Fire-and-forget wrapper invoked from `complete-scheduled-service.js` after visit commit.
 */
function triggerOnVisitComplete({ isBackfillCompletion, isIncompleteVisit, svc, record } = {}) {
  if (isBackfillCompletion || isIncompleteVisit || !svc?.customer_id || !record?.id) return;
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
  lastTenPhone,
  inboundHasMedia,
  findEligibleInboundForPostVisitRedraft,
  findPostVisitRedraftCandidates,
  draftPostVisitRevisionIfEligible,
  triggerOnVisitComplete,
};
