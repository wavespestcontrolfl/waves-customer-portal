const crypto = require("crypto");
const db = require("../models/db");
const logger = require("./logger");
const {
  etParts,
  parseETDateTime,
  addETDays,
  etDateString,
} = require("../utils/datetime-et");
const { shortenOrPassthrough } = require("./short-url");
const { sendCustomerMessage } = require("./messaging/send-customer-message");
const { renderSmsTemplate } = require("./sms-template-renderer");
const { firstNameFrom } = require("./customer-contact");
const { publicPortalUrl } = require("../utils/portal-url");
const OUTREACH = require("./review-outreach-templates");
const ASK_TOUCH_SQL = OUTREACH.ASK_TOUCH_SQL;
const { toE164 } = require("../utils/phone");
const { runExclusive } = require("../utils/cron-lock");

// GBP review links per location
const REVIEW_LINKS = {
  "bradenton": "https://g.page/r/CVRc_P5butTMEBM/review",
  sarasota: "https://g.page/r/CRkzS6M4EpncEBM/review",
  venice: "https://g.page/r/CURA5pQ1KatBEBM/review",
  parrish: "https://g.page/r/Ca-4KKoWwFacEBM/review",
};

// City → location for review routing. Shares the canonical office map
// (config/locations.js) so cities added there — including ZIP-recovered ones
// (utils/zip-to-city.js) — route reviews to the right GBP automatically rather
// than silently defaulting to Bradenton. The overrides are deliberate
// review-only exceptions where reviews go to a different GBP than the lead
// office (Palmetto/Longboat Key → Bradenton GBP) plus finer-grained
// neighborhood keys not needed for lead routing.
const { CITY_TO_LOCATION: CANONICAL_CITY_TO_LOCATION } = require("../config/locations");
const CITY_TO_LOCATION = {
  ...CANONICAL_CITY_TO_LOCATION,
  palmetto: "bradenton",
  "longboat key": "bradenton",
  "braden river": "bradenton",
  "bee ridge": "sarasota",
  "gulf gate": "sarasota",
};

function resolveLocation(customer) {
  const city = (customer.city || "").toLowerCase().trim();
  return CITY_TO_LOCATION[city] || "bradenton";
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
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
    const naive = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    return parseETDateTime(naive);
  }

  function nextDayAtHour(date, targetHour) {
    return atHour(addETDays(date, 1), targetHour);
  }

  function normalizeReviewSendWindow(sendAt) {
    const p = etParts(sendAt);
    if (p.hour < 9) return atHour(sendAt, 10);
    if (p.hour >= 17) return nextDayAtHour(sendAt, 10);
    return sendAt;
  }

  function addMins(date, mins) {
    return new Date(date.getTime() + (mins + jitter()) * 60000);
  }

  const LATE_AFTERNOON = 16.5; // 4:30 PM — last review-request window
  const MORNING = 10; // 10:00 AM

  const svc = (serviceType || "").toLowerCase();

  // ── Service-type overrides ──────────────────────────────────

  // Mosquito / WaveGuard: delay until evening when they're outside enjoying the yard
  if (svc.includes("mosquito") || svc.includes("waveguard")) {
    if (hour < 15) return atHour(completedAt, LATE_AFTERNOON);
    return nextDayAtHour(completedAt, MORNING);
  }

  // Lawn care / tree & shrub: let them see the results first
  if (
    svc.includes("lawn") ||
    svc.includes("turf") ||
    svc.includes("tree") ||
    svc.includes("shrub") ||
    svc.includes("dethatch")
  ) {
    if (hour < 15) return atHour(completedAt, LATE_AFTERNOON); // same afternoon
    return nextDayAtHour(completedAt, MORNING); // next morning
  }

  // WDO / first-time inspections: high anxiety → high relief, capture it fast
  if (svc.includes("wdo")) {
    const send = addMins(completedAt, 90);
    return normalizeReviewSendWindow(send);
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

  if (hour >= 7 && hour < 12) return normalizeReviewSendWindow(addMins(completedAt, 120)); // morning: 2-hour delay
  if (hour >= 12 && hour < 15) return normalizeReviewSendWindow(addMins(completedAt, 90)); // early afternoon: 90 min
  if (hour >= 15 && hour < 17) return nextDayAtHour(completedAt, MORNING); // late afternoon: next morning
  // After 5 PM or before 7 AM — next morning 10 AM
  return nextDayAtHour(completedAt, MORNING);
}

async function retryReviewRequestAfterTemplateMiss(requestId) {
  const retryAt = new Date(Date.now() + 5 * 60 * 1000);
  await db("review_requests").where({ id: requestId }).update({
    status: "pending",
    scheduled_for: retryAt,
  });
  return retryAt;
}

function retryAtForDeferredSend(result) {
  if (
    !result ||
    !(result.retryable || result.deferred || result.code === "QUIET_HOURS_HOLD")
  ) {
    return null;
  }
  const nextAllowedAt = result.nextAllowedAt
    ? new Date(result.nextAllowedAt)
    : null;
  if (nextAllowedAt && !Number.isNaN(nextAllowedAt.getTime())) {
    return nextAllowedAt;
  }
  return new Date(Date.now() + 5 * 60 * 1000);
}

