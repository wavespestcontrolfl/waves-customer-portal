const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { noStore } = require('../middleware/no-store');

// Token-keyed review pages carry the customer's name and service history —
// keep them out of caches and search indexes.
router.use(noStore);
const { resolveReviewLocation: resolveReviewLocationCanonical } = require('../config/locations');

// The GBP profile this ask points at. Delegates to the ONE review-routing
// resolver in config/locations.js (city → zip → nearest office → the id stored
// on the ask). This used to run nearest-office FIRST, which sent downtown
// Sarasota (34236) to the Bradenton profile — the Sarasota office is in 34240,
// farther from downtown than Bradenton is.
function resolveReviewLocation(request, customer) {
  return resolveReviewLocationCanonical(customer || {}, {
    storedLocationId: request?.location_id || null,
  });
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
  // Absolute portal origin, same as the in-handler fallback — a root-relative
  // /rate resolves on the API origin (404) in a split-origin deploy
  // (codex #3285 r5).
  handler: (req, res) => {
    const { publicPortalUrl } = require('../utils/portal-url');
    return res.redirect(302, `${publicPortalUrl()}/rate/${encodeURIComponent(String(req.params?.token || ''))}`);
  },
});
const { isBotUserAgent } = require('../utils/bot-ua');

// Live review_requests tokens are 32-64 char url-safe (prod-verified
// 2026-08-07, all 68 rows incl. one legacy 32-char). Malformed tokens get
// the same generic 404 as unknown ones, before any DB lookup. Applies to
// every /:token route on this router.
const { REVIEW_TOKEN_RE } = require('../services/review-request');
router.param('token', (req, res, next, token) => {
  if (REVIEW_TOKEN_RE.test(String(token))) return next();
  // /go's contract is that EVERY failure path degrades to the rate page
  // (which renders a friendly not-found state) — keep that for malformed
  // tokens too; everything else gets the same generic 404 as unknown.
  if (req.path.endsWith('/go')) {
    // Absolute portal origin (split-origin safe) — see the limiter handler.
    const { publicPortalUrl } = require('../utils/portal-url');
    return res.redirect(302, `${publicPortalUrl()}/rate/${encodeURIComponent(String(token))}`);
  }
  return res.status(404).json({ error: 'Review link not found or expired' });
});

// The page GET had no per-route limiter (security review 2026-08-07) — same
// probing exposure as /go, but it DOES touch the DB per hit. 30/min per IP
// matches directLinkLimiter.
const reviewPageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require('../middleware/rate-limit-key').rateLimitKey,
  message: { error: 'Too many requests — please slow down.' },
});

