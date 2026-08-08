const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { noStore } = require('../middleware/no-store');

// Token-keyed review pages carry the customer's name and service history —
// keep them out of caches and search indexes.
router.use(noStore);
const { WAVES_LOCATIONS, nearestLocation } = require('../config/locations');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('../services/llm/call');

// Nearest GBP to the customer's geocoded address, with fallbacks. Prefers the
// haversine winner when the customer has a lat/lng; otherwise falls back to
// whatever location the review request was tagged with at creation time
// (review-request.js already city-routes on create).
function resolveReviewLocation(request, customer) {
  if (customer && customer.latitude != null && customer.longitude != null) {
    const hit = nearestLocation(customer.latitude, customer.longitude);
    if (hit) return hit;
  }
  if (request && request.location_id) {
    const byId = WAVES_LOCATIONS.find((l) => l.id === request.location_id);
    if (byId) return byId;
  }
  return WAVES_LOCATIONS[0];
}

// Admin alert recipient — must be a real cell, never one of our own Twilio
// numbers (an SMS from the HQ line to itself fails with Twilio error 21266).
const ADMIN_ALERT_PHONE = process.env.ADAM_PHONE || '+19415993489';

function categorizeScore(score) {
  if (score >= 8) return 'promoter';
  if (score >= 4) return 'passive';
  return 'detractor';
}

// Direct-link redirects are cheap and unauthenticated — cap per IP so the
// token space can't be probed at volume. Over-limit requests are REDIRECTED
// to the rate page rather than 429'd (Codex P2, r1): customers behind a
// shared carrier/NAT IP — or following a batch a scanner just burned through
// — must still land somewhere that works. The redirect handler does no DB
// work, so the probing protection (no token-existence oracle) holds.
const directLinkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.redirect(302, `/rate/${encodeURIComponent(String(req.params?.token || ''))}`),
});
const { isBotUserAgent } = require('../utils/bot-ua');

// Live review_requests tokens are 32-64 char url-safe (prod-verified
// 2026-08-07, all 68 rows incl. one legacy 32-char). Malformed tokens get
// the same generic 404 as unknown ones, before any DB lookup. Applies to
// every /:token route on this router.
const REVIEW_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
router.param('token', (req, res, next, token) => {
  if (REVIEW_TOKEN_RE.test(String(token))) return next();
  // /go's contract is that EVERY failure path degrades to the rate page
  // (which renders a friendly not-found state) — keep that for malformed
  // tokens too; everything else gets the same generic 404 as unknown.
  if (req.path.endsWith('/go')) return res.redirect(302, `/rate/${encodeURIComponent(String(token))}`);
  return res.status(404).json({ error: 'Review link not found or expired' });
});

// The page GET and the score/submit writes had no per-route limiter
// (security review 2026-08-07) — same probing exposure as /go, but these
// DO touch the DB per hit. 30/min per IP matches directLinkLimiter.
const reviewPageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require('../middleware/rate-limit-key').rateLimitKey,
  message: { error: 'Too many requests — please slow down.' },
});

