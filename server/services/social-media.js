/**
 * Social Media Engine.
 *
 * Flow: RSS/Blog trigger → AI content generation → post to all platforms
 *   - Facebook Page
 *   - Instagram Business
 *   - LinkedIn Company Page
 *   - Google Business Profile (4 locations, each with location-specific copy)
 *
 * Env vars:
 *   ANTHROPIC_API_KEY          — AI content generation (already set)
 *   FACEBOOK_PAGE_ID           — Facebook page ID
 *   FACEBOOK_ACCESS_TOKEN      — Long-lived page access token
 *   INSTAGRAM_ACCOUNT_ID       — Instagram business account ID
 *   LINKEDIN_COMPANY_ID        — LinkedIn company page ID
 *   LINKEDIN_ACCESS_TOKEN      — LinkedIn OAuth token
 *   GOOGLE_MAPS_API_KEY        — Already set for GBP
 *   GEMINI_API_KEY             — For AI image generation (optional)
 */

const db = require('../models/db');
const logger = require('./logger');
const gbpService = require('./google-business');
const { WAVES_LOCATIONS } = require('../config/locations');
const config = require('../config');
const MODELS = require('../config/models');

let Anthropic;
try {
  const sdk = require('@anthropic-ai/sdk');
  Anthropic = sdk.default || sdk.Anthropic || sdk;
} catch (err) {
  logger.warn(`[social] Anthropic SDK unavailable: ${err.message}`);
  Anthropic = null;
}

const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const LINKEDIN_COMPANY_ID = process.env.LINKEDIN_COMPANY_ID;

// ── Feature Flags ──
// Credentials make a platform *available*, not *active*.
// Automation stays off until explicitly enabled.
function socialFlag(key) {
  return String(process.env[key] || '').toLowerCase() === 'true';
}
const SOCIAL_FLAGS = {
  get automationEnabled() { return socialFlag('SOCIAL_AUTOMATION_ENABLED'); },
  get rssAutopublish() { return socialFlag('SOCIAL_RSS_AUTOPUBLISH_ENABLED'); },
  get scheduledPosts() { return socialFlag('SOCIAL_SCHEDULED_POSTS_ENABLED'); },
  get newsletterAutoshare() { return socialFlag('SOCIAL_NEWSLETTER_AUTOSHARE_ENABLED'); },
  get facebookEnabled() { return socialFlag('SOCIAL_FACEBOOK_ENABLED'); },
  get instagramEnabled() { return socialFlag('SOCIAL_INSTAGRAM_ENABLED'); },
  get gbpEnabled() { return socialFlag('SOCIAL_GBP_ENABLED'); },
  get dryRun() { return socialFlag('SOCIAL_DRY_RUN'); },
};

const PUBLISH_PLATFORMS = ['facebook', 'instagram', 'linkedin', 'gbp'];

function normalizePublishChannels(channels) {
  // Omitted (undefined/null/not an array) → default to all platforms. An
  // EXPLICIT list fails closed: an all-invalid or empty list resolves to no
  // platforms, so a typo or stale client can't accidentally blast everywhere.
  if (channels == null || !Array.isArray(channels)) return new Set(PUBLISH_PLATFORMS);
  const selected = channels
    .map((channel) => String(channel || '').trim().toLowerCase())
    .filter((channel) => PUBLISH_PLATFORMS.includes(channel));
  return new Set(selected);
}

function normalizeGbpLocationIds(locationIds) {
  // Omitted → null = all GBP locations (the default). An EXPLICIT list fails
  // closed: all-invalid/empty yields an empty set, so no GBP location is
  // posted to rather than every one of them.
  if (locationIds == null || !Array.isArray(locationIds)) return null;
  const valid = new Set(WAVES_LOCATIONS.map((loc) => loc.id));
  const selected = locationIds
    .map((id) => String(id || '').trim())
    .filter((id) => valid.has(id));
  return new Set(selected);
}

async function isPausedByAdmin() {
  try {
    const row = await db('system_settings').where('key', 'social_automation_paused').first();
    return row?.value === 'true' || row?.value === true;
  } catch { return false; }
}

// ── Per-platform consecutive-failure alerting ──
// A post's `status` is 'published' when ANY platform succeeds, so a single
// broken platform (e.g. Instagram failing auth while Facebook + GBP post fine)
// is invisible at the post level — that's how Instagram sat dead ~2 weeks
// unnoticed. Instead, derive each platform's recent outcome from
// platforms_posted and alert when any one platform's last ALERT_THRESHOLD
// *attempts* all failed.
const ALERT_THRESHOLD = 3;
const ALERT_WINDOW = 20; // recent posts to scan — enough to find THRESHOLD attempts per platform
const ALERTED_PLATFORMS = ['facebook', 'instagram', 'gbp'];
const PLATFORM_LABELS = { facebook: 'Facebook', instagram: 'Instagram', gbp: 'Google Business' };
const SOCIAL_ALERT_KEY = 'social_consecutive_failures_alert';

function parsePlatformResults(value) {
  if (!value) return [];
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v : [];
}

// One platform's outcome within a single post: 'success' | 'fail' | null.
// null = not a real attempt (disabled / skipped / dry-run) — ignored for the
// streak. GBP posts to multiple locations, so treat the post as a success if
// ANY location succeeded (mirrors the post-level "any success" rule) and a
// fail only if every attempted location failed.
function platformOutcomeForPost(entries, platform) {
  const attempts = entries.filter(e => e && e.platform === platform && !e.skipped && !e.dryRun);
  if (!attempts.length) return null;
  if (attempts.some(e => e.success === true)) return 'success';
  if (attempts.some(e => e.success === false)) return 'fail';
  return null;
}

function firstPlatformError(parsedPosts, platform) {
  for (const entries of parsedPosts) {
    const e = entries.find(x => x && x.platform === platform && x.success === false && x.error);
    if (e) return String(e.error).slice(0, 120);
  }
  return null;
}

