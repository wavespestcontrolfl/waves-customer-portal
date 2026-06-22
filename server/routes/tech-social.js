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
 *   GET  /locations  the 4 GBP service-area locations for the picker
 *
 * Two-layer gating, both fail-closed:
 *   - TECH_SOCIAL_ENABLED gates this whole feature (default off).
 *   - Publishing still flows through SocialMediaService.postToSingle, which
 *     enforces SOCIAL_AUTOMATION_ENABLED + per-platform SOCIAL_*_ENABLED +
 *     the admin pause switch + content validation. Nothing reaches a public
 *     feed until those are deliberately turned on.
 *
 * TikTok has no posting API, so its caption is returned for the tech to copy
 * (clipboard) rather than published.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const captionService = require('../services/tech-social-caption');
const social = require('../services/social-media');
const { WAVES_LOCATIONS } = require('../config/locations');

router.use(adminAuthenticate, requireTechOrAdmin);

// Platforms we can publish to natively. TikTok intentionally absent — no API.
const PUBLISHABLE = ['facebook', 'instagram', 'gbp'];
const MAX_PHOTO_BASE64_BYTES = 12 * 1024 * 1024; // client downscales to ~1600px first

function techSocialEnabled() {
  return String(process.env.TECH_SOCIAL_ENABLED || '').toLowerCase() === 'true';
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
function buildPostLogRow({ techNote, captions, results, imageUrl, location, model }) {
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
    platforms_posted: JSON.stringify(results),
    image_url: imageUrl || null,
    status,
    ai_model: model || null,
    published_content: JSON.stringify(captions || {}),
  };
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
router.get('/locations', (req, res) => {
  res.json({ locations: WAVES_LOCATIONS.map(pickLocation) });
});

// POST /api/tech/social/generate — vision + captions, no persistence.
router.post('/generate', async (req, res, next) => {
  try {
    if (!techSocialEnabled()) {
      return res.status(403).json({ error: 'Field social posting is not enabled' });
    }
    const { photo, techNote, locationId, lat, lng, photoType } = req.body || {};
    if (!photo || !photo.data) {
      return res.status(400).json({ error: 'Add a photo first' });
    }
    if (String(photo.data).length > MAX_PHOTO_BASE64_BYTES) {
      return res.status(413).json({ error: 'Photo is too large — retake or let the app shrink it' });
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
    if (!techSocialEnabled()) {
      return res.status(403).json({ error: 'Field social posting is not enabled' });
    }
    const { photo, captions, platforms, locationId, model } = req.body || {};
    if (!captions || typeof captions !== 'object') {
      return res.status(400).json({ error: 'No captions to publish' });
    }
    // Same size cap as /generate — /publish must not re-accept an oversized
    // client photo and push it through uploadImageToS3/Sharp unbounded.
    if (photo && photo.data && String(photo.data).length > MAX_PHOTO_BASE64_BYTES) {
      return res.status(413).json({ error: 'Photo is too large — retake or let the app shrink it' });
    }

    const publishPlatforms = selectPublishPlatforms(platforms);
    const tiktokRequested = Array.isArray(platforms)
      && platforms.map((p) => String(p || '').toLowerCase()).includes('tiktok');

    // Preflight BEFORE hosting the photo: a paused/disabled/invalid publish must
    // never leave a public field-photo URL behind. For each requested platform,
    // check readiness (automation + per-platform flag + creds + admin pause) and
    // run the same content validation postToSingle will. Only platforms that pass
    // get attempted; the rest are recorded as skips with the reason.
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
      const ready = await social.assertSocialPublishingReady(platform, platform === 'gbp' ? locationId : undefined);
      if (!ready.ready) {
        results.push({ platform, skipped: ready.reason });
        continue;
      }
      const validation = social.validateContent(content, platform);
      if (!validation.valid) {
        results.push({ platform, skipped: `Validation: ${validation.issues[0]}`, validationIssues: validation.issues });
        continue;
      }
      plan.push({ platform, content });
    }

    // Host the photo on the public CDN once — and only if something will actually
    // publish and it isn't a dry run. Instagram requires a public URL; Facebook
    // and GBP attach it when present. Null when image hosting isn't configured.
    let imageUrl = null;
    const dryRun = !!(social.SOCIAL_FLAGS && social.SOCIAL_FLAGS.dryRun);
    if (plan.length && !dryRun && photo && photo.data) {
      // Unguessable, collision-free key — these are customer field photos.
      imageUrl = await social.uploadImageToS3(photo.data, `tech-field-${crypto.randomUUID()}.jpg`);
    }

    // Photo-first flow: if the tech submitted a photo but it couldn't be hosted,
    // do NOT publish text-only posts describing a photo the public won't see —
    // fail every planned native platform with a clear reason. (Dry-run skips
    // hosting by design and postToSingle no-ops, so it's exempt.)
    const photoHostingFailed = !!(plan.length && photo && photo.data && !dryRun && !imageUrl);

    for (const { platform, content } of plan) {
      if (photoHostingFailed) {
        results.push({ platform, success: false, error: 'Field photo could not be hosted — not publishing (check SOCIAL_MEDIA_CDN_DOMAIN / S3)' });
        continue;
      }
      if (platform === 'instagram' && !imageUrl && !dryRun) {
        results.push({ platform, success: false, error: 'Instagram needs a hosted image (set SOCIAL_MEDIA_CDN_DOMAIN)' });
        continue;
      }
      try {
        const r = await social.postToSingle(platform, {
          content,
          imageUrl: imageUrl || undefined,
          locationId: platform === 'gbp' ? locationId : undefined,
        });
        results.push({ platform, ...r });
      } catch (err) {
        results.push({ platform, success: false, error: err.message });
      }
    }

    const location = WAVES_LOCATIONS.find((l) => l.id === locationId) || null;
    await logPost(buildPostLogRow({
      techNote: typeof req.body.techNote === 'string' ? req.body.techNote : '',
      captions, results, imageUrl, location,
      model: typeof model === 'string' ? model : null,
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

    res.json({
      results,
      clipboard: tiktokRequested ? { tiktok: (captions.tiktok || '') } : null,
      imageHosted: !!imageUrl,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._test = { selectPublishPlatforms, buildPostLogRow, techSocialEnabled, PUBLISHABLE };
