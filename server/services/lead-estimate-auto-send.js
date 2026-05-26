const db = require('../models/db');
const logger = require('./logger');

const DEFAULT_DELAY_MINUTES = 5;
const DEFAULT_LIMIT = 10;
const DEFAULT_STALE_CLAIM_MINUTES = 30;
const DEFAULT_ALLOWED_REVIEW_REASONS = ['property_measurements_defaulted'];

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowedReviewReasons(value) {
  const items = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : DEFAULT_ALLOWED_REVIEW_REASONS;
}

function leadEstimateAutoSendConfigFromEnv(env = process.env) {
  return {
    delayMinutes: parsePositiveInt(env.LEAD_ESTIMATE_AUTO_SEND_DELAY_MINUTES, DEFAULT_DELAY_MINUTES),
    limit: parsePositiveInt(env.LEAD_ESTIMATE_AUTO_SEND_LIMIT, DEFAULT_LIMIT),
    staleClaimMinutes: parsePositiveInt(
      env.LEAD_ESTIMATE_AUTO_SEND_STALE_CLAIM_MINUTES,
      DEFAULT_STALE_CLAIM_MINUTES
    ),
    allowedReviewReasons: parseAllowedReviewReasons(env.LEAD_ESTIMATE_AUTO_SEND_ALLOWED_REVIEW_REASONS),
    sendMethod: ['sms', 'email', 'both'].includes(env.LEAD_ESTIMATE_AUTO_SEND_METHOD)
      ? env.LEAD_ESTIMATE_AUTO_SEND_METHOD
      : 'both',
  };
}

function isStaleAutoSendClaim(autoSend = {}, now = new Date(), staleClaimMinutes = DEFAULT_STALE_CLAIM_MINUTES) {
  const claimedAt = autoSend.claimedAt || autoSend.claimed_at;
  if (!claimedAt) return false;
  const claimedTime = new Date(claimedAt).getTime();
  if (!Number.isFinite(claimedTime)) return false;
  return now.getTime() - claimedTime >= Number(staleClaimMinutes || DEFAULT_STALE_CLAIM_MINUTES) * 60 * 1000;
}

function mergeAutoSendMetadata(estimateData, patch) {
  const data = parseJsonObject(estimateData);
  const automation = parseJsonObject(data.automation);
  return {
    ...data,
    automation: {
      ...automation,
      autoSend: {
        ...parseJsonObject(automation.autoSend),
        ...patch,
      },
    },
  };
}

function leadAutomationSummary(estimateData) {
  const data = parseJsonObject(estimateData);
  const automation = parseJsonObject(data.automation);
  const gate = parseJsonObject(automation.leadEstimateAutomation);
  const draft = parseJsonObject(automation.draftEstimateAutomation);
  const review = [
    ...(Array.isArray(gate.review) ? gate.review : []),
    ...(Array.isArray(draft.review) ? draft.review : []),
  ].filter(Boolean);
  return {
    gate,
    draft,
    autoSend: parseJsonObject(automation.autoSend),
    status: draft.status || gate.status || null,
    generated: draft.generated === true,
    quoteRequired: draft.quoteRequired === true || data.quoteRequired === true,
    review: [...new Set(review)],
  };
}

function leadEstimateAutoSendEligibility(estimate = {}, options = {}) {
  const config = {
    delayMinutes: DEFAULT_DELAY_MINUTES,
    staleClaimMinutes: DEFAULT_STALE_CLAIM_MINUTES,
    allowedReviewReasons: DEFAULT_ALLOWED_REVIEW_REASONS,
    ...options,
  };
  const summary = leadAutomationSummary(estimate.estimate_data || estimate.estimateData);
  const allowedReview = new Set(config.allowedReviewReasons || []);
  const disallowedReview = summary.review.filter((reason) => !allowedReview.has(reason));
  const createdAt = estimate.created_at || estimate.createdAt;
  const createdTime = createdAt ? new Date(createdAt).getTime() : NaN;
  const now = options.now instanceof Date ? options.now : new Date();
  const delayMs = Number(config.delayMinutes || DEFAULT_DELAY_MINUTES) * 60 * 1000;

  if (estimate.source !== 'lead_webhook') return { eligible: false, reason: 'not_lead_webhook_source' };
  if (estimate.status !== 'draft') return { eligible: false, reason: 'not_draft' };
  if (estimate.archived_at || estimate.archivedAt) return { eligible: false, reason: 'archived' };
  if (summary.autoSend.attemptedAt || summary.autoSend.attempted_at) return { eligible: false, reason: 'already_attempted' };
  if (summary.autoSend.blockedAt || summary.autoSend.blocked_at) return { eligible: false, reason: 'already_blocked' };
  if (
    (summary.autoSend.claimedAt || summary.autoSend.claimed_at)
    && !isStaleAutoSendClaim(summary.autoSend, now, config.staleClaimMinutes)
  ) {
    return { eligible: false, reason: 'already_claimed' };
  }
  if (summary.status !== 'generated' || !summary.generated) return { eligible: false, reason: 'not_generated' };
  if (summary.quoteRequired) return { eligible: false, reason: 'quote_required' };
  if (disallowedReview.length > 0) {
    return { eligible: false, reason: 'disallowed_review_reasons', review: disallowedReview };
  }
  if (!estimate.customer_phone && !estimate.customerPhone && !estimate.customer_email && !estimate.customerEmail) {
    return { eligible: false, reason: 'missing_delivery_contact' };
  }
  if (!Number.isFinite(createdTime)) return { eligible: false, reason: 'missing_created_at' };
  if ((now.getTime() - createdTime) < delayMs) return { eligible: false, reason: 'delay_not_elapsed' };

  return { eligible: true, reason: null };
}

