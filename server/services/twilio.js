const twilio = require("twilio");
const config = require("../config");
const db = require("../models/db");
const logger = require("./logger");
const smsTemplatesRouter = require("../routes/admin-sms-templates");
const { shortenOrPassthrough } = require("./short-url");
const { formatTechnicianForCustomer } = require("../utils/technician-name");
const { publicPortalUrl } = require("../utils/portal-url");

// Owner/admin SMS controls.
//
// 25+ places in the codebase send SMS to the operator's personal phone
// — new-lead alerts, billing crons, BI briefings, SEO digests, missed
// appointments, etc. — and most of them have hardcoded phone fallbacks
// like '+19413187612' / '+19415993489'. Legacy internal/admin alert SMS
// to those phones is redirected to Waves admin notifications before Twilio.
// When OWNER_SMS_DISABLED='true', sendSMS() also suppresses any remaining
// non-alert send whose recipient matches a known owner phone.
//
// Toggleable via env var so the kill switch is reversible without a
// deploy: set OWNER_SMS_DISABLED=true on Railway → silence; unset
// or set to anything else → restore.
const HARDCODED_OWNER_FALLBACKS = ["+19413187612", "+19415993489"];

function normalizePhone(p) {
  if (!p || typeof p !== "string") return "";
  // Canonicalize to bare digits. SMS recipient strings arrive in mixed
  // formats — env-var literals (`+19413187612`), user input
  // (`(941) 318-7612` / `941-318-7612`), JS string concat
  // (`19413187612`) — so reduce both sides of every comparison to a
  // single form. US numbers also vary on whether the country-code `1`
  // is included; strip a leading `1` from 11-digit numbers so the
  // 10-digit and 11-digit forms collide.
  let d = p.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d;
}

// Mask a phone for logging: keep only the last 4 digits.
function maskPhone(p) {
  const d = normalizePhone(p);
  return d.length >= 4 ? `***${d.slice(-4)}` : "***";
}

function sanitizeTwilioError(value) {
  if (!value) return "";
  return String(value)
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted-phone]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function formatTwilioSendError(err) {
  if (!err) return "Twilio send failed";
  const parts = [];
  if (err.code) parts.push(`Twilio ${err.code}`);
  if (err.status) parts.push(`HTTP ${err.status}`);
  if (err.message) parts.push(sanitizeTwilioError(err.message));
  return parts.filter(Boolean).join(": ") || "Twilio send failed";
}

async function sendCustomerPolicySms(input) {
  if (input.purpose === "marketing" && input.consentBasis?.status !== "opted_in") {
    throw new Error("Marketing SMS requires explicit opted-in consent basis");
  }
  const { consentBasis, metadata, messageType, ...sendFields } = input;
  const { sendCustomerMessage } = require("./messaging/send-customer-message");
  const result = await sendCustomerMessage({
    channel: "sms",
    audience: "customer",
    identityTrustLevel: "phone_matches_customer",
    ...sendFields,
    consentBasis,
    metadata: {
      original_message_type: messageType,
      ...(metadata || {}),
    },
  });
  if (result && result.sent === false && result.blocked !== true) {
    throw new Error(result.reason || result.code || "SMS provider send failed");
  }
  return result;
}

function getOwnerPhoneSet() {
  const candidates = [
    process.env.OWNER_PHONE,
    process.env.ADAM_PHONE,
    process.env.ADAM_CELL,
    process.env.ADMIN_PHONE,
    process.env.WAVES_OFFICE_PHONE,
    process.env.WAVES_ADMIN_PHONE,
    ...HARDCODED_OWNER_FALLBACKS,
  ];
  return new Set(candidates.map(normalizePhone).filter(Boolean));
}

function isKnownOwnerPhone(to) {
  return getOwnerPhoneSet().has(normalizePhone(to));
}

function isOwnerSmsSilenced(to) {
  if (process.env.OWNER_SMS_DISABLED !== "true") return false;
  return isKnownOwnerPhone(to);
}

function isInternalAdminAlertType(messageType) {
  const type = String(messageType || "").toLowerCase();
  return type === "internal_alert" || type === "admin_alert";
}