// GET /api/rate/:token/go — tracked redirect straight to the Google review
// form (the SMS/email {review_url} resolves here via a /l/ short link when
// GATE_REVIEW_DIRECT_LINK is on, and the /rate page's Open Google button always
// does). Stamps the open + click on the review_requests
// row, stops the customer's active cadence (they acted — no Day-3/4 chasers),
// bells the owner so an unmatched review can be manually attributed, and 302s
// to the location's GBP review URL. Every failure path degrades to the /rate
// page, which already renders not-found/expired states.
router.get('/:token/go', directLinkLimiter, async (req, res) => {
  const token = String(req.params.token || '');
  // Absolute portal-origin fallback: /rate is an SPA route, and in a
  // split-origin deploy (SPA built with a full VITE_API_URL) a root-relative
  // redirect would resolve on the API origin and 404 (codex #3286 pre-push
  // audit). publicPortalUrl() is the canonical public origin serving the SPA.
  const { publicPortalUrl } = require('../utils/portal-url');
  const ratePageFallback = `${publicPortalUrl()}/rate/${encodeURIComponent(token)}`;
  try {
    // The tracked flow runs whatever GATE_REVIEW_DIRECT_LINK says (that gate
    // only decides whether ask texts/emails link HERE or to the /rate thank-you
    // page). With the 1-10 rating retired there is no old flow for a gate-off
    // alias to fall back to, and the /rate page's own button points here — a
    // gate-off bounce back to /rate would be a loop and would skip the click
    // stamp and the cadence stop.
    // Shared review-token shape, NOT 64-hex-only (codex #3287 r1): live
    // tokens are 32-64 url-safe (prod-verified incl. one legacy 32-char
    // row), and the Track CTA + tech-trigger now emit /go for those rows
    // too — a 64-hex-only check bounced exactly them back to the raw rate
    // page. router.param already enforces this shape; kept here as
    // defense-in-depth for the same range.
    if (!REVIEW_TOKEN_RE.test(token)) return res.redirect(302, ratePageFallback);
    const request = await db('review_requests').where({ token }).first();
    if (!request) return res.redirect(302, ratePageFallback);
    // Finality first (pre-push audit P1): a request whose feedback was
    // already submitted — including a detractor's — must never redirect to
    // Google again, expired or not. The rate page renders its
    // alreadySubmitted state for exactly these rows, so the fallback IS the
    // right destination. This also covers the stale-CTA race: a track page
    // rendered while the ask was live, tapped after the customer finalized
    // through another link.
    const requestFinalized = Boolean(request.rated_at)
      || ['submitted', 'reviewed', 'rated'].includes(request.status);
    if (requestFinalized) return res.redirect(302, ratePageFallback);
    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      // Expired-but-real UNANSWERED link (review audit 2026-08-07): a
      // willing reviewer clicking a weeks-old text used to dead-end on the
      // rate page's "link expired" state. Send them on to the location's
      // Google review form anyway — but stamp NOTHING (no click credit, no
      // cadence stop, no owner bell): the request is past its attribution
      // window, and an expired token must not keep working as a tracked
      // link. Customers already marked as reviewers stay on the fallback.
      try {
        const expiredCustomer = await db('customers').where({ id: request.customer_id }).first();
        if (expiredCustomer?.has_left_google_review === true) {
          return res.redirect(302, ratePageFallback);
        }
        const expiredLoc = resolveReviewLocation(request, expiredCustomer);
        if (expiredLoc?.googleReviewUrl) return res.redirect(302, expiredLoc.googleReviewUrl);
      } catch (err) {
        logger.warn(`[review-gate] expired-link GBP resolve failed — rate-page fallback: ${err.message}`);
      }
      return res.redirect(302, ratePageFallback);
    }

    const customer = await db('customers').where({ id: request.customer_id }).first();
    // Same finality rule for the customer-level flag: once Adam marks
    // "Left Google review", no live /go link re-solicits — the rate page's
    // states handle the visit instead.
    if (customer?.has_left_google_review === true) {
      return res.redirect(302, ratePageFallback);
    }
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
    // recorded. If the stamp or the first-click claim fails (transient
    // Postgres outage), fall back to the rate page instead of proceeding.
    // Ordering: the base stamp (SQL-side counter, no stale read) lands first,
    // then the first-click claim (a conditional UPDATE ... WHERE redirected_at
    // IS NULL, so overlapping requests can't double-notify or lose an
    // open_count increment) — redirected_at is what every review sender's
    // send-time guard reads — and only then the best-effort stop below.
    try {
      const updates = {
        open_count: db.raw('COALESCE(open_count, 0) + 1'),
        google_review_clicked: true,
        redirected_to_google: true,
      };
      // google_location is NOT stamped here: a failed attempt (cadence
      // stop / claim errors fall back to the rate page) would persist a
      // location that redirected_at never observed, and a later successful
      // retry after routing changes would pair them falsely (GH codex
      // #3483 r6). It is set atomically WITH the redirected_at claim below.
      if (!request.opened_at) {
        updates.opened_at = new Date();
        if (request.status === 'sent') updates.status = 'opened';
      }
      await db('review_requests').where({ id: request.id }).update(updates);
    } catch (err) {
      logger.warn(`[review-gate] direct-link click stamp failed — rate-page fallback: ${err.message}`);
      return res.redirect(302, ratePageFallback);
    }

    // Atomic first-click claim: only the request that flips redirected_at
    // from NULL owns the owner notification.
    let firstClick = false;
    try {
      const claimed = await db('review_requests')
        .where({ id: request.id })
        .whereNull('redirected_at')
        // google_location pairs atomically with the first-click claim (GH
        // codex #3483 r4/r6): one conditional write, one observation — the
        // frozen first location can never describe a failed attempt.
        .update({ redirected_at: new Date(), google_location: loc.id });
      firstClick = claimed > 0;
    } catch (err) {
      logger.warn(`[review-gate] first-click claim failed — rate-page fallback: ${err.message}`);
      return res.redirect(302, ratePageFallback);
    }

    // They acted on the ask — stop what we can find that would ask them again
    // (ReviewService.stopFutureAsks: the clicked request's cadence and any other
    // active / deferred cadence, a cadence parked for summary recovery, queued
    // asks, due Day-3 follow-ups), under the send lock with a bounded wait.
    // BEST-EFFORT: the click is already recorded above (the first-click claim
    // stamps redirected_at), and every sender re-checks that at SEND time
    // (services/review-click-guard.js, inside the per-customer review-send
    // lock) — so a state this stop cannot see or reach (a redeeming cadence, a
    // stranded 'sending' row, an uncertain summary that enrolls later) is
    // suppressed when its ask is about to leave. The customer is NEVER kept
    // from Google over it. Accepted race: a send already past its guard when
    // the click lands can still deliver that one in-flight text.
    try {
      const stop = await require('../services/review-request').stopFutureAsks(request.customer_id, {
        sequenceId: request.sequence_id || null,
        reason: 'clicked',
      });
      if (!stop || stop.stopped !== true) {
        logger.info(`[review-gate] click stop incomplete (requestId=${request.id} outstanding=${(stop?.outstanding || ['unknown']).join(',')}) — send-time guard covers it`);
      }
    } catch (err) {
      logger.warn(`[review-gate] stopping later asks on click failed (send-time guard covers it): ${err.message}`);
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

    // Referral invite email (owner ruling 2026-09-29): sent right after the
    // customer taps through to Google. First click only (this request won the
    // atomic claim above); the helper's customer-scoped idempotency keeps it to
    // once per customer. Fire-and-forget — it never delays or breaks the
    // redirect. A bare, untracked office Google URL never reaches /go, so those
    // taps send nothing.
    if (firstClick && request.customer_id) {
      try {
        const { sendReferralInviteEmail } = require('../services/referral-invite-email');
        void sendReferralInviteEmail({ customerId: request.customer_id, trigger: 'google_review_click' });
      } catch (err) {
        logger.warn(`[review-gate] referral invite failed: ${err.message}`);
      }
    }

    // Latest-click stamp for the auto-link correlation, recorded ONLY once
    // every pre-redirect step has succeeded — a failed attempt falls back to
    // the rate page and must not become "latest click" evidence (pre-push P1;
    // redirected_at is the immutable first-click claim above and never
    // moves). Best-effort: a stamp failure must not cost the redirect.
    try {
      await db('review_requests').where({ id: request.id }).update({
        last_redirected_at: new Date(),
        last_google_location: loc.id,
      });
    } catch (err) {
      logger.warn(`[review-gate] last-click stamp failed: ${err.message}`);
    }

    return res.redirect(302, loc.googleReviewUrl);
  } catch (err) {
    logger.error(`[review-gate] direct-link redirect failed: ${err.message}`);
    return res.redirect(302, ratePageFallback);
  }
});

