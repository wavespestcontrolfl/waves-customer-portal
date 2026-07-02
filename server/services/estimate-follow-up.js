/**
 * Estimate Follow-Up Service
 *
 * Three touches while a quote is live, plus one payment-drop stage:
 *   1. Questions opener — 48-72h after send, viewed / not-yet-viewed copy
 *      variants. A reply routes the thread to Virginia (the reply-pause
 *      below already stops the cron from talking over a live conversation).
 *   2. Day-5 check-in — the slot the offer engine's First-Year Protection
 *      Credit will occupy (hence the followup_credit_sent_at column);
 *      neutral copy until the offer machinery lands. SMS-only.
 *   3. Last-day notice — the day before expires_at.
 *   +  Deposit started but never completed (2-72h after the last pending
 *      PaymentIntent; gated by GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS —
 *      shadow-logs counts until on).
 *
 * Runs via cron every 2 hours. SMS is primary, email is a second channel
 * where an honest template exists. Each stage atomically claims a timestamp
 * column (not a boolean) so acceptances can be attributed to touches later.
 */

const db = require("../models/db");
const EmailTemplateLibrary = require("./email-template-library");
const smsTemplatesRouter = require("../routes/admin-sms-templates");
const logger = require("./logger");
const { shortenOrPassthrough } = require("./short-url");
const { sendCustomerMessage } = require("./messaging/send-customer-message");
const { inferEstimateServiceInterest } = require("./estimate-service-lines");
const { isEnabled } = require("../config/feature-gates");
const { CUSTOMER_STAGES } = require("./customer-stages");
const {
  assessDepositFollowUpEligibility,
  DEPOSIT_FOLLOWUP_WINDOW,
} = require("./estimate-deposits");

// ── Cadence windows ──────────────────────────────────────────────────────
// With the 10-day default expiry the ladder lands roughly day 2-3 / day 5-6
// / day 9 — one touch every ~3 days. Max-age bounds keep a stalled cron or
// deploy gap from nudging estimates whose moment has passed.

const QUESTIONS_WINDOW = { minAgeHours: 48, maxAgeHours: 120 };
const CHECKIN_WINDOW = { minAgeDays: 5, maxAgeDays: 8 };
// The check-in yields when expiry is close — the last-day notice carries the
// deadline; two texts on the same short-fuse estimate would stack.
const CHECKIN_EXPIRY_YIELD_HOURS = 48;
// Gap required since the questions touch so a quiet-hours-delayed touch 1
// doesn't run into touch 2 the next morning.
const CHECKIN_QUESTIONS_GAP_HOURS = 48;
// "Last day" catch window: wide enough that quiet hours + the 2h cron can't
// starve it, tight enough the copy stays honest.
const EXPIRING_HORIZON_HOURS = 30;
// Minimum spacing from ANY prior follow-up (manual sends included). The
// expiring touch runs a tighter gap because it is deadline-critical.
const TOUCH_SPACING_HOURS = 24;
const EXPIRING_SPACING_HOURS = 12;

// ── Safety gates (see: "don't be annoying" PR) ──────────────────────────
// Centralized so the behavior stays consistent across all stages.

const TERMINAL_STATUSES = new Set(["declined", "accepted", "expired", "void"]);

// 9a–5p America/New_York. Per Adam: never text a customer outside normal
// business hours. Cron runs every 2h; sends blocked outside the window
// will be re-evaluated at the next cron tick and fire then.
function isQuietHours(now = new Date()) {
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: "America/New_York",
    }).format(now),
    10,
  );
  if (Number.isNaN(hour)) return false; // fail open — better to send than stall
  return hour < 9 || hour >= 17;
}

// Engagement signal: if the customer opened the estimate within the last N
// hours (default 2), skip the scheduled nudge. They're thinking about it
// right now and don't need a poke.
function wasRecentlyOpened(est, hours = 2, nowMs = Date.now()) {
  const last = est.last_viewed_at || est.viewed_at;
  if (!last) return false;
  const ts = new Date(last).getTime();
  if (Number.isNaN(ts)) return false;
  return nowMs - ts < hours * 3600000;
}