// GET /api/rate/:token/go — tracked redirect straight to the Google review
// form (GATE_REVIEW_DIRECT_LINK rollout; the SMS/email {review_url} resolves
// here via a /l/ short link). Stamps the open + click on the review_requests
// row, stops the customer's active cadence (they acted — no Day-3/4 chasers),
// bells the owner so an unmatched review can be manually attributed, and 302s
// to the location's GBP review URL. Every failure path degrades to the /rate
// page, which already renders not-found/expired states.
router.get('/:token/go', directLinkLimiter, async (req, res) => {
  const token = String(req.params.token || '');
  const ratePageFallback = `/rate/${encodeURIComponent(token)}`;
  try {
    // Kill switch must govern ALREADY-DELIVERED links too (Codex P1, r2):
    // with the gate off, /go behaves as a plain alias of the rate page — no
    // click stamping, no cadence stop, no Google redirect — so unsetting
    // GATE_REVIEW_DIRECT_LINK rolls the whole direct flow back even for
    // links sitting in old texts.
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('reviewDirectLink')) return res.redirect(302, ratePageFallback);
    if (!/^[a-f0-9]{64}$/.test(token)) return res.redirect(302, ratePageFallback);
    const request = await db('review_requests').where({ token }).first();
    if (!request) return res.redirect(302, ratePageFallback);
    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      // Expired-but-real link (review audit 2026-08-07): a willing reviewer
      // clicking a weeks-old text used to dead-end on the rate page's
      // "link expired" state. Send them on to the location's Google review
      // form anyway — but stamp NOTHING (no click credit, no cadence stop,
      // no owner bell): the request is past its attribution window, and an
      // expired token must not keep working as a tracked link.
      try {
        const expiredCustomer = await db('customers').where({ id: request.customer_id }).first();
        const expiredLoc = resolveReviewLocation(request, expiredCustomer);
        if (expiredLoc?.googleReviewUrl) return res.redirect(302, expiredLoc.googleReviewUrl);
      } catch (err) {
        logger.warn(`[review-gate] expired-link GBP resolve failed — rate-page fallback: ${err.message}`);
      }
      return res.redirect(302, ratePageFallback);
    }

    const customer = await db('customers').where({ id: request.customer_id }).first();
    const loc = resolveReviewLocation(request, customer);
    if (!loc || !loc.googleReviewUrl) return res.redirect(302, ratePageFallback);

    // Scanner/preview fetches (iMessage unfurlers, carrier link scanners,
    // Slack/WhatsApp previews) follow SMS links without a human tap. Issue
    // the 302 so the link keeps working, but record NOTHING — a scanned
    // Day-0 link must not stamp a click, stop the cadence, or bell the
    // owner (Codex P1, r1; same contract as public-shortlinks.js).
    if (isBotUserAgent(req.headers['user-agent'])) {
      return res.redirect(302, loc.googleReviewUrl);
    }

    // The route contract: a customer only reaches Google AFTER the click is
    // recorded and their cadence is stopped. If any required write fails
    // (transient Postgres outage), fall back to the rate page instead of
    // proceeding — otherwise the still-active sequence would keep chasing a
    // customer who already reached the review form (Codex P2, r3).
    // Ordering (Codex P2, r4): the base stamp (SQL-side counter, no stale
    // read) and the cadence stop both land BEFORE the first-click claim, and
    // the claim itself is a conditional UPDATE ... WHERE redirected_at IS
    // NULL — so overlapping requests can't double-notify or lose an
    // open_count increment, and a stamp-ok/stop-failed request leaves the
    // claim unconsumed for the retry to notify on.
    try {
      const updates = {
        open_count: db.raw('COALESCE(open_count, 0) + 1'),
        google_review_clicked: true,
        redirected_to_google: true,
        google_location: loc.id,
      };
      if (!request.opened_at) {
        updates.opened_at = new Date();
        if (request.status === 'sent') updates.status = 'opened';
      }
      await db('review_requests').where({ id: request.id }).update(updates);
    } catch (err) {
      logger.warn(`[review-gate] direct-link click stamp failed — rate-page fallback: ${err.message}`);
      return res.redirect(302, ratePageFallback);
    }

    // They acted on the ask — stop the cadence so no further touches chase
    // a customer who already visited the review form. A one-off/legacy link
    // has no sequence_id, but the CUSTOMER may still have an active cadence
    // (older unexpired link clicked mid-cadence) — stop that one too
    // (Codex P2, r1).
    try {
      const ReviewService = require('../services/review-request');
      if (request.sequence_id) {
        await ReviewService.stopReviewSequence(request.sequence_id, 'clicked');
      } else {
        const activeSeq = await db('review_sequences')
          .where({ customer_id: request.customer_id, status: 'active' })
          .first();
        if (activeSeq) await ReviewService.stopReviewSequence(activeSeq.id, 'clicked');
      }
    } catch (err) {
      logger.warn(`[review-gate] cadence stop on click failed — rate-page fallback: ${err.message}`);
      return res.redirect(302, ratePageFallback);
    }

    // Atomic first-click claim: only the request that flips redirected_at
    // from NULL owns the owner notification.
    let firstClick = false;
    try {
      const claimed = await db('review_requests')
        .where({ id: request.id })
        .whereNull('redirected_at')
        .update({ redirected_at: new Date() });
      firstClick = claimed > 0;
    } catch (err) {
      logger.warn(`[review-gate] first-click claim failed — rate-page fallback: ${err.message}`);
      return res.redirect(302, ratePageFallback);
    }

    // Owner bell (first click only): Google won't tell us who reviewed, so
    // Adam checks the GBP and flips "Left Google review" on the profile when
    // it lands. Best-effort — never blocks the redirect.
    if (firstClick && customer) {
      try {
        const NotificationService = require('../services/notification-service');
        const name = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'A customer';
        await NotificationService.notifyAdmin(
          'review',
          'Review link clicked',
          `${name} clicked through to the ${loc.name} Google review form. If their review shows up (any reviewer name), mark "Left Google review" on their profile so review asks stop.`,
          {
            link: `/admin/customers?customerId=${customer.id}`,
            metadata: {
              reviewRequestId: request.id,
              customerId: customer.id,
              locationId: loc.id,
              sequenceId: request.sequence_id || null,
            },
          },
        );
      } catch (err) {
        logger.warn(`[review-gate] click notification failed: ${err.message}`);
      }
    }

    return res.redirect(302, loc.googleReviewUrl);
  } catch (err) {
    logger.error(`[review-gate] direct-link redirect failed: ${err.message}`);
    return res.redirect(302, ratePageFallback);
  }
});

