/**
 * Photo privacy shadow (dark behind GATE_PHOTO_PRIVACY=shadow, on top of the
 * typed-decisions and Clef gates).
 *
 * After a technician social post is published and logged (routes/tech-social.js),
 * its photo is put to Cloudflare Clef as photo_privacy.v1 (a face, a person,
 * readable address text, a license plate, a child, a pet) and each answer is
 * recorded in decision_reviews against the social_media_posts row.
 *
 * SHADOW ONLY: nothing here holds, edits or removes a post, and the route
 * ignores the result. The photo is fitted to Clef's request budget in memory
 * (fitImagesForClef: re-encoded, metadata dropped) and is not stored again;
 * rows hold ids and yes/no answers, and the ledger files a digest of the image.
 *
 * Baseline: the publish path has no image check, so it treated every photo it
 * published as showing none of these (`production: false`). A Clef "yes"
 * therefore lands in the review queue as a disagreement and the rest are
 * sampled by the random audit, which is the set a later hold needs labels on.
 */
const { photoPrivacyMode } = require('../../config/feature-gates');

const PACKAGE_ID = 'photo_privacy.v1';
const SURFACE = 'social';

/**
 * @param {object} p
 * @param {string} p.postId     the social_media_posts row the publish logged
 * @param {string} p.imageUrl   the hosted photo's public URL (no URL = nothing public to check)
 * @param {string} p.photoData  the photo as bare base64, as the route received it
 * @param {object} p.captions   the published captions by platform (the row's published_content)
 * @returns {Promise<{asked:number, recorded:number, failed:number, skipped?:string}>}
 */
async function shadowSocialPostPhoto({ postId, imageUrl, photoData, captions } = {}) {
  const out = { asked: 0, recorded: 0, failed: 0 };
  if (photoPrivacyMode() !== 'shadow') return { ...out, skipped: 'gate_off' };
  if (!postId || !imageUrl || typeof photoData !== 'string' || !photoData) return { ...out, skipped: 'no_photo' };

  // Lazy: the gate-off path must not load these modules (the fitter pulls in sharp).
  const { packageFor } = require('./packages');
  const { fitImagesForClef, clefBodyOverhead } = require('./image-budget');
  const { socialPostCaption, socialPostSubjectHash } = require('./subject-hash');
  const pkg = packageFor(PACKAGE_ID);
  const state = { surface: SURFACE, caption: socialPostCaption(captions) };

  const fitted = await fitImagesForClef([Buffer.from(photoData, 'base64')], { maxImages: pkg.imageSlots, reserveBytes: clefBodyOverhead(state, pkg.questions) });
  if (!fitted.ok) return { ...out, skipped: `image_${fitted.reason}` };

  const { askPackage } = require('./jev');
  out.asked = 1;
  const result = await askPackage(PACKAGE_ID, state, { provider: 'cloudflare', images: fitted.images });
  if (!result || !result.ok) return { ...out, failed: 1 };

  const baselines = Object.fromEntries(Object.keys(pkg.questions).map((id) => [id, { production: false }]));
  const { recordDecisions } = require('./shadow-recorder');
  const written = await recordDecisions({
    capability: pkg.capability,
    pkg,
    provider: 'cloudflare',
    subjectType: 'social_post',
    subjectId: postId,
    result,
    baselines,
    subjectHash: socialPostSubjectHash({ imageUrl, captions }),
  });
  if (written.recorded > 0) out.recorded = written.recorded; else out.failed = 1;
  return out;
}

module.exports = { shadowSocialPostPhoto, PACKAGE_ID };
