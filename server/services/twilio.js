const twilio = require('twilio');
const config = require('../config');
const db = require('../models/db');
const logger = require('./logger');

const WAVES_LOGO_URL = 'https://www.wavespestcontrol.com/wp-content/uploads/2026/01/waves-pest-and-lawn-logo.png';

// Owner-SMS kill switch.
//
// 25+ places in the codebase send SMS to the operator's personal phone
// — new-lead alerts, billing crons, BI briefings, SEO digests, missed
// appointments, etc. — and most of them have hardcoded phone fallbacks
// like '+19413187612' / '+19415993489' so simply unsetting env vars
// doesn't silence them. When OWNER_SMS_DISABLED='true', sendSMS()
// suppresses any send whose recipient matches a known owner phone.
// Push notifications + bell entries continue normally.
//
// Toggleable via env var so the kill switch is reversible without a
// deploy: set OWNER_SMS_DISABLED=true on Railway → silence; unset
// or set to anything else → restore.
const HARDCODED_OWNER_FALLBACKS = ['+19413187612', '+19415993489'];

function normalizePhone(p) {
  if (!p || typeof p !== 'string') return '';
  // Canonicalize to bare digits. SMS recipient strings arrive in mixed
  // formats — env-var literals (`+19413187612`), user input
  // (`(941) 318-7612` / `941-318-7612`), JS string concat
  // (`19413187612`) — so reduce both sides of every comparison to a
  // single form. US numbers also vary on whether the country-code `1`
  // is included; strip a leading `1` from 11-digit numbers so the
  // 10-digit and 11-digit forms collide.
  let d = p.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

// Mask a phone for logging: keep only the last 4 digits.
function maskPhone(p) {
  const d = normalizePhone(p);
  return d.length >= 4 ? `***${d.slice(-4)}` : '***';
}

function getOwnerPhoneSet() {
  const candidates = [
    process.env.OWNER_PHONE,
    process.env.ADAM_PHONE,
    process.env.ADAM_CELL,
    process.env.WAVES_OFFICE_PHONE,
    process.env.WAVES_ADMIN_PHONE,
    ...HARDCODED_OWNER_FALLBACKS,
  ];
  return new Set(candidates.map(normalizePhone).filter(Boolean));
}

function isOwnerSmsSilenced(to) {
  if (process.env.OWNER_SMS_DISABLED !== 'true') return false;
  return getOwnerPhoneSet().has(normalizePhone(to));
}

// Lazy-initialize Twilio client — don't crash if creds are missing
let _client;
function getClient() {
  if (_client) return _client;
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    logger.warn('[twilio] TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set — SMS/voice disabled');
    return null;
  }
  _client = twilio(config.twilio.accountSid, config.twilio.authToken);
  return _client;
}
// Keep backward-compatible reference for any code that reads `client` directly
const client = null;

