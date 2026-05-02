/**
 * Intelligence Bar — Review & Reputation Tools
 * server/services/intelligence-bar/review-tools.js
 *
 * Tools for managing Google reviews, AI reply drafting,
 * review request outreach, and review velocity tracking.
 */

const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const REVIEW_TOOLS = [
  {
    name: 'get_review_stats',
    description: `Get review overview: total reviews, avg rating, breakdown by stars, per-location stats, unresponded count, response rate, new this month.
Use for: "how are our reviews?", "what's our Google rating?", "which location has the most reviews?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_unresponded_reviews',
    description: `Get reviews that need a reply. Prioritizes low-star reviews first. Shows reviewer name, text, rating, location, date.
Use for: "any reviews need replies?", "show me unanswered reviews", "any negative reviews we haven't responded to?"`,
    input_schema: {
      type: 'object',
      properties: {
        max_rating: { type: 'number', description: 'Only show reviews at or below this rating (e.g. 3 for negative)' },
        location: { type: 'string', description: 'Filter by location ID' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'draft_review_reply',
    description: `Generate an AI-written reply for a specific Google review. Returns a draft for operator approval — does NOT post it automatically.
Use for: "draft a reply for the Smith review", "write a response to that 3-star review"`,
    input_schema: {
      type: 'object',
      properties: {
        review_id: { type: 'string', description: 'Review UUID' },
      },
      required: ['review_id'],
    },
  },
  {
    name: 'submit_review_reply',
    description: `Post a reply to a Google review. ALWAYS show the draft and ask for confirmation first.
Use for: "post that reply", "send the response I just approved"`,
    input_schema: {
      type: 'object',
      properties: {
        review_id: { type: 'string' },
        reply_text: { type: 'string', description: 'The reply to post' },
      },
      required: ['review_id', 'reply_text'],
    },
  },
  {
    name: 'get_outreach_candidates',
    description: `Find customers who are good candidates for a review request: recently serviced, active, no existing review, not over-asked.
Use for: "who should we ask for reviews?", "review request candidates", "eligible customers for outreach"`,
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'Filter by location/zone' },
        min_tier: { type: 'string', enum: ['Bronze', 'Silver', 'Gold', 'Platinum'], description: 'Only customers at or above this tier' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'trigger_review_request',
    description: `Send a review request SMS to a customer. Creates a review_request record and triggers the SMS flow.
ALWAYS confirm with the operator before sending.
Use for: "send a review request to Smith", "ask Henderson for a review"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        customer_name: { type: 'string', description: 'Alternative: find by name' },
      },
    },
  },
  {
    name: 'search_reviews',
    description: `Search reviews by text, reviewer name, rating, or location.
Use for: "find reviews mentioning lawn care", "show me all 1-star reviews", "reviews from Lakewood Ranch location"`,
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Text search in review content or reviewer name' },
        rating: { type: 'number', description: 'Filter by exact star rating (1-5)' },
        location: { type: 'string' },
        responded: { type: 'boolean', description: 'true=has reply, false=no reply' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_review_trends',
    description: `Analyze review trends over time: reviews per month, average rating trend, response rate trend.
Use for: "are our reviews improving?", "review trend over the last 6 months", "is our response rate going up?"`,
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'number', description: 'How many months back (default 6)' },
      },
    },
  },
  {
    name: 'get_velocity_pipeline',
    description: `Get the review request velocity pipeline: how many requests sent, reminded, converted to reviews, declined. Shows conversion rates.
Use for: "how's our review velocity?", "what's the conversion rate on review requests?", "outreach pipeline stats"`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look back N days (default 30)' },
      },
    },
  },
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeReviewTool(toolName, input) {
  try {
    switch (toolName) {
      case 'get_review_stats': return await getReviewStats();
      case 'get_unresponded_reviews': return await getUnrespondedReviews(input);
      case 'draft_review_reply': return await draftReviewReply(input.review_id);
      case 'submit_review_reply': return await submitReviewReply(input.review_id, input.reply_text);
      case 'get_outreach_candidates': return await getOutreachCandidates(input);
      case 'trigger_review_request': return await triggerReviewRequest(input);
      case 'search_reviews': return await searchReviews(input);
      case 'get_review_trends': return await getReviewTrends(input.months || 6);
      case 'get_velocity_pipeline': return await getVelocityPipeline(input.days || 30);
      default: return { error: `Unknown review tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:reviews] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function getReviewStats() {
  const reviews = db('google_reviews').where('reviewer_name', '!=', '_stats');

  const [totals, unresponded, thisMonth, perLocation, breakdown] = await Promise.all([
    reviews.clone().select(db.raw('COUNT(*) as total'), db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating')).first(),
    reviews.clone().whereNull('review_reply').whereNotNull('review_text').count('* as count').first(),
    reviews.clone().where('review_created_at', '>=', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()).count('* as count').first(),
    reviews.clone().select('location_id', db.raw('COUNT(*) as count'), db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating')).groupBy('location_id'),
    reviews.clone().select('star_rating', db.raw('COUNT(*) as count')).groupBy('star_rating').orderBy('star_rating', 'desc'),
  ]);

  const total = parseInt(totals?.total || 0);
  const responded = total - parseInt(unresponded?.count || 0);
  const responseRate = total > 0 ? Math.round(responded / total * 100) : 0;

  const starBreakdown = {};
  breakdown.forEach(b => { starBreakdown[b.star_rating] = parseInt(b.count); });

  return {
    total_reviews: total,
    avg_rating: parseFloat(totals?.avg_rating || 0),
    unresponded: parseInt(unresponded?.count || 0),
    new_this_month: parseInt(thisMonth?.count || 0),
    response_rate: responseRate,
    star_breakdown: starBreakdown,
    per_location: perLocation.map(l => ({
      location: l.location_id,
      count: parseInt(l.count),
      avg_rating: parseFloat(l.avg_rating),
    })),
  };
}


async function getUnrespondedReviews(input) {
  const { max_rating, location, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 10, 50);

  let query = db('google_reviews')
    .where('reviewer_name', '!=', '_stats')
    .whereNull('review_reply')
    .whereNotNull('review_text')
    .leftJoin('customers', 'google_reviews.customer_id', 'customers.id')
    .select('google_reviews.*', 'customers.first_name as cust_first', 'customers.last_name as cust_last', 'customers.waveguard_tier')
    .orderBy('star_rating', 'asc') // Low stars first (priority)
    .orderBy('review_created_at', 'desc');

  if (max_rating) query = query.where('star_rating', '<=', max_rating);
  if (location) query = query.where('location_id', location);

  const reviews = await query.limit(limit);

  return {
    unresponded: reviews.map(r => ({
      id: r.id,
      reviewer: r.reviewer_name,
      rating: r.star_rating,
      text: r.review_text,
      location: r.location_id,
      date: r.review_created_at,
      matched_customer: r.cust_first ? `${r.cust_first} ${r.cust_last}` : null,
      customer_tier: r.waveguard_tier,
    })),
    total: reviews.length,
    priority_note: max_rating ? `Showing reviews rated ${max_rating} stars or below` : 'Sorted by rating (lowest first)',
  };
}


async function draftReviewReply(reviewId) {
  const review = await db('google_reviews').where('id', reviewId).first();
  if (!review) return { error: 'Review not found' };

  // Get location name
  let locationName = 'Southwest Florida';
  try {
    const { WAVES_LOCATIONS } = require('../../config/locations');
    const loc = WAVES_LOCATIONS.find(l => l.id === review.location_id);
    if (loc) locationName = loc.name;
  } catch {}

  // Get customer city if matched
  let customerCity = '';
  if (review.customer_id) {
    const cust = await db('customers').where('id', review.customer_id).first();
    if (cust) customerCity = cust.city || '';
  }

  const Anthropic = require('@anthropic-ai/sdk');
  if (!process.env.ANTHROPIC_API_KEY) return { error: 'ANTHROPIC_API_KEY not set' };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Write a Google review reply for Waves Pest Control ${locationName}.

Review by: ${review.reviewer_name}
Rating: ${review.star_rating}/5
Text: ${review.review_text || '(No comment — just a star rating)'}
Customer city: ${customerCity || 'unknown'}

Rules:
- Max 2 paragraphs, warm and genuine
- Use "we" and "our" (first person plural)
- For low ratings: acknowledge concern, offer to make it right
- For high ratings: thank specifically, mention local connection
- Naturally include 1-2 service keywords (pest control, lawn care)
- End with: The 🌊 Waves Pest Control ${locationName} Team`
    }],
  });

  const draft = msg.content[0]?.text || '';

  return {
    draft: true,
    review_id: reviewId,
    reviewer: review.reviewer_name,
    rating: review.star_rating,
    review_text: review.review_text,
    reply_draft: draft,
    note: 'This is a DRAFT. Say "post it" or "send it" to submit, or "revise it" to regenerate.',
  };
}


