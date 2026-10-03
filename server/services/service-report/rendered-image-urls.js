'use strict';

/**
 * Every remote image URL the service report document prints, from the payload:
 * the server-side mirror of ServiceReportDocument's gallery assembly
 * (client/src/pages/ServiceReportDocument.jsx: its galleryPhotos +
 * photoSet / v2AssessmentPhotos + momentPhotos + gaugePhoto sources, plus the
 * traced-map snapshot). Probing only data.photos left the other sources
 * cacheable with placeholders (pre-push P1 r19), so keep this list in lockstep
 * with what the component renders. The two cannot share code (the client is
 * ESM bundled by Vite, this is CommonJS), so the client test
 * ServiceReportDocument.renderedImages.test.jsx renders the document for a set
 * of payloads and fails if the two disagree.
 *
 * GATE_LAWN_REPORT_PHOTO_SET: when the payload carries a lawn photo set the
 * document prints the set in place of the `lawn-` turf copies in data.photos
 * and in place of the reportV2.photos strip copies, so the set is probed and
 * those copies are not.
 */
function collectRenderedImageUrls(data) {
  const photoSet = (Array.isArray(data?.reportV2?.photoSet) ? data.reportV2.photoSet : [])
    .filter((p) => p && p.url);
  const hasPhotoSet = photoSet.length > 0;
  const urls = [
    ...(Array.isArray(data?.photos) ? data.photos : [])
      .filter((p) => !(hasPhotoSet && p && String(p.id || '').startsWith('lawn-')))
      .map((p) => p?.url),
    ...photoSet.map((p) => p.url),
    ...(hasPhotoSet ? [] : (Array.isArray(data?.reportV2?.photos) ? data.reportV2.photos : [])
      .map((p) => p?.url || p?.imageUrl)),
    ...((data?.proofMoments || data?.visualServiceMoments || [])
      .filter((m) => m && m.mediaType !== 'video')
      .map((m) => m?.mediaUrl)),
    data?.mowingHeight?.photoUrl,
    data?.treatmentMap?.traced?.snapshotUrl,
  ];
  return [...new Set(urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)))];
}

module.exports = { collectRenderedImageUrls };
