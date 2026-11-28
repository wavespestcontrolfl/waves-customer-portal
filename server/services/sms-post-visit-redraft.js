'use strict';

/**
 * Post-Visit SMS Re-Draft Revision Service (owner 2026-11-27 "ok go", Decision 4D).
 *
 * When a visit completes (`service_records` saved), checks whether the customer sent an
 * unanswered inbound SMS earlier the SAME ET calendar day whose original draft was created
 * before the visit finished. If so, generates ONE linked revision row (`draft_trigger =
 * 'post_visit_closeout'`, `supersedes_draft_id = priorDraft.id`) with the fresh post-closeout
 * visit findings — WITHOUT modifying the original `inbound` draft (keeping nightly judge and
 * sealed-exam baselines intact) and WITHOUT sending any customer message.
 *
 * Cost discipline: runs live on Railway ONLY while `smsShadowDrafts` or `smsSuggestMode` is on.
 * While Mac-only late drafting runs, returns `{ skipped: 'live_drafting_off' }` ($0 API cost)
 * and exports `findPostVisitRedraftCandidates` so the Mac runner can draft revisions for free.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, parseETDateTime, addETDays } = require('../utils/datetime-et');
const { validDateOnly } = require('../utils/date-only');
const { serviceDateOnly } = require('../utils/invoice-due-base-day');
const { HUMAN_REPLY_TYPES, SENT_STATUSES } = require('./sms-suggest-mode');

const INBOUND_TRIGGER = 'inbound';
const POST_VISIT_TRIGGER = 'post_visit_closeout';
const ANSWERED_REPLY_TYPES = [...HUMAN_REPLY_TYPES, 'ai_autosent', 'ai_gratitude'];
const IGNORED_INBOUND_TYPES = ['opt_out', 'opt_in', 'sms_reaction'];

function etDayBounds(visitDateET) {
  const raw = String(visitDateET || '').trim();
  const day = validDateOnly(raw) ? raw : etDateString(new Date());
  const start = parseETDateTime(`${day}T00:00`);
  const nextDay = etDateString(addETDays(parseETDateTime(`${day}T12:00`), 1));
  const end = parseETDateTime(`${nextDay}T00:00`);
  return { day, start, end };
}

function isLiveDraftingEnabled(gates) {
  const featureGates = gates || require('../config/feature-gates');
  return Boolean(featureGates.isEnabled?.('smsShadowDrafts') || featureGates.isEnabled?.('smsSuggestMode'));
}

/**
 * Find the newest unanswered same-ET-day inbound SMS for `customerId` whose original inbound
 * draft predates `completedAt` and has no `post_visit_closeout` revision yet.
 */
async function findEligibleInboundForPostVisitRedraft(dbh, { customerId, completedAt, visitDateET }) {
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
    .whereRaw("TRIM(COALESCE(s.message_body, '')) <> ''")
    .orderBy('s.created_at', 'desc')
    .first('s.id', 's.from_phone', 's.message_body', 's.created_at');

  if (!inbound) return null;

  // Stop if a human or approved reply already answered this inbound text.
  const answered = await dbh('sms_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    .where('created_at', '>', inbound.created_at)
    .whereIn('message_type', ANSWERED_REPLY_TYPES)
    .whereIn('status', [...SENT_STATUSES, 'scheduled', 'sending'])
    .first('id');
  if (answered) return null;

  // Must have an original inbound draft that predates visit completion.
  const priorDraft = await dbh('message_drafts')
    .where({ sms_log_id: inbound.id })
    .whereRaw("COALESCE(draft_trigger, 'inbound') = ?", [INBOUND_TRIGGER])
    .where('created_at', '<', doneAt)
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
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
  };
}

/**
 * Read-only batch candidate query for the Mac Max-plan late drafter ($0 API cost).
 */
async function findPostVisitRedraftCandidates(dbh, { visitDateET, limit = 25 } = {}) {
  const { day, start, end } = etDayBounds(visitDateET);
  const records = await dbh('service_records')
    .where('service_date', day)
    .whereNotNull('customer_id')
    .orderBy('created_at', 'desc')
    .limit(limit * 3)
    .select('id', 'customer_id', 'created_at');

  const seenCustomers = new Set();
  const candidates = [];
  for (const rec of records) {
    if (seenCustomers.has(rec.customer_id)) continue;
    seenCustomers.add(rec.customer_id);
    const eligible = await findEligibleInboundForPostVisitRedraft(dbh, {
      customerId: rec.customer_id,
      completedAt: rec.created_at,
      visitDateET: day,
    });
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
  return candidates;
}

/**
 * Post-commit hook for visit completion. Never throws, never sends any customer message.
 */
async function draftPostVisitRevisionIfEligible({
  customerId,
  completedAt,
  visitDateET,
  dbh = db,
  gates = null,
  draftFn = null,
} = {}) {
  if (!customerId) return { skipped: 'missing_customer' };
  if (!isLiveDraftingEnabled(gates)) return { skipped: 'live_drafting_off' };

  const eligible = await findEligibleInboundForPostVisitRedraft(dbh, { customerId, completedAt, visitDateET });
  if (!eligible) return { skipped: 'none_eligible' };

  const customer = await dbh('customers').where({ id: customerId }).first();
  if (!customer) return { skipped: 'customer_not_found' };

  try {
    const drafter = draftFn || ((args) => require('./sms-shadow-drafter').draftShadowReply(args));
    const draftId = await drafter({
      inboundMessage: eligible.inboundMessage,
      fromPhone: eligible.fromPhone,
      customer,
      smsLogId: eligible.smsLogId,
      draftTrigger: POST_VISIT_TRIGGER,
      supersedesDraftId: eligible.priorDraftId,
      skipAutoSend: true,
    });
    return { drafted: Boolean(draftId), draftId: draftId || null, supersedesDraftId: eligible.priorDraftId };
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
  ANSWERED_REPLY_TYPES,
  etDayBounds,
  findEligibleInboundForPostVisitRedraft,
  findPostVisitRedraftCandidates,
  draftPostVisitRevisionIfEligible,
  triggerOnVisitComplete,
};
