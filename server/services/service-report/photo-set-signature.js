'use strict';

const crypto = require('crypto');
const { hasPendingPhotoSummary } = require('./photo-summary-recovery');
const { detectServiceLine } = require('./service-line-configs');
const { resolveLawnReportPhotos, resolveLawnPhotoAssessmentIds } = require('./report-photo-set');

/**
 * Report-photo-set key component for cached service-report PDFs.
 *
 * The photo rows a report renders can change AFTER closeout: the completion
 * panel's photo recovery attaches the uploads that failed at closeout, then
 * POST /photos/reconcile nulls pdf_storage_key and re-queues the render. A
 * public /pdf render that started BEFORE those rows landed is not tracked in
 * service_report_pdf_jobs, so reconcile cannot fence it — and it finishes by
 * storing its photo-less output under the deterministic key and writing that
 * key back, making the stale PDF current indefinitely (Codex #4091 P1).
 *
 * Two guards close that: (1) the SET of photo rows is part of the storage
 * key, so a PDF stored from the pre-recovery set never matches the expected
 * key once the rows exist; (2) every render path captures this value before
 * the render and re-reads it after, serving without storing on a mismatch —
 * the same posture as the callback-set fence (reservice-report.js).
 *
 * The parked photo summary is part of the same identity: recovery attaches
 * the rows FIRST and /photos/reconcile restores the summary AFTER, so a render
 * that starts between the two sees the full photo set but a summary-less
 * snapshot. Its photo-row signature would match before and after; the '-ps'
 * marker (present while photoSummaryPendingRecovery is parked, gone once
 * restored) moves the key and trips the fence across that window (pre-push
 * Codex P1 on e3e8302e3).
 *
 * Records with no photo rows and nothing parked return '' so their existing
 * keys are untouched; a failed lookup returns a unique token so uncertainty
 * re-renders (and trips the fence) instead of serving or storing a possibly
 * stale document.
 *
 * Lawn turf photos (pre-push P1, third round, 2026-09-28): a lawn visit's
 * report/preview can show a customer-visible lawn_assessment_photos row
 * (report-data.js appends these to the gallery for serviceLine === 'lawn',
 * and the before/after section shows one from the visit's BASELINE
 * assessment too) even with ZERO service_photos rows — so hashing
 * service_photos alone left this signature unmoved ('-pgon' bare) while a
 * turf photo was added, removed, hidden, or the linked/baseline assessment
 * changed. This resolves the SAME assessment identity and rows the renderer
 * draws from, through resolveLawnPhotoAssessmentIds + resolveLawnReportPhotos
 * (report-photo-set.js, backed by report-data.js's
 * resolveLawnAssessmentAndHistory) — the one path both sides consume, so the
 * signature is by construction over exactly the photos the renderer can show
 * (current assessment AND, when the before/after slider would pair one, the
 * baseline assessment).
 *
 * Versioned, unconditionally, for every lawn service line (pre-push P1,
 * second round: "version the empty lawn-photo signature"): a lawn record
 * always gets an `-lp<count>-<digest>` component, even when `count` is 0
 * (no linked assessment, or an assessment with zero customer-visible turf
 * photos). Without this, a lawn visit whose service_photos AND turf photos
 * were both empty produced the exact same bare/`-ps`-only signature a
 * PRE-THIS-CHANGE cached PDF was stored under — so hiding the visit's last
 * visible turf photo (count N → 0) would silently converge back onto that
 * legacy key and serve the stale document forever instead of tripping a
 * re-render. `-lp0-<hash of empty string>` is stable but distinct from the
 * legacy no-'-lp'-at-all key, so every pre-change lawn PDF — including the
 * zero-turf-photos state — is invalidated exactly once by this change.
 */
/**
 * `options.serviceData` — the service_data of the snapshot a render path
 * already loaded. The BEFORE capture must derive the parked marker from that
 * exact snapshot, not from a fresh read: the snapshot is loaded first, and a
 * reconcile that restores the summary between that load and a fresh read
 * would make before and after agree while the render used the summary-less
 * snapshot — caching the stale PDF under the current key (pre-push Codex P1
 * on 3d69b662c). The AFTER re-read passes nothing and sees live state, so a
 * restore after the snapshot load moves the marker and trips the fence.
 */