async function submitReviewReply(reviewId, replyText) {
  const review = await db('google_reviews').where('id', reviewId).first();
  if (!review) return { error: 'Review not found' };

  await db('google_reviews').where('id', reviewId).update({
    review_reply: replyText,
    reply_updated_at: new Date(),
  });

  logger.info(`[intelligence-bar:reviews] Posted reply to review ${reviewId} by ${review.reviewer_name}`);

  return {
    success: true,
    review_id: reviewId,
    reviewer: review.reviewer_name,
    note: 'Reply saved. It will be visible on Google once synced via the GBP API.',
  };
}


async function getOutreachCandidates(input) {
  const { location, min_tier, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 100);
  const thirtyDaysAgo = etDateString(addETDays(new Date(), -30));

  let query = db('customers')
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
    .select('customers.id', 'customers.first_name', 'customers.last_name',
      'customers.phone', 'customers.city', 'customers.waveguard_tier');

  if (location) query = query.whereILike('customers.city', `%${location}%`);
  if (min_tier) {
    const tierOrder = { Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };
    const minVal = tierOrder[min_tier] || 1;
    query = query.whereIn('customers.waveguard_tier', Object.entries(tierOrder).filter(([, v]) => v >= minVal).map(([k]) => k));
  }

  const customers = await query.orderBy('customers.waveguard_tier', 'desc').limit(limit);

  // Check if review request was already sent
  const ids = customers.map(c => c.id);
  const sentRequests = ids.length > 0
    ? await db('review_requests').whereIn('customer_id', ids).select('customer_id', 'status')
    : [];
  const sentMap = {};
  sentRequests.forEach(r => { sentMap[r.customer_id] = r.status; });

  return {
    candidates: customers.map(c => ({
      id: c.id,
      name: `${c.first_name} ${c.last_name}`,
      phone: c.phone,
      city: c.city,
      tier: c.waveguard_tier,
      already_asked: sentMap[c.id] || null,
    })),
    total: customers.length,
  };
}