const TwilioService = {
  // =========================================================================
  // PHONE VERIFICATION (Login via OTP)
  // =========================================================================

  /**
   * Send a verification code via SMS for phone-based login
   */
  async sendVerificationCode(phone) {
    try {
      const c = getClient();
      if (!c) throw new Error('Twilio not configured');
      const verification = await c.verify.v2
        .services(config.twilio.verifyServiceSid)
        .verifications.create({ to: phone, channel: 'sms' });

      logger.info(`Verification sent to ${maskPhone(phone)}: ${verification.status}`);
      return { success: true, status: verification.status };
    } catch (err) {
      logger.error(`Twilio verification send failed: ${err.message}`);
      throw new Error('Failed to send verification code');
    }
  },

  /**
   * Check a verification code
   */
  async checkVerificationCode(phone, code) {
    try {
      const c = getClient();
      if (!c) throw new Error('Twilio not configured');
      const check = await c.verify.v2
        .services(config.twilio.verifyServiceSid)
        .verificationChecks.create({ to: phone, code });

      logger.info(`Verification check for ${maskPhone(phone)}: ${check.status}`);
      return { success: check.status === 'approved', status: check.status };
    } catch (err) {
      logger.error(`Twilio verification check failed: ${err.message}`);
      throw new Error('Verification check failed');
    }
  },

  // =========================================================================
  // SERVICE NOTIFICATIONS
  // =========================================================================

  /**
   * Send a single SMS message — routes through the customer's location number
   * options: { customerId, customerLocationId, fromNumber, messageType, adminUserId }
   */
  async sendSMS(to, body, options = {}) {
    try {
      // Owner-SMS kill switch: when OWNER_SMS_DISABLED=true, suppress
      // every send addressed to one of the operator's known phones.
      // Push and bell still fire normally — only Twilio is silenced.
      // See HARDCODED_OWNER_FALLBACKS / getOwnerPhoneSet above.
      //
      // Logged with metadata only — no body preview, no full recipient.
      // Internal alerts contain customer PII (names, addresses) and the
      // AGENTS.md PII-in-logs rule applies even on the suppression path.
      if (isOwnerSmsSilenced(to)) {
        logger.info(`[OWNER_SMS_DISABLED] suppressed SMS to ${maskPhone(to)} (messageType=${options.messageType || 'n/a'}, bodyLen=${body?.length || 0})`);
        return { success: true, sid: 'owner-sms-disabled', suppressed: true };
      }

      const { isEnabled } = require('../config/feature-gates');
      if (!isEnabled('twilioSms')) {
        logger.info(`[GATE BLOCKED] SMS to ${maskPhone(to)} (messageType=${options.messageType || 'n/a'}, bodyLen=${body?.length || 0}, gate=twilioSms)`);
        return { success: true, sid: 'gate-blocked', gateBlocked: true };
      }

      // Pre-send guard — rejects messages that look like a template
      // rendering bug (stale month, unsubstituted variables, "undefined",
      // etc.) before they ship to customers. See services/sms-guard.js.
      try {
        const { validateOutbound } = require('./sms-guard');
        const hasMedia = Array.isArray(options.mediaUrls) && options.mediaUrls.length > 0;
        const guard = hasMedia && !String(body || '').trim()
          ? { ok: true }
          : validateOutbound(body, { messageType: options.messageType });
        if (!guard.ok) {
          logger.warn(`[SMS-GUARD BLOCKED] to=${maskPhone(to)} reason=${guard.reason} messageType=${options.messageType || 'n/a'} bodyLen=${body?.length || 0}`);
          // Best-effort alert to the operator so a blocked send gets human eyes.
          // Non-blocking — if the alert path breaks we still refuse the send.
          // Honors OWNER_SMS_DISABLED (the kill switch above only applied to
          // the primary `to` argument; this branch directly calls
          // c.messages.create against ownerPhone, so it needs its own guard).
          (async () => {
            try {
              const ownerPhone = process.env.OWNER_PHONE || '+19413187612';
              if (to !== ownerPhone && !isOwnerSmsSilenced(ownerPhone)) {
                const c = getClient();
                if (c) {
                  await c.messages.create({
                    to: ownerPhone,
                    from: options.fromNumber || ownerPhone,
                    body: `[SMS-GUARD] Blocked outbound to ${maskPhone(to)}\nReason: ${guard.reason}\nMessage type: ${options.messageType || 'n/a'}\nBody length: ${body?.length || 0}`,
                  }).catch(() => {});
                }
              }
            } catch { /* alert is best-effort */ }
          })();
          return { success: false, sid: null, guardBlocked: true, error: guard.reason };
        }
      } catch (gErr) {
        // If the guard itself blows up, fail open — missing a legit send is
        // worse than shipping a message the guard would've rejected.
        logger.warn(`[sms-guard] validator failed (failing open): ${gErr.message}`);
      }

      // Check if this message type has been disabled via SMS Templates admin
      if (options.messageType && options.messageType !== 'internal_alert') {
        try {
          const templates = require('../routes/admin-sms-templates');
          const active = await templates.isTemplateActive(options.messageType);
          if (!active) {
            logger.info(`[SMS DISABLED] Template "${options.messageType}" is off — skipping SMS to ${maskPhone(to)}`);
            return { success: true, sid: 'template-disabled', templateDisabled: true };
          }
        } catch { /* template check failed — send anyway */ }
      }

      const TWILIO_NUMBERS = require('../config/twilio-numbers');
      const { resolveLocation } = require('../config/locations');

      // Determine FROM number — always the customer's location number
      let fromNumber = options.fromNumber;

      if (!fromNumber) {
        let locationId = options.customerLocationId;

        if (!locationId && options.customerId) {
          try {
            const customer = await db('customers').where({ id: options.customerId }).first();
            if (customer) {
              const loc = resolveLocation(customer.city);
              locationId = loc.id;
            }
          } catch {}
        }

        fromNumber = TWILIO_NUMBERS.getOutboundNumber(locationId || 'lakewood-ranch');
      }

      const c = getClient();
      if (!c) {
        logger.warn(`[twilio] Cannot send SMS — client not initialized. To: ${maskPhone(to)}`);
        return { success: false, sid: null, error: 'Twilio not configured' };
      }

      const msgPayload = { from: fromNumber, to };
      if (body && String(body).trim()) msgPayload.body = body;
      // Include Waves logo for automated messages, not manual correspondence.
      // Admin composer can attach multiple images via `mediaUrls` (plural) —
      // preserve the legacy single-image `mediaUrl` path for existing callers.
      const isManual = options.messageType === 'manual' || options.skipLogo;
      const urls = [];
      let explicitMedia = [];
      if (Array.isArray(options.mediaUrls) && options.mediaUrls.length > 0) {
        for (const u of options.mediaUrls.slice(0, 10)) {
          if (typeof u === 'string' && u) urls.push(u);
        }
        explicitMedia = urls.map((url, index) => ({ url, index }));
      } else if (options.mediaUrl) {
        urls.push(options.mediaUrl);
        explicitMedia = [{ url: options.mediaUrl, index: 0 }];
      } else if (!isManual) {
        urls.push(WAVES_LOGO_URL);
      }
      if (urls.length > 0) msgPayload.mediaUrl = urls;
      const message = await c.messages.create(msgPayload);
      logger.info(`SMS sent to ${maskPhone(to)} from ${maskPhone(fromNumber)}: ${message.sid}`);

      // Log to sms_log (legacy) AND dual-write to unified messages.
      // PR 2 cuts the inbox read path over to messages; sms_log stays as
      // long as anything still queries it (scheduled-SMS queue, BI scripts).
      try {
        await db('sms_log').insert({
          customer_id: options.customerId || null,
          direction: 'outbound',
          from_phone: fromNumber,
          to_phone: to,
          message_body: body,
          twilio_sid: message.sid,
          status: 'sent',
          message_type: options.messageType || 'manual',
          admin_user_id: options.adminUserId || null,
          metadata: options.media ? JSON.stringify({ media: options.media }) : null,
        });
      } catch (logErr) {
        logger.error(`SMS log failed: ${logErr.message}`);
      }
      require('./conversations').recordTouchpoint({
        customerId: options.customerId || null,
        channel: 'sms',
        ourEndpointId: fromNumber,
        contactPhone: options.customerId ? null : to,
        direction: 'outbound',
        body,
        authorType: options.adminUserId ? 'admin' : 'system',
        adminUserId: options.adminUserId || null,
        twilioSid: message.sid,
        media: options.media || explicitMedia,
        messageType: options.messageType || 'manual',
        deliveryStatus: 'sent',
      }).catch(() => {});

      return { success: true, sid: message.sid, fromNumber };
    } catch (err) {
      logger.error(`SMS send failed to ${maskPhone(to)}: ${err.message}`);
      throw new Error('Failed to send SMS');
    }
  },

  /**
   * Send 24-hour service reminder
   * Called by cron job the day before scheduled service
   */
  async sendServiceReminder(customerId, scheduledServiceId) {
    const customer = await db('customers').where({ id: customerId }).first();
    const service = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'technicians.name as tech_name')
      .first();

    if (!customer || !service) return;

    // Check if customer has this notification enabled
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (!prefs?.service_reminder_24h || !prefs?.sms_enabled) return;

    const timeWindow = service.window_start && service.window_end
      ? `between ${formatTime(service.window_start)} - ${formatTime(service.window_end)}`
      : '(time window TBD)';

    const body = `🌊 Waves Pest Control — Service Reminder\n\n` +
      `Hi ${customer.first_name}! Your ${service.service_type} is scheduled for tomorrow ${timeWindow}.\n\n` +
      `Technician: ${service.tech_name || 'TBD'}\n\n` +
      `Please ensure gates are unlocked and pets are secured. ` +
      `Reply CONFIRM to confirm or call (941) 555-0100 to reschedule.`;

    return this.sendSMS(customer.phone, body);
  },

  /**
   * Send "tech en route" notification
   * Called when tech marks job as started in the field
   *
   * trackToken (optional): when present, body includes the /track/:token
   * link so the customer can tap through to the live tracking page.
   * Phase 1 callers always pass a token (minted by migration backfill);
   * legacy callers that pass nothing still get a sensible bodyless message.
   */
  async sendTechEnRoute(customerId, techName, etaMinutes, trackToken = null) {
    const customer = await db('customers').where({ id: customerId }).first();
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (!customer || !prefs?.tech_en_route || !prefs?.sms_enabled) return;

    const firstName = customer.first_name || '';
    const eta = etaMinutes ? `ETA: ~${etaMinutes} minutes.\n\n` : '';

    let body;
    if (trackToken) {
      const origin = process.env.CLIENT_URL
        || process.env.PUBLIC_PORTAL_URL
        || 'https://portal.wavespestcontrol.com';
      const trackUrl = `${origin}/track/${trackToken}`;
      body = `Hi ${firstName} — ${techName} is on the way.\n${eta}` +
        `Track live: ${trackUrl}\n\n` +
        `Reply STOP to opt out.`;
    } else {
      body = `🌊 Waves Pest Control\n\n` +
        `${techName} is on the way to your property! ` +
        `${eta}` +
        `Please ensure gates are unlocked and pets are secured.`;
    }

    return this.sendSMS(customer.phone, body, {
      customerId,
      messageType: 'tech_en_route',
    });
  },

  /**
   * Send service completion summary
   * Called after tech completes service and submits notes
   */
  async sendServiceCompletedSummary(customerId, serviceRecordId) {
    const customer = await db('customers').where({ id: customerId }).first();
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (!customer || !prefs?.service_completed || !prefs?.sms_enabled) return;

    const service = await db('service_records')
      .where({ id: serviceRecordId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'technicians.name as tech_name')
      .first();

    const products = await db('service_products')
      .where({ service_record_id: serviceRecordId })
      .select('product_name');

    const productList = products.map(p => p.product_name).join(', ');

    const portalUrl = 'https://portal.wavespestcontrol.com';
    const body = `Hello ${customer.first_name}! Your service report is ready. View it here: ${portalUrl}`;

    return this.sendSMS(customer.phone, body, { customerId: customerId, messageType: 'service_complete' });
  },

  /**
   * Send monthly billing reminder
   */
  async sendBillingReminder(customerId, amount, date) {
    const customer = await db('customers').where({ id: customerId }).first();
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (!customer || !prefs?.billing_reminder || !prefs?.sms_enabled) return;

    const body = `🌊 Waves Pest Control — Billing Notice\n\n` +
      `Hi ${customer.first_name}, your ${customer.waveguard_tier} WaveGuard monthly charge of $${amount.toFixed(2)} ` +
      `will be processed on ${date}.\n\n` +
      `Manage your payment method in your customer portal or call (941) 555-0100.`;

    return this.sendSMS(customer.phone, body);
  },

  /**
   * Send seasonal tip / pest alert
   */
  async sendSeasonalAlert(customerId, subject, tip) {
    const customer = await db('customers').where({ id: customerId }).first();
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (!customer || !prefs?.seasonal_tips || !prefs?.sms_enabled) return;

    const body = `🌊 Waves Pest Control — ${subject}\n\n` +
      `Hi ${customer.first_name}! ${tip}\n\n` +
      `Questions? Reply to this text or call (941) 555-0100.`;

    return this.sendSMS(customer.phone, body);
  },
};

// Helper
function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, '0')} ${ampm}`;
}

module.exports = TwilioService;