// Pure: given recent post rows (newest first), return which platforms have
// ALERT_THRESHOLD+ consecutive failed attempts. Exported for testing.
function buildSocialFailureAlert(recentRowsNewestFirst, threshold = ALERT_THRESHOLD) {
  const parsed = (recentRowsNewestFirst || []).map(r => parsePlatformResults(r.platforms_posted));
  const broken = [];
  for (const platform of ALERTED_PLATFORMS) {
    const outcomes = parsed
      .map(entries => platformOutcomeForPost(entries, platform))
      .filter(o => o !== null);
    if (outcomes.length < threshold) continue; // not enough attempts to judge
    const firstSuccess = outcomes.indexOf('success');
    const consecutiveFailures = firstSuccess === -1 ? outcomes.length : firstSuccess;
    if (consecutiveFailures >= threshold) {
      broken.push({
        platform,
        label: PLATFORM_LABELS[platform] || platform,
        consecutive_failures: consecutiveFailures,
        latest_error: firstPlatformError(parsed, platform),
      });
    }
  }
  if (!broken.length) return { active: false, platforms: [] };
  const names = broken.map(b => b.label).join(', ');
  const errSuffix = broken.length === 1 && broken[0].latest_error
    ? ` (latest: ${broken[0].latest_error})` : '';
  const message =
    `${names} ${broken.length === 1 ? 'has' : 'have'} ${threshold}+ consecutive failed posts — check platform credentials${errSuffix}`;
  return { active: true, message, platforms: broken };
}

async function checkAndRaiseAlert() {
  try {
    const recentPosts = await db('social_media_posts')
      .orderBy('created_at', 'desc')
      .limit(ALERT_WINDOW)
      .select('platforms_posted');

    const result = buildSocialFailureAlert(recentPosts);

    if (result.active) {
      const existing = await db('system_settings').where('key', SOCIAL_ALERT_KEY).first();
      let priorRaisedAt = null;
      if (existing) {
        try {
          const prior = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
          priorRaisedAt = prior && prior.raised_at;
        } catch { /* ignore malformed prior value */ }
      }
      const value = JSON.stringify({
        // Keep the original "since" timestamp while the alert stays active.
        raised_at: priorRaisedAt || new Date().toISOString(),
        message: result.message,
        platforms: result.platforms,
      });
      if (existing) {
        await db('system_settings').where('key', SOCIAL_ALERT_KEY).update({ value, updated_at: new Date() });
      } else {
        await db('system_settings').insert({ key: SOCIAL_ALERT_KEY, value, updated_at: new Date() });
      }
      logger.warn(`[social] ALERT: consecutive failures — ${result.platforms.map(p => p.label).join(', ')}`);
    } else {
      await db('system_settings').where('key', SOCIAL_ALERT_KEY).del();
    }
  } catch (err) {
    logger.error(`[social] Alert check failed: ${err.message}`);
  }
}

const PLATFORM_FLAG_MAP = {
  facebook: 'facebookEnabled',
  instagram: 'instagramEnabled',
  gbp: 'gbpEnabled',
};

const PLATFORM_ENV_REQS = {
  facebook: ['FACEBOOK_ACCESS_TOKEN', 'FACEBOOK_PAGE_ID'],
  instagram: ['FACEBOOK_ACCESS_TOKEN', 'INSTAGRAM_ACCOUNT_ID'],
  gbp: [],
};

async function assertSocialPublishingReady(platform, locationId) {
  if (await isPausedByAdmin()) {
    return { ready: false, reason: 'Automation paused by admin' };
  }
  if (!SOCIAL_FLAGS.automationEnabled) {
    return { ready: false, reason: 'SOCIAL_AUTOMATION_ENABLED is not true' };
  }

  const flagKey = PLATFORM_FLAG_MAP[platform];
  if (flagKey && !SOCIAL_FLAGS[flagKey]) {
    return { ready: false, reason: `${platform} is disabled (SOCIAL_${platform.toUpperCase()}_ENABLED)` };
  }

  const requiredEnvs = PLATFORM_ENV_REQS[platform] || [];
  for (const envKey of requiredEnvs) {
    if (!process.env[envKey]) {
      return { ready: false, reason: `Missing required env var: ${envKey}` };
    }
  }

  if (platform === 'instagram') {
    const cdnDomain = process.env.SOCIAL_MEDIA_CDN_DOMAIN;
    const hasS3 = config.s3.accessKeyId && config.s3.secretAccessKey && config.s3.bucket;
    if (!hasS3 && !cdnDomain) {
      return { ready: false, reason: 'Instagram requires image hosting (S3 + CloudFront) — not configured' };
    }
  }

  // GBP client creds are per-location (GBP_CLIENT_ID_*/GBP_CLIENT_SECRET_*),
  // so they can't live in PLATFORM_ENV_REQS' static list. Without them,
  // postToGBP fails in _getHeaders ("No GBP credentials for location") — and
  // callers that gate image generation on this readiness check would burn
  // image credits first. Bail here so the post is parked, not retried.
  if (platform === 'gbp') {
    if (!gbpService.configured) {
      return { ready: false, reason: 'GBP OAuth client credentials not configured for any location' };
    }
    // gbpService.configured only proves SOME location has client creds. When
    // the caller knows the target location (e.g. the autonomous single-profile
    // post), verify THAT location has usable creds + a refresh token — a
    // partial setup would otherwise pass the global check and burn an image
    // before postToGBP fails for the unconfigured target.
    if (locationId && !(await gbpService.isLocationConfigured(locationId))) {
      return { ready: false, reason: `GBP location "${locationId}" has no usable credentials (client ID/secret + refresh token)` };
    }
  }

  return { ready: true };
}