// Reply-pause: if the customer has SMS'd Waves in the last N days (via
// phone match or customer_id), pause the cron touch and let Virginia
// handle it live. Soft-fails if the messages/conversations tables aren't
// present (e.g. fresh env) so we don't break the whole follow-up loop.
async function hasRepliedRecently(est, days = 14) {
  const cutoff = new Date(Date.now() - days * 86400000);
  try {
    const q = db("messages")
      .join("conversations", "messages.conversation_id", "conversations.id")
      .where("messages.direction", "inbound")
      .where("messages.channel", "sms")
      .where("messages.created_at", ">=", cutoff)
      .first("messages.id");
    if (est.customer_id) {
      q.andWhere(function () {
        this.where("conversations.customer_id", est.customer_id);
        if (est.customer_phone)
          this.orWhere("conversations.contact_phone", est.customer_phone);
      });
    } else if (est.customer_phone) {
      q.andWhere("conversations.contact_phone", est.customer_phone);
    } else {
      return false;
    }
    const row = await q;
    return !!row;
  } catch (e) {
    logger.warn(`[est-followup] reply-pause check skipped: ${e.message}`);
    return false; // fail open
  }
}

// The pipeline-audit nag bug: every stage gated on ESTIMATE status only, so
// a lead who became a paying customer through another path (second estimate,
// phone booking) kept getting "any questions about your quote?" texts.
// Guarded at both layers: stage queries exclude estimates whose customer is
// live, and safetyGate re-checks per candidate (covers rows loaded before a
// conversion landed). Uses the canonical live-customer predicate from
// customer-stages.js — customers.active alone does NOT distinguish
// customers from CRM lead rows; pipeline_stage does.
function whereCustomerNotLive(query) {
  query.whereNotExists(function () {
    this.select(db.raw("1"))
      .from("customers")
      .whereRaw("customers.id = estimates.customer_id")
      .where("customers.active", true)
      .whereNull("customers.deleted_at")
      .whereIn("customers.pipeline_stage", CUSTOMER_STAGES);
  });
  return query;
}

// Last-10-digit phone rule, mirroring lead-estimate-link (kept private —
// that module doesn't export its helper).
function normalizeFollowupPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits || null;
}

async function isLiveCustomer(est) {
  try {
    if (est.customer_id) {
      const row = await db("customers")
        .where({ id: est.customer_id })
        .where("active", true)
        .whereNull("deleted_at")
        .whereIn("pipeline_stage", CUSTOMER_STAGES)
        .first("id");
      if (row) return true;
    }
    // Contact fallback: ID-less estimates (IB pending drafts, legacy lead
    // quotes) and estimates linked to a non-live record — the same person
    // may be live under ANOTHER customer row (converted via phone booking
    // or a second estimate). Same last-10-digit / lowercased-email match as
    // lead-estimate-link. Skipping a follow-up for a shared-household
    // contact is the cheap failure; texting a paying customer is not.
    const phone = normalizeFollowupPhone(est.customer_phone);
    const email = String(est.customer_email || "").trim().toLowerCase() || null;
    if (!phone && !email) return false;
    const contactMatch = await db("customers")
      .where("active", true)
      .whereNull("deleted_at")
      .whereIn("pipeline_stage", CUSTOMER_STAGES)
      .andWhere(function () {
        if (phone) {
          this.orWhereRaw(
            "RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = ?",
            [phone],
          );
        }
        if (email) this.orWhereRaw("LOWER(COALESCE(email, '')) = ?", [email]);
      })
      .first("id");
    return !!contactMatch;
  } catch (e) {
    // Fail CLOSED: a skipped touch retries next tick (the claim is never
    // burned on a skip); texting a paying customer can't be taken back.
    logger.warn(
      `[est-followup] live-customer check failed (failing closed): ${e.message}`,
    );
    return true;
  }
}

// Unified gate. Returns { skip: true, reason } if the send should be
// blocked, else { skip: false }. Keeps the per-stage loops readable.
async function safetyGate(est, now = new Date()) {
  if (TERMINAL_STATUSES.has(est.status))
    return { skip: true, reason: `terminal-status:${est.status}` };
  if (isQuietHours(now)) return { skip: true, reason: "quiet-hours" };
  if (wasRecentlyOpened(est, 2, now.getTime()))
    return { skip: true, reason: "recently-opened" };
  if (await isLiveCustomer(est))
    return { skip: true, reason: "active-customer" };
  if (await hasRepliedRecently(est))
    return { skip: true, reason: "customer-replied-recently" };
  return { skip: false };
}

