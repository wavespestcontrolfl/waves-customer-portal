const express = require('express');
const router = express.Router();
const db = require('../models/db');
const gbp = require('../services/google-business');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { WAVES_LOCATIONS } = require('../config/locations');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/reviews — all reviews with filters
router.get('/', async (req, res, next) => {
  try {
    const { location, rating, responded, search, page = 1, limit = 30 } = req.query;

    // Exclude stats rows from actual reviews
    let query = db('google_reviews')
      .leftJoin('customers', 'google_reviews.customer_id', 'customers.id')
      .where('google_reviews.reviewer_name', '!=', '_stats')
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

    // Get real Google stats from Places API (stored during sync)
    const statsRows = await db('google_reviews').where({ reviewer_name: '_stats' });
    const googleStats = {};
    for (const row of statsRows) {
      try {
        const parsed = JSON.parse(row.review_text);
        googleStats[row.location_id] = { rating: parsed.rating, totalReviews: parsed.totalReviews };
      } catch { /* ignore */ }
    }

    // Aggregate stats from actual reviews (excluding _stats rows)
    const reviewsOnly = db('google_reviews').where('reviewer_name', '!=', '_stats');
    const [totals, unresponded, thisMonth, perLocation] = await Promise.all([
      reviewsOnly.clone().select(
        db.raw('COUNT(*) as total'),
        db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating'),
      ).first(),
      reviewsOnly.clone().whereNull('review_reply').whereNotNull('review_text').count('* as count').first(),
      reviewsOnly.clone().where('review_created_at', '>=', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()).count('* as count').first(),
      reviewsOnly.clone().select('location_id')
        .count('* as count')
        .avg('star_rating as avg')
        .groupBy('location_id'),
    ]);

    // Star breakdown (exclude stats rows)
    const breakdown = await db('google_reviews').where('reviewer_name', '!=', '_stats').select('star_rating').count('* as count').groupBy('star_rating').orderBy('star_rating', 'desc');

    // Use Google's real totals if available
    const totalGoogleReviews = Object.values(googleStats).reduce((s, g) => s + (g.totalReviews || 0), 0);
    const avgGoogleRating = Object.values(googleStats).length > 0
      ? (Object.values(googleStats).reduce((s, g) => s + (g.rating || 0), 0) / Object.values(googleStats).filter(g => g.rating).length).toFixed(1)
      : parseFloat(totals?.avg_rating || 0);

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
        avgRating: parseFloat(avgGoogleRating) || parseFloat(totals?.avg_rating || 0),
        unresponded: parseInt(unresponded?.count || 0),
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

    // Try to post to Google
    if (gbp.configured && review.google_review_id) {
      try {
        await gbp.replyToReview(review.google_review_id, replyText, review.location_id);
      } catch (e) {
        logger.error(`Google reply failed: ${e.message}`);
        // Still save locally even if Google API fails
      }
    }

    await db('google_reviews').where({ id: req.params.id }).update({
      review_reply: replyText, reply_updated_at: db.fn.now(),
    });

    await db('activity_log').insert({
      admin_user_id: req.technicianId, action: 'review_replied',
      description: `Replied to ${review.star_rating}-star review from ${review.reviewer_name} on ${review.location_id}`,
    });

    res.json({ success: true });
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
      model: 'claude-sonnet-4-20250514',
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
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

    // Active customers with completed services in last 30 days who haven't left a review
    const customers = await db('customers')
      .where('customers.active', true)
      .whereExists(function () {
        this.select(db.raw(1)).from('scheduled_services')
          .whereRaw('scheduled_services.customer_id = customers.id')
          .where('scheduled_services.status', 'completed')
          .where('scheduled_services.scheduled_date', '>=', thirtyDaysAgo);
      })
      .whereNotExists(function () {
        this.select(db.raw(1)).from('google_reviews')
          .whereRaw('google_reviews.customer_id = customers.id');
      })
      .select('customers.id', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.city', 'customers.waveguard_tier', 'customers.nearest_location_id')
      .orderBy('customers.last_contact_date', 'desc')
      .limit(100);

    // Get last service for each customer
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

    // Check if review request was already sent (via sms_log)
    const sentRequests = customerIds.length > 0
      ? await db('sms_log')
          .whereIn('customer_id', customerIds)
          .where('message_type', 'review_request')
          .select('customer_id')
      : [];
    const sentSet = new Set(sentRequests.map(s => s.customer_id));

    res.json({
      customers: customers.map(c => {
        const ls = lastSvcMap[c.id];
        return {
          id: c.id,
          name: `${c.first_name} ${c.last_name}`,
          phone: c.phone,
          city: c.city,
          tier: c.waveguard_tier,
          locationId: c.nearest_location_id,
          lastService: ls?.service_type || null,
          lastServiceDate: ls?.scheduled_date || null,
          requestSent: sentSet.has(c.id),
        };
      }),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/reviews/send-request — send review request SMS to customer
router.post('/send-request', async (req, res, next) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const loc = WAVES_LOCATIONS.find(l => l.id === customer.nearest_location_id) || WAVES_LOCATIONS[0];
    const firstName = customer.first_name || 'there';
    const reviewUrl = loc.googleReviewUrl || 'https://g.page/r/CRkzS6M4EpncEBM/review';

    const TwilioService = require('../services/twilio');
    await TwilioService.sendSMS(customer.phone,
      `Hi ${firstName}! Adam here with Waves Pest Control. Just checking in — hope everything's been great since our last visit.\n\nIf you've been happy with the service, a quick Google review would really help us out:\n\n${reviewUrl}\n\nThanks so much!`,
      { customerId: customer.id, messageType: 'review_request', customerLocationId: customer.nearest_location_id }
    );

    await db('activity_log').insert({
      customer_id: customer.id, action: 'review_requested',
      description: `Review request sent to ${customer.first_name} ${customer.last_name} (${loc.name})`,
    });

    res.json({ success: true });
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

module.exports = router;
