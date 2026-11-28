'use strict';

/**
 * Post-Visit SMS Re-Draft Revision Service (owner 2026-11-27 "ok go", Decision 4D).
 *
 * When a non-backfill, completed visit closes out (`service_records` saved), checks the
 * canonical pending-conversations view (`loadPendingSmsConversations`) for an unanswered
 * same-ET-day inbound SMS on the account whose original `house_voice` draft predated closeout.
 * Delegating to `loadPendingSmsConversations` selects the newest inbound per phone thread in
 * PostgreSQL (no row cutoff) AND respects SMS replies, completed staff phone callbacks,
 * staff booking/payment resolution actions, and opt-outs.
 *
 * Spend discipline: live Railway drafting is gated behind `GATE_SMS_POST_VISIT_REDRAFT`
 * (`smsPostVisitRedraftLive()`, strict `=== 'true'`, also requires `smsPromptB1Live()`, dark by
 * default). Revisions pass `liveEta: false` so Distance Matrix is never called outside budget,
 * never modify the original draft/card, never auto-send, and stay isolated from nightly judging
 * and shadow score totals. `findPostVisitRedraftCandidates()` is a read-only discovery helper
 * available for a future free Mac Max-plan runner (not yet wired into `sms-late-drafter.js`).
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, parseETDateTime, addETDays } = require('../utils/datetime-et');
const { validDateOnly } = require('../utils/date-only');
const { serviceDateOnly } = require('../utils/invoice-due-base-day');
const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
const { mediaCountFromMetadata } = require('./sms-gratitude-context');
const { SENT_STATUSES, threadHasLiveAnswer } = require('./sms-suggest-mode');
const { phoneMatchDigits } = require('../utils/phone');
const { loadPendingSmsConversations } = require('./sms-pending-conversations');

const INBOUND_TRIGGER = 'inbound';
const POST_VISIT_TRIGGER = 'post_visit_closeout';
const HOUSE_VOICE_DRAFTER = 'house_voice';
const AUTOMATED_REPLY_TYPES = ['ai_autosent', 'ai_gratitude'];
const DEFAULT_LOCK_RETRY_MS = 150;
const MAX_NO_CONNECTION_RETRIES = 2;

function etDayBounds(visitDateET) {
  const raw = String(visitDateET || '').trim();
  const day = validDateOnly(raw) ? raw : etDateString(new Date());
  const start = parseETDateTime(`${day}T00:00`);
  const nextDay = etDateString(addETDays(parseETDateTime(`${day}T12:00`), 1));
  const end = parseETDateTime(`${nextDay}T00:00`);
  return { day, start, end };
}

function lastTenPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

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

function pendingRowSmsLogId(row) {
  if (!row) return null;
  return row.legacy_id || (row.source === 'legacy' ? row.id : null);
}

async function loadSameDayPendingThreads(dbh, { customerId, start, end, doneAt }, deps = {}) {
  const loadPending = deps.loadPendingSmsConversations || loadPendingSmsConversations;
  const pending = await loadPending({ customerId, since: start, includeLegacyOnly: true, dbh });
  return (pending || []).filter((row) => {
    const smsLogId = pendingRowSmsLogId(row);
    if (!smsLogId) return false;
    const at = new Date(row.created_at).getTime();
    return Number.isFinite(at) && at >= start.getTime() && at < end.getTime() && at <= doneAt.getTime();
  });
}

async function evaluatePendingCandidate(dbh, pendingRow, { customerId, doneAt, checkLiveAnswer }) {
  const smsLogId = pendingRowSmsLogId(pendingRow);
  const inbound = await dbh('sms_log')
    .where({ id: smsLogId, customer_id: customerId, direction: 'inbound' })
    .first('id', 'from_phone', 'message_body', 'created_at', 'metadata');
  if (!inbound || !String(inbound.message_body || '').trim()) return null;

  const threadLast10 = lastTenPhone(inbound.from_phone);
  if (await checkLiveAnswer(dbh, {
    threadLast10,
    customerId,
    inboundCreatedAt: inbound.created_at,
    inboundSmsLogId: inbound.id,
  })) {
    return null;
  }

  if (await threadHasAutomatedAnswer(dbh, {
    threadLast10,
    customerId,
    inboundSmsLogId: inbound.id,
    inboundCreatedAt: inbound.created_at,
  })) {
    return null;
  }

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
 * Finds the newest eligible unanswered same-ET-day inbound SMS across ALL phone threads on
 * `customerId` via `loadPendingSmsConversations` (which performs `DISTINCT ON (peer, endpoint)`
 * in PostgreSQL and excludes SMS replies, staff phone callbacks, and staff booking/payment actions).
 */
