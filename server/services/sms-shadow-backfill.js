/**
 * SMS Shadow Backfill — judge-data accelerator for the brand-voice loop.
 *
 * The live loop only drafts on NEW inbound customer SMS and waits 24h
 * before judging, so per-intent score history accumulates at real inbound
 * volume — months to reach graduation thresholds. But sms_log already holds
 * months of (customer message → reply a human actually sent) pairs where
 * the ground truth EXISTS. This service drafts the house-voice reply for
 * those historical inbounds and inserts them as ordinary shadow rows, so
 * the EXISTING Phase C judge pairs and scores them with zero changes.
 *
 * Design points:
 *   - Rows are BACKDATED: message_drafts.created_at = the inbound's
 *     created_at. That makes them immediately judge-eligible (eligibility
 *     is created_at < now-24h) and sorts them honestly in the Shadow
 *     Drafts tab. The judge's pairing anchors on the inbound sms_log
 *     timestamp via sms_log_id, so window math is identical to live rows.
 *   - prompt_version = 'house_voice_v1_backfill' marks the samples:
 *     customer context is aggregated AS OF NOW, not as of the original
 *     message, so action-fit scores carry drift noise (voice/safety scores
 *     are fully valid). Phase E can weight backfill vs live separately.
 *   - status='shadow' is hard-coded — historical inbounds must NEVER
 *     publish composer suggestion cards, whatever the intent mode says.
 *   - Selection requires a human ground-truth reply within the judge's
 *     24h window, so nearly every backfilled draft yields an LLM-scored
 *     verdict — maximum signal per Anthropic call.
 *   - Same eligibility semantics as the live webhook gate: customer
 *     matched, non-empty body, not a reaction/opt message, inbound to a
 *     location number, AI assistant number excluded (TWILIO_NUMBERS
 *     reports it as type 'location' — the documented trap).
 *   - Self-terminating: the anti-join on message_drafts.sms_log_id means
 *     exhausted history yields zero candidates and the cron no-ops.
 *
 * PII: never log message bodies or full phone numbers from this module.
 */