// ── Content Validation ──
const PRICING_PATTERNS = /\$\d+(?:\.\d{2})?(?:\s*\/\s*(?:mo(?:nth)?|yr|year|visit|quarter))?/i;
const SAFETY_OVERCLAIMS = /\b(?:guarante(?:e[ds]?|ing)|100\s*%\s*(?:effective|safe|eliminat)|completely\s+safe|risk[\s-]*free|no\s+side\s+effects)\b/i;
const PHONE_PATTERN = /(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|\+1\d{10})/g;

const KNOWN_PHONES = new Set();
try {
  const twilioNumbers = require('../config/twilio-numbers');
  const addPhone = (n) => {
    if (n.number) KNOWN_PHONES.add(n.number.replace(/\D/g, ''));
    if (n.formatted) KNOWN_PHONES.add(n.formatted.replace(/\D/g, ''));
  };
  if (twilioNumbers.locations) Object.values(twilioNumbers.locations).forEach(addPhone);
  if (twilioNumbers.domainTracking) twilioNumbers.domainTracking.forEach(addPhone);
  if (twilioNumbers.lawnDomainTracking) twilioNumbers.lawnDomainTracking.forEach(addPhone);
} catch { /* twilio config not available */ }

const PLATFORM_LENGTH_LIMITS = { facebook: 500, instagram: 2200, linkedin: 3000, gbp: 1500 };

function validateContent(text, platform) {
  const issues = [];

  if (PRICING_PATTERNS.test(text)) {
    issues.push('Contains pricing claim — link to /pest-control-calculator/ instead');
  }
  if (SAFETY_OVERCLAIMS.test(text)) {
    issues.push('Contains safety overclaim (guaranteed, 100% effective, etc.)');
  }

  const phones = text.match(PHONE_PATTERN) || [];
  for (const phone of phones) {
    const digits = phone.replace(/\D/g, '');
    const normalized = digits.length === 11 && digits.startsWith('1') ? digits : `1${digits}`;
    if (!KNOWN_PHONES.has(digits) && !KNOWN_PHONES.has(normalized)) {
      issues.push(`Unknown phone number: ${phone} — may be hallucinated`);
    }
  }

  const limit = PLATFORM_LENGTH_LIMITS[platform];
  if (limit && text.length > limit) {
    issues.push(`Content exceeds ${platform} limit (${text.length}/${limit} chars)`);
  }

  return issues.length > 0 ? { valid: false, issues } : { valid: true, issues: [] };
}