async function renderTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === "function") {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch (err) {
    logger.warn(`[est-followup] SMS template ${templateKey} lookup failed: ${err.message}`);
  }
  logger.warn(`[est-followup] SMS template ${templateKey} missing/disabled/invalid`);
  return null;
}

// Atomic stage claim. Stamps the stage timestamp from NULL and returns true
// only if THIS caller won the race. Two concurrent crons (server restart,
// overlapping runs) both load the same candidate row; the one whose UPDATE
// affects 1 row sends, the other gets 0 rows and skips. Prevents duplicate
// SMS/email to the customer. The stamp doubles as the attribution record —
// "accepted within 48h of the day-5 touch" needs the actual send time.
async function claimStage(estId, column, now = new Date()) {
  const affected = await db("estimates")
    .where({ id: estId })
    .whereNull(column)
    .update({ [column]: now });
  return affected === 1;
}

// Reverses a claim when the send fails on every channel, so the next cron
// tick retries instead of permanently burning the stage.
async function releaseStage(estId, column) {
  await db("estimates")
    .where({ id: estId })
    .update({ [column]: null });
}

function moneySummary(est = {}) {
  const monthlyTotal = parseFloat(est.monthly_total || est.monthlyTotal || 0);
  const annualTotal = parseFloat(est.annual_total || est.annualTotal || 0);
  const oneTimeTotal = parseFloat(est.onetime_total || est.oneTimeTotal || est.onetimeTotal || 0);
  if (monthlyTotal > 0) {
    return annualTotal > 0
      ? `$${monthlyTotal.toFixed(0)}/mo · $${annualTotal.toLocaleString()}/yr`
      : `$${monthlyTotal.toFixed(0)}/mo`;
  }
  if (oneTimeTotal > 0) return `$${oneTimeTotal.toFixed(0)} one-time`;
  return "";
}

function formatExpiryDate(expiresAt) {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

function estimateEmailPayload(est, firstName, estimateUrl, extra = {}) {
  const serviceSummary = inferEstimateServiceInterest({
    ...est,
    estimateData: est.estimate_data,
  });
  return {
    first_name: firstName,
    estimate_url: estimateUrl,
    service_summary: serviceSummary || "",
    property_address: est.address || "",
    price_summary: moneySummary(est),
    ...extra,
  };
}

function templateContext(est) {
  return {
    workflow: "estimate_follow_up",
    entity_type: "estimate",
    entity_id: est.id,
  };
}

// Shared sender — fires SMS if phone exists, email if email exists. Returns
// true if at least one channel attempted (callers use this to decide whether
// to keep the stage claim or release it).
//
// Email goes through EmailTemplateLibrary.sendTemplate so every send writes
// an `email_messages` audit row, respects `email_suppressions`, carries the
// ASM (List-Unsubscribe) header for the service_operational group, and
// renders content the admin can edit in /admin/email without a deploy. The
// `idempotencyKey` is stable per (stage, estimate) — duplicate cron ticks
// hit the email_messages unique index instead of resending. The atomic
// claimStage() timestamp is still primary; idempotency is belt-and-suspenders.
// `smsMessageType` is the rendered SMS template key. It feeds the per-
// template ops kill switch in TwilioService (isTemplateActive) — a coarse
// shared key would let disabling ONE stage's template silently swallow every
// stage's SMS after its claim was already taken.
async function sendDualChannel(est, { sms, email, smsMessageType }) {
  let attempted = false;
  if (est.customer_phone && sms) {
    try {
      const result = await sendCustomerMessage({
        to: est.customer_phone,
        body: sms,
        channel: "sms",
        audience: est.customer_id ? "customer" : "lead",
        purpose: "estimate_followup",
        customerId: est.customer_id || undefined,
        estimateId: est.id,
        identityTrustLevel: est.customer_id
          ? "phone_matches_customer"
          : "phone_provided_unverified",
        consentBasis: est.customer_id
          ? undefined
          : {
              status: "transactional_allowed",
              source: "estimate_follow_up",
              capturedAt: est.created_at || new Date().toISOString(),
            },
        entryPoint: "estimate_follow_up_cron",
        metadata: {
          original_message_type: smsMessageType || "estimate_followup",
        },
      });
      if (result.blocked || result.sent === false) {
        logger.warn(
          `[est-followup] SMS blocked for estimate ${est.id}: ${result.code || "unknown"} ${result.reason || ""}`,
        );
      } else {
        attempted = true;
      }
    } catch (e) {
      logger.error(
        `[est-followup] SMS failed for estimate ${est.id}: ${e.message}`,
      );
    }
  }
  if (est.customer_email && email?.templateKey) {
    try {
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: email.templateKey,
        to: est.customer_email,
        payload: email.payload || {},
        recipientType: est.customer_id ? "customer" : "lead",
        recipientId: est.customer_id || null,
        triggerEventId: `estimate_followup_${email.stage}:${est.id}`,
        idempotencyKey: `estimate_followup_${email.stage}:${est.id}`,
        categories: ["estimate_followup", `estimate_followup_${email.stage}`],
      });
      if (result?.blocked) {
        logger.warn(
          `[est-followup] Email suppressed for estimate ${est.id} (${email.stage}): ${result.reason || "blocked"}`,
        );
      } else if (result?.deduped) {
        logger.info(
          `[est-followup] Email deduped for estimate ${est.id} (${email.stage}) — prior send already on record`,
        );
        attempted = true;
      } else if (result?.sent) {
        attempted = true;
      }
    } catch (e) {
      logger.error(
        `[est-followup] Email failed for estimate ${est.id} (${email.stage}): ${e.message}`,
      );
    }
  }
  return attempted;
}

