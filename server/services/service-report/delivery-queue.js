const db = require('../../models/db');
const logger = require('../logger');
const { sendServiceReportV1Email } = require('./email-delivery');
const { alertServiceReportDeliveryFailed } = require('./failure-alerts');

const CLAIM_LIMIT = 10;
const STALE_CLAIM_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MINUTES = [5, 15, 60, 240, 1440];

function isMissingQueueError(err) {
  return err?.code === '42P01' || err?.code === '42703';
}

function nextServiceReportDeliveryAttemptAt(now = new Date(), attempts = 1) {
  const index = Math.min(Math.max(Number(attempts || 1) - 1, 0), RETRY_DELAYS_MINUTES.length - 1);
  return new Date(now.getTime() + RETRY_DELAYS_MINUTES[index] * 60 * 1000);
}

async function mergeServiceRecordDeliveryNotes(serviceRecordId, patch, knex = db) {
  if (!serviceRecordId || !patch || typeof patch !== 'object') return;
  try {
    await knex('service_records').where({ id: serviceRecordId }).update({
      structured_notes: knex.raw("COALESCE(structured_notes, '{}'::jsonb) || ?::jsonb", [JSON.stringify(patch)]),
    });
  } catch (err) {
    if (isMissingQueueError(err)) return;
    logger.warn(`[service-report-delivery] service record note sync failed for ${serviceRecordId}: ${err.message}`);
  }
}

async function enqueueServiceReportV1EmailDelivery({
  serviceRecordId,
  customerId,
  token,
  reportUrl,
  pdfUrl,
  payload,
  // Earliest dispatch delay — used to durably hold the email while grounded
  // report copy settles (the worker attaches the CURRENT pdf at send time,
  // so a held job self-heals; a process-local deferral would strand on
  // restart — codex P1 #3093 r16).
  delayMs = 0,
} = {}, knex = db) {
  if (!serviceRecordId) throw new Error('serviceRecordId is required');

  try {
    const existing = await knex('service_report_deliveries')
      .where({
        service_record_id: serviceRecordId,
        channel: 'email',
        report_template_version: 'service_report_v1',
      })
      .first();
    if (existing) return { ok: true, queued: false, delivery: existing };

    const row = {
      service_record_id: serviceRecordId,
      customer_id: customerId || null,
      channel: 'email',
      report_template_version: 'service_report_v1',
      status: 'queued',
      report_token: token || null,
      report_url: reportUrl || null,
      pdf_url: pdfUrl || null,
      payload: payload || {},
      attempts: 0,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
      next_attempt_at: new Date(Date.now() + Math.max(0, Number(delayMs) || 0)),
      created_at: new Date(),
      updated_at: new Date(),
    };
    const [inserted] = await knex('service_report_deliveries').insert(row).returning('*');
    return { ok: true, queued: true, delivery: inserted || row };
  } catch (err) {
    if (err?.code === '23505') {
      const existing = await knex('service_report_deliveries')
        .where({
          service_record_id: serviceRecordId,
          channel: 'email',
          report_template_version: 'service_report_v1',
        })
        .first();
      if (existing) return { ok: true, queued: false, delivery: existing };
    }
    if (isMissingQueueError(err)) {
      logger.warn(`[service-report-delivery] queue table unavailable; delivery not queued for ${serviceRecordId}`);
      return { ok: false, skipped: true, error: 'service_report_deliveries table unavailable' };
    }
    throw err;
  }
}

async function recoverStaleServiceReportDeliveryClaims(now = new Date(), knex = db) {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  try {
    const result = await knex.raw(`
      UPDATE service_report_deliveries
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
          next_attempt_at = CASE WHEN attempts >= max_attempts THEN next_attempt_at ELSE ? END,
          failed_at = CASE WHEN attempts >= max_attempts THEN ? ELSE failed_at END,
          locked_at = NULL,
          last_error = COALESCE(last_error, 'Recovered stale delivery claim'),
          updated_at = ?
      WHERE status = 'sending'
        AND locked_at <= ?
      RETURNING *
    `, [now, now, now, staleBefore]);
    const rows = result.rows || [];
    const failedRows = rows.filter((row) => row.status === 'failed');
    // A claim that goes stale on its final attempt is flipped straight to
    // 'failed' here in bulk SQL, never through markDeliveryFailed — so without
    // this it would skip the admin bell every other terminal failure raises,
    // leaving a permanently undelivered report silent. This is exactly the
    // crash-on-final-attempt case the delivery-failure alert (#1899) exists to
    // catch. Best-effort and deduped per delivery id (shared key with
    // markDeliveryFailed, so an overlapping normal failure can't double-alert),
    // and the helper never throws, so it can't break the queue sweep.
    for (const row of failedRows) {
      await alertServiceReportDeliveryFailed({
        delivery: row,
        error: new Error(row.last_error || 'Recovered stale delivery claim'),
      }, { knex });
    }
    return {
      recovered: rows.length,
      retried: rows.filter((row) => row.status === 'queued').length,
      failed: failedRows.length,
    };
  } catch (err) {
    if (isMissingQueueError(err)) return { recovered: 0, retried: 0, failed: 0, skipped: true };
    throw err;
  }
}