// GET /api/rate/:token — public page data for the review funnel
router.get('/:token', reviewPageLimiter, async (req, res, next) => {
  try {
    const request = await db('review_requests')
      .where({ token: req.params.token })
      .first();

    if (!request) {
      return res.status(404).json({ error: 'Review link not found or expired' });
    }

    // Check expiry
    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This review link has expired' });
    }

    // Stamp the first open so the Review Outreach funnel's open-rate reflects
    // real link engagement, not just final submissions. Non-blocking.
    try {
      const updates = { open_count: (request.open_count || 0) + 1 };
      if (!request.opened_at) {
        updates.opened_at = new Date();
        if (request.status === 'sent') updates.status = 'opened';
      }
      await db('review_requests').where({ id: request.id }).update(updates);
    } catch (err) {
      logger.warn(`[review-gate] open stamp failed: ${err.message}`);
    }

    // Already submitted. `rated_at` also covers completed legacy /review
    // submissions (review-public.js) that now land here via redirect — those
    // mark completion with rated_at + status rated/reviewed rather than
    // 'submitted', so honor them too or a finished customer would see a fresh,
    // overwritable rating flow instead of the thank-you state.
    if (request.status === 'submitted' || request.rated_at) {
      return res.status(200).json({ alreadySubmitted: true, message: 'You already submitted feedback — thank you!' });
    }

    // Look up customer name — prefer the beneficiary (service contact) when
    // set so the review page greets the right person. Closest-GBP routing
    // uses the customer's geocoded lat/lng (spec ask: "paired with the
    // closest Google Business Profile"), falling back to the location tagged
    // at request creation.
    const customer = await db('customers').where({ id: request.customer_id }).first();
    const { getServiceContact } = require('../services/customer-contact');
    const contact = getServiceContact(customer);
    const loc = resolveReviewLocation(request, customer);

    // Tech avatar: presign photo_s3_key (canonical) inside this trusted
    // token-scoped boundary; fall back to photo_url for techs whose
    // photo lives at an external URL (e.g., GBP). Same pattern as
    // track-public.js.
    let techPhotoUrl = null;
    if (request.technician_id) {
      try {
        const tech = await db('technicians')
          .where({ id: request.technician_id })
          .first('photo_s3_key', 'photo_url');
        if (tech) {
          const { resolveTechPhotoUrl } = require('../services/tech-photo');
          // Customer-dwell TTL: rate pages sit open for hours (the
          // tech-photo helper's own docs sanction longer TTLs here).
          const { CUSTOMER_DWELL_TTL_SECONDS } = require('../services/photos');
          techPhotoUrl = await resolveTechPhotoUrl(tech.photo_s3_key, tech.photo_url, CUSTOMER_DWELL_TTL_SECONDS);
        }
      } catch (err) {
        logger.warn(`[review-gate] tech photo resolve failed: ${err.message}`);
      }
    }

    res.json({
      firstName: contact.name || customer?.first_name || 'there',
      techName: request.tech_name || 'your technician',
      techPhotoUrl,
      serviceType: request.service_type || 'pest control service',
      hasServiceType: Boolean(request.service_type),
      serviceDate: request.service_date,
      locationName: loc.name,
      googleReviewUrl: loc.googleReviewUrl,
    });
  } catch (err) { next(err); }
});