// ── URL Normalization ──
function normalizeUrl(url) {
  if (!url || !String(url).trim()) return null;
  if (!url || !String(url).trim()) return null;
  try {
    const u = new URL(url);
    u.protocol = 'https:';
    u.search = '';  // strip UTM params
    u.hash = '';
    let path = u.pathname.replace(/\/+$/, '');
    if (!path) path = '';
    return `${u.origin}${path}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

// A GBP post that fails *with media attached* may have failed because
// Google rejected or couldn't fetch the image — those are worth a text-only
// retry. Auth/quota/validation failures are not media-related and would just
// fail again, so the retry skips them.
function isGbpMediaError(error) {
  return /media|photo|image|picture|thumbnail|source.?url|download|unable to (fetch|access)|could not.*(fetch|access|download)|aspect ratio|resolution|dimension|file (size|format)/i
    .test(String(error || ''));
}

// ── Advisory Lock for RSS Ingestion ──
const RSS_LOCK_ID = 839201;  // arbitrary stable int for pg_advisory_lock

// ── Retry with Exponential Backoff ──
async function withRetry(fn, { maxAttempts = 3, label = '' } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.message?.match(/\b(\d{3})\b/)?.[1];
      const isTransient = !status || status >= 500 || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(err.message);
      const isAuth = status === '401' || status === '403' || /expired|invalid.*token|not.*configured/i.test(err.message);

      if (isAuth || !isTransient || attempt === maxAttempts) throw err;

      const delay = Math.pow(4, attempt - 1) * 1000;  // 1s, 4s, 16s
      logger.warn(`[social] ${label} attempt ${attempt}/${maxAttempts} failed: ${err.message} — retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── AI Content Generation ──

const BRAND_PREAMBLE = `You are writing social media content for Waves Pest Control, a family-owned pest control and lawn care company in Southwest Florida (Manatee, Sarasota, and Charlotte counties). 12 years in SWFL.

Voice: Knowledgeable neighbor, not corporate. You're talking to a homeowner over the fence. Casual, specific, occasionally funny. Never salesy or generic.

Content angles to draw from when relevant:
- What we're seeing this week (seasonal/weather-driven)
- Pest CSI (make pest signs fascinating)
- Lawn ER (diagnosis, not cosmetics)
- Florida newcomer mistakes
- "Don't touch that" (urgency without fearmongering)
- Lanai life (highly local, relatable)

Rules:
- Never include pricing ($39/mo, $99 setup, etc.)
- Never make safety guarantees ("100% effective", "completely safe", "risk-free")
- Never use: "Your trusted pest control provider", "Contact us today for all your pest control needs", "We are pleased to announce", "Dear valued customer"
- Be specific: "Southern chinch bugs feed at the blade base" beats "chinch bugs damage lawns"
- Reference SWFL naturally: Florida humidity, gulf coast weather, lanais, St. Augustine grass, local neighborhoods`;

const HOOK_BANK = [
  "Here's what we're seeing in {location} after the rain…",
  "That brown patch might not be drought.",
  "Don't scrape this off your foundation.",
  "New to Florida? This one surprises people.",
  "If your lanai has ants right now, check this first.",
  "Before you spray, look here.",
  "The bug you see is usually not the whole problem.",
  "Your lawn is not being dramatic. It's trying to tell you something.",
  "A pest tech would notice this in 10 seconds.",
  "This is why DIY sprays don't always solve the problem.",
];

function getHookSample() {
  const shuffled = HOOK_BANK.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3).join('\n  ');
}

async function generateContent(platform, { title, description, link, locationName }) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const safeTitle = String(title || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  const safeDesc = String(description || '').replace(/[\r\n]+/g, ' ').slice(0, 1000);
  const safeLocation = String(locationName || '').replace(/[\r\n]+/g, ' ').slice(0, 100);
  const hooks = getHookSample();

  const prompts = {
    facebook: `${BRAND_PREAMBLE}

Write a Facebook post based on this blog article.

Format:
- Hook line first (question, surprising fact, or "here's what we're seeing")
- 2-3 sentences of real value — the reader should learn something without clicking
- End with a soft CTA ("Full breakdown on the blog" or "Here's what to check first")
- 1-2 emojis max, only where natural — never emoji-stuffed
- 200-400 characters total
- Do NOT include the URL — it will be attached as a link preview

Hook inspiration (vary your approach):
  ${hooks}

GOOD example:
"That brown patch spreading across your St. Augustine? It's probably not drought — it's chinch bugs feeding at the blade base. 🐛 By the time you notice, they've had a 2-week head start. Here's how to tell the difference and what actually works."

BAD example (do NOT write like this):
"🏠🐜 Pest problems? Waves Pest Control is here to help! Check out our latest blog for tips on keeping your home pest-free! 💪✨ #pestcontrol"

Article title: ${safeTitle}
Article summary: ${safeDesc}`,

    instagram: `${BRAND_PREAMBLE}

Write an Instagram caption based on this blog article.

Format:
- Strong opening line that works as a standalone hook (this shows before "...more")
- 2-3 sentences of genuinely useful content
- End with a conversation starter ("What's your lawn doing this week?" or "Tag someone whose lanai has this problem")
- 200-400 characters before hashtags
- Do NOT include any URL

After the caption, add a blank line then 3-5 hashtags:
- Always include: #wavespestcontrol
- 1-2 local: #swfl #sarasotafl #bradentonfl #lakewoodranch #manateecounty #floridahomeowner
- 1-2 niche (match the topic): #chinchbugs #staugustinegrass #floridapests #lawncare #termites #pestcontrol #floridagardening
- Never more than 5 hashtags total

Hook inspiration (vary your approach):
  ${hooks}

GOOD example:
"Florida lawns can look thirsty when they're actually under attack. Chinch bugs hide low in St. Augustine and the damage shows up as crispy patches. Check the blade base before blaming your sprinkler.

What's your lawn doing this week? 👇

#wavespestcontrol #sarasotafl #chinchbugs #staugustinegrass #floridahomeowner"

Article title: ${safeTitle}
Article summary: ${safeDesc}`,

    linkedin: `${BRAND_PREAMBLE}

Write a professional LinkedIn post based on this blog article.
Professional but approachable tone. 100-200 characters. Do NOT include the URL.

Article title: ${safeTitle}
Article summary: ${safeDesc}`,

    gbp: `${BRAND_PREAMBLE}

Write a Google Business Profile post for Waves Pest Control ${safeLocation}.

This post appears on Google Search and Maps for local customers.

Format:
- Mention ${safeLocation || 'the local area'} naturally in the first sentence
- Lead with a useful seasonal or practical tip
- Sound like a local expert sharing advice, not an ad
- End with a clear next step ("Schedule an inspection" or "See the full guide")
- 150-250 characters total — tight and scannable
- Do NOT include any URL or phone number — a button will be attached
- Do NOT use hashtags

GOOD example:
"Seeing crispy St. Augustine in Lakewood Ranch? It may not be drought. Chinch bugs feed near the blade base and spread fast in hot spots. Schedule a lawn inspection before the patch grows."

Article title: ${safeTitle}
Article summary: ${safeDesc}`,
  };

  const prompt = prompts[platform] || prompts.facebook;

  const response = await client.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0]?.text?.trim() || '';
}

// ── AI Image Generation ──
// Delegates to the provider-chained image-generator (gpt-image-2 →
// gpt-image-1.5 → gpt-image-1 → gemini by default). Preserves the
// legacy "return null on any failure" contract so existing callers
// that fall through to non-image posts keep working unchanged.
async function generateImage(title) {
  try {
    const imageGenerator = require('./content/image-generator');
    const result = await imageGenerator.generate({ title, mode: 'social-square' });
    // Existing callers expect { base64, mimeType }. Parse our data: URL
    // back into those parts to maintain the contract.
    const match = /^data:([^;]+);base64,(.+)$/.exec(result.dataUrl || '');
    if (!match) {
      logger.warn(`[social] image-generator returned malformed dataUrl from ${result.model}`);
      return null;
    }
    return { base64: match[2], mimeType: match[1] };
  } catch (err) {
    logger.warn(`[social] image generation failed: ${err.message}`);
    return null;
  }
}

// ── S3 Image Upload (for Instagram/GBP — requires public HTTPS URL) ──
// Uses CloudFront OAC — no public-read ACL on S3.
async function uploadImageToS3(base64Data, filename) {
  if (!config.s3.accessKeyId || !config.s3.bucket) return null;
  const cdnDomain = process.env.SOCIAL_MEDIA_CDN_DOMAIN;

  try {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: config.s3.region,
      credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
    });

    let buffer = Buffer.from(base64Data, 'base64');
    let contentType = 'image/jpeg';
    let finalFilename = filename.replace(/\.\w+$/, '.jpg');

    // Convert PNG/WebP → JPEG (Instagram requires JPEG)
    try {
      const sharp = require('sharp');
      buffer = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
    } catch (sharpErr) {
      logger.error(`[social] sharp unavailable — cannot convert to JPEG for Instagram: ${sharpErr.message}`);
      return null;
    }

    const key = `social-media/${finalFilename}`;
    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));

    if (!cdnDomain) {
      logger.error('[social] SOCIAL_MEDIA_CDN_DOMAIN not set — private S3 URLs are not publicly fetchable');
      return null;
    }
    const url = `https://${cdnDomain}/${key}`;
    logger.info(`[social] Image uploaded: ${url}`);
    return url;
  } catch (err) {
    logger.error(`[social] S3 upload failed: ${err.message}`);
    return null;
  }
}

