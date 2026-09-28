'use strict';

/**
 * The ONE place that resolves a service report's customer-visible LAWN turf
 * photo set (lawn_assessment_photos), shared by:
 *   - report-data.js buildReportV1Data — the report's own photo gallery
 *     (which the SMS-preview candidate, v1Data.previewPhoto, is picked from)
 *   - photo-set-signature.js reportPhotoSetPdfSignature — the cache-key
 *     component the SMS-preview writer/reader AND the PDF pipeline compare
 *     before serving/storing a cached artifact
 *
 * Pre-push P1 (third round, 2026-09-28): reportPhotoSetPdfSignature used to
 * hash ONLY service_photos rows. A lawn visit can carry ZERO service_photos
 * and still show a customer-visible turf photo (previewPhoto/the gallery
 * draw from lawn_assessment_photos too for serviceLine === 'lawn') — so the
 * signature could stay unmoved ('-pgon' bare) while the shown photo changed,
 * a turf photo was hidden/removed, or the linked assessment changed. Both
 * consumers now resolve the SAME rows through resolveLawnReportPhotos, so the
 * signature is by construction over exactly the photos the renderer can show.
 *
 * `customer_visible: true` is the same quality-gate/suppression check the
 * renderer applies (failed-quality photos are audit-only and never reach a
 * customer-facing report or its cache key); the order — photo_order, then
 * taken_at, then id as a final deterministic tiebreak — matches the
 * renderer's own gallery order.
 *
 * `options.failClosed` (pre-push P1, follow-up to the above): the RENDER
 * path (report-data.js) wants the old fail-SOFT behavior — an unreadable
 * photo set degrades to "no lawn photos" rather than 500ing a customer's
 * report. A SIGNATURE caller (photo-set-signature.js) must NOT do that: an
 * empty array on a genuine DB error is indistinguishable from "this
 * assessment truly has no customer-visible photos", so
 * reportPhotoSetPdfSignature would build a valid EMPTY-SET key on pure
 * uncertainty — it could then match an older photo-less asset, or persist
 * a render made during the same outage under that same (wrong) key,
 * bypassing the unique '-phu' failure token this file's caller relies on
 * elsewhere for exactly this "uncertain ⇒ never match" guarantee. Passing
 * `failClosed: true` rethrows instead of swallowing, so a signature caller
 * that does NOT catch it lets the failure reach ITS OWN try/catch and the
 * unique token — never a false empty-set match.
 */
async function resolveLawnReportPhotos(assessmentId, knex, { failClosed = false } = {}) {
  if (!assessmentId || !knex) return [];
  const query = knex('lawn_assessment_photos')
    .where({ assessment_id: assessmentId, customer_visible: true })
    .orderBy('photo_order', 'asc')
    .orderBy('taken_at', 'asc')
    .orderBy('id', 'asc');
  return failClosed ? query : query.catch(() => []);
}

module.exports = { resolveLawnReportPhotos };