// POST /api/rate/:token/score — persist score taps without final submission.
// This protects bounce cases while leaving the customer free to correct their
// score before committing to feedback or the Google-review path. The request
// status is intentionally left alone so reminder and low-score workflows still
// run only from the final /submit path.
router.post('/:token/score', reviewPageLimiter, async (req, res, next) => {
  try {
    const { score, highlights } = req.body;

    if (!score || score < 1 || score > 10) {
      return res.status(400).json({ error: 'Score must be between 1 and 10' });
    }

    const request = await db('review_requests')
      .where({ token: req.params.token })
      .first();

    if (!request) {
      return res.status(404).json({ error: 'Review link not found' });
    }

    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This review link has expired' });
    }

    if (['submitted', 'reviewed'].includes(request.status) || request.rated_at) {
      return res.status(409).json({ error: 'Feedback already submitted' });
    }

    const category = categorizeScore(score);
    await db('review_requests')
      .where({ id: request.id })
      .whereNotIn('status', ['submitted', 'reviewed'])
      .update({
        score,
        highlights: highlights ? JSON.stringify(highlights) : null,
        category,
      });

    res.json({ saved: true, category });
  } catch (err) { next(err); }
});

// POST /api/rate/:token/submit — submit NPS score + feedback
router.post('/:token/submit', reviewPageLimiter, async (req, res, next) => {
  try {
    const { score, feedback, highlights } = req.body;

    if (!score || score < 1 || score > 10) {
      return res.status(400).json({ error: 'Score must be between 1 and 10' });
    }

    const request = await db('review_requests')
      .where({ token: req.params.token })
      .first();

    if (!request) {
      return res.status(404).json({ error: 'Review link not found' });
    }

    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This review link has expired' });
    }

    if (request.rated_at || ['submitted', 'reviewed', 'rated'].includes(request.status)) {
      return res.status(409).json({ error: 'Feedback already submitted' });
    }

    // Categorize by NPS score
    const category = categorizeScore(score);

    // Update the review request record. Atomic claim (NULL-safe status
    // check): a concurrent double-submit must not double-fire the
    // referral/activity side effects below. rated_at is stamped too — it is
    // the LEGACY endpoint's finality marker, and without it a request
    // submitted here stayed replayable through /api/review/:token.
    const claimed = await db('review_requests')
      .where({ id: request.id })
      .whereNull('rated_at')
      .where(function notFinal() {
        this.whereNull('status').orWhereNotIn('status', ['submitted', 'reviewed', 'rated']);
      })
      .update({
        score,
        feedback: feedback || null,
        highlights: highlights ? JSON.stringify(highlights) : null,
        category,
        status: 'submitted',
        submitted_at: db.fn.now(),
        rated_at: db.fn.now(),
      });
    if (!claimed) {
      return res.status(409).json({ error: 'Feedback already submitted' });
    }

    // If this came from a multi-touch cadence, stop it now — the customer has
    // engaged, so no further Day-3/7 review asks should go out. (The cadence
    // runner also re-checks this before each send; this just stops it sooner.)
    if (request.sequence_id) {
      try {
        await require('../services/review-request').stopReviewSequence(request.sequence_id, 'responded');
      } catch (err) {
        logger.warn(`[review-gate] cadence stop-on-submit failed: ${err.message}`);
      }
    }

    // Create activity log entry
    await db('activity_log').insert({
      customer_id: request.customer_id,
      action: 'review_submitted',
      description: `NPS ${score}/10 (${category}) — ${request.service_type || 'service'} at ${request.location_id}`,
      metadata: JSON.stringify({ score, category, feedback: (feedback || '').slice(0, 200), highlights }),
    });

    // Look up location for Google review URL — closest-GBP by customer
    // geocode, fallback to the request's tagged location.
    const customerForLoc = await db('customers').where({ id: request.customer_id }).first();
    const loc = resolveReviewLocation(request, customerForLoc);

    // Referral invite email on the warmest moment we have (owner trigger
    // call 2026-07-06) — same hook and same >=7 bar as the legacy
    // /api/review submit path (a 7 is 'passive' here but still
    // invite-grade). Fire-and-forget; the helper's customer-scoped
    // idempotency key keeps repeat submitters from being re-invited.
    if (score >= 7 && request.customer_id) {
      try {
        const { sendReferralInviteEmail } = require('../services/referral-invite-email');
        void sendReferralInviteEmail({ customerId: request.customer_id, trigger: 'positive_review' });
      } catch (err) {
        logger.error(`[review-gate] referral invite failed: ${err.message}`);
      }
    }

    // Handle by category
    if (category === 'promoter') {
      // Score 8-10: redirect to Google review

      // Fire-and-forget: trigger referral nudge workflow
      try {
        const referralNudge = require('../services/workflows/referral-nudge');
        if (referralNudge.triggerAfterPositiveReview) {
          referralNudge.triggerAfterPositiveReview(request.customer_id, score).catch(err =>
            logger.error(`[review-gate] Referral nudge failed: ${err.message}`)
          );
        }
      } catch (err) {
        logger.error(`[review-gate] Referral nudge require failed: ${err.message}`);
      }

      // Fire-and-forget: update customer health score
      try {
        const customerHealth = require('../services/customer-health');
        if (customerHealth.scoreCustomer) {
          customerHealth.scoreCustomer(request.customer_id).catch(err =>
            logger.error(`[review-gate] Health score update failed: ${err.message}`)
          );
        }
      } catch (err) {
        logger.error(`[review-gate] Customer health require failed: ${err.message}`);
      }

      return res.json({
        category: 'promoter',
        redirect: loc.googleReviewUrl,
        message: 'Thank you! We\'d love if you could share that on Google too.',
      });
    }

    if (category === 'passive') {
      // Score 4-7: thank them, save feedback
      return res.json({
        category: 'passive',
        message: 'Thank you for your feedback! We\'re always working to improve.',
      });
    }

    // Detractor (1-3): alert admin via SMS
    try {
      const customer = await db('customers').where({ id: request.customer_id }).first();
      const customerName = customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown';

      const TwilioService = require('../services/twilio');
      await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
        `⚠️ Low NPS alert: ${customerName} rated ${score}/10 for ${request.service_type || 'service'} (${loc.name}).\n\nFeedback: "${(feedback || 'No comment').slice(0, 150)}"\n\nFollow up ASAP.`,
        { messageType: 'internal_alert' }
      );
    } catch (smsErr) {
      logger.error(`Detractor SMS alert failed: ${smsErr.message}`);
    }

    // Fire-and-forget: create health alert for detractor
    try {
      const healthAlerts = require('../services/health-alerts');
      if (healthAlerts.generateAlerts) {
        healthAlerts.generateAlerts(request.customer_id, {
          overall: 0,
          satisfaction: 0,
          satisfactionDetails: { avgRating: score / 2 },
          churnRisk: 'high',
          churnSignals: [{ signal: 'low_nps', severity: 'high', message: `NPS score ${score}/10 (detractor)` }],
          grade: 'F',
        }).catch(err => logger.error(`[review-gate] Health alert failed: ${err.message}`));
      }
    } catch (err) {
      logger.error(`[review-gate] Health alerts require failed: ${err.message}`);
    }

    // Fire-and-forget: update customer health score for detractor
    try {
      const customerHealth = require('../services/customer-health');
      if (customerHealth.scoreCustomer) {
        customerHealth.scoreCustomer(request.customer_id).catch(err =>
          logger.error(`[review-gate] Detractor health score update failed: ${err.message}`)
        );
      }
    } catch (err) {
      logger.error(`[review-gate] Customer health require failed: ${err.message}`);
    }

    return res.json({
      category: 'detractor',
      message: 'Thank you for letting us know. A manager will reach out to make things right.',
    });
  } catch (err) { next(err); }
});

