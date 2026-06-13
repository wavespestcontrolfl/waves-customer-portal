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

const BACKFILL_PROMPT_VERSION = 'house_voice_v1_backfill';
const AI_ASSISTANT_LAST10 = '8559260203';
const REPLY_WINDOW_HOURS = 24; // mirror of the judge's pairing window

const DEFAULT_BATCH = Number(process.env.SHADOW_BACKFILL_BATCH) > 0
  ? Number(process.env.SHADOW_BACKFILL_BATCH)
  : 50;
const DEFAULT_SINCE_DAYS = Number(process.env.SHADOW_BACKFILL_SINCE_DAYS) > 0
  ? Number(process.env.SHADOW_BACKFILL_SINCE_DAYS)
  : 180;
const DEFAULT_JUDGE_BATCH = Number(process.env.SHADOW_BACKFILL_JUDGE_BATCH) > 0
  ? Number(process.env.SHADOW_BACKFILL_JUDGE_BATCH)
  : 150;

/**
 * Pure: would the live webhook have shadow-drafted an inbound to this
 * number? Location numbers only, with the AI assistant line excluded
 * explicitly — twilio-numbers reports the toll-free AI number as
 * type 'location' (twilio-numbers.js:107), so type alone is not enough.
 */
function isBackfillableNumber(toPhone) {
  const last10 = String(toPhone || '').replace(/\D/g, '').slice(-10);
  if (!last10 || last10 === AI_ASSISTANT_LAST10) return false;
  const config = TWILIO_NUMBERS.findByNumber(toPhone);
  return config?.type === 'location';
}

/**
 * Pure: the message_drafts insert row for one backfilled draft. Kept as a
 * builder so tests can pin the invariants (backdated created_at, shadow
 * status, backfill prompt_version).
 */
function buildBackfillDraftRow({ inbound, parsed, intent, context, draftMs }) {
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
    }),
    scheduling_intent: false,
    draft_ms: draftMs,
    // Backdated on purpose — see the module header.
    created_at: inbound.created_at,
  };
}

/**
 * Historical inbounds that (a) the live gate would have drafted, (b) have
 * no draft yet, and (c) have a human ground-truth reply inside the judge's
 * window. Overfetches because the location-number gate needs JS (the
 * number registry isn't in SQL); newest first so the freshest voice
 * examples score first.
 */
async function findBackfillCandidates({ batchSize = DEFAULT_BATCH, sinceDays = DEFAULT_SINCE_DAYS } = {}) {
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
  const matureBefore = new Date(Date.now() - REPLY_WINDOW_HOURS * 3600 * 1000);

  const rows = await db('sms_log as i')
    .where('i.direction', 'inbound')
    .whereNotNull('i.customer_id')
    .where('i.created_at', '>=', since)
    .where('i.created_at', '<', matureBefore)
    .whereRaw("COALESCE(i.message_type, '') NOT IN ('opt_out', 'opt_in', 'sms_reaction')")
    .whereRaw("NULLIF(TRIM(i.message_body), '') IS NOT NULL")
    .whereRaw('NOT EXISTS (SELECT 1 FROM message_drafts md WHERE md.sms_log_id = i.id)')
    .whereRaw(`EXISTS (
      SELECT 1 FROM sms_log o
      WHERE o.direction = 'outbound'
        AND o.customer_id = i.customer_id
        AND o.message_type IN ('manual', 'ai_approved', 'ai_revised')
        AND o.status IN ('queued', 'sent', 'delivered')
        AND o.created_at > i.created_at
        AND o.created_at < i.created_at + interval '24 hours'
    )`)
    .select('i.id', 'i.customer_id', 'i.message_body', 'i.to_phone', 'i.created_at')
    .orderBy('i.created_at', 'desc')
    .limit(batchSize * 3);

  return rows.filter((r) => isBackfillableNumber(r.to_phone)).slice(0, batchSize);
}

async function draftOneBackfill(inbound, customer) {
  const startedAt = Date.now();
  const drafter = require('./sms-shadow-drafter');
  const { classifyCustomerSmsTriageIntent } = require('./estimate-conversion-agent');
  const ContextAggregator = require('./context-aggregator');

  const intent = classifyCustomerSmsTriageIntent(inbound.message_body, { customer });
  const context = await ContextAggregator.getContextForCustomer(customer);

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 600,
    system: drafter.buildSystemPrompt(),
    messages: [{ role: 'user', content: drafter.buildUserPrompt(context, inbound.message_body, intent, false) }],
  });

  const parsed = drafter.parseShadowResponse(resp.content?.[0]?.text || '');
  if (!parsed) {
    logger.warn(`[shadow-backfill] unparseable draft (inbound ${String(inbound.id).slice(0, 8)}); skipping`);
    return null;
  }

  const row = buildBackfillDraftRow({ inbound, parsed, intent, context, draftMs: Date.now() - startedAt });
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
  isBackfillableNumber,
  buildBackfillDraftRow,
  findBackfillCandidates,
  runShadowBackfill,
};