async function candidateLeadEstimateAutoSends({
  database = db,
  now = new Date(),
  delayMinutes = DEFAULT_DELAY_MINUTES,
  limit = DEFAULT_LIMIT,
} = {}) {
  const cutoff = new Date(now.getTime() - delayMinutes * 60 * 1000);
  return database('estimates')
    .where({ source: 'lead_webhook', status: 'draft' })
    .where('created_at', '<=', cutoff)
    .whereNull('sent_at')
    .whereNull('scheduled_at')
    .whereRaw("estimate_data->'automation'->'draftEstimateAutomation'->>'status' = 'generated'")
    .whereRaw(`(
      estimate_data->'automation'->'autoSend' IS NULL
      OR (
        estimate_data->'automation'->'autoSend'->>'claimedAt' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'claimed_at' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'attemptedAt' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'attempted_at' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'blockedAt' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'blocked_at' IS NULL
      )
    )`)
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('*');
}

async function recoverStaleLeadEstimateAutoSendClaims({
  database = db,
  now = new Date(),
  staleClaimMinutes = DEFAULT_STALE_CLAIM_MINUTES,
  limit = DEFAULT_LIMIT,
} = {}) {
  const possibleStaleClaims = await database('estimates')
    .where({ source: 'lead_webhook', status: 'sending' })
    .whereNull('sent_at')
    .whereNull('scheduled_at')
    .whereRaw("estimate_data->'automation'->'draftEstimateAutomation'->>'status' = 'generated'")
    .whereRaw(`(
      estimate_data->'automation'->'autoSend'->>'claimedAt' IS NOT NULL
      OR estimate_data->'automation'->'autoSend'->>'claimed_at' IS NOT NULL
    )`)
    .whereRaw("estimate_data->'automation'->'autoSend'->>'attemptedAt' IS NULL")
    .whereRaw("estimate_data->'automation'->'autoSend'->>'attempted_at' IS NULL")
    .whereRaw("estimate_data->'automation'->'autoSend'->>'blockedAt' IS NULL")
    .whereRaw("estimate_data->'automation'->'autoSend'->>'blocked_at' IS NULL")
    .orderBy('updated_at', 'asc')
    .limit(limit)
    .select('*');

  let recovered = 0;
  for (const estimate of possibleStaleClaims) {
    const summary = leadAutomationSummary(estimate.estimate_data || estimate.estimateData);
    const claimedAt = summary.autoSend.claimedAt || summary.autoSend.claimed_at;
    if (!isStaleAutoSendClaim(summary.autoSend, now, staleClaimMinutes)) continue;

    const nextData = mergeAutoSendMetadata(estimate.estimate_data || estimate.estimateData, {
      claimedAt: null,
      claimed_at: null,
      recoveredAt: now.toISOString(),
      recoveredReason: 'stale_claim',
    });
    const updated = await database('estimates')
      .where({ id: estimate.id, source: 'lead_webhook', status: 'sending' })
      .whereRaw(`(
        estimate_data->'automation'->'autoSend'->>'claimedAt' = ?
        OR estimate_data->'automation'->'autoSend'->>'claimed_at' = ?
      )`, [claimedAt, claimedAt])
      .whereRaw("estimate_data->'automation'->'autoSend'->>'attemptedAt' IS NULL")
      .whereRaw("estimate_data->'automation'->'autoSend'->>'attempted_at' IS NULL")
      .whereRaw("estimate_data->'automation'->'autoSend'->>'blockedAt' IS NULL")
      .whereRaw("estimate_data->'automation'->'autoSend'->>'blocked_at' IS NULL")
      .update({
        status: 'draft',
        send_method: null,
        estimate_data: JSON.stringify(nextData),
        updated_at: database.fn.now(),
      });
    recovered += Number(updated || 0);
  }
  return recovered;
}