// ── Platform Posting ──

async function postToFacebook(message, link, imageUrl) {
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!token) throw new Error('FACEBOOK_ACCESS_TOKEN not configured');

  if (imageUrl) {
    const caption = link ? `${message}\n\n${link}` : message;
    const res = await fetch(`https://graph.facebook.com/v25.0/${FACEBOOK_PAGE_ID}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: imageUrl, caption, access_token: token }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Facebook photo API ${res.status}: ${err}`);
    }
    const data = await res.json();
    logger.info(`[social] Facebook photo post created: ${data.post_id || data.id}`);
    return { platform: 'facebook', postId: data.post_id || data.id, success: true, imageUrl };
  }

  const body = { message, access_token: token };
  if (link) body.link = link;

  const res = await fetch(`https://graph.facebook.com/v25.0/${FACEBOOK_PAGE_ID}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook API ${res.status}: ${err}`);
  }
  const data = await res.json();
  logger.info(`[social] Facebook post created: ${data.id}`);
  return { platform: 'facebook', postId: data.id, success: true };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInstagramContainer(containerId, token) {
  let lastStatus = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await sleep(attempt === 0 ? 3000 : 5000);
    const statusRes = await fetch(
      `https://graph.facebook.com/v25.0/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`
    );
    const status = await statusRes.json().catch(() => ({}));
    if (!statusRes.ok) {
      throw new Error(`Instagram status ${statusRes.status}: ${JSON.stringify(status)}`);
    }
    lastStatus = status;
    if (status.status_code === 'FINISHED') return status;
    if (status.status_code === 'ERROR') {
      throw new Error(`Instagram media error: ${JSON.stringify(status)}`);
    }
  }
  throw new Error(`Instagram media not ready: ${JSON.stringify(lastStatus)}`);
}

async function postToInstagram(caption, imageUrl) {
  const token = process.env.FACEBOOK_ACCESS_TOKEN; // Instagram uses same token
  if (!token) throw new Error('FACEBOOK_ACCESS_TOKEN not configured');
  if (!imageUrl) throw new Error('Instagram requires an image URL');

  // Step 1: Create media container
  const containerRes = await fetch(
    `https://graph.facebook.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, caption, access_token: token }),
    }
  );
  if (!containerRes.ok) {
    const err = await containerRes.text();
    throw new Error(`Instagram container ${containerRes.status}: ${err}`);
  }
  const container = await containerRes.json();

  // Step 2: Wait for Meta to finish ingesting the image. Publishing
  // immediately often returns code 9007: "Media ID is not available".
  const containerStatus = await waitForInstagramContainer(container.id, token);

  // Step 3: Publish
  const publishRes = await fetch(
    `https://graph.facebook.com/v25.0/${INSTAGRAM_ACCOUNT_ID}/media_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: container.id, access_token: token }),
    }
  );
  if (!publishRes.ok) {
    const err = await publishRes.text();
    throw new Error(`Instagram publish ${publishRes.status}: ${err}`);
  }
  const data = await publishRes.json();
  logger.info(`[social] Instagram post published: ${data.id}`);
  return { platform: 'instagram', postId: data.id, success: true, mediaContainerId: container.id, mediaStatus: containerStatus.status_code };
}

