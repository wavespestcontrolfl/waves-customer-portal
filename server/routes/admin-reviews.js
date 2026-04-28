const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const gbp = require('../services/google-business');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { WAVES_LOCATIONS } = require('../config/locations');
const logger = require('../services/logger');
const MODELS = require('../config/models');
const { etDateString, addETDays } = require('../utils/datetime-et');

const PORTAL_DOMAIN = process.env.PORTAL_DOMAIN || 'portal.wavespestcontrol.com';

/**
 * Generate a unique review request token and create a review_requests record.
 * Returns the created record.
 */
async function createReviewRequest({ customerId, locationId, techName, serviceType, serviceDate }) {
  const token = crypto.randomBytes(24).toString('base64url'); // 32 chars, URL-safe
  const expiresAt = new Date(Date.now() + 14 * 86400000); // 14 days

  const [record] = await db('review_requests').insert({
    customer_id: customerId,
    token,
    location_id: locationId,
    tech_name: techName || null,
    service_type: serviceType || null,
    service_date: serviceDate || null,
    status: 'pending',
    sent_at: db.fn.now(),
    expires_at: expiresAt.toISOString(),
  }).returning('*');

  return record;
}

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/reviews — all reviews with filters
router.get('/', async (req, res, next) => {
  try {
    const { location, rating, responded, search, page = 1, limit = 30 } = req.query;

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
      .modify(qb => { if (!showDismissed) qb.where(function() { this.where('google_reviews.dismissed', false).orWhereNull('google_reviews.dismissed'); }); })
      .select(
        'google_reviews.*',
        'customers.first_name as cust_first', 'customers.last_name as cust_last',
        'customers.waveguard_tier as cust_tier'
      )
      .orderBy('google_reviews.review_created_at', 'desc');

    if (location) query = query.where('google_reviews.location_id', location);
    if (rating) query = query.where('google_reviews.star_rating', parseInt(rating));
    if (responded === 'true') query = query.whereNotNull('google_reviews.review_reply');
    if (responded === 'false') query = query.whereNull('google_reviews.review_reply');
    if (search) query = query.where(function () {
      this.whereILike('google_reviews.reviewer_name', `%${search}%`)
        .orWhereILike('google_reviews.review_text', `%${search}%`);
    });

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const reviews = await query.limit(parseInt(limit)).offset(offset);

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
        googleStats[row.location_id] = { rating: parsed.rating, totalReviews: parsed.totalReviews, syncedAt: row.synced_at };
      } catch { /* ignore */ }
    }

    // Aggregate stats from actual reviews (excluding _stats rows).
    // Scoped to currently-configured WAVES_LOCATIONS so unreplied reviews
    // from retired/renamed GBPs don't pad the unresponded count and
    // skew the response-rate math (denominator already excludes them).
    const reviewsOnly = db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .whereIn('location_id', activeLocationIds);
    const [totals, unresponded, respondedCountRow, thisMonth, perLocation] = await Promise.all([
      reviewsOnly.clone().select(
        db.raw('COUNT(*) as total'),
        db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating'),
      ).first(),
      reviewsOnly.clone().whereNull('review_reply').count('* as count').first(),
      reviewsOnly.clone().whereNotNull('review_reply').count('* as count').first(),
      reviewsOnly.clone().where('review_created_at', '>=', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()).count('* as count').first(),
      reviewsOnly.clone().select('location_id')
        .count('* as count')
        .avg('star_rating as avg')
        .groupBy('location_id'),
    ]);

    // Star breakdown (exclude stats rows; scope to active locations).
    const breakdown = await db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .whereIn('location_id', activeLocationIds)
      .select('star_rating').count('* as count')
      .groupBy('star_rating').orderBy('star_rating', 'desc');

    // Use Google's real totals if available
    const totalGoogleReviews = Object.values(googleStats).reduce((s, g) => s + (g.totalReviews || 0), 0);

    // For the response-rate calc, the numerator and denominator must come
    // from the same population. `totalGoogleReviews` only sums locations
    // that have a `_stats` row, so scope the unresponded count we expose
    // for the rate-calc denominator to those same locations. Otherwise a
    // location with reviews-but-no-_stats would inflate `unresponded`
    // without contributing to the total, breaking `total - unresponded`.
    const ratedLocationIds = Object.keys(googleStats).filter(id => (googleStats[id]?.totalReviews || 0) > 0);
    const unrespondedInRatedRow = ratedLocationIds.length > 0
      ? await reviewsOnly.clone().whereIn('location_id', ratedLocationIds).whereNull('review_reply').count('* as count').first()
      : { count: 0 };
    const avgGoogleRating = Object.values(googleStats).length > 0
      ? (Object.values(googleStats).reduce((s, g) => s + (g.rating || 0), 0) / Object.values(googleStats).filter(g => g.rating).length).toFixed(1)
      : parseFloat(totals?.avg_rating || 0);
    // True only when every currently-configured location has a `_stats`
    // row whose synced_at is recent. Places sync runs hourly and
    // swallows per-location errors (services/google-business.js
    // syncAllReviews), so a stale row from a previous successful run
    // can outlive the failure. We check each WAVES_LOCATIONS ID
    // explicitly (rather than aggregate row counts) so a stale row from
    // a retired location can't satisfy the count while a newly added
    // location has no row yet. The 24h window absorbs transient sync
    // hiccups; once any configured location goes a full day without a
    // fresh _stats write, the client falls back to the
    // responded+unresponded denominator.
    const STATS_FRESH_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const isFresh = (locId) => {
      const g = googleStats[locId];
      if (!g?.syncedAt) return false;
      const t = new Date(g.syncedAt).getTime();
      return t > 0 && (now - t) <= STATS_FRESH_MS;
    };
    const googleStatsComplete = WAVES_LOCATIONS.every(loc => isFresh(loc.id));

    res.json({
      reviews: reviews.map(r => ({
        id: r.id, googleReviewId: r.google_review_id, locationId: r.location_id,
        reviewerName: r.reviewer_name, reviewerPhoto: r.reviewer_photo_url,
        starRating: r.star_rating, reviewText: r.review_text,
        reply: r.review_reply, replyUpdatedAt: r.reply_updated_at,
        reviewCreatedAt: r.review_created_at,
        matchedCustomer: r.cust_first ? { name: `${r.cust_first} ${r.cust_last}`, tier: r.cust_tier, id: r.customer_id } : null,
        syncedAt: r.synced_at,
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
        perLocation: perLocation.map(l => {
          const gs = googleStats[l.location_id];
          return {
            locationId: l.location_id,
            count: gs?.totalReviews || parseInt(l.count),
            avgRating: gs?.rating?.toFixed(1) || parseFloat(l.avg || 0).toFixed(1),
          };
        }),
      },
      locations: WAVES_LOCATIONS.map(l => ({ id: l.id, name: l.name, reviewUrl: l.googleReviewUrl })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/:id/reply — reply to a review
router.post('/:id/reply', async (req, res, next) => {
  try {
    const { replyText } = req.body;
    if (!replyText) return res.status(400).json({ error: 'Reply text required' });

    const review = await db('google_reviews').where({ id: req.params.id }).first();
    if (!review) return res.status(404).json({ error: 'Review not found' });

    // Try to post reply to Google
    let googlePosted = false;
    if (gbp.configured) {
      let resourceName = review.gbp_review_name;

      // If no GBP resource name stored, try to resolve it now
      if (!resourceName && review.location_id) {
        try {
          const { WAVES_LOCATIONS } = require('../config/locations');
          const loc = WAVES_LOCATIONS.find(l => l.id === review.location_id);
          if (loc?.googleLocationResourceName) {
            const gbpReviews = await gbp.getReviews(loc.googleLocationResourceName, review.location_id, 100);
            const match = gbpReviews.find(g => {
              const gName = (g.reviewer?.displayName || '').toLowerCase();
              const rName = (review.reviewer_name || '').toLowerCase();
              return gName === rName;
            });
            if (match?.name) {
              resourceName = match.name;
              await db('google_reviews').where({ id: req.params.id }).update({ gbp_review_name: resourceName });
            }
          }
        } catch (lookupErr) {
          logger.warn(`GBP resource name lookup failed: ${lookupErr.message}`);
        }
      }

      if (resourceName) {
        try {
          await gbp.replyToReview(resourceName, replyText, review.location_id);
          googlePosted = true;
        } catch (e) {
          logger.error(`Google reply failed: ${e.message}`);
        }
      } else {
        logger.warn(`No GBP resource name for review ${req.params.id} — reply saved locally only`);
      }
    }

    await db('google_reviews').where({ id: req.params.id }).update({
      review_reply: replyText, reply_updated_at: db.fn.now(),
    });

    await db('activity_log').insert({
      admin_user_id: req.technicianId, action: 'review_replied',
      description: `Replied to ${review.star_rating}-star review from ${review.reviewer_name} on ${review.location_id}`,
    });

    res.json({ success: true, googlePosted });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/:id/dismiss — dismiss a review from dashboard
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    await db('google_reviews').where({ id: req.params.id }).update({ dismissed: true });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/dismiss-batch — dismiss multiple reviews
router.post('/dismiss-batch', async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'No IDs provided' });
    await db('google_reviews').whereIn('id', ids).update({ dismissed: true });
    res.json({ success: true, dismissed: ids.length });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/:id/ai-reply — generate AI reply using Claude
router.post('/:id/ai-reply', async (req, res, next) => {
  try {
    const review = await db('google_reviews').where({ id: req.params.id }).first();
    if (!review) return res.status(404).json({ error: 'Review not found' });

    const loc = WAVES_LOCATIONS.find(l => l.id === review.location_id) || WAVES_LOCATIONS[0];
    const locationName = loc.name;

    // Try to find customer city
    let customerCity = '';
    if (review.customer_id) {
      const cust = await db('customers').where({ id: review.customer_id }).first();
      if (cust) customerCity = cust.city || '';
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const prompt = `You are an expert in local business reputation management and are writing a personalized response on behalf of Waves Pest Control ${locationName}, a family-owned pest control & lawn care company serving ${locationName} and neighboring cities.

Your response must strictly adhere to Google's best practices, be limited to a maximum of two paragraphs, and be written in the first person plural (using "we" and "our").

Input Data
Review Text: ${review.review_text || '(No comment — just a star rating)'}
Reviewer Name: ${review.reviewer_name}
Star Rating: ${review.star_rating}/5
Customer City: ${customerCity}

Instructions for Generating the Response
Greeting & Personalization:
- Start the response with a warm, human greeting.
- If the reviewer's name is a common English first name (e.g., John, Lisa, Michael), greet them with: "Hello [First Name]!"
- If the name is uncommon, use: "Hey there!" or "Hello there!".

Core Content & Keyword Integration (Paragraph 1):
- Tone: Write with a genuine, approachable, and slightly conversational tone, using "we" and "our" consistently.
- Review with Comment: We must thank the reviewer and specifically comment on the subject of their review. Naturally weave in one or two high-value search terms relevant to the local homeowner (e.g., "general pest control," "rodent removal," or "reliable scheduling") without sounding robotic.
- Review with NO Comment (Just Stars): If the review text is empty, we must generate a brief, sincere thank you for their rating, focusing on our commitment as a local pest & lawn company. Do not reference a specific service.

Brand Differentiation & Localization (Paragraph 2):
- Localization Logic: If the Customer City is provided, we must reference our service in that specific city (e.g., "We are glad our team could deliver excellent service in ${customerCity || 'Sarasota'}!"). If the Customer City data is empty, default the reference to: "Southwest Florida."
- Commitment: Briefly highlight our commitment to effective pest management and our "neighborly" approach.
- Uniqueness: Ensure the entire response is completely unique and does not repeat phrasing or structure from previous responses.

Closing & Format:
- Conclude with a warm, sincere closing statement that acts as a final expression of gratitude or soft call to action.
- Strictly enforce the two-paragraph limit.
- Signature: The response must end with the exact sign-off on a separate paragraph:

The 🌊 Waves Pest Control ${locationName} Team

Generate the reply now.`;

    const msg = await client.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const reply = msg.content[0]?.text || '';
    res.json({ reply });
  } catch (err) {
    logger.error(`AI reply generation failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/reviews/outreach-candidates — customers eligible for review request
router.get('/outreach-candidates', async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 90));
    const windowStart = etDateString(addETDays(new Date(), -days));

    // Active customers with completed services inside window who haven't left a review
    const customers = await db('customers')
      .where('customers.active', true)
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
        'customers.address_line1',
        'customers.city',
        'customers.zip',
        'customers.waveguard_tier',
        'customers.nearest_location_id',
        'customers.lifetime_revenue'
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

    // Aggregate review_request SMS history (count + most recent) per customer
    const askStats = customerIds.length > 0
      ? await db('sms_log')
          .whereIn('customer_id', customerIds)
          .where('message_type', 'review_request')
          .groupBy('customer_id')
          .select('customer_id')
          .count({ askCount: '*' })
          .max({ lastAsked: 'created_at' })
      : [];
    const askMap = {};
    askStats.forEach(a => {
      askMap[a.customer_id] = { askCount: Number(a.askCount) || 0, lastAsked: a.lastAsked };
    });

    res.json({
      customers: customers.map(c => {
        const ls = lastSvcMap[c.id];
        const ask = askMap[c.id] || { askCount: 0, lastAsked: null };
        return {
          id: c.id,
          name: `${c.first_name} ${c.last_name}`,
          firstName: c.first_name,
          lastName: c.last_name,
          phone: c.phone,
          addressLine1: c.address_line1,
          city: c.city,
          zip: c.zip,
          tier: c.waveguard_tier,
          locationId: c.nearest_location_id,
          lifetimeRevenue: Number(c.lifetime_revenue) || 0,
          lastService: ls?.service_type || null,
          lastServiceDate: ls?.scheduled_date || null,
          askCount: ask.askCount,
          lastAsked: ask.lastAsked,
          requestSent: ask.askCount > 0,
        };
      }),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/send-request — send review request SMS with NPS gate
router.post('/send-request', async (req, res, next) => {
  try {
    const { customerId, serviceType, techName } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const loc = WAVES_LOCATIONS.find(l => l.id === customer.nearest_location_id) || WAVES_LOCATIONS[0];
    const firstName = customer.first_name || 'there';

    // Get last completed service for context
    const lastSvc = await db('scheduled_services')
      .where({ customer_id: customerId, status: 'completed' })
      .orderBy('scheduled_date', 'desc').first();

    // Create a review_requests record with a unique token
    const reviewReq = await createReviewRequest({
      customerId: customer.id,
      locationId: loc.id,
      techName: techName || lastSvc?.tech_name || null,
      serviceType: serviceType || lastSvc?.service_type || 'pest control',
      serviceDate: lastSvc?.scheduled_date || null,
    });

    const rateUrl = `https://${PORTAL_DOMAIN}/rate/${reviewReq.token}`;
    const svcLabel = reviewReq.service_type || 'pest control service';

    const TwilioService = require('../services/twilio');
    await TwilioService.sendSMS(customer.phone,
      `Hey ${firstName}! Thanks for choosing Waves 🌊 We'd love to hear how your ${svcLabel} went — it only takes 10 seconds:\n\n${rateUrl}\n\nThank you! — Waves Pest Control`,
      { customerId: customer.id, messageType: 'review_request', customerLocationId: customer.nearest_location_id }
    );

    await db('activity_log').insert({
      customer_id: customer.id, action: 'review_requested',
      description: `Review request sent to ${customer.first_name} ${customer.last_name} (${loc.name}) — token: ${reviewReq.token.slice(0, 8)}...`,
    });

    res.json({ success: true, token: reviewReq.token });
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
    const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCvzQ84QWUKMby5YcbM8MhDBlEZ2oF7Bsk';
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
    const rows = reviews.map(r =>
      `"${r.location_id}","${(r.reviewer_name || '').replace(/"/g, '""')}",${r.star_rating},"${(r.review_text || '').replace(/"/g, '""')}","${(r.review_reply || '').replace(/"/g, '""')}","${r.review_created_at || ''}","${r.synced_at || ''}"`
    ).join('\n');

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
      .whereNotNull('review_reply')
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
      .whereNull('review_reply')
      .where('review_created_at', '<', twentyFourHoursAgo)
      .count('* as count')
      .first();
    const unansweredOver24h = parseInt(unansweredRow?.count || 0);

    // --- Monthly review counts (last 6 months) ---
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const monthlyCounts = await db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
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

    // Generate QR code SVG using a lightweight approach via Google Charts API
    // This avoids adding a QR library dependency
    const qrApiUrl = `https://chart.googleapis.com/chart?cht=qr&chs=400x400&chl=${encodeURIComponent(reviewUrl)}&choe=UTF-8`;

    // Return the URL and also an inline SVG-compatible data URI
    // For direct embedding, use the Google Charts URL
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
      // Also provide a self-hosted version via QR Server API (no Google dependency)
      qrImageUrlAlt: `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(reviewUrl)}`,
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
