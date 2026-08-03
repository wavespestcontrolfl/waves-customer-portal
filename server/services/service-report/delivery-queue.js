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
  const heldForGrounding = !!(heldPayload.awaiting_grounding && heldPayload.lawn_assessment_id);
  let lawnFenceCheck = null;
  let lawnSealRenewTimer = null;
  let releaseLawnSeal = null;

  let fencedAssessmentId = null;
  // The canonical answer as of BEFORE the render — including null, which is
  // itself a meaningful answer ("the report page renders no lawn section").
  // The post-render re-check compares against this, not against the fenced id,
  // so the held-payload fallback is covered too: null -> a newly confirmed row
  // is a change, and must defer.
  let canonicalAtResolve = null;
  // Only lawn reports carry an assessment, so only they are worth pinning.
  let isLawnDelivery = false;

  if (heldForGrounding) {
    const KnowledgeBridge = require('../knowledge-bridge');
    // Backlink recovery (codex P1 r40): a completion that crashed before
    // writing service_record_id leaves the assessment unlinked, and
    // sanitation rejects unlinked assessments forever. The held payload
    // records exactly which record this assessment belongs to — restore
    // the link (idempotent, only-if-null) before sanitizing.
    await knex('lawn_assessments')
      .where({ id: heldPayload.lawn_assessment_id })
      .whereNull('service_record_id')
      .update({ service_record_id: delivery.service_record_id })
      .catch((linkErr) => logger.warn(`[delivery-queue] assessment backlink recovery failed for ${heldPayload.lawn_assessment_id}: ${linkErr.message}`));
    const sanitized = await KnowledgeBridge.sanitizeStoredRecommendations(heldPayload.lawn_assessment_id);
    if (sanitized?.error) {
      const status = await markDeliveryFailed(delivery, new Error(`grounding readiness unverified: ${sanitized.error}`), knex);
      return { status, error: sanitized.error };
    }
  }

  // Fence target = the assessment the ATTACHMENT actually renders, resolved by
  // the SAME function the renderer uses (codex P1 #3135 r1). A hand-rolled
  // backlink query diverges: loadLinkedLawnAssessment filters to confirmed
  // rows, orders by confirmed_at then created_at, and falls back through the
  // scheduled service — and the record backlink is explicitly non-unique, so
  // duplicating the rules could seal a DIFFERENT row than the one rendered, or
  // miss a scheduled-service-only assessment entirely. Runs AFTER the held
  // path's backlink recovery so a just-relinked assessment is resolvable.
  //
  // failClosed (codex P1 #3135 r2): a transient DB error must NOT read as
  // "not a lawn record". Swallowing it would dispatch an unfenced attachment;
  // defer retryably instead — only a clean query returning no row bypasses.
  const { loadLinkedLawnAssessment, PIN_NO_ASSESSMENT } = require('./report-data');
  try {
    const serviceRow = await knex('service_records')
      .where({ id: delivery.service_record_id })
      .first('id', 'customer_id', 'scheduled_service_id', 'service_id', 'service_line', 'service_type');
    // Classify EXACTLY as the report builder does (report-data.js:
    // `service.service_line || detectServiceLine(service.service_type)`).
    // Trusting service_line alone missed legacy rows that carry a null line
    // but still render a lawn assessment — those would render unpinned, which
    // is the case the pin exists for.
    const { detectServiceLine } = require('./service-line-configs');
    isLawnDelivery = (serviceRow?.service_line || detectServiceLine(serviceRow?.service_type)) === 'lawn';
    const linked = serviceRow
      ? await loadLinkedLawnAssessment(serviceRow, knex, { failClosed: true })
      : null;
    fencedAssessmentId = linked?.id || null;
    canonicalAtResolve = fencedAssessmentId;
  } catch (resolveErr) {
    const status = await markDeliveryFailed(delivery, new Error(`lawn fence target unresolvable: ${resolveErr.message}`), knex);
    return { status, error: resolveErr.message };
  }
  // Never weaken the held path: if canonical resolution finds nothing (e.g. the
  // assessment isn't confirmed yet), fall back to the id the hold was created
  // for, which is the row that was grounded and sanitized above.
  if (!fencedAssessmentId && heldForGrounding) fencedAssessmentId = heldPayload.lawn_assessment_id;

  // The fence is installed for EVERY delivery, including ones whose canonical
  // selection is currently null (codex P1 #3143 r3). Gating installation on a
  // resolved assessment left the null -> id race wide open on ordinary
  // deliveries: with no assessment yet, no check ran at all, so one confirmed
  // while the remote PDF rendered became the page's selection and was mailed
  // unfenced. A record that genuinely has no lawn assessment resolves null both
  // times, costs one extra lookup, and sends exactly as before.
  {
    const KnowledgeBridge = require('../knowledge-bridge');
    // Capture the settled copy's version NOW and re-verify it after the
    // attachment renders, right before dispatch (codex P1 r36): a run that
    // starts after this one-time check must defer the send, not race it.
    const assessmentId = fencedAssessmentId;
    let versionAtCheck = null;
    if (assessmentId) {
      try {
        const row = await knex('lawn_assessments').where({ id: assessmentId }).first('recommendations', 'ai_summary', 'updated_at');
        versionAtCheck = row ? JSON.stringify([row.recommendations, row.ai_summary, row.updated_at]) : null;
      } catch (verErr) {
        const status = await markDeliveryFailed(delivery, new Error(`grounding version unreadable: ${verErr.message}`), knex);
        return { status, error: verErr.message };
      }
    }
    // ATOMIC SEAL (codex P1 r39): a plain re-read left an await boundary
    // between the check and sendTemplate where a generator could register.
    // sealForSend verifies no-active-run + version under the SAME advisory
    // lock generators register through and persists a short seal;
    // registration refuses while it is unexpired, so nothing can start
    // between this check and the dispatch.
    const versionOf = (row) => (row ? JSON.stringify([row.recommendations, row.ai_summary, row.updated_at]) : null);
    lawnFenceCheck = async ({ renderedAssessmentId = null } = {}) => {
      try {
        // The render is authoritative about which assessment the customer is
        // about to receive (codex P1 #3135 r3). If it used a DIFFERENT row than
        // the one whose version was pinned before the render, there is no proof
        // that row held still while it rendered — defer and let the retry fence
        // the now-current assessment. A null id means the render produced no
        // lawn assessment at all, so there is nothing to diverge from.
        if (assessmentId && renderedAssessmentId && String(renderedAssessmentId) !== String(assessmentId)) {
          logger.warn(`[delivery-queue] rendered assessment ${renderedAssessmentId} differs from fenced ${assessmentId} for record ${delivery.service_record_id} — deferring send`);
          return false;
        }
        // SELECTION re-check across the render window (issue #3143).
        //
        // The PDF's content provenance cannot be read server-side: the
        // renderer does not consume the payload built here — it points a
        // headless browser at /report/:token, and that page fetches
        // /api/reports/:token/data, which rebuilds the report independently
        // (server/services/service-report/pdf.js, server/routes/reports-public.js).
        // With Cloudflare Browser Rendering the render is a remote URL->PDF
        // call, so there is no hook to ask what the browser actually received.
        //
        // What IS knowable is whether the ANSWER changed. The version pin
        // above catches the fenced row's copy moving during the render; it
        // cannot catch a DIFFERENT row becoming the selection, which is the
        // race here — the backlink is non-unique and a newly confirmed or
        // relinked assessment can outrank the fenced one. Re-resolve through
        // the same canonical function the report page uses and require the
        // same answer. A change means the browser may well have rendered the
        // new row, so defer; the retry fences whatever is current then.
        //
        // Fail closed: an unreadable re-check is not a pass.
        //
        // Compared against the PRE-RENDER canonical answer, not the fenced id,
        // and it runs for EVERY fenced delivery including the held-payload
        // fallback. null is a real answer there — "the page renders no lawn
        // section" — so a row becoming confirmed mid-render flips null to an
        // id, which is exactly the drift that must defer. Exempting the
        // fallback would have left that race open.
        const serviceNow = await knex('service_records')
          .where({ id: delivery.service_record_id })
          .first('id', 'customer_id', 'scheduled_service_id', 'service_id');
        const linkedNow = serviceNow
          ? await loadLinkedLawnAssessment(serviceNow, knex, { failClosed: true })
          : null;
        if (String(linkedNow?.id || '') !== String(canonicalAtResolve || '')) {
          logger.warn(`[delivery-queue] lawn assessment selection changed across render for record ${delivery.service_record_id} (was ${canonicalAtResolve || 'none'}, now ${linkedNow?.id || 'none'}, fenced ${assessmentId || 'none'}) — deferring send`);
          return false;
        }
        // Selection-only mode: no assessment resolved, so there is nothing to
        // seal. The re-check above is the whole guarantee — it proved the
        // answer was null before the render and still null after, so the page
        // rendered no lawn section either way.
        if (!assessmentId) return true;
        const sealed = await KnowledgeBridge.sealRecommendationsForSend(assessmentId, versionAtCheck, versionOf);
        if (sealed) {
          // The base TTL equals SendGrid's own request timeout, so a slow
          // dispatch could outlive a fixed seal (codex P1 r40) — renew on a
          // heartbeat until the send settles; the worker releases it below.
          lawnSealRenewTimer = setInterval(() => {
            void KnowledgeBridge.renewRecommendationSendSeal(assessmentId)
              .catch((renewErr) => logger.warn(`[delivery-queue] send-seal renew failed for ${assessmentId}: ${renewErr.message}`));
          }, 45000);
          lawnSealRenewTimer.unref?.();
        }
        return sealed;
      } catch {
        return false; // unreadable fence state = defer, never send blind
      }
    };
    // Only a delivery that can SEAL needs a release; selection-only mode never
    // takes one.
    if (assessmentId) {
      releaseLawnSeal = async () => {
        if (lawnSealRenewTimer) { clearInterval(lawnSealRenewTimer); lawnSealRenewTimer = null; }
        await KnowledgeBridge.releaseRecommendationSendSeal(assessmentId)
          .catch((relErr) => logger.warn(`[delivery-queue] send-seal release failed for ${assessmentId} (expires by TTL): ${relErr.message}`));
      };
    }
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
      // Any FENCED delivery forces a fresh render, not just held ones (codex
      // P1 #3135 r3): a stored PDF carries no assessment or recommendation
      // version, so a cached object rendered from an older copy would sail
      // past the version check — the fence proves the stored copy didn't move
      // during THIS render, not that the cached object came from it. Cost is
      // one render per lawn delivery, which the held path already paid.
      forceFreshPdf: heldForGrounding || !!fencedAssessmentId,
      // Pin the render to the assessment this delivery fences (#3168). The
      // post-render selection re-check below catches the answer CHANGING
      // across the render; the pin closes the case it cannot see — the
      // selection moving away and back inside the window — by removing the
      // page's freedom to choose. A pin the report cannot legitimately show
      // fails the render, so the delivery defers rather than mailing an
      // attachment whose contents nothing verified.
      // 'none' when nothing resolved — an ABSENT pin is not the same as a pin
      // of absence (#3168 r1). Without the sentinel a null selection renders
      // unpinned, and a row that becomes eligible during the browser's fetch
      // and ineligible again before the post-render check passes both checks
      // and lands unsealed lawn copy in the attachment.
      // LAWN deliveries only. Pinning a pest report would be meaningless (it
      // has no lawn section to pin) while making every pest render fresh and
      // unstored, since a pinned render deliberately bypasses the cache.
      // Pin the CANONICAL selection, not the fence target. The held-payload
      // fallback deliberately seals an id that canonical resolution rejected —
      // typically an assessment not yet confirmed — and a pin of that id would
      // be refused by design on every attempt, deterministically 409ing the
      // render until the delivery exhausts its retries. Pinning absence is
      // correct there: the page renders no lawn section (canonical found
      // none), while the seal still guards the held assessment's copy.
      pinnedLawnAssessmentId: isLawnDelivery ? (canonicalAtResolve || PIN_NO_ASSESSMENT) : null,
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
  } finally {
    if (releaseLawnSeal) await releaseLawnSeal();
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