function buildInternalAlertPayload(body, options = {}) {
  const text = String(body || "").trim();
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const title = String(options.notificationTitle || lines[0] || "Internal admin alert").slice(0, 180);
  const notificationBody = options.notificationBody || (lines.length > 1 ? lines.slice(1).join("\n") : text);
  return {
    title,
    body: notificationBody ? String(notificationBody).slice(0, 1500) : null,
    link: options.link || "/admin/dashboard",
    originalMessageType: options.messageType || null,
  };
}

function internalAlertNotificationDelivered(stats) {
  if (!stats || stats.error) return false;
  if (stats.bellWritten) return true;
  return Number(stats.push?.sent || 0) > 0;
}

function auditInternalAlertDeliveryIssue(details) {
  try {
    const { auditInternalAdminAlertDeliveryIssue } = require("./audit-log");
    auditInternalAdminAlertDeliveryIssue(details);
  } catch (err) {
    logger.error(`[twilio] internal alert delivery audit failed: ${err.message}`);
  }
}

async function notifySmsGuardBlocked({ to, body, reason, messageType }) {
  try {
    const { triggerNotification } = require("./notification-triggers");
    await triggerNotification("internal_admin_alert", {
      title: "SMS guard blocked outbound message",
      body: [
        `Reason: ${reason}`,
        `Message type: ${messageType || "n/a"}`,
        `Recipient: ${maskPhone(to)}`,
        `Body length: ${body?.length || 0}`,
      ].join("\n"),
      link: "/admin/sms-templates",
      originalMessageType: "sms_guard_blocked",
      originalToMasked: maskPhone(to),
    });
  } catch (err) {
    logger.error(`[sms-guard] blocked-send admin notification failed: ${err.message}`);
  }
}

async function redirectInternalAdminSmsToNotification(to, body, options = {}) {
  if (options.allowOwnerSms === true) return null;
  if (!isKnownOwnerPhone(to) || !isInternalAdminAlertType(options.messageType)) return null;

  const payload = buildInternalAlertPayload(body, options);
  try {
    const { triggerNotification } = require("./notification-triggers");
    const stats = await triggerNotification("internal_admin_alert", {
      ...payload,
      originalToMasked: maskPhone(to),
    });
    if (!internalAlertNotificationDelivered(stats)) {
      logger.warn(
        `[twilio] internal alert notification redirect did not deliver; suppressed owner/admin SMS fallback (messageType=${options.messageType || "n/a"}, to=${maskPhone(to)}, bodyLen=${body?.length || 0})`,
      );
      auditInternalAlertDeliveryIssue({
        outcome: "undelivered",
        message_type: options.messageType || null,
        to_masked: maskPhone(to),
        body_length: body?.length || 0,
        title: payload.title,
        link: payload.link,
        reason: "notification_redirect_undelivered",
        stats,
      });
      return {
        success: true,
        sid: "internal-admin-notification-undelivered",
        suppressed: true,
        notificationRedirected: false,
        notificationUndelivered: true,
      };
    }
    logger.info(
      `[twilio] redirected owner/admin SMS to Waves notification (messageType=${options.messageType || "n/a"}, to=${maskPhone(to)}, bodyLen=${body?.length || 0})`,
    );
    return {
      success: true,
      sid: "internal-admin-notification",
      suppressed: true,
      notificationRedirected: true,
    };
  } catch (err) {
    logger.error(`[twilio] internal alert notification redirect failed; suppressed owner/admin SMS fallback: ${err.message}`);
    auditInternalAlertDeliveryIssue({
      outcome: "error",
      message_type: options.messageType || null,
      to_masked: maskPhone(to),
      body_length: body?.length || 0,
      title: payload.title,
      link: payload.link,
      reason: err.message,
      stats: null,
    });
    return {
      success: true,
      sid: "internal-admin-notification-error",
      suppressed: true,
      notificationRedirected: false,
      notificationError: true,
    };
  }
}