async function triggerReviewRequest(input) {
  const { customer_id, customer_name } = input;

  let customer;
  if (customer_id) {
    customer = await db('customers').where('id', customer_id).first();
  } else if (customer_name) {
    customer = await db('customers').where(function () {
      const s = `%${customer_name}%`;
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereRaw("TRIM(first_name || ' ' || COALESCE(last_name, '')) ILIKE ?", [s]);
    }).first();
  }
  if (!customer) return { error: 'Customer not found' };
  if (!customer.phone) return { error: `${customer.first_name} ${customer.last_name} has no phone number` };

  // Check if already sent recently
  const recent = await db('review_requests')
    .where({ customer_id: customer.id })
    .where('created_at', '>=', new Date(Date.now() - 30 * 86400000).toISOString())
    .first();
  if (recent) return { already_sent: true, status: recent.status, sent_at: recent.created_at, note: 'Already sent a review request in the last 30 days' };

  // Create request
  try {
    const ReviewService = require('../review-request');
    const request = await ReviewService.create({
      customerId: customer.id,
      triggeredBy: 'intelligence_bar',
    });

    logger.info(`[intelligence-bar:reviews] Triggered review request for ${customer.first_name} ${customer.last_name}`);

    return {
      success: true,
      customer: `${customer.first_name} ${customer.last_name}`,
      phone: customer.phone,
      request_id: request.id,
      note: 'Review request SMS will be sent via the automated flow (90-180 min delay after service).',
    };
  } catch (err) {
    return { error: `Failed to create review request: ${err.message}` };
  }
}


