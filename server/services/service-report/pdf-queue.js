const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { buildServiceReportDynamicContext } = require('./dynamic-context');
const { buildReportV1Data } = require('./report-data');
const { renderServiceReportV1Pdf } = require('./pdf');
const {
  getHealthyStoredReportPdf,
  putReportPdf,
  reportPdfStorageKey,
} = require('./pdf-storage');
const { loadActiveConfig, pestPressureVisibilitySignature } = require('../pest-pressure/store');
const { alertServiceReportPdfFailed } = require('./failure-alerts');
const {
  emitPdfRenderTerminalFailure,
  safePdfRenderError,
} = require('./pdf-events');

const CLAIM_LIMIT = 5;
const STALE_CLAIM_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MINUTES = [5, 30, 240];

function isMissingQueueError(err) {
  return err?.code === '42P01' || err?.code === '42703';
}

function nextPdfRenderAttemptAt(now = new Date(), attempts = 0) {
  const index = Math.min(Math.max(Number(attempts || 0), 0), RETRY_DELAYS_MINUTES.length - 1);
  return new Date(now.getTime() + RETRY_DELAYS_MINUTES[index] * 60 * 1000);
}

async function ensureReportToken(serviceRecordId, knex = db) {
  const service = await knex('service_records').where({ id: serviceRecordId }).first('id', 'report_view_token');
  if (!service) return null;
  if (service.report_view_token) return service.report_view_token;

  const token = crypto.randomBytes(16).toString('hex');
  await knex('service_records').where({ id: serviceRecordId }).update({
    report_view_token: token,
    report_generated_at: knex.fn.now(),
  });
  return token;
}

async function loadServiceRecordForPdf(recordId, knex = db) {
  return knex('service_records')
    .where({ 'service_records.id': recordId })
    .leftJoin('customers', 'service_records.customer_id', 'customers.id')
    .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
    .select(
      'service_records.*',
      'customers.first_name',
      'customers.last_name',
      'customers.address_line1',
      'customers.address_line2',
      'customers.city',
      'customers.state',
      'customers.zip',
      'customers.has_left_google_review',
      'customers.latitude as customer_latitude',
      'customers.longitude as customer_longitude',
      'technicians.name as technician_name',
      'technicians.photo_url as technician_photo_url',
      'technicians.avatar_url as technician_avatar_url',
      'technicians.photo_s3_key as technician_photo_s3_key',
    )
    .first();
}

async function renderAndStoreServiceReportPdf(recordId, {
  token,
  req,
  knex = db,
  allowUnstoredPdf = false,
  pestPressureConfig: providedPestPressureConfig,
} = {}) {
  const service = await loadServiceRecordForPdf(recordId, knex);
  if (!service) throw new Error('Service record not found');
  if (service.status !== 'completed' && service.status !== 'complete') {
    throw new Error(`Service record is not complete: ${service.status}`);
  }
  if (service.report_template_version !== 'service_report_v1') {
    throw new Error('Service record is not a v1 report');
  }

  const reportToken = token || await ensureReportToken(recordId, knex);
  if (!reportToken) throw new Error('Missing report token');

  let pestPressureConfig = providedPestPressureConfig === undefined
    ? await loadActiveConfig(knex).catch(() => null)
    : providedPestPressureConfig;
  let visibilitySignature = pestPressureVisibilitySignature(pestPressureConfig);
  let pdf;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const renderSignature = visibilitySignature;
    const data = await buildReportV1Data(service, reportToken, knex, { pestPressureConfig });
    data.dynamicContext = await buildServiceReportDynamicContext({
      recordId,
      mode: 'static',
      pestPressureConfig,
      knex,
    });
    pdf = await renderServiceReportV1Pdf(data, {
      token: reportToken,
      req,
      logger,
      serviceRecordId: recordId,
    });

    const latestPestPressureConfig = await loadActiveConfig(knex).catch(() => null);
    const latestVisibilitySignature = pestPressureVisibilitySignature(latestPestPressureConfig);
    if (latestVisibilitySignature === renderSignature) break;

    if (attempt === 1) {
      const err = new Error('Pest Pressure config changed during PDF render');
      err.code = 'pest_pressure_config_changed_during_pdf_render';
      throw err;
    }
    pestPressureConfig = latestPestPressureConfig;
    visibilitySignature = latestVisibilitySignature;
  }
  try {
    const key = await putReportPdf(recordId, pdf, { visibilitySignature });
    await knex('service_records').where({ id: recordId }).update({ pdf_storage_key: key });
    return { key, pdf, token: reportToken };
  } catch (err) {
    if (!allowUnstoredPdf) throw err;
    const storageError = safePdfRenderError(err);
    logger.warn(`[service-report-pdf] storage failed for ${recordId}; returning rendered PDF without stored copy: ${storageError}`);
    return {
      key: null,
      pdf,
      rendered: true,
      storageFailed: true,
      storageError,
      token: reportToken,
    };
  }
}