const MODELS = require('../config/models');
const db = require('../models/db');
const logger = require('./logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { hasSchedulingIntent } = require('./sms-intent');

// v3 (06-13): tracks the drafter's verify→revise loop. v1/v2 cohorts (both
// 32% unsafe — identical, confirming homogeneous populations) stay the
// baseline; the remaining candidates run under v3 — a valid control cohort
// to measure whether the verify loop cuts the draft_unsafe rate.
const BACKFILL_PROMPT_VERSION = 'house_voice_v3_backfill';
const REPLY_WINDOW_HOURS = 24; // mirror of the judge's pairing window

// Inbound message_types the live webhook handles in a branch that returns
// BEFORE the shadow drafter runs (twilio-webhook.js): opt keywords +
// reactions, plus reschedule_reply and lead_intake. The live system never
// shadow-samples these, so the backfill must not either.
const PREHANDLED_INBOUND_TYPES = ['opt_out', 'opt_in', 'sms_reaction', 'reschedule_reply', 'lead_intake'];

function phoneLast10(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

/**
 * Location-number allowlist derived from config, never literals: only the
 * staffed-location lines the live webhook shadow-drafts. The AI assistant
 * toll-free line is structurally excluded — it lives in
 * TWILIO_NUMBERS.tollFree, not .locations, so it can never enter this set
 * even though findByNumber() reports it as type 'location' (the documented
 * registry trap). A config number change flows through automatically.
 */
function locationNumberLast10s() {
  return Object.values(TWILIO_NUMBERS.locations || {})
    .map((l) => phoneLast10(l.number))
    .filter(Boolean);
}

const DEFAULT_BATCH = Number(process.env.SHADOW_BACKFILL_BATCH) > 0
  ? Number(process.env.SHADOW_BACKFILL_BATCH)
  : 50;
const DEFAULT_SINCE_DAYS = Number(process.env.SHADOW_BACKFILL_SINCE_DAYS) > 0
  ? Number(process.env.SHADOW_BACKFILL_SINCE_DAYS)
  : 180;
const DEFAULT_JUDGE_BATCH = Number(process.env.SHADOW_BACKFILL_JUDGE_BATCH) > 0
  ? Number(process.env.SHADOW_BACKFILL_JUDGE_BATCH)
  : 150;

/** Pure: would the live webhook have shadow-drafted an inbound to this number? */
function isBackfillableNumber(toPhone) {
  const last10 = phoneLast10(toPhone);
  return Boolean(last10) && locationNumberLast10s().includes(last10);
}

/**
 * Pure: bound the aggregated context to what existed BEFORE the historical
 * inbound. ContextAggregator returns the customer's latest SMS thread —
 * which, for an old inbound, includes the human reply the judge later
 * treats as ground truth. Leaving it in lets the model copy the answer and
 * inflates every backfill score (test-set leakage). Strictly-before also
 * drops the inbound itself: buildUserPrompt appends it separately, same as
 * the live path. Other context (balance, next service) still reflects
 * today — that drift is accepted and flagged via prompt_version; the
 * ground-truth reply is the one thing that must never reach the prompt.
 */
function boundContextToInbound(context, inboundAt) {
  const anchor = new Date(inboundAt).getTime();
  return {
    ...context,
    smsHistory: (context.smsHistory || []).filter((m) => {
      // new Date(null) is epoch zero, not NaN — reject missing dates
      // explicitly so an undateable row can never sneak the ground-truth
      // reply past the strictly-before cut.
      const t = m.date ? new Date(m.date).getTime() : NaN;
      return Number.isFinite(t) && t < anchor;
    }),
  };
}

/**
 * Pure: the message_drafts insert row for one backfilled draft. Kept as a
 * builder so tests can pin the invariants (backdated created_at, shadow
 * status, backfill prompt_version).
 */
function buildBackfillDraftRow({ inbound, parsed, intent, context, draftMs, verify }) {
  return {
    sms_log_id: inbound.id,
    customer_id: inbound.customer_id,
    inbound_message: inbound.message_body,
    draft_response: parsed.reply,
    intent: intent?.intent || 'GENERAL',
    intent_confidence: intent?.confidence ?? null,
    context_summary: context.summary || null,
    flags: JSON.stringify(context.flags || []),
    status: 'shadow',
    drafter: 'house_voice',
    model: MODELS.FLAGSHIP,
    prompt_version: BACKFILL_PROMPT_VERSION,
    intended_actions: JSON.stringify({
      actions: parsed.intended_actions,
      missing_info: parsed.missing_info,
      ...(verify ? { verify } : {}),
    }),
    // Same classifier the live webhook uses — scheduling texts keep their
    // high-stakes prompt guard and stay distinguishable in judge data.
    scheduling_intent: hasSchedulingIntent(inbound.message_body),
    draft_ms: draftMs,
    // Backdated on purpose — see the module header.
    created_at: inbound.created_at,
  };
}

/**
 * Historical inbounds that (a) the live gate would have drafted, (b) have
 * no draft yet, and (c) have a human ground-truth reply inside the judge's
 * window. The location-number allowlist is applied IN SQL so the limit
 * always advances past non-location traffic — a JS post-filter over a
 * capped fetch could stall forever on a run of AI/tracking-number rows.
 * Newest first so the freshest voice examples score first.
 */
async function findBackfillCandidates({ batchSize = DEFAULT_BATCH, sinceDays = DEFAULT_SINCE_DAYS } = {}) {
  const allowedLast10 = locationNumberLast10s();
  if (!allowedLast10.length) return [];
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
  const matureBefore = new Date(Date.now() - REPLY_WINDOW_HOURS * 3600 * 1000);

  return db('sms_log as i')
    .where('i.direction', 'inbound')
    .whereNotNull('i.customer_id')
    .where('i.created_at', '>=', since)
    .where('i.created_at', '<', matureBefore)
    // Full parity with the live webhook's pre-drafter early returns
    // (PREHANDLED_INBOUND_TYPES): drafting those would sample flows the live
    // system never samples and skew per-intent graduation data.
    .whereRaw("COALESCE(i.message_type, '') <> ALL(?)", [PREHANDLED_INBOUND_TYPES])
    .whereRaw("NULLIF(TRIM(i.message_body), '') IS NOT NULL")
    .whereRaw(
      `RIGHT(REGEXP_REPLACE(COALESCE(i.to_phone, ''), '[^0-9]', '', 'g'), 10) = ANY(?)`,
      [allowedLast10]
    )
    // Skip only inbounds that already have a HOUSE-VOICE sample (live shadow
    // row or a prior backfill row — both drafter='house_voice'). A legacy
    // approval-queue draft (drafter NULL, non-shadow status) is invisible to
    // the judge, so its inbound still needs a judgeable house-voice draft;
    // the old any-draft anti-join wrongly skipped all of those.
    .whereRaw("NOT EXISTS (SELECT 1 FROM message_drafts md WHERE md.sms_log_id = i.id AND md.drafter = 'house_voice')")
    // Deleted customers would re-select every run (no draft ever lands, the
    // anti-join stays true) — exclude them here so exhaustion is clean.
    .whereRaw('EXISTS (SELECT 1 FROM customers c WHERE c.id = i.customer_id AND c.deleted_at IS NULL)')
    // Mirrors the judge's pairing EXACTLY, including the burst cap: the
    // judge ends each draft's reply window at the customer's NEXT real
    // inbound, so a reply that lands after a follow-up text is ground
    // truth for THAT text, not this one. Without the inner NOT EXISTS, an
    // early burst inbound buys a paid draft the judge then files as
    // human_no_reply — spend with no score.
    .whereRaw(`EXISTS (
      SELECT 1 FROM sms_log o
      WHERE o.direction = 'outbound'
        AND o.customer_id = i.customer_id
        AND o.message_type IN ('manual', 'ai_approved', 'ai_revised')
        AND o.status IN ('queued', 'sent', 'delivered')
        AND NULLIF(TRIM(o.message_body), '') IS NOT NULL
        AND o.created_at > i.created_at
        AND o.created_at < i.created_at + interval '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM sms_log b
          WHERE b.direction = 'inbound'
            AND b.customer_id = i.customer_id
            AND b.id <> i.id
            AND COALESCE(b.message_type, '') NOT IN ('opt_out', 'opt_in', 'sms_reaction')
            AND b.created_at > i.created_at
            AND b.created_at < o.created_at
        )
    )`)
    .select('i.id', 'i.customer_id', 'i.message_body', 'i.to_phone', 'i.created_at')
    .orderBy('i.created_at', 'desc')
    .limit(batchSize);
}

async function draftOneBackfill(inbound, customer) {
  const startedAt = Date.now();
  const drafter = require('./sms-shadow-drafter');
  const { classifyCustomerSmsTriageIntent } = require('./estimate-conversion-agent');
  const ContextAggregator = require('./context-aggregator');

  const intent = classifyCustomerSmsTriageIntent(inbound.message_body, { customer });
  // Bound the SMS thread to strictly before this inbound — the unbounded
  // context contains the human's actual reply, i.e. the judge's ground
  // truth. See boundContextToInbound.
  const context = boundContextToInbound(
    await ContextAggregator.getContextForCustomer(customer),
    inbound.created_at
  );

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // Same draft→verify→revise loop the live drafter uses (v3).
  const { parsed, passes, converged } = await drafter.generateGroundedDraft({
    client,
    context,
    inboundMessage: inbound.message_body,
    intent,
    schedulingIntent: hasSchedulingIntent(inbound.message_body),
  });
  if (!parsed) {
    logger.warn(`[shadow-backfill] unparseable draft (inbound ${String(inbound.id).slice(0, 8)}); skipping`);
    return null;
  }

  const row = buildBackfillDraftRow({
    inbound, parsed, intent, context, draftMs: Date.now() - startedAt, verify: { passes, converged },
  });
  const [inserted] = await db('message_drafts')
    .insert(row)
    .onConflict()
    .ignore()
    .returning('id');
  return inserted?.id || null;
}

/**
 * One batched pass: draft up to batchSize historical pairs, then run the
 * existing judge with a raised batch limit so backfill rows score the same
 * cycle (their backdated created_at makes them immediately eligible).
 * Caller is responsible for gating and runExclusive.
 */
async function runShadowBackfill({ batchSize = DEFAULT_BATCH, sinceDays = DEFAULT_SINCE_DAYS, judgeBatch = DEFAULT_JUDGE_BATCH } = {}) {
  const startedAt = Date.now();
  const candidates = await findBackfillCandidates({ batchSize, sinceDays });
  if (!candidates.length) {
    logger.info('[shadow-backfill] no remaining candidates — backfill exhausted');
    return { drafted: 0, failed: 0, judged: 0, exhausted: true, ms: Date.now() - startedAt };
  }

  const customerIds = [...new Set(candidates.map((c) => c.customer_id))];
  const customers = await db('customers').whereIn('id', customerIds).whereNull('deleted_at');
  const customersById = new Map(customers.map((c) => [c.id, c]));

  let drafted = 0;
  let failed = 0;
  for (const inbound of candidates) {
    const customer = customersById.get(inbound.customer_id);
    if (!customer) {
      failed += 1;
      continue;
    }
    try {
      const id = await draftOneBackfill(inbound, customer);
      if (id) drafted += 1; else failed += 1;
    } catch (err) {
      failed += 1;
      logger.error(`[shadow-backfill] draft failed (inbound ${String(inbound.id).slice(0, 8)}): ${err.message}`);
    }
  }

  // Judge in the same pass under the judge's own cron lock so a
  // concurrently-firing nightly run can't double-process.
  let judgeSummary = { judged: 0 };
  try {
    const { runExclusive } = require('../utils/cron-lock');
    const { judgeShadowDrafts } = require('./sms-shadow-judge');
    judgeSummary = await runExclusive('shadow-judge', () => judgeShadowDrafts({ batchLimit: judgeBatch }))
      || { judged: 0 };
  } catch (err) {
    logger.error(`[shadow-backfill] judge pass failed: ${err.message}`);
  }

  const summary = { drafted, failed, judged: judgeSummary.judged || 0, exhausted: false, ms: Date.now() - startedAt };
  logger.info(`[shadow-backfill] run complete: drafted=${summary.drafted} failed=${summary.failed} judged=${summary.judged} ms=${summary.ms}`);
  return summary;
}

module.exports = {
  BACKFILL_PROMPT_VERSION,
  REPLY_WINDOW_HOURS,
  PREHANDLED_INBOUND_TYPES,
  isBackfillableNumber,
  boundContextToInbound,
  buildBackfillDraftRow,
  findBackfillCandidates,
  runShadowBackfill,
};
