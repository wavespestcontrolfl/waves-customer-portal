const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { etParts, parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');
const { shortenOrPassthrough } = require('./short-url');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

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
      if (delayMinutes !== undefined && delayMinutes !== null) {
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

    // PII: ID-only logging per AGENTS.md. Customer name lives in the
    // customers row; the log line just needs IDs for cross-reference.
    logger.info(`[review] Created request (customerId=${customer.id} requestId=${request.id} trigger=${triggeredBy} scheduled=${scheduledFor || 'immediate'})`);

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
    // Skip customers a CSR has flagged as already-reviewed (Customer 360 toggle).
    if (customer && customer.has_left_google_review) {
      await db('review_requests').where({ id: requestId }).update({
        status: 'suppressed',
      });
      // PII: ID-only per AGENTS.md.
      logger.info(`[review] Suppressed request (customerId=${customer.id} requestId=${requestId} reason=already-reviewed-flag)`);
      return;
    }
    // Route to the service beneficiary (see services/customer-contact.js) —
    // falls back to the billing phone when no service contact is configured.
    const { getServiceContact } = require('./customer-contact');
    const contact = getServiceContact(customer);
    if (!contact.phone) return;

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
        first_name: contact.name || customer.first_name || '',
        review_url: reviewUrl,
      });
    } catch { /* fall through */ }
    if (!body) {
      body = `Hello ${contact.name || customer.first_name}! How was your service with ${techName}? We'd love your feedback: ${reviewUrl}`;
    }

    // Routed through the customer-message middleware so consent /
    // suppression / identity / voice / segment checks all apply, and
    // every attempt lands in messaging_audit_log.
    //
    // Per the prompt-hardening pass that landed in #522, review-request
    // eligibility lives in the upstream candidate-finder (no open
    // complaint, no unresolved billing, opted in, no recent ask in
    // cooldown). Here we just make sure the channel is permitted at
    // send time — sms_enabled, suppression list, segment count, no
    // emoji / price leak.
    try {
      const { sendCustomerMessage } = require('./messaging/send-customer-message');
      const result = await sendCustomerMessage({
        to: contact.phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'review_request',
        customerId: customer.id,
        entryPoint: 'review_request_send',
      });

      if (result.sent) {
        await db('review_requests').where({ id: requestId }).update({
          sms_sent_at: new Date(),
          status: 'sent',
        });
        // PII: ID-only per AGENTS.md.
        logger.info(`[review] SMS sent (customerId=${customer.id} requestId=${requestId} auditLogId=${result.auditLogId || 'n/a'})`);
      } else if (result.blocked && result.code === 'CONSENT_LOOKUP_FAILED') {
        // Transient lookup failure inside the wrapper (DB error during
        // consent validation). Distinct code from NO_CONSENT_RECORD;
        // treat like a provider failure — re-queue for the cron rather
        // than permanently suppress. Codex P1 round-2 on PR #545:
        // NO_CONSENT_RECORD and CONSENT_LOOKUP_FAILED used to share the
        // same code, which silently dropped legitimate review requests
        // during DB blips.
        const retryAt = new Date(Date.now() + 5 * 60 * 1000);
        await db('review_requests').where({ id: requestId }).update({
          scheduled_for: retryAt,
        });
        // PII: ID + code only. result.reason can include recipient phone
        // or message body when upstream provider/guard error strings
        // propagate; full failure context lives on messaging_audit_log
        // keyed on auditLogId.
        logger.error(`[review] SMS WRAPPER LOOKUP FAILED (customerId=${customer.id} requestId=${requestId} auditLogId=${result.auditLogId || 'n/a'} code=${result.code}) (queued for retry at ${retryAt.toISOString()})`);
      } else if (result.blocked) {
        // True wrapper-policy block (opt-out, suppression, emoji, price
        // leak, segment cap, identity, NO_CONSENT_RECORD). Mark
        // suppressed so processScheduled() — which only picks rows with
        // status='pending' — stops retrying. The request row stays for
        // audit history; the audit_log row captures the block reason.
        await db('review_requests').where({ id: requestId }).update({
          status: 'suppressed',
        });
        // PII: ID + code only — see WRAPPER LOOKUP FAILED above for why
        // result.reason is dropped from log lines.
        logger.warn(`[review] SMS BLOCKED (customerId=${customer.id} requestId=${requestId} auditLogId=${result.auditLogId || 'n/a'} code=${result.code})`);
      } else {
        // Provider failure (Twilio/network). Mark for retry: keep
        // status='pending' AND set scheduled_for=now+5min so
        // processScheduled() (which selects status='pending' AND
        // scheduled_for <= now()) picks it up on its next tick.
        //
        // Codex P1 on the redo PR #545: just leaving status='pending'
        // wasn't enough for tech-triggered requests, which are created
        // with scheduled_for=null and sent immediately. processScheduled
        // does whereNotNull('scheduled_for'), so a null-scheduled_for
        // pending row would never retry — silently dropping legitimate
        // review requests on a Twilio blip. Setting scheduled_for moves
        // the row into the cron's retry queue regardless of how it was
        // originally created.
        const retryAt = new Date(Date.now() + 5 * 60 * 1000);
        await db('review_requests').where({ id: requestId }).update({
          scheduled_for: retryAt,
        });
        // PII: ID + code only — see WRAPPER LOOKUP FAILED above for why
        // result.reason is dropped from log lines.
        logger.error(`[review] SMS PROVIDER FAILURE (customerId=${customer.id} requestId=${requestId} auditLogId=${result.auditLogId || 'n/a'} code=${result.code}) (queued for retry at ${retryAt.toISOString()})`);
      }
    } catch (err) {
      // Same retry contract on a thrown exception (network down etc.):
      // re-queue for the cron rather than leave the row stranded.
      try {
        const retryAt = new Date(Date.now() + 5 * 60 * 1000);
        await db('review_requests').where({ id: requestId }).update({
          scheduled_for: retryAt,
        });
        // PII: log error class only. err.message can include Twilio
        // request bodies / phone numbers since the wrapper internally
        // calls services that surface the raw destination in their
        // error strings. Audit row (when reached) holds full context.
        logger.error(`[review] SMS dispatch threw — queued for retry at ${retryAt.toISOString()} (requestId=${requestId} errType=${err?.name || 'Error'})`);
      } catch (dbErr) {
        // Last resort — couldn't even update the row. Log error classes
        // only for both failures (same PII reasoning).
        logger.error(`[review] SMS failed AND retry-queue update failed (requestId=${requestId} sendErrType=${err?.name || 'Error'} dbErrType=${dbErr?.name || 'Error'})`);
      }
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
    // CSR flagged this customer as already-reviewed — caller treats null
    // as "skip the review suffix" so the completion SMS goes out clean.
    if (customer.has_left_google_review) return null;

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

    // PII: ID-only per AGENTS.md.
    logger.info(`[review] Created inline request (customerId=${customer.id} requestId=${request.id} bundled-with=completion_sms)`);

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

    // Tech photo. Mirrors the pattern in track-public.js (#344) and
    // admin-dispatch /board (#346): the canonical source is
    // technicians.photo_s3_key (an S3 reference set by
    // POST /api/admin/timetracking/technicians/:id/photo). Presign
    // at response-build time inside this token-scoped getByToken
    // call so newly-uploaded tech photos surface on review pages
    // without expiring URLs baked into the row.
    //
    // Falls back only to technicians.photo_url for legacy techs whose
    // photo lives at an external host (e.g., Google Business).
    const { resolveTechPhotoUrl } = require('./tech-photo');
    let techPhoto = null;
    if (request.technician_id) {
      const tech = await db('technicians')
        .where({ id: request.technician_id })
        .select('photo_url', 'photo_s3_key')
        .first();
      techPhoto = await resolveTechPhotoUrl(tech?.photo_s3_key, tech?.photo_url);
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
   * Cron: send the single follow-up reminder, on Day 3 after the initial
   * review request. Only sends ONE follow-up, only to people who haven't
   * opened OR opened but didn't rate.
   *
   * Eligibility window: review SMS was sent on or before 2 ET-calendar-days
   * ago. Combined with the 10:00 AM ET cron schedule, this lands the followup
   * on the 3rd ET day after the original (e.g. Mon 8 AM or Mon 8 PM initial
   * → Wed 10 AM followup, regardless of original time of day).
   *
   * Per-customer dedup: a customer with multiple recent review_requests (e.g.
   * back-to-back services) only gets a single follow-up SMS. Sibling rows are
   * marked followup_sent so they stop appearing in eligibility windows on
   * subsequent cron runs.
   */
  async processFollowups() {
    // ET midnight at the start of "yesterday in ET" — anything sent before
    // this fell on (today - 2 ET days) or earlier in the ET calendar.
    const cutoff = parseETDateTime(`${etDateString(addETDays(new Date(), -1))}T00:00`);
    const recentFollowupCutoff = new Date(Date.now() - 14 * 24 * 3600000); // 14 days
    const eligible = await db('review_requests')
      .whereIn('status', ['sent', 'opened'])
      .where('sms_sent_at', '<', cutoff)
      .where({ followup_sent: false })
      .whereNull('rated_at')
      .orderBy('sms_sent_at', 'asc')
      .limit(20);

    let sent = 0;
    let suppressed = 0;
    const sentThisRun = new Set();
    const { getServiceContact } = require('./customer-contact');
    for (const request of eligible) {
      // Dedup #1: another row in this same batch already triggered a followup
      if (sentThisRun.has(request.customer_id)) {
        await db('review_requests').where({ id: request.id }).update({
          followup_sent: true,
          followup_sent_at: new Date(),
        });
        suppressed++;
        continue;
      }

      // Dedup #2: a sibling row already sent a followup to this customer recently
      const recentFollowup = await db('review_requests')
        .where({ customer_id: request.customer_id, followup_sent: true })
        .where('followup_sent_at', '>=', recentFollowupCutoff)
        .first();
      if (recentFollowup) {
        await db('review_requests').where({ id: request.id }).update({
          followup_sent: true,
          followup_sent_at: new Date(),
        });
        suppressed++;
        continue;
      }

      const customer = await db('customers').where({ id: request.customer_id }).first();
      // Dedup #3: CSR flagged the customer as already-reviewed (Customer 360 toggle).
      if (customer && customer.has_left_google_review) {
        await db('review_requests').where({ id: request.id }).update({
          followup_sent: true,
          followup_sent_at: new Date(),
        });
        suppressed++;
        continue;
      }
      const contact = getServiceContact(customer);
      if (!contact.phone) continue;

      // Followup points straight at the GBP review form — they ignored the
      // tokenized rate page once, so reduce friction the second time.
      const location = resolveLocation(customer || {});
      const googleReviewUrl = REVIEW_LINKS[location] || REVIEW_LINKS['lakewood-ranch'];

      const fallback = `No pressure at all, ${contact.name || customer.first_name}, but if you get a sec, your review helps other SWFL families find a pest company they can trust: ${googleReviewUrl}`;
      let body = fallback;
      try {
        const templates = require('../routes/admin-sms-templates');
        const rendered = await templates.getTemplate('review_request_followup', {
          first_name: contact.name || customer.first_name || '',
          google_review_url: googleReviewUrl,
        });
        if (rendered && !rendered.includes('{first_name}') && !rendered.includes('{google_review_url}')) {
          body = rendered;
        }
      } catch { /* use fallback */ }

      try {
        const result = await sendCustomerMessage({
          to: contact.phone,
          body,
          channel: 'sms',
          audience: 'customer',
          purpose: 'review_request',
          customerId: customer.id,
          identityTrustLevel: 'phone_matches_customer',
          entryPoint: 'review_request_followup',
          metadata: {
            original_message_type: 'review_followup',
            review_request_id: request.id,
          },
        });
        if (!result.sent) {
          logger.warn(`[review] Follow-up SMS blocked/failed (customerId=${customer.id} requestId=${request.id} auditLogId=${result.auditLogId || 'n/a'} code=${result.code || 'UNKNOWN'})`);
          continue;
        }

        await db('review_requests').where({ id: request.id }).update({
          followup_sent: true,
          followup_sent_at: new Date(),
        });
        sentThisRun.add(request.customer_id);
        sent++;
      } catch (err) {
        logger.error(`[review] Follow-up SMS failed: ${err.message}`);
      }
    }
    if (sent > 0 || suppressed > 0) {
      logger.info(`[review] Follow-ups: ${sent} sent, ${suppressed} suppressed (dedup)`);
    }
    return { sent, suppressed };
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