async function getOrRenderServiceReportPdf(recordId, { token, req, knex = db } = {}) {
  const service = await knex('service_records').where({ id: recordId }).first('id', 'pdf_storage_key');
  const pestPressureConfig = await loadActiveConfig(knex).catch(() => null);
  const visibilitySignature = pestPressureVisibilitySignature(pestPressureConfig);
  const expectedPdfStorageKey = service?.id ? reportPdfStorageKey(service.id, { visibilitySignature }) : null;
  const stored = service?.pdf_storage_key === expectedPdfStorageKey
    ? await getHealthyStoredReportPdf(service.pdf_storage_key)
    : null;
  if (stored) return { pdf: stored, key: service.pdf_storage_key, rendered: false };

  const rendered = await renderAndStoreServiceReportPdf(recordId, {
    token,
    req,
    knex,
    allowUnstoredPdf: true,
    pestPressureConfig,
  });
  return {
    pdf: rendered.pdf,
    key: rendered.key,
    rendered: true,
    storageFailed: !!rendered.storageFailed,
    storageError: rendered.storageError || null,
    token: rendered.token,
  };
}

async function enqueuePdfRenderJob({
  serviceRecordId,
  delayMs = 0,
  payload = {},
} = {}, knex = db) {
  if (!serviceRecordId) throw new Error('serviceRecordId is required');
  const nextAttemptAt = new Date(Date.now() + Math.max(0, Number(delayMs || 0)));
  try {
    const existing = await knex('service_report_pdf_jobs')
      .where({ service_record_id: serviceRecordId })
      .whereIn('status', ['queued', 'rendering'])
      .first();
    if (existing) return { ok: true, queued: false, job: existing };

    const row = {
      service_record_id: serviceRecordId,
      status: 'queued',
      attempts: 0,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
      next_attempt_at: nextAttemptAt,
      payload,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const [inserted] = await knex('service_report_pdf_jobs').insert(row).returning('*');
    return { ok: true, queued: true, job: inserted || row };
  } catch (err) {
    if (err?.code === '23505') {
      const existing = await knex('service_report_pdf_jobs')
        .where({ service_record_id: serviceRecordId })
        .orderBy('created_at', 'desc')
        .first();
      if (existing) return { ok: true, queued: false, job: existing };
    }
    if (isMissingQueueError(err)) {
      logger.warn(`[service-report-pdf-queue] queue table unavailable; PDF render not queued for ${serviceRecordId}`);
      return { ok: false, skipped: true, error: 'service_report_pdf_jobs table unavailable' };
    }
    throw err;
  }
}

async function enqueuePdfRenderRetry({ serviceRecordId, payload } = {}, knex = db) {
  return enqueuePdfRenderJob({
    serviceRecordId,
    delayMs: RETRY_DELAYS_MINUTES[0] * 60 * 1000,
    payload,
  }, knex);
}

async function recoverStalePdfRenderClaims(now = new Date(), knex = db) {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  try {
    const result = await knex.raw(`
      UPDATE service_report_pdf_jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
          next_attempt_at = CASE WHEN attempts >= max_attempts THEN next_attempt_at ELSE ? END,
          failed_at = CASE WHEN attempts >= max_attempts THEN ? ELSE failed_at END,
          locked_at = NULL,
          last_error = COALESCE(last_error, 'Recovered stale PDF render claim'),
          updated_at = ?
      WHERE status = 'rendering'
        AND locked_at <= ?
      RETURNING status
    `, [now, now, now, staleBefore]);
    const rows = result.rows || [];
    return {
      recovered: rows.length,
      retried: rows.filter((row) => row.status === 'queued').length,
      failed: rows.filter((row) => row.status === 'failed').length,
    };
  } catch (err) {
    if (isMissingQueueError(err)) return { recovered: 0, retried: 0, failed: 0, skipped: true };
    throw err;
  }
}

async function claimDuePdfRenderJobs(now = new Date(), limit = CLAIM_LIMIT, knex = db) {
  try {
    const result = await knex.raw(`
      WITH due AS (
        SELECT id
        FROM service_report_pdf_jobs
        WHERE status = 'queued'
          AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ?
      )
      UPDATE service_report_pdf_jobs AS j
      SET status = 'rendering',
          attempts = attempts + 1,
          last_attempt_at = ?,
          locked_at = ?,
          updated_at = ?
      FROM due
      WHERE j.id = due.id
      RETURNING j.*
    `, [now, limit, now, now, now]);
    return result.rows || [];
  } catch (err) {
    if (isMissingQueueError(err)) return [];
    throw err;
  }
}

async function markPdfRenderJobSucceeded(job, key, knex = db) {
  await knex('service_report_pdf_jobs').where({ id: job.id }).update({
    status: 'succeeded',
    succeeded_at: new Date(),
    locked_at: null,
    pdf_storage_key: key,
    last_error: null,
    updated_at: new Date(),
  });
}

async function markPdfRenderJobFailed(job, err, knex = db) {
  const now = new Date();
  const attempts = Number(job.attempts || 0);
  const maxAttempts = Number(job.max_attempts || DEFAULT_MAX_ATTEMPTS);
  const exhausted = attempts >= maxAttempts;
  const errorMessage = safePdfRenderError(err);
  const nextAttemptAt = exhausted ? job.next_attempt_at : nextPdfRenderAttemptAt(now, attempts - 1);
  await knex('service_report_pdf_jobs').where({ id: job.id }).update({
    status: exhausted ? 'failed' : 'queued',
    next_attempt_at: nextAttemptAt,
    failed_at: exhausted ? now : null,
    locked_at: null,
    last_error: errorMessage,
    updated_at: now,
  });

  if (exhausted) {
    emitPdfRenderTerminalFailure({
      service_record_id: job.service_record_id,
      err: errorMessage.slice(0, 500),
    });
    logger.error(`[service-report-pdf-queue] PDF render failed permanently for ${job.service_record_id} after ${attempts} attempts: ${errorMessage}`);
    // Surface it on the admin bell (best-effort; never breaks the queue).
    await alertServiceReportPdfFailed({ job, error: errorMessage }, { knex });
  } else if (attempts === 1) {
    logger.warn(`[service-report-pdf-queue] PDF render failed for ${job.service_record_id}; retry queued for ${nextAttemptAt.toISOString()}: ${errorMessage}`);
  }
  return exhausted ? 'failed' : 'queued';
}

async function processPdfRenderJob(job, knex = db) {
  try {
    const result = await renderAndStoreServiceReportPdf(job.service_record_id, { knex });
    await markPdfRenderJobSucceeded(job, result.key, knex);
    return { status: 'succeeded', key: result.key };
  } catch (err) {
    const status = await markPdfRenderJobFailed(job, err, knex);
    return { status, error: err.message };
  }
}

async function processDuePdfRenderJobs({ now = new Date(), limit = CLAIM_LIMIT } = {}, knex = db) {
  const summary = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    requeued: 0,
    recovered: 0,
  };
  const recovered = await recoverStalePdfRenderClaims(now, knex);
  summary.recovered = recovered.recovered || 0;

  const jobs = await claimDuePdfRenderJobs(now, limit, knex);
  summary.claimed = jobs.length;
  for (const job of jobs) {
    const result = await processPdfRenderJob(job, knex);
    if (result.status === 'succeeded') summary.succeeded += 1;
    else if (result.status === 'failed') summary.failed += 1;
    else if (result.status === 'queued') summary.requeued += 1;
  }
  return summary;
}

module.exports = {
  CLAIM_LIMIT,
  DEFAULT_MAX_ATTEMPTS,
  RETRY_DELAYS_MINUTES,
  claimDuePdfRenderJobs,
  enqueuePdfRenderJob,
  enqueuePdfRenderRetry,
  ensureReportToken,
  getOrRenderServiceReportPdf,
  loadServiceRecordForPdf,
  nextPdfRenderAttemptAt,
  processDuePdfRenderJobs,
  processPdfRenderJob,
  recoverStalePdfRenderClaims,
  renderAndStoreServiceReportPdf,
};