async function bumpFollowUpCounters(estId) {
  await db("estimates")
    .where({ id: estId })
    .update({
      follow_up_count: db.raw("COALESCE(follow_up_count, 0) + 1"),
      last_follow_up_at: db.fn.now(),
    });
}

// Shared per-candidate runner: safety gate → render → atomic claim → send →
// counters, releasing the claim if nothing attempted so the next tick
// retries. Render happens BEFORE the claim so a missing template on an
// SMS-only stage (smsRequired) skips without burning the stage. Returns 1
// when at least one channel attempted, else 0.
async function runTouch(est, cfg, now = new Date()) {
  let claimed = false;
  try {
    const gate = await safetyGate(est, now);
    if (gate.skip) {
      logger.info(`[est-followup] ${cfg.label} skip ${est.id}: ${gate.reason}`);
      return 0;
    }
    const firstName = (est.customer_name || "").split(" ")[0] || "there";
    const longUrl = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
    const url = await shortenOrPassthrough(longUrl, {
      kind: "estimate",
      entityType: "estimates",
      entityId: est.id,
      customerId: est.customer_id,
    });
    const rendered = await cfg.render(est, { firstName, url }, now);
    if (!rendered.sms && cfg.smsRequired) {
      logger.warn(
        `[est-followup] ${cfg.label} SMS unavailable — skipping est ${est.id} without claiming`,
      );
      return 0;
    }
    if (!(await claimStage(est.id, cfg.column, now))) {
      logger.info(`[est-followup] ${cfg.label} skip ${est.id}: lost-claim`);
      return 0;
    }
    claimed = true;
    const ok = await sendDualChannel(est, rendered);
    if (ok) {
      await bumpFollowUpCounters(est.id);
      claimed = false; // success path keeps the timestamp set
      return 1;
    }
    // !ok → finally releases so the next tick retries
    return 0;
  } catch (e) {
    logger.error(`[est-followup] ${cfg.label} send failed: ${e.message}`);
    return 0;
  } finally {
    if (claimed) {
      try {
        await releaseStage(est.id, cfg.column);
      } catch (e) {
        logger.error(`[est-followup] ${cfg.label} release failed: ${e.message}`);
      }
    }
  }
}

function withContactableChannel(q) {
  return q.where(function () {
    this.whereNotNull("customer_phone").orWhereNotNull("customer_email");
  });
}

function withTouchSpacing(q, nowMs, hours) {
  return q.where(function () {
    this.whereNull("last_follow_up_at").orWhere(
      "last_follow_up_at",
      "<",
      new Date(nowMs - hours * 3600000),
    );
  });
}

