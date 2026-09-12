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

// structured_notes.completionPhotos records what closeout submitted. Uploads
// dedupe by image hash (the same image selected twice is one row), so the
// authoritative check is the set of DISTINCT expected image hashes recorded
// at closeout (expectedImageHashes): recovery is complete when every one has
// an 'after' row on the record. Older records without that list fall back to
// the count rule (uploaded + failed <= after-photo rows).
function completionPhotosFullyRecovered(structuredNotes, { afterPhotoCount = 0, presentImageHashes = [] } = {}) {
  const notes = structuredNotes && typeof structuredNotes === 'object' ? structuredNotes : null;
  const completion = notes && notes.completionPhotos && typeof notes.completionPhotos === 'object' ? notes.completionPhotos : null;
  if (!completion) return true;
  const expected = Array.isArray(completion.expectedImageHashes)
    ? completion.expectedImageHashes.filter((h) => typeof h === 'string' && h) : null;
  if (expected && expected.length) {
    const present = new Set((presentImageHashes || []).filter(Boolean));
    return expected.every((hash) => present.has(hash));
  }
  const submitted = Number(completion.uploaded || 0) + Number(completion.failed || 0);
  return Number(afterPhotoCount || 0) >= submitted;
}

// Distinct image hashes of the photos closeout submitted — computed from the
// submitted bytes so a photo whose upload failed is still expected.
function expectedImageHashesFor(photos = [], { decode, hash }) {
  const out = new Set();
  for (const photo of Array.isArray(photos) ? photos : []) {
    if (!photo || !photo.data) continue;
    try {
      const decoded = decode(photo.data);
      if (decoded && decoded.buffer) out.add(hash(decoded.buffer));
    } catch { /* undecodable submissions never uploaded either; nothing to expect */ }
  }
  return [...out];
}

module.exports = {
  PENDING_KEY,
  stripPhotoSummaryForRecovery,
  hasPendingPhotoSummary,
  restorePhotoSummaryAfterRecovery,
  completionPhotosFullyRecovered,
  expectedImageHashesFor,
};
