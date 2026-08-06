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
const CAP_TOUCH_SQL = OUTREACH.CAP_TOUCH_SQL;
// Trapping-family catalog keys (owner ruling 2026-08-06: "rodent/wildlife
// should be deemed multiple visits") — multi-treatment REVIEW-CADENCE
// semantics only. Deliberately NOT merged into TWO_TREATMENT_PACKAGE_KEYS:
// its other consumers (admin-dispatch follow-up alert, typed follow-up
// obligations) encode exactly-two-visit package semantics that open-ended
// trapping programs do not share. Keys mirror the prod services catalog —
// every rodent trapping row plus rodent_exclusion, whose catalog name is
// "Rodent Exclusion & Trapping Service" (7-day return visit standard).
const RODENT_TRAPPING_SERIES_KEYS = new Set([
  "rodent_trapping",
  "rodent_trapping_followup",
  "rodent_trapping_exclusion",
  "rodent_trapping_exclusion_sanitation",
  "rodent_trapping_sanitation",
  "rodent_exclusion",
]);
const TRAPPING_MULTI_TREATMENT_KEYS = new Set([...RODENT_TRAPPING_SERIES_KEYS, "wildlife_trapping"]);
// Series position crosses keys only within ONE service line (codex #3243 r2
// P2): a wildlife job must not read as a rodent program's prior/next visit.
// Wildlife has a single catalog row, so it matches only itself; the rodent
// SKUs cross-match because the return check has its own row.
function trappingSeriesKeysFor(serviceKey) {
  return serviceKey === "wildlife_trapping" ? ["wildlife_trapping"] : [...RODENT_TRAPPING_SERIES_KEYS];
}
// Stamped-address conflict for premise comparison — CANONICAL forms via the
// property-dedup streetKey ("123 Main St." == "123 Main Street", suffixes
// never stripped) and normalizeZip, the same identity stampedAddressDiverges
// uses (codex #3243 r6 P1: a parallel whitespace-only rule split equivalent
// formats into different premises). Each leg requires BOTH sides present —
// a missing value is unknown, not different.
function premiseStampConflicts(a, b) {
  const { streetKey, unitKey, streetEmbeddedUnitKey, normalizeZip } = require("./customer-properties");
  const sa = streetKey(a?.service_address_line1);
  const sb = streetKey(b?.service_address_line1);
  if (!sa || !sb) return false;
  if (sa !== sb) return true;
  // Unit leg (codex #3243 r7 P2): streetKey is deliberately unit-stripped,
  // so two units at one street key identically — compare the unit identity
  // (explicit line2, else embedded in line1) when both sides carry one.
  const ua = unitKey(a?.service_address_line2) || streetEmbeddedUnitKey(a?.service_address_line1);
  const ub = unitKey(b?.service_address_line2) || streetEmbeddedUnitKey(b?.service_address_line1);
  // One-sided units diverge too (codex #3243 r10 P2): "100 Main St Apt 4"
  // vs the unitless "100 Main St" is a sub-unit, not the same premise.
  // Errs toward fewer merges — the safe direction for cadence position.
  if ((ua || ub) && ua !== ub) return true;
  const za = normalizeZip(a?.service_address_zip);
  const zb = normalizeZip(b?.service_address_zip);
  if (za && zb && za !== zb) return true;
  const cityNorm = (v) => String(v == null ? "" : v).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const ca = cityNorm(a?.service_address_city);
  const cb = cityNorm(b?.service_address_city);
  return !!(ca && cb && ca !== cb);
}
// A stamp matching a reference's street but omitting the unit INHERITS the
// reference's unit (codex #3243 r12 P2 — the canonical stamped-address rule:
// phone extractions often omit line 2, so a missing stamped unit is unknown,
// not different). A stamp that ADDS a unit the reference lacks stays
// divergent (r10: a sub-unit is not the whole-street premise).
function inheritReferenceUnit(row, reference) {
  const { streetKey, unitKey, streetEmbeddedUnitKey } = require("./customer-properties");
  if (!row || !reference) return row;
  const rowUnit = unitKey(row.service_address_line2) || streetEmbeddedUnitKey(row.service_address_line1);
  if (rowUnit) return row;
  // The reference's unit may live in line 2 OR embedded in its street line
  // ("100 Main St Apt 7" — codex #3243 r13 P2); either form inherits.
  const refUnit = unitKey(reference.service_address_line2) || streetEmbeddedUnitKey(reference.service_address_line1);
  if (!refUnit) return row;
  const rs = streetKey(row.service_address_line1);
  if (!rs || rs !== streetKey(reference.service_address_line1)) return row;
  return { ...row, service_address_line2: reference.service_address_line2 || refUnit };
}
// Premise predicate for trapping history (codex #3243 r2+r3+r5 P2): a linked
// NON-primary property (rental, second home) is strict; the primary premise
// spans BOTH legacy NULL rows and rows carrying the backfilled primary
// property id — call-booked visits stamp the primary row's id while older
// rows for the same address carry NULL (same equivalence the re-service
// premise classifier documents in call-recording-processor). BUT NULL also
// means an UNMATCHED caller-stated address, distinguished only by the
// stamped service_address_* fields — so when BOTH rows carry stamps and
// they differ, they are different premises regardless of the NULL fallback.
// Takes the enrolling visit ROW, returns a predicate over candidate rows
// ({property_id, service_address_line1, service_address_zip}), applied
// JS-side. Fail-open to customer-wide matching — scoping is a refinement,
// not a guarantee.
async function trappingPremiseMatcher(customerId, visit) {
  // FAIL CLOSED (codex #3243 r7 P2): a lookup error here must propagate —
  // resolveSequencePlanForEnrollment's retry/plan_resolution_failed path
  // suppresses the uncertain enrollment, and the exemption walk's own catch
  // degrades to NO exemption (fewer sends). A customer-wide fallback would
  // instead let another property's visit rewrite this one's cadence.
  if (visit.property_id) {
    const prop = await db("customer_properties")
      .where({ id: visit.property_id })
      .select("id", "is_primary", "address_line1", "address_line2", "city", "zip")
      .first();
    if (prop && !prop.is_primary) {
      // Accept the property id OR a canonically equal stamp (codex #3243
      // r8 P2): a rental's earlier visits can PREDATE its property row —
      // property recording is feature-gated while address stamping is not —
      // so the opener carries only NULL + the stamped address. Positive
      // street match against the property's own address is required; an
      // unstamped legacy row is the primary premise, never the rental.
      const { streetKey } = require("./customer-properties");
      const propStamp = {
        service_address_line1: prop.address_line1,
        service_address_line2: prop.address_line2,
        service_address_city: prop.city,
        service_address_zip: prop.zip,
      };
      const propStreet = streetKey(prop.address_line1);
      return (row) => {
        if (row.property_id === visit.property_id) return true;
        if (row.property_id != null || !propStreet) return false;
        const rowN = inheritReferenceUnit(row, propStamp);
        return streetKey(rowN?.service_address_line1) === propStreet
          && !premiseStampConflicts(rowN, propStamp);
      };
    }
  }
  // Primary-or-NULL visit. NULL is ambiguous — legacy primary OR an
  // unmatched caller-stated address (codex #3243 r6 P2; the linkage
  // migration adds the stamp columns WITHOUT backfilling legacy rows) —
  // so a lone stamp is judged against the customer's on-file primary
  // address before the NULL fallback applies.
  const cust = await db("customers").where({ id: customerId }).select("address_line1", "address_line2", "city", "zip").first();
  const primaryStamp = {
    service_address_line1: cust?.address_line1,
    service_address_line2: cust?.address_line2,
    service_address_city: cust?.city,
    service_address_zip: cust?.zip,
  };
  const primary = await db("customer_properties").where({ customer_id: customerId, is_primary: true }).select("id").first();
  const primaryId = primary?.id || null;
  // Missing stamped units inherit the primary's unit before any conflict
  // decision (codex #3243 r12 P2) — phone extractions often omit line 2.
  const visitN = inheritReferenceUnit(visit, primaryStamp);
  if (premiseStampConflicts(visitN, primaryStamp)) {
    // The visit is a stamped UNMATCHED premise (a rental the property
    // table doesn't know): only rows stamped with the SAME address are
    // the same series — unstamped legacy rows are the primary, not it.
    return (row) => {
      const { streetKey } = require("./customer-properties");
      return !!streetKey(row?.service_address_line1) && !premiseStampConflicts(row, visitN);
    };
  }
  // The visit IS the primary premise: legacy NULL rows and rows carrying
  // the backfilled primary id match; a row stamped with a DIFFERENT
  // address than the primary does not, whatever its property_id.
  return (row) => {
    const rowN = inheritReferenceUnit(row, primaryStamp);
    return !premiseStampConflicts(rowN, primaryStamp)
      && !premiseStampConflicts(rowN, visitN)
      && (row.property_id == null
        || row.property_id === visit.property_id
        || (primaryId != null && row.property_id === primaryId));
  };
}
// Order two visits sharing a scheduled_date (codex #3243 r5 P2: trap setup
// and same-day capture/removal). window_start is a time-of-day string and
// compares lexically; created_at breaks ties. 0 = indeterminate.
function compareSameDayVisits(a, b) {
  if (a?.window_start && b?.window_start) {
    const x = String(a.window_start);
    const y = String(b.window_start);
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a?.created_at && b?.created_at) {
    const x = new Date(a.created_at).getTime();
    const y = new Date(b.created_at).getTime();
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
const { toE164 } = require("../utils/phone");
const { runExclusive } = require("../utils/cron-lock");

// GBP review links per location — derived from the canonical office map
// (config/locations.js) so a GBP link change lands everywhere at once instead
// of drifting across the three copies this module/satisfaction.js used to hold.
const { WAVES_LOCATIONS } = require("../config/locations");
const REVIEW_LINKS = Object.fromEntries(
  WAVES_LOCATIONS.filter((l) => l.googleReviewUrl).map((l) => [l.id, l.googleReviewUrl]),
);

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


// pg DATE columns deserialize as 'YYYY-MM-DD' strings or UTC-midnight Dates;
// new Date(...) + etDateString would shift them to the PREVIOUS Eastern day
// (the documented timestamptz trap — AGENTS.md; codex #3235 r12 P1). The
// drafter's etCalendarDayOf is the single source for reading them literally.
function etDayWindow(value, backDays) {
  const { etCalendarDayOf } = require("../utils/datetime-et");
  const day = etCalendarDayOf(value || new Date());
  const floorMs = Date.parse(`${day}T00:00:00Z`) - backDays * 86400000;
  return { anchorStr: day, floorStr: new Date(floorMs).toISOString().slice(0, 10) };
}

// Rolling window for the 3-delivered-asks cap (owner policy 2026-07-30:
// a never-engaging customer may get a fresh cadence at most every ~6 months).
const ASK_CAP_WINDOW_DAYS = 180;

// Canonical opening paragraph for the cadence email — the template's
// {{intro_paragraph}} default when no personalized draft verified. Keep in
// lockstep with the seed copy in
// migrations/20260806000001_review_email_intro_paragraph.js.
const GENERIC_EMAIL_INTRO = "We're a small, family-owned pest and lawn company here in Southwest Florida, and word of mouth is how neighbors find us. If your recent service hit the mark, would you take 15 seconds to share a quick review?";

/**
 * Build the (shortened) review link for an ask. Behind GATE_REVIEW_DIRECT_LINK
 * the link is the tracked server redirect that stamps the open/click on the
 * review_requests row and 302s STRAIGHT to the location's Google review form —
 * the 1-10 rate page produced zero Google click-throughs in four months, so
 * the gate removes that friction. Gate off = the tokenized /rate/<token> page,
 * exactly the pre-rollout behavior.
 */
async function buildReviewUrl(request, customerId) {
  const { isEnabled } = require("../config/feature-gates");
  const domain = publicPortalUrl();
  const longUrl = isEnabled("reviewDirectLink")
    ? `${domain}/api/rate/${request.token}/go`
    : `${domain}/rate/${request.token}`;
  return shortenOrPassthrough(longUrl, {
    kind: "review",
    entityType: "review_requests",
    entityId: request.id,
    customerId,
  });
}

/**
 * ET-wall-clock weekday shift: a send scheduled for Sat/Sun moves to Monday
 * 10:00 AM ET (±15 min jitter). Weekday sends pass through untouched.
 */
function shiftToWeekdayMorning(date) {
  let p = etParts(date);
  if (p.dayOfWeek !== 0 && p.dayOfWeek !== 6) return date;
  let shifted = date;
  while (p.dayOfWeek === 0 || p.dayOfWeek === 6) {
    shifted = addETDays(shifted, 1);
    p = etParts(shifted);
  }
  const minute = Math.floor(Math.random() * 31); // 10:00–10:30, spread the batch
  const naive = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T10:${String(minute).padStart(2, "0")}`;
  return parseETDateTime(naive);
}

/**
 * When the next sequence touch should fire. Base schedule is
 * started_at + step.day days; three corrections:
 *  - catch-up: a base time already in the past fires in ~60s, EXCEPT
 *  - min spacing: a later step never fires sooner than ~20h after the touch
 *    that just went out (a weekend-shifted Day-3 SMS would otherwise be
 *    chased by the already-due Day-4 email a minute later);
 *  - weekdaysOnly steps land Mon-Fri (ET) — Sat/Sun shifts to Monday 10 AM.
 */
function nextTouchRunAt({ startedAt, step, now = new Date() }) {
  const dayOffset = Number(step?.day) || 0;
  let at = new Date(new Date(startedAt).getTime() + dayOffset * 86400000);
  if (at <= now) at = new Date(now.getTime() + 60000);
  if (dayOffset > 0) {
    const minAt = new Date(now.getTime() + 20 * 3600000);
    if (at < minAt) at = minAt;
  }
  if (step?.weekdaysOnly) at = shiftToWeekdayMorning(at);
  return at;
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
  if (!result || !(result.retryable || result.deferred)) {
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
   * A review ask the OWNER already sent by hand (portal manual messaging with
   * a Google/rate link pasted in) — the cadence must not pile an automated
   * ask on top of it (2026-08-05: Adam texted a personal ask, the Day-0
   * cadence SMS landed the next morning). Detection: an outbound sms_log row
   * in the last 30 days whose body carries a review link/ask, with NO
   * review_requests send within ±10 minutes of it — the pipeline's own
   * touches always have a matching review_requests row, so time correlation
   * separates "Adam asked personally" from "the cadence asked".
   * `since` (a Date) overrides the default 30-day window — _runSequenceStep
   * passes the sequence's started_at so a mid-cadence recheck only reacts to
   * manual asks sent AFTER enrollment (an operator who deliberately started
   * a sequence despite their own recent ask keeps that override).
   * Fail-open on lookup errors (enroll anyway, warn): the cap/cooldown still
   * bound total volume, and an sms_log blip must not silently kill every
   * post-service enrollment.
   */
  async manualReviewAskSentRecently(customerId, { windowDays = 30, since = null } = {}) {
    const MANUAL_ASK_RE = /g\.page\/|writereview|\/rate\/[A-Za-z0-9]|\bgoogle\s+review\b|maps\.app\.goo\.gl\/|goo\.gl\/maps|maps\.google\.[a-z.]+\//i;
    // A forwarded copy of one of our own (now shorter) templates says just
    // "review" with a branded /l/ short link (codex #3235 r4 P1) — /l/ alone
    // is any portal short link (reports, appointments), so require BOTH the
    // short-link shape and review wording before treating it as an ask.
    const SHORT_LINK_RE = /\/l\/[A-Za-z0-9]{3,}\b/;
    const REVIEW_WORD_RE = /\breview/i;
    const looksLikeAsk = (body) => MANUAL_ASK_RE.test(body)
      || (SHORT_LINK_RE.test(body) && REVIEW_WORD_RE.test(body));
    try {
      const sinceAt = since ? new Date(since) : new Date(Date.now() - windowDays * 86400000);
      const outbound = await db("sms_log")
        .where({ customer_id: customerId, direction: "outbound" })
        .where("created_at", ">=", sinceAt)
        // Rows that never reached the customer are not asks: scheduled rows
        // are inserted pre-delivery (and stay on cancel), failed/undelivered
        // never landed, the scheduled-SMS executor stamps 'blocked' on
        // pre-delivery rejections and holds 'sending' during the in-flight
        // claim window (codex #3235 r1 P2 + r3 P2 + r4 P2).
        .whereNotIn("status", ["scheduled", "sending", "canceled", "cancelled", "failed", "undelivered", "blocked"])
        .orderBy("created_at", "desc")
        .limit(200)
        .select("message_body", "created_at");
      const candidates = outbound.filter((r) => looksLikeAsk(String(r.message_body || "")));
      if (!candidates.length) return false;
      // SMS sends only (codex #3235 r6 P2): correlating against email
      // sends would let an automated Day-0 EMAIL excuse the owner's hand
      // TEXT sent minutes later, defeating the standdown.
      const sends = await db("review_requests")
        .where({ customer_id: customerId })
        .whereNotNull("sms_sent_at")
        .select("sms_sent_at");
      const sentTimes = sends
        .map((r) => new Date(r.sms_sent_at).getTime())
        .filter((t) => Number.isFinite(t));
      // One pipeline send excuses ONE sms_log row (codex #3235 r12 P2): a
      // hand-sent ask minutes after an automated one must not share the
      // automated send's timestamp alibi. Greedy nearest-match consumption.
      // And a send whose own sms_log insert failed (twilio.js swallows the
      // post-send log error) is an ORPHAN — with no row of its own within
      // ±90s it may not excuse anything (codex r13 P2): the pipeline logs
      // at send time, so its row is seconds away; a manual text minutes
      // later is not.
      const TEN_MIN = 10 * 60 * 1000;
      const CORRESPONDENCE_MS = 90 * 1000;
      // Correspondence counts REVIEW-LOOKING rows only (codex #3235 r15 P2):
      // an unrelated invoice/report text logged near an orphaned review send
      // must not legitimize its timestamp.
      const candidateTimes = candidates
        .map((r) => new Date(r.created_at).getTime())
        .filter((t) => Number.isFinite(t));
      const unused = sentTimes.filter((sT) =>
        candidateTimes.some((cT) => Math.abs(cT - sT) <= CORRESPONDENCE_MS));
      return candidates.some((c) => {
        const t = new Date(c.created_at).getTime();
        let best = -1;
        let bestGap = Infinity;
        unused.forEach((sT, i) => {
          const gap = Math.abs(sT - t);
          if (gap <= TEN_MIN && gap < bestGap) { best = i; bestGap = gap; }
        });
        if (best === -1) return true; // no unconsumed pipeline send → manual ask
        unused.splice(best, 1);
        return false;
      });
    } catch (err) {
      logger.warn(`[review] manual-ask lookup failed (customerId=${customerId}): ${err.message} — enrolling anyway`);
      return false;
    }
  },

  /**
   * Which cadence plan this completion should enroll (owner spec 2026-08-05):
   *   - Multi-treatment series:
   *       first visit  → single cap-exempt first_treatment_ask;
   *       middle visit → nothing (skip);
   *       final visit  → the full one-time cadence (the cap-exempt first ask
   *       doesn't cooldown-block it).
   *   - Recurring plan visit / customer with live recurring coverage → ONE
   *     Day-0 ask per eligible visit.
   *   - Everything else (true one-time work) → the full 3-touch cadence.
   * A "multi-treatment series" is: a booked follow-up child visit
   * (scheduled_services.parent_service_id — structural, any service) OR one
   * of the owner-named multi-treatment services below. The catalog's
   * requires_follow_up flag is deliberately NOT a signal — prod carries it on
   * One-Time Pest Control (a courtesy re-check, same 14-day interval as the
   * roach/bed-bug rows), and the owner explicitly ruled one-time pest gets
   * the full cadence right after treatment. Fail-open to the default plan on
   * lookup errors: a wrong-but-bounded cadence beats no ask.
   */
  async resolveSequencePlanForEnrollment({ customerId, serviceRecordId = null, scheduledServiceId = null, _attempt = 0 }) {
    // Owner-named multi-treatment jobs (2026-08-05: "we should treat
    // cockroach different than one time pest, as we should bed bug") — the
    // follow-up visit IS a treatment, so the review ask waits for it. Other
    // multi-visit work joins this flow structurally once its follow-up is
    // actually booked as a linked child visit. The package set is the
    // canonical TWO_TREATMENT_PACKAGE_KEYS from the follow-up-obligation
    // lane — never a parallel copy (codex #3235 r1 P1). Lazy require: that
    // module is heavier than this hot path needs at load time.
    const { TWO_TREATMENT_PACKAGE_KEYS } = require("./typed-followup-obligation");
    try {
      let svc = null;
      // Visit identity: the service record's linked visit, or a directly
      // supplied scheduled_services id (codex #3235 r5 P1 — the admin
      // completion route can run before a service_records row exists, and
      // without visit context the resolver defaulted an ongoing plan's last
      // seeded visit or a series opener to the 3-touch one-time cadence).
      let visitId = scheduledServiceId || null;
      if (!visitId && serviceRecordId) {
        const sr = await db("service_records")
          .where({ id: serviceRecordId })
          .select("scheduled_service_id")
          .first();
        visitId = sr?.scheduled_service_id || null;
      }
      if (visitId) {
        {
          svc = await db("scheduled_services as s")
            .leftJoin("services as sv", "s.service_id", "sv.id")
            .where("s.id", visitId)
            .select("s.id", "s.parent_service_id", "s.followup_source_service_id", "s.is_recurring", "s.service_id", "s.scheduled_date", "s.property_id", "s.service_address_line1", "s.service_address_line2", "s.service_address_city", "s.service_address_zip", "s.window_start", "s.created_at", "sv.service_key", "sv.follow_up_interval_days")
            .first();
        }
      }

      if (svc) {
        const { TERMINAL_STATUSES } = require("./waveguard-existing-services");
        // A booked next treatment links back via followup_source_service_id
        // (the admin-dispatch included-follow-up CTA — the canonical
        // mechanism) or parent_service_id (call-booked linked visits).
        // Two lookups, not an OR (codex #3235 r2 P1: the first cut only
        // checked parent_service_id and missed every CTA-booked child).
        // Liveness is STATUS-ONLY (codex r4 P1) and uses the follow-up
        // obligation lane's OWN predicate (codex r9 P1): only cancelled /
        // skipped / no_show children are dead — a 'rescheduled' child is
        // still an outstanding treatment there, and the WaveGuard coverage
        // TERMINAL list wrongly discarded it. 'completed' is excluded here
        // too: a finished child means nothing further is coming.
        const { FOLLOWUP_CHILD_INACTIVE_STATUSES } = require("./typed-followup-obligation");
        // Two separate questions (codex #3235 r11 P1):
        //   POSITION — does ANY non-dead child exist (canonical inactive
        //   list only: cancelled/skipped/no_show)? A COMPLETED child still
        //   proves this visit is not the series' last — a late-paid middle
        //   visit must not classify as final.
        //   OUTSTANDING — is a child still coming (non-dead AND not
        //   completed)? That decides first-visit ask vs stand-down.
        const childQuery = (col, statuses) => db("scheduled_services")
          .where({ [col]: svc.id })
          .whereNotIn("status", statuses)
          .first();
        const liveStatuses = [...FOLLOWUP_CHILD_INACTIVE_STATUSES, "completed"];
        const liveChild = (await childQuery("followup_source_service_id", liveStatuses))
          || (await childQuery("parent_service_id", liveStatuses));
        const anyChild = liveChild
          || (await childQuery("followup_source_service_id", FOLLOWUP_CHILD_INACTIVE_STATUSES))
          || (await childQuery("parent_service_id", FOLLOWUP_CHILD_INACTIVE_STATUSES));
        // Trapping position resolves BEFORE the structural returns (codex
        // #3243 r3 P1): a program can mix linkage styles — a linked visit 2
        // with an unlinked booked visit 3, or an unlinked opener with a
        // linked child — and the child queries above only see LINKED
        // siblings. Line-scoped keys (the rodent return check has its own
        // catalog row, rodent_trapping_followup, so same-service matching
        // never sees the opener), premise-scoped JS-side via
        // trappingPremiseMatcher, window floored at 30 days (catalog
        // intervals are 1-7 days but a program's checks stretch across
        // weeks; a far-future booking is a new series).
        const isTrappingSeries = TRAPPING_MULTI_TREATMENT_KEYS.has(svc.service_key);
        let trapPrior = null;
        let trapLaterLive = null;
        let trapLaterCompleted = null;
        let visitDeclaredInitial = false;
        let trapEngaged = false;
        if (isTrappingSeries) {
          const intervalDays = Number(svc.follow_up_interval_days) > 0 ? Number(svc.follow_up_interval_days) : 15;
          const windowDays = Math.min(60, Math.max(30, intervalDays * 2));
          const { anchorStr, floorStr: windowFloor } = etDayWindow(svc.scheduled_date, windowDays);
          const ceilStr = new Date(Date.parse(`${anchorStr}T00:00:00Z`) + windowDays * 86400000)
            .toISOString().slice(0, 10);
          const seriesKeys = trappingSeriesKeysFor(svc.service_key);
          const inPremise = await trappingPremiseMatcher(customerId, svc);
          const priorRows = await db("scheduled_services as ps")
            .leftJoin("services as psv", "ps.service_id", "psv.id")
            .where("ps.customer_id", customerId)
            .where("ps.status", "completed")
            .where("ps.id", "!=", svc.id)
            .where("ps.scheduled_date", "<", anchorStr)
            .where("ps.scheduled_date", ">=", windowFloor)
            .whereIn("psv.service_key", seriesKeys)
            .select("ps.id", "ps.property_id", "ps.service_address_line1", "ps.service_address_line2", "ps.service_address_city", "ps.service_address_zip");
          trapPrior = priorRows.find((r) => inPremise(r)) || null;
          const laterRows = await db("scheduled_services as fs")
            .leftJoin("services as fsv", "fs.service_id", "fsv.id")
            .where("fs.customer_id", customerId)
            .where("fs.id", "!=", svc.id)
            .where("fs.scheduled_date", ">", anchorStr)
            .where("fs.scheduled_date", "<=", ceilStr)
            .whereIn("fsv.service_key", seriesKeys)
            .select("fs.id", "fs.status", "fs.property_id", "fs.scheduled_date", "fs.window_start", "fs.created_at", "fs.service_address_line1", "fs.service_address_line2", "fs.service_address_city", "fs.service_address_zip");
          // Same-day siblings (codex #3243 r5 P2: trap setup + same-day
          // capture/removal) are invisible to the date-only comparisons —
          // order them by appointment window (then created_at); an
          // indeterminate order contributes nothing.
          const sameDayRows = await db("scheduled_services as ds")
            .leftJoin("services as dsv", "ds.service_id", "dsv.id")
            .where("ds.customer_id", customerId)
            .where("ds.id", "!=", svc.id)
            .where("ds.scheduled_date", anchorStr)
            .whereIn("dsv.service_key", seriesKeys)
            .select("ds.id", "ds.status", "ds.property_id", "ds.scheduled_date", "ds.service_address_line1", "ds.service_address_line2", "ds.service_address_city", "ds.service_address_zip", "ds.window_start", "ds.created_at");
          const sameDayInPremise = sameDayRows.filter((r) => inPremise(r));
          if (!trapPrior) {
            trapPrior = sameDayInPremise.find(
              (r) => r.status === "completed" && compareSameDayVisits(r, svc) < 0,
            ) || null;
          }
          const laterInPremise = [
            ...laterRows.filter((r) => inPremise(r)),
            ...sameDayInPremise.filter((r) => compareSameDayVisits(r, svc) > 0),
          ].filter((r) => !FOLLOWUP_CHILD_INACTIVE_STATUSES.includes(r.status));
          // A later DECLARED initial is a series boundary, not evidence
          // this series continues (codex #3243 r13 P2): a payment-deferred
          // old final must not read the new program's opener as its own
          // later visit. The boundary visit and everything at/after it are
          // the NEW series.
          const laterFlags = new Map();
          for (const r of laterInPremise) {
            laterFlags.set(r.id, await this._isDeclaredInitialTrapVisit({ scheduledServiceId: r.id }));
          }
          let boundedLater = laterInPremise;
          const laterDeclared = laterInPremise.filter((r) => laterFlags.get(r.id));
          if (laterDeclared.length) {
            const earliestBoundary = laterDeclared.reduce((a, b) => (
              etDayWindow(a.scheduled_date, 0).anchorStr <= etDayWindow(b.scheduled_date, 0).anchorStr ? a : b));
            const bDay = etDayWindow(earliestBoundary.scheduled_date, 0).anchorStr;
            boundedLater = laterInPremise.filter((r) => {
              if (r.id === earliestBoundary.id) return false;
              const day = etDayWindow(r.scheduled_date, 0).anchorStr;
              if (day < bDay) return true;
              return day === bDay && compareSameDayVisits(r, earliestBoundary) < 0;
            });
          }
          trapLaterLive = boundedLater.find((r) => r.status !== "completed") || null;
          trapLaterCompleted = boundedLater.find((r) => r.status === "completed") || null;
          // A technician-declared initial setup outranks history inference
          // AND structural linkage (codex #3243 r10 P2 + r12 P2): a new
          // program starting inside the window of an old one — even one
          // wrongly linked to it — must not inherit its position.
          // trap_visit_type is REQUIRED on rodent_trapping reports and
          // frozen into the typed report snapshot.
          visitDeclaredInitial = await this._isDeclaredInitialTrapVisit({ serviceRecordId, scheduledServiceId: svc.id });
          if (trapPrior && visitDeclaredInitial) {
            trapPrior = null;
          }
          // Series engagement, computed ONCE for every path that can
          // classify this visit final (codex #3243 r12 P1: linked finals
          // returned before the unlinked branch's check ran): a customer
          // who already responded to the series' first ask — private
          // rating, submit, or Google click — must not get three more
          // asks. Separate simple queries by design (no OR groups).
          if (trapPrior || svc.parent_service_id || svc.followup_source_service_id) {
            // strict: a swallowed walk failure here would read as "not
            // engaged" and over-send (codex #3243 r13 P1) — propagate to
            // the resolver's retry/plan_resolution_failed path instead.
            const seriesIds = await this._seriesExemptSequenceIds(customerId, { serviceRecordId, scheduledServiceId: svc.id, strict: true });
            if (seriesIds.length) {
              const engaged = (await db("review_sequences").whereIn("id", seriesIds).whereIn("stop_reason", ["responded", "clicked"]).first())
                || (await db("review_requests").whereIn("sequence_id", seriesIds).whereIn("status", ["submitted", "reviewed", "rated"]).first())
                || (await db("review_requests").whereIn("sequence_id", seriesIds).whereNotNull("redirected_at").first())
                || (await db("review_requests").whereIn("sequence_id", seriesIds).whereNotNull("rated_at").first())
                || (await db("review_requests").whereIn("sequence_id", seriesIds).where({ google_review_clicked: true }).first())
                // A NON-PROMOTER draft tap — score + category without a
                // submit — is engagement too (codex #3243 r13 P1; mirrors
                // the step runner's own lowDraft predicate).
                || (await db("review_requests").whereIn("sequence_id", seriesIds).whereNotNull("score").whereNot("category", "promoter").first());
              trapEngaged = !!engaged;
            }
          }
        }
        // A declared initial never reads as a follow-up child — stale or
        // cross-service linkage must not demote the opener to middle/final
        // (codex #3243 r12 P2). Non-trapping visits are unaffected.
        const isFollowUpChild = !visitDeclaredInitial && !!(svc.parent_service_id || svc.followup_source_service_id);

        if (liveChild) {
          // Another treatment in this series is still on the books. An
          // unlinked earlier line visit already carried the first ask
          // (codex #3243 r3 P1) — a linked child alone doesn't make this
          // the series opener.
          return isFollowUpChild || trapPrior
            ? { skip: "multi_treatment_middle" }
            : { plan: OUTREACH.MULTI_TREATMENT_FIRST_PLAN };
        }
        if (anyChild) {
          // Only COMPLETED children remain: the series moved past this visit
          // and the final visit carried (or will carry) the cadence — a late
          // enrollment here would just be an extra ask.
          return { skip: "series_completed" };
        }
        if (isFollowUpChild) {
          // Structurally the follow-up visit with nothing LINKED further —
          // but an unlinked later line visit still means the program is
          // ongoing (booked → middle) or already finished past this visit
          // (completed → the final carried the cadence).
          if (trapLaterLive) return { skip: "multi_treatment_middle" };
          if (trapLaterCompleted) return { skip: "series_completed" };
          // Engagement on the series' earlier asks stands the final down
          // here too (codex #3243 r12 P1 — linked finals bypassed the
          // unlinked branch's check).
          if (trapEngaged) return { skip: "series_engaged" };
          // The series is done; run the full cadence with the series-final
          // cap/cooldown exemption.
          return { plan: OUTREACH.DEFAULT_SEQUENCE_PLAN, seriesFinal: true };
        }
        if (isTrappingSeries) {
          // Unlinked trapping position from line history (owner spec: one
          // ask after treatment 1, the 3-touch cadence after the final).
          // With a prior behind it, ANY non-dead later visit makes this a
          // middle check ('completed' counts: a late-paid middle enrollment
          // must not fire the cadence the real final carries). Without a
          // prior (payment-deferred FIRST visit), only a later COMPLETED
          // visit stands the ask down — a merely-booked later check keeps
          // the owner-spec first ask.
          if (trapPrior && (trapLaterLive || trapLaterCompleted)) return { skip: "multi_treatment_middle" };
          if (!trapPrior && trapLaterCompleted) return { skip: "series_completed" };
          // Opener engagement stands the final cadence down (codex #3243
          // r11 P1) — computed once in the hoisted block.
          if (trapPrior && trapEngaged) return { skip: "series_engaged" };
          return trapPrior
            ? { plan: OUTREACH.DEFAULT_SEQUENCE_PLAN, seriesFinal: true }
            : { plan: OUTREACH.MULTI_TREATMENT_FIRST_PLAN };
        }
        if (TWO_TREATMENT_PACKAGE_KEYS.has(svc.service_key)) {
          // Named two-treatment package with no child linkage — position in
          // the series comes from history: a completed same-service visit in
          // the window makes THIS the follow-up treatment (owner spec:
          // "the 3 after 2nd treatment"); none makes it the first.
          // Anchored to the COMPLETED VISIT's date, earlier visits only
          // (codex #3235 r10 P1): a payment-deferred enrollment runs at
          // payment time, so a now-relative window let a LATER treatment
          // make an earlier visit look final (and a late-paid final visit
          // look first).
          // Window = 2x the catalog's follow-up interval (fallback 30d),
          // not a flat 60d (codex #3235 r11 P1): a NEW package started 60
          // days after the previous one must not read as its follow-up —
          // real roach/bed-bug follow-ups run ~14 days.
          const intervalDays = Number(svc.follow_up_interval_days) > 0 ? Number(svc.follow_up_interval_days) : 15;
          const windowDays = Math.min(60, intervalDays * 2);
          const { anchorStr, floorStr: windowFloor } = etDayWindow(svc.scheduled_date, windowDays);
          const prior = await db("scheduled_services")
            .where({ customer_id: customerId, service_id: svc.service_id, status: "completed" })
            .where("id", "!=", svc.id)
            .where("scheduled_date", "<", anchorStr)
            .where("scheduled_date", ">=", windowFloor)
            .first();
          return prior
            ? { plan: OUTREACH.DEFAULT_SEQUENCE_PLAN, seriesFinal: true }
            : { plan: OUTREACH.MULTI_TREATMENT_FIRST_PLAN };
        }
        if (svc.is_recurring === true) {
          return { plan: OUTREACH.RECURRING_SEQUENCE_PLAN };
        }
      }

      // No visit link (or a non-recurring visit): a customer with LIVE
      // recurring coverage still gets the single-ask treatment — the
      // relationship is ongoing, so asks spread across visits instead of
      // bursting (same live-coverage shape as reserviceLanesForCustomer,
      // but family-agnostic: mosquito/termite plans are recurring too).
      const { TERMINAL_STATUSES } = require("./waveguard-existing-services");
      const liveRecurring = await db("scheduled_services")
        .where({ customer_id: customerId, is_recurring: true })
        // IS DISTINCT FROM, not != — legacy rows carry NULL is_callback and
        // `whereNot(col, true)` would drop them with it.
        .whereRaw("is_callback IS DISTINCT FROM true")
        .whereNotIn("status", TERMINAL_STATUSES)
        .where("scheduled_date", ">=", etDateString())
        .first();
      if (liveRecurring) return { plan: OUTREACH.RECURRING_SEQUENCE_PLAN };

      return { plan: OUTREACH.DEFAULT_SEQUENCE_PLAN };
    } catch (err) {
      // Explicit failure (codex #3235 r10 P1): defaulting here made a
      // transient lookup error indistinguishable from a real one-time
      // classification — dropping seriesFinal at final-treatment enrollment
      // (cooldown rejection) or overwriting a correct persisted plan at the
      // first-send re-resolve. Callers decide: enrollment skips (the
      // invoice-paid trigger naturally retries), the runner keeps the
      // enrolled plan.
      // One internal retry (codex #3235 r11 P1): the paid-invoice trigger
      // is one-shot — the processed webhook never re-fires — so a transient
      // blip here would otherwise permanently lose the deferred cadence.
      if (_attempt < 1) {
        await new Promise((r) => setTimeout(r, 250));
        return this.resolveSequencePlanForEnrollment({ customerId, serviceRecordId, scheduledServiceId, _attempt: _attempt + 1 });
      }
      logger.warn(`[review] plan resolution failed (customerId=${customerId}): ${err.message}`);
      return { error: true };
    }
  },

  /**
   * Post-service enrollment — the single entry point every "service is done,
   * ask for a review" trigger (dispatch completion, schedule completion,
   * invoice send/paid, Stripe paid webhook) funnels through.
   *
   * GATE_REVIEW_SEQUENCES on  → start the multi-touch cadence (Day 0 SMS at
   *   the smart send window → Day 3 weekday SMS → Day 4 email). Idempotent
   *   per customer (one active sequence), capped 3 asks / rolling 180 days,
   *   30-day cooldown, all the per-customer suppressions.
   * GATE_REVIEW_SEQUENCES off → the legacy single scheduled ask
   *   (ReviewService.create), byte-for-byte the pre-rollout behavior.
   *
   * Never throws — auto callers (webhooks, completion flows) must not fail
   * their own transaction over a review ask.
   */
  async enrollPostService({
    customerId,
    serviceRecordId = null,
    scheduledServiceId = null,
    serviceType = null,
    serviceDate = null,
    techName = null,
    technicianId = null,
    completedAt = null,
    // delayMinutes = an EXPLICIT operator/config choice (completion panel
    // timing selector, invoice scheduled_review_delay_minutes) — honored in
    // BOTH modes. legacyDelayMinutes = a caller's historical hardcoded
    // default — applied only on the legacy path so cadence mode can use the
    // smart send window instead (Codex P2, r2).
    delayMinutes,
    legacyDelayMinutes,
    triggeredBy = "auto",
  }) {
    const { isEnabled } = require("../config/feature-gates");
    if (!isEnabled("reviewSequences")) {
      return this.create({
        customerId,
        serviceRecordId,
        triggeredBy,
        delayMinutes: delayMinutes !== undefined && delayMinutes !== null ? delayMinutes : legacyDelayMinutes,
        techName,
        serviceType,
        serviceDate,
        technicianId,
      });
    }
    try {
      let svcType = serviceType;
      let tName = techName;
      if ((!svcType || !tName) && serviceRecordId) {
        const sr = await db("service_records")
          .where({ "service_records.id": serviceRecordId })
          .leftJoin("technicians", "service_records.technician_id", "technicians.id")
          .select("service_records.service_type", "technicians.name as tech_name")
          .first()
          .catch(() => null);
        svcType = svcType || sr?.service_type || null;
        tName = tName || sr?.tech_name || null;
      }
      // Owner already asked this customer by hand → the cadence stands down.
      if (await this.manualReviewAskSentRecently(customerId)) {
        logger.info(`[review] Post-service cadence skipped (customerId=${customerId} reason=manual_ask_recent)`);
        return { started: false, reason: "manual_ask_recent" };
      }
      // Per-type cadence plan (owner spec 2026-08-05): recurring = one ask,
      // one-time = full cadence, multi-treatment = one after the first visit
      // then the cadence after the final one (middle visits send nothing).
      const resolved = await this.resolveSequencePlanForEnrollment({ customerId, serviceRecordId, scheduledServiceId });
      if (resolved.error) {
        // Fail toward FEWER sends: enrolling on a guessed plan risks a
        // 3-touch cadence where one ask (or none) was owed. The payment/
        // completion triggers re-attempt enrollment naturally.
        logger.warn(`[review] Post-service cadence skipped (customerId=${customerId} reason=plan_resolution_failed)`);
        return { started: false, reason: "plan_resolution_failed" };
      }
      if (resolved.skip) {
        logger.info(`[review] Post-service cadence skipped (customerId=${customerId} reason=${resolved.skip})`);
        return { started: false, reason: resolved.skip };
      }
      // An explicit timing choice (completion panel "Now"/"Tomorrow 8 AM"/
      // custom, invoice scheduled minutes) wins over the smart send window —
      // the operator's selection must not be silently ignored in cadence
      // mode (Codex P2, r2). 0 = "Now" → first cron tick.
      const explicitDelay = Number(delayMinutes);
      const firstTouchAt = delayMinutes !== undefined && delayMinutes !== null && Number.isFinite(explicitDelay)
        ? new Date(Date.now() + Math.max(0, explicitDelay) * 60000)
        : calculateReviewSendTime(
          completedAt ? new Date(completedAt) : new Date(),
          svcType,
        );
      const result = await this.startReviewSequence({
        customerId,
        serviceRecordId,
        scheduledServiceId,
        serviceType: svcType,
        techName: tName,
        startedBy: "post_service",
        firstTouchAt,
        plan: resolved.plan,
        seriesFinal: resolved.seriesFinal === true,
      });
      if (result?.started) {
        logger.info(
          `[review] Post-service cadence enrolled (customerId=${customerId} sequenceId=${result.sequence?.id} firstTouch=${firstTouchAt.toISOString()})`,
        );
      } else {
        logger.info(
          `[review] Post-service cadence skipped (customerId=${customerId} reason=${result?.reason || "unknown"})`,
        );
      }
      return result;
    } catch (err) {
      logger.error(`[review] Post-service cadence enroll failed (customerId=${customerId} errType=${err?.name || "Error"}): ${err.message}`);
      return { started: false, reason: "error" };
    }
  },

  /**
   * Post-PAYMENT enrollment for a COMPLETION invoice (has service_record_id)
   * whose review ask was deferred at delivery (unpaid-invoice hold). Shared
   * by the Stripe paid webhook and the admin record-payment path so an
   * off-Stripe settlement (cash/check/Zelle) still triggers the ask
   * (Codex P2, r2). Honors the completion's stored requestReview intent and
   * visit outcome. Standalone invoices are NOT handled here — they enrolled
   * at delivery. Never throws.
   */
  async enrollForPaidInvoice(invoice, { source = "invoice_paid" } = {}) {
    try {
      if (!invoice?.customer_id || !invoice?.service_record_id) {
        return { enrolled: false, reason: "not_completion_invoice" };
      }
      const label = invoice.invoice_number || invoice.id;
      const serviceRecord = await db("service_records")
        .where({ id: invoice.service_record_id })
        .select("structured_notes")
        .first();
      let notes = serviceRecord?.structured_notes || {};
      if (typeof notes === "string") {
        try { notes = JSON.parse(notes); } catch { notes = {}; }
      }
      if (notes.requestReview === false) {
        logger.info(`[review] Skipping paid-invoice review request for invoice ${label} (${source}): completion opted out`);
        return { enrolled: false, reason: "completion_opted_out" };
      }
      if (notes.visitOutcome && notes.visitOutcome !== "completed") {
        logger.info(`[review] Skipping paid-invoice review request for invoice ${label} (${source}): visit outcome ${notes.visitOutcome}`);
        return { enrolled: false, reason: "visit_outcome" };
      }
      // The completion panel's explicit timing selection (Now / Tomorrow 8 AM
      // / custom) is persisted on the service record — honor it through the
      // payment deferral instead of silently reverting to the default
      // (Codex P2, r3). An absolute time already elapsed sends immediately.
      let delayMinutes;
      // reviewScheduledFor is the TIMEZONE-LESS Eastern wall-clock string the
      // completion panel posts — new Date() on a UTC server would read it
      // 4-5h early (Codex P1, r5). Parse naive strings as ET, same as the
      // completion validation; an explicit offset/Z (defensive) parses as-is.
      let storedAt = null;
      if (notes.reviewScheduledFor) {
        const raw = String(notes.reviewScheduledFor);
        storedAt = /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? new Date(raw) : parseETDateTime(raw);
      }
      if (storedAt && !Number.isNaN(storedAt.getTime())) {
        delayMinutes = Math.max(0, Math.round((storedAt.getTime() - Date.now()) / 60000));
      } else if (notes.reviewDelayMinutes != null && Number.isFinite(Number(notes.reviewDelayMinutes))) {
        delayMinutes = Math.max(0, Number(notes.reviewDelayMinutes));
      }
      // Legacy create() dedupes by service_record_id; the cadence path
      // dedupes per service record too (startReviewSequence) on top of the
      // active-sequence + cap/cooldown guards — safe under webhook retries
      // and double-clicked payment forms alike.
      const result = await this.enrollPostService({
        customerId: invoice.customer_id,
        serviceRecordId: invoice.service_record_id,
        triggeredBy: "auto",
        delayMinutes,
        legacyDelayMinutes: 120,
      });
      // Honest outcome (codex #3235 r11 P1): the paid webhook is one-shot,
      // so a swallowed plan_resolution_failed here would silently lose the
      // deferred ask — after the resolver's internal retry, surface it loud.
      if (result?.started === false && result?.reason === "plan_resolution_failed") {
        logger.error(`[review] Paid-invoice enrollment LOST to plan-resolution failure after retry (invoiceId=${invoice?.id} source=${source}) — enroll manually from the reviews admin if the ask is still wanted`);
        return { enrolled: false, reason: "plan_resolution_failed", result };
      }
      return { enrolled: true, result };
    } catch (err) {
      logger.error(`[review] Paid-invoice enrollment failed (invoiceId=${invoice?.id} source=${source}): ${err.message}`);
      return { enrolled: false, reason: "error" };
    }
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
    const { getServiceContactSmsRecipient } = require("./customer-contact");
    const contact = getServiceContactSmsRecipient(customer);
    if (!contact.phone) {
      // No consented SMS recipient (e.g. unstamped contact phone and no
      // primary phone): mark the row so the scheduler's 20-row batch can't
      // be starved by the same unsendable rows every run (#2955 r3).
      await db("review_requests").where({ id: requestId }).update({ status: "suppressed" }).catch(() => {});
      logger.info(`[review] Suppressed request (requestId=${requestId} reason=no-consented-sms-recipient)`);
      return;
    }

    const reviewUrl = await buildReviewUrl(request, customer.id);
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
        const url = await buildReviewUrl(existing, customerId);
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

    const url = await buildReviewUrl(request, customerId);
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
    // Finality is cross-surface: the newer /api/rate flow marks completion
    // with status='submitted' (and this path with rated_at) — honor BOTH so
    // a submitted request can't be re-used through the legacy endpoint, and
    // honor expiry the same way /api/rate does.
    if (request.rated_at || ["submitted", "reviewed", "rated"].includes(request.status)) {
      throw new Error("Already rated");
    }
    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      throw new Error("Review link expired");
    }

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

    // Atomic claim: the check above is check-then-update, so two concurrent
    // submissions could both pass it and double-fire the SMS/referral/
    // activity side effects. Gate the write on the same finality predicate
    // (NULL-safe — legacy rows may carry a NULL status) and stop when
    // another submission won the race.
    const claimed = await db("review_requests")
      .where({ id: request.id })
      .whereNull("rated_at")
      .where(function notFinal() {
        this.whereNull("status").orWhereNotIn("status", ["submitted", "reviewed", "rated"]);
      })
      .update(updates);
    if (!claimed) throw new Error("Already rated");

    // Referral invite on the warmest moment we have (owner trigger call
    // 2026-07-06): a promoter-grade rating just came in. Fire-and-forget
    // and once-per-customer-ever (the helper's idempotency key is
    // customer-scoped), so repeat promoters aren't re-invited.
    if (isPromoter && request.customer_id) {
      const { sendReferralInviteEmail } = require('./referral-invite-email');
      void sendReferralInviteEmail({ customerId: request.customer_id, trigger: 'positive_review' });
    }

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
      // recordHealth: false — per-customer mutual-exclusion lock, not a
      // scheduled job; recording it would grow job_health per customer.
      await runExclusive(`review-send:${request.customer_id}`, () => this.sendSMS(request.id), { recordHealth: false });
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
    const { getServiceContactSmsRecipient } = require("./customer-contact");
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
      const contact = getServiceContactSmsRecipient(customer);
      if (!contact.phone) {
        // No consented SMS recipient — mark handled so this row can't sit
        // in the 20-row follow-up batch every run and starve later
        // customers (#2955 r4). Mirrors the scheduled-send suppression.
        await db("review_requests").where({ id: request.id }).update({ followup_sent: true, followup_sent_at: new Date() }).catch(() => {});
        suppressed++;
        continue;
      }

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
    technicianId = null,
    serviceRecordId = null,
    scheduledServiceId = null,
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

    // Cadence steps carry only serviceRecordId — recover the visit context the
    // legacy create() path preserves (technician_id drives the rate page's
    // tech photo, service_date the visit line; Codex P2, r1). Best-effort: a
    // lookup failure just sends without them.
    if (serviceRecordId && (!technicianId || !serviceDate || !techName || !serviceType)) {
      try {
        const sr = await db("service_records")
          .where({ "service_records.id": serviceRecordId })
          .leftJoin("technicians", "service_records.technician_id", "technicians.id")
          .select(
            "service_records.service_type",
            "service_records.service_date",
            "service_records.technician_id",
            "service_records.scheduled_service_id",
            "technicians.name as tech_name",
          )
          .first();
        if (sr) {
          technicianId = technicianId || sr.technician_id || null;
          serviceDate = serviceDate || sr.service_date || null;
          techName = techName || sr.tech_name || null;
          serviceType = serviceType || sr.service_type || null;
          // Same fallback as create(): legacy rows without a technician on the
          // service record inherit the assigned tech from the linked visit.
          if (!technicianId && sr.scheduled_service_id) {
            const ss = await db("scheduled_services")
              .where({ "scheduled_services.id": sr.scheduled_service_id })
              .leftJoin("technicians", "scheduled_services.technician_id", "technicians.id")
              .select("scheduled_services.technician_id", "technicians.name as tech_name")
              .first();
            if (ss?.technician_id) {
              technicianId = ss.technician_id;
              techName = techName || ss.tech_name || null;
            }
          }
        }
      } catch (err) {
        logger.warn(`[review] outreach visit-context recovery failed (serviceRecordId=${serviceRecordId}): ${err.message}`);
      }
    }
    // Record-less sequences (admin-schedule completion before the
    // service_records row exists) recover date/tech from the persisted visit
    // id instead (codex #3235 r8 P2) — without it a post-midnight smart send
    // would draft "today"/"just finished" copy the next morning.
    if (scheduledServiceId && (!serviceDate || !technicianId || !serviceType)) {
      try {
        const ss = await db("scheduled_services")
          .where({ "scheduled_services.id": scheduledServiceId })
          .leftJoin("technicians", "scheduled_services.technician_id", "technicians.id")
          .select(
            "scheduled_services.service_type",
            "scheduled_services.scheduled_date",
            "scheduled_services.technician_id",
            "technicians.name as tech_name",
          )
          .first();
        if (ss) {
          serviceDate = serviceDate || ss.scheduled_date || null;
          serviceType = serviceType || ss.service_type || null;
          technicianId = technicianId || ss.technician_id || null;
          techName = techName || ss.tech_name || null;
        }
      } catch (err) {
        logger.warn(`[review] outreach visit-context recovery failed (scheduledServiceId=${scheduledServiceId}): ${err.message}`);
      }
    }

    // SMS identity is consent-gated; EMAIL identity is not (the #2948
    // artifact covers texting only) — resolve them separately so an
    // unstamped contact still gets the email touch as themselves.
    const { getServiceContact, getServiceContactSmsRecipient } = require("./customer-contact");
    const contact = getServiceContactSmsRecipient(customer);
    const emailContact = getServiceContact(customer);

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
    const canEmail = !!emailContact.email && !!prefs && !emailBlocked && !prefsLookupFailed;

    // A no-link private check-in (resolution_check / satisfaction_confirm) must
    // NEVER route to email — the only email template is review_request_email,
    // which carries a /rate link, so an email fallback would turn a recovery
    // message into a review ask (and bypass the cap, since send-request didn't
    // count it). Keep these SMS-only, ignoring the email channel preference.
    const noLinkSend = !!(templateId && OUTREACH.NO_LINK_TEMPLATE_KEYS.includes(templateId));

    // Per-type channel preference. Only 'email' is treated as an EXCLUSIVE
    // choice (it is never the column default, so it's deliberate): an 'email'
    // preference must not fall back to SMS. 'sms' is the backfill DEFAULT, so it
    // is NOT a deliberate opt-out — it must keep the email fallback / Day-4 email
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
    // (custom_body) so a provider retry re-sends the operator's copy
    // rather than reverting to the template.
    const smsTemplateId = templateId || (customBody && customBody.trim() ? null : "friendly_ask");
    let recordedTemplateKey = actualChannel === "email" ? "review_request_email" : smsTemplateId || "custom";
    let persistedBody = actualChannel === "sms" && customBody && customBody.trim() ? customBody : null;

    // Personalized ask body (GATE_REVIEW_ASK_PERSONALIZED): CADENCE SMS ask
    // touches only (sequenceId required — a CSR's one-off send keeps exactly
    // the template they picked; Codex P1, r1). Operator-provided copy always
    // wins; private no-link check-ins and email touches keep their templates.
    // A null draft (gate off, no grounding, model down, failed verification,
    // or a recipient who isn't the account holder) falls through to the
    // template.
    if (actualChannel === "sms" && !persistedBody && !noLinkSend && sequenceId != null) {
      // Identity guard (Codex P1, r1): the SMS goes to the RESOLVED service
      // contact. The account's call/SMS history only belongs to the account
      // holder — when the recipient is someone else (tenant, buyer, realtor),
      // skip drafting entirely so their message can't carry the account
      // holder's name or private conversation details. Checked BEFORE retry
      // reuse: a draft persisted for the account holder must not be re-sent
      // to a recipient who changed between attempts (Codex P1, r2).
      const recipientIsAccountHolder = !!(contact.phone && customer.phone
        && (toE164(contact.phone) || contact.phone) === (toE164(customer.phone) || customer.phone));

      // Retry reuse: a deferred/transiently-failed step re-enters here with no
      // customBody — reuse the draft already persisted for this exact step so
      // one touch can never send two different drafts (Codex P2, r1).
      if (recipientIsAccountHolder) {
        try {
          const prior = await db("review_requests")
            // Channel-scoped (codex #3235 r1 P2): a step that flipped
            // email→SMS between attempts must not resend the email intro
            // (no {review_url}, wrong shape) as the SMS body.
            .where({ sequence_id: sequenceId, sequence_step: sequenceStep, channel: "sms" })
            .whereNotNull("custom_body")
            .orderBy("created_at", "desc")
            .first();
          if (prior?.custom_body) persistedBody = prior.custom_body;
        } catch { /* reuse is best-effort; a fresh draft is still verified */ }
      }

      if (!persistedBody && recipientIsAccountHolder) {
        const drafted = await require("./review-ask-drafter").draftAskBody({
          customer,
          recipientFirstName: firstNameFrom(contact.name) || customer.first_name || "",
          serviceType,
          techName,
          sequenceStep,
          serviceDate,
        });
        if (drafted) persistedBody = drafted;
      }
      // Analytics provenance (Codex P1, r1): personalized touches must not be
      // credited to the control template — the outreach funnel groups by
      // template_key, so a gated rollout is only measurable with a distinct
      // variant key. Body resolution is unaffected (custom_body wins first;
      // _sendOutreachSms renders from the real templateId param).
      if (persistedBody) {
        recordedTemplateKey = `${smsTemplateId || "custom"}_personalized`;
      }
    }

    // Personalized EMAIL intro (same gate; owner 2026-08-05 — the email is
    // the touch that actually converted, so it gets the grounded opener too).
    // Cadence touches only, and only when the resolved email recipient IS the
    // account holder (same identity guard as SMS: the account's history must
    // not leak into a tenant/realtor's inbox). The drafted paragraph is
    // persisted on custom_body for retry reuse; the CTA button still carries
    // the tokenized link — the paragraph never does. Only when the ACTIVE
    // template version actually renders {{intro_paragraph}} (codex #3235 r6
    // P2): an operator-edited/republished version without the variable would
    // silently ignore the draft — paying for the LLM call and crediting
    // control copy to the personalized variant.
    if (actualChannel === "email" && !persistedBody && sequenceId != null
      && await this._emailIntroVariableActive()) {
      const recipientIsAccountHolder = !!(emailContact?.email && customer.email
        && String(emailContact.email).trim().toLowerCase() === String(customer.email).trim().toLowerCase());
      if (recipientIsAccountHolder) {
        try {
          const prior = await db("review_requests")
            // Channel-scoped (codex #3235 r1 P2): a step that flipped
            // SMS→email between attempts must not inject the persisted SMS
            // draft — its single-brace {review_url} placeholder would render
            // literally in the email paragraph.
            .where({ sequence_id: sequenceId, sequence_step: sequenceStep, channel: "email" })
            .whereNotNull("custom_body")
            .orderBy("created_at", "desc")
            .first();
          if (prior?.custom_body) persistedBody = prior.custom_body;
        } catch { /* reuse is best-effort; a fresh draft is still verified */ }
        if (!persistedBody) {
          const drafted = await require("./review-ask-drafter").draftEmailIntro({
            customer,
            recipientFirstName: firstNameFrom(emailContact.name) || customer.first_name || "",
            serviceType,
            techName,
            sequenceStep,
            serviceDate,
          });
          if (drafted) persistedBody = drafted;
        }
        if (persistedBody) {
          recordedTemplateKey = "review_request_email_personalized";
        }
      }
    }

    // Cap-exempt provenance survives the email fallback (codex #3235 r1 P1):
    // an email-only/email-preferred customer's FIRST-TREATMENT ask resolves
    // to email — recorded as a review_request_email* key it would count
    // toward the cap/cooldown and deterministically block the final-visit
    // cadence. Record it under first_treatment_ask_email* instead (both
    // listed in CAP_EXEMPT_TEMPLATE_KEYS; ASK_TOUCH_SQL still counts them
    // as asks for the funnel and supersede guards).
    if (actualChannel === "email" && templateId && OUTREACH.CAP_EXEMPT_TEMPLATE_KEYS.includes(templateId) && !noLinkSend) {
      recordedTemplateKey = persistedBody ? `${templateId}_email_personalized` : `${templateId}_email`;
    }

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
        technician_id: technicianId || null,
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
        // Sequence touches, no-link check-ins AND one-ask-by-design templates
        // (first_treatment_ask sent manually — codex #3235 r12 P1) skip the
        // legacy Day-3 followup.
        followup_sent: sequenceId || isNoLinkSms || (templateId && OUTREACH.CAP_EXEMPT_TEMPLATE_KEYS.includes(templateId)) ? true : false,
        expires_at: expiresAt || new Date(Date.now() + 14 * 86400000).toISOString(),
      })
      .returning("*");

    const reviewUrl = await buildReviewUrl(request, customer.id);

    const vars = {
      first: firstNameFrom(contact.name) || customer.first_name || "",
      // First name only (codex #3235 r2 P2): a full technician name blows the
      // one-segment budget on the {tech}-bearing templates, and the customer
      // knows the tech by first name anyway.
      tech: firstNameFrom(techName) || "Adam",
      service_type: serviceType || "service",
      review_url: reviewUrl,
    };

    if (actualChannel === "email") {
      return this._sendOutreachEmail({ request, customer, contact: emailContact, reviewUrl, techName, manageRetryVia, introParagraph: persistedBody });
    }
    return this._sendOutreachSms({ request, customer, contact, vars, templateId: smsTemplateId, customBody: persistedBody ?? customBody, manageRetryVia });
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

    // Segment observability (codex #3235 r3): the one-segment contract is
    // enforced on template copy and drafter output against the SHORT link;
    // when the shortener degrades, shortenOrPassthrough falls back to the
    // full tokenized URL (~112 GSM chars) and a second segment is the
    // deliberate trade — no ask copy fits one segment around that URL, and
    // dropping the ask or the link would cost more than the extra segment.
    // Log it so a shortener outage is visible instead of silent spend.
    try {
      const { countSegments } = require("./messaging/segment-counter");
      const seg = countSegments(require("./messaging/gsm-normalize").normalizeGsmPunctuation(body));
      if (seg.segmentCount > 1) {
        logger.warn(`[review] outreach SMS rendered to ${seg.segmentCount} segments (requestId=${request.id} template=${request.template_key || "custom"}) — likely short-url fallback`);
      }
    } catch { /* observability only */ }

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
      // result (rate-limit / transient provider failure) has
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

  async _sendOutreachEmail({ request, customer, contact, reviewUrl, techName, manageRetryVia, introParagraph = null }) {
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
          // The template's opening paragraph is {{intro_paragraph}} — the
          // personalized draft when one verified, else the canonical generic
          // copy. Always supplied: a missing variable renders an empty
          // paragraph, never literal braces, but the email would read bare.
          intro_paragraph: introParagraph || GENERIC_EMAIL_INTRO,
        },
        recipientType: "customer",
        recipientId: customer.id,
        // Stable per sequence STEP (not per touch row): a sequence retry inserts
        // a fresh review_requests row, so a request.id-based key would change
        // each retry and bypass the email library's dedupe — re-sending the same
        // Day-4 email if a prior attempt was accepted but then threw.
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
  async startReviewSequence({ customerId, plan, startedBy, locationId, serviceType, techName, serviceRecordId, scheduledServiceId = null, firstTouchAt = null, seriesFinal = false }) {
    const customer = await db("customers").where({ id: customerId }).first();
    if (!customer) throw new Error("Customer not found");
    if (customer.deleted_at) throw new Error("Customer is archived");
    if (customer.has_left_google_review) return { started: false, reason: "already_reviewed" };

    let supersedeOpenerId = null;
    const active = await db("review_sequences").where({ customer_id: customerId, status: "active" }).first();
    if (active) {
      // A zero-sent series opener yields to its own series' FINAL enrollment
      // (codex #3243 r7 P1): daily trapping checks can complete the final
      // before the opener's smart-window ask ever sends — rejecting here
      // left the opener to stop itself as series_completed at send time, so
      // NEITHER ask went out and nothing re-enrolled the final. Supersede
      // ONLY when the active sequence provably belongs to this enrollment's
      // series (the exemption walk) and has delivered nothing; any error
      // falls back to the reject (never risks a duplicate ask).
      // Proof only here — the actual stop commits atomically WITH the
      // replacement insert below (codex #3243 r9 P2): stopping up front let
      // any later enrollment failure strand the customer with the opener
      // dead and no final cadence.
      if (seriesFinal) {
        try {
          const seriesIds = await this._seriesExemptSequenceIds(customerId, { serviceRecordId, scheduledServiceId });
          if (seriesIds.includes(active.id)) {
            const delivered = await db("review_requests")
              .where({ sequence_id: active.id, status: "sent" })
              .first();
            if (!delivered) supersedeOpenerId = active.id;
          }
        } catch (err) {
          logger.warn(`[review] opener-supersede check failed (customerId=${customerId}): ${err.message} — keeping already_active`);
        }
      }
      if (!supersedeOpenerId) return { started: false, reason: "already_active", sequence: active };
    }

    // One cadence per SERVICE RECORD, ever (codex #3235 r3 P1): the legacy
    // create() deduped by service_record_id, and the cadence path used to be
    // implicitly safe via the cap — but the cap-exempt first-treatment ask
    // broke that: its one-step sequence completes on send, so a second
    // enrollment for the same visit (completion first, paid-invoice webhook
    // later) would re-send the identical ask. start_failed rows may retry.
    // Fail CLOSED — a lookup error must not risk a duplicate text.
    if (serviceRecordId) {
      const priorForRecord = await db("review_sequences")
        .where({ service_record_id: serviceRecordId })
        .whereRaw("stop_reason IS DISTINCT FROM 'start_failed'")
        .first();
      if (priorForRecord) {
        return { started: false, reason: "service_record_enrolled", sequence: priorForRecord };
      }
    }
    // Record-less enrollments dedupe by the persisted visit id (codex #3235
    // r10 P2): the admin-schedule path can complete a visit before its
    // service_records row exists, and a completion retry after the cooldown
    // would otherwise re-send the identical one-step ask for the same visit.
    if (scheduledServiceId) {
      const priorForVisit = await db("review_sequences")
        .where({ scheduled_service_id: scheduledServiceId })
        .whereRaw("stop_reason IS DISTINCT FROM 'start_failed'")
        .first();
      if (priorForVisit) {
        return { started: false, reason: "service_record_enrolled", sequence: priorForVisit };
      }
    }

    // The first touch is an immediate ask, so enforce the same lifetime cap +
    // 30-day cooldown as a one-off send (the candidate list already filters on
    // these, but this endpoint can be hit directly / in bulk / racing a recent
    // send). Counts asks across BOTH channels. Fail CLOSED — a DB blip must not
    // let an at-cap / in-cooldown customer through (no .catch → it throws and
    // the route records the customer as not-started). Day 3/4 still bypass cooldown.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    // seriesFinal scopes the first-treatment exemption to THIS series'
    // sequence ids (codex #3235 r4+r6 P1) — see getDeliveredAskStats.
    const enrollExemptIds = seriesFinal
      ? await this._seriesExemptSequenceIds(customerId, { serviceRecordId, scheduledServiceId })
      : [];
    const stats = await this.getDeliveredAskStats(customerId, { exemptSequenceIds: enrollExemptIds });
    if (stats.count >= 3) return { started: false, reason: "at_cap" };
    if (stats.lastAt && new Date(stats.lastAt).getTime() >= thirtyDaysAgo.getTime()) {
      return { started: false, reason: "cooldown" };
    }

    // Supersede any already-queued ASK (post-service auto, or a deferred
    // retry): otherwise processScheduled() would fire it AND the cadence's
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
    const insertReplacement = () => db.transaction(async (trx) => {
        // The opener stop commits WITH the replacement insert (codex #3243
        // r9 P2) — and the one-active partial index means the stop cannot
        // simply be deferred outside the insert's transaction. A concurrent
        // state change on the opener aborts into the already_active
        // recovery below, exactly like an index collision.
        if (supersedeOpenerId) {
          const stopped = await trx("review_sequences")
            .where({ id: supersedeOpenerId, status: "active" })
            .update({ status: "stopped", stop_reason: "superseded_by_series_final", next_run_at: null, completed_at: new Date(), updated_at: new Date() });
          if (!stopped) {
            const raceErr = new Error("opener changed state mid-enrollment");
            raceErr.code = "OPENER_SUPERSEDE_RACE";
            throw raceErr;
          }
        }
        return trx("review_sequences")
          .insert({
          customer_id: customerId,
          location_id: locId,
          status: "active",
          plan: JSON.stringify(usePlan),
          current_step: 0,
          touches_sent: 0,
          // Without firstTouchAt: insert with next_run_at NULL so the cron
          // (which only picks rows with a non-null next_run_at <= now) can't
          // grab this row and fire step 0 in parallel with the inline
          // _runSequenceStep below — the cron lock serializes cron workers,
          // not this admin path. _runSequenceStep sets next_run_at when it
          // advances/retries.
          // With firstTouchAt (post-service auto-enroll): the Day-0 touch is
          // NOT fired inline — it's scheduled at the smart send window and the
          // sequence cron delivers it.
          next_run_at: firstTouchAt || null,
          // Persisted so the step runner applies the series-final cap
          // exemption deterministically (codex #3235 r5 P1).
          series_final: seriesFinal === true,
          service_record_id: serviceRecordId || null,
          // Visit identity for the runner's lineage walk — the record row
          // may not exist on the admin-schedule path (codex #3235 r7 P1).
          scheduled_service_id: scheduledServiceId || null,
          tech_name: tName,
          service_type: svcType,
          started_by: startedBy || null,
          started_at: new Date(),
        })
          .returning("*");
      });
    try {
      [sequence] = await insertReplacement();
    } catch (err) {
      if (err?.code === "OPENER_SUPERSEDE_RACE") {
        // The opener stopped ITSELF (its cron re-resolution can close it as
        // series_completed) between the proof and this commit (codex #3243
        // r10 P1). Another active sequence in its place is a genuine
        // already_active; NO active sequence means the final's cadence must
        // still be created — retry once without the stop.
        const existing = await db("review_sequences").where({ customer_id: customerId, status: "active" }).first();
        if (existing) return { started: false, reason: "already_active", sequence: existing };
        supersedeOpenerId = null;
        try {
          [sequence] = await insertReplacement();
        } catch (retryErr) {
          if (retryErr?.code === "23505") {
            const raced = await db("review_sequences").where({ customer_id: customerId, status: "active" }).first();
            return { started: false, reason: "already_active", sequence: raced };
          }
          throw retryErr;
        }
      } else if (err?.code === "23505") {
        const existing = await db("review_sequences").where({ customer_id: customerId, status: "active" }).first();
        return { started: false, reason: "already_active", sequence: existing };
      } else {
        throw err;
      }
    }

    // Scheduled start: the cron fires step 0 at firstTouchAt; nothing to run
    // inline. (The stop conditions re-run inside _runSequenceStep at send
    // time, so a customer who reviews/opts out in the gap is still skipped.)
    if (firstTouchAt) {
      return { started: true, sequence, scheduledFor: firstTouchAt };
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
    let plan = Array.isArray(seq.plan) ? seq.plan : JSON.parse(seq.plan || "[]");
    const customer = await db("customers").where({ id: seq.customer_id }).first();

    // Late-arriving series context (codex #3235 r9 P1): completion enrolls
    // BEFORE staff book the follow-up from the completion CTA, so the plan
    // persisted at enrollment can be stale by the first send. Re-resolve
    // once, while NOTHING has been sent, for auto enrollments only — an
    // operator-started sequence keeps its explicit plan. A re-resolve that
    // says skip (now a middle visit) stops the sequence; a changed plan and
    // series flags are persisted before any guard reads them.
    if (seq.started_by === "post_service" && (seq.touches_sent || 0) === 0 && (seq.current_step || 0) === 0) {
      try {
        const re = await this.resolveSequencePlanForEnrollment({
          customerId: seq.customer_id,
          serviceRecordId: seq.service_record_id,
          scheduledServiceId: seq.scheduled_service_id,
        });
        if (re.error) {
          // Defer, never send on a possibly-stale plan (codex #3235 r19 P1):
          // a follow-up booked after enrollment may have flipped this to a
          // single first-treatment ask, so retry the classification next tick.
          await db("review_sequences")
            .where({ id: seq.id, status: "active" })
            .update({ next_run_at: new Date(Date.now() + 30 * 60 * 1000), updated_at: new Date() })
            .catch(() => {});
          return { ran: false, deferred: true, reason: "plan_reresolution_unavailable" };
        }
        if (re.skip) {
          await db("review_sequences").where({ id: seq.id }).update({
            status: "stopped",
            stop_reason: re.skip,
            next_run_at: null,
            completed_at: new Date(),
            updated_at: new Date(),
          });
          return { ran: false, stopped: true, reason: re.skip };
        }
        if (re.plan && JSON.stringify(re.plan) !== JSON.stringify(plan)) {
          await db("review_sequences").where({ id: seq.id, status: "active" }).update({
            plan: JSON.stringify(re.plan),
            series_final: re.seriesFinal === true,
            updated_at: new Date(),
          });
          plan = re.plan;
          seq.series_final = re.seriesFinal === true;
        }
      } catch {
        // Same posture as re.error (codex r19): a blip mid-swap must defer,
        // not send against a possibly half-updated plan/flag pair.
        await db("review_sequences")
          .where({ id: seq.id, status: "active" })
          .update({ next_run_at: new Date(Date.now() + 30 * 60 * 1000), updated_at: new Date() })
          .catch(() => {});
        return { ran: false, deferred: true, reason: "plan_reresolution_unavailable" };
      }
    }

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
    // Direct-link engagement: with GATE_REVIEW_DIRECT_LINK there is no submit
    // event — the tracked redirect stamping redirected_at IS the response.
    // The redirect route stops the sequence inline; this is the backstop for
    // legacy google_review_clicked stamps and any missed inline stop.
    const clicked = await db("review_requests")
      .where({ sequence_id: seq.id })
      .where((b) => b.whereNotNull("redirected_at").orWhere("google_review_clicked", true))
      .first()
      .catch(() => null);
    if (clicked) return stop("clicked");
    if (seq.current_step >= plan.length) return stop("completed");
    // Same-series exemption set, computed once for the cap check AND the
    // supersession check below (codex #3235 r2+r5+r6 P1s): the visit-1 ask
    // of THIS sequence's own series never supersedes or caps its final
    // cadence; any other sequence's ask still does.
    const runnerExemptIds = seq.series_final === true
      ? await this._seriesExemptSequenceIds(seq.customer_id, { serviceRecordId: seq.service_record_id, scheduledServiceId: seq.scheduled_service_id })
      : [];
    const runnerExempt = new Set(runnerExemptIds);

    // Keep the whole cadence within the lifetime 3-ask cap: a customer who had
    // 1-2 prior asks must not reach 4-5 via the cadence. Delivered ask touches
    // (incl. this cadence's own) are counted, so the sequence stops once 3 is hit.
    let askStats;
    try {
      // The persisted enrollment-time flag (codex #3235 r5 P1) gates the
      // exemption; the exempt set is the SAME-SERIES sequence ids (r6 P1),
      // so another series' first-treatment ask still counts here. The
      // series-final cadence itself still delivers its full 3 (owner 1+3).
      askStats = await this.getDeliveredAskStats(seq.customer_id, { exemptSequenceIds: runnerExemptIds });
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

    // Gate-toggle hygiene (Codex P2, r4): while GATE_REVIEW_SEQUENCES is off
    // the cron freezes active rows in place — completions deliver legacy asks
    // in the meantime, and re-enabling the gate would otherwise resume relic
    // steps. Two deterministic retirements:
    //  - stale: a step OVERDUE by more than 7 days can only be a resumed
    //    relic (normal cron lag is minutes). Overdue-based, NOT age-based —
    //    an operator may legitimately schedule the first touch up to 30 days
    //    out, and that step arrives just-due, never deeply overdue
    //    (Codex P2, r5). A NULL next_run_at (inline start) is brand new.
    //  - superseded: an ask DELIVERED outside this sequence since 30 days ago
    //    (legacy path, manual one-off) means the customer was already
    //    contacted — another touch inside the cooldown would double-ask.
    const dueAtMs = seq.next_run_at ? new Date(seq.next_run_at).getTime() : null;
    if (dueAtMs != null && Number.isFinite(dueAtMs) && Date.now() - dueAtMs > 7 * 86400000) {
      return stop("stale");
    }
    let recentAskRows = [];
    try {
      recentAskRows = await db("review_requests")
        .where({ customer_id: seq.customer_id })
        .where("created_at", ">", new Date(Date.now() - 30 * 86400000))
        .whereRaw("(sms_sent_at IS NOT NULL OR sent_at IS NOT NULL)")
        .whereRaw(ASK_TOUCH_SQL)
        .select("sequence_id", "template_key", "sms_sent_at", "sent_at");
    } catch {
      recentAskRows = []; // hygiene check is best-effort; the cap/cooldown guards below still hold
    }
    const externallyAsked = recentAskRows.some(
      (r) => (r.sms_sent_at || r.sent_at)
        && r.sequence_id !== seq.id
        && !(OUTREACH.CAP_EXEMPT_TEMPLATE_KEYS.includes(r.template_key)
          && r.sequence_id && runnerExempt.has(r.sequence_id)),
    );
    if (externallyAsked) return stop("superseded");

    // Mid-cadence manual-ask standdown (codex #3235 r1 P1): the owner can
    // hand-send an ask AFTER enrollment (evening of a next-morning Day-0, or
    // between Day 0 and Day 4). Scoped to evidence since the sequence
    // started — pre-enrollment asks were already screened at enrollment, and
    // an operator-started sequence keeps its deliberate override.
    if (seq.started_at && await this.manualReviewAskSentRecently(seq.customer_id, { since: seq.started_at })) {
      return stop("manual_ask_recent");
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
        // serviceDate is NOT passed here: sendOutreachTouch recovers the real
        // service_date (and technician) from service_record_id — or from the
        // persisted visit id when no record backs the sequence (codex #3235
        // r8 P2) — which grounds both the touch row and the drafter's
        // "completed N days ago" fact; seq.started_at would shadow that.
        serviceRecordId: seq.service_record_id,
        scheduledServiceId: seq.scheduled_service_id,
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
      const next_run_at = nextTouchRunAt({ startedAt: seq.started_at, step: plan[nextStep] });
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
   * True when the ACTIVE review_request_email version renders the
   * {{intro_paragraph}} variable — the precondition for drafting/attributing
   * a personalized email intro (codex #3235 r6 P2). Fail-closed: template
   * copy sends, no drafting spend, honest analytics.
   */
  async _emailIntroVariableActive() {
    try {
      const t = await db("email_templates")
        .where({ template_key: "review_request_email" })
        .select("active_version_id")
        .first();
      if (!t?.active_version_id) return false;
      const v = await db("email_template_versions")
        .where({ id: t.active_version_id })
        .select("blocks")
        .first();
      const blocks = typeof v?.blocks === "string" ? v.blocks : JSON.stringify(v?.blocks || "");
      return blocks.includes("{{intro_paragraph}}");
    } catch {
      return false;
    }
  },

  /**
   * Sequence ids whose delivered first-treatment ask belongs to the SAME
   * treatment series as the given service record (codex #3235 r6 P1): the
   * cap/cooldown exemption must not blanket-hide every first-treatment ask —
   * two back-to-back series would otherwise reach 5 asks in the rolling
   * window. Series lineage: the current visit's parent/followup-source
   * visit(s), or (named two-treatment packages without linkage) prior
   * completed same-service visits in the last 60 days. Fail-open to [] —
   * no exemption means FEWER sends, never more.
   */
  /**
   * Technician-declared initial setup (codex #3243 r10 P2): rodent_trapping
   * reports REQUIRE trap_visit_type, frozen into service_data's
   * typedReportSnapshot (or a companion snapshot when trapping rides a
   * combined visit). Absence or a parse failure falls back to inference —
   * the declaration is an override, not a gate.
   */
  async _isDeclaredInitialTrapVisit({ serviceRecordId = null, scheduledServiceId = null } = {}) {
    // DB failures PROPAGATE (codex #3243 r13 P1): collapsing them into
    // "not declared" let a genuine new setup inherit the old program's
    // position — the resolver's retry/plan_resolution_failed path must see
    // the error. Only parse/shape problems fall back to inference.
    let record = null;
    if (serviceRecordId) {
      record = await db("service_records").where({ id: serviceRecordId }).select("service_data").first();
    }
    if (!record && scheduledServiceId) {
      record = await db("service_records")
        .where({ scheduled_service_id: scheduledServiceId })
        .orderBy("created_at", "desc")
        .select("service_data")
        .first();
    }
    if (!record?.service_data) return false;
    try {
      const data = typeof record.service_data === "string" ? JSON.parse(record.service_data) : record.service_data;
      const snapshots = [
        data?.typedReportSnapshot,
        ...(Array.isArray(data?.companionReportSnapshots) ? data.companionReportSnapshots : []),
      ];
      return snapshots.some((snap) => String(snap?.values?.trap_visit_type || "").trim() === "Initial setup");
    } catch {
      return false;
    }
  },

  async _seriesExemptSequenceIds(customerId, { serviceRecordId = null, scheduledServiceId = null, strict = false } = {}) {
    try {
      let visitId = scheduledServiceId || null;
      if (!visitId && serviceRecordId) {
        const sr = await db("service_records")
          .where({ id: serviceRecordId })
          .select("scheduled_service_id")
          .first();
        visitId = sr?.scheduled_service_id || null;
      }
      if (!visitId) return [];
      const visit = await db("scheduled_services as s")
        .leftJoin("services as sv", "s.service_id", "sv.id")
        .where("s.id", visitId)
        .select("s.id", "s.parent_service_id", "s.followup_source_service_id", "s.service_id", "s.scheduled_date", "s.property_id", "s.service_address_line1", "s.service_address_line2", "s.service_address_city", "s.service_address_zip", "s.window_start", "s.created_at", "sv.service_key", "sv.follow_up_interval_days")
        .first();
      if (!visit) return [];
      // Walk the FULL ancestor chain (codex #3235 r7 P1): in a 3+ visit
      // series the final visit's immediate parent is the middle visit, and
      // only the chain's first visit carries the exempt ask. Bounded depth
      // + cycle guard.
      // Traverse until the chain ends (codex #3235 r11 P1: trapping
      // programs legitimately reach visit 9+); the seen-set is the real
      // terminator, the depth cap is only a runaway guard.
      const seen = new Set([visit.id]);
      let sourceIds = [];
      const ancestorRows = [];
      let cursor = visit;
      for (let depth = 0; depth < 50; depth += 1) {
        const next = cursor.parent_service_id || cursor.followup_source_service_id;
        if (!next || seen.has(next)) break;
        seen.add(next);
        sourceIds.push(next);
        cursor = await db("scheduled_services")
          .where({ id: next })
          .select("id", "parent_service_id", "followup_source_service_id", "service_id", "scheduled_date", "property_id", "service_address_line1", "service_address_line2", "service_address_city", "service_address_zip", "window_start", "created_at")
          .first();
        if (!cursor) break;
        ancestorRows.push(cursor);
      }
      // Trapping merges family history INTO linked ancestry (codex #3243 r4
      // P1) rather than falling back either/or: a final linked only to the
      // middle visit made sourceIds nonempty, so the unlinked opener's
      // first_treatment_ask stayed unexempted and the cooldown rejected the
      // intended final cadence.
      if (visit.service_id && TRAPPING_MULTI_TREATMENT_KEYS.has(visit.service_key)
        // A declared initial IS its series' opener — nothing behind it
        // belongs to this series, so the family walk is skipped entirely
        // (codex #3243 r11 P1); linked ancestry (if any) stands alone.
        && !(await this._isDeclaredInitialTrapVisit({ scheduledServiceId: visit.id }))) {
        // Breadth-first opener trace (r3 P2 + r4 P1): every discovered
        // visit anchors its own window — adjacent checks chain past one
        // window's span (days 0/20/40) — and the seeds are the visit PLUS
        // its linked ancestors: linkage bridges date gaps the walk can't
        // cross, the walk reaches unlinked visits linkage can't. The
        // seen-set terminates; the hop cap is a runaway guard.
        const intervalDays = Number(visit.follow_up_interval_days) > 0 ? Number(visit.follow_up_interval_days) : 15;
        const windowDays = Math.min(60, Math.max(30, intervalDays * 2));
        const seriesKeys = trappingSeriesKeysFor(visit.service_key);
        const inPremise = await trappingPremiseMatcher(customerId, visit);
        const collectedRows = new Map(); // walk discoveries: id -> row
        const walkSelect = ["ps.id", "ps.scheduled_date", "ps.property_id", "ps.service_address_line1", "ps.service_address_line2", "ps.service_address_city", "ps.service_address_zip", "ps.window_start", "ps.created_at"];
        // The declared-opener boundary is GLOBAL across dequeues (codex
        // #3243 r12 P1): later cursors re-open windows behind the opener,
        // so the bound persists (and retro-prunes) rather than living one
        // iteration.
        let boundOpener = null;
        const afterBound = (r) => {
          if (!boundOpener || r.id === boundOpener.id) return true;
          const day = etDayWindow(r.scheduled_date, 0).anchorStr;
          const bDay = etDayWindow(boundOpener.scheduled_date, 0).anchorStr;
          if (day > bDay) return true;
          return day === bDay && compareSameDayVisits(r, boundOpener) >= 0;
        };
        // Linked ancestry is cut at the nearest declared initial too (codex
        // #3243 r13 P1): a stale link THROUGH the opener must not exempt
        // the previous program's ask. The cut opener seeds the walk's
        // global bound; ancestry ids without row data (broken chain) are
        // kept — unknown, not judged.
        let ancestryRows = ancestorRows;
        for (let i = 0; i < ancestorRows.length; i += 1) {
          if (await this._isDeclaredInitialTrapVisit({ scheduledServiceId: ancestorRows[i].id })) {
            boundOpener = ancestorRows[i];
            ancestryRows = ancestorRows.slice(0, i + 1);
            break;
          }
        }
        const keptAncestryIds = new Set(ancestryRows.map((r) => r.id));
        const seedIds = new Set(sourceIds.filter((id) => keptAncestryIds.has(id) || !ancestorRows.some((r) => r.id === id)));
        const queue = [visit, ...ancestryRows.filter((r) => r.scheduled_date != null)];
        // Exhaust the queue (codex #3243 r6 P2): a dequeue cap truncated
        // long chains — each cursor can enqueue several same-window
        // siblings, starving the path to the opener. Termination is the
        // seen-set (nothing enqueues twice); the collected-size bound is a
        // runaway guard sized far above any real program.
        while (queue.length && collectedRows.size < 300) {
          const c = queue.shift();
          const w = etDayWindow(c.scheduled_date, windowDays);
          const rows = await db("scheduled_services as ps")
            .leftJoin("services as psv", "ps.service_id", "psv.id")
            .where("ps.customer_id", customerId)
            .where("ps.status", "completed")
            .where("ps.scheduled_date", "<", w.anchorStr)
            .where("ps.scheduled_date", ">=", w.floorStr)
            .whereIn("psv.service_key", seriesKeys)
            .select(...walkSelect);
          // Same-day earlier siblings (r5 P2): a same-date setup visit sits
          // outside the strictly-earlier window — order by appointment
          // window / created_at relative to this cursor.
          const sameDay = await db("scheduled_services as ps")
            .leftJoin("services as psv", "ps.service_id", "psv.id")
            .where("ps.customer_id", customerId)
            .where("ps.status", "completed")
            .where("ps.scheduled_date", w.anchorStr)
            .whereIn("psv.service_key", seriesKeys)
            .select(...walkSelect);
          const fresh = [...rows, ...sameDay.filter((r) => compareSameDayVisits(r, c) < 0)]
            .filter((r) => r.id !== visit.id && !collectedRows.has(r.id) && inPremise(r));
          // A declared initial is ITS series' opener (codex #3243 r11 P1):
          // it stays in the exemption set, but nothing EARLIER than it —
          // in this window or via further traversal — belongs to this
          // series; those asks must keep counting toward cap/cooldown.
          const declaredFlags = new Map();
          for (const r of fresh) {
            declaredFlags.set(r.id, await this._isDeclaredInitialTrapVisit({ scheduledServiceId: r.id }));
          }
          for (const r of fresh) {
            // The NEAREST declared initial wins; raising the bound also
            // retro-prunes anything admitted before it was known.
            if (declaredFlags.get(r.id) && (!boundOpener || afterBound(r))) {
              boundOpener = r;
              for (const [id, row] of [...collectedRows]) {
                if (!afterBound(row)) collectedRows.delete(id);
              }
            }
          }
          for (const r of fresh) {
            if (!afterBound(r)) continue;
            collectedRows.set(r.id, r);
            if (!declaredFlags.get(r.id)) {
              queue.push(r);
            }
          }
        }
        sourceIds = [...new Set([...seedIds, ...collectedRows.keys()])];
      } else if (!sourceIds.length && visit.service_id) {
        // Same anchoring as the plan resolver (codex #3235 r10 P1): the
        // series' earlier visits, relative to THIS visit's date — never a
        // now-relative window that payment-deferred enrollment would skew.
        // Packages stay same-service, 2x-interval.
        const intervalDays = Number(visit.follow_up_interval_days) > 0 ? Number(visit.follow_up_interval_days) : 15;
        const windowDays = Math.min(60, intervalDays * 2);
        const w = etDayWindow(visit.scheduled_date, windowDays);
        const priors = await db("scheduled_services")
          .where({ customer_id: customerId, service_id: visit.service_id, status: "completed" })
          .where("id", "!=", visit.id)
          .where("scheduled_date", "<", w.anchorStr)
          .where("scheduled_date", ">=", w.floorStr)
          .select("id");
        sourceIds = priors.map((r) => r.id);
      }
      if (!sourceIds.length) return [];
      // Two lookups (codex #3235 r8 P1): a first-visit sequence enrolled
      // before its service_records row existed carries only
      // scheduled_service_id — record-mapped matching alone misses it.
      const records = await db("service_records")
        .whereIn("scheduled_service_id", sourceIds)
        .select("id");
      const byRecord = records.length
        ? await db("review_sequences")
            .whereIn("service_record_id", records.map((r) => r.id))
            .select("id")
        : [];
      const byVisit = await db("review_sequences")
        .whereIn("scheduled_service_id", sourceIds)
        .select("id");
      return [...new Set([...byRecord, ...byVisit].map((r) => r.id))];
    } catch (err) {
      // strict = the ENGAGEMENT consumer (codex #3243 r13 P1): a swallowed
      // failure there reads as "not engaged" and sends three more asks to a
      // customer who already responded — propagate so the resolver defers.
      // Non-strict consumers (cap/cooldown exemption) keep the fail-open []
      // — a missing exemption means FEWER sends, never more.
      if (strict) throw err;
      logger.warn(`[review] series-exempt lookup failed (customerId=${customerId}): ${err.message} — no exemption`);
      return [];
    }
  },

  /**
   * Channel-complete "review asks delivered" stats for one customer — counts
   * every review_requests row actually sent on SMS OR email (audit: the old
   * sms_log-only count missed email asks, so a customer could exceed the cap /
   * dodge the cooldown via email). Used by the cap + 30-day cooldown guards.
   */
  async getDeliveredAskStats(customerId, { exemptSequenceIds = [] } = {}) {
    // Cap window (owner policy 2026-07-30): the 3-ask cap is a ROLLING
    // 180-day window, not lifetime — a customer who never engages becomes
    // eligible for a fresh cadence every ~6 months. `lastAt` (the 30-day
    // cooldown input) is still all-time.
    //
    // Exemption scope (codex #3235 r4 P1 + r6 P1): a first-treatment ask is
    // invisible to cap/cooldown ONLY when it belongs to the series whose
    // final visit is enrolling — exemptSequenceIds carries that series'
    // sequence ids (_seriesExemptSequenceIds). A template-key-only filter
    // would also hide OTHER series' first asks and let back-to-back series
    // reach 5 asks in the window. Rows are filtered in JS because the
    // predicate needs the (key, sequence) pair, not a static SQL list.
    const rows = await db("review_requests")
      .where({ customer_id: customerId })
      .whereRaw("(sms_sent_at IS NOT NULL OR sent_at IS NOT NULL)")
      .whereRaw(ASK_TOUCH_SQL)
      .select("template_key", "sequence_id", "sms_sent_at", "sent_at")
      .orderByRaw("COALESCE(sms_sent_at, sent_at) DESC")
      .limit(200);
    const exempt = new Set(exemptSequenceIds);
    const counted = rows.filter((r) => !(
      OUTREACH.CAP_EXEMPT_TEMPLATE_KEYS.includes(r.template_key)
      && r.sequence_id && exempt.has(r.sequence_id)
    ));
    const windowStartMs = Date.now() - ASK_CAP_WINDOW_DAYS * 86400000;
    const times = counted
      .map((r) => new Date(r.sms_sent_at || r.sent_at).getTime())
      .filter((t) => Number.isFinite(t));
    return {
      count: times.filter((t) => t >= windowStartMs).length,
      lastAt: times.length ? new Date(Math.max(...times)) : null,
    };
  },

  /** Batched getDeliveredAskStats for the candidate list. */
  async getDeliveredAskStatsBatch(ids = []) {
    if (!ids.length) return {};
    // Same rolling 180-day cap window as getDeliveredAskStats; last_at stays
    // all-time (cooldown input).
    const windowStart = new Date(Date.now() - ASK_CAP_WINDOW_DAYS * 86400000);
    // ASK_TOUCH: the outreach candidate list has no series context, so it
    // counts every delivered ask including first-treatment ones (codex r4).
    const rows = await db("review_requests")
      .whereIn("customer_id", ids)
      .whereRaw("(sms_sent_at IS NOT NULL OR sent_at IS NOT NULL)")
      .whereRaw(ASK_TOUCH_SQL)
      .groupBy("customer_id")
      .select(
        "customer_id",
        db.raw("COUNT(*) FILTER (WHERE COALESCE(sms_sent_at, sent_at) >= ?) AS count", [windowStart]),
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
  nextTouchRunAt,
  shiftToWeekdayMorning,
  buildReviewUrl,
};

// The digital-card mint (services/customer-card.js) routes its review QR with
// the SAME city→GBP map as review asks — including the review-only overrides
// above (palmetto → bradenton etc.) — instead of forking another copy of the
// location list. Returns a location id string ('bradenton' | ...).
ReviewService.resolveReviewLocationId = resolveLocation;

module.exports = ReviewService;