// 1. Questions opener, 48-72h after send. Anchored on sent_at (not
// viewed_at) so a lead who never opens the link still gets touch 1 — the
// copy just switches to the not-yet-viewed variant.
const QUESTIONS_TOUCH = {
  label: "Questions",
  column: "followup_questions_sent_at",
  smsRequired: false,
  async render(est, { firstName, url }) {
    const viewed = !!est.viewed_at;
    const templateKey = viewed
      ? "estimate_followup_questions"
      : "estimate_followup_questions_unviewed";
    let sms = null;
    const expiresLabel = formatExpiryDate(est.expires_at);
    if (!viewed && !expiresLabel) {
      // The unviewed copy promises "price locked until {expires_at}" —
      // without a date that sentence is broken, so skip SMS (email still
      // goes). Every live creation path stamps expires_at; this is legacy
      // rows only.
      logger.warn(
        `[est-followup] Questions SMS skipped for est ${est.id}: no expires_at for unviewed copy`,
      );
    } else {
      const vars = viewed
        ? { first_name: firstName, estimate_url: url }
        : {
            first_name: firstName,
            address: (est.address || "").trim() || "your home",
            expires_at: expiresLabel,
            estimate_url: url,
          };
      sms = await renderTemplate(templateKey, vars, templateContext(est));
      if (!sms) {
        logger.warn(
          `[est-followup] ${templateKey} template missing/disabled — continuing without SMS for est ${est.id}`,
        );
      }
    }
    return {
      sms,
      smsMessageType: templateKey,
      email: {
        templateKey: viewed
          ? "estimate.viewed_followup"
          : "estimate.unviewed_followup",
        stage: "questions",
        payload: estimateEmailPayload(est, firstName, url),
      },
    };
  },
};

async function checkQuestionsTouch(now = new Date()) {
  const nowMs = now.getTime();
  const q = db("estimates")
    .whereIn("status", ["sent", "viewed"])
    .whereNotNull("sent_at")
    .where("sent_at", "<", new Date(nowMs - QUESTIONS_WINDOW.minAgeHours * 3600000))
    .where("sent_at", ">", new Date(nowMs - QUESTIONS_WINDOW.maxAgeHours * 3600000))
    .whereNull("followup_questions_sent_at");
  withContactableChannel(q);
  withTouchSpacing(q, nowMs, TOUCH_SPACING_HOURS);
  whereCustomerNotLive(q);
  const candidates = await q;

  let sent = 0;
  for (const est of candidates) {
    sent += await runTouch(est, QUESTIONS_TOUCH, now);
  }
  return sent;
}

// 2. Day-5 check-in — the offer slot. SMS-only: the retired "final nudge"
// email said "one last check-in", which is dishonest mid-ladder, and the
// offer email belongs to PR 2. Yields to the last-day notice when expiry is
// close, and keeps distance from a quiet-hours-delayed questions touch.
const CHECKIN_TOUCH = {
  label: "Check-in",
  column: "followup_credit_sent_at",
  smsRequired: true,
  async render(est, { firstName, url }) {
    const sms = await renderTemplate(
      "estimate_followup_credit",
      {
        first_name: firstName,
        expires_at: formatExpiryDate(est.expires_at),
        estimate_url: url,
      },
      templateContext(est),
    );
    return { sms, smsMessageType: "estimate_followup_credit", email: null };
  },
};

async function checkCheckInTouch(now = new Date()) {
  const nowMs = now.getTime();
  const q = db("estimates")
    .whereIn("status", ["sent", "viewed"])
    .whereNotNull("sent_at")
    .where("sent_at", "<", new Date(nowMs - CHECKIN_WINDOW.minAgeDays * 86400000))
    .where("sent_at", ">", new Date(nowMs - CHECKIN_WINDOW.maxAgeDays * 86400000))
    .whereNotNull("customer_phone")
    .whereNull("followup_credit_sent_at")
    .whereNotNull("expires_at")
    .where(
      "expires_at",
      ">",
      new Date(nowMs + CHECKIN_EXPIRY_YIELD_HOURS * 3600000),
    )
    .where(function () {
      this.whereNull("followup_questions_sent_at").orWhere(
        "followup_questions_sent_at",
        "<",
        new Date(nowMs - CHECKIN_QUESTIONS_GAP_HOURS * 3600000),
      );
    });
  withTouchSpacing(q, nowMs, TOUCH_SPACING_HOURS);
  whereCustomerNotLive(q);
  const candidates = await q;

  let sent = 0;
  for (const est of candidates) {
    sent += await runTouch(est, CHECKIN_TOUCH, now);
  }
  return sent;
}

