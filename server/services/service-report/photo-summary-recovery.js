/**
 * Photo-summary recovery for typed report snapshots.
 *
 * Closeout freezes the technician-approved photo narrative into
 * service_data.typedReportSnapshot.photoSummary before the best-effort photo
 * uploads run. When any upload fails the summary would describe photos the
 * report cannot show, so completion strips it — but a later recovery
 * (POST /api/tech/services/:id/photos then /photos/reconcile) re-attaches
 * every photo, and the rebuilt report must carry the narrative again
 * (Codex #4091 P1). The stripped copy therefore parks in the same durable
 * snapshot under photoSummaryPendingRecovery until reconciliation proves the
 * full photo set is present.
 */

const PENDING_KEY = 'photoSummaryPendingRecovery';

function snapshotOf(serviceData) {
  return serviceData && typeof serviceData === 'object' && serviceData.typedReportSnapshot
    && typeof serviceData.typedReportSnapshot === 'object' ? serviceData.typedReportSnapshot : null;
}

// Move the live summary aside. Idempotent: a snapshot with no live summary is
// left alone (a parked copy is never overwritten by null).
function stripPhotoSummaryForRecovery(serviceData) {
  const snapshot = snapshotOf(serviceData);
  if (!snapshot || !snapshot.photoSummary) return { changed: false, serviceData };
  snapshot[PENDING_KEY] = snapshot.photoSummary;
  snapshot.photoSummary = null;
  return { changed: true, serviceData };
}

function hasPendingPhotoSummary(serviceData) {
  const snapshot = snapshotOf(serviceData);
  return !!(snapshot && typeof snapshot[PENDING_KEY] === 'string' && snapshot[PENDING_KEY].trim());
}

// Put the parked summary back. Only meaningful once every closeout photo is
// attached — callers gate on completionPhotosFullyRecovered first.
function restorePhotoSummaryAfterRecovery(serviceData) {
  if (!hasPendingPhotoSummary(serviceData)) return { changed: false, serviceData };
  const snapshot = snapshotOf(serviceData);
  snapshot.photoSummary = snapshot[PENDING_KEY];
  delete snapshot[PENDING_KEY];
  return { changed: true, serviceData };
}

// structured_notes.completionPhotos records how many closeout photos were
// submitted (uploaded + failed). Recovery is complete when at least that many
// 'after' photo rows exist on the record; the attachment route dedupes by
// image hash, so a retried upload never double-counts.
function completionPhotosFullyRecovered(structuredNotes, afterPhotoCount) {
  const notes = structuredNotes && typeof structuredNotes === 'object' ? structuredNotes : null;
  const completion = notes && notes.completionPhotos && typeof notes.completionPhotos === 'object' ? notes.completionPhotos : null;
  if (!completion) return true;
  const submitted = Number(completion.uploaded || 0) + Number(completion.failed || 0);
  return Number(afterPhotoCount || 0) >= submitted;
}

module.exports = {
  PENDING_KEY,
  stripPhotoSummaryForRecovery,
  hasPendingPhotoSummary,
  restorePhotoSummaryAfterRecovery,
  completionPhotosFullyRecovered,
};
