'use strict';

const crypto = require('crypto');
const { hasPendingPhotoSummary } = require('./photo-summary-recovery');

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
    if (Object.hasOwn(options || {}, 'serviceData')) {
      serviceData = options.serviceData;
    } else {
      const record = await knex('service_records')
        .where({ id: serviceRecordId })
        .first('service_data');
      serviceData = record ? record.service_data : null;
    }
    if (typeof serviceData === 'string') {
      try { serviceData = JSON.parse(serviceData); } catch { serviceData = null; }
    }
    const parked = hasPendingPhotoSummary(serviceData) ? '-ps' : '';
    if (!rows.length) return parked;
    const digest = crypto.createHash('sha1').update(rows.map((row) => String(row.id)).join(',')).digest('hex').slice(0, 8);
    return `-ph${rows.length}-${digest}${parked}`;
  } catch {
    return `-phu-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
}

module.exports = { reportPhotoSetPdfSignature };