// 3. Last-day notice, the day before expiry. Runs FIRST in checkAll so the
// deadline touch wins the day when a short manual expiry stacks stages —
// later stages then space themselves off last_follow_up_at.
const EXPIRING_TOUCH = {
  label: "Expiring",
  column: "followup_expiring_sent_at",
  smsRequired: false,
  async render(est, { firstName, url }) {
    const expiresLabel = formatExpiryDate(est.expires_at);
    const sms = await renderTemplate(
      "estimate_followup_expiring",
      {
        first_name: firstName,
        expires_at: expiresLabel,
        estimate_url: url,
      },
      templateContext(est),
    );
    if (!sms) {
      logger.warn(
        `[est-followup] estimate_followup_expiring template missing/disabled — continuing without SMS for est ${est.id}`,
      );
    }
    return {
      sms,
      smsMessageType: "estimate_followup_expiring",
      email: {
        templateKey: "estimate.expiring_notice",
        stage: "expiring",
        payload: estimateEmailPayload(est, firstName, url, {
          expires_at: expiresLabel,
        }),
      },
    };
  },
};

async function checkExpiringTouch(now = new Date()) {
  const nowMs = now.getTime();
  const q = db("estimates")
    .whereIn("status", ["sent", "viewed"])
    .whereNotNull("expires_at")
    .where("expires_at", ">", now)
    .where(
      "expires_at",
      "<",
      new Date(nowMs + EXPIRING_HORIZON_HOURS * 3600000),
    )
    .whereNull("followup_expiring_sent_at");
  withContactableChannel(q);
  withTouchSpacing(q, nowMs, EXPIRING_SPACING_HOURS);
  whereCustomerNotLive(q);
  const candidates = await q;

  let sent = 0;
  for (const est of candidates) {
    sent += await runTouch(est, EXPIRING_TOUCH, now);
  }
  return sent;
}

