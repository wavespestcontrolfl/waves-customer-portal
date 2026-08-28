const express = require('express');
const router = express.Router();
const db = require('../models/db');
const gbp = require('../services/google-business');
const ReviewService = require('../services/review-request');
const ReviewIncentives = require('../services/review-incentives');
const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');
const { WAVES_LOCATIONS, resolveReviewLocationId } = require('../config/locations');
const logger = require('../services/logger');
const { etDateString, addETDays, startOfETMonth } = require('../utils/datetime-et');
const { getServiceContact, getServiceContactSmsRecipient } = require('../services/customer-contact');
const { runExclusive } = require('../utils/cron-lock');
const OUTREACH = require('../services/review-outreach-templates');
const { isEnabled } = require('../config/feature-gates');
const { toE164 } = require('../utils/phone');

const { DRAFT_REPLY_PREFIX, isDraftReply, stripDraftPrefix, whereNeedsRealReply, whereHasRealReply } = require('../services/review-reply/draft-prefix');
const ReplyPublisher = require('../services/review-reply/publisher');
const ReplyDrafter = require('../services/review-reply/drafter');
const { buildReplyGrounding } = require('../services/review-reply/grounding');
const AutoReply = require('../services/review-reply/runner');

// Route-level translation of the canonical publisher's typed errors.
function sendReplyError(res, err, next) {
  if (err instanceof ReplyPublisher.ReviewReplyError) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
  return next(err);
}

// Dismissing a review means "we are deliberately not replying to this one"
// (e.g. a hostile 1-star). The review list already hides dismissed rows, so
// the unresponded stat must skip them too — otherwise the "No Portal Reply"
// counter stays stuck on reviews that were explicitly dismissed.
function whereNotDismissed(qb) {
  qb.where(function () {
    this.where('google_reviews.dismissed', false).orWhereNull('google_reviews.dismissed');
  });
}

async function getReviewLocationStatuses() {
  const statuses = {};
  await Promise.all(WAVES_LOCATIONS.map(async (loc) => {
    let hasGbpAccess = false;
    let authError = null;
    if (loc.googleLocationResourceName) {
      try {
        await gbp._getHeaders(loc.id);
        hasGbpAccess = true;
      } catch (err) {
        authError = err.message;
      }
    }
    statuses[loc.id] = {
      // Without a Maps key the Places fallback cannot run — a non-GBP
      // location is then fully offline ('none'), and the UI must not claim
      // a partial feed remains active.
      reviewsSource: hasGbpAccess
        ? 'gbp'
        : (process.env.GOOGLE_MAPS_API_KEY ? 'places_fallback' : 'none'),
      hasGbpAccess,
      authError,
    };
  }));
  return statuses;
}

/**
 * Create an admin review request through the centralized review service.
 */
async function createReviewRequest({ customerId, locationId, techName, serviceType, serviceDate }) {
  return ReviewService.create({
    customerId,
    triggeredBy: 'admin',
    delayMinutes: 0,
    locationId,
    techName,
    serviceType,
    serviceDate,
    expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
  });
}

router.use(adminAuthenticate, requireAdmin);

