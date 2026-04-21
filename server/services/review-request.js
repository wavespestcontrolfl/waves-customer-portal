const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { etParts, parseETDateTime, addETDays } = require('../utils/datetime-et');
const { shortenOrPassthrough } = require('./short-url');

// GBP review links per location
const REVIEW_LINKS = {
  'lakewood-ranch': 'https://g.page/r/CVRc_P5butTMEBM/review',
  'sarasota': 'https://g.page/r/CRkzS6M4EpncEBM/review',
  'venice': 'https://g.page/r/CURA5pQ1KatBEBM/review',
  'parrish': 'https://g.page/r/Ca-4KKoWwFacEBM/review',
};

// City → location for review routing
const CITY_TO_LOCATION = {
  'lakewood ranch': 'lakewood-ranch', 'bradenton': 'lakewood-ranch', 'university park': 'lakewood-ranch',
  'braden river': 'lakewood-ranch', 'longboat key': 'lakewood-ranch', 'anna maria': 'lakewood-ranch',
  'holmes beach': 'lakewood-ranch', 'palmetto': 'lakewood-ranch', 'cortez': 'lakewood-ranch',
  'sarasota': 'sarasota', 'siesta key': 'sarasota', 'lido key': 'sarasota',
  'bee ridge': 'sarasota', 'gulf gate': 'sarasota', 'osprey': 'sarasota',
  'venice': 'venice', 'north port': 'venice', 'englewood': 'venice',
  'nokomis': 'venice', 'port charlotte': 'venice', 'punta gorda': 'venice',
  'parrish': 'parrish', 'ellenton': 'parrish', 'ruskin': 'parrish', 'apollo beach': 'parrish',
};