// ══════════════════════════════════════════════════════════════
const ReviewService = {
  /**
   * Create a review request — called after payment or by tech.
   * @param {string} triggeredBy - 'auto' (post-payment), 'tech' (in-person), 'admin'
   * @param {number} delayMinutes - 0 for immediate (tech trigger), or 90-180 for auto
   */
  async create({
    customerId,
    serviceRecordId,
    triggeredBy = "auto",
    delayMinutes,
    locationId,
    techName: overrideTechName,
    serviceType: overrideServiceType,
    serviceDate: overrideServiceDate,
    technicianId: overrideTechnicianId,
    expiresAt,
  }) {
    const customer = await db("customers").where({ id: customerId }).first();
    if (!customer) throw new Error("Customer not found");
    // Event-driven callers (paid-invoice webhook, completion flows,
    // intelligence bar) reach here directly — don't even create the row
    // for an archived customer (sendSMS would suppress it later, but a
    // restore would then revive a stale ask).
    if (customer.deleted_at) {
      throw new Error("Customer is archived — review outreach not created");
    }

    // Don't create duplicate for same service
    if (serviceRecordId) {
      const existing = await db("review_requests")
        .where({ service_record_id: serviceRecordId })
        .first();
      if (existing) {
        const manualTrigger = triggeredBy !== "auto";
        const pending = String(existing.status || "").toLowerCase() === "pending";
        if (manualTrigger && pending && !existing.sms_sent_at) {
          await this.sendSMS(existing.id);
          return (
            (await db("review_requests").where({ id: existing.id }).first()) ||
            existing
          );
        }
        return existing;
      }
    }

    // Pull service + tech context
    let techName = overrideTechName || null,
      serviceType = overrideServiceType || null,
      serviceDate = overrideServiceDate || null,
      technicianId = overrideTechnicianId || null;
    if (serviceRecordId) {
      const sr = await db("service_records")
        .where({ "service_records.id": serviceRecordId })
        .leftJoin(
          "technicians",
          "service_records.technician_id",
          "technicians.id",
        )
        .select("service_records.*", "technicians.name as tech_name")
        .first();
      if (sr) {
        techName = techName || sr.tech_name;
        serviceType = serviceType || sr.service_type;
        serviceDate = serviceDate || sr.service_date;
        technicianId = technicianId || sr.technician_id;

        // Tech fallback: when service_records.technician_id wasn't set
        // (legacy rows or services completed before a tech was tagged
        // on the record), fall back to the assigned tech on the linked
        // scheduled_services row. service_records.scheduled_service_id
        // was added in migration 20260427000007. Without this fallback
        // the rate page and post-service SMS body lose the tech name
        // and avatar (Brooke b5nhw was a live example).
        if (!technicianId && sr.scheduled_service_id) {
          const ss = await db("scheduled_services")
            .where({ "scheduled_services.id": sr.scheduled_service_id })
            .leftJoin(
              "technicians",
              "scheduled_services.technician_id",
              "technicians.id",
            )
            .select(
              "scheduled_services.technician_id",
              "technicians.name as tech_name",
            )
            .first();
          if (ss?.technician_id) {
            technicianId = ss.technician_id;
            techName = techName || ss.tech_name || null;
          }
        }
      }
    }

    // Smart timing: pick the moment the customer is most likely to leave a review
    let scheduledFor = null;
    if (triggeredBy === "auto") {
      if (delayMinutes !== undefined && delayMinutes !== null) {
        scheduledFor = new Date(Date.now() + delayMinutes * 60000);
      } else {
        scheduledFor = calculateReviewSendTime(new Date(), serviceType);
      }
    } else if (delayMinutes !== undefined && delayMinutes !== null && Number(delayMinutes) > 0) {
      scheduledFor = new Date(Date.now() + Number(delayMinutes) * 60000);
    }
    // Non-auto manual triggers send immediately unless the caller explicitly
    // supplied a future delay. Auto rows are always picked up by the scheduler.
    const shouldSendImmediately = triggeredBy !== "auto" && !scheduledFor;

    const token = generateToken();
    const [request] = await db("review_requests")
      .insert({
        token,
        customer_id: customerId,
        service_record_id: serviceRecordId,
        location_id: locationId || resolveLocation(customer),
        technician_id: technicianId,
        tech_name: techName,
        service_type: serviceType,
        service_date: serviceDate,
        triggered_by: triggeredBy,
        scheduled_for: scheduledFor,
        status: "pending",
        expires_at: expiresAt || null,
      })
      .returning("*");

    // PII: ID-only logging per AGENTS.md. Customer name lives in the
    // customers row; the log line just needs IDs for cross-reference.
    logger.info(
      `[review] Created request (customerId=${customer.id} requestId=${request.id} trigger=${triggeredBy} scheduled=${scheduledFor || "immediate"})`,
    );

    if (shouldSendImmediately) {
      await this.sendSMS(request.id);
    }

    return request;
  },

  /**
   * Send the review request SMS.
   */
  async sendSMS(requestId) {
    const request = await db("review_requests")
      .where({ id: requestId })
      .first();
    if (!request || request.sms_sent_at) return;
    // Don't send a row that was taken out of the pending queue after this id was
    // batched by processScheduled — e.g. a cadence start that superseded this
    // queued ask (sets status='suppressed'), or a failed/deferred row. Re-reading
    // status here closes the race so the customer doesn't get the old ask AND the
    // cadence's Day-0 touch.
    if (["suppressed", "failed", "deferred"].includes(request.status)) return;

    const customer = await db("customers")
      .where({ id: request.customer_id })
      .first();
    // Soft-deleted customers get no outbound asks.
    if (customer && customer.deleted_at) {
      await db("review_requests").where({ id: requestId }).update({
        status: "suppressed",
      });
      // PII: ID-only per AGENTS.md.
      logger.info(
        `[review] Suppressed request (customerId=${customer.id} requestId=${requestId} reason=customer-deleted)`,
      );
      return;
    }
    // Skip customers a CSR has flagged as already-reviewed (Customer 360 toggle).
    if (customer && customer.has_left_google_review) {
      await db("review_requests").where({ id: requestId }).update({
        status: "suppressed",
      });
      // PII: ID-only per AGENTS.md.
      logger.info(
        `[review] Suppressed request (customerId=${customer.id} requestId=${requestId} reason=already-reviewed-flag)`,
      );
      return;
    }
    // Route to the service beneficiary (see services/customer-contact.js) —
    // falls back to the billing phone when no service contact is configured.
    const { getServiceContact } = require("./customer-contact");
    const contact = getServiceContact(customer);
    if (!contact.phone) return;

    const domain = publicPortalUrl();
    const longReviewUrl = `${domain}/rate/${request.token}`;
    const reviewUrl = await shortenOrPassthrough(longReviewUrl, {
      kind: "review",
      entityType: "review_requests",
      entityId: request.id,
      customerId: customer.id,
    });
    const techName = request.tech_name || "Our team";

    // Body source priority so a deferred/retried send keeps the operator's
    // approved copy instead of reverting:
    //   1. custom_body — the operator's edited message (persisted on the row).
    //   2. template_key — the chosen outreach template (manual or cadence touch).
    //   3. canonical sms_templates.review_request.
    // If none resolves, requeue.
    let body = null;
    const outreachTpl = request.template_key
      ? OUTREACH.getOutreachTemplate(request.template_key)
      : null;
    if (request.custom_body) {
      // Whether to guarantee the /rate link is based on the STORED template, not
      // "custom body ⇒ ask" — otherwise an edited no-link check-in (e.g.
      // resolution_check / satisfaction_confirm) would retry as a review ask
      // with a Google link appended. A pure custom body with no known template
      // is treated as an ask. For a no-link template, review_url is forced empty
      // so any {review_url} the operator left in the edited copy renders to
      // nothing (the cap was skipped for this template).
      const customIsNoLink = !!(outreachTpl && !outreachTpl.body.includes("{review_url}"));
      const customRequiresLink = !customIsNoLink && (outreachTpl ? outreachTpl.body.includes("{review_url}") : true);
      body = OUTREACH.renderOutreachBody(
        request.custom_body,
        {
          first: firstNameFrom(contact.name) || customer.first_name || "",
          tech: techName,
          service_type: request.service_type || "service",
          review_url: customIsNoLink ? "" : reviewUrl,
        },
        { requireLink: customRequiresLink },
      );
    } else if (outreachTpl) {
      body = OUTREACH.renderOutreachBody(
        outreachTpl.body,
        {
          first: firstNameFrom(contact.name) || customer.first_name || "",
          tech: techName,
          service_type: request.service_type || "service",
          review_url: reviewUrl,
        },
        { requireLink: outreachTpl.body.includes("{review_url}") },
      );
    } else {
      try {
        const tpl = require("../routes/admin-sms-templates");
        body = await tpl.getTemplate("review_request", {
          first_name: firstNameFrom(contact.name) || customer.first_name || "",
          review_url: reviewUrl,
          tech_name: techName,
        });
      } catch {
        /* template lookup failed → null */
      }
    }
    if (!body) {
      const retryAt = await retryReviewRequestAfterTemplateMiss(requestId);
      logger.info(
        `[review] review_request template missing/disabled — requestId=${requestId} requeued for ${retryAt.toISOString()}`,
      );
      return;
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
    // emoji / customer voice policy.
    try {
      const {
        sendCustomerMessage,
      } = require("./messaging/send-customer-message");
      const result = await sendCustomerMessage({
        to: contact.phone,
        body,
        channel: "sms",
        audience: "customer",
        purpose: "review_request",
        customerId: customer.id,
        entryPoint: "review_request_send",
      });

      if (result.sent) {
        await db("review_requests").where({ id: requestId }).update({
          sms_sent_at: new Date(),
          status: "sent",
        });
        // PII: ID-only per AGENTS.md.
        logger.info(
          `[review] SMS sent (customerId=${customer.id} requestId=${requestId} auditLogId=${result.auditLogId || "n/a"})`,
        );
      } else {
        const deferredRetryAt = retryAtForDeferredSend(result);
        if (deferredRetryAt) {
          await db("review_requests").where({ id: requestId }).update({
            status: "pending",
            scheduled_for: deferredRetryAt,
          });
          logger.info(
            `[review] SMS DEFERRED (customerId=${customer.id} requestId=${requestId} auditLogId=${result.auditLogId || "n/a"} code=${result.code}) (queued for retry at ${deferredRetryAt.toISOString()})`,
          );
        } else if (result.blocked && result.code === "CONSENT_LOOKUP_FAILED") {
          // Transient lookup failure inside the wrapper (DB error during
          // consent validation). Distinct code from NO_CONSENT_RECORD;
          // treat like a provider failure — re-queue for the cron rather
          // than permanently suppress. Codex P1 round-2 on PR #545:
          // NO_CONSENT_RECORD and CONSENT_LOOKUP_FAILED used to share the
          // same code, which silently dropped legitimate review requests
          // during DB blips.
          const retryAt = new Date(Date.now() + 5 * 60 * 1000);
          await db("review_requests").where({ id: requestId }).update({
            scheduled_for: retryAt,
          });
          // PII: ID + code only. result.reason can include recipient phone
          // or message body when upstream provider/guard error strings
          // propagate; full failure context lives on messaging_audit_log
          // keyed on auditLogId.
          logger.error(
            `[review] SMS WRAPPER LOOKUP FAILED (customerId=${customer.id} requestId=${requestId} auditLogId=${result.auditLogId || "n/a"} code=${result.code}) (queued for retry at ${retryAt.toISOString()})`,
          );
        } else if (result.blocked) {
          // True wrapper-policy block (opt-out, suppression, emoji, price
          // leak, segment cap, identity, NO_CONSENT_RECORD). Mark
          // suppressed so processScheduled() — which only picks rows with
          // status='pending' — stops retrying. The request row stays for
          // audit history; the audit_log row captures the block reason.
          await db("review_requests").where({ id: requestId }).update({
            status: "suppressed",
          });
          // PII: ID + code only — see WRAPPER LOOKUP FAILED above for why
          // result.reason is dropped from log lines.
          logger.warn(
            `[review] SMS BLOCKED (customerId=${customer.id} requestId=${requestId} auditLogId=${result.auditLogId || "n/a"} code=${result.code})`,
          );
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
          await db("review_requests").where({ id: requestId }).update({
            scheduled_for: retryAt,
          });
          // PII: ID + code only — see WRAPPER LOOKUP FAILED above for why
          // result.reason is dropped from log lines.
          logger.error(
            `[review] SMS PROVIDER FAILURE (customerId=${customer.id} requestId=${requestId} auditLogId=${result.auditLogId || "n/a"} code=${result.code}) (queued for retry at ${retryAt.toISOString()})`,
          );
        }
      }
    } catch (err) {
      // Same retry contract on a thrown exception (network down etc.):
      // re-queue for the cron rather than leave the row stranded.
      try {
        const retryAt = new Date(Date.now() + 5 * 60 * 1000);
        await db("review_requests").where({ id: requestId }).update({
          scheduled_for: retryAt,
        });
        // PII: log error class only. err.message can include Twilio
        // request bodies / phone numbers since the wrapper internally
        // calls services that surface the raw destination in their
        // error strings. Audit row (when reached) holds full context.
        logger.error(
          `[review] SMS dispatch threw — queued for retry at ${retryAt.toISOString()} (requestId=${requestId} errType=${err?.name || "Error"})`,
        );
      } catch (dbErr) {
        // Last resort — couldn't even update the row. Log error classes
        // only for both failures (same PII reasoning).
        logger.error(
          `[review] SMS failed AND retry-queue update failed (requestId=${requestId} sendErrType=${err?.name || "Error"} dbErrType=${dbErr?.name || "Error"})`,
        );
      }
    }
  },

  /**
   * Create a review-request row and return the (shortened) review URL
   * without sending its own SMS. Used when the completion flow wants to
   * bundle the review link into the service-complete SMS so the customer
   * gets a single message instead of two.
   *
   * Leaves sms_sent_at empty until the outer completion-SMS caller confirms
   * delivery. Failed/blocked completion SMS attempts suppress the inline row
   * so it does not look delivered or become eligible for a follow-up.
   *
   * @returns {{ url: string, requestId: string, token: string }|null}
   * shortened review URL metadata, or null when the caller should skip the suffix.
   */
  async createInline({ customerId, serviceRecordId }) {
    const customer = await db("customers").where({ id: customerId }).first();
    if (!customer) return null;
    // CSR flagged this customer as already-reviewed — caller treats null
    // as "skip the review suffix" so the completion SMS goes out clean.
    if (customer.has_left_google_review) return null;

    try {
      const prefs = await db("notification_prefs")
        .where({ customer_id: customerId })
        .first();
      if (prefs && (prefs.sms_enabled === false || prefs.review_request === false)) {
        return null;
      }
    } catch (err) {
      logger.warn(
        `[review] Inline request skipped; prefs lookup failed (customerId=${customerId} errType=${err?.name || "Error"})`,
      );
      return null;
    }

    // Reuse an existing request for this service so we don't stack tokens.
    if (serviceRecordId) {
      const existing = await db("review_requests")
        .where({ service_record_id: serviceRecordId })
        .first();
      if (existing) {
        if (
          existing.sms_sent_at ||
          String(existing.status || "").toLowerCase() !== "pending"
        ) {
          return null;
        }
        const domain = publicPortalUrl();
        const longUrl = `${domain}/rate/${existing.token}`;
        const url = await shortenOrPassthrough(longUrl, {
          kind: "review",
          entityType: "review_requests",
          entityId: existing.id,
          customerId,
        });
        return { url, requestId: existing.id, token: existing.token };
      }
    }

    let techName = null,
      serviceType = null,
      serviceDate = null,
      technicianId = null;
    if (serviceRecordId) {
      const sr = await db("service_records")
        .where({ "service_records.id": serviceRecordId })
        .leftJoin(
          "technicians",
          "service_records.technician_id",
          "technicians.id",
        )
        .select("service_records.*", "technicians.name as tech_name")
        .first();
      if (sr) {
        techName = sr.tech_name;
        serviceType = sr.service_type;
        serviceDate = sr.service_date;
        technicianId = sr.technician_id;

        // Same scheduled_services fallback used in create() — keep both
        // paths in lockstep so the auto_inline trigger doesn't end up
        // with a null technician_id when create() would have resolved
        // one.
        if (!technicianId && sr.scheduled_service_id) {
          const ss = await db("scheduled_services")
            .where({ "scheduled_services.id": sr.scheduled_service_id })
            .leftJoin(
              "technicians",
              "scheduled_services.technician_id",
              "technicians.id",
            )
            .select(
              "scheduled_services.technician_id",
              "technicians.name as tech_name",
            )
            .first();
          if (ss?.technician_id) {
            technicianId = ss.technician_id;
            techName = techName || ss.tech_name || null;
          }
        }
      }
    }

    const token = generateToken();
    const [request] = await db("review_requests")
      .insert({
        token,
        customer_id: customerId,
        service_record_id: serviceRecordId,
        technician_id: technicianId,
        tech_name: techName,
        service_type: serviceType,
        service_date: serviceDate,
        triggered_by: "auto_inline",
        scheduled_for: new Date(Date.now() + 120 * 60000),
        sms_sent_at: null,
        status: "pending",
      })
      .returning("*");

    // PII: ID-only per AGENTS.md.
    logger.info(
      `[review] Created inline request (customerId=${customer.id} requestId=${request.id} bundled-with=completion_sms)`,
    );

    const domain = publicPortalUrl();
    const longUrl = `${domain}/rate/${request.token}`;
    const url = await shortenOrPassthrough(longUrl, {
      kind: "review",
      entityType: "review_requests",
      entityId: request.id,
      customerId,
    });
    return { url, requestId: request.id, token: request.token };
  },

  async markInlineDelivered(requestId) {
    if (!requestId) return;
    await db("review_requests")
      .where({ id: requestId })
      .whereNull("sms_sent_at")
      .where("status", "pending")
      .update({
        sms_sent_at: new Date(),
        scheduled_for: null,
        status: "sent",
      });
  },

  async markInlineDeliveryFailed(requestId) {
    if (!requestId) return;
    await db("review_requests").where({ id: requestId }).update({
      status: "suppressed",
    });
  },

  async markInlineRetryable(requestId, scheduledFor) {
    if (!requestId) return;
    await db("review_requests").where({ id: requestId }).update({
      status: "pending",
      scheduled_for: scheduledFor || new Date(Date.now() + 120 * 60000),
    });
  },

  /**
   * Get review page data by public token.
   */
  async getByToken(token) {
    const request = await db("review_requests").where({ token }).first();
    if (!request) return null;

    // Record view
    const updates = { open_count: (request.open_count || 0) + 1 };
    if (!request.opened_at) {
      updates.opened_at = new Date();
      updates.status = request.status === "sent" ? "opened" : request.status;
    }
    await db("review_requests").where({ id: request.id }).update(updates);

    const customer = await db("customers")
      .where({ id: request.customer_id })
      .select("first_name", "last_name", "city", "zip")
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
    const { resolveTechPhotoUrl } = require("./tech-photo");
    let techPhoto = null;
    if (request.technician_id) {
      const tech = await db("technicians")
        .where({ id: request.technician_id })
        .select("photo_url", "photo_s3_key")
        .first();
      techPhoto = await resolveTechPhotoUrl(
        tech?.photo_s3_key,
        tech?.photo_url,
      );
    }

    // Social proof: count of ratings for this tech
    let techReviewCount = 0;
    if (request.technician_id) {
      const [{ count }] = await db("review_requests")
        .where({ technician_id: request.technician_id })
        .whereNotNull("rating")
        .count("* as count");
      techReviewCount = parseInt(count);
    }
    // Also add Google reviews count
    try {
      const [{ count: googleCount }] = await db("google_reviews")
        .where("reviewer_name", "!=", "_stats")
        .count("* as count");
      techReviewCount += parseInt(googleCount);
    } catch {
      /* table might not exist */
    }

    // Resolve which Google review link to use
    const location = resolveLocation(customer || {});
    const googleReviewUrl =
      REVIEW_LINKS[location] || REVIEW_LINKS["bradenton"];

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
    const request = await db("review_requests").where({ token }).first();
    if (!request) throw new Error("Review request not found");
    if (request.rated_at) throw new Error("Already rated");

    const customer = await db("customers")
      .where({ id: request.customer_id })
      .first();
    const location = resolveLocation(customer || {});
    const isPromoter = rating >= 7; // 7+ goes to Google (per the case study discussion)
    const isDetractor = rating <= 4;

    const updates = {
      rating,
      rated_at: new Date(),
      feedback_text: feedbackText || null,
      status: "rated",
      google_location: location,
    };

    if (isPromoter) {
      updates.redirected_to_google = true;
      updates.redirected_at = new Date();
      updates.status = "reviewed"; // optimistic — they got the redirect
    }

    await db("review_requests").where({ id: request.id }).update(updates);

    // Also record in satisfaction_responses for backward compat
    try {
      const existing = await db("satisfaction_responses")
        .where({
          customer_id: request.customer_id,
          service_record_id: request.service_record_id,
        })
        .first();
      if (!existing && request.service_record_id) {
        await db("satisfaction_responses").insert({
          customer_id: request.customer_id,
          service_record_id: request.service_record_id,
          rating,
          feedback_text: feedbackText || null,
          directed_to_review: isPromoter,
          flagged_for_followup: !isPromoter,
          office_location: location.replace("-", "_"),
        });
      }
    } catch {
      /* satisfaction_responses may not exist */
    }

    // Alert on low scores
    if (!isPromoter) {
      const urgency = isDetractor ? "🚨 URGENT" : "⚠️";
      try {
        const TwilioService = require("./twilio");
        const alertPhone = process.env.OWNER_PHONE || "+19415993489";
        await TwilioService.sendSMS(
          alertPhone,
          `${urgency} Review Alert\n\n` +
            `${customer.first_name} ${customer.last_name} rated ${rating}/10\n` +
            `Service: ${request.service_type} (${request.service_date})\n` +
            `Tech: ${request.tech_name}\n` +
            (feedbackText ? `Feedback: "${feedbackText}"\n` : "") +
            `Phone: ${customer.phone}\n\n` +
            (isDetractor ? "Follow up ASAP." : "Follow up within 24 hours."),
          { messageType: "internal_alert" },
        );
      } catch (err) {
        logger.error(`[review] Alert SMS failed: ${err.message}`);
      }
    }

    const googleReviewUrl = isPromoter
      ? REVIEW_LINKS[location] || REVIEW_LINKS["bradenton"]
      : null;
    return {
      rating,
      action: isPromoter ? "review" : "feedback",
      googleReviewUrl,
    };
  },

  /**
   * Cron: send scheduled review requests.
   * Runs every 15 minutes, picks up requests whose scheduled_for has passed.
   */
  async processScheduled() {
    // Terminate (not just skip) due requests whose customer was
    // soft-deleted: a row left 'pending' forever would become eligible
    // again — and fire very late — if the customer is ever restored.
    const terminated = await db("review_requests")
      .where({ status: "pending" })
      .whereNotNull("scheduled_for")
      .where("scheduled_for", "<=", new Date())
      .whereNull("sms_sent_at")
      .whereExists(function () {
        this.select(1)
          .from("customers")
          .whereRaw("customers.id = review_requests.customer_id")
          .whereNotNull("customers.deleted_at");
      })
      .update({ status: "suppressed" });
    if (terminated > 0) {
      logger.info(`[review] Suppressed ${terminated} scheduled requests (reason=customer-deleted)`);
    }

    const pending = await db("review_requests")
      .where({ status: "pending" })
      .whereNotNull("scheduled_for")
      .where("scheduled_for", "<=", new Date())
      .whereNull("sms_sent_at")
      // Never SMS-send an email-channel cadence touch. Email touches are
      // re-driven by processReviewSequences via review_sequences.next_run_at,
      // not this SMS scheduler.
      .where(function () {
        this.where("channel", "sms").orWhereNull("channel");
      })
      .whereNotExists(function () {
        this.select(1)
          .from("customers")
          .whereRaw("customers.id = review_requests.customer_id")
          .whereNotNull("customers.deleted_at");
      })
      .limit(20);

    let sent = 0;
    for (const request of pending) {
      // Serialize each send under the SAME per-customer lock the manual send and
      // cadence-start paths take. Without this, a cadence start can suppress this
      // queued row + fire its Day-0 touch in the window between this row being
      // batched and sendSMS reading its status — delivering BOTH. The lock is
      // non-blocking: if a manual/cadence send for this customer holds it, we
      // skip the row this tick (it's picked up next tick, or was superseded).
      await runExclusive(`review-send:${request.customer_id}`, () => this.sendSMS(request.id));
      sent++;
    }
    if (sent > 0)
      logger.info(`[review] Processed ${sent} scheduled review requests`);
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
    const cutoff = parseETDateTime(
      `${etDateString(addETDays(new Date(), -1))}T00:00`,
    );
    const recentFollowupCutoff = new Date(Date.now() - 14 * 24 * 3600000); // 14 days

    // Terminally mark due follow-ups for soft-deleted customers as
    // handled (mirrors processScheduled): filtering alone leaves
    // followup_sent=false rows eligible forever, so a restored customer
    // would get a stale follow-up.
    const followupsClosed = await db("review_requests")
      .whereIn("status", ["sent", "opened"])
      .where("sms_sent_at", "<", cutoff)
      .where({ followup_sent: false })
      .whereExists(function () {
        this.select(1)
          .from("customers")
          .whereRaw("customers.id = review_requests.customer_id")
          .whereNotNull("customers.deleted_at");
      })
      .update({ followup_sent: true, followup_sent_at: new Date() });
    if (followupsClosed > 0) {
      logger.info(`[review] Closed ${followupsClosed} due follow-ups (reason=customer-deleted)`);
    }

    const nonPromoterDrafts = await db("review_requests")
      .whereIn("status", ["sent", "opened"])
      .where("sms_sent_at", "<", cutoff)
      .where({ followup_sent: false })
      .whereNull("rated_at")
      .where("score", "<", 8)
      .whereNotExists(function () {
        this.select(1)
          .from("customers")
          .whereRaw("customers.id = review_requests.customer_id")
          .whereNotNull("customers.deleted_at");
      })
      .orderBy("sms_sent_at", "asc")
      .limit(20);

    let internalFollowups = 0;
    for (const request of nonPromoterDrafts) {
      const customer = await db("customers")
        .where({ id: request.customer_id })
        .first();
      const customerName = customer
        ? `${customer.first_name || ""} ${customer.last_name || ""}`.trim()
        : "Unknown customer";
      const serviceLabel = request.service_type || "service";

      try {
        const TwilioService = require("./twilio");
        const alertPhone = process.env.OWNER_PHONE || "+19415993489";
        const result = await TwilioService.sendSMS(
          alertPhone,
          `Review follow-up needed: ${customerName} tapped ${request.score}/10 for ${serviceLabel} but did not submit feedback. Reach out before asking for a Google review.`,
          { messageType: "internal_alert" },
        );
        if (!result?.success)
          throw new Error(result?.error || "SMS send failed");

        await db("activity_log")
          .insert({
            customer_id: request.customer_id,
            action: "review_draft_needs_followup",
            description: `Draft NPS ${request.score}/10 needs follow-up — ${serviceLabel}`,
            metadata: JSON.stringify({
              reviewRequestId: request.id,
              score: request.score,
              category: request.category,
              serviceType: request.service_type,
            }),
          })
          .catch((err) =>
            logger.warn(
              `[review] Draft follow-up activity skipped: ${err.message}`,
            ),
          );

        await db("review_requests").where({ id: request.id }).update({
          followup_sent: true,
          followup_sent_at: new Date(),
        });
        internalFollowups++;
      } catch (err) {
        logger.error(
          `[review] Draft low-score follow-up failed: ${err.message}`,
        );
      }
    }

    const eligible = await db("review_requests")
      .whereIn("status", ["sent", "opened"])
      .where("sms_sent_at", "<", cutoff)
      .where({ followup_sent: false })
      .whereNull("rated_at")
      // Draft score taps are durable but not final. Do not send the
      // straight-to-Google reminder when the draft score already tells us the
      // customer was not a promoter.
      .where((builder) => builder.whereNull("score").orWhere("score", ">=", 8))
      .whereNotExists(function () {
        this.select(1)
          .from("customers")
          .whereRaw("customers.id = review_requests.customer_id")
          .whereNotNull("customers.deleted_at");
      })
      .orderBy("sms_sent_at", "asc")
      .limit(20);

    let sent = 0;
    let suppressed = 0;
    const sentThisRun = new Set();
    const { getServiceContact } = require("./customer-contact");
    for (const request of eligible) {
      // Dedup #1: another row in this same batch already triggered a followup
      if (sentThisRun.has(request.customer_id)) {
        await db("review_requests").where({ id: request.id }).update({
          followup_sent: true,
          followup_sent_at: new Date(),
        });
        suppressed++;
        continue;
      }

      // Dedup #2: a sibling row already sent a followup to this customer recently
      const recentFollowup = await db("review_requests")
        .where({ customer_id: request.customer_id, followup_sent: true })
        .where("followup_sent_at", ">=", recentFollowupCutoff)
        .first();
      if (recentFollowup) {
        await db("review_requests").where({ id: request.id }).update({
          followup_sent: true,
          followup_sent_at: new Date(),
        });
        suppressed++;
        continue;
      }

      const customer = await db("customers")
        .where({ id: request.customer_id })
        .first();
      // Dedup #3: CSR flagged the customer as already-reviewed (Customer 360 toggle).
      if (customer && customer.has_left_google_review) {
        await db("review_requests").where({ id: request.id }).update({
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
      const googleReviewUrl =
        REVIEW_LINKS[location] || REVIEW_LINKS["bradenton"];

      const body = await renderSmsTemplate(
        "review_request_followup",
        {
          first_name: firstNameFrom(contact.name) || customer.first_name || "",
          google_review_url: googleReviewUrl,
        },
        {
          workflow: "review_request_followup",
          entity_type: "review_request",
          entity_id: request.id,
        },
      );
      if (!body) {
        logger.warn(
          `[review] review_request_followup template missing/disabled (customerId=${customer.id} requestId=${request.id})`,
        );
        continue;
      }

      try {
        const result = await sendCustomerMessage({
          to: contact.phone,
          body,
          channel: "sms",
          audience: "customer",
          purpose: "review_request",
          customerId: customer.id,
          identityTrustLevel: "phone_matches_customer",
          entryPoint: "review_request_followup",
          metadata: {
            original_message_type: "review_followup",
            review_request_id: request.id,
          },
        });
        if (!result.sent) {
          logger.warn(
            `[review] Follow-up SMS blocked/failed (customerId=${customer.id} requestId=${request.id} auditLogId=${result.auditLogId || "n/a"} code=${result.code || "UNKNOWN"})`,
          );
          if (
            result.blocked &&
            result.code !== "CONSENT_LOOKUP_FAILED" &&
            !result.retryable &&
            !result.deferred
          ) {
            await db("review_requests").where({ id: request.id }).update({
              followup_sent: true,
              followup_sent_at: new Date(),
            });
            suppressed++;
          }
          continue;
        }

        await db("review_requests").where({ id: request.id }).update({
          followup_sent: true,
          followup_sent_at: new Date(),
        });
        sentThisRun.add(request.customer_id);
        sent++;
      } catch (err) {
        logger.error(`[review] Follow-up SMS failed: ${err.message}`);
      }
    }
    if (sent > 0 || suppressed > 0 || internalFollowups > 0) {
      logger.info(
        `[review] Follow-ups: ${sent} sent, ${suppressed} suppressed (dedup), ${internalFollowups} internal`,
      );
    }
    return { sent, suppressed, internalFollowups };
  },

  // ════════════════════════════════════════════════════════════════
  // OUTREACH — manual sends + multi-touch cadence (Review Outreach tab)
  // ════════════════════════════════════════════════════════════════

  /**
   * Send a single review-ask "touch" on SMS or email, recording it in
   * review_requests with channel + template + sequence linkage so it flows
   * through the same NPS rate page, suppression, and analytics as every other
   * ask. Used by the manual Review Outreach send AND by each cadence step.
   *
   * The chosen template/body actually sends (audit O2): the {review_url}
   * placeholder always resolves to the tokenized /rate page, preserving the
   * happy→Google / issue→private gate on both channels.
   *
   * @returns {{ ok, sent?, deferred?, blocked?, terminal?, retryable?,
   *   reason?, code?, channel?, requestId?, nextAllowedAt? }}
   */
  async sendOutreachTouch({
    customer,
    channel = "sms",
    templateId = null,
    body: customBody = null,
    locationId,
    techName,
    serviceType,
    serviceDate,
    serviceRecordId = null,
    sequenceId = null,
    sequenceStep = null,
    triggeredBy = "admin",
    expiresAt,
    manageRetryVia = "cron",
  }) {
    if (!customer || !customer.id) return { ok: false, reason: "no_customer", terminal: true };
    if (customer.deleted_at) return { ok: false, reason: "deleted", terminal: true };
    if (customer.has_left_google_review) {
      return { ok: false, reason: "already_reviewed", terminal: true };
    }

    const { getServiceContact } = require("./customer-contact");
    const contact = getServiceContact(customer);

    // Load consent prefs once. Channel resolution is OPT-OUT-AWARE and honors
    // the per-type review_request_channel preference ('sms' | 'email' | 'both'):
    // a customer who opted out of SMS (or set review requests to email) but
    // allows email gets the email touch instead of stalling as "opted out".
    let prefs = null;
    let prefsLookupFailed = false;
    try {
      prefs = await db("notification_prefs").where({ customer_id: customer.id }).first();
    } catch {
      prefsLookupFailed = true;
    }
    // If we can't read the channel preferences, DON'T resolve a channel: the
    // downstream SMS wrapper doesn't enforce review_request_channel, so a
    // fallback to SMS could text an email-only customer. No row exists yet, so:
    //  • sequence → retryable: _runSequenceStep reschedules the step.
    //  • manual one-off → terminal: there's NO row for processScheduled to
    //    retry, so report a real failure rather than a false "queued" (the route
    //    maps retryable→202 queued, which would lie to the operator).
    if (prefsLookupFailed) {
      return manageRetryVia === "sequence"
        ? { ok: false, retryable: true, reason: "prefs_unavailable" }
        : { ok: false, terminal: true, reason: "prefs_unavailable" };
    }
    const reviewBlocked = !!prefs && prefs.review_request === false;
    const smsBlocked = reviewBlocked || (!!prefs && prefs.sms_enabled === false);
    const emailBlocked = reviewBlocked || (!!prefs && prefs.email_enabled === false);
    // Hard suppression (DNC / wrong-number) on the phone — if the SMS block is
    // suppression-only, the cadence should fall back to email rather than stall.
    // sendCustomerMessage would also block it, but checking here lets the channel
    // resolver pick email (matching the candidate list's sms_suppressed → email).
    let phoneSuppressed = false;
    if (contact.phone) {
      try {
        // messaging_suppression.phone is E.164 (written by the Twilio path), so
        // normalize before matching or a formatted "(941)…" number misses the
        // DNC row and the cadence stalls instead of falling back to email.
        const e164 = toE164(contact.phone) || contact.phone;
        const sup = await db("messaging_suppression").where({ phone: e164, active: true }).first();
        phoneSuppressed = !!sup;
      } catch {
        /* table may not exist → treat as not suppressed */
      }
    }
    // SMS consent is re-checked downstream in sendCustomerMessage (fails closed
    // there), so a prefs-read blip can still attempt SMS. Email has NO downstream
    // consent gate, so it fails CLOSED: it requires an existing prefs row with
    // review + email enabled (parity with SMS's NO_CONSENT_RECORD on a missing
    // row) and a clean prefs read.
    const canSms = !!contact.phone && !smsBlocked && !phoneSuppressed;
    const canEmail = !!contact.email && !!prefs && !emailBlocked && !prefsLookupFailed;

    // A no-link private check-in (resolution_check / satisfaction_confirm) must
    // NEVER route to email — the only email template is review_request_email,
    // which carries a /rate link, so an email fallback would turn a recovery
    // message into a review ask (and bypass the cap, since send-request didn't
    // count it). Keep these SMS-only, ignoring the email channel preference.
    const noLinkSend = !!(templateId && OUTREACH.NO_LINK_TEMPLATE_KEYS.includes(templateId));

    // Per-type channel preference. Only 'email' is treated as an EXCLUSIVE
    // choice (it is never the column default, so it's deliberate): an 'email'
    // preference must not fall back to SMS. 'sms' is the backfill DEFAULT, so it
    // is NOT a deliberate opt-out — it must keep the email fallback / Day-7 email
    // step working. 'both' / unset allow either with fallback.
    const prefChannel = prefs && prefs.review_request_channel;
    const allowSms = canSms && (noLinkSend || prefChannel !== "email");
    const allowEmail = canEmail && !noLinkSend;
    let intended = noLinkSend ? "sms" : channel === "email" ? "email" : "sms";
    if (!noLinkSend && prefChannel === "email") intended = "email";

    let actualChannel = intended;
    if (actualChannel === "sms" && !allowSms) actualChannel = allowEmail ? "email" : null;
    if (actualChannel === "email" && !allowEmail) actualChannel = allowSms ? "sms" : null;
    if (!actualChannel) {
      const optedOut = reviewBlocked || (intended === "email" ? emailBlocked : smsBlocked);
      return { ok: false, reason: optedOut ? "opted_out" : "no_contact", blocked: optedOut, terminal: true };
    }

    // Effective template + what we RECORD for analytics. A manual send with no
    // chosen template defaults to the standard friendly ask (audit P1). Email
    // touches always render the review_request_email DB template, so we record
    // THAT for honest per-template attribution. An edited SMS body is persisted
    // (custom_body) so a quiet-hours/provider retry re-sends the operator's copy
    // rather than reverting to the template.
    const smsTemplateId = templateId || (customBody && customBody.trim() ? null : "friendly_ask");
    const recordedTemplateKey = actualChannel === "email" ? "review_request_email" : smsTemplateId || "custom";
    const persistedBody = actualChannel === "sms" && customBody && customBody.trim() ? customBody : null;

    // A no-link template (resolution_check / satisfaction_confirm) is a PRIVATE
    // check-in, not a review ask — so it must NOT trigger the legacy Day-3
    // straight-to-Google follow-up (processFollowups), which would turn the
    // recovery message into a public review request.
    const smsTpl = actualChannel === "sms" && smsTemplateId ? OUTREACH.getOutreachTemplate(smsTemplateId) : null;
    const isNoLinkSms = !!smsTpl && !smsTpl.body.includes("{review_url}");

    const token = generateToken();
    const [request] = await db("review_requests")
      .insert({
        token,
        customer_id: customer.id,
        service_record_id: serviceRecordId,
        location_id: locationId || resolveLocation(customer),
        tech_name: techName || null,
        service_type: serviceType || null,
        service_date: serviceDate || null,
        triggered_by: triggeredBy,
        channel: actualChannel,
        template_key: recordedTemplateKey,
        custom_body: persistedBody,
        sequence_id: sequenceId,
        sequence_step: sequenceStep,
        status: "pending",
        // Sequence touches AND no-link check-ins skip the legacy Day-3 followup.
        followup_sent: sequenceId || isNoLinkSms ? true : false,
        expires_at: expiresAt || new Date(Date.now() + 14 * 86400000).toISOString(),
      })
      .returning("*");

    const domain = publicPortalUrl();
    const longUrl = `${domain}/rate/${token}`;
    const reviewUrl = await shortenOrPassthrough(longUrl, {
      kind: "review",
      entityType: "review_requests",
      entityId: request.id,
      customerId: customer.id,
    });

    const vars = {
      first: firstNameFrom(contact.name) || customer.first_name || "",
      tech: techName || "Adam",
      service_type: serviceType || "service",
      review_url: reviewUrl,
    };

    if (actualChannel === "email") {
      return this._sendOutreachEmail({ request, customer, contact, reviewUrl, techName, manageRetryVia });
    }
    return this._sendOutreachSms({ request, customer, contact, vars, templateId: smsTemplateId, customBody, manageRetryVia });
  },

  async _sendOutreachSms({ request, customer, contact, vars, templateId, customBody, manageRetryVia }) {
    const tpl = templateId ? OUTREACH.getOutreachTemplate(templateId) : null;
    const rawBody =
      typeof customBody === "string" && customBody.trim() ? customBody : tpl ? tpl.body : null;
    if (!rawBody) {
      await db("review_requests").where({ id: request.id }).update({ status: "failed" }).catch(() => {});
      return { ok: false, reason: "no_template", terminal: true, requestId: request.id };
    }
    // Whether a /rate link is required is determined by the SELECTED TEMPLATE,
    // not the (possibly edited) body — so an operator who edits {review_url} out
    // of an ask template still gets the link appended rather than sending an ask
    // with no way to act on it. A pure custom body with no template is treated
    // as an ask (require the link); the issue/check-in templates carry no link.
    const isNoLink = !!(tpl && !tpl.body.includes("{review_url}"));
    const requiresLink = !isNoLink && (tpl ? tpl.body.includes("{review_url}") : true);
    // For a no-link check-in, force review_url empty so ANY {review_url} the
    // operator left/added in the edited body renders to nothing — send-request
    // skipped cap/cooldown for this template, so it must never carry a review link.
    const renderVars = isNoLink ? { ...vars, review_url: "" } : vars;
    const body = OUTREACH.renderOutreachBody(rawBody, renderVars, { requireLink: requiresLink });

    // ONLY the send attempt is in the retry-on-throw path. If sendCustomerMessage
    // itself throws (network/provider), it's safe to retry — Twilio never
    // accepted it. If it RETURNS and then post-send bookkeeping throws (a
    // transient Postgres error after Twilio accepted), we must NOT retry, or the
    // customer gets the SMS twice (audit P1).
    let result;
    try {
      result = await sendCustomerMessage({
        to: contact.phone,
        body,
        channel: "sms",
        audience: "customer",
        purpose: "review_request",
        customerId: customer.id,
        entryPoint: "review_outreach_touch",
        metadata: request.sequence_id ? { review_sequence_id: request.sequence_id } : {},
      });
    } catch (err) {
      if (manageRetryVia === "cron") {
        await db("review_requests")
          .where({ id: request.id })
          .update({ status: "pending", scheduled_for: new Date(Date.now() + 5 * 60 * 1000) })
          .catch(() => {});
      } else {
        await db("review_requests").where({ id: request.id }).update({ status: "failed" }).catch(() => {});
      }
      logger.error(`[review] outreach SMS send threw (requestId=${request.id} errType=${err?.name || "Error"})`);
      return { ok: false, retryable: true, channel: "sms", requestId: request.id };
    }

    try {
      return await this._applyOutreachSendResult(request, result, manageRetryVia, "sms");
    } catch (bookErr) {
      // The send already happened — do NOT requeue. Report based on what the
      // provider did; the audit log holds the full record for reconciliation.
      logger.error(
        `[review] post-send bookkeeping failed (requestId=${request.id} sent=${!!result?.sent} errType=${bookErr?.name || "Error"})`,
      );
      // Only a SENT result must avoid retry (would double-send). A not-sent
      // result (quiet-hours hold / rate-limit / transient provider failure) has
      // NO duplicate-send risk, so keep it retryable — don't drop the manual
      // retry or stop the cadence over a bookkeeping blip.
      return result?.sent
        ? { ok: true, sent: true, channel: "sms", requestId: request.id, auditLogId: result.auditLogId }
        : { ok: false, retryable: true, channel: "sms", requestId: request.id, reason: "bookkeeping_failed" };
    }
  },

  async _applyOutreachSendResult(request, result, manageRetryVia, channel) {
    if (result && result.sent) {
      await db("review_requests").where({ id: request.id }).update({
        sms_sent_at: new Date(),
        sent_at: new Date(),
        status: "sent",
      });
      return { ok: true, sent: true, channel, requestId: request.id, auditLogId: result.auditLogId };
    }
    const deferredRetryAt = retryAtForDeferredSend(result);
    if (deferredRetryAt) {
      if (manageRetryVia === "cron") {
        await db("review_requests").where({ id: request.id }).update({
          status: "pending",
          scheduled_for: deferredRetryAt,
        });
      } else {
        // The sequence cron owns retries — keep this row out of processScheduled.
        await db("review_requests").where({ id: request.id }).update({ status: "deferred" });
      }
      return { ok: false, deferred: true, nextAllowedAt: deferredRetryAt, channel, requestId: request.id, code: result?.code };
    }
    // Terminal: a policy block (opt-out/suppression) OR a non-retryable provider
    // failure (invalid / non-SMS-capable number). Suppress so a manual send
    // isn't rescheduled every 5 min and a cadence stops on an unfixable contact,
    // rather than retrying forever. CONSENT_LOOKUP_FAILED is a transient DB blip,
    // not terminal.
    const terminalBlock =
      result &&
      result.code !== "CONSENT_LOOKUP_FAILED" &&
      (result.terminal === true || (result.blocked && result.retryable !== true && !result.deferred));
    if (terminalBlock) {
      await db("review_requests").where({ id: request.id }).update({ status: "suppressed" });
      return { ok: false, blocked: true, terminal: true, channel, requestId: request.id, code: result?.code };
    }
    // Transient (provider failure / consent lookup blip).
    if (manageRetryVia === "cron") {
      await db("review_requests").where({ id: request.id }).update({
        status: "pending",
        scheduled_for: new Date(Date.now() + 5 * 60 * 1000),
      });
    } else {
      await db("review_requests").where({ id: request.id }).update({ status: "failed" });
    }
    return { ok: false, retryable: true, channel, requestId: request.id, code: result?.code };
  },

  async _sendOutreachEmail({ request, customer, contact, reviewUrl, techName, manageRetryVia }) {
    // Same split as SMS (audit P1): only the SEND is in the retry-on-throw path.
    let result;
    try {
      const EmailLib = require("./email-template-library");
      result = await EmailLib.sendTemplate({
        templateKey: "review_request_email",
        to: contact.email,
        payload: {
          first_name: firstNameFrom(contact.name) || customer.first_name || "",
          review_url: reviewUrl,
          tech_name: techName || "Adam",
        },
        recipientType: "customer",
        recipientId: customer.id,
        // Stable per sequence STEP (not per touch row): a sequence retry inserts
        // a fresh review_requests row, so a request.id-based key would change
        // each retry and bypass the email library's dedupe — re-sending the same
        // Day-7 email if a prior attempt was accepted but then threw.
        idempotencyKey:
          request.sequence_id != null && request.sequence_step != null
            ? `review_seq:${request.sequence_id}:${request.sequence_step}`
            : `review_touch:${request.id}`,
        suppressionGroupKey: "service_operational",
        categories: ["review_request"],
      });
    } catch (err) {
      logger.error(`[review] outreach email send threw (requestId=${request.id} errType=${err?.name || "Error"})`);
      // There is NO standalone email retry driver — processScheduled only
      // re-sends SMS (it excludes channel='email'). So:
      //  • sequence touch → the sequence cron re-runs this step; mark 'failed'
      //    and report retryable so _runSequenceStep reschedules next_run_at.
      //  • one-off (cron) → nothing would ever retry it; mark 'failed' and report
      //    a hard failure so the caller doesn't tell the operator it's "queued".
      await db("review_requests").where({ id: request.id }).update({ status: "failed" }).catch(() => {});
      if (manageRetryVia === "sequence") {
        return { ok: false, retryable: true, channel: "email", requestId: request.id };
      }
      return { ok: false, terminal: true, channel: "email", requestId: request.id, reason: "email_send_failed" };
    }

    // Send returned — bookkeeping failures here must NOT requeue (the email
    // library already deduped/sent). Report based on the result.
    try {
      if (result && result.sent) {
        await db("review_requests").where({ id: request.id }).update({ status: "sent", sent_at: new Date() });
        return { ok: true, sent: true, channel: "email", requestId: request.id };
      }
      await db("review_requests").where({ id: request.id }).update({ status: "suppressed" });
      return { ok: false, blocked: true, terminal: true, channel: "email", requestId: request.id, reason: result?.reason || "email_blocked" };
    } catch (bookErr) {
      logger.error(`[review] post-send email bookkeeping failed (requestId=${request.id} sent=${!!result?.sent} errType=${bookErr?.name || "Error"})`);
      // Only a SENT result avoids retry. A not-sent result keeps retryability so
      // the cadence step isn't stopped over a bookkeeping blip.
      return result?.sent
        ? { ok: true, sent: true, channel: "email", requestId: request.id }
        : { ok: false, retryable: true, channel: "email", requestId: request.id, reason: "bookkeeping_failed" };
    }
  },

  /**
   * Start a multi-touch review cadence for one customer. Idempotent: a customer
   * with an active sequence returns that one instead of starting a second
   * (also enforced by the partial unique index). Fires step 0 immediately.
   */
  async startReviewSequence({ customerId, plan, startedBy, locationId, serviceType, techName, serviceRecordId }) {
    const customer = await db("customers").where({ id: customerId }).first();
    if (!customer) throw new Error("Customer not found");
    if (customer.deleted_at) throw new Error("Customer is archived");
    if (customer.has_left_google_review) return { started: false, reason: "already_reviewed" };

    const active = await db("review_sequences").where({ customer_id: customerId, status: "active" }).first();
    if (active) return { started: false, reason: "already_active", sequence: active };

    // The first touch is an immediate ask, so enforce the same lifetime cap +
    // 30-day cooldown as a one-off send (the candidate list already filters on
    // these, but this endpoint can be hit directly / in bulk / racing a recent
    // send). Counts asks across BOTH channels. Fail CLOSED — a DB blip must not
    // let an at-cap / in-cooldown customer through (no .catch → it throws and
    // the route records the customer as not-started). Day 3/7 still bypass cooldown.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const stats = await this.getDeliveredAskStats(customerId);
    if (stats.count >= 3) return { started: false, reason: "at_cap" };
    if (stats.lastAt && new Date(stats.lastAt).getTime() >= thirtyDaysAgo.getTime()) {
      return { started: false, reason: "cooldown" };
    }

    // Supersede any already-queued ASK (post-service auto, or a quiet-hours
    // deferral): otherwise processScheduled() would fire it AND the cadence's
    // Day-0 touch → a duplicate review request. Only ASKS are superseded — a
    // queued private no-link check-in (ASK_TOUCH_SQL excludes it) is left alone.
    // Fail CLOSED — if this can't run, abort the start (no .catch → it throws and
    // the route records not-started) rather than risk a stranded duplicate ask.
    await db("review_requests")
      .where({ customer_id: customerId, status: "pending" })
      .whereNull("sms_sent_at")
      .whereNotNull("scheduled_for")
      .whereRaw(ASK_TOUCH_SQL)
      .update({ status: "suppressed" });

    const usePlan = Array.isArray(plan) && plan.length ? plan : OUTREACH.DEFAULT_SEQUENCE_PLAN;
    let svcType = serviceType;
    let tName = techName;
    if (!svcType || !tName) {
      const lastSvc = await db("scheduled_services")
        .where({ customer_id: customerId, status: "completed" })
        .orderBy("scheduled_date", "desc")
        .first()
        .catch(() => null);
      svcType = svcType || lastSvc?.service_type || null;
      tName = tName || lastSvc?.tech_name || "Adam";
    }
    const locId = locationId || customer.nearest_location_id || resolveLocation(customer);

    let sequence;
    try {
      [sequence] = await db("review_sequences")
        .insert({
          customer_id: customerId,
          location_id: locId,
          status: "active",
          plan: JSON.stringify(usePlan),
          current_step: 0,
          touches_sent: 0,
          // Insert with next_run_at NULL so the cron (which only picks rows with
          // a non-null next_run_at <= now) can't grab this row and fire step 0
          // in parallel with the inline _runSequenceStep below — the cron lock
          // serializes cron workers, not this admin path. _runSequenceStep sets
          // next_run_at when it advances/retries.
          next_run_at: null,
          service_record_id: serviceRecordId || null,
          tech_name: tName,
          service_type: svcType,
          started_by: startedBy || null,
          started_at: new Date(),
        })
        .returning("*");
    } catch (err) {
      if (err?.code === "23505") {
        const existing = await db("review_sequences").where({ customer_id: customerId, status: "active" }).first();
        return { started: false, reason: "already_active", sequence: existing };
      }
      throw err;
    }

    let firstTouch;
    try {
      firstTouch = await this._runSequenceStep(sequence.id);
    } catch (err) {
      // The Day-0 touch threw during setup (insert / short-link / send). The
      // step's own catch restored next_run_at for a CRON retry, but for a
      // START the operator is told it failed — so DON'T leave an active row the
      // cron would fire later. Stop it and report not-started.
      await db("review_sequences")
        .where({ id: sequence.id, status: "active" })
        .update({ status: "stopped", stop_reason: "start_failed", next_run_at: null, completed_at: new Date(), updated_at: new Date() })
        .catch(() => {});
      return { started: false, reason: "send_failed" };
    }
    const refreshed = await db("review_sequences").where({ id: sequence.id }).first();
    // If the immediate first touch stopped the cadence (no contact, just opted
    // out, already reviewed), report it as NOT started so the route doesn't
    // count a phantom "started" — the row is already stopped and nothing runs.
    if (refreshed && refreshed.status === "stopped") {
      return { started: false, reason: refreshed.stop_reason || "stopped", sequence: refreshed, firstTouch };
    }
    return { started: true, sequence: refreshed, firstTouch };
  },

  /** Run the current step of one sequence (send + advance, or stop). */
  async _runSequenceStep(sequenceId) {
    const seq = await db("review_sequences").where({ id: sequenceId }).first();
    if (!seq || seq.status !== "active") return { ran: false, reason: "not_active" };
    const plan = Array.isArray(seq.plan) ? seq.plan : JSON.parse(seq.plan || "[]");
    const customer = await db("customers").where({ id: seq.customer_id }).first();

    const stop = async (reason) => {
      await db("review_sequences").where({ id: seq.id }).update({
        status: reason === "completed" ? "completed" : "stopped",
        stop_reason: reason,
        next_run_at: null,
        completed_at: new Date(),
        updated_at: new Date(),
      });
      return { ran: false, stopped: true, reason };
    };

    if (!customer || customer.deleted_at) return stop("deleted");
    if (customer.has_left_google_review) return stop("reviewed");
    try {
      const gr = await db("google_reviews").where({ customer_id: seq.customer_id }).first();
      if (gr) return stop("reviewed");
    } catch {
      /* google_reviews may not exist */
    }
    // Stop once the customer has ENGAGED with any touch in this cadence — the
    // /rate flow marks the row submitted/rated (score/category) WITHOUT setting
    // has_left_google_review or a google_reviews row, so a passive/detractor who
    // gave private feedback must not keep getting Day-3/7 review asks.
    const submitted = await db("review_requests")
      .where({ sequence_id: seq.id })
      .whereNotNull("submitted_at")
      .first()
      .catch(() => null);
    const rated = submitted
      ? null
      : await db("review_requests")
          .where({ sequence_id: seq.id })
          .whereNotNull("rated_at")
          .first()
          .catch(() => null);
    // Also catch a NON-PROMOTER draft score tap — /rate/:token/score stores
    // score + category WITHOUT submitted_at, and the touch is followup_sent=true
    // so the legacy low-score path won't catch it either. A detractor/passive
    // who tapped a low score must not keep getting Day-3/7 review asks.
    const lowDraft = submitted || rated
      ? null
      : await db("review_requests")
          .where({ sequence_id: seq.id })
          .whereNotNull("score")
          .whereNot("category", "promoter")
          .first()
          .catch(() => null);
    if (submitted || rated || lowDraft) return stop("responded");
    if (seq.current_step >= plan.length) return stop("completed");
    // Keep the whole cadence within the lifetime 3-ask cap: a customer who had
    // 1-2 prior asks must not reach 4-5 via the cadence. Delivered ask touches
    // (incl. this cadence's own) are counted, so the sequence stops once 3 is hit.
    let askStats;
    try {
      askStats = await this.getDeliveredAskStats(seq.customer_id);
    } catch {
      // Fail CLOSED: sendOutreachTouch does NOT enforce the lifetime cap, so a
      // stats blip must defer the step (retry next tick), not send a 4th ask.
      await db("review_sequences")
        .where({ id: seq.id, status: "active" })
        .update({ next_run_at: new Date(Date.now() + 30 * 60 * 1000), updated_at: new Date() })
        .catch(() => {});
      return { ran: false, deferred: true, reason: "cap_stats_unavailable" };
    }
    if (askStats.count >= 3) return stop("capped");
    try {
      const prefs = await db("notification_prefs").where({ customer_id: seq.customer_id }).first();
      if (prefs && prefs.review_request === false) return stop("opted_out");
      if (prefs && prefs.sms_enabled === false && prefs.email_enabled === false) return stop("opted_out");
    } catch {
      /* ignore */
    }

    const step = plan[seq.current_step] || {};

    // Final atomic claim right before sending: an admin Stop (or a completing
    // touch on a sibling row) can land between the reads above and here. Flip
    // next_run_at to NULL only if the row is STILL active — if 0 rows update,
    // it was stopped/completed concurrently, so bail without sending. (The
    // value is restored to the real schedule on success/retry below.)
    const claimed = await db("review_sequences")
      .where({ id: seq.id, status: "active" })
      .update({ next_run_at: null, updated_at: new Date() });
    if (!claimed) return { ran: false, reason: "not_active" };

    let outcome;
    try {
      outcome = await this.sendOutreachTouch({
        customer,
        channel: step.channel || "sms",
        templateId: step.templateKey || null,
        locationId: seq.location_id,
        techName: seq.tech_name,
        serviceType: seq.service_type,
        serviceRecordId: seq.service_record_id,
        sequenceId: seq.id,
        sequenceStep: seq.current_step,
        triggeredBy: "sequence",
        manageRetryVia: "sequence",
      });
    } catch (err) {
      // The claim above cleared next_run_at; if the touch throws BEFORE handling
      // its own outcome (e.g. the review_requests insert or short-link fails),
      // restore a retry time so the cron picks the sequence up again instead of
      // stranding it with next_run_at = null.
      await db("review_sequences")
        .where({ id: seq.id, status: "active" })
        .update({ next_run_at: new Date(Date.now() + 30 * 60 * 1000), updated_at: new Date() })
        .catch(() => {});
      throw err;
    }

    if (outcome.ok && outcome.sent) {
      const nextStep = seq.current_step + 1;
      // The post-send advance/complete is conditional on status='active': if an
      // admin Stop landed WHILE sendOutreachTouch was awaiting Twilio/SendGrid,
      // status is now 'stopped' and these update 0 rows — so a stop during the
      // send window is honored (the next touch won't be scheduled) rather than
      // silently undone by re-activating the row.
      if (nextStep >= plan.length) {
        await db("review_sequences").where({ id: seq.id, status: "active" }).update({
          status: "completed",
          stop_reason: "completed",
          current_step: nextStep,
          touches_sent: seq.touches_sent + 1,
          last_touch_at: new Date(),
          next_run_at: null,
          completed_at: new Date(),
          updated_at: new Date(),
        });
        return { ran: true, sent: true, completed: true, step: seq.current_step };
      }
      const plannedAt = new Date(new Date(seq.started_at).getTime() + (Number(plan[nextStep].day) || 0) * 86400000);
      const next_run_at = plannedAt > new Date() ? plannedAt : new Date(Date.now() + 60000);
      await db("review_sequences").where({ id: seq.id, status: "active" }).update({
        current_step: nextStep,
        touches_sent: seq.touches_sent + 1,
        last_touch_at: new Date(),
        next_run_at,
        updated_at: new Date(),
      });
      return { ran: true, sent: true, step: seq.current_step };
    }

    if (outcome.terminal || outcome.blocked) {
      if (outcome.reason === "no_contact") return stop("no_contact");
      if (outcome.reason === "already_reviewed") return stop("reviewed");
      return stop("opted_out");
    }

    // Deferred / transient → retry this step later without advancing.
    const retryAt = outcome.nextAllowedAt ? new Date(outcome.nextAllowedAt) : new Date(Date.now() + 30 * 60 * 1000);
    await db("review_sequences").where({ id: seq.id }).update({ next_run_at: retryAt, updated_at: new Date() });
    return { ran: false, deferred: true, retryAt };
  },

  /** Cron: advance all due review sequences. Gated by GATE_REVIEW_SEQUENCES. */
  async processReviewSequences() {
    const due = await db("review_sequences")
      .where({ status: "active" })
      .whereNotNull("next_run_at")
      .where("next_run_at", "<=", new Date())
      .orderBy("next_run_at", "asc")
      .limit(25);
    let sent = 0;
    let stopped = 0;
    let completed = 0;
    let deferred = 0;
    for (const seq of due) {
      try {
        const r = await this._runSequenceStep(seq.id);
        if (r.sent) sent++;
        if (r.completed) completed++;
        else if (r.stopped) stopped++;
        if (r.deferred) deferred++;
      } catch (err) {
        logger.error(`[review] sequence step failed (sequenceId=${seq.id} errType=${err?.name || "Error"})`);
      }
    }
    if (sent || stopped || completed || deferred) {
      logger.info(`[review] Sequences: ${sent} sent, ${completed} completed, ${stopped} stopped, ${deferred} deferred`);
    }
    return { sent, stopped, completed, deferred };
  },

  async stopReviewSequence(sequenceId, reason = "manual") {
    const updated = await db("review_sequences")
      .where({ id: sequenceId, status: "active" })
      .update({
        status: "stopped",
        stop_reason: reason,
        next_run_at: null,
        completed_at: new Date(),
        updated_at: new Date(),
      });
    return { stopped: updated > 0 };
  },

  /**
   * Channel-complete "review asks delivered" stats for one customer — counts
   * every review_requests row actually sent on SMS OR email (audit: the old
   * sms_log-only count missed email asks, so a customer could exceed the cap /
   * dodge the cooldown via email). Used by the cap + 30-day cooldown guards.
   */
  async getDeliveredAskStats(customerId) {
    const countRow = await db("review_requests")
      .where({ customer_id: customerId })
      .whereRaw("(sms_sent_at IS NOT NULL OR sent_at IS NOT NULL)")
      .whereRaw(ASK_TOUCH_SQL)
      .count("* as count")
      .first();
    const recent = await db("review_requests")
      .where({ customer_id: customerId })
      .whereRaw("(sms_sent_at IS NOT NULL OR sent_at IS NOT NULL)")
      .whereRaw(ASK_TOUCH_SQL)
      .orderByRaw("COALESCE(sms_sent_at, sent_at) DESC")
      .first();
    return {
      count: Number(countRow?.count) || 0,
      lastAt: recent ? recent.sms_sent_at || recent.sent_at : null,
    };
  },

  /** Batched getDeliveredAskStats for the candidate list. */
  async getDeliveredAskStatsBatch(ids = []) {
    if (!ids.length) return {};
    const rows = await db("review_requests")
      .whereIn("customer_id", ids)
      .whereRaw("(sms_sent_at IS NOT NULL OR sent_at IS NOT NULL)")
      .whereRaw(ASK_TOUCH_SQL)
      .groupBy("customer_id")
      .select(
        "customer_id",
        db.raw("COUNT(*) AS count"),
        db.raw("MAX(COALESCE(sms_sent_at, sent_at)) AS last_at"),
      );
    const map = {};
    rows.forEach((r) => {
      map[r.customer_id] = { askCount: Number(r.count) || 0, lastAsked: r.last_at };
    });
    return map;
  },

  /** Map of customerId → active sequence summary (for candidate annotation). */
  async getActiveSequencesForCustomers(ids = []) {
    if (!ids.length) return {};
    const rows = await db("review_sequences").whereIn("customer_id", ids).where("status", "active");
    const map = {};
    rows.forEach((r) => {
      const plan = Array.isArray(r.plan) ? r.plan : JSON.parse(r.plan || "[]");
      map[r.customer_id] = {
        id: r.id,
        currentStep: r.current_step,
        totalSteps: plan.length,
        nextRunAt: r.next_run_at,
      };
    });
    return map;
  },

  /**
   * Real conversion funnel + velocity for the Review Outreach dashboard
   * (audit O1). Conversion is the share of sent asks that clicked through to
   * Google (redirected_to_google); velocity is actual Google reviews landed.
   */
  async getOutreachAnalytics({ days = 90 } = {}) {
    const window = Math.max(1, Math.min(365, Number(days) || 90));
    const since = new Date(Date.now() - window * 86400000);

    // The live /rate/<token> flow (review-gate.js) records score / category /
    // submitted_at — NOT the legacy rating / rated_at / redirected_to_google
    // (those belong to the older review-public.js submitRating path). Count
    // BOTH families so the funnel reflects real conversions on either flow.
    // "Directed to Google" = a promoter (score 8-10 → Google redirect) or the
    // legacy redirect flag.
    // A bare 8-10 score TAP stores category='promoter' with no submitted_at and
    // no Google redirect (review-gate.js /score). Those drafts must NOT count as
    // rated/promoter/Google-directed, or the dashboard overstates conversions —
    // so the live-flow promoter is gated on submitted_at.
    const SENT_SQL = "(sms_sent_at IS NOT NULL OR sent_at IS NOT NULL)";
    const RATED_SQL = "(submitted_at IS NOT NULL OR rated_at IS NOT NULL)";
    const OPENED_SQL = "(opened_at IS NOT NULL OR submitted_at IS NOT NULL OR rated_at IS NOT NULL)";
    const PROMOTER_SQL = "((category = 'promoter' AND submitted_at IS NOT NULL) OR rating >= 7)";
    const REVIEWED_SQL = "(redirected_to_google = true OR (category = 'promoter' AND submitted_at IS NOT NULL))";

    // The funnel measures review ASKS, so exclude no-link private check-ins
    // (same predicate as the cap stats) — otherwise recovery/check-in sends
    // inflate the "sent" denominator and skew the conversion rate + template
    // breakdown with messages that had no review CTA.
    const [funnel] = await db("review_requests")
      .where("created_at", ">=", since)
      .whereRaw(ASK_TOUCH_SQL)
      .select(
        db.raw(`COUNT(*) FILTER (WHERE ${SENT_SQL}) AS sent`),
        db.raw(`COUNT(*) FILTER (WHERE ${OPENED_SQL}) AS opened`),
        db.raw(`COUNT(*) FILTER (WHERE ${RATED_SQL}) AS rated`),
        db.raw(`COUNT(*) FILTER (WHERE ${PROMOTER_SQL}) AS promoters`),
        db.raw(`COUNT(*) FILTER (WHERE ${REVIEWED_SQL}) AS reviewed`),
        db.raw("COUNT(*) FILTER (WHERE channel = 'email') AS email_touches"),
      );

    const breakdown = (col) =>
      db("review_requests")
        .where("created_at", ">=", since)
        .whereRaw(SENT_SQL)
        .whereRaw(ASK_TOUCH_SQL)
        .groupBy(col)
        .select(
          col,
          db.raw("COUNT(*) AS sent"),
          db.raw(`COUNT(*) FILTER (WHERE ${REVIEWED_SQL}) AS reviewed`),
        );

    const byLocation = await breakdown("location_id");
    const byTemplate = await breakdown("template_key");
    const byChannel = await breakdown("channel");

    // Actual Google reviews landed in window — the real outcome + velocity.
    let googleByLocation = [];
    let velocity = [];
    try {
      googleByLocation = await db("google_reviews")
        .where("reviewer_name", "!=", "_stats")
        .where("review_created_at", ">=", since)
        .groupBy("location_id")
        .select("location_id", db.raw("COUNT(*) AS reviews"), db.raw("ROUND(AVG(star_rating)::numeric, 2) AS avg_rating"));
      velocity = await db("google_reviews")
        .where("reviewer_name", "!=", "_stats")
        .where("review_created_at", ">=", since)
        .select(db.raw("date_trunc('week', review_created_at) AS week"), db.raw("COUNT(*) AS reviews"))
        .groupByRaw("date_trunc('week', review_created_at)")
        .orderByRaw("date_trunc('week', review_created_at) ASC");
    } catch {
      /* google_reviews may not exist */
    }

    const num = (v) => Number(v) || 0;
    const sent = num(funnel?.sent);
    const reviewed = num(funnel?.reviewed);
    const activeSequences = num(
      (await db("review_sequences").where("status", "active").count("* as c").first().catch(() => ({ c: 0 })))?.c,
    );

    return {
      window,
      funnel: {
        sent,
        opened: num(funnel?.opened),
        rated: num(funnel?.rated),
        promoters: num(funnel?.promoters),
        reviewed,
        emailTouches: num(funnel?.email_touches),
        conversionRate: sent > 0 ? Math.round((reviewed / sent) * 100) : 0,
        openRate: sent > 0 ? Math.round((num(funnel?.opened) / sent) * 100) : 0,
      },
      byLocation: byLocation.map((r) => ({ locationId: r.location_id, sent: num(r.sent), reviewed: num(r.reviewed) })),
      byTemplate: byTemplate.map((r) => ({ templateKey: r.template_key || "canonical", sent: num(r.sent), reviewed: num(r.reviewed) })),
      byChannel: byChannel.map((r) => ({ channel: r.channel || "sms", sent: num(r.sent), reviewed: num(r.reviewed) })),
      googleByLocation: googleByLocation.map((r) => ({ locationId: r.location_id, reviews: num(r.reviews), avgRating: Number(r.avg_rating) || 0 })),
      velocity: velocity.map((r) => ({ week: r.week, reviews: num(r.reviews) })),
      activeSequences,
    };
  },

  /** Server-backed activity feed (audit O3 — replaces the localStorage log). */
  async getOutreachActivity({ limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = await db("review_requests as rr")
      .leftJoin("customers as c", "c.id", "rr.customer_id")
      .whereRaw("COALESCE(rr.sms_sent_at, rr.sent_at, rr.submitted_at, rr.rated_at, rr.opened_at) IS NOT NULL")
      .select(
        "rr.id",
        "rr.status",
        "rr.channel",
        "rr.template_key",
        "rr.location_id",
        "rr.sms_sent_at",
        "rr.sent_at",
        "rr.opened_at",
        "rr.submitted_at",
        "rr.rated_at",
        "rr.rating",
        "rr.score",
        "rr.category",
        "rr.redirected_to_google",
        "rr.sequence_id",
        "rr.triggered_by",
        "c.first_name",
        "c.last_name",
      )
      .orderByRaw("COALESCE(rr.submitted_at, rr.rated_at, rr.opened_at, rr.sms_sent_at, rr.sent_at, rr.created_at) DESC")
      .limit(lim);

    return rows.map((r) => {
      const name = `${r.first_name || ""} ${r.last_name || ""}`.trim() || "Customer";
      // Score (live /rate flow) and rating (legacy) both express NPS; promoters
      // (score 8-10 / category 'promoter' / rating ≥7) are the ones directed to
      // Google.
      const nps = r.score ?? r.rating ?? null;
      const isRated = r.submitted_at != null || r.rated_at != null;
      // Same submitted-gate as the funnel: a score-tap draft isn't a promoter.
      const isPromoter =
        r.redirected_to_google === true ||
        (r.category === "promoter" && r.submitted_at != null) ||
        (r.rating != null && r.rating >= 7);
      let type = "sent";
      let msg;
      if (isPromoter) {
        type = "reviewed";
        msg = `${name} was sent to Google (promoter)`;
      } else if (isRated) {
        type = "rated";
        msg = `${name} rated ${nps ?? "?"}/10`;
      } else {
        const via = r.sequence_id ? "cadence" : r.triggered_by === "auto" ? "auto" : "manual";
        msg = `Review request sent to ${name} (${r.channel || "sms"}, ${via})`;
      }
      return {
        id: r.id,
        type,
        channel: r.channel || "sms",
        locationId: r.location_id,
        message: msg,
        at: r.submitted_at || r.rated_at || r.opened_at || r.sms_sent_at || r.sent_at,
      };
    });
  },

  // ── Stats ──
  async getStats() {
    const [totals] = await db("review_requests").select(
      db.raw("COUNT(*) as total"),
      db.raw("COUNT(*) FILTER (WHERE rated_at IS NOT NULL) as rated"),
      db.raw(
        "COUNT(*) FILTER (WHERE redirected_to_google = true) as sent_to_google",
      ),
      db.raw(
        "COUNT(*) FILTER (WHERE rating >= 7 AND rated_at IS NOT NULL) as promoters",
      ),
      db.raw(
        "COUNT(*) FILTER (WHERE rating <= 4 AND rated_at IS NOT NULL) as detractors",
      ),
      db.raw("COUNT(*) FILTER (WHERE sms_sent_at IS NOT NULL) as sms_sent"),
      db.raw(
        "ROUND(AVG(rating) FILTER (WHERE rated_at IS NOT NULL), 1) as avg_rating",
      ),
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

ReviewService.__private = {
  retryAtForDeferredSend,
  calculateReviewSendTime,
};

module.exports = ReviewService;