// GET /api/admin/reviews — all reviews with filters
router.get('/', async (req, res, next) => {
  try {
    const { location, rating, responded, search, page = 1, limit = 200, missing } = req.query;

    // Exclude stats rows and dismissed reviews from actual reviews.
    // Scoped to active WAVES_LOCATIONS so the displayed list stays
    // consistent with the aggregate stats (retired-location rows
    // wouldn't be filterable in the dropdown anyway).
    const showDismissed = req.query.dismissed === 'true';
    const activeLocationIds = WAVES_LOCATIONS.map(l => l.id);
    let query = db('google_reviews')
      .leftJoin('customers', 'google_reviews.customer_id', 'customers.id')
      .where('google_reviews.reviewer_name', '!=', '_stats')
      .whereIn('google_reviews.location_id', activeLocationIds)
      // The removed-from-Google filter promises EVERY stamped review is
      // reachable (it backs the removal-alert support workflow), so it must
      // not be narrowed by the dismissed exclusion — a review dismissed
      // before (or after) Google removed it is still removal evidence.
      .modify(qb => {
        if (!showDismissed && missing !== 'true') {
          qb.where(function () {
            this.where('google_reviews.dismissed', false)
              .orWhereNull('google_reviews.dismissed')
              // Stamped rows pass regardless of dismissal: the removal
              // alert links to the DEFAULT view, and a review dismissed
              // before Google removed it is still removal evidence — the
              // dismissed exclusion must not hide it there.
              .orWhereNotNull('google_reviews.missing_since');
          });
        }
      })
      .select(
        'google_reviews.*',
        'customers.first_name as cust_first', 'customers.last_name as cust_last',
        'customers.waveguard_tier as cust_tier'
      )
      .orderBy('google_reviews.review_created_at', 'desc')
      // Deterministic tie-breaker for offset pagination: rows sharing a
      // review_created_at (or null legacy timestamps) otherwise have
      // undefined relative order, and a row that swaps pages between
      // requests is silently skipped by Load More.
      .orderBy('google_reviews.id', 'desc');

    if (location && location !== 'all') query = query.where('google_reviews.location_id', location);
    if (rating) query = query.where('google_reviews.star_rating', parseInt(rating));
    // Dedicated removed-from-Google filter — makes every stamped review
    // reachable regardless of the result cap on the default view (a large
    // profile wipe stays fully inspectable).
    if (missing === 'true') query = query.whereNotNull('google_reviews.missing_since');
    if (responded === 'true') query = query.modify(whereHasRealReply);
    if (responded === 'false') {
      // The default "Needs Reply" view must still surface reviews Google has
      // removed (missing_since stamped) even when they were already replied
      // to — the removal notification links here, and a replied-to removed
      // review would otherwise be invisible in the default list.
      query = query.where(function () {
        this.modify(whereNeedsRealReply).orWhereNotNull('google_reviews.missing_since');
      });
    }
    if (search) query = query.where(function () {
      this.whereILike('google_reviews.reviewer_name', `%${search}%`)
        .orWhereILike('google_reviews.review_text', `%${search}%`)
        .orWhereILike('customers.first_name', `%${search}%`)
        .orWhereILike('customers.last_name', `%${search}%`)
        .orWhereRaw("LOWER(customers.first_name || ' ' || COALESCE(customers.last_name, '')) LIKE LOWER(?)", [`%${search}%`]);
    });

    const parsedLimit = Math.max(1, Math.min(500, parseInt(limit, 10) || 200));
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * parsedLimit;
    const reviews = await query.limit(parsedLimit).offset(offset);
    // Explicit pagination signal, computed BEFORE a pinned review is added
    // (the page may then carry limit+1 rows; offset paging is unaffected).
    const hasMore = reviews.length === parsedLimit;
    // Deep-linked review (?review=<id> from an action bell): pin it into the
    // first page when it is not already there, so a review older than the
    // page size (edited-after-post, removal evidence …) is reached directly.
    const pin = typeof req.query.review === 'string' && req.query.review.trim() ? req.query.review.trim() : null;
    if (pin && offset === 0 && !reviews.some((r) => String(r.id) === pin)) {
      const pinned = await db('google_reviews')
        .leftJoin('customers', 'google_reviews.customer_id', 'customers.id')
        .where('google_reviews.id', pin)
        .where('google_reviews.reviewer_name', '!=', '_stats')
        .whereIn('google_reviews.location_id', activeLocationIds)
        .select('google_reviews.*', 'customers.first_name as cust_first', 'customers.last_name as cust_last', 'customers.waveguard_tier as cust_tier')
        .first();
      if (pinned) reviews.unshift(pinned);
    }

    // Get real Google stats from Places API (stored during sync).
    // Restrict to currently-configured WAVES_LOCATIONS so a `_stats`
    // row from a retired/renamed location can't inflate totalReviews
    // or the average. Track synced_at per row so we can distinguish
    // fresh stats from stale rows left behind when a location's sync
    // stopped updating.
    const statsRows = await db('google_reviews')
      .where({ reviewer_name: '_stats' })
      .whereIn('location_id', activeLocationIds);
    const googleStats = {};
    for (const row of statsRows) {
      try {
        const parsed = JSON.parse(row.review_text);
        // Shape-validated (matches the dashboard + BI gates): '"corrupt"'
        // or '{}' parses as valid JSON but contributes nothing — letting it
        // into googleStats would count its location toward
        // googleStatsComplete and expose a silently partial Google total.
        // Finite totalReviews REQUIRED: consumers sum it, so a rating-only
        // payload counting as "complete" would contribute zero reviews and
        // silently under-report the Google total. Rating stays optional —
        // a zero-review location legitimately has none, and every consumer
        // guards it.
        if (parsed && typeof parsed === 'object'
          && Number.isFinite(parsed.totalReviews)) {
          googleStats[row.location_id] = { rating: parsed.rating, totalReviews: parsed.totalReviews, syncedAt: row.synced_at };
        }
      } catch { /* ignore */ }
    }

    // Aggregate stats from actual reviews (excluding _stats rows).
    // Scoped to currently-configured WAVES_LOCATIONS so unreplied reviews
    // from retired/renamed GBPs don't pad the unresponded count and
    // skew the response-rate math (denominator already excludes them).
    // Live rows only, across EVERY overview aggregate: the stats bar reports
    // current Google state, and rows Google removed are retained evidence —
    // they stay reachable through the list's dedicated Removed filter, but
    // must not inflate Total Reviews / averages / star bars. (This also keeps
    // the reply metrics symmetric: every reply path rejects stamped rows, so
    // counting them on either side would distort the response rate.)
    const reviewsOnly = db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .whereNull('missing_since')
      .whereIn('location_id', activeLocationIds);
    const [totals, unresponded, respondedCountRow, thisMonth, perLocation] = await Promise.all([
      reviewsOnly.clone().select(
        db.raw('COUNT(*) as total'),
        db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating'),
      ).first(),
      reviewsOnly.clone().modify(whereNeedsRealReply).modify(whereNotDismissed).count('* as count').first(),
      reviewsOnly.clone().modify(whereHasRealReply).count('* as count').first(),
      reviewsOnly.clone().where('review_created_at', '>=', startOfETMonth().toISOString()).count('* as count').first(),
      reviewsOnly.clone().select('location_id')
        .count('* as count')
        .avg('star_rating as avg')
        .groupBy('location_id'),
    ]);

    // Star breakdown (exclude stats rows and removed rows; active locations).
    const breakdown = await db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .whereNull('missing_since')
      .whereIn('location_id', activeLocationIds)
      .select('star_rating').count('* as count')
      .groupBy('star_rating').orderBy('star_rating', 'desc');
    const locationBreakdownRows = await reviewsOnly.clone()
      .select('location_id', 'star_rating')
      .count('* as count')
      .groupBy('location_id', 'star_rating');
    const locationBreakdown = {};
    for (const row of locationBreakdownRows) {
      if (!locationBreakdown[row.location_id]) {
        locationBreakdown[row.location_id] = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
      }
      locationBreakdown[row.location_id][String(row.star_rating)] = parseInt(row.count, 10) || 0;
    }

    // True only when every currently-configured location has a `_stats`
    // row whose synced_at is recent. Places sync runs hourly and
    // swallows per-location errors (services/google-business.js
    // syncAllReviews), so a stale row from a previous successful run
    // can outlive the failure. We check each WAVES_LOCATIONS ID
    // explicitly (rather than aggregate row counts) so a stale row from
    // a retired location can't satisfy the count while a newly added
    // location has no row yet. The 24h window absorbs transient sync
    // hiccups; once any configured location goes a full day without a
    // fresh _stats write, every stats consumer below falls back to the
    // live-row aggregates (which exclude removed reviews).
    const STATS_FRESH_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const isFresh = (locId) => {
      const g = googleStats[locId];
      if (!g?.syncedAt) return false;
      const t = new Date(g.syncedAt).getTime();
      return t > 0 && (now - t) <= STATS_FRESH_MS;
    };
    const googleStatsComplete = WAVES_LOCATIONS.every(loc => isFresh(loc.id));

    // Use Google's real totals only when the snapshot is fresh AND complete —
    // completeness computed but ignored here previously meant stale _stats
    // rows (removed Maps key, persistent Places failures) kept feeding the
    // overview while the corrected live-row fallback never ran.
    const totalGoogleReviews = googleStatsComplete
      ? Object.values(googleStats).reduce((s, g) => s + (g.totalReviews || 0), 0)
      : 0;

    // For the response-rate calc, the numerator and denominator must come
    // from the same population. `totalGoogleReviews` only sums locations
    // that have a `_stats` row, so scope the unresponded count we expose
    // for the rate-calc denominator to those same locations. Otherwise a
    // location with reviews-but-no-_stats would inflate `unresponded`
    // without contributing to the total, breaking `total - unresponded`.
    const ratedLocationIds = googleStatsComplete
      ? Object.keys(googleStats).filter(id => (googleStats[id]?.totalReviews || 0) > 0)
      : [];
    const unrespondedInRatedRow = ratedLocationIds.length > 0
      ? await reviewsOnly.clone().whereIn('location_id', ratedLocationIds).modify(whereNeedsRealReply).modify(whereNotDismissed).whereNull('missing_since').count('* as count').first()
      : { count: 0 };
    const avgGoogleRating = googleStatsComplete && Object.values(googleStats).some(g => g.rating)
      ? (Object.values(googleStats).reduce((s, g) => s + (g.rating || 0), 0) / Object.values(googleStats).filter(g => g.rating).length).toFixed(1)
      : parseFloat(totals?.avg_rating || 0);

    const locationStatuses = await getReviewLocationStatuses();

    res.json({
      hasMore,
      reviews: reviews.map(r => ({
        id: r.id, googleReviewId: r.google_review_id, locationId: r.location_id,
        reviewerName: r.reviewer_name, reviewerPhoto: r.reviewer_photo_url,
        starRating: r.star_rating, reviewText: r.review_text,
        reply: isDraftReply(r.review_reply) ? null : r.review_reply,
        draftReply: isDraftReply(r.review_reply) ? stripDraftPrefix(r.review_reply) : null,
        // Identity of the pipeline's own draft in the slot: "Use Draft" sends
        // it back with the reply so a draft the sync invalidated meanwhile
        // (review edit / re-attribution) is refused, not posted as free text.
        draftToken: isDraftReply(r.review_reply) && r.auto_reply_draft && stripDraftPrefix(r.review_reply).trim() === String(r.auto_reply_draft).trim()
          ? AutoReply.reviewFingerprint(r) : null,
        // Identity of the review CONTENT the browser is showing; every editor
        // submission sends it back so text written for the old review is
        // refused after a reviewer rewrite the sync recorded meanwhile.
        reviewToken: AutoReply.reviewFingerprint(r),
        // A person's saved draft the sync found written for an EARLIER version
        // of the review: shown, but refused verbatim until edited.
        draftStale: isDraftReply(r.review_reply) && r.auto_reply_reason === AutoReply.HUMAN_DRAFT_STALE,
        replyUpdatedAt: isDraftReply(r.review_reply) ? null : r.reply_updated_at,
        // Auto-reply pipeline state (null = never queued; see review-reply/runner.js).
        autoReply: r.auto_reply_status ? {
          status: r.auto_reply_status,
          reason: r.auto_reply_reason || null,
          dueAt: r.auto_reply_due_at || null,
          draftedAt: r.auto_reply_drafted_at || null,
          publishedAt: r.auto_reply_published_at || null,
          mode: r.auto_reply_mode || null,
          version: r.auto_reply_version || null,
          hasDraft: !!r.auto_reply_draft,
          // The verified text a failed publish is retrying with (review_reply
          // stays null on those rows) — surfaced so the page can offer it.
          draft: r.auto_reply_status === 'failed' ? (r.auto_reply_draft || null) : null,
        } : null,
        reviewCreatedAt: r.review_created_at,
        matchedCustomer: r.cust_first ? { name: `${r.cust_first} ${r.cust_last}`, tier: r.cust_tier, id: r.customer_id } : null,
        syncedAt: r.synced_at,
        // Non-null = this review no longer appears on Google (removed or
        // filtered) as of this timestamp; the row is kept as evidence.
        missingSince: r.missing_since || null,
      })),
      stats: {
        totalReviews: totalGoogleReviews || parseInt(totals?.total || 0),
        googleStatsComplete,
        avgRating: parseFloat(avgGoogleRating) || parseFloat(totals?.avg_rating || 0),
        unresponded: parseInt(unresponded?.count || 0),
        // Unresponded count scoped to locations that contribute to
        // `totalReviews` — used as the response-rate denominator's
        // companion so numerator (totalReviews - unrespondedInRated) and
        // denominator (totalReviews) come from the same location set.
        unrespondedInRated: parseInt(unrespondedInRatedRow?.count || 0),
        responded: parseInt(respondedCountRow?.count || 0),
        newThisMonth: parseInt(thisMonth?.count || 0),
        breakdown: Object.fromEntries(breakdown.map(b => [b.star_rating, parseInt(b.count)])),
        locationBreakdown,
        perLocation: perLocation.map(l => {
          const gs = googleStatsComplete ? googleStats[l.location_id] : null;
          return {
            locationId: l.location_id,
            count: gs?.totalReviews || parseInt(l.count),
            avgRating: gs?.rating?.toFixed(1) || parseFloat(l.avg || 0).toFixed(1),
          };
        }),
      },
      locations: WAVES_LOCATIONS.map(l => ({
        id: l.id,
        name: l.name,
        reviewUrl: l.googleReviewUrl,
        ...(locationStatuses[l.id] || {}),
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/:id/reply — reply to a review (human writer).
// Posts through the canonical publisher (draft → verify → liveness recheck →
// publish → persist → audit); a human may replace an existing Google reply.
router.post('/:id/reply', async (req, res, next) => {
  try {
    const { replyText, draftToken, groundingToken, expectedReply, expectedDraft, expectedReview } = req.body;
    if (!replyText) return res.status(400).json({ error: 'Reply text required' });
    const result = await ReplyPublisher.publishReviewReply({
      reviewId: req.params.id,
      text: replyText,
      actor: { type: 'admin', adminUserId: req.technicianId || null },
      allowOverwrite: true,
      // A human posting closes out a pending/posted auto-reply state on the
      // row; a never-queued row keeps NULL.
      autoFields: AutoReply.manualReplyCloseFields(db),
      // "Use Draft" re-submits the pipeline's stored draft through this
      // route: it must still match the review + account facts it was
      // grounded on (a re-attribution or city fix since then → 409).
      guard: AutoReply.pipelineDraftGuard(replyText, {
        draftToken: typeof draftToken === 'string' ? draftToken : null,
        groundingToken: typeof groundingToken === 'string' ? groundingToken : null,
      }),
      // What the browser saw in the reply slot when the page loaded (null =
      // no reply). Omitted by older clients → no browser-side check.
      expectedReply: expectedReply === undefined ? undefined : (expectedReply == null ? null : String(expectedReply)),
      expectedDraft: expectedDraft === undefined ? undefined : (expectedDraft == null ? null : String(expectedDraft)),
      expectedReview: typeof expectedReview === 'string' && expectedReview ? expectedReview : undefined,
      // The account half of an editor AI draft's grounding token: the
      // post-PUT check parks a reply whose facts changed while Google's PUT
      // was in flight, human path included (codex r40).
      expectedAccountFingerprint: typeof groundingToken === 'string' && groundingToken.includes('|') ? groundingToken.slice(groundingToken.indexOf('|') + 1) : undefined,
    });
    res.json({ success: true, googlePosted: result.googlePosted });
  } catch (err) { sendReplyError(res, err, next); }
});

// POST /api/admin/reviews/:id/retract-reply — delete the owner reply on
// Google (auto-posted or not) and clear it locally.
router.post('/:id/retract-reply', requireAdmin, async (req, res, next) => {
  try {
    const result = await ReplyPublisher.retractReviewReply({
      reviewId: req.params.id,
      actor: { type: 'admin', adminUserId: req.technicianId || null },
      autoFields: { auto_reply_status: AutoReply.STATUS.RETRACTED, auto_reply_reason: 'admin_retract', auto_reply_claimed_until: null },
    });
    res.json({ success: true, googleDeleted: result.googleDeleted });
  } catch (err) { sendReplyError(res, err, next); }
});

// POST /api/admin/reviews/:id/auto-reply/post-now — publish the pending
// auto draft immediately (bypasses the jitter and shadow mode; a person asked).
router.post('/:id/auto-reply/post-now', requireAdmin, async (req, res, next) => {
  try {
    const { expectedDraft } = req.body || {};
    const result = await AutoReply.postNow(req.params.id, { type: 'admin', adminUserId: req.technicianId || null }, {
      // The draft the page displayed (null = none). Omitted by older clients.
      expectedDraft: expectedDraft === undefined ? undefined : (expectedDraft == null ? null : String(expectedDraft)),
    });
    if (result.outcome !== 'posted') {
      // A 1-3★ / unrated review with no surfaced draft: the draft was just
      // created and parked; the person reads it, then posts it.
      // Success-shaped (200) so the page reloads the card and RENDERS the
      // draft before another Post now is possible (codex r28).
      if (result.drafted) {
        const message = result.reason === 'draft_replaced'
          ? 'The draft you approved was no longer valid (the review or customer facts changed, or it no longer passes the checks). A fresh draft is on the review — read it, then Post now again.'
          : 'This review needs a person: a draft was just created and is on the review — read it, then Post now again.';
        return res.json({ success: false, drafted: true, outcome: result.outcome, reason: result.reason || null, message });
      }
      return res.status(409).json({ error: `Could not post: ${result.reason || result.outcome}`, outcome: result.outcome, reason: result.reason || null });
    }
    res.json({ success: true, outcome: result.outcome, mode: result.mode || null });
  } catch (err) { sendReplyError(res, err, next); }
});

// POST /api/admin/reviews/:id/auto-reply/skip — take a review out of the
// automatic pipeline (it stays in the manual needs-reply queue).
router.post('/:id/auto-reply/skip', requireAdmin, async (req, res, next) => {
  try {
    const skipped = await AutoReply.skipAutoReply(req.params.id);
    if (!skipped) return res.status(409).json({ error: 'This review is not waiting on the auto-reply pipeline (or a reply is being posted right now — try again in a moment)' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/reviews/auto-reply/status — mode, counts, shadow-exit facts.
router.get('/auto-reply/status', requireAdmin, async (req, res, next) => {
  try {
    res.json(await AutoReply.autoReplyStatus());
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/:id/dismiss — dismiss a review from dashboard
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    // Stamped rows are removal evidence, not inbox items: the Removed filter
    // deliberately ignores the dismissed flag, so dismissing one only plants
    // a trap — if Google reinstates the review, the stamp clears while
    // `dismissed` remains and the live review vanishes from every normal
    // view. Conditional update + 409 (the client hides the button; this
    // guards stale pages, same as the reply lockout).
    const updated = await db('google_reviews')
      .where({ id: req.params.id })
      .whereNull('missing_since')
      // Never under an in-flight automatic publish (mirrors Skip).
      .modify(AutoReply.whereNoLivePublishClaim)
      .update({ dismissed: true, ...AutoReply.dismissCancelFields(db) });
    if ((Array.isArray(updated) ? updated.length : updated) === 0) {
      return res.status(409).json({ error: 'This review cannot be dismissed right now — it was removed from Google (retained as evidence) or a reply is being posted this moment; try again in a minute.' });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/dismiss-batch — dismiss multiple reviews
router.post('/dismiss-batch', async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'No IDs provided' });
    // Stamped rows are skipped, not 409'd — a batch may legitimately mix in
    // a row the hourly sync stamped since the page loaded.
    const dismissed = await db('google_reviews')
      .whereIn('id', ids)
      .whereNull('missing_since')
      // Rows under an in-flight automatic publish are skipped, like stamped ones.
      .modify(AutoReply.whereNoLivePublishClaim)
      .update({ dismissed: true, ...AutoReply.dismissCancelFields(db) });
    res.json({ success: true, dismissed: Array.isArray(dismissed) ? dismissed.length : dismissed });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/:id/ai-reply — draft a reply for the editor.
// Same drafter + verifier + public-safe grounding as the auto-reply runner
// (services/review-reply); returns text only, posts nothing.
router.post('/:id/ai-reply', async (req, res, next) => {
  try {
    const review = await db('google_reviews').where({ id: req.params.id }).first();
    if (!review || review.reviewer_name === '_stats') return res.status(404).json({ error: 'Review not found' });
    if (review.missing_since) return res.status(409).json({ error: 'This review has been removed from Google — replies are disabled.' });

    const grounding = await buildReplyGrounding(review);
    const recentReplies = await ReplyDrafter.loadRecentPostedReplies(review.location_id);
    const draft = await ReplyDrafter.draftReviewReply({ grounding, recentReplies });
    if (!draft.ok) {
      if (draft.reason === 'provider_unavailable') return res.status(502).json({ error: 'AI reply providers unavailable' });
      return res.status(422).json({ error: `No draft passed the safety checks (${(draft.rejections || []).join(', ')}) — write this one by hand.`, rejections: draft.rejections || [] });
    }
    // The draft is not stored on the row; the token binds it to the review +
    // account facts it was grounded on and is validated at publish time.
    res.json({ reply: draft.text, mode: draft.mode, version: draft.version, groundingToken: AutoReply.groundingToken(review, grounding) });
  } catch (err) {
    logger.error(`AI reply generation failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/reviews/outreach-candidates — customers eligible for review request
// requireAdmin: this returns full customer PII (name/phone/address/lifetime
// revenue) and drives outbound SMS. The /incentives/* endpoints are already
// admin-only; the PII-and-send surface must be at least as locked down.
router.get('/outreach-candidates', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 90));
    const windowStart = etDateString(addETDays(new Date(), -days));

    // Active customers with completed services inside window who haven't left a review
    const customers = await db('customers')
      .where('customers.active', true)
      .whereNull('customers.deleted_at')
      .where(function () {
        this.where('customers.has_left_google_review', false).orWhereNull('customers.has_left_google_review');
      })
      .whereExists(function () {
        this.select(db.raw(1)).from('scheduled_services')
          .whereRaw('scheduled_services.customer_id = customers.id')
          .where('scheduled_services.status', 'completed')
          .where('scheduled_services.scheduled_date', '>=', windowStart);
      })
      .whereNotExists(function () {
        this.select(db.raw(1)).from('google_reviews')
          .whereRaw('google_reviews.customer_id = customers.id');
      })
      .select(
        'customers.id',
        'customers.first_name',
        'customers.last_name',
        'customers.phone',
        'customers.email',
        'customers.service_contact_name',
        'customers.service_contact_phone',
        'customers.service_contact_email',
        // Consent stamp — getServiceContactSmsRecipient treats a row
        // without it as unstamped, so omitting it would make the admin
        // list resolve the primary while /send-request (full row) targets
        // the stamped contact (#2955 r3).
        'customers.service_contacts_consent_at',
        'customers.address_line1',
        'customers.city',
        'customers.zip',
        'customers.waveguard_tier',
        'customers.nearest_location_id',
        // lat/lng feed the canonical review resolver's geo fallback for the
        // payload's locationId (see below).
        'customers.latitude',
        'customers.longitude',
        // Payments-derived net — customers.lifetime_revenue has no production
        // writer and reads $0/stale for every real customer.
        db.raw("(SELECT COALESCE(SUM(amount - COALESCE(refund_amount, 0)), 0) FROM payments WHERE payments.customer_id = customers.id AND payments.status = 'paid') as lifetime_revenue")
      )
      .orderBy('customers.last_contact_date', 'desc')
      .limit(200);

    // Get last completed service for each customer
    const customerIds = customers.map(c => c.id);
    const lastServices = customerIds.length > 0
      ? await db('scheduled_services')
          .whereIn('customer_id', customerIds)
          .where('status', 'completed')
          .orderBy('scheduled_date', 'desc')
          .select('customer_id', 'service_type', 'scheduled_date')
      : [];

    const lastSvcMap = {};
    lastServices.forEach(s => {
      if (!lastSvcMap[s.customer_id]) lastSvcMap[s.customer_id] = s;
    });

    // Channel-complete review-ask history (count + most recent) per customer —
    // counts delivered review_requests on BOTH SMS and email so the cooldown /
    // 3-cap eligibility matches the send-time guards (audit: an sms_log-only
    // count missed email asks).
    const askMap = customerIds.length > 0
      ? await ReviewService.getDeliveredAskStatsBatch(customerIds).catch(() => ({}))
      : {};

    // ── Eligibility inputs (batched) ──────────────────────────────
    // Annotate each candidate with WHY it may not be sendable instead of
    // silently over-listing customers who fail at send time (audit O8):
    // consent prefs, hard suppression (DNC), an active cadence, plus a
    // sentiment signal from the customer's last NPS rating (audit O4).
    const prefsRows = customerIds.length
      ? await db('notification_prefs').whereIn('customer_id', customerIds)
          .select('customer_id', 'sms_enabled', 'email_enabled', 'review_request', 'review_request_channel')
          .catch(() => [])
      : [];
    const prefsMap = {};
    prefsRows.forEach(p => { prefsMap[p.customer_id] = p; });

    const phones = customers
      .map(c => getServiceContactSmsRecipient(c).phone || c.phone)
      .filter(Boolean)
      // messaging_suppression.phone is E.164 — normalize before matching.
      .map(p => toE164(p) || p);
    const suppressedRows = phones.length
      ? await db('messaging_suppression').whereIn('phone', phones).where('active', true).select('phone').catch(() => [])
      : [];
    const suppressedSet = new Set(suppressedRows.map(r => r.phone));

    const sequenceMap = await ReviewService.getActiveSequencesForCustomers(customerIds).catch(() => ({}));

    const satRows = customerIds.length
      ? await db('satisfaction_responses').whereIn('customer_id', customerIds)
          .orderBy('created_at', 'desc').select('customer_id', 'rating')
          .catch(() => [])
      : [];
    const sentimentMap = {};
    satRows.forEach(r => {
      if (sentimentMap[r.customer_id]) return;
      const rt = Number(r.rating);
      sentimentMap[r.customer_id] = rt >= 7 ? 'happy' : rt <= 4 ? 'issue' : 'neutral';
    });

    const thirtyDaysAgo = Date.now() - 30 * 86400000;

    res.json({
      customers: customers.map(c => {
        // SMS eligibility is consent-gated; EMAIL eligibility is not (the
        // #2948 artifact covers texting only) — resolve separately so an
        // unstamped contact's email still counts as cadenceable.
        const contact = getServiceContactSmsRecipient(c);
        const phone = contact.phone || c.phone || null;
        const email = getServiceContact(c).email || c.email || null;
        const ls = lastSvcMap[c.id];
        const ask = askMap[c.id] || { askCount: 0, lastAsked: null };
        const prefs = prefsMap[c.id];
        const reviewOptedOut = !!prefs && prefs.review_request === false; // review-wide opt-out
        const smsPrefOff = !!prefs && prefs.sms_enabled === false;
        const emailPrefOff = !!prefs && prefs.email_enabled === false;
        // Mirror the sender's channel-preference exclusivity (round-4/6): an
        // explicit 'email' preference disables the SMS-only manual Send; 'sms'
        // (the backfill default) does NOT disable email.
        const emailPreferred = !!prefs && prefs.review_request_channel === 'email';
        const suppressed = phone ? suppressedSet.has(toE164(phone) || phone) : false;
        const inCooldown = ask.lastAsked ? (new Date(ask.lastAsked).getTime() >= thirtyDaysAgo) : false;
        const atCap = ask.askCount >= 3;
        const smsable = !!phone && !reviewOptedOut && !smsPrefOff && !suppressed && !emailPreferred;
        // Email fails closed like the sender: requires an existing prefs row
        // (parity with SMS's NO_CONSENT_RECORD on a missing row).
        const emailable = !!email && !!prefs && !reviewOptedOut && !emailPrefOff;
        const sequence = sequenceMap[c.id] || null;
        // `sendable` gates the SMS-only manual Send; `cadenceable` gates
        // Start-Cadence (can use email). A customer who turned OFF review SMS but
        // still allows email must STAY visible for the email cadence — so only
        // the row-hiding reasons (opted_out / suppressed) are emitted when NO
        // review channel remains; an SMS-only block uses a soft `sms_*` reason.
        const baseBlocked = atCap || inCooldown || !!sequence;
        const sendable = smsable && !baseBlocked;
        const cadenceable = (smsable || emailable) && !baseBlocked;
        const eligibilityReasons = [];
        if (!smsable && !emailable) {
          if (reviewOptedOut) eligibilityReasons.push('opted_out');
          else if (suppressed) eligibilityReasons.push('suppressed');
          else eligibilityReasons.push('no_contact');
        } else if (!smsable && emailable) {
          eligibilityReasons.push(
            emailPreferred ? 'email_preferred' : suppressed ? 'sms_suppressed' : smsPrefOff ? 'sms_opted_out' : 'no_phone',
          );
        }
        if (atCap) eligibilityReasons.push('at_cap');
        if (inCooldown) eligibilityReasons.push('cooldown');
        if (sequence) eligibilityReasons.push('in_sequence');
        return {
          id: c.id,
          name: `${c.first_name} ${c.last_name}`,
          firstName: c.first_name,
          lastName: c.last_name,
          phone,
          phoneSource: contact.phone && contact.phone !== c.phone ? 'service_contact' : 'customer',
          hasEmail: !!email,
          addressLine1: c.address_line1,
          city: c.city,
          zip: c.zip,
          tier: c.waveguard_tier,
          // The CANONICAL review office (city → zip → geo → stored id), not
          // raw nearest_location_id — the admin table/drawer/grouping must
          // show the same office the send path resolves, or downtown Sarasota
          // reads Bradenton in the UI while the SMS targets Sarasota
          // (codex #3285 r3).
          locationId: resolveReviewLocationId(c, { storedLocationId: c.nearest_location_id || null }),
          lifetimeRevenue: Number(c.lifetime_revenue) || 0,
          lastService: ls?.service_type || null,
          lastServiceDate: ls?.scheduled_date || null,
          askCount: ask.askCount,
          lastAsked: ask.lastAsked,
          requestSent: ask.askCount > 0,
          sentiment: sentimentMap[c.id] || 'unknown',
          sendable,
          cadenceable,
          eligibilityReasons,
          sequence,
        };
      }),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/send-request — send a single review-request SMS.
// Sends the chosen outreach template/body (audit O2) through the tokenized NPS
// rate page; serialized per-customer against double-sends and returns an
// accurate status (sent / deferred / blocked) rather than a misleading 422.
router.post('/send-request', requireAdmin, async (req, res, next) => {
  try {
    const { customerId, serviceType, techName, templateId, body } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (templateId && !OUTREACH.getOutreachTemplate(templateId)) {
      return res.status(400).json({ error: 'Unknown templateId' });
    }

    // The whole gate stack (archived / already-reviewed / consented recipient /
    // per-customer lock / active-cadence block / 3-ask cap / 30-day cooldown /
    // queued-ask reuse) lives in ReviewService.sendGatedAsk, shared with the
    // customer-portal satisfaction prompt so there is ONE unscheduled-ask path.
    // This route only maps the outcome onto HTTP.
    const result = await ReviewService.sendGatedAsk({
      customerId,
      channel: 'sms',
      templateId: templateId || null,
      body: typeof body === 'string' ? body : null,
      serviceType: serviceType || null,
      techName: techName || null,
      triggeredBy: 'admin',
      manageRetryVia: 'cron',
    });

    switch (result.outcome) {
      case 'sent': {
        const loc = WAVES_LOCATIONS.find(l => l.id === result.locationId) || WAVES_LOCATIONS[0];
        const customer = await db('customers').where({ id: customerId }).first().catch(() => null);
        await db('activity_log').insert({
          customer_id: customerId, action: 'review_requested',
          description: `Review request sent to ${customer?.first_name || ''} ${customer?.last_name || ''}`.trim()
            + ` (${loc.name})`,
        }).catch(() => {});
        return res.status(200).json({ success: true, requestId: result.requestId });
      }
      case 'no_customer':
        return res.status(404).json({ error: 'Customer not found' });
      case 'archived':
        return res.status(409).json({ error: 'Customer is archived' });
      case 'already_reviewed':
        return res.status(409).json({ error: 'Customer is marked as already having left a Google review' });
      case 'no_contact':
        return res.status(400).json({ error: 'No SMS-capable phone on file' });
      case 'concurrent':
        return res.status(409).json({ error: 'A review request to this customer is already being sent.' });
      case 'in_cadence':
        return res.status(409).json({ error: 'Customer is in an active review cadence — manage outreach from the cadence instead of a one-off send.' });
      case 'at_cap':
        return res.status(409).json({ error: 'Customer has already received 3 review requests in the last 6 months' });
      case 'cooldown':
        return res.status(409).json({ error: 'Customer received a review request in the last 30 days' });
      case 'already_queued':
        return res.status(202).json({
          success: false, deferred: true, alreadyQueued: true,
          nextAllowedAt: result.nextAllowedAt,
          message: 'A review request to this customer is already queued and will send automatically.',
        });
      case 'deferred':
        return res.status(202).json({
          success: false, deferred: true,
          nextAllowedAt: result.nextAllowedAt,
          message: 'Send deferred. Queued — it will send automatically on the next retry.',
        });
      case 'blocked':
        return res.status(409).json({
          error: `Review request was not sent (${result.code || result.reason || 'blocked'}). Check the customer's messaging consent / suppression.`,
        });
      case 'error':
        // NON-durable failure (lock never ran, or no scheduled_for was
        // persisted) — processScheduled has nothing to retry, so reporting
        // "queued" here would record a phantom retry in the UI (codex r7).
        return res.status(502).json({
          error: `Review request failed and was NOT queued (${result.code || result.reason || 'error'}). Retry the send.`,
        });
      default:
        // Durable transient failure only — send_failed guarantees a
        // persisted scheduled_for row processScheduled will pick up.
        return res.status(202).json({
          success: false, queued: true,
          message: 'Send failed transiently and was queued for automatic retry.',
        });
    }
  } catch (err) { next(err); }
});

// ── Review Outreach: analytics, activity, and cadence control ──────────────

// GET /api/admin/reviews/outreach-analytics — real Sent→Reviewed funnel +
// per-location/template/channel conversion + Google-review velocity (audit O1).
router.get('/outreach-analytics', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 90));
    const analytics = await ReviewService.getOutreachAnalytics({ days });

    // Digital-card QR scans (short_codes kind='card') — the PASSIVE review ask
    // that rides each customer's business card, surfaced alongside the active
    // outreach funnel. Windowed count comes from the per-click rows (human
    // clicks only — bots never get a short_code_clicks row).
    let cardScans = null;
    try {
      const totals = await db('short_codes')
        .where({ kind: 'card' })
        .select(
          db.raw('COUNT(*)::int as cards'),
          db.raw('COALESCE(SUM(click_count), 0)::int as scans'),
        )
        .first();
      const windowRow = await db('short_code_clicks')
        .join('short_codes', 'short_code_clicks.short_code_id', 'short_codes.id')
        .where('short_codes.kind', 'card')
        .where('short_code_clicks.clicked_at', '>=', new Date(Date.now() - days * 24 * 3600000))
        .count('* as count')
        .first();
      cardScans = {
        cards: Number(totals?.cards || 0),
        scans: Number(totals?.scans || 0),
        windowScans: parseInt(windowRow?.count || 0, 10),
        days,
      };
    } catch { /* short-code tables may not exist in older envs */ }

    // Tell the client whether automated cadences are live so it can hide the
    // Start-Cadence affordance when the gate is off (one-off sends still work).
    res.json({ ...analytics, cardScans, reviewSequencesEnabled: isEnabled('reviewSequences') });
  } catch (err) { next(err); }
});

// GET /api/admin/reviews/outreach-activity — server-backed activity feed (audit O3).
router.get('/outreach-activity', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const items = await ReviewService.getOutreachActivity({ limit });
    res.json({ items });
  } catch (err) { next(err); }
});

// GET /api/admin/reviews/outreach-templates — template registry for the composer.
router.get('/outreach-templates', requireAdmin, (req, res) => {
  res.json({
    templates: OUTREACH.OUTREACH_TEMPLATES,
    defaultPlan: OUTREACH.DEFAULT_SEQUENCE_PLAN,
  });
});

// POST /api/admin/reviews/outreach/start-sequence — start a cadence for one
// customer (or many, when body.customerIds is provided). The cadence itself
// only advances when GATE_REVIEW_SEQUENCES is on; the first touch fires now.
router.post('/outreach/start-sequence', requireAdmin, async (req, res, next) => {
  try {
    // Don't start cadences while the gate is off: the cron won't advance them,
    // so the row would sit 'active' forever — firing Day 0 then blocking the
    // customer from one-off sends without ever delivering Day 3/4.
    if (!isEnabled('reviewSequences')) {
      return res.status(409).json({ error: 'Review cadences are disabled (GATE_REVIEW_SEQUENCES is off). Use a one-off send instead.' });
    }
    const ids = Array.isArray(req.body?.customerIds)
      ? req.body.customerIds
      : (req.body?.customerId ? [req.body.customerId] : []);
    if (!ids.length) return res.status(400).json({ error: 'customerId or customerIds required' });
    const plan = Array.isArray(req.body?.plan) && req.body.plan.length ? req.body.plan : null;

    const results = [];
    for (const customerId of ids) {
      try {
        // Take the SAME per-customer lock as /send-request so a Send + Cadence
        // double-click (or a batch overlapping a manual send) can't both read
        // the cap/cooldown before either Twilio log lands and double-ask.
        const r = await runExclusive(`review-send:${customerId}`, async () => {
          // No explicit plan from the operator → the same per-type
          // classification as post-service enrollment (codex #3235 r19 P1):
          // a recurring customer gets the one-touch plan here too. An
          // explicit plan in the request body still wins.
          let effectivePlan = plan;
          let seriesFinal = false;
          if (!effectivePlan) {
            const resolved = await ReviewService.resolveSequencePlanForEnrollment({ customerId });
            if (resolved.error) return { started: false, reason: 'plan_resolution_failed' };
            if (resolved.skip) return { started: false, reason: resolved.skip };
            effectivePlan = resolved.plan;
            seriesFinal = resolved.seriesFinal === true;
          }
          return ReviewService.startReviewSequence({ customerId, plan: effectivePlan, seriesFinal, startedBy: req.technicianId });
        },
        { recordHealth: false }); // per-customer lock, not a scheduled job
        if (r && r.skipped) {
          results.push({ customerId, started: false, reason: 'send_in_progress' });
        } else {
          results.push({ customerId, ...r });
        }
      } catch (err) {
        results.push({ customerId, started: false, reason: err.message });
      }
    }
    const started = results.filter(r => r.started).length;
    res.json({ success: true, started, total: ids.length, results });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/outreach/stop-sequence — stop an active cadence.
router.post('/outreach/stop-sequence', requireAdmin, async (req, res, next) => {
  try {
    const { sequenceId } = req.body || {};
    if (!sequenceId) return res.status(400).json({ error: 'sequenceId required' });
    const result = await ReviewService.stopReviewSequence(sequenceId, 'manual');
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// GET /api/admin/reviews/incentives — technician review bonus dashboard
router.get('/incentives', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const dashboard = await ReviewIncentives.getDashboard({ days });
    res.json(dashboard);
  } catch (err) { next(err); }
});

// GET /api/admin/reviews/incentives/attribution-queue — Google reviews that need payout attribution repair
router.get('/incentives/attribution-queue', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const limit = Math.max(1, Math.min(250, parseInt(req.query.limit, 10) || 100));
    const queue = await ReviewIncentives.getAttributionQueue({ days, limit });
    res.json(queue);
  } catch (err) { next(err); }
});

// GET /api/admin/reviews/incentives/attribution-candidates — customer/service matches for one Google review
router.get('/incentives/attribution-candidates', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(25, parseInt(req.query.limit, 10) || 10));
    const result = await ReviewIncentives.searchAttributionCandidates({
      reviewId: req.query.reviewId,
      q: req.query.q,
      limit,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/incentives/attribute — manually attribute a confirmed Google review payout
router.post('/incentives/attribute', requireAdmin, async (req, res, next) => {
  try {
    const result = await ReviewIncentives.manualAttributeGoogleReview({
      reviewId: req.body?.reviewId,
      customerId: req.body?.customerId,
      technicianId: req.body?.technicianId,
      serviceRecordId: req.body?.serviceRecordId,
      noVisit: req.body?.noVisit === true,
      adminId: req.technicianId,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/incentives/sync — backfill/create earned bonus rows
router.post('/incentives/sync', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.body?.days || req.query.days, 10) || 90));
    const sync = await ReviewIncentives.syncReviewIncentives({ sinceDays: days });
    const dashboard = await ReviewIncentives.getDashboard({ days: Math.min(days, 90) });
    res.json({ success: true, sync, ...dashboard });
  } catch (err) { next(err); }
});

// PATCH /api/admin/reviews/incentives/policy — update flat bonus policy
router.patch('/incentives/policy', requireAdmin, async (req, res, next) => {
  try {
    const policy = await ReviewIncentives.savePolicy(req.body || {});
    res.json({ success: true, policy });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/incentives/mark-paid — close payroll loop manually
router.post('/incentives/mark-paid', requireAdmin, async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!raw.length) return res.status(400).json({ error: 'ids required (valid payout UUIDs)' });
    // Validate UUID shape before the query. A non-UUID string reaches a uuid
    // column and throws Postgres 22P02 → an unhandled 500. Reject the WHOLE
    // request if any id is malformed rather than silently dropping it and
    // reporting success on a partial set.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = raw;
    if (!ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
      return res.status(400).json({ error: 'All ids must be valid payout UUIDs' });
    }
    const result = await ReviewIncentives.markPaid(ids, { paidBy: req.technicianId });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// GET /api/admin/reviews/incentives/export — payroll-friendly CSV
router.get('/incentives/export', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const dashboard = await ReviewIncentives.getDashboard({ days });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=waves-review-incentives.csv');
    res.send(ReviewIncentives.toCsv(dashboard.payouts));
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/sync — manual sync
router.post('/sync', async (req, res, next) => {
  try {
    // If fresh=true, clear old synced reviews first (re-pull from Google)
    if (req.body?.fresh) {
      await db('google_reviews').where('google_review_id', 'like', 'places_%').del();
    }
    const result = await gbp.syncAllReviews();
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// =========================================================================
// GBP LOCATION DATA — via Places API
// =========================================================================

// GET /api/admin/reviews/gbp-locations — all location details from Places API
router.get('/gbp-locations', async (req, res, next) => {
  try {
    const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!GOOGLE_KEY) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });
    const fields = 'name,formatted_address,formatted_phone_number,opening_hours,website,photos,types,business_status,url,rating,user_ratings_total';

    const locations = [];
    for (const loc of WAVES_LOCATIONS) {
      if (!loc.googlePlaceId) continue;
      try {
        const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${loc.googlePlaceId}&fields=${fields}&key=${GOOGLE_KEY}`);
        const data = await r.json();
        if (data.status !== 'OK') continue;
        const p = data.result;

        // Build photo URLs
        const photos = (p.photos || []).map(photo => ({
          url: `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${photo.photo_reference}&key=${GOOGLE_KEY}`,
          width: photo.width,
          height: photo.height,
          attributions: photo.html_attributions,
        }));

        // Parse hours
        const hours = (p.opening_hours?.weekday_text || []);

        locations.push({
          id: loc.id,
          name: p.name,
          address: p.formatted_address,
          phone: p.formatted_phone_number,
          website: p.website,
          mapsUrl: p.url,
          status: p.business_status,
          rating: p.rating,
          totalReviews: p.user_ratings_total,
          types: p.types,
          hours,
          openNow: p.opening_hours?.open_now,
          photos,
          reviewUrl: loc.googleReviewUrl,
          placeId: loc.googlePlaceId,
        });
      } catch (err) {
        logger.error(`GBP location fetch failed for ${loc.name}: ${err.message}`);
      }
    }

    res.json({ locations });
  } catch (err) { next(err); }
});

// GET /api/admin/reviews/export — export reviews as CSV
router.get('/export', async (req, res, next) => {
  try {
    const reviews = await db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .orderBy('review_created_at', 'desc');

    const header = 'Location,Reviewer,Rating,Review Text,Reply,Review Date,Synced At\n';
    const rows = reviews.map(r => {
      const reply = isDraftReply(r.review_reply) ? '' : (r.review_reply || '');
      return `"${r.location_id}","${(r.reviewer_name || '').replace(/"/g, '""')}",${r.star_rating},"${(r.review_text || '').replace(/"/g, '""')}","${reply.replace(/"/g, '""')}","${r.review_created_at || ''}","${r.synced_at || ''}"`;
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=waves-reviews-export.csv');
    res.send(header + rows);
  } catch (err) { next(err); }
});

// =========================================================================
// REVIEW STATS — NPS, response times, conversion
// =========================================================================

// GET /api/admin/reviews/stats
router.get('/stats', async (req, res, next) => {
  try {
    // --- NPS from review_requests ---
    let npsScore = null;
    let npsCounts = { promoters: 0, passives: 0, detractors: 0, total: 0 };
    try {
      const npsRows = await db('review_requests')
        .where('status', 'submitted')
        .whereNotNull('category')
        .select('category')
        .count('* as count')
        .groupBy('category');

      for (const row of npsRows) {
        const c = parseInt(row.count);
        if (row.category === 'promoter') npsCounts.promoters = c;
        else if (row.category === 'passive') npsCounts.passives = c;
        else if (row.category === 'detractor') npsCounts.detractors = c;
      }
      npsCounts.total = npsCounts.promoters + npsCounts.passives + npsCounts.detractors;
      if (npsCounts.total > 0) {
        npsScore = Math.round(((npsCounts.promoters - npsCounts.detractors) / npsCounts.total) * 100);
      }
    } catch { /* review_requests table may not exist yet */ }

    // --- Avg response time (review_created_at to reply_updated_at) ---
    const responseTimes = await db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .whereNull('missing_since')
      .modify(whereHasRealReply)
      .whereNotNull('reply_updated_at')
      .whereNotNull('review_created_at')
      .select(
        db.raw("AVG(EXTRACT(EPOCH FROM (reply_updated_at - review_created_at)) / 3600) as avg_hours")
      )
      .first();
    const avgResponseHours = responseTimes?.avg_hours ? Math.round(parseFloat(responseTimes.avg_hours)) : null;

    // --- Unanswered > 24h ---
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600000).toISOString();
    const unansweredRow = await db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .modify(whereNeedsRealReply)
      // Removed reviews can't be answered — they'd sit in this metric forever.
      .whereNull('missing_since')
      .where('review_created_at', '<', twentyFourHoursAgo)
      .count('* as count')
      .first();
    const unansweredOver24h = parseInt(unansweredRow?.count || 0);

    // --- Monthly review counts (last 6 months) ---
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const monthlyCounts = await db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .whereNull('missing_since')
      .where('review_created_at', '>=', sixMonthsAgo.toISOString())
      .select(
        db.raw("TO_CHAR(review_created_at, 'YYYY-MM') as month"),
        db.raw('COUNT(*) as count'),
        db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating')
      )
      .groupByRaw("TO_CHAR(review_created_at, 'YYYY-MM')")
      .orderBy('month', 'asc');

    // --- Conversion rate (review requests sent vs submitted) ---
    let conversionRate = null;
    try {
      const conversionRow = await db('review_requests')
        .select(
          db.raw('COUNT(*) as total_sent'),
          db.raw("COUNT(*) FILTER (WHERE status = 'submitted') as total_submitted"),
          db.raw("COUNT(*) FILTER (WHERE category = 'promoter') as promoters_total"),
          db.raw("COUNT(*) FILTER (WHERE google_review_clicked = true) as clicked_google")
        )
        .first();
      const totalSent = parseInt(conversionRow?.total_sent || 0);
      const totalSubmitted = parseInt(conversionRow?.total_submitted || 0);
      const clickedGoogle = parseInt(conversionRow?.clicked_google || 0);
      conversionRate = {
        totalSent,
        totalSubmitted,
        submissionRate: totalSent > 0 ? Math.round((totalSubmitted / totalSent) * 100) : 0,
        googleClicks: clickedGoogle,
        googleConversion: totalSent > 0 ? Math.round((clickedGoogle / totalSent) * 100) : 0,
      };
    } catch { /* table may not exist */ }

    // --- Rating breakdown ---
    const breakdown = await db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .whereNull('missing_since')
      .select('star_rating')
      .count('* as count')
      .groupBy('star_rating')
      .orderBy('star_rating', 'desc');

    res.json({
      nps: { score: npsScore, ...npsCounts },
      avgResponseHours,
      unansweredOver24h,
      monthlyCounts: monthlyCounts.map(m => ({ month: m.month, count: parseInt(m.count), avgRating: parseFloat(m.avg_rating) })),
      conversionRate,
      ratingBreakdown: Object.fromEntries(breakdown.map(b => [b.star_rating, parseInt(b.count)])),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// QR CODE — generate QR for a location's review page
// =========================================================================

// GET /api/admin/reviews/qr/:locationId
router.get('/qr/:locationId', async (req, res, next) => {
  try {
    const loc = WAVES_LOCATIONS.find(l => l.id === req.params.locationId);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const reviewUrl = loc.googleReviewUrl;

    // QR via the QR Server API — avoids adding a QR library dependency.
    // (Google Image Charts, the previous primary, was retired and returned
    // 404s — review audit 2026-08-07. qrImageUrlAlt used to carry this same
    // qrserver URL; collapsed since the primary now IS the working one.)
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(reviewUrl)}`;

    const { format } = req.query;

    if (format === 'redirect') {
      return res.redirect(qrApiUrl);
    }

    // Default: return JSON with the QR image URL and review URL
    res.json({
      locationId: loc.id,
      locationName: loc.name,
      reviewUrl,
      qrImageUrl: qrApiUrl,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// Competitor Review Tracking
// ─────────────────────────────────────────────────────────────
const CompetitorTracker = require('../services/competitor-tracker');

// GET /competitors — list tracked competitors
router.get('/competitors', async (req, res, next) => {
  try {
    const rows = await db('competitor_businesses')
      .where({ active: true })
      .orderBy('name', 'asc');
    res.json({ competitors: rows });
  } catch (err) { next(err); }
});

// POST /competitors — add a competitor to track
// Body: { name, googlePlaceId, market?, category?, notes? }
router.post('/competitors', async (req, res, next) => {
  try {
    const { name, googlePlaceId, market, category, notes } = req.body || {};
    if (!name || !googlePlaceId) return res.status(400).json({ error: 'name and googlePlaceId required' });

    const [row] = await db('competitor_businesses').insert({
      name, google_place_id: googlePlaceId, market: market || null,
      category: category || null, notes: notes || null,
    }).returning('*');

    // Do an initial sync immediately
    try { await CompetitorTracker.syncOne(row.id); } catch (e) {
      logger.error(`[admin-reviews] initial competitor sync failed: ${e.message}`);
    }
    const refreshed = await db('competitor_businesses').where({ id: row.id }).first();
    res.status(201).json(refreshed);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Competitor already tracked' });
    next(err);
  }
});

// DELETE /competitors/:id — soft-remove (sets active=false)
router.delete('/competitors/:id', async (req, res, next) => {
  try {
    await db('competitor_businesses').where({ id: req.params.id }).update({ active: false, updated_at: db.fn.now() });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /competitors/:id/sync — refresh a single competitor from Places API
router.post('/competitors/:id/sync', async (req, res, next) => {
  try {
    const details = await CompetitorTracker.syncOne(req.params.id);
    res.json({ success: true, details });
  } catch (err) { next(err); }
});

// POST /competitors/sync-all — refresh every active competitor
router.post('/competitors/sync-all', async (req, res, next) => {
  try {
    const result = await CompetitorTracker.syncAll();
    res.json(result);
  } catch (err) { next(err); }
});

// GET /competitors/market-position — Waves vs competitor aggregate
router.get('/competitors/market-position', async (req, res, next) => {
  try {
    const pos = await CompetitorTracker.getMarketPosition();
    res.json(pos);
  } catch (err) { next(err); }
});

// GET /competitors/:id/history — trend of rating/review_count over time
router.get('/competitors/:id/history', async (req, res, next) => {
  try {
    const { days = 90 } = req.query;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - parseInt(days));
    const rows = await db('competitor_review_cache')
      .where({ competitor_id: req.params.id })
      .where('snapshot_date', '>=', cutoff.toISOString().split('T')[0])
      .orderBy('snapshot_date', 'asc')
      .select('snapshot_date', 'rating', 'review_count');
    res.json({ history: rows });
  } catch (err) { next(err); }
});

// Export createReviewRequest for use by other modules (e.g., admin-schedule auto-send)
router.createReviewRequest = createReviewRequest;

module.exports = router;