// 4. Deposit started but never completed (2-72h after the last pending
// PaymentIntent). Highest-intent drop-off: the customer clicked accept and
// reached the Stripe card form. Gated separately because it's a new
// customer-facing auto-send — until GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS is
// on, candidates are only counted in the log (shadow, no claims) so the
// volume can be judged before any text goes out. SMS-only stage: there is no
// email template for it, so a missing/disabled SMS template skips WITHOUT
// claiming (nothing could send on either channel — claiming would burn the
// stage for nothing).
async function checkDepositAbandoned(now = new Date()) {
  let sent = 0;
  const nowMs = now.getTime();
  // Window on updated_at, not created_at: the deposit-intent endpoint REUSES
  // the same PaymentIntent for the same estimate+amount and bumps updated_at
  // on retry, so updated_at is "last time the customer touched the payment
  // step". created_at would both exclude a >72h-old intent the customer
  // retried an hour ago and nudge someone who is actively retrying right now.
  const latestPendingByEstimate = db("estimate_deposits")
    .select("estimate_id")
    .where("status", "pending")
    .groupBy("estimate_id")
    .max("updated_at as latest_pending_at")
    .as("pd");
  const q = db("estimates")
    .join(latestPendingByEstimate, "pd.estimate_id", "estimates.id")
    .whereIn("estimates.status", ["sent", "viewed"])
    .whereNotNull("estimates.customer_phone")
    .where("pd.latest_pending_at", "<", new Date(nowMs - DEPOSIT_FOLLOWUP_WINDOW.minAgeHours * 3600000))
    .where("pd.latest_pending_at", ">", new Date(nowMs - DEPOSIT_FOLLOWUP_WINDOW.maxAgeHours * 3600000))
    .whereNull("estimates.followup_deposit_abandoned_sent_at")
    .select("estimates.*");
  whereCustomerNotLive(q);
  const candidates = await q;

  if (!candidates.length) return 0;
  if (!isEnabled("estimateDepositAbandonmentSms")) {
    logger.info(
      `[est-followup] Deposit-abandoned shadow: ${candidates.length} candidate(s), gate off — no sends`,
    );
    return 0;
  }

  for (const est of candidates) {
    let claimed = false;
    try {
      const gate = await safetyGate(est, now);
      if (gate.skip) {
        logger.info(
          `[est-followup] Deposit-abandoned skip ${est.id}: ${gate.reason}`,
        );
        continue;
      }
      // Fresh, fail-CLOSED eligibility + outstanding-amount resolution from
      // the deposits service: re-checks the accepted race, an inactive/
      // expired estimate, quote-required, a now-exempt policy, money already
      // received (refund-netted, so a partial payment with a pending top-up
      // remainder stays nudgeable while a covered policy goes silent), and
      // that a pending intent still exists. Any verification failure skips —
      // an unprompted SMS is never sent on unverified eligibility.
      const eligibility = await assessDepositFollowUpEligibility(est.id, now);
      if (!eligibility.eligible) {
        logger.info(
          `[est-followup] Deposit-abandoned skip ${est.id}: ${eligibility.reason || "ineligible"}`,
        );
        continue;
      }
      const depositAmount = Number(eligibility.outstandingAmount);
      if (!Number.isFinite(depositAmount) || depositAmount <= 0) {
        logger.warn(
          `[est-followup] Deposit-abandoned skip ${est.id}: bad outstanding amount ${eligibility.outstandingAmount}`,
        );
        continue;
      }
      const firstName = (est.customer_name || "").split(" ")[0] || "there";
      const longUrl = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
      const url = await shortenOrPassthrough(longUrl, {
        kind: "estimate",
        entityType: "estimates",
        entityId: est.id,
        customerId: est.customer_id,
      });
      const smsBody = await renderTemplate("estimate_followup_deposit", {
        first_name: firstName,
        // Whole dollars render bare ("$49"); a refund-netted remainder with
        // cents renders exactly ("$29.50") instead of misquoting via round.
        deposit_amount: Number.isInteger(depositAmount)
          ? String(depositAmount)
          : depositAmount.toFixed(2),
        estimate_url: url,
      }, templateContext(est));
      if (!smsBody) {
        logger.warn(
          `[est-followup] estimate_followup_deposit template missing/disabled — skipping est ${est.id} without claiming`,
        );
        continue;
      }
      if (!(await claimStage(est.id, "followup_deposit_abandoned_sent_at", now))) {
        logger.info(
          `[est-followup] Deposit-abandoned skip ${est.id}: lost-claim`,
        );
        continue;
      }
      claimed = true;
      const ok = await sendDualChannel(est, {
        sms: smsBody,
        smsMessageType: "estimate_followup_deposit",
      });
      if (ok) {
        await bumpFollowUpCounters(est.id);
        sent++;
        claimed = false;
      }
    } catch (e) {
      logger.error(
        `[est-followup] Deposit-abandoned send failed: ${e.message}`,
      );
    } finally {
      if (claimed) {
        try {
          await releaseStage(est.id, "followup_deposit_abandoned_sent_at");
        } catch (e) {
          logger.error(
            `[est-followup] Deposit-abandoned release failed: ${e.message}`,
          );
        }
      }
    }
  }
  return sent;
}

const EstimateFollowUp = {
  async checkAll() {
    let sent = 0;
    const now = new Date();

    // Deadline touch first — see EXPIRING_TOUCH.
    try {
      sent += await checkExpiringTouch(now);
    } catch {
      /* columns may not exist */
    }

    try {
      sent += await checkQuestionsTouch(now);
    } catch {
      /* columns may not exist */
    }

    try {
      sent += await checkCheckInTouch(now);
    } catch {
      /* columns may not exist */
    }

    try {
      sent += await checkDepositAbandoned(now);
    } catch {
      /* columns may not exist */
    }

    if (sent > 0)
      logger.info(`[est-followup] Sent ${sent} follow-ups (SMS+email)`);
    return { sent };
  },
};

module.exports = EstimateFollowUp;
module.exports._private = {
  sendDualChannel,
  estimateEmailPayload,
  renderTemplate,
  checkDepositAbandoned,
  checkQuestionsTouch,
  checkCheckInTouch,
  checkExpiringTouch,
  safetyGate,
  isLiveCustomer,
  formatExpiryDate,
};
