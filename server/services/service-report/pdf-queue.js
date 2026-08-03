const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { buildServiceReportDynamicContext } = require('./dynamic-context');
const { buildReportV1Data, stripLiveOnlyScheduleFields, lawnAssessmentPdfSignature } = require('./report-data');
const { renderServiceReportV1Pdf } = require('./pdf');
const {
  getHealthyStoredReportPdf,
  putReportPdf,
  reportPdfStorageKey,
  timeOnSiteAdjustedPdfSignature,
} = require('./pdf-storage');
const { loadActiveConfig, pestPressureVisibilitySignature } = require('../pest-pressure/store');
const { summaryCopySignature } = require('./technician-report-copy');
const { mosquitoReportV2PdfSignature } = require('./mosquito-report-v2');
const { pestReportV2PdfSignature } = require('./pest-report-v2');
const { treatmentZonePdfSignature } = require('../treatment-zone-maps');
const { treatmentNarrativePdfSignature } = require('./treatment-narrative');
const { stampedDivergesSql, stampedLine2Sql } = require('../stamped-address');
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
    .leftJoin('scheduled_services as ss', 'service_records.scheduled_service_id', 'ss.id')
    .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
    .select(
      'service_records.*',
      'customers.first_name',
      'customers.last_name',
      // PDF address/map follow the visit's stamped service address when
      // present — a phone-booked rental report must not render the primary
      // home (codex round-9 P2). Coords: stamped visit coords first, the
      // primary home only for non-divergent stamps.
      knex.raw('COALESCE(ss.service_address_line1, customers.address_line1) as address_line1'),
      knex.raw(`${stampedLine2Sql('ss', 'customers')} as address_line2`),
      knex.raw('COALESCE(ss.service_address_city, customers.city) as city'),
      knex.raw('COALESCE(ss.service_address_state, customers.state) as state'),
      knex.raw('COALESCE(ss.service_address_zip, customers.zip) as zip'),
      'customers.has_left_google_review',
      knex.raw(`COALESCE(ss.lat, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.latitude END) as customer_latitude`),
      knex.raw(`COALESCE(ss.lng, CASE WHEN NOT ${stampedDivergesSql('ss', 'customers')} THEN customers.longitude END) as customer_longitude`),
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
  // #3168: pin which lawn assessment this render shows, so a send fence can
  // prove the attachment carries the copy it sealed. Rides to the page on the
  // URL; also pinned on this function's own data build so the storage-key
  // signature describes the same render.
  pinnedLawnAssessmentId = null,
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
  // Summary-copy key component (see reports-public direct PDF route): a
  // technician-report-driven summary changes the storage key so stale
  // generic-summary PDFs re-render. Immutable per record — no race re-check.
  const summarySignature = summaryCopySignature(service);
  // Mosquito V2 key component (see reports-public direct PDF route): a gate
  // flip must re-render cached mosquito-report PDFs. Env + service line only —
  // immutable per render, no race re-check.
  const mosquitoV2Signature = mosquitoReportV2PdfSignature(service);
  // Same for PEST_REPORT_V2 — the pest gate predates this key component, so
  // pest PDFs cached pre-dashboard re-render once on next view.
  const pestV2Signature = pestReportV2PdfSignature(service);
  // Treatment-zone key component: the traced satellite map bakes into the
  // PDF, so a gate flip or re-trace must change the key (re-trace also
  // nulls pdf_storage_key at save — this covers the gate-flip direction).
  const tzSignature = await treatmentZonePdfSignature(service, knex);
  // Assessment identity + copy version in the key, so a stale in-flight render
  // cannot republish over a newer one (#3168).
  const laSignature = await lawnAssessmentPdfSignature(service, knex);
  let pdf;
  // The signature of the narrative text actually rendered travels ON the
  // payload (attached by report-data at the moment the text was chosen) —
  // never re-read from the DB, so a background generation landing mid-render
  // can't key a fallback PDF as final (codex P2 r15). '-tn0' matches the
  // lookup sentinel for reports that render no narrative.
  let tnRenderedSignature = '-tn0';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const renderSignature = visibilitySignature;
    const data = await buildReportV1Data(service, reportToken, knex, { pestPressureConfig, pinnedLawnAssessmentId });
    tnRenderedSignature = data?.treatmentNarrativeRenderedSignature || '-tn0';
    // Queued PDFs are cached snapshots — live-only schedule fields
    // (nextAppointment, reportV2.snapshot.nextVisit) must never fossilize
    // into them (codex P2 r2: this path bypasses the route helper's strip).
    stripLiveOnlyScheduleFields(data);
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
      pinnedLawnAssessmentId,
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
  // A PINNED render never joins the shared cache (#3168). The storage key is
  // assessment-agnostic, so persisting one would let a later UNPINNED download
  // serve a PDF built for a specific assessment — and the pinned path exists
  // precisely for the case where the pin and the current selection disagree.
  //
  // Deliberately OUTSIDE the storage try/catch below: that catch exists to let
  // an ordinary render degrade to an unstored PDF, and swallowing this failure
  // there would mark the delivery sent while Download PDF kept serving the
  // known-stale object. A failed clear must fail the render so the delivery
  // defers and retries.
  if (pinnedLawnAssessmentId) {
    // The delivery forced a fresh render precisely because the cached object
    // may hold an older assessment or recommendation version, so leaving that
    // key in place would hand the recipient a document different from the
    // attachment they were just emailed. The next unpinned request re-renders
    // canonically; nothing reads a null key as an error.
    await knex('service_records')
      .where({ id: recordId })
      .update({ pdf_storage_key: null });
    return { key: null, pdf, rendered: true, token: reportToken, pinned: true };
  }
  try {
    // An UNPINNED cache render opens the report page without a pin, so the
    // page's own fetch chooses the assessment — and a selection that moved
    // away and back during the render would otherwise store that PDF under
    // the pre-render signature, where it reads as current forever. Re-read and
    // require stability before publishing; if it moved, skip the store and let
    // the next view render cleanly. (Pinned renders never reach here.)
    const laAfter = await lawnAssessmentPdfSignature(service, knex);
    if (laAfter !== laSignature) {
      logger.warn(`[service-report-pdf] lawn assessment changed during render for ${recordId} — not caching this render`);
      return { key: null, pdf, rendered: true, token: reportToken, uncached: true };
    }
    const key = await putReportPdf(recordId, pdf, {
      visibilitySignature: visibilitySignature + summarySignature + mosquitoV2Signature + pestV2Signature + tzSignature + tnRenderedSignature + timeOnSiteAdjustedPdfSignature(service) + laSignature,
    });
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

// Durable lawn-PDF correction marker helpers (codex P1 #3093 r30).
// Version of the stored lawn recommendations — changes on every write
// (generation, sanitize), so an unchanged value across a render proves the
// render did not straddle a copy change.
// Both helpers THROW on a query error so callers can distinguish "no lawn
// assessment exists" (safe to clear the marker) from "we could not read"
// (must retain it) — swallowing the error made two nulls compare equal and
// cleared the marker after a raced render (codex P1 #3093 r33).
async function lawnRecommendationVersion(assessmentId, knex = db) {
  const row = await knex('lawn_assessments').where({ id: assessmentId }).first('recommendations', 'ai_summary', 'updated_at');
  if (!row) return null;
  return crypto.createHash('sha1')
    .update(`${typeof row.recommendations === 'string' ? row.recommendations : JSON.stringify(row.recommendations || '')}|${row.ai_summary || ''}|${row.updated_at ? new Date(row.updated_at).toISOString() : ''}`)
    .digest('hex');
}

async function lawnAssessmentIdForRecord(recordId, knex = db) {
  // Deterministic newest-row selection matching loadLinkedLawnAssessment
  // (codex P1 r36): the back-link index is non-unique, and an unordered
  // .first() could fence against an OLDER assessment while the actual one
  // was still being grounded — clearing the marker on the wrong evidence.
  const row = await knex('lawn_assessments')
    .where({ service_record_id: recordId })
    .orderBy('confirmed_at', 'desc')
    .orderBy('created_at', 'desc')
    .first('id');
  if (row?.id) return row.id;
  // Legacy assessments are linked only through the scheduled service —
  // the report builder still renders them via loadLinkedLawnAssessment's
  // by-service fallback, so the fence must resolve through the SAME path
  // or it compares two nulls and clears the marker for a row that can
  // still change (codex P1 r38). Unlike the report builder, errors THROW
  // here (r33 semantics): unreadable fence state retains the marker.
  const record = await knex('service_records').where({ id: recordId }).first('id', 'customer_id', 'scheduled_service_id');
  const scheduledServiceId = record?.scheduled_service_id;
  if (!record?.customer_id || !scheduledServiceId) return null;
  const byService = await knex('lawn_assessments')
    .where({ customer_id: record.customer_id, confirmed_by_tech: true, service_id: scheduledServiceId })
    .orderBy('confirmed_at', 'desc')
    .orderBy('created_at', 'desc')
    .first('id');
  return byService?.id || null;
}

// ATOMIC key removal (codex P2 #3093 r31): a read-modify-write of the whole
// structured_notes column can clobber completionSmsStatus / sentSmsBody
// written concurrently, which would defeat the resend guard.
async function clearLawnPdfCorrectionMarker(recordId, knex = db) {
  await knex('service_records')
    .where({ id: recordId })
    .update({
      structured_notes: knex.raw("(COALESCE(structured_notes::jsonb, '{}'::jsonb) - ?)", ['lawnPdfCorrectionPending']),
    });
}

// forceFresh: skip the stored-object lookup and render anew — held email
// deliveries must attach a render produced AFTER final copy settled, and no
// fence can cover every render path (the public report route renders
// synchronously without a job row — codex P1 #3093 r23).
async function getOrRenderServiceReportPdf(recordId, {
  token, req, knex = db, forceFresh = false, pinnedLawnAssessmentId = null,
} = {}) {
  // technician_notes + service_data ride along for the summary-copy key
  // component, service_type/service_line for the mosquito-V2 component —
  // the expected key must match what renderAndStore writes.
  const service = await knex('service_records')
    .where({ id: recordId })
    .first('id', 'pdf_storage_key', 'technician_notes', 'service_data', 'service_type', 'service_line', 'scheduled_service_id', 'structured_notes');
  // DURABLE correction marker (codex P1 #3093 r30): completion sets
  // structured_notes.lawnPdfCorrectionPending when lawn copy may still
  // change after the first render. Any render path — including the public
  // report route on a box that never ran the completion callback — then
  // renders FRESH until a post-settlement render clears it. Covers the
  // no-email / process-restart path the in-process callback cannot.
  let correctionPending = false;
  try {
    const notes = typeof service?.structured_notes === 'string'
      ? JSON.parse(service.structured_notes) : (service?.structured_notes || {});
    correctionPending = notes && notes.lawnPdfCorrectionPending === true;
  } catch { correctionPending = false; }
  // A pinned render can never be served from storage: a cached object records
  // nothing about which assessment it was built from, so returning one would
  // silently answer a pinned request with unpinned content (#3168).
  const mustRenderFresh = forceFresh || correctionPending || !!pinnedLawnAssessmentId;
  // Version captured BEFORE the render: the marker may only be cleared when
  // the recommendation copy did not change during the render AND no
  // generation is in flight afterwards — otherwise this render may have
  // loaded pre-grounding copy (codex P1 r31).
  let lawnAssessmentId = null;
  let recVersionBefore = null;
  let fenceReadOk = true;
  if (correctionPending) {
    try {
      lawnAssessmentId = await lawnAssessmentIdForRecord(recordId, knex);
      recVersionBefore = lawnAssessmentId ? await lawnRecommendationVersion(lawnAssessmentId, knex) : null;
    } catch (fenceErr) {
      fenceReadOk = false;
      logger.warn(`[pdf-queue] correction-fence pre-read failed for ${recordId} — marker retained: ${fenceErr.message}`);
    }
  }
  const pestPressureConfig = await loadActiveConfig(knex).catch(() => null);
  const visibilitySignature = pestPressureVisibilitySignature(pestPressureConfig);
  const expectedPdfStorageKey = service?.id
    ? reportPdfStorageKey(service.id, {
      visibilitySignature: visibilitySignature + summaryCopySignature(service) + mosquitoReportV2PdfSignature(service) + pestReportV2PdfSignature(service) + await treatmentZonePdfSignature(service, knex) + await treatmentNarrativePdfSignature(service.id, knex) + timeOnSiteAdjustedPdfSignature(service) + await lawnAssessmentPdfSignature(service, knex),
    })
    : null;
  const stored = (!mustRenderFresh && service?.pdf_storage_key === expectedPdfStorageKey)
    ? await getHealthyStoredReportPdf(service.pdf_storage_key)
    : null;
  if (stored) return { pdf: stored, key: service.pdf_storage_key, rendered: false };

  const rendered = await renderAndStoreServiceReportPdf(recordId, {
    token,
    req,
    knex,
    allowUnstoredPdf: true,
    pestPressureConfig,
    pinnedLawnAssessmentId,
  });
  // A completed fresh render satisfies the pending correction — but only
  // once the copy can no longer change (no generation in flight).
  // A PINNED render must not clear the correction marker: it stored nothing, so
  // the canonical cached PDF is still whatever it was. Clearing here would
  // retire the marker while a stale object remains the one customers download.
  if (correctionPending && !rendered.storageFailed && !rendered.pinned && fenceReadOk) {
    try {
      if (!lawnAssessmentId) {
        // No linked assessment (stray marker on a non-lawn record) —
        // nothing can generate, clear directly.
        await clearLawnPdfCorrectionMarker(recordId, knex);
      } else {
        // The entire check-and-clear runs under the SAME advisory lock
        // generation registration takes (codex P1 r40): a run registering
        // between the reads and the marker deletion was a TOCTOU that left
        // a permanently stale PDF. Inside the lock nothing can register,
        // so the observed state holds through the clear.
        await knex.transaction(async (trx) => {
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`lawn_rec_${lawnAssessmentId}`]);
          const freshRow = await trx('lawn_assessments').where({ id: lawnAssessmentId }).first('recommendations', 'ai_summary', 'updated_at');
          const recVersionAfter = freshRow ? crypto.createHash('sha1')
            .update(`${typeof freshRow.recommendations === 'string' ? freshRow.recommendations : JSON.stringify(freshRow.recommendations || '')}|${freshRow.ai_summary || ''}|${freshRow.updated_at ? new Date(freshRow.updated_at).toISOString() : ''}`)
            .digest('hex') : null;
          const copyStableAcrossRender = recVersionBefore === recVersionAfter;
          let payload = freshRow?.recommendations;
          if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
          const isObj = payload && typeof payload === 'object' && !Array.isArray(payload);
          // Live lease check from the row we hold under the lock — a
          // separate query would read outside the fence.
          const runs = (isObj && payload._generationRuns && typeof payload._generationRuns === 'object') ? payload._generationRuns : {};
          const stillGenerating = Object.values(runs).some((exp) => {
            const t = Date.parse(exp);
            return Number.isFinite(t) && t > Date.now();
          });
          // The copy must also be SETTLED — grounded or sanitation-final
          // (codex P1 r39): between grounded-generation failure and a
          // sanitize retry there is no live lease, so "stable and not
          // generating" can hold while the copy still awaits correction.
          const copySettled = !!(isObj && (payload._groundedInApplications || payload._sanitizationFinal));
          if (!stillGenerating && copyStableAcrossRender && copySettled) {
            await trx('service_records').where({ id: recordId }).update({
              structured_notes: trx.raw("(COALESCE(structured_notes::jsonb, '{}'::jsonb) - ?)", ['lawnPdfCorrectionPending']),
            });
          }
        });
      }
    } catch (clearErr) {
      logger.warn(`[pdf-queue] correction-marker clear skipped for ${recordId} — retained: ${clearErr.message}`);
    }
  }
  return {
    pdf: rendered.pdf,
    key: rendered.key,
    rendered: true,
    storageFailed: !!rendered.storageFailed,
    storageError: rendered.storageError || null,
    token: rendered.token,
    // Pinned renders are deliberately unstored (#3168) — surfaced so a caller
    // can tell "no key because storage failed" from "no key by design".
    pinned: !!rendered.pinned,
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