async function claimLeadEstimateAutoSend(database, estimate, { now = new Date(), sendMethod = 'both' } = {}) {
  const nextData = mergeAutoSendMetadata(estimate.estimate_data || estimate.estimateData, {
    claimedAt: now.toISOString(),
    sendMethod,
  });

  const [updated] = await database('estimates')
    .where({ id: estimate.id, source: 'lead_webhook', status: 'draft' })
    .whereNull('sent_at')
    .whereNull('scheduled_at')
    .whereRaw("estimate_data->'automation'->'draftEstimateAutomation'->>'status' = 'generated'")
    .whereRaw(`(
      estimate_data->'automation'->'autoSend' IS NULL
      OR (
        estimate_data->'automation'->'autoSend'->>'claimedAt' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'claimed_at' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'attemptedAt' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'attempted_at' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'blockedAt' IS NULL
        AND estimate_data->'automation'->'autoSend'->>'blocked_at' IS NULL
      )
    )`)
    .update({
      status: 'sending',
      send_method: sendMethod,
      estimate_data: JSON.stringify(nextData),
      updated_at: database.fn.now(),
    })
    .returning('*');
  return updated || null;
}

async function updateAutoSendMetadata(database, estimate, patch, status = estimate.status, extraUpdate = {}) {
  const nextData = mergeAutoSendMetadata(estimate.estimate_data || estimate.estimateData, patch);
  const [updated] = await database('estimates')
    .where({ id: estimate.id })
    .update({
      status,
      estimate_data: JSON.stringify(nextData),
      updated_at: database.fn.now(),
      ...extraUpdate,
    })
    .returning('*');
  return updated;
}

async function processLeadEstimateAutoSendBatch({
  database = db,
  now = new Date(),
  config = leadEstimateAutoSendConfigFromEnv(),
  sendEstimateNow,
} = {}) {
  const recovered = await recoverStaleLeadEstimateAutoSendClaims({
    database,
    now,
    staleClaimMinutes: config.staleClaimMinutes,
    limit: config.limit,
  });

  const candidates = await candidateLeadEstimateAutoSends({
    database,
    now,
    delayMinutes: config.delayMinutes,
    limit: config.limit,
  });

  const results = {
    scanned: candidates.length,
    sent: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    recovered,
  };

  for (const estimate of candidates) {
    const eligibility = leadEstimateAutoSendEligibility(estimate, { ...config, now });
    if (!eligibility.eligible) {
      if (['delay_not_elapsed', 'already_attempted', 'already_blocked', 'already_claimed'].includes(eligibility.reason)) {
        results.skipped += 1;
        continue;
      }
      await updateAutoSendMetadata(database, estimate, {
        blockedAt: now.toISOString(),
        blockedReason: eligibility.reason,
        blockedReviewReasons: eligibility.review || [],
      });
      results.blocked += 1;
      continue;
    }

    const claimed = await claimLeadEstimateAutoSend(database, estimate, {
      now,
      sendMethod: config.sendMethod,
    });
    if (!claimed) {
      results.skipped += 1;
      continue;
    }

    try {
      const sender = sendEstimateNow || require('../routes/admin-estimates').sendEstimateNow;
      const sendResult = await sender(claimed, config.sendMethod, {
        idempotencyKey: `lead-estimate-auto-send:${claimed.id}`,
        now: () => now,
      });
      if (sendResult.sent) {
        const sentEstimate = await database('estimates').where({ id: claimed.id }).first();
        if (sentEstimate) {
          await updateAutoSendMetadata(database, sentEstimate, {
            attemptedAt: now.toISOString(),
            result: 'sent',
            sentChannels: sendResult.sentChannels || [],
            failedChannels: sendResult.failedChannels || [],
          }, 'sent');
        }
        results.sent += 1;
        logger.info(`[lead-estimate-auto-send] sent estimate ${claimed.id}`);
      } else {
        await updateAutoSendMetadata(database, claimed, {
          attemptedAt: now.toISOString(),
          result: 'not_sent',
          channels: sendResult.channels || {},
          failedChannels: sendResult.failedChannels || [],
        }, 'draft', { send_method: null });
        results.failed += 1;
      }
    } catch (error) {
      await updateAutoSendMetadata(database, claimed, {
        attemptedAt: now.toISOString(),
        result: 'failed',
        error: String(error.message || error).slice(0, 1000),
      }, 'draft', { send_method: null });
      results.failed += 1;
      logger.error(`[lead-estimate-auto-send] estimate ${claimed.id} failed: ${error.message}`);
    }
  }

  return results;
}

module.exports = {
  DEFAULT_ALLOWED_REVIEW_REASONS,
  DEFAULT_DELAY_MINUTES,
  DEFAULT_STALE_CLAIM_MINUTES,
  claimLeadEstimateAutoSend,
  isStaleAutoSendClaim,
  leadEstimateAutoSendConfigFromEnv,
  leadEstimateAutoSendEligibility,
  leadAutomationSummary,
  mergeAutoSendMetadata,
  processLeadEstimateAutoSendBatch,
};