async function findEligibleInboundForPostVisitRedraft(dbh, { customerId, completedAt, visitDateET }, deps = {}) {
  if (!dbh || !customerId) return null;
  const doneAt = completedAt instanceof Date ? completedAt : new Date(completedAt || Date.now());
  if (Number.isNaN(doneAt.getTime())) return null;
  const { start, end } = etDayBounds(visitDateET);
  const checkLiveAnswer = deps.threadHasLiveAnswer || threadHasLiveAnswer;

  const pendingRows = await loadSameDayPendingThreads(dbh, { customerId, start, end, doneAt }, deps);
  for (const row of pendingRows) {
    const eligible = await evaluatePendingCandidate(dbh, row, { customerId, doneAt, checkLiveAnswer });
    if (eligible) return eligible;
  }
  return null;
}

/**
 * Read-only paginated candidate discovery helper (not yet wired into `sms-late-drafter.js`).
 * Filters to completed, non-backfill, non-incomplete service records before pagination.
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
      .where('status', 'completed')
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

/**
 * Rechecks active, non-deleted, non-shared phone ownership inside the lock so a reassigned
 * or shared number can never receive a revision built from another account's visit details.
 */
async function loadUniquelyOwnedActiveCustomer(dbh, fromPhone, expectedCustomerId) {
  const matchDigits = phoneMatchDigits(fromPhone);
  if (!matchDigits.length) return null;
  const matches = await dbh('customers')
    .whereNull('deleted_at')
    .whereRaw("REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = ANY(?)", [matchDigits])
    .select('*');
  if (!Array.isArray(matches) || matches.length !== 1) return null;
  return String(matches[0].id) === String(expectedCustomerId) ? matches[0] : null;
}

async function generateClaimedRevision({
  dbh, customerId, eligible, serviceRecordId, dayStart, draftFn, checkLiveAnswer, loadPendingFn,
}) {
  const already = await dbh('message_drafts')
    .where({ sms_log_id: eligible.smsLogId, draft_trigger: POST_VISIT_TRIGGER })
    .first('id');
  if (already) return { skipped: 'already_revised' };

  const activeCustomer = await loadUniquelyOwnedActiveCustomer(dbh, eligible.fromPhone, customerId);
  if (!activeCustomer) return { skipped: 'phone_ownership_changed' };

  // Re-verify inside the lock against the canonical pending conversations view so any staff
  // SMS reply, completed phone callback, booking/payment resolution, or newer inbound text
  // that landed while waiting on lock slots stops paid drafting immediately.
  const loadPending = loadPendingFn || loadPendingSmsConversations;
  const stillPending = await loadPending({ customerId: activeCustomer.id, since: dayStart, includeLegacyOnly: true, dbh });
  if (!(stillPending || []).some((row) => String(pendingRowSmsLogId(row)) === String(eligible.smsLogId))) {
    return { skipped: 'resolved_before_lock' };
  }

  const threadLast10 = lastTenPhone(eligible.fromPhone);
  const liveChecker = checkLiveAnswer || threadHasLiveAnswer;
  if (await liveChecker(dbh, {
    threadLast10,
    customerId: activeCustomer.id,
    inboundCreatedAt: eligible.inboundAt,
    inboundSmsLogId: eligible.smsLogId,
  })) {
    return { skipped: 'answered_before_lock' };
  }
  if (await threadHasAutomatedAnswer(dbh, {
    threadLast10,
    customerId: activeCustomer.id,
    inboundSmsLogId: eligible.smsLogId,
    inboundCreatedAt: eligible.inboundAt,
  })) {
    return { skipped: 'answered_before_lock' };
  }

  const drafter = draftFn || ((args) => require('./sms-shadow-drafter').draftShadowReply(args));
  const draftId = await drafter({
    inboundMessage: eligible.inboundMessage,
    fromPhone: eligible.fromPhone,
    customer: activeCustomer,
    smsLogId: eligible.smsLogId,
    intent: eligible.intent,
    schedulingIntent: eligible.schedulingIntent,
    hasMedia: eligible.hasMedia,
    draftTrigger: POST_VISIT_TRIGGER,
    supersedesDraftId: eligible.priorDraftId,
    serviceRecordId: serviceRecordId || null,
    liveEta: false,
    skipAutoSend: true,
  });
  return { drafted: Boolean(draftId), draftId: draftId || null, supersedesDraftId: eligible.priorDraftId };
}