// POST /api/rate/:token/generate-review — AI-powered review writer
// Caps for AI prompt inputs — prevent prompt-injection / runaway prompt size.
const MAX_LIST_ITEMS = 12;
const MAX_LIST_ITEM_CHARS = 60;
const MAX_PERSONAL_NOTE_CHARS = 500;

const sanitizeList = (arr) => {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((v) => typeof v === 'string')
    .slice(0, MAX_LIST_ITEMS)
    .map((v) => v.trim().slice(0, MAX_LIST_ITEM_CHARS))
    .filter(Boolean);
};

// Review generation is a paid model call with no other spend control — a
// promoter legitimately regenerates a handful of times, not dozens.
const generateReviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many drafts — give it a minute and try again.' },
});
const generateReviewDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many drafts today — please try again tomorrow.' },
});

router.post('/:token/generate-review', generateReviewLimiter, generateReviewDailyLimiter, async (req, res, next) => {
  try {
    const { services, highlights, personalNote } = req.body;

    const request = await db('review_requests')
      .where({ token: req.params.token })
      .first();

    if (!request) {
      return res.status(404).json({ error: 'Review link not found' });
    }

    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This review link has expired' });
    }

    // Review writer is the promoter branch only — the client submits the NPS
    // score first and only then calls this endpoint, so a missing score means
    // the request is hitting us out of the intended order.
    if (request.score == null) {
      return res.status(400).json({ error: 'Submit your rating before generating a review' });
    }
    if (request.score < 8) {
      return res.status(403).json({ error: 'Review writer is available for high-rating responses only' });
    }

    const customer = await db('customers').where({ id: request.customer_id }).first();
    const firstName = customer?.first_name || 'there';

    const safeServices = sanitizeList(services);
    const safeHighlights = sanitizeList(highlights);
    const safePersonalNote = (typeof personalNote === 'string' ? personalNote : '')
      .trim()
      .slice(0, MAX_PERSONAL_NOTE_CHARS);

    // Build the prompt
    const serviceList = safeServices.length > 0
      ? safeServices.join(', ')
      : (request.service_type || 'pest control');

    const highlightList = safeHighlights.length > 0
      ? safeHighlights.join(', ')
      : '';

    const personalDetail = safePersonalNote;

    // Vary opening style so Google's dup-detection doesn't flag a pattern
    // of "Adam was…" across every generated review. One is sampled per call.
    const OPENING_STYLES = [
      'start mid-thought, as if the customer is finishing a conversation',
      'lead with the specific result they got',
      'lead with the technician\'s behavior',
      'lead with a short reaction word (e.g. "Really happy", "Super impressed", "Honestly great")',
      'lead with how the experience compared to expectations',
      'lead with the service type',
    ];
    const style = OPENING_STYLES[Math.floor(Math.random() * OPENING_STYLES.length)];

    const prompt = `Write a genuine Google review for Waves Pest Control (Southwest Florida) from the customer's perspective. Sound like a real SWFL homeowner wrote it on their phone — casual, short, specific.

Context:
- Customer first name: ${firstName}
- Services received: ${serviceList}
${highlightList ? `- What stood out: ${highlightList}` : ''}
${personalDetail ? `- Customer's own words: "${personalDetail}"` : ''}
${request.tech_name ? `- Technician: ${request.tech_name}` : ''}

Opening style for this review: ${style}

Rules:
- 2 to 4 sentences. Vary the length between reviews — sometimes tight, sometimes chattier.
- No emojis, no hashtags, no star ratings.
- Do NOT start with "I", "My", "We", or the technician's name.
- At most one exclamation mark in the whole review; preferably zero.
- Weave in at least one specific trait or detail; avoid generic filler like "great service" or "highly recommend".
- Don't say "Waves Pest Control" more than once; never use "WPC" or other abbreviations.
- No marketing phrases like "5 stars" or "best company ever".

Return ONLY the review body. No quotes, no preamble, no sign-off.`;

    // VOICE-tier customer-voice copy — a warm natural voice beats raw
    // reasoning for a real Google review — with cross-provider failover;
    // deterministic template last.
    let reviewText = '';
    try {
      const result = await dispatchWithFallback(MODELS.TEXT_POLICIES.customerCopy, {
        text: prompt,
        jsonMode: false,
        maxTokens: 256,
      });
      if (!result.ok) throw new Error('both AI providers unavailable');
      reviewText = result.text?.trim() || '';
      // Strip accidental quotes or "Review:" preambles
      reviewText = reviewText.replace(/^["']+|["']+$/g, '').replace(/^(Review|My review):\s*/i, '').trim();
    } catch (aiErr) {
      logger.error(`[review-gate] AI review generation failed: ${aiErr.message}`);
      // Fallback: generate a simple template
      const parts = [];
      if (highlightList) parts.push(`They were ${highlightList.toLowerCase()}`);
      if (request.tech_name) parts.push(`${request.tech_name} did a great job`);
      parts.push(`Really happy with the ${serviceList.toLowerCase()} service from Waves Pest Control`);
      if (personalDetail) parts.push(personalDetail);
      parts.push('Would definitely recommend them to anyone in Southwest Florida.');
      reviewText = parts.join('. ') + (parts[parts.length - 1].endsWith('.') ? '' : '.');
    }

    // Persist so we can audit variation + iterate the prompt. Soft-fail:
    // if the column isn't present yet (pre-migration env) the API still
    // returns the draft.
    try {
      await db('review_requests').where({ id: request.id }).update({
        generated_review_text: reviewText.slice(0, 2000),
        generated_at: db.fn.now(),
      });
    } catch (persistErr) {
      logger.warn(`[review-gate] generated_review_text persist skipped: ${persistErr.message}`);
    }

    res.json({ review: reviewText });
  } catch (err) { next(err); }
});

module.exports = router;