async function reportPhotoSetPdfSignature(serviceRecordId, knex = null, options = {}) {
  if (!knex || !serviceRecordId) return '';
  try {
    const rows = await knex('service_photos')
      .where({ service_record_id: serviceRecordId })
      .orderBy('id', 'asc')
      .select('id');
    let serviceData;
    let lawnFields;
    if (Object.hasOwn(options || {}, 'serviceData')) {
      serviceData = options.serviceData;
      // options.lawnFields — the caller's ALREADY-LOADED service_records row
      // (every current caller that passes serviceData loads the full row via
      // service_records.* or an explicit column list that already includes
      // these fields for its OWN lawn-assessment lookups, per pdf-queue.js's
      // and reports-public.js's own comments on why customer_id/service_id
      // ride along). Reusing it here is what keeps this branch's original
      // zero-extra-read contract for a caller that opts in; a caller that
      // does not pass it gets exactly one service_records read to learn the
      // service line, same as before the lawn-photo term existed.
      lawnFields = Object.hasOwn(options, 'lawnFields') && options.lawnFields
        ? options.lawnFields
        : await knex('service_records')
          .where({ id: serviceRecordId })
          .first('customer_id', 'service_line', 'service_type', 'scheduled_service_id', 'service_id');
    } else {
      const record = await knex('service_records')
        .where({ id: serviceRecordId })
        .first('service_data', 'customer_id', 'service_line', 'service_type', 'scheduled_service_id', 'service_id');
      serviceData = record ? record.service_data : null;
      lawnFields = record;
    }
    // A missing row must not read as "not lawn": that would drop the -lp
    // term and let a lawn PDF match its legacy key. Fail closed (the outer
    // catch returns the unique '-phu' token).
    if (!lawnFields) throw new Error('service record not found for photo signature');
    if (typeof serviceData === 'string') {
      try { serviceData = JSON.parse(serviceData); } catch { serviceData = null; }
    }
    const parked = hasPendingPhotoSummary(serviceData) ? '-ps' : '';

    // Lawn turf photos join the identity too — see the module doc above.
    // Both lookups below run failClosed: a genuine "no assessment linked" /
    // "no customer-visible photos" resolves normally (empty array) and
    // simply contributes a '-lp0-<empty digest>' term — that is NOT an
    // error, it's the versioned empty-set marker. Only a real QUERY FAILURE
    // throws here, and neither call is caught locally, so it propagates to
    // this function's own outer try/catch below and comes back as the
    // unique '-phu' failure token — never a valid (empty or non-empty)
    // lawn-photo signature an unreadable lawn photo set could otherwise be
    // mistaken for.
    // No pinnedAssessmentId here (Sonnet fallback-audit P1, 2026-09-28,
    // verified false positive): this mirrors lawnAssessmentPdfSignature
    // (report-data.js's resolveCanonicalLawnRender), which ALSO resolves the
    // unpinned/canonical assessment only, never a delivery pin — by design.
    // A genuine delivery pin (pdf-queue.js's pinnedLawnAssessmentId) forces
    // `mustRenderFresh` there, which skips the cached-key comparison AND the
    // store entirely ("a PINNED render must not clear the correction marker:
    // it stored nothing" — pdf-queue.js), so this unpinned resolution is
    // never compared against a pinned render's actual content. Whenever this
    // signature IS consulted for a cache decision, the render it describes
    // is the canonical (unpinned) one.
    let lawnPart = '';
    const serviceLine = lawnFields?.service_line || detectServiceLine(lawnFields?.service_type);
    if (serviceLine === 'lawn') {
      // options.propertyHistoryEnabled / options.lawnHistory (Sonnet
      // fallback-audit P1, 2026-09-28): resolveLawnAssessmentAndHistory
      // (report-data.js) re-derives its OWN propertyHistoryEnabled default
      // (a bare gateEnvValue read) when not given one, same as the render
      // path's default. Today that default is the only value either side
      // ever uses (the gate is a process-wide env flag, not request- or
      // customer-scoped), so this can never actually diverge from the
      // render's own resolution — but a caller that already resolved the
      // canonical render (pdf-queue.js's `canonical`, reports-public.js's
      // `canonical`) can pass its EXACT propertyHistoryEnabled/lawnHistory
      // through here instead of letting this call re-derive its own, so the
      // two paths are provably reading the same value rather than
      // coincidentally agreeing on a shared default.
      const assessmentIds = await resolveLawnPhotoAssessmentIds({
        id: serviceRecordId,
        customer_id: lawnFields?.customer_id,
        scheduled_service_id: lawnFields?.scheduled_service_id,
        service_id: lawnFields?.service_id,
      }, knex, {
        failClosed: true,
        propertyHistoryEnabled: options.propertyHistoryEnabled,
        lawnHistory: options.lawnHistory,
      });
      const turfPhotos = await resolveLawnReportPhotos(assessmentIds, knex, { failClosed: true });
      const turfDigest = crypto.createHash('sha1')
        .update(turfPhotos.map((p) => `${p.assessment_id}:${p.id}:${p.updated_at ? new Date(p.updated_at).toISOString() : ''}`).join(','))
        .digest('hex')
        .slice(0, 8);
      // Unconditional even at zero rows — see "Versioned, unconditionally"
      // above: this is what stops the zero-turf-photos state from
      // collapsing back onto the pre-this-change legacy bare key.
      lawnPart = `-lp${turfPhotos.length}-${turfDigest}`;
    }

    if (!rows.length && !lawnPart) return parked;
    const digest = crypto.createHash('sha1').update(rows.map((row) => String(row.id)).join(',')).digest('hex').slice(0, 8);
    return `-ph${rows.length}-${digest}${lawnPart}${parked}`;
  } catch {
    return `-phu-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
}

module.exports = { reportPhotoSetPdfSignature };
