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
      next_attempt_at: new Date(),
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

  try {
    const result = await sendServiceReportV1Email(delivery.service_record_id, {
      token: delivery.report_token,
      reportUrl: delivery.report_url,
      pdfUrl: delivery.pdf_url,
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