async function claimDueServiceReportDeliveries(now = new Date(), limit = CLAIM_LIMIT, knex = db) {
  try {
    const result = await knex.raw(`
      WITH due AS (
        SELECT id
        FROM service_report_deliveries
        WHERE status = 'queued'
          AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ?
      )
      UPDATE service_report_deliveries AS d
      SET status = 'sending',
          attempts = attempts + 1,
          last_attempt_at = ?,
          locked_at = ?,
          updated_at = ?
      FROM due
      WHERE d.id = due.id
      RETURNING d.*
    `, [now, limit, now, now, now]);
    return result.rows || [];
  } catch (err) {
    if (isMissingQueueError(err)) return [];
    throw err;
  }
}

async function markDeliverySent(delivery, result = {}, knex = db) {
  const sentAt = new Date();
  await knex('service_report_deliveries').where({ id: delivery.id }).update({
    status: 'sent',
    sent_at: sentAt,
    locked_at: null,
    provider_message_id: result.messageId || null,
    last_error: null,
    updated_at: new Date(),
  });
  await mergeServiceRecordDeliveryNotes(delivery.service_record_id, {
    serviceReportV1EmailStatus: 'sent',
    serviceReportV1EmailSentAt: sentAt.toISOString(),
    serviceReportV1EmailError: null,
    serviceReportV1EmailMessageId: result.messageId || null,
    serviceReportV1EmailAttachedPdf: !!result.attachedPdf,
  }, knex);
}

async function markDeliverySkipped(delivery, result = {}, knex = db) {
  const skippedAt = new Date();
  await knex('service_report_deliveries').where({ id: delivery.id }).update({
    status: 'skipped',
    skipped_at: skippedAt,
    locked_at: null,
    last_error: result.error || result.reason || null,
    updated_at: new Date(),
  });
  await mergeServiceRecordDeliveryNotes(delivery.service_record_id, {
    serviceReportV1EmailStatus: 'skipped',
    serviceReportV1EmailSkippedAt: skippedAt.toISOString(),
    serviceReportV1EmailError: result.error || result.reason || null,
  }, knex);
}

async function markDeliveryFailed(delivery, err, knex = db) {
  const now = new Date();
  const attempts = Number(delivery.attempts || 0);
  const maxAttempts = Number(delivery.max_attempts || DEFAULT_MAX_ATTEMPTS);
  const exhausted = attempts >= maxAttempts;
  await knex('service_report_deliveries').where({ id: delivery.id }).update({
    status: exhausted ? 'failed' : 'queued',
    next_attempt_at: exhausted ? delivery.next_attempt_at : nextServiceReportDeliveryAttemptAt(now, attempts),
    failed_at: exhausted ? now : null,
    locked_at: null,
    last_error: err?.message || err?.error || String(err || 'Delivery failed'),
    updated_at: now,
  });
  await mergeServiceRecordDeliveryNotes(delivery.service_record_id, {
    serviceReportV1EmailStatus: exhausted ? 'failed' : 'queued',
    serviceReportV1EmailFailedAt: exhausted ? now.toISOString() : null,
    serviceReportV1EmailNextAttemptAt: exhausted ? null : nextServiceReportDeliveryAttemptAt(now, attempts).toISOString(),
    serviceReportV1EmailError: err?.message || err?.error || String(err || 'Delivery failed'),
  }, knex);
  // Terminal failure: surface it on the admin bell so the report can be re-sent
  // manually. Best-effort — never let a notification problem break the queue.
  if (exhausted) {
    await alertServiceReportDeliveryFailed({ delivery, error: err }, { knex });
  }
  return exhausted ? 'failed' : 'queued';
}

