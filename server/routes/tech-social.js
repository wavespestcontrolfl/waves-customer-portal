/**
 * Tech-portal field social posting. Mounted at /api/tech/social.
 *
 * The seamless flow: a field tech snaps one photo, types a couple words, and
 * gets four platform-tailored captions to review/edit and publish — straight
 * from their phone, no admin queue (owner decision 2026-06-22).
 *
 *   POST /generate   photo + note + location → Gemini vision + Claude captions
 *                    (no persistence — the tech's eyes, like lawn-diagnostic/analyze)
 *   POST /publish    tech-edited captions → native publish via SocialMediaService
 *   POST /validate   brand-rule check for one caption (used before TikTok copy)
 *   GET  /locations  the 4 GBP service-area locations for the picker
 *
 * Gating, all fail-closed:
 *   - TECH_SOCIAL_ENABLED (env) is the global kill-switch (default off).
 *   - Per-technician feature flag `tech_social_enabled` (user_feature_flags,
 *     keyed by technicianId) controls per-tech rollout — enforced server-side on
 *     every route, not just the TechHome tile.
 *   - Publishing still flows through SocialMediaService.postToSingle, which
 *     enforces SOCIAL_AUTOMATION_ENABLED + per-platform SOCIAL_*_ENABLED +
 *     the admin pause switch + content validation. Nothing reaches a public
 *     feed until those are deliberately turned on.
 *
 * TikTok has no posting API, so it never goes through /publish — the tech copies
 * its caption (validated via /validate) and posts it in the app manually.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const captionService = require('../services/tech-social-caption');
const social = require('../services/social-media');
const { isUserFeatureEnabled } = require('../services/feature-flags');
const { WAVES_LOCATIONS } = require('../config/locations');

router.use(adminAuthenticate, requireTechOrAdmin);

// Platforms we can publish to natively. TikTok intentionally absent — no API.
const PUBLISHABLE = ['facebook', 'instagram', 'gbp'];
const MAX_PHOTO_BASE64_BYTES = 12 * 1024 * 1024; // client downscales to ~1600px first
const TECH_SOCIAL_FLAG = 'tech_social_enabled';

// Env kill-switch — feature off globally unless explicitly enabled.
function techSocialEnabled() {
  return String(process.env.TECH_SOCIAL_ENABLED || '').toLowerCase() === 'true';
}

// Authoritative gate: the env kill-switch AND a per-technician feature flag, so
// the owner can limit rollout to specific techs. The flag is keyed by
// technicianId — the SAME id the TechHome tile's useFeatureFlag reads — so the
// tile and the API stay consistent.
async function techSocialAllowed(req) {
  if (!techSocialEnabled()) return false;
  return isUserFeatureEnabled(req.technicianId, TECH_SOCIAL_FLAG, false);
}

function pickLocation(loc) {
  return loc ? { id: loc.id, name: loc.name, area: loc.area } : null;
}

// Which platforms to actually publish to. Fail-closed: only an OMITTED selection
// (null/undefined) defaults to all publishable. An explicit array is taken
// literally (so [] publishes nothing), and a malformed value (e.g. a bare
// string from a stale client) publishes nothing — never fan out on bad input.
function selectPublishPlatforms(requested) {
  if (requested === undefined || requested === null) return [...PUBLISHABLE];
  if (!Array.isArray(requested)) return [];
  const set = new Set(requested.map((p) => String(p || '').trim().toLowerCase()));
  return PUBLISHABLE.filter((p) => set.has(p));
}

// Build the social_media_posts audit row from a publish result. Pure + testable.
// `model` is the ACTUAL caption-generation model (carried from /generate, which
// may fall back VOICE→FLAGSHIP); null when unknown (e.g. manually supplied
// captions) — never hardcode a tier here, it makes ai_model unreliable.
function buildPostLogRow({ techNote, captions, results, imageUrl, location, model, publishId }) {
  const anySuccess = results.some((r) => r && r.success);
  const anyDryRun = results.some((r) => r && r.dryRun);
  // A preflight skip (paused/disabled/no-caption/validation) is NOT a platform
  // failure — only an actual attempt returning success:false counts. So an
  // all-skipped publish logs as 'skipped' and never feeds the failure alert.
  const anyFailure = results.some((r) => r && !r.success && !r.dryRun && !r.skipped);
  const status = anySuccess ? 'published' : anyDryRun ? 'dry_run' : anyFailure ? 'failed' : 'skipped';
  return {
    title: (techNote || `Field photo — ${location?.name || 'Waves'}`).slice(0, 200),
    description: String(techNote || captions?.facebook || '').slice(0, 1000),
    source_type: 'tech_field',
    source_guid: publishId || null, // idempotency key — reused for retry de-dupe
    platforms_posted: JSON.stringify(results),
    image_url: imageUrl || null,
    status,
    ai_model: model || null,
    published_content: JSON.stringify(captions || {}),
  };
}

// Atomic per-platform publish claim. system_settings.key is the PRIMARY KEY, so
// INSERT … ON CONFLICT DO NOTHING serializes concurrent /publish calls with the
// same publishId — a double tap or in-flight retry can't double-post a platform.
// Returns true only if WE won the claim.
function publishClaimKey(publishId, platform) {
  return `tech_social_claim:${publishId}:${platform}`;
}

// Returns true only if WE won the claim. Fails CLOSED (false) on any error or a
// missing key — we must NOT post to a public feed when the de-dupe can't be
// recorded (publishId shape is bounded at the route so the key always fits).
async function claimPlatformPublish(publishId, platform) {
  if (!publishId) return false;
  try {
    const inserted = await db('system_settings')
      .insert({ key: publishClaimKey(publishId, platform), value: 'claimed', category: 'tech_social', updated_at: new Date() })
      .onConflict('key').ignore()
      .returning('key');
    return Array.isArray(inserted) && inserted.length > 0;
  } catch (err) {
    logger.warn(`[tech-social] publish claim failed (failing closed): ${err.message}`);
    return false;
  }
}

// Release the claim when the attempt did NOT post, so a later retry can re-try.
async function releasePlatformClaim(publishId, platform) {
  if (!publishId) return;
  await db('system_settings').where({ key: publishClaimKey(publishId, platform) }).del().catch(() => {});
}

async function logPost(row) {
  try {
    const cols = await db('social_media_posts').columnInfo();
    const insert = {};
    for (const [key, value] of Object.entries(row)) {
      if (cols[key]) insert[key] = value;
    }
    if (Object.keys(insert).length) await db('social_media_posts').insert(insert);
  } catch (err) {
    logger.warn(`[tech-social] post log failed: ${err.message}`);
  }
}

// GET /api/tech/social/locations — service-area locations for the GBP picker.
router.get('/locations', async (req, res, next) => {
  try {
    res.json({ enabled: await techSocialAllowed(req), locations: WAVES_LOCATIONS.map(pickLocation) });
  } catch (err) {
    next(err);
  }
});

// POST /api/tech/social/validate — brand-rule check for a single caption.
// TikTok copy is the delivery path (no API), so the client validates before
// copying; also a pre-copy check for the publishable platforms.
router.post('/validate', async (req, res, next) => {
  try {
    if (!(await techSocialAllowed(req))) {
      return res.status(403).json({ error: 'Field social posting is not enabled' });
    }
    const { caption, platform } = req.body || {};
    const known = new Set([...PUBLISHABLE, 'tiktok']);
    const p = known.has(platform) ? platform : 'facebook';
    const text = String(caption || '');
    const base = social.validateContent(text, p);
    const issues = [...(base.valid ? [] : base.issues), ...captionService.piiIssues(text)];
    res.json({ valid: issues.length === 0, issues });
  } catch (err) {
    next(err);
  }
});

// POST /api/tech/social/generate — vision + captions, no persistence.
router.post('/generate', async (req, res, next) => {
  try {
    if (!(await techSocialAllowed(req))) {
      return res.status(403).json({ error: 'Field social posting is not enabled' });
    }
    const { photo, techNote, locationId, lat, lng, photoType } = req.body || {};
    if (!photo || !photo.data) {
      return res.status(400).json({ error: 'Add a photo first' });
    }
    if (String(photo.data).length > MAX_PHOTO_BASE64_BYTES) {
      return res.status(413).json({ error: 'Photo is too large — retake or let the app shrink it' });
    }
    // The GBP caption is geo-specific. If the tech left the picker on "Auto" but
    // geolocation is unavailable, we have no signal — don't silently default to the
    // primary location (would post a wrong-city GBP). Force a manual selection.
    const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
    const validLocId = !!locationId && WAVES_LOCATIONS.some((l) => l.id === locationId);
    // A valid pick OR usable coords is required — never silently default to the
    // primary GBP for an absent/stale/unknown locationId (wrong-city GBP copy).
    if (!validLocId && !hasCoords) {
      return res.status(422).json({ error: 'Select your service area — location auto-detect is unavailable' });
    }

    const image = { data: photo.data, mimeType: photo.mimeType || 'image/jpeg' };
    const note = typeof techNote === 'string' ? techNote.trim().slice(0, 500) : '';
    const location = captionService.resolveCaptionLocation({ locationId, lat, lng });

    const vision = await captionService.analyzePhoto(image);
    const { captions, validation, model } = await captionService.generateCaptions({
      vision, techNote: note, location, photoType,
    });

    logger.info(
      `[tech-social] generate tech=${req.technicianId} loc=${location.id} ` +
      `visionSource=${vision?.source || 'none'} model=${model}`
    );

    res.json({ vision, captions, validation, location: pickLocation(location), model });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/tech/social/publish — native publish of the (tech-edited) captions.
router.post('/publish', async (req, res, next) => {
  try {
    if (!(await techSocialAllowed(req))) {
      return res.status(403).json({ error: 'Field social posting is not enabled' });
    }
    const { photo, captions, platforms, locationId, model, publishId } = req.body || {};
    if (!captions || typeof captions !== 'object') {
      return res.status(400).json({ error: 'No captions to publish' });
    }
    // Photo-first contract: publishing without a photo would post captions that
    // describe an image the public never sees. Require it (the hosting-failure
    // guard below only triggers when a photo was supplied).
    if (!photo || !photo.data) {
      return res.status(400).json({ error: 'A photo is required to publish' });
    }
    // Same size cap as /generate — /publish must not re-accept an oversized
    // client photo and push it through uploadImageToS3/Sharp unbounded.
    if (photo && photo.data && String(photo.data).length > MAX_PHOTO_BASE64_BYTES) {
      return res.status(413).json({ error: 'Photo is too large — retake or let the app shrink it' });
    }
    // Idempotency requires a stable, bounded key — the client mints one per
    // generated caption set. Bound the shape so the claim key always fits
    // system_settings.key (varchar 100) and the de-dupe can't be bypassed.
    if (typeof publishId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(publishId)) {
      return res.status(400).json({ error: 'Missing or invalid publishId' });
    }

    const publishPlatforms = selectPublishPlatforms(platforms);
    const gbpLocation = WAVES_LOCATIONS.find((l) => l.id === locationId) || null;
    const dryRun = !!(social.SOCIAL_FLAGS && social.SOCIAL_FLAGS.dryRun);

    // Preflight BEFORE hosting the photo: a paused/disabled/invalid publish must
    // never leave a public field-photo URL behind. For each requested platform,
    // check readiness (automation + per-platform flag + creds + admin pause) and
    // run the same content + PII validation. Only platforms that pass get
    // attempted; the rest are recorded as skips with the reason.
    const results = [];
    const plan = [];
    for (const platform of publishPlatforms) {
      const content = (captions[platform] || '').trim();
      // Preflight non-attempts are recorded as `skipped`, never `success:false` —
      // the shared checkAndRaiseAlert() only counts non-skipped success:false
      // entries, so an intentionally paused/disabled platform must not look like
      // a real failure (else 3 attempts while disabled raise a false alert).
      if (!content) {
        results.push({ platform, skipped: 'No caption for this platform' });
        continue;
      }
      // GBP is geo-specific — never let a missing/unknown locationId fall back to
      // the default profile (postToGBP would post to the wrong city). Skip instead.
      if (platform === 'gbp' && !gbpLocation) {
        results.push({ platform, skipped: 'No valid service area selected for Google Business' });
        continue;
      }
      // Dry-run is for smoke-testing without live creds — skip the credential /
      // image-hosting readiness gate (postToSingle no-ops), but still validate copy.
      if (!dryRun) {
        const ready = await social.assertSocialPublishingReady(platform, platform === 'gbp' ? locationId : undefined);
        if (!ready.ready) {
          results.push({ platform, skipped: ready.reason });
          continue;
        }
      }
      const base = social.validateContent(content, platform);
      const issues = [...(base.valid ? [] : base.issues), ...captionService.piiIssues(content)];
      if (issues.length) {
        results.push({ platform, skipped: `Validation: ${issues[0]}`, validationIssues: issues });
        continue;
      }
      plan.push({ platform, content });
    }

    // Claim each planned platform BEFORE hosting the photo or posting — the atomic
    // INSERT…ON CONFLICT serializes concurrent/retry publishes, so a timed-out
    // retry can't re-host the field photo or re-post for a platform another request
    // already claimed. (Dry-run does no real work, so it skips claiming.)
    const toPublish = [];
    for (const item of plan) {
      if (dryRun || await claimPlatformPublish(publishId, item.platform)) {
        toPublish.push(item);
      } else {
        results.push({ platform: item.platform, skipped: 'Skipped to avoid a duplicate post (idempotency)' });
      }
    }

    // Host the photo on the public CDN once — only if a claimed platform will
    // actually publish and it isn't a dry run. Instagram requires a public URL;
    // Facebook and GBP attach it when present.
    let imageUrl = null;
    // Only upload when hosting is fully configured — uploadImageToS3 PUTs the
    // object BEFORE its own CDN check, so calling it without a CDN domain would
    // orphan the customer photo on S3 with no URL to clean up.
    if (toPublish.length && !dryRun && photo && photo.data && social.isImageHostingConfigured()) {
      // Unguessable, collision-free key — these are customer field photos.
      imageUrl = await social.uploadImageToS3(photo.data, `tech-field-${crypto.randomUUID()}.jpg`);
    }

    // Photo-first flow: if the tech submitted a photo but it couldn't be hosted,
    // do NOT publish text-only posts describing a photo the public won't see —
    // fail every claimed platform and release its claim so a retry can re-try.
    const photoHostingFailed = !!(toPublish.length && photo && photo.data && !dryRun && !imageUrl);

    for (const { platform, content } of toPublish) {
      if (photoHostingFailed) {
        if (!dryRun) await releasePlatformClaim(publishId, platform);
        results.push({ platform, success: false, error: 'Field photo could not be hosted — not publishing (check SOCIAL_MEDIA_CDN_DOMAIN / S3)' });
        continue;
      }
      if (platform === 'instagram' && !imageUrl && !dryRun) {
        await releasePlatformClaim(publishId, platform);
        results.push({ platform, success: false, error: 'Instagram needs a hosted image (set SOCIAL_MEDIA_CDN_DOMAIN)' });
        continue;
      }
      try {
        const r = await social.postToSingle(platform, {
          content,
          imageUrl: imageUrl || undefined,
          locationId: platform === 'gbp' ? locationId : undefined,
        });
        // Keep the claim regardless of the result: once postToSingle is invoked the
        // outcome is ambiguous (a returned failure or a thrown timeout may still have
        // created the public post), so we never release post-attempt — a retry must
        // not be able to duplicate it. The platform stays claimed until a fresh
        // publishId. (Pre-attempt no-side-effect skips above DO release.)
        results.push({ platform, ...r });
      } catch (err) {
        results.push({ platform, success: false, error: err.message });
      }
    }

    // Don't leave an orphan: if a photo was hosted but no platform actually
    // published, delete it so a customer field photo isn't left publicly
    // fetchable — and don't record the (now-deleted) URL in the audit row.
    const anyPublished = results.some((r) => r && r.success);
    if (imageUrl && !anyPublished) {
      await social.deleteSocialImage(imageUrl).catch(() => {});
      imageUrl = null;
    }

    // Audit ONLY the validated captions (those that passed content + PII checks
    // and were attempted) — never persist a PII-rejected caption to history.
    const loggedCaptions = {};
    for (const item of plan) loggedCaptions[item.platform] = item.content;

    // Sanitize what we persist: drop the detailed validationIssues (they can quote
    // an unknown phone number) and genericize validation skip reasons; and redact
    // techNote if it carries PII (it's free text the tech typed, never PII-checked).
    const loggedResults = results.map(({ validationIssues, ...r }) =>
      (typeof r.skipped === 'string' && r.skipped.startsWith('Validation:'))
        ? { ...r, skipped: 'Validation: caption rejected' }
        : r);
    const rawNote = (typeof req.body.techNote === 'string' ? req.body.techNote : '').slice(0, 500);
    // Redact the note if it trips ANY guard captions get — phone (validateContent's
    // unknown-number check) + email/street (piiIssues) — so customer PII a tech
    // typed into the free-text note never lands in the audit row.
    const noteIssues = [
      ...(social.validateContent(rawNote, 'facebook').issues || []),
      ...captionService.piiIssues(rawNote),
    ];
    const safeNote = noteIssues.length ? '' : rawNote;

    const location = WAVES_LOCATIONS.find((l) => l.id === locationId) || null;
    await logPost(buildPostLogRow({
      techNote: safeNote,
      captions: loggedCaptions, results: loggedResults, imageUrl, location,
      model: typeof model === 'string' ? model.slice(0, 80) : null, // ai_model is varchar(80)
      publishId: typeof publishId === 'string' ? publishId : null,
    }));

    // Keep the shared consecutive-failure alert current — tech-field posts land
    // in the same social_media_posts table checkAndRaiseAlert() reads. Explicit
    // fire-and-forget with logged error handling (AGENTS.md floating-promise rule).
    void social.checkAndRaiseAlert().catch((err) => logger.error(`[tech-social] alert check failed: ${err.message}`));

    logger.info(
      `[tech-social] publish tech=${req.technicianId} ` +
      `platforms=${publishPlatforms.join(',') || 'none'} ` +
      `ok=${results.filter((r) => r.success).length}/${results.length} imageHosted=${!!imageUrl}`
    );

    res.json({ results, imageHosted: !!imageUrl });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._test = { selectPublishPlatforms, buildPostLogRow, publishClaimKey, techSocialEnabled, PUBLISHABLE };
