'use strict';

const crypto = require('crypto');

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
 * Records with no photo rows return '' so their existing keys are untouched;
 * a failed lookup returns a unique token so uncertainty re-renders (and trips
 * the fence) instead of serving or storing a possibly stale document.
 */
async function reportPhotoSetPdfSignature(serviceRecordId, knex = null) {
  if (!knex || !serviceRecordId) return '';
  try {
    const rows = await knex('service_photos')
      .where({ service_record_id: serviceRecordId })
      .orderBy('id', 'asc')
      .select('id');
    if (!rows.length) return '';
    const digest = crypto.createHash('sha1').update(rows.map((row) => String(row.id)).join(',')).digest('hex').slice(0, 8);
    return `-ph${rows.length}-${digest}`;
  } catch {
    return `-phu-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
}

module.exports = { reportPhotoSetPdfSignature };