async function resolveRevisionInputs({ customerId, completedAt, visitDateET, dbh, threadHasLiveAnswerFn, loadPendingFn }) {
  const deps = {
    ...(threadHasLiveAnswerFn ? { threadHasLiveAnswer: threadHasLiveAnswerFn } : {}),
    ...(loadPendingFn ? { loadPendingSmsConversations: loadPendingFn } : {}),
  };
  const eligible = await findEligibleInboundForPostVisitRedraft(dbh, { customerId, completedAt, visitDateET }, deps);
  if (!eligible) return { skipped: 'none_eligible' };
  const { start } = etDayBounds(visitDateET);
  return { eligible, dayStart: start };
}

async function runWithCapacityRetries(acquire, lockKey, work, { sleepFn, maxRetries = MAX_NO_CONNECTION_RETRIES } = {}) {
  const sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const locked = await acquire(lockKey, work, { recordHealth: false });
    if (!wasLockSkipped(locked)) return locked;
    if (locked.reason !== 'no_connection') return { skipped: 'claim_in_flight' };
    if (attempt < maxRetries) await sleep(DEFAULT_LOCK_RETRY_MS * (attempt + 1));
  }
  return { skipped: 'lock_unavailable' };
}

async function draftPostVisitRevisionIfEligible(opts = {}) {
  const {
    customerId, serviceRecordId = null, completedAt, visitDateET,
    dbh = db, gates, draftFn, lockFn, sleepFn, threadHasLiveAnswerFn, loadPendingFn,
  } = opts;
  if (!customerId) return { skipped: 'missing_customer' };
  const featureGates = gates || require('../config/feature-gates');
  if (featureGates.smsPostVisitRedraftLive?.() !== true) return { skipped: 'gate_off' };

  const resolved = await resolveRevisionInputs({
    customerId, completedAt, visitDateET, dbh, threadHasLiveAnswerFn, loadPendingFn,
  });
  if (resolved.skipped) return resolved;

  try {
    return await runWithCapacityRetries(
      lockFn || runExclusive,
      `sms-post-visit-redraft:${resolved.eligible.smsLogId}`,
      () => generateClaimedRevision({
        dbh,
        customerId,
        eligible: resolved.eligible,
        serviceRecordId,
        dayStart: resolved.dayStart,
        draftFn,
        checkLiveAnswer: threadHasLiveAnswerFn,
        loadPendingFn,
      }),
      { sleepFn },
    );
  } catch (err) {
    if (err?.code === '23505') return { skipped: 'already_revised' };
    logger.warn(`[sms-post-visit-redraft] revision draft failed for customer ${customerId}: ${err?.code || err?.name || 'error'}`);
    return { skipped: 'error' };
  }
}

function triggerOnVisitComplete({ isBackfillCompletion, isIncompleteVisit, svc, record } = {}) {
  if (isBackfillCompletion || isIncompleteVisit || !svc?.customer_id || !record?.id) return;
  draftPostVisitRevisionIfEligible({
    customerId: svc.customer_id,
    serviceRecordId: record.id,
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