function resolveLocation(customer) {
  const city = (customer.city || '').toLowerCase().trim();
  return CITY_TO_LOCATION[city] || 'lakewood-ranch';
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Smart review send-time calculator.
 * Instead of a flat 90-180 min delay, pick the moment the customer is most
 * likely relaxed, on their phone, and has experienced the result of the service.
 *
 * @param {Date} completedAt - when the service was completed
 * @param {string} serviceType - e.g. 'pest_control', 'lawn_care', 'mosquito'
 * @returns {Date} optimal send timestamp
 */
function calculateReviewSendTime(completedAt, serviceType) {
  // Read ET wall-clock — server runs UTC, so getHours/getDay would be 4-5h off.
  const { hour, dayOfWeek: day } = etParts(completedAt);

  // ±15 min jitter so messages don't all land at the same second
  const jitter = () => Math.floor(Math.random() * 31) - 15;

  // Build a Date at ET hour H of `date`'s ET calendar day (respecting DST).
  function atHour(date, targetHour) {
    const p = etParts(date);
    const h = Math.floor(targetHour);
    const m = Math.round((targetHour - h) * 60) + jitter();
    const mm = Math.max(0, Math.min(59, m));
    const naive = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    return parseETDateTime(naive);
  }

  function nextDayAtHour(date, targetHour) {
    return atHour(addETDays(date, 1), targetHour);
  }

  function addMins(date, mins) {
    return new Date(date.getTime() + (mins + jitter()) * 60000);
  }

  const EVENING = 18.5;  // 6:30 PM — golden window
  const MORNING = 10;    // 10:00 AM

  const svc = (serviceType || '').toLowerCase();

  // ── Service-type overrides ──────────────────────────────────

  // Mosquito / WaveGuard: delay until evening when they're outside enjoying the yard
  if (svc.includes('mosquito') || svc.includes('waveguard')) {
    if (hour < 16) return atHour(completedAt, EVENING);
    return nextDayAtHour(completedAt, MORNING);
  }

  // Lawn care / tree & shrub: let them see the results first
  if (svc.includes('lawn') || svc.includes('tree') || svc.includes('shrub') || svc.includes('dethatch')) {
    if (hour < 16) return atHour(completedAt, EVENING);   // same evening
    return nextDayAtHour(completedAt, MORNING);            // next morning
  }

  // WDO / first-time inspections: high anxiety → high relief, capture it fast
  if (svc.includes('wdo')) {
    const send = addMins(completedAt, 90);
    // Guard: never after 8 PM ET
    if (etParts(send).hour >= 20) return nextDayAtHour(completedAt, MORNING);
    return send;
  }

  // ── Day-of-week overrides ──────────────────────────────────

  // Saturday service → Sunday 10:30 AM
  if (day === 6) {
    return atHour(addETDays(completedAt, 1), 10.5);
  }

  // Friday afternoon → Saturday 10 AM
  if (day === 5 && hour >= 14) {
    return nextDayAtHour(completedAt, 10);
  }

  // ── Default time-of-day logic ──────────────────────────────

  if (hour >= 7 && hour < 12) return addMins(completedAt, 120);  // morning: 2-hour delay
  if (hour >= 12 && hour < 15) return addMins(completedAt, 90);  // early afternoon: 90 min
  if (hour >= 15 && hour < 17) return atHour(completedAt, EVENING); // late afternoon: 6:30 PM
  // After 5 PM or before 7 AM — next morning 10 AM
  return nextDayAtHour(completedAt, MORNING);
}

// ══════════════════════════════════════════════════════════════
const ReviewService = {

  /**
   * Create a review request — called after payment or by tech.
   * @param {string} triggeredBy - 'auto' (post-payment), 'tech' (in-person), 'admin'
   * @param {number} delayMinutes - 0 for immediate (tech trigger), or 90-180 for auto
   */
  async create({ customerId, serviceRecordId, triggeredBy = 'auto', delayMinutes }) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    // Don't create duplicate for same service
    if (serviceRecordId) {
      const existing = await db('review_requests').where({ service_record_id: serviceRecordId }).first();
      if (existing) return existing;
    }

    // Pull service + tech context
    let techName = null, serviceType = null, serviceDate = null, technicianId = null;
    if (serviceRecordId) {
      const sr = await db('service_records')
        .where({ 'service_records.id': serviceRecordId })
        .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
        .select('service_records.*', 'technicians.name as tech_name')
        .first();
      if (sr) {
        techName = sr.tech_name;
        serviceType = sr.service_type;
        serviceDate = sr.service_date;
        technicianId = sr.technician_id;
      }
    }

    // Smart timing: pick the moment the customer is most likely to leave a review
    let scheduledFor = null;
    if (triggeredBy === 'auto') {
      if (delayMinutes) {
        scheduledFor = new Date(Date.now() + delayMinutes * 60000);
      } else {
        scheduledFor = calculateReviewSendTime(new Date(), serviceType);
      }
    }
    // 'tech' trigger = immediate (delayMinutes = 0 or null)

    const token = generateToken();
    const [request] = await db('review_requests').insert({
      token,
      customer_id: customerId,
      service_record_id: serviceRecordId,
      technician_id: technicianId,
      tech_name: techName,
      service_type: serviceType,
      service_date: serviceDate,
      triggered_by: triggeredBy,
      scheduled_for: scheduledFor,
      status: 'pending',
    }).returning('*');

    logger.info(`[review] Created request for ${customer.first_name} ${customer.last_name} — trigger: ${triggeredBy}, scheduled: ${scheduledFor || 'immediate'}`);

    // If tech-triggered, send immediately
    if (triggeredBy === 'tech') {
      await this.sendSMS(request.id);
    }

    return request;
  },

  /**
   * Send the review request SMS.
   */
  async sendSMS(requestId) {
    const request = await db('review_requests').where({ id: requestId }).first();
    if (!request || request.sms_sent_at) return;

    const customer = await db('customers').where({ id: request.customer_id }).first();
    if (!customer?.phone) return;

    const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
    const longReviewUrl = `${domain}/rate/${request.token}`;
    const reviewUrl = await shortenOrPassthrough(longReviewUrl, {
      kind: 'review', entityType: 'review_requests', entityId: request.id, customerId: customer.id,
    });
    const techName = request.tech_name || 'Our team';

    // Pull editable body from sms_templates.review_request. Fall back to inline.
    let body = null;
    try {
      const tpl = require('../routes/admin-sms-templates');
      body = await tpl.getTemplate('review_request', {
        first_name: customer.first_name || '',
        review_url: reviewUrl,
      });
    } catch { /* fall through */ }
    if (!body) {
      body = `Hello ${customer.first_name}! How was your service with ${techName}? We'd love your feedback: ${reviewUrl}`;
    }

    try {
      const TwilioService = require('./twilio');
      await TwilioService.sendSMS(customer.phone, body, {
        customerId: customer.id,
        messageType: 'review_request',
      });

      await db('review_requests').where({ id: requestId }).update({
        sms_sent_at: new Date(),
        status: 'sent',
        updated_at: new Date(),
      });

      logger.info(`[review] SMS sent for ${customer.first_name} ${customer.last_name}`);
    } catch (err) {
      logger.error(`[review] SMS failed: ${err.message}`);
    }
  },

  /**
   * Create a review-request row and return the (shortened) review URL
   * without sending its own SMS. Used when the completion flow wants to
   * bundle the review link into the service-complete SMS so the customer
   * gets a single message instead of two.
   *
   * Marks sms_sent_at = now() so the scheduled-sender cron skips this
   * record — the outer caller is responsible for the actual SMS body.
   *
   * @returns {string|null} shortened review URL, or null on no-phone /
   * existing-duplicate cases (outer caller can just skip the suffix).
   */
  async createInline({ customerId, serviceRecordId }) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return null;

    // Reuse an existing request for this service so we don't stack tokens.
    if (serviceRecordId) {
      const existing = await db('review_requests').where({ service_record_id: serviceRecordId }).first();
      if (existing) {
        const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
        const longUrl = `${domain}/rate/${existing.token}`;
        return shortenOrPassthrough(longUrl, {
          kind: 'review', entityType: 'review_requests', entityId: existing.id, customerId,
        });
      }
    }

    let techName = null, serviceType = null, serviceDate = null, technicianId = null;
    if (serviceRecordId) {
      const sr = await db('service_records')
        .where({ 'service_records.id': serviceRecordId })
        .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
        .select('service_records.*', 'technicians.name as tech_name')
        .first();
      if (sr) {
        techName = sr.tech_name;
        serviceType = sr.service_type;
        serviceDate = sr.service_date;
        technicianId = sr.technician_id;
      }
    }

    const token = generateToken();
    const now = new Date();
    const [request] = await db('review_requests').insert({
      token,
      customer_id: customerId,
      service_record_id: serviceRecordId,
      technician_id: technicianId,
      tech_name: techName,
      service_type: serviceType,
      service_date: serviceDate,
      triggered_by: 'auto_inline',
      scheduled_for: null,
      sms_sent_at: now,
      status: 'sent',
    }).returning('*');

    logger.info(`[review] Created inline request for ${customer.first_name} ${customer.last_name} (bundled with completion SMS)`);

    const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
    const longUrl = `${domain}/rate/${request.token}`;
    return shortenOrPassthrough(longUrl, {
      kind: 'review', entityType: 'review_requests', entityId: request.id, customerId,
    });
  },

  /**
   * Get review page data by public token.
   */
  async getByToken(token) {
    const request = await db('review_requests').where({ token }).first();
    if (!request) return null;

    // Record view
    const updates = { open_count: (request.open_count || 0) + 1 };
    if (!request.opened_at) {
      updates.opened_at = new Date();
      updates.status = request.status === 'sent' ? 'opened' : request.status;
    }
    await db('review_requests').where({ id: request.id }).update(updates);

    const customer = await db('customers')
      .where({ id: request.customer_id })
      .select('first_name', 'last_name', 'city', 'zip')
      .first();

    // Tech photo
    let techPhoto = null;
    if (request.technician_id) {
      const tech = await db('technicians').where({ id: request.technician_id }).select('photo_url').first();
      techPhoto = tech?.photo_url || null;
      // Also try dispatch_technicians
      if (!techPhoto) {
        try {
          const dispatchTech = await db('dispatch_technicians')
            .where({ name: request.tech_name }).select('photo_url').first();
          techPhoto = dispatchTech?.photo_url || null;
        } catch { /* table might not exist */ }
      }
    }

    // Social proof: count of ratings for this tech
    let techReviewCount = 0;
    if (request.technician_id) {
      const [{ count }] = await db('review_requests')
        .where({ technician_id: request.technician_id })
        .whereNotNull('rating')
        .count('* as count');
      techReviewCount = parseInt(count);
    }
    // Also add Google reviews count
    try {
      const [{ count: googleCount }] = await db('google_reviews')
        .where('reviewer_name', '!=', '_stats')
        .count('* as count');
      techReviewCount += parseInt(googleCount);
    } catch { /* table might not exist */ }

    // Resolve which Google review link to use
    const location = resolveLocation(customer || {});
    const googleReviewUrl = REVIEW_LINKS[location] || REVIEW_LINKS['lakewood-ranch'];

    return {
      id: request.id,
      techName: request.tech_name,
      techPhoto,
      serviceType: request.service_type,
      serviceDate: request.service_date,
      customerFirstName: customer?.first_name,
      techReviewCount,
      googleReviewUrl,
      googleLocation: location,
      alreadyRated: !!request.rated_at,
      rating: request.rating,
    };
  },

  /**
   * Submit a rating from the review page.
   */
  async submitRating(token, { rating, feedbackText }) {
    const request = await db('review_requests').where({ token }).first();
    if (!request) throw new Error('Review request not found');
    if (request.rated_at) throw new Error('Already rated');

    const customer = await db('customers').where({ id: request.customer_id }).first();
    const location = resolveLocation(customer || {});
    const isPromoter = rating >= 7; // 7+ goes to Google (per the case study discussion)
    const isDetractor = rating <= 4;

    const updates = {
      rating,
      rated_at: new Date(),
      feedback_text: feedbackText || null,
      status: 'rated',
      google_location: location,
      updated_at: new Date(),
    };

    if (isPromoter) {
      updates.redirected_to_google = true;
      updates.redirected_at = new Date();
      updates.status = 'reviewed'; // optimistic — they got the redirect
    }

    await db('review_requests').where({ id: request.id }).update(updates);

    // Also record in satisfaction_responses for backward compat
    try {
      const existing = await db('satisfaction_responses')
        .where({ customer_id: request.customer_id, service_record_id: request.service_record_id })
        .first();
      if (!existing && request.service_record_id) {
        await db('satisfaction_responses').insert({
          customer_id: request.customer_id,
          service_record_id: request.service_record_id,
          rating,
          feedback_text: feedbackText || null,
          directed_to_review: isPromoter,
          flagged_for_followup: !isPromoter,
          office_location: location.replace('-', '_'),
        });
      }
    } catch { /* satisfaction_responses may not exist */ }

    // Alert on low scores
    if (!isPromoter) {
      const urgency = isDetractor ? '🚨 URGENT' : '⚠️';
      try {
        const TwilioService = require('./twilio');
        const alertPhone = process.env.OWNER_PHONE || '+19413187612';
        await TwilioService.sendSMS(alertPhone,
          `${urgency} Review Alert\n\n` +
          `${customer.first_name} ${customer.last_name} rated ${rating}/10\n` +
          `Service: ${request.service_type} (${request.service_date})\n` +
          `Tech: ${request.tech_name}\n` +
          (feedbackText ? `Feedback: "${feedbackText}"\n` : '') +
          `Phone: ${customer.phone}\n\n` +
          (isDetractor ? 'Follow up ASAP.' : 'Follow up within 24 hours.'),
          { messageType: 'internal_alert' }
        );
      } catch (err) {
        logger.error(`[review] Alert SMS failed: ${err.message}`);
      }
    }

    const googleReviewUrl = isPromoter ? (REVIEW_LINKS[location] || REVIEW_LINKS['lakewood-ranch']) : null;
    return { rating, action: isPromoter ? 'review' : 'feedback', googleReviewUrl };
  },

  /**
   * Cron: send scheduled review requests.
   * Runs every 15 minutes, picks up requests whose scheduled_for has passed.
   */
  async processScheduled() {
    const pending = await db('review_requests')
      .where({ status: 'pending' })
      .whereNotNull('scheduled_for')
      .where('scheduled_for', '<=', new Date())
      .whereNull('sms_sent_at')
      .limit(20);

    let sent = 0;
    for (const request of pending) {
      await this.sendSMS(request.id);
      sent++;
    }
    if (sent > 0) logger.info(`[review] Processed ${sent} scheduled review requests`);
    return { sent };
  },

  /**
   * Cron: send 48-hour follow-up to non-responders.
   * Only sends ONE follow-up, only to people who haven't opened OR opened but didn't rate.
   */
  async processFollowups() {
    const cutoff = new Date(Date.now() - 48 * 3600000); // 48 hours ago
    const eligible = await db('review_requests')
      .whereIn('status', ['sent', 'opened'])
      .where('sms_sent_at', '<=', cutoff)
      .where({ followup_sent: false })
      .whereNull('rated_at')
      .limit(20);

    let sent = 0;
    for (const request of eligible) {
      const customer = await db('customers').where({ id: request.customer_id }).first();
      if (!customer?.phone) continue;

      const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
      const longReviewUrl = `${domain}/rate/${request.token}`;
      const reviewUrl = await shortenOrPassthrough(longReviewUrl, {
        kind: 'review', entityType: 'review_requests', entityId: request.id, customerId: customer.id,
      });

      const fallback = `No pressure at all, ${customer.first_name} — but if you get a sec, your review helps other SWFL families find a pest company they can trust → ${reviewUrl} 🌊`;
      let body = fallback;
      try {
        const templates = require('../routes/admin-sms-templates');
        const rendered = await templates.getTemplate('review_request_followup', {
          first_name: customer.first_name || '',
          review_url: reviewUrl,
        });
        if (rendered && !rendered.includes('{first_name}')) body = rendered;
      } catch { /* use fallback */ }

      try {
        const TwilioService = require('./twilio');
        await TwilioService.sendSMS(customer.phone, body, {
          customerId: customer.id,
          messageType: 'review_followup',
        });

        await db('review_requests').where({ id: request.id }).update({
          followup_sent: true,
          followup_sent_at: new Date(),
          updated_at: new Date(),
        });
        sent++;
      } catch (err) {
        logger.error(`[review] Follow-up SMS failed: ${err.message}`);
      }
    }
    if (sent > 0) logger.info(`[review] Sent ${sent} follow-up reminders`);
    return { sent };
  },

  // ── Stats ──
  async getStats() {
    const [totals] = await db('review_requests').select(
      db.raw("COUNT(*) as total"),
      db.raw("COUNT(*) FILTER (WHERE rated_at IS NOT NULL) as rated"),
      db.raw("COUNT(*) FILTER (WHERE redirected_to_google = true) as sent_to_google"),
      db.raw("COUNT(*) FILTER (WHERE rating >= 7 AND rated_at IS NOT NULL) as promoters"),
      db.raw("COUNT(*) FILTER (WHERE rating <= 4 AND rated_at IS NOT NULL) as detractors"),
      db.raw("COUNT(*) FILTER (WHERE sms_sent_at IS NOT NULL) as sms_sent"),
      db.raw("ROUND(AVG(rating) FILTER (WHERE rated_at IS NOT NULL), 1) as avg_rating"),
      db.raw("COUNT(*) FILTER (WHERE triggered_by = 'tech') as tech_triggered"),
      db.raw("COUNT(*) FILTER (WHERE triggered_by = 'auto') as auto_triggered"),
    );

    const smsSent = parseInt(totals.sms_sent) || 1;
    const rated = parseInt(totals.rated);
    const sentToGoogle = parseInt(totals.sent_to_google);

    return {
      total: parseInt(totals.total),
      smsSent,
      rated,
      sentToGoogle,
      promoters: parseInt(totals.promoters),
      detractors: parseInt(totals.detractors),
      avgRating: parseFloat(totals.avg_rating) || 0,
      rateRate: Math.round((rated / smsSent) * 100), // % who submitted a rating
      reviewRate: Math.round((sentToGoogle / smsSent) * 100), // % sent to Google
      techTriggered: parseInt(totals.tech_triggered),
      autoTriggered: parseInt(totals.auto_triggered),
    };
  },
};

module.exports = ReviewService;