async function processServiceReportDelivery(delivery, knex = db) {
  if (!delivery || delivery.channel !== 'email' || delivery.report_template_version !== 'service_report_v1') {
    await markDeliverySkipped(delivery, { error: 'Unsupported service report delivery' }, knex);
    return { status: 'skipped' };
  }

  // Jobs held for grounding: an elapsed hold is NOT proof the grounded
  // write/sanitize ran (the enqueuing process may have died) — the worker
  // enforces readiness itself by running the deterministic sanitize before
  // sending (idempotent, advisory-locked, no-op on already-grounded copy).
  // A sanitize ERROR means safety is unverified — defer via the normal
  // failure/backoff path instead of emailing possibly-stale copy (codex P1
  // #3093 r17).
  const heldPayload = (delivery.payload && typeof delivery.payload === 'object') ? delivery.payload : {};
  let lawnFenceCheck = null;
  if (heldPayload.awaiting_grounding && heldPayload.lawn_assessment_id) {
    const KnowledgeBridge = require('../knowledge-bridge');
    const sanitized = await KnowledgeBridge.sanitizeStoredRecommendations(heldPayload.lawn_assessment_id);
    if (sanitized?.error) {
      const status = await markDeliveryFailed(delivery, new Error(`grounding readiness unverified: ${sanitized.error}`), knex);
      return { status, error: sanitized.error };
    }
    // Capture the settled copy's version NOW and re-verify it after the
    // attachment renders, right before dispatch (codex P1 r36): a run that
    // starts after this one-time check must defer the send, not race it.
    const { treatmentGuard } = KnowledgeBridge;
    const assessmentId = heldPayload.lawn_assessment_id;
    let versionAtCheck = null;
    try {
      const row = await knex('lawn_assessments').where({ id: assessmentId }).first('recommendations', 'ai_summary', 'updated_at');
      versionAtCheck = row ? JSON.stringify([row.recommendations, row.ai_summary, row.updated_at]) : null;
    } catch (verErr) {
      const status = await markDeliveryFailed(delivery, new Error(`grounding version unreadable: ${verErr.message}`), knex);
      return { status, error: verErr.message };
    }
    lawnFenceCheck = async () => {
      try {
        if (await treatmentGuard.isGenerationInFlight(assessmentId, knex)) return false;
        const row = await knex('lawn_assessments').where({ id: assessmentId }).first('recommendations', 'ai_summary', 'updated_at');
        const versionNow = row ? JSON.stringify([row.recommendations, row.ai_summary, row.updated_at]) : null;
        return versionNow === versionAtCheck;
      } catch {
        return false; // unreadable fence state = defer, never send blind
      }
    };
  }

  try {
    // Held deliveries FORCE a fresh render at send time: copy was unsettled
    // when the first PDF rendered, and no fence can cover every render path
    // — the public report route renders synchronously without a job row and
    // could write a pre-finalization key after any invalidation (codex P1
    // r20/r22/r23). forceFreshPdf skips the stored-object lookup entirely,
    // so the attachment is always produced from the just-sanitized copy.
    const result = await sendServiceReportV1Email(delivery.service_record_id, {
      token: delivery.report_token,
      reportUrl: delivery.report_url,
      pdfUrl: delivery.pdf_url,
      forceFreshPdf: !!(heldPayload.awaiting_grounding && heldPayload.lawn_assessment_id),
      verifyBeforeSend: lawnFenceCheck,
    });
    if (result.ok) {
      await markDeliverySent(delivery, result, knex);
      return { status: 'sent', result };
    }
    if (result.skipped) {
      await markDeliverySkipped(delivery, result, knex);
      return { status: 'skipped', result };
    }
    const status = await markDeliveryFailed(delivery, new Error(result.error || 'Email delivery failed'), knex);
    return { status, result };
  } catch (err) {
    const status = await markDeliveryFailed(delivery, err, knex);
    return { status, error: err.message };
  }
}

async function processDueServiceReportDeliveries({ now = new Date(), limit = CLAIM_LIMIT } = {}, knex = db) {
  const summary = {
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    requeued: 0,
    recovered: 0,
  };

  const recovered = await recoverStaleServiceReportDeliveryClaims(now, knex);
  summary.recovered = recovered.recovered || 0;

  const deliveries = await claimDueServiceReportDeliveries(now, limit, knex);
  summary.claimed = deliveries.length;
  for (const delivery of deliveries) {
    const result = await processServiceReportDelivery(delivery, knex);
    if (result.status === 'sent') summary.sent += 1;
    else if (result.status === 'skipped') summary.skipped += 1;
    else if (result.status === 'failed') summary.failed += 1;
    else if (result.status === 'queued') summary.requeued += 1;
  }

  return summary;
}

module.exports = {
  CLAIM_LIMIT,
  DEFAULT_MAX_ATTEMPTS,
  enqueueServiceReportV1EmailDelivery,
  nextServiceReportDeliveryAttemptAt,
  processDueServiceReportDeliveries,
  processServiceReportDelivery,
  recoverStaleServiceReportDeliveryClaims,
  claimDueServiceReportDeliveries,
  mergeServiceRecordDeliveryNotes,
};