async function searchReviews(input) {
  const { search, rating, location, responded, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 20, 100);

  let query = db('google_reviews')
    .where('reviewer_name', '!=', '_stats')
    .leftJoin('customers', 'google_reviews.customer_id', 'customers.id')
    .select('google_reviews.*', 'customers.first_name as cust_first', 'customers.last_name as cust_last')
    .orderBy('review_created_at', 'desc');

  if (search) query = query.where(function () {
    this.whereILike('reviewer_name', `%${search}%`).orWhereILike('review_text', `%${search}%`);
  });
  if (rating) query = query.where('star_rating', rating);
  if (location) query = query.where('location_id', location);
  if (responded === true) query = query.whereNotNull('review_reply');
  if (responded === false) query = query.whereNull('review_reply');

  const reviews = await query.limit(limit);

  return {
    reviews: reviews.map(r => ({
      id: r.id,
      reviewer: r.reviewer_name,
      rating: r.star_rating,
      text: r.review_text,
      reply: r.review_reply ? r.review_reply.substring(0, 100) + '...' : null,
      has_reply: !!r.review_reply,
      location: r.location_id,
      date: r.review_created_at,
      customer: r.cust_first ? `${r.cust_first} ${r.cust_last}` : null,
    })),
    total: reviews.length,
  };
}


async function getReviewTrends(months) {
  const results = [];
  const now = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    const label = start.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'America/New_York' });

    const stats = await db('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .whereBetween('review_created_at', [start.toISOString(), end.toISOString()])
      .select(
        db.raw('COUNT(*) as total'),
        db.raw('ROUND(AVG(star_rating)::numeric, 1) as avg_rating'),
        db.raw("COUNT(*) FILTER (WHERE review_reply IS NOT NULL) as responded"),
        db.raw("COUNT(*) FILTER (WHERE star_rating >= 4) as positive"),
        db.raw("COUNT(*) FILTER (WHERE star_rating <= 2) as negative"),
      ).first();

    const total = parseInt(stats?.total || 0);
    results.push({
      month: label,
      total,
      avg_rating: parseFloat(stats?.avg_rating || 0),
      responded: parseInt(stats?.responded || 0),
      response_rate: total > 0 ? Math.round(parseInt(stats?.responded || 0) / total * 100) : 0,
      positive: parseInt(stats?.positive || 0),
      negative: parseInt(stats?.negative || 0),
    });
  }

  return {
    trend: results,
    direction: results.length >= 2 && results[results.length - 1].avg_rating > results[results.length - 2].avg_rating ? 'improving' : results.length >= 2 && results[results.length - 1].avg_rating < results[results.length - 2].avg_rating ? 'declining' : 'stable',
  };
}


async function getVelocityPipeline(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const pipeline = await db('review_requests')
    .where('created_at', '>=', since)
    .select('status', db.raw('COUNT(*) as count'))
    .groupBy('status');

  const counts = {};
  pipeline.forEach(p => { counts[p.status] = parseInt(p.count); });

  const totalSent = Object.values(counts).reduce((s, c) => s + c, 0);
  const reviewed = counts.reviewed || counts.completed || 0;

  return {
    period_days: days,
    pipeline: counts,
    total_sent: totalSent,
    total_reviewed: reviewed,
    conversion_rate: totalSent > 0 ? Math.round(reviewed / totalSent * 100) : 0,
    pending: counts.pending || 0,
    reminded: counts.reminded || 0,
    declined: counts.declined || 0,
  };
}


module.exports = { REVIEW_TOOLS, executeReviewTool };