// Lazy-initialize Twilio client — don't crash if creds are missing
let _client;
function getClient() {
  if (_client) return _client;
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    logger.warn(
      "[twilio] TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set — SMS/voice disabled",
    );
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
      if (!c) throw new Error("Twilio not configured");
      const verification = await c.verify.v2
        .services(config.twilio.verifyServiceSid)
        .verifications.create({ to: phone, channel: "sms" });

      logger.info(
        `Verification sent to ${maskPhone(phone)}: ${verification.status}`,
      );
      return { success: true, status: verification.status };
    } catch (err) {
      logger.error(`Twilio verification send failed: ${err.message}`);
      throw new Error("Failed to send verification code");
    }
  },

  /**
   * Check a verification code
   */
  async checkVerificationCode(phone, code) {
    try {
      const c = getClient();
      if (!c) throw new Error("Twilio not configured");
      const check = await c.verify.v2
        .services(config.twilio.verifyServiceSid)
        .verificationChecks.create({ to: phone, code });

      logger.info(
        `Verification check for ${maskPhone(phone)}: ${check.status}`,
      );
      return { success: check.status === "approved", status: check.status };
    } catch (err) {
      logger.error(`Twilio verification check failed: ${err.message}`);
      throw new Error("Verification check failed");
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
    let attemptedFrom = options.fromNumber || null;
    try {
      const internalRedirect = await redirectInternalAdminSmsToNotification(to, body, options);
      if (internalRedirect) return internalRedirect;

      // Owner-SMS kill switch: when OWNER_SMS_DISABLED=true, suppress
      // every send addressed to one of the operator's known phones.
      // Push and bell still fire normally — only Twilio is silenced.
      // See HARDCODED_OWNER_FALLBACKS / getOwnerPhoneSet above.
      //
      // Logged with metadata only — no body preview, no full recipient.
      // Internal alerts contain customer PII (names, addresses) and the
      // AGENTS.md PII-in-logs rule applies even on the suppression path.
      if (isOwnerSmsSilenced(to)) {
        logger.info(
          `[OWNER_SMS_DISABLED] suppressed SMS to ${maskPhone(to)} (messageType=${options.messageType || "n/a"}, bodyLen=${body?.length || 0})`,
        );
        return { success: true, sid: "owner-sms-disabled", suppressed: true };
      }

      if (
        isInternalAdminAlertType(options.messageType) &&
        !isKnownOwnerPhone(to) &&
        options.allowUnknownInternalAlertRecipient !== true
      ) {
        logger.error(
          `[twilio] blocked internal/admin alert to unknown recipient ${maskPhone(to)} (messageType=${options.messageType || "n/a"}, bodyLen=${body?.length || 0})`,
        );
        return {
          success: false,
          sid: null,
          blocked: true,
          guardBlocked: true,
          error: "Internal/admin alert recipient is not a known owner/admin phone",
        };
      }

      const { isEnabled } = require("../config/feature-gates");
      if (!isEnabled("twilioSms")) {
        logger.info(
          `[GATE BLOCKED] SMS to ${maskPhone(to)} (messageType=${options.messageType || "n/a"}, bodyLen=${body?.length || 0}, gate=twilioSms)`,
        );
        return { success: true, sid: "gate-blocked", gateBlocked: true };
      }

      // Pre-send guard — rejects messages that look like a template
      // rendering bug (stale month, unsubstituted variables, "undefined",
      // etc.) before they ship to customers. See services/sms-guard.js.
      try {
        const { validateOutbound } = require("./sms-guard");
        const hasMedia =
          Array.isArray(options.mediaUrls) && options.mediaUrls.length > 0;
        const guard =
          hasMedia && !String(body || "").trim()
            ? { ok: true }
            : validateOutbound(body, {
                messageType: options.messageType,
                humanAuthored: options.humanAuthored === true,
              });
        if (!guard.ok) {
          logger.warn(
            `[SMS-GUARD BLOCKED] to=${maskPhone(to)} reason=${guard.reason} messageType=${options.messageType || "n/a"} bodyLen=${body?.length || 0}`,
          );
          // Best-effort alert to the operator so a blocked send gets human eyes.
          // Non-blocking — if the alert path breaks we still refuse the send.
          notifySmsGuardBlocked({
            to,
            body,
            reason: guard.reason,
            messageType: options.messageType,
          });
          return {
            success: false,
            sid: null,
            guardBlocked: true,
            error: guard.reason,
          };
        }
      } catch (gErr) {
        // If the guard itself blows up, fail open — missing a legit send is
        // worse than shipping a message the guard would've rejected.
        logger.warn(
          `[sms-guard] validator failed (failing open): ${gErr.message}`,
        );
      }

      // Check if this message type has been disabled via SMS Templates admin
      if (options.messageType && options.messageType !== "internal_alert") {
        try {
          const templates = require("../routes/admin-sms-templates");
          const active = await templates.isTemplateActive(options.messageType);
          if (!active) {
            logger.info(
              `[SMS DISABLED] Template "${options.messageType}" is off — skipping SMS to ${maskPhone(to)}`,
            );
            return {
              success: true,
              sid: "template-disabled",
              templateDisabled: true,
            };
          }
        } catch {
          /* template check failed — send anyway */
        }
      }

      const TWILIO_NUMBERS = require("../config/twilio-numbers");
      const { resolveLocation } = require("../config/locations");

      // Determine FROM number — always the customer's location number
      let fromNumber = options.fromNumber;

      if (!fromNumber) {
        let locationId = options.customerLocationId;

        if (!locationId && options.customerId) {
          try {
            const customer = await db("customers")
              .where({ id: options.customerId })
              .first();
            if (customer) {
              const loc = resolveLocation(customer.city);
              locationId = loc.id;
            }
          } catch {}
        }

        fromNumber = TWILIO_NUMBERS.getOutboundNumber(
          locationId || "bradenton",
        );
      }
      attemptedFrom = fromNumber;

      const c = getClient();
      if (!c) {
        logger.warn(
          `[twilio] Cannot send SMS — client not initialized. To: ${maskPhone(to)}`,
        );
        return { success: false, sid: null, error: "Twilio not configured" };
      }

      const domain =
        process.env.SERVER_DOMAIN ||
        process.env.RAILWAY_PUBLIC_DOMAIN ||
        "portal.wavespestcontrol.com";
      const msgPayload = {
        from: fromNumber,
        to,
        statusCallback: `https://${domain}/api/webhooks/twilio/status`,
      };
      if (body && String(body).trim()) msgPayload.body = body;
      // Admin composer can attach multiple images via `mediaUrls` (plural) —
      // preserve the legacy single-image `mediaUrl` path for existing callers.
      // Do not attach default media to automated SMS. If Twilio cannot fetch
      // the media URL, the whole outbound message can fail before carrier handoff.
      const urls = [];
      let explicitMedia = [];
      if (Array.isArray(options.mediaUrls) && options.mediaUrls.length > 0) {
        for (const u of options.mediaUrls.slice(0, 10)) {
          if (typeof u === "string" && u) urls.push(u);
        }
        explicitMedia = urls.map((url, index) => ({ url, index }));
      } else if (options.mediaUrl) {
        urls.push(options.mediaUrl);
        explicitMedia = [{ url: options.mediaUrl, index: 0 }];
      }
      if (urls.length > 0) msgPayload.mediaUrl = urls;
      const message = await c.messages.create(msgPayload);
      logger.info(
        `SMS sent to ${maskPhone(to)} from ${maskPhone(fromNumber)}: ${message.sid}`,
      );

      // Log to sms_log (legacy) AND dual-write to unified messages.
      // PR 2 cuts the inbox read path over to messages; sms_log stays as
      // long as anything still queries it (scheduled-SMS queue, BI scripts).
      try {
        await db("sms_log").insert({
          customer_id: options.customerId || null,
          direction: "outbound",
          from_phone: fromNumber,
          to_phone: to,
          message_body: body,
          twilio_sid: message.sid,
          status: "sent",
          message_type: options.messageType || "manual",
          admin_user_id: options.adminUserId || null,
          // Decision linkage makes the sent row recoverable: if the process
          // dies after Twilio accepts but before the caller resolves the
          // Agent Review decisions (composer send or scheduled-SMS cron),
          // the nightly suggest sweep resolves the used decision and ignores
          // the parked ones from this linkage instead of reopening cards on
          // an answered thread.
          // scheduled_sms_log_id ties this provider row back to the queued
          // row that dispatched it, so stale-claim recovery can prove the
          // send happened instead of retrying (double-send) or reopening.
          metadata: (options.media || options.agentDecisionId || options.scheduledSmsLogId || (Array.isArray(options.parkedDecisionIds) && options.parkedDecisionIds.length))
            ? JSON.stringify({
              ...(options.media ? { media: options.media } : {}),
              ...(options.agentDecisionId ? { agent_decision_id: options.agentDecisionId } : {}),
              ...(Array.isArray(options.parkedDecisionIds) && options.parkedDecisionIds.length
                ? { parked_decision_ids: options.parkedDecisionIds }
                : {}),
              ...(options.scheduledSmsLogId ? { scheduled_sms_log_id: options.scheduledSmsLogId } : {}),
            })
            : null,
        });
      } catch (logErr) {
        logger.error(`SMS log failed: ${logErr.message}`);
      }
      require("./conversations")
        .recordTouchpoint({
          customerId: options.customerId || null,
          channel: "sms",
          ourEndpointId: fromNumber,
          contactPhone: to,
          direction: "outbound",
          body,
          authorType: options.adminUserId ? "admin" : "system",
          adminUserId: options.adminUserId || null,
          twilioSid: message.sid,
          media: options.media || explicitMedia,
          messageType: options.messageType || "manual",
          deliveryStatus: "sent",
        })
        .then((recorded) => {
          if (!recorded?.message) return null;
          return require("./reply-training-capture").captureReplyExampleForMessage(recorded.message, {
            customerId: options.customerId || null,
            metadata: {
              captureSource: "twilio_send_sms",
              originalMessageType: options.messageType || "manual",
              agentDecisionId: options.agentDecisionId || null,
              agentDraft: options.agentDraft || null,
              suggestedReply: options.suggestedReply || null,
            },
          });
        })
        .catch(() => {});

      return { success: true, sid: message.sid, fromNumber };
    } catch (err) {
      const providerError = formatTwilioSendError(err);
      logger.error(`SMS send failed to ${maskPhone(to)}: ${providerError}`);
      void require("./twilio-failure-alerts")
        .alertTwilioFailure({
          channel: "sms",
          direction: "outbound",
          phase: "send_api",
          status: "failed",
          errorMessage: providerError,
          from: attemptedFrom,
          to,
          link: "/admin/communications",
        })
        .catch((alertErr) => {
          logger.error(
            `[twilio-alerts] async notification failed: ${alertErr.message}`,
          );
        });
      const wrapped = new Error(`Failed to send SMS: ${providerError}`);
      wrapped.providerError = providerError;
      wrapped.code = err.code;
      wrapped.status = err.status;
      throw wrapped;
    }
  },

  /**
   * Send 24-hour service reminder
   * Called by cron job the day before scheduled service
   */
  async sendServiceReminder(customerId, scheduledServiceId) {
    const customer = await db("customers").where({ id: customerId }).first();
    const service = await db("scheduled_services")
      .where({ id: scheduledServiceId })
      .leftJoin(
        "technicians",
        "scheduled_services.technician_id",
        "technicians.id",
      )
      .select("scheduled_services.*", "technicians.name as tech_name")
      .first();

    if (!customer || !service) return;

    // Check if customer has this notification enabled
    const prefs = await db("notification_prefs")
      .where({ customer_id: customerId })
      .first();
    if (!prefs?.service_reminder_24h || !prefs?.sms_enabled) return;

    const time = service.window_start
      ? formatTime(service.window_start)
      : "a time to be confirmed";

    const body =
      typeof smsTemplatesRouter.getTemplate === "function"
        ? await smsTemplatesRouter.getTemplate("reminder_24h", {
            first_name: customer.first_name || "",
            service_type: service.service_type || "service",
            time,
          }, { workflow: "twilio_reminder_24h", entity_type: "scheduled_service", entity_id: scheduledServiceId })
        : null;
    if (!body) {
      logger.warn(
        `[twilio] reminder_24h template missing/disabled — skipping reminder for customer ${customerId}`,
      );
      return;
    }

    return sendCustomerPolicySms({
      to: customer.phone,
      body,
      purpose: "appointment_reminder_24h",
      customerId,
      identityTrustLevel: "service_contact_authorized",
      messageType: "appointment_reminder",
    });
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
    const customer = await db("customers").where({ id: customerId }).first();
    const prefs = await db("notification_prefs")
      .where({ customer_id: customerId })
      .first();
    if (!customer || !prefs?.tech_en_route || !prefs?.sms_enabled) return;

    const etaLine = etaMinutes ? `ETA: ~${etaMinutes} minutes.\n` : "";
    const { getAppointmentContacts, isServiceContactRole } = require("./customer-contact");
    const contacts = getAppointmentContacts(customer, prefs);
    if (!contacts.length) return;

    const origin = publicPortalUrl();
    const longTrackUrl = trackToken ? `${origin}/track/${trackToken}` : null;
    const trackUrl = longTrackUrl
      ? await shortenOrPassthrough(longTrackUrl, {
          kind: "tracking",
          entityType: "scheduled_services",
          customerId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        })
      : null;

    const trackClause = trackUrl ? `Track live: ${trackUrl}\n\n` : "";
    const customerTechName = formatTechnicianForCustomer({ name: techName });

    const results = [];
    const {
      sendCustomerMessage,
    } = require("./messaging/send-customer-message");
    // Cached-landline shortcut: the customers.line_type cache is the customer's
    // PRIMARY phone (learned from Twilio Lookup or a prior 30006 bounce). If it's
    // a landline, the primary number can't receive SMS, so skip it and let the
    // email fallback carry the notice.
    const digitsOnly = (v) => String(v || "").replace(/\D/g, "").slice(-10);
    const primaryDigits = digitsOnly(customer.phone);
    const cachedPrimaryLandline = customer.line_type === "landline" && !!primaryDigits;
    let attemptedSms = false;
    let landlineSkipped = false;
    for (const contact of contacts) {
      if (cachedPrimaryLandline && digitsOnly(contact.phone) === primaryDigits) {
        landlineSkipped = true;
        continue;
      }
      const firstName = contact.name || customer.first_name || "";
      let body = null;
      if (typeof smsTemplatesRouter.getTemplate === "function") {
        body = await smsTemplatesRouter.getTemplate("tech_en_route", {
          first_name: firstName,
          tech_name: customerTechName,
          eta_line: etaLine,
          track_clause: trackClause,
          track_url: trackUrl || "",
        }, { workflow: "tech_en_route", entity_type: "customer", entity_id: customerId });
      }
      if (!body) {
        logger.warn(
          `[twilio] tech_en_route template missing/disabled — skipping en-route SMS for customer ${customerId}`,
        );
        continue;
      }
      attemptedSms = true;
      results.push(
        await sendCustomerMessage({
          to: contact.phone,
          body,
          channel: "sms",
          audience: "customer",
          purpose: "tech_en_route",
          customerId,
          identityTrustLevel:
            isServiceContactRole(contact.role)
              ? "service_contact_authorized"
              : "phone_matches_customer",
          metadata: { original_message_type: "tech_en_route" },
        }),
      );
    }

    const delivered = results.some((r) => r?.sent);

    // None of the contacts could receive the en-route text (landline / no mobile /
    // blocked) — send the en-route notice by email instead so the customer still
    // knows the tech is on the way.
    if (!delivered && (attemptedSms || landlineSkipped)) {
      try {
        const AppointmentEmail = require("./appointment-email");
        await AppointmentEmail.sendTechEnRouteEmail({
          customerId,
          techName: customerTechName,
          etaMinutes,
          trackUrl: trackUrl || longTrackUrl,
          idempotencyKey: `appointment.en_route:${trackToken || customerId}`,
        });
      } catch (e) {
        logger.warn(`[twilio] en-route email fallback failed for customer ${customerId}: ${e.message}`);
      }
    }

    return { success: delivered, results };
  },

  /**
   * Send "tech arrived/on property" notification.
   *
   * Uses the same customer preference gate as en-route notifications
   * (`notification_prefs.tech_en_route`) because this is the same
   * appointment-progress class, but the copy must not say "on the way".
   */
  async sendTechArrived(customerId, techName) {
    const customer = await db("customers").where({ id: customerId }).first();
    const prefs = await db("notification_prefs")
      .where({ customer_id: customerId })
      .first();
    if (!customer || !prefs?.tech_en_route || !prefs?.sms_enabled) return;

    const { getAppointmentContacts, isServiceContactRole } = require("./customer-contact");
    const contacts = getAppointmentContacts(customer, prefs);
    if (!contacts.length) return;

    const results = [];
    const {
      sendCustomerMessage,
    } = require("./messaging/send-customer-message");
    const customerTechName = formatTechnicianForCustomer({ name: techName });
    for (const contact of contacts) {
      const firstName = contact.name || customer.first_name || "";
      let body = null;
      if (typeof smsTemplatesRouter.getTemplate === "function") {
        body = await smsTemplatesRouter.getTemplate("tech_arrived", {
          first_name: firstName,
          tech_name: customerTechName,
        }, { workflow: "tech_arrived", entity_type: "customer", entity_id: customerId });
      }
      if (!body) {
        logger.warn(
          `[twilio] tech_arrived template missing/disabled — skipping arrival SMS for customer ${customerId}`,
        );
        continue;
      }
      results.push(
        await sendCustomerMessage({
          to: contact.phone,
          body,
          channel: "sms",
          audience: "customer",
          purpose: "tech_en_route",
          customerId,
          identityTrustLevel:
            isServiceContactRole(contact.role)
              ? "service_contact_authorized"
              : "phone_matches_customer",
          metadata: {
            original_message_type: "tech_en_route",
            appointment_progress_event: "tech_arrived",
          },
        }),
      );
    }

    return { success: results.some((r) => r?.sent), results };
  },

  /**
   * Send service completion summary
   * Called after tech completes service and submits notes
   */
  async sendServiceCompletedSummary(customerId, serviceRecordId) {
    const customer = await db("customers").where({ id: customerId }).first();
    const prefs = await db("notification_prefs")
      .where({ customer_id: customerId })
      .first();
    if (!customer || !prefs?.service_completed || !prefs?.sms_enabled) return;

    const service = await db("service_records")
      .where({ id: serviceRecordId })
      .leftJoin(
        "technicians",
        "service_records.technician_id",
        "technicians.id",
      )
      .select("service_records.*", "technicians.name as tech_name")
      .first();

    const products = await db("service_products")
      .where({ service_record_id: serviceRecordId })
      .select("product_name");

    const productList = products.map((p) => p.product_name).join(", ");

    const body =
      typeof smsTemplatesRouter.getTemplate === "function"
        ? await smsTemplatesRouter.getTemplate("service_complete", {
            first_name: customer.first_name || "",
          }, { workflow: "service_complete", entity_type: "service_record", entity_id: serviceRecordId })
        : null;
    if (!body) {
      logger.warn(
        `[twilio] service_complete template missing/disabled — skipping summary for customer ${customerId}`,
      );
      return;
    }

    return sendCustomerPolicySms({
      to: customer.phone,
      body,
      purpose: "service_completion",
      customerId,
      identityTrustLevel: "service_contact_authorized",
      messageType: "service_complete",
      metadata: { serviceRecordId },
    });
  },

  /**
   * Send monthly billing reminder
   */
  async sendBillingReminder(customerId, amount, date) {
    const customer = await db("customers").where({ id: customerId }).first();
    const prefs = await db("notification_prefs")
      .where({ customer_id: customerId })
      .first();
    if (!customer || !prefs?.billing_reminder || !prefs?.sms_enabled) return;

    const body =
      typeof smsTemplatesRouter.getTemplate === "function"
        ? await smsTemplatesRouter.getTemplate("billing_reminder", {
            first_name: customer.first_name || "",
            waveguard_tier: customer.waveguard_tier || "",
            amount: amount.toFixed(2),
            charge_date: date,
          }, { workflow: "billing_reminder", entity_type: "customer", entity_id: customerId })
        : null;
    if (!body) {
      logger.warn(
        `[twilio] billing_reminder template missing/disabled — skipping for customer ${customerId}`,
      );
      return;
    }

    return sendCustomerPolicySms({
      to: customer.phone,
      body,
      purpose: "billing",
      customerId,
      messageType: "billing_reminder",
    });
  },

  /**
   * Send seasonal tip / pest alert
   */
  async sendSeasonalAlert(customerId, subject, tip) {
    const customer = await db("customers").where({ id: customerId }).first();
    const prefs = await db("notification_prefs")
      .where({ customer_id: customerId })
      .first();
    if (!customer || !prefs?.seasonal_tips || !prefs?.sms_enabled) return;

    const body =
      typeof smsTemplatesRouter.getTemplate === "function"
        ? await smsTemplatesRouter.getTemplate("seasonal_alert", {
            first_name: customer.first_name || "",
            tip,
          }, { workflow: "seasonal_alert", entity_type: "customer", entity_id: customerId })
        : null;
    if (!body) {
      logger.warn(
        `[twilio] seasonal_alert template missing/disabled — skipping for customer ${customerId}`,
      );
      return;
    }

    return sendCustomerPolicySms({
      to: customer.phone,
      body,
      purpose: "marketing",
      customerId,
      consentBasis: {
        status: "opted_in",
        source: "notification_prefs.seasonal_tips",
        capturedAt: prefs.updated_at || prefs.created_at || undefined,
      },
      messageType: "seasonal_alert",
    });
  },
};

// Helper
function formatTime(timeStr) {
  if (!timeStr) return "";
  const [h, m] = timeStr.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}

module.exports = TwilioService;