async function postToLinkedIn(text, link, title, description, imageUrl) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) throw new Error('LINKEDIN_ACCESS_TOKEN not configured');

  const body = {
    author: `urn:li:organization:${LINKEDIN_COMPANY_ID}`,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: link ? 'ARTICLE' : 'NONE',
        media: link ? [{
          status: 'READY',
          originalUrl: link,
          title: { text: title || '' },
          description: { text: (description || '').substring(0, 200) },
        }] : [],
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LinkedIn API ${res.status}: ${err}`);
  }
  const headerId = res.headers.get('x-restli-id');
  let bodyId = null;
  try {
    const data = await res.json();
    bodyId = data?.id || null;
  } catch { /* empty body */ }
  const postId = headerId || bodyId;
  logger.info(`[social] LinkedIn post created: ${postId}`);
  return { platform: 'linkedin', postId, success: true };
}

async function postToGBP(locationId, summary, link, imageUrl) {
  const loc = WAVES_LOCATIONS.find(l => l.id === locationId);
  if (!loc?.googleLocationResourceName) throw new Error(`No GBP resource for ${locationId}`);

  try {
    const result = await gbpService.createPost(
      loc.googleLocationResourceName,
      {
        summary,
        callToAction: link ? { actionType: 'LEARN_MORE', url: link } : undefined,
        mediaUrl: imageUrl || undefined,
      },
      locationId
    );
    logger.info(`[social] GBP post created for ${loc.name}`);
    return { platform: 'gbp', location: locationId, success: true, postId: result.name };
  } catch (err) {
    logger.error(`[social] GBP post failed for ${loc.name}: ${err.message}`);
    return { platform: 'gbp', location: locationId, success: false, error: err.message };
  }
}

// ── RSS Feed Polling ──
async function fetchRSSFeed(feedUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(feedUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();

  // Simple XML parsing for RSS items
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const get = (tag) => {
      const m = itemXml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 's'));
      return m ? m[1].trim() : '';
    };
    items.push({
      title: get('title'),
      link: get('link'),
      description: get('description').replace(/<[^>]+>/g, '').substring(0, 500),
      pubDate: get('pubDate'),
      guid: get('guid') || get('link'),
    });
  }
  return items;
}

// ══════════════════════════════════════════════════════════════
// MAIN SERVICE
// ══════════════════════════════════════════════════════════════
const SocialMediaService = {
  /**
   * Check RSS feed for new posts and publish to all platforms.
   * Called by cron job or manually from admin.
   */
  async checkAndPublish(feedUrl = 'https://www.wavespestcontrol.com/feed.xml', { manual = false } = {}) {
    if (!manual) {
      if (!SOCIAL_FLAGS.automationEnabled || !SOCIAL_FLAGS.rssAutopublish) {
        logger.info('[social] RSS auto-publish skipped — automation or RSS flag disabled');
        return { processed: 0, results: [], skipped: true };
      }
      if (await isPausedByAdmin()) {
        logger.info('[social] RSS auto-publish skipped — paused by admin');
        return { processed: 0, results: [], skipped: true };
      }
    }

    const items = await fetchRSSFeed(feedUrl);
    if (!items.length) return { processed: 0, results: [] };

    // Advisory lock prevents overlapping cron runs / deploys from double-posting.
    // Uses transaction-scoped lock so acquire+release use the same connection.
    const results = [];
    let lockAcquired = false;

    await db.transaction(async (trx) => {
      try {
        const lockResult = await trx.raw(
          'SELECT pg_try_advisory_xact_lock(?) as locked', [RSS_LOCK_ID]
        );
        lockAcquired = lockResult.rows[0]?.locked;
      } catch (lockErr) { logger.warn(`[social] Advisory lock failed: ${lockErr.message} — skipping run`); }

      if (!lockAcquired) {
        logger.info('[social] RSS check skipped — another instance holds the lock');
        return;
      }

      for (const item of items.slice(0, 5)) {
        const normalizedUrl = normalizeUrl(item.link) || null;
        const normalizedGuid = item.guid || normalizedUrl;

        const existing = await trx('social_media_posts')
          .where(function() {
            this.where({ source_url: normalizedUrl })
              .orWhere({ source_guid: normalizedGuid });
          })
          .whereNot('status', 'dry_run')
          .first();

        if (existing) continue;

        try {
          const result = await this.publishToAll({
            title: item.title,
            description: item.description,
            link: normalizedUrl,
            guid: normalizedGuid,
            source: 'rss',
          });
          results.push({ item: item.title, ...result });
        } catch (err) {
          logger.error(`[social] Failed to process RSS item "${item.title}": ${err.message}`);
          results.push({ item: item.title, error: err.message });
        }
      }
    });

    if (!lockAcquired) return { processed: 0, results: [], locked: true };
    return { processed: results.length, results };
  },

  /**
   * Publish content to all configured platforms.
   */
  async publishToAll({ title, description, link, guid, source, imageUrl, customContent, channels, gbpLocationIds }) {
    if (!SOCIAL_FLAGS.automationEnabled) {
      return { success: false, platforms: [{ platform: 'all', skipped: 'Automation is disabled' }] };
    }
    if (await isPausedByAdmin()) {
      return { success: false, platforms: [{ platform: 'all', skipped: 'Automation is paused' }] };
    }

    const platformResults = [];
    const requestedPlatforms = normalizePublishChannels(channels);
    const requestedGbpLocations = normalizeGbpLocationIds(gbpLocationIds);

    // Only generate an AI image if a platform can actually consume it.
    // Both Instagram and GBP use generatedImageUrl, and both need the image
    // uploaded to S3/CDN first (they require a public URL). Instagram also
    // needs a Facebook token (Graph API); GBP does not — so a GBP-only run
    // (e.g. SOCIAL_GBP_ENABLED with no Facebook token) should still get an
    // image. Without S3 hosting + at least one consumer, generating would
    // spend image credits and discard the result.
    let generatedImageUrl = imageUrl || null;
    // SOCIAL_MEDIA_CDN_DOMAIN is required too: uploadImageToS3 returns null
    // without it (private S3 URLs aren't publicly fetchable), so generating
    // an image without a CDN just burns credits and discards the result.
    const hasImageHosting =
      !!config.s3.accessKeyId && !!config.s3.secretAccessKey && !!config.s3.bucket
      && !!process.env.SOCIAL_MEDIA_CDN_DOMAIN;
    // Only a REQUESTED channel can justify generating the image. A run that
    // didn't ask for an image-consuming channel (e.g. channels:['linkedin'],
    // or channels:['facebook'] when Instagram/GBP merely happen to be
    // configured globally) must NOT burn image credits on a result every
    // requested channel discards. Instagram requires the image; GBP attaches
    // it when present; Facebook reuses the shared image opportunistically but
    // never triggers generation on its own (text+link posts fine without one).
    const instagramCanConsume =
      requestedPlatforms.has('instagram')
      && SOCIAL_FLAGS.instagramEnabled && !!process.env.FACEBOOK_ACCESS_TOKEN && !!INSTAGRAM_ACCOUNT_ID;
    // Decide whether to generate the shared image. Skip on a dry run (nothing
    // posts, so it'd just burn credits) and when an image already exists or
    // hosting is unconfigured — establish that cheaply before any DB work.
    let shouldGenerateImage = false;
    if (!generatedImageUrl && !SOCIAL_FLAGS.dryRun && hasImageHosting) {
      // A requested platform must actually be able to consume the image.
      // Instagram is a sync env check. GBP needs a profile that can PUBLISH — a
      // usable client (client creds + a refresh token), NOT just
      // gbpService.configured, which is client-creds-only: a GBP deploy whose
      // admin OAuth connect never ran (no stored refresh token) would otherwise
      // generate/upload an image before every postToGBP fails with "No GBP
      // credentials". One image is shared across all WAVES_LOCATIONS GBP posts
      // below, so any one publish-ready profile justifies it. GBP is checked
      // lazily (only when Instagram can't already consume, and only when GBP was
      // requested) so the DB is touched only when warranted. (The autonomous
      // single-profile path uses a per-location check via
      // assertSocialPublishingReady.)
      shouldGenerateImage = instagramCanConsume
        || (requestedPlatforms.has('gbp') && SOCIAL_FLAGS.gbpEnabled && (await gbpService.getConfiguredLocations()).length > 0);
    }
    if (shouldGenerateImage) {
      try {
        const img = await generateImage(title);
        if (img && img.base64) {
          // Upload to S3 to get a public URL (required by Instagram)
          const filename = `post-${Date.now()}.jpg`;
          const s3Url = await uploadImageToS3(img.base64, filename);
          if (s3Url) {
            generatedImageUrl = s3Url;
          }
        }
      } catch { /* non-critical */ }
    }

    // Generate content for each platform and post
    const fbReady = !!process.env.FACEBOOK_ACCESS_TOKEN && !!FACEBOOK_PAGE_ID;
    const igReady = fbReady && !!INSTAGRAM_ACCOUNT_ID && !!generatedImageUrl;
    const platforms = [
      {
        key: 'facebook',
        enabled: SOCIAL_FLAGS.facebookEnabled && fbReady,
        reason: !SOCIAL_FLAGS.facebookEnabled ? 'Disabled'
          : !FACEBOOK_PAGE_ID ? 'FACEBOOK_PAGE_ID not set'
          : 'FACEBOOK_ACCESS_TOKEN not set',
      },
      {
        key: 'instagram',
        enabled: SOCIAL_FLAGS.instagramEnabled && igReady,
        reason: !SOCIAL_FLAGS.instagramEnabled ? 'Disabled'
          : !process.env.FACEBOOK_ACCESS_TOKEN ? 'FACEBOOK_ACCESS_TOKEN not set'
          : !INSTAGRAM_ACCOUNT_ID ? 'INSTAGRAM_ACCOUNT_ID not set'
          : 'Image hosting not configured',
      },
      {
        key: 'linkedin',
        enabled: false,
        reason: 'Disabled',
      },
    ].filter((platform) => requestedPlatforms.has(platform.key));

    for (const p of platforms) {
      if (!p.enabled) {
        platformResults.push({ platform: p.key, skipped: p.reason });
        continue;
      }

      try {
        const content = customContent?.[p.key] || await generateContent(p.key, { title, description, link });

        const validation = validateContent(content, p.key);
        if (!validation.valid) {
          logger.warn(`[social] Content validation failed for ${p.key}: ${validation.issues.join('; ')}`);
          platformResults.push({ platform: p.key, success: false, error: `Validation: ${validation.issues[0]}`, validationIssues: validation.issues });
          continue;
        }

        if (SOCIAL_FLAGS.dryRun) {
          logger.info(`[social] DRY RUN — ${p.key}: ${content.substring(0, 120)}...`);
          platformResults.push({ platform: p.key, success: false, dryRun: true, content });
          continue;
        }

        if (p.key === 'facebook') {
          const r = await withRetry(() => postToFacebook(content, link, generatedImageUrl), { label: 'facebook' });
          platformResults.push({ ...r, content });
        } else if (p.key === 'instagram') {
          const imgUrl = typeof generatedImageUrl === 'string' ? generatedImageUrl : null;
          if (imgUrl) {
            const r = await withRetry(() => postToInstagram(content, imgUrl), { label: 'instagram' });
            platformResults.push({ ...r, content });
          } else {
            platformResults.push({ platform: 'instagram', skipped: 'No public image URL' });
          }
        }
      } catch (err) {
        logger.error(`[social] ${p.key} post failed: ${err.message}`);
        platformResults.push({ platform: p.key, success: false, error: err.message });
      }
    }

    // Post to all 4 GBP locations
    if (requestedPlatforms.has('gbp') && !SOCIAL_FLAGS.gbpEnabled) {
      platformResults.push({ platform: 'gbp', skipped: 'Disabled' });
    }
    // customContent.gbp may be a string (same copy for all locations) or an object keyed by location id
    const gbpLocations = requestedPlatforms.has('gbp') && SOCIAL_FLAGS.gbpEnabled
      ? WAVES_LOCATIONS.filter((loc) => !requestedGbpLocations || requestedGbpLocations.has(loc.id))
      : [];
    for (const loc of gbpLocations) {
      try {
        const gbpCustom = customContent?.gbp;
        const gbpContent =
          (typeof gbpCustom === 'string' ? gbpCustom : gbpCustom?.[loc.id]) ||
          await generateContent('gbp', { title, description, link, locationName: loc.name });

        const gbpValidation = validateContent(gbpContent, 'gbp');
        if (!gbpValidation.valid) {
          logger.warn(`[social] GBP content validation failed for ${loc.name}: ${gbpValidation.issues.join('; ')}`);
          platformResults.push({ platform: 'gbp', location: loc.id, success: false, error: `Validation: ${gbpValidation.issues[0]}` });
          continue;
        }

        if (SOCIAL_FLAGS.dryRun) {
          logger.info(`[social] DRY RUN — gbp/${loc.name}: ${gbpContent.substring(0, 120)}...`);
          platformResults.push({ platform: 'gbp', location: loc.id, success: false, dryRun: true, content: gbpContent });
          continue;
        }

        // Reuse the image already generated + uploaded to the CDN for this
        // run (see generatedImageUrl above) so GBP posts carry a photo too —
        // a GBP local post without media renders as a flat text card and its
        // "Learn more" CTA is easy to miss. Same public URL Instagram uses.
        const gbpImageUrl = typeof generatedImageUrl === 'string' ? generatedImageUrl : null;
        let r = await postToGBP(loc.id, gbpContent, link, gbpImageUrl);
        // Media is best-effort: if Google rejects or can't fetch the image,
        // retry text-only so an image problem doesn't block a post that would
        // otherwise have succeeded. Other failures (auth/quota) skip the retry.
        if (!r.success && gbpImageUrl && isGbpMediaError(r.error)) {
          logger.warn(`[social] GBP post with image failed for ${loc.name} (${r.error}); retrying text-only`);
          r = await postToGBP(loc.id, gbpContent, link, null);
        }
        platformResults.push({ ...r, content: gbpContent });
      } catch (err) {
        platformResults.push({ platform: 'gbp', location: loc.id, success: false, error: err.message });
      }
    }

    // Log to database
    // Collect published content for audit trail
    const publishedContent = {};
    for (const r of platformResults) {
      if (r.content) {
        const key = r.location ? `${r.platform}_${r.location}` : r.platform;
        publishedContent[key] = r.content;
      }
    }

    const normalizedLink = normalizeUrl(link);
    const postStatus = SOCIAL_FLAGS.dryRun ? 'dry_run'
      : platformResults.some(r => r.success) ? 'published' : 'failed';

    const postRow = {
      title,
      description: (description || '').substring(0, 1000),
      source_url: normalizedLink,
      source_guid: guid,
      source_type: source || 'manual',
      platforms_posted: JSON.stringify(platformResults),
      image_url: typeof generatedImageUrl === 'string' ? generatedImageUrl : null,
      status: postStatus,
      ai_model: MODELS.FLAGSHIP,
      published_content: Object.keys(publishedContent).length > 0
        ? JSON.stringify(publishedContent) : null,
    };
    const updateCols = { platforms_posted: postRow.platforms_posted, status: postRow.status, published_content: postRow.published_content };

    const autoSources = ['rss', 'blog_scheduled', 'newsletter'];
    const isAutoSource = autoSources.includes(postRow.source_type);

    try {
      if (isAutoSource) {
        const existingByUrl = normalizedLink
          ? await db('social_media_posts').where('source_url', normalizedLink).whereIn('source_type', autoSources).first()
          : null;
        const existingByGuid = !existingByUrl && guid
          ? await db('social_media_posts').where('source_guid', guid).whereIn('source_type', autoSources).first()
          : null;
        const existing = existingByUrl || existingByGuid;

        if (existing) {
          await db('social_media_posts').where('id', existing.id).update(updateCols);
        } else {
          await db('social_media_posts').insert(postRow);
        }
      } else {
        await db('social_media_posts').insert(postRow);
      }
    } catch (err) {
      logger.error(`[social] Failed to log post: ${err.message}`);
    }

    // Recompute failure alert state on every publish (raise on failure, clear on success)
    checkAndRaiseAlert().catch(() => {});

    return {
      success: platformResults.some(r => r.success),
      dryRun: SOCIAL_FLAGS.dryRun,
      platforms: platformResults,
    };
  },

  /**
   * Post to a single platform (from admin UI).
   */
  async postToSingle(platform, { title, description, link, content, imageUrl, locationId }) {
    if (!SOCIAL_FLAGS.automationEnabled) {
      return { platform, success: false, error: 'Automation is disabled' };
    }
    if (await isPausedByAdmin()) {
      return { platform, success: false, error: 'Automation is paused' };
    }
    const flagMap = { facebook: 'facebookEnabled', instagram: 'instagramEnabled', gbp: 'gbpEnabled' };
    const flagKey = flagMap[platform];
    if (flagKey && !SOCIAL_FLAGS[flagKey]) {
      return { platform, success: false, error: `${platform} is disabled` };
    }
    if (platform === 'linkedin') {
      return { platform, success: false, error: 'LinkedIn is disabled' };
    }

    const text = content || await generateContent(platform, { title, description, link, locationName: locationId });

    const validation = validateContent(text, platform);
    if (!validation.valid) {
      return { platform, success: false, error: `Validation: ${validation.issues[0]}`, validationIssues: validation.issues };
    }

    if (SOCIAL_FLAGS.dryRun) {
      logger.info(`[social] DRY RUN — postToSingle/${platform}: ${text.substring(0, 120)}...`);
      return { platform, success: false, dryRun: true, content: text };
    }

    if (platform === 'facebook') return postToFacebook(text, link);
    if (platform === 'instagram') return postToInstagram(text, imageUrl);
    if (platform === 'gbp') return postToGBP(locationId || 'bradenton', text, link, imageUrl);
    throw new Error(`Unknown platform: ${platform}`);
  },

  /**
   * Get post history.
   */
  async getHistory({ limit = 50, offset = 0, status } = {}) {
    let query = db('social_media_posts').orderBy('created_at', 'desc');
    if (status) query = query.where({ status });
    return query.limit(limit).offset(offset);
  },

  /**
   * Generate AI content preview (for admin UI).
   */
  async previewContent({ title, description, link }) {
    const [facebook, instagram, linkedin, gbp] = await Promise.all([
      generateContent('facebook', { title, description, link }),
      generateContent('instagram', { title, description, link }),
      generateContent('linkedin', { title, description, link }),
      generateContent('gbp', { title, description, link, locationName: 'Lakewood Ranch' }),
    ]);
    return { facebook, instagram, linkedin, gbp };
  },

  /**
   * Fetch recent RSS items (for admin preview).
   */
  async getRSSItems(feedUrl = 'https://www.wavespestcontrol.com/feed.xml') {
    return fetchRSSFeed(feedUrl);
  },

  // Expose for direct use
  generateContent,
  generateImage,
};

module.exports = SocialMediaService;
module.exports.SOCIAL_FLAGS = SOCIAL_FLAGS;
module.exports.isPausedByAdmin = isPausedByAdmin;
module.exports.assertSocialPublishingReady = assertSocialPublishingReady;
module.exports.validateContent = validateContent;
module.exports.normalizeUrl = normalizeUrl;
module.exports.uploadImageToS3 = uploadImageToS3;
module.exports.postToGBP = postToGBP;
module.exports.isGbpMediaError = isGbpMediaError;
module.exports.checkAndRaiseAlert = checkAndRaiseAlert;
module.exports.buildSocialFailureAlert = buildSocialFailureAlert;