// GET /api/rate/:token — public page data for the thank-you + Google button page
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
    // overwritable rating flow instead of the thank-you state. Same
    // finality predicate as /go and submitRating — a status-only 'rated'
    // legacy row must not reopen the form (pre-push audit r5b).
    if (request.rated_at
      || ['submitted', 'reviewed', 'rated'].includes(String(request.status || '').toLowerCase())) {
      return res.status(200).json({ alreadySubmitted: true, message: 'Thank you!' });
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

    // The page is a thank-you plus ONE tap to Google (owner ruling 2026-09-29:
    // the 1-10 rating is retired). The button ALWAYS points at the tracked /go
    // redirect (stamps the click, stops the cadence, sends the referral invite),
    // whatever GATE_REVIEW_DIRECT_LINK says. A customer already marked as a
    // reviewer gets no button (same finality /go enforces).
    const { publicPortalUrl } = require('../utils/portal-url');
    const reviewUrl = customer?.has_left_google_review === true
      ? null
      : `${publicPortalUrl()}/api/rate/${encodeURIComponent(request.token)}/go`;

    res.json({
      firstName: contact.name || customer?.first_name || 'there',
      techName: request.tech_name || 'your technician',
      techPhotoUrl,
      serviceDate: request.service_date,
      locationName: loc.name,
      reviewUrl,
    });
  } catch (err) { next(err); }
});

module.exports = router;
