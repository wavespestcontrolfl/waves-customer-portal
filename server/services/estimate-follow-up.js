/**
 * Estimate Follow-Up Service
 *
 * Auto-sends follow-up SMS + email to customers who:
 *   - Received an estimate but haven't viewed it (24h)
 *   - Viewed an estimate but haven't accepted (48h, 5d)
 *   - Estimate is about to expire (1-3 days before)
 *   - Started the deposit payment step but never completed it (2-72h after
 *     the last pending PaymentIntent; gated by
 *     GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS — shadow-logs counts until on)
 *   - Reached the save-a-card accept step (Auto Pay card / one-time hold)
 *     but never accepted (2-72h after the last estimate_checkout_events
 *     touch; email-only; gated by GATE_PAYMENT_STEP_FOLLOWUP —
 *     shadow-logs counts until on)
 *
 * Runs via cron every 2 hours. SMS is primary, email is a second channel —
 * each stage's flag flips once either channel attempts so we don't re-nudge.
 */

const db = require("../models/db");
const EmailTemplateLibrary = require("./email-template-library");
const smsTemplatesRouter = require("../routes/admin-sms-templates");
const logger = require("./logger");
const { shortenOrPassthrough } = require("./short-url");
const { leadIdForEstimate } = require("./estimate-lead-linkage");
const { sendCustomerMessage } = require("./messaging/send-customer-message");
const { inferEstimateServiceInterest } = require("./estimate-service-lines");
const { isEnabled } = require("../config/feature-gates");
const { WAVES_SUPPORT_PHONE_DISPLAY } = require("../constants/business");
const {
  assessDepositFollowUpEligibility,
  DEPOSIT_FOLLOWUP_WINDOW,
} = require("./estimate-deposits");
const { customerConvertedSince } = require("./estimate-conversion-guard");

// ── Safety gates (see: "don't be annoying" PR) ──────────────────────────
// Centralized so the behavior stays consistent across all four stages.

const TERMINAL_STATUSES = new Set(["declined", "accepted", "expired", "void"]);

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

// Unified gate. Returns { skip: true, reason } if the send should be
// blocked, else { skip: false }. Keeps the per-stage loops readable.
async function safetyGate(est, now = new Date()) {
  if (TERMINAL_STATUSES.has(est.status))
    return { skip: true, reason: `terminal-status:${est.status}` };
  if (wasRecentlyOpened(est, 2, now.getTime()))
    return { skip: true, reason: "recently-opened" };
  // Conversion guard: the customer already paid an invoice, booked an
  // appointment after this estimate, or is an active customer — the estimate
  // status just never flipped (booking/invoicing/completion don't write it).
  // Never nag a converted customer to "accept" a quote for work we already
  // did. Fail-closed inside the check; cheap sync gates run first.
  const conv = await customerConvertedSince(est);
  if (conv.converted)
    return { skip: true, reason: `customer-converted:${conv.reason}` };
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

// Atomic stage claim. Flips the stage flag from false/NULL → true and returns
// true only if THIS caller won the race. Two concurrent crons (server restart,
// overlapping runs) both load the same candidate row; the one whose UPDATE
// affects 1 row sends, the other gets 0 rows and skips. Prevents duplicate
// SMS/email to the customer. Re-checks archived_at at claim time: the
// candidate queries filter on it, but a manual/sweep archive landing between
// the read and this UPDATE must still block the send.
async function claimStage(estId, flag, { excludeEngineRuleKeys = [] } = {}) {
  const q = db("estimates")
    .where({ id: estId })
    .whereNull("archived_at")
    .where((qq) => qq.where(flag, false).orWhereNull(flag));
  // Cross-lane dedupe INSIDE the atomic claim (codex 2736 r3): the legacy
  // cron and the engagement engine run under different advisory locks, so
  // the candidate-query whereNotExists alone leaves a read-then-claim race
  // at the 2h boundary. Re-checking the engine ledger in the same UPDATE
  // closes it — if the engine's send landed after our candidate read, this
  // claim affects 0 rows and the stage skips.
  if (excludeEngineRuleKeys.length) {
    q.whereNotExists(function excludeEngineSends() {
      this.select(db.raw("1"))
        .from("estimate_followup_sends")
        .whereRaw("estimate_followup_sends.estimate_id = estimates.id")
        .whereIn("estimate_followup_sends.rule_key", excludeEngineRuleKeys);
    });
  }
  const affected = await q.update({ [flag]: true });
  return affected === 1;
}

// Reverses a claim when the send fails on every channel, so the next cron
// tick retries instead of permanently burning the stage.
async function releaseStage(estId, flag) {
  await db("estimates")
    .where({ id: estId })
    .update({ [flag]: false });
}

function moneySummary(est = {}) {
  // Residential estimate emails never restate a monthly or annual total
  // (owner 2026-07-11) — the linked estimate page leads with per-application
  // pricing, so the email defers to it. One-time totals stay (with cents).
  // Authored commercial proposals are owner-EXEMPT (boards budget annually)
  // and keep their totals in follow-ups too (codex 2642 r2: the drip jobs
  // don't exclude proposal estimates).
  const monthlyTotal = parseFloat(est.monthly_total || est.monthlyTotal || 0);
  const annualTotal = parseFloat(est.annual_total || est.annualTotal || 0);
  const oneTimeTotal = parseFloat(est.onetime_total || est.oneTimeTotal || est.onetimeTotal || 0);
  const proposalEnabled = (() => {
    try {
      const data = typeof est.estimate_data === "string"
        ? JSON.parse(est.estimate_data)
        : (est.estimate_data || est.estimateData);
      return !!data?.proposal?.enabled;
    } catch {
      return false;
    }
  })();
  if (monthlyTotal > 0) {
    if (proposalEnabled) {
      return annualTotal > 0
        ? `$${monthlyTotal.toFixed(2)}/mo · $${annualTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/yr`
        : `$${monthlyTotal.toFixed(2)}/mo`;
    }
    return "Priced per application — full breakdown inside";
  }
  if (oneTimeTotal > 0) return `$${oneTimeTotal.toFixed(2)} one-time`;
  return "";
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
    // Templates render "call {{company_phone}}" lines — a missing payload
    // value renders as an empty string in customer copy.
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
    ...extra,
  };
}

// One tracked short code PER CHANNEL LEG for the dual-channel stages.
// sendDualChannel can send either leg alone — the SMS template can be
// missing/disabled, the SMS can be policy-blocked at send time, or the
// estimate may only carry one contact handle — and the click-followup
// candidate scan (services/click-followup.js) admits sc.channel='sms' links
// only. Reusing a single sms-tagged code in the email payload would let a
// click on an EMAIL-only follow-up masquerade as an SMS click and queue a
// proactive SMS nudge. Minting per leg keeps every click attributable to
// the channel that actually carried it: a leg that never goes out just
// leaves an undelivered (hence unclickable) code behind, which is harmless.
// A leg the estimate can't receive at all (no phone / no email) skips the
// mint and falls back to the long URL — the same graceful degradation
// shortenOrPassthrough already guarantees on shortener failure.
async function mintStageLinks(est, purpose) {
  const longUrl = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
  const base = {
    kind: "estimate",
    entityType: "estimates",
    entityId: est.id,
    customerId: est.customer_id,
    leadId: await leadIdForEstimate(est),
    purpose,
  };
  const smsUrl = est.customer_phone
    ? await shortenOrPassthrough(longUrl, { ...base, channel: "sms" })
    : longUrl;
  const emailUrl = est.customer_email
    ? await shortenOrPassthrough(longUrl, { ...base, channel: "email" })
    : longUrl;
  return { smsUrl, emailUrl };
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
// claimStage() flag is still primary; idempotency is belt-and-suspenders.
async function sendDualChannel(est, { sms, email }) {
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
        metadata: { original_message_type: "estimate_followup" },
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
        // SendGrid rejection bodies can echo the recipient address — keep
        // them out of the provider log; the catch below redacts too.
        suppressProviderErrorLog: true,
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
        `[est-followup] Email failed for estimate ${est.id} (${email.stage}): ${EmailTemplateLibrary.redactEmailAddresses(e.message)}`,
      );
    }
  }
  return attempted;
}

// 5. Deposit started but never completed (2-72h after the last pending
// PaymentIntent). Highest-intent drop-off: the customer clicked accept and
// reached the Stripe card form. Gated separately because it's a
// customer-facing auto-send — until GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS is
// on, candidates are only counted in the log (shadow, no claims) so the
// volume can be judged before anything goes out; the gate arms BOTH
// channels. Dual-channel like the other stages (estimate.deposit_abandoned
// email + estimate_followup_deposit SMS); a claim requires at least one
// deliverable leg, so nothing can silently burn the stage.
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
  const candidates = await db("estimates")
    .join(latestPendingByEstimate, "pd.estimate_id", "estimates.id")
    .whereIn("estimates.status", ["sent", "viewed"])
    .whereNull("estimates.archived_at")
    // Channel-aware: email-only estimates are nudgeable too — they started
    // paying through the tokened estimate page, same audience the deposit
    // receipt email serves.
    .where((q) =>
      q.whereNotNull("estimates.customer_phone").orWhereNotNull("estimates.customer_email"),
    )
    .where("pd.latest_pending_at", "<", new Date(nowMs - DEPOSIT_FOLLOWUP_WINDOW.minAgeHours * 3600000))
    .where("pd.latest_pending_at", ">", new Date(nowMs - DEPOSIT_FOLLOWUP_WINDOW.maxAgeHours * 3600000))
    .where((q) =>
      q
        .where("followup_deposit_abandoned_sent", false)
        .orWhereNull("followup_deposit_abandoned_sent"),
    )
    .select("estimates.*");

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
      // Whole dollars render bare ("$49"); a refund-netted remainder with
      // cents renders exactly ("$29.50") instead of misquoting via round.
      const depositAmountText = Number.isInteger(depositAmount)
        ? String(depositAmount)
        : depositAmount.toFixed(2);
      const { smsUrl, emailUrl } = await mintStageLinks(est, "estimate_followup_deposit");
      const smsBody = est.customer_phone
        ? await renderTemplate("estimate_followup_deposit", {
          first_name: firstName,
          deposit_amount: depositAmountText,
          estimate_url: smsUrl,
        }, {
          workflow: "estimate_follow_up",
          entity_type: "estimate",
          entity_id: est.id,
        })
        : null;
      if (est.customer_phone && !smsBody) {
        logger.warn(
          `[est-followup] estimate_followup_deposit template missing/disabled — continuing without SMS for est ${est.id}`,
        );
      }
      // Portal-wide email opt-out for customer-linked estimates — the
      // template library only enforces email_suppressions, not
      // notification_prefs.email_enabled (same gate the welcome sender
      // applies). Fails CLOSED: an unreadable pref means no email leg this
      // tick; if that leaves zero legs the stage skips WITHOUT claiming and
      // retries next tick.
      let emailAllowed = !!est.customer_email;
      if (emailAllowed && est.customer_id) {
        try {
          const prefs = await db("notification_prefs")
            .where({ customer_id: est.customer_id })
            .first("email_enabled");
          if (prefs?.email_enabled === false) {
            emailAllowed = false;
            logger.info(
              `[est-followup] Deposit-abandoned email leg skipped for est ${est.id} — email disabled in prefs`,
            );
          }
        } catch (err) {
          emailAllowed = false;
          logger.warn(
            `[est-followup] Deposit-abandoned email leg skipped for est ${est.id} — prefs unverifiable: ${err.message}`,
          );
        }
      }
      // At least one deliverable leg or skip WITHOUT claiming — a claim with
      // zero legs would permanently mark the stage sent while sending nothing
      // (the exact silent-skip this stage used to have).
      const emailLeg = emailAllowed
        ? {
          templateKey: "estimate.deposit_abandoned",
          stage: "deposit_abandoned",
          payload: estimateEmailPayload(est, firstName, emailUrl, {
            deposit_amount: depositAmountText,
          }),
        }
        : null;
      if (!smsBody && !emailLeg) {
        logger.warn(
          `[est-followup] Deposit-abandoned skip ${est.id}: no deliverable channel (SMS template off, no email)`,
        );
        continue;
      }
      if (!(await claimStage(est.id, "followup_deposit_abandoned_sent"))) {
        logger.info(
          `[est-followup] Deposit-abandoned skip ${est.id}: lost-claim`,
        );
        continue;
      }
      claimed = true;
      const ok = await sendDualChannel(est, {
        sms: smsBody || undefined,
        email: emailLeg || undefined,
      });
      if (ok) {
        await db("estimates")
          .where({ id: est.id })
          .update({
            follow_up_count: db.raw("COALESCE(follow_up_count, 0) + 1"),
            last_follow_up_at: db.fn.now(),
          });
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
          await releaseStage(est.id, "followup_deposit_abandoned_sent");
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

// ── Stage 6: reached the save-a-card step but never accepted ────────────
// The card-on-file accept flow (recurring Auto Pay card / one-time card
// hold) replaced the retired deposit step. Its SetupIntents live only in
// Stripe; the two intent endpoints stamp estimate_checkout_events, and that
// row's updated_at ("last time the customer touched the payment step") is
// this stage's 2–72h window anchor — same semantics the deposit stage got
// from PaymentIntent reuse. EMAIL-ONLY: the estimate follow-up SMS lane is
// owner-paused. Gated by GATE_PAYMENT_STEP_FOLLOWUP; until it's on,
// candidates are shadow-counted and nothing is claimed or sent.
const PAYMENT_STEP_FOLLOWUP_WINDOW = { minAgeHours: 2, maxAgeHours: 72 };
const PAYMENT_STEP_RULE_KEY = "payment_step_abandoned";
const PAYMENT_STEP_TEMPLATE_KEY = "estimate.payment_step_abandoned";

// Atomic claim on the estimate_followup_sends ledger: the unique
// (estimate_id, rule_key) index means exactly one concurrent cron wins the
// insert. The INSERT selects FROM estimates gated on archived_at, so an
// archive landing between the candidate read and this claim blocks the send
// in the same statement — the same at-claim-time re-check the boolean
// claimStage path does (codex 2729 r2). A send failure deletes the row so
// the next tick retries — the ledger row is the claim AND the attribution
// record.
// Optional atomic guards (codex 2736 r3): blockLegacyFlags re-checks the
// legacy cron's boolean claim columns inside the same statement (closes the
// cross-lane race at the 2h boundary — column names are allowlisted, never
// caller-interpolated), and blockRuleKeys blocks sibling rules that share a
// send budget (e.g. the two expiring variants = one expiry reminder).
const CLAIM_LEGACY_FLAG_COLUMNS = new Set([
  "followup_unviewed_sent",
  "followup_expiring_sent",
]);

async function claimFollowupSend(estimateId, ruleKey, templateKey, trigger, options = {}) {
  const legacyFlags = (options.blockLegacyFlags || []).filter((col) => CLAIM_LEGACY_FLAG_COLUMNS.has(col));
  const siblingKeys = options.blockRuleKeys || [];
  const bindings = [ruleKey, templateKey, JSON.stringify(trigger || {}), estimateId];
  const flagClause = legacyFlags.map((col) => `AND estimates.${col} IS NOT TRUE`).join("\n     ");
  let siblingClause = "";
  if (siblingKeys.length) {
    siblingClause = `AND NOT EXISTS (
       SELECT 1 FROM estimate_followup_sends s2
       WHERE s2.estimate_id = estimates.id
         AND s2.rule_key IN (${siblingKeys.map(() => "?").join(", ")})
     )`;
    bindings.push(...siblingKeys);
  }
  const result = await db.raw(
    `INSERT INTO estimate_followup_sends (estimate_id, rule_key, template_key, trigger)
     SELECT id, ?, ?, ?::jsonb FROM estimates
     WHERE id = ? AND archived_at IS NULL
     ${flagClause}
     ${siblingClause}
     ON CONFLICT (estimate_id, rule_key) DO NOTHING
     RETURNING id`,
    bindings,
  );
  return (result?.rows?.length || 0) === 1;
}

async function releaseFollowupSend(estimateId, ruleKey) {
  await db("estimate_followup_sends")
    .where({ estimate_id: estimateId, rule_key: ruleKey })
    .del();
}

// Atomic post-send bookkeeping (codex 2736 r6): stamping the ledger row's
// counted_at and bumping the estimate's counters happen in ONE statement,
// so a transient failure leaves a clean uncounted row (healable by
// repairFollowupCounters) instead of a half-applied state. Idempotent: an
// already-counted row makes the whole statement a no-op.
async function bumpFollowupCounters(estimateId, ruleKey) {
  await db.raw(
    `WITH counted AS (
       UPDATE estimate_followup_sends SET counted_at = now()
       WHERE estimate_id = ? AND rule_key = ? AND counted_at IS NULL
       RETURNING 1
     )
     UPDATE estimates SET
       follow_up_count = COALESCE(follow_up_count, 0) + 1,
       last_follow_up_at = now()
     WHERE id = ? AND EXISTS (SELECT 1 FROM counted)`,
    [estimateId, ruleKey, estimateId],
  );
}

// Estimate-wide counter heal: applies every uncounted ledger row (any rule,
// payment_step_abandoned included) to follow_up_count/last_follow_up_at in
// one atomic statement. Exact — counts rows rather than guessing from
// timestamps, so a newer successful send can't mask an older lost bump.
// Returns the healed counters (null when nothing was uncounted) so callers
// can overlay a stale in-memory row before judging caps/spacing.
async function repairFollowupCounters(estimateId) {
  const result = await db.raw(
    `WITH uncounted AS (
       UPDATE estimate_followup_sends SET counted_at = now()
       WHERE estimate_id = ? AND counted_at IS NULL
       RETURNING sent_at
     )
     UPDATE estimates SET
       follow_up_count = COALESCE(follow_up_count, 0) + (SELECT count(*) FROM uncounted),
       last_follow_up_at = GREATEST(COALESCE(last_follow_up_at, '-infinity'::timestamptz), (SELECT max(sent_at) FROM uncounted))
     WHERE id = ? AND EXISTS (SELECT 1 FROM uncounted)
     RETURNING follow_up_count, last_follow_up_at`,
    [estimateId, estimateId],
  );
  return result?.rows?.[0] || null;
}

// Fail-CLOSED re-check that the abandoned payment step is still the thing
// standing between this customer and acceptance. Runs the SAME policy
// resolvers the intent endpoints ran (lazy-required to avoid loading the
// route module at boot): an estimate that expired, went invoice-mode,
// gained a saved consented card, or otherwise no longer owes a card must
// not get a "finish saving your card" email. Any resolver error skips the
// send — an unprompted email is never sent on unverifiable policy.
async function paymentStepStillRequiresCard(est, checkoutKind) {
  try {
    const {
      isEstimateAcceptActive,
      isStructuralOneTimeOnlyEstimate,
      resolveEstimateInvoiceMode,
      buildPricingBundle,
      resolveEstimateQuoteRequirement,
      estimateTrenchingReviewRequired,
      reconcileFrozenMembershipSnapshot,
      resolveAcceptOneTimeTotal,
      commercialAcceptDepositExempt,
      isCommercialAutoAcceptEstimate,
      matchAcceptCustomerByPhone,
    } = require("../routes/estimate-public");
    const { commercialLowConfidenceRange } = require("./estimate-delivery-options");
    const { resolveRecurringCardPolicyForEstimate } = require("./recurring-card-on-file");
    const { resolveCardHoldPolicy } = require("./estimate-card-holds");
    const { buildEstimateMembershipContext } = require("./estimate-membership-context");

    if (!isEstimateAcceptActive(est)) return false;
    // Both intent endpoints reconcile the frozen membership snapshot before
    // any pricing/policy read (codex 2729 r3): a stale "existing customer"
    // snapshot would make this re-check disagree with the live endpoint in
    // either direction (skip a customer the endpoint would still card, or
    // vice versa). Mutates est.estimate_data in place, so estData parses
    // AFTER it — same order as the endpoints.
    await reconcileFrozenMembershipSnapshot(est);
    let estData = {};
    try {
      estData = typeof est.estimate_data === "string"
        ? JSON.parse(est.estimate_data)
        : (est.estimate_data || {});
    } catch {
      estData = {};
    }
    // Mirror the intent endpoints' self-serve gates (codex 2729 r2): an
    // estimate edited into quote-required or trenching-review state after
    // the customer touched the payment step can no longer be accepted
    // online — the endpoints 409 before minting, so don't email the
    // customer back into a card step that's now a dead end.
    if (estimateTrenchingReviewRequired(estData)) return false;
    const pricingBundle = await buildPricingBundle(est);
    if (resolveEstimateQuoteRequirement(pricingBundle, estData).quoteRequired) return false;
    // Contact gate, BOTH lanes (codex 2729 r2 + r3): recurring accept is
    // phone-keyed (CUSTOMER_CONTACT_REQUIRED), and a required hold binds a
    // slot/appointment, which accept also refuses without a customer/phone.
    // Don't nudge an email-only estimate into a card step that can't
    // complete online.
    if (!est.customer_id && !est.customer_phone) return false;
    const billByInvoice = resolveEstimateInvoiceMode(est, estData);
    // The event kind records which accept lane the customer was in; a
    // structurally one-time-only estimate can only ever be the hold lane.
    const structurallyOneTime = isStructuralOneTimeOnlyEstimate(estData, est);
    const oneTimeLane = checkoutKind === "card_hold" || structurallyOneTime;
    if (oneTimeLane) {
      // One-time availability (codex 2729 r3): the abandoned intent was a
      // one_time request (the event kind proves it), and /card-hold-intent
      // still 400s that request on a mixed estimate whose one-time choice
      // is now hidden or unpriced — same predicate as the endpoint.
      if (!structurallyOneTime) {
        const oneTimeChoicePrice = resolveAcceptOneTimeTotal(est, pricingBundle);
        const canChooseOneTime = !!est.show_one_time_option && oneTimeChoicePrice > 0;
        if (!canChooseOneTime) return false;
      }
      const hold = resolveCardHoldPolicy({
        treatAsOneTime: true,
        billByInvoice,
        paymentMethodPreference: null,
      });
      if (!hold.required) return false;
      // Mirror the intent endpoint's saved-card auto-satisfy (codex 2729
      // r1): resolveCardHoldPolicy is config-level only — the endpoints
      // additionally 409 ('saved_method') when a consented chargeable card
      // already covers the booking. A customer who gained a saved card
      // after abandoning the hold step owes no capture, so never nudge
      // them to save one. Customer resolution mirrors the endpoint
      // (customer_id, else accept's phone match). Errors fall to the outer
      // catch → fail closed.
      const { findConsentedChargeableCard } = require("./payment-method-consents");
      let holdCustomerId = est.customer_id || null;
      if (!holdCustomerId && est.customer_phone) {
        const { match } = await matchAcceptCustomerByPhone(est);
        holdCustomerId = match?.id || null;
      }
      if (holdCustomerId) {
        const savedCard = await findConsentedChargeableCard(holdCustomerId);
        if (savedCard?.stripe_payment_method_id) return false;
      }
      return true;
    }
    // Commercial manual-billing exemption (codex 2729 r3): the SAME
    // commercialAcceptDepositExempt predicate /recurring-card-intent 409s
    // with 'commercial_manual_billing' — an estimate edited into an
    // auto-priced commercial/manual-billing or site-confirmation-held state
    // collects nothing at accept, so it owes no card nudge.
    const lc = commercialLowConfidenceRange(estData);
    if (commercialAcceptDepositExempt({
      isCommercialAccept: isCommercialAutoAcceptEstimate(est),
      siteConfirmationHold: lc.hasLowConfidence && !lc.forceSiteQuote,
      treatAsOneTime: false,
      billByInvoice,
    })) return false;
    const membership = await buildEstimateMembershipContext(est);
    const policy = await resolveRecurringCardPolicyForEstimate({
      estimate: est,
      membership,
      treatAsOneTime: false,
      billByInvoice,
      paymentMethodPreference: null,
    });
    return !!policy.required;
  } catch (e) {
    logger.warn(
      `[est-followup] payment-step policy re-check failed for estimate ${est.id}: ${e.message}`,
    );
    return false;
  }
}

async function checkPaymentStepAbandoned(now = new Date()) {
  let sent = 0;
  const nowMs = now.getTime();
  // Latest touch per estimate. distinctOn keeps the row's kind (which accept
  // lane the customer was in) — a plain groupBy/max would lose it.
  const latestByEstimate = db("estimate_checkout_events")
    .distinctOn("estimate_id")
    .select("estimate_id", "kind", "updated_at")
    .orderBy([
      { column: "estimate_id" },
      { column: "updated_at", order: "desc" },
    ])
    .as("ce");
  const candidates = await db("estimates")
    .join(latestByEstimate, "ce.estimate_id", "estimates.id")
    .whereIn("estimates.status", ["sent", "viewed"])
    .whereNull("estimates.archived_at")
    // Email is this stage's ONLY channel.
    .whereNotNull("estimates.customer_email")
    .where("ce.updated_at", "<", new Date(nowMs - PAYMENT_STEP_FOLLOWUP_WINDOW.minAgeHours * 3600000))
    .where("ce.updated_at", ">", new Date(nowMs - PAYMENT_STEP_FOLLOWUP_WINDOW.maxAgeHours * 3600000))
    .whereNotExists(function excludeAlreadySent() {
      this.select(db.raw("1"))
        .from("estimate_followup_sends")
        .whereRaw("estimate_followup_sends.estimate_id = estimates.id")
        .where("estimate_followup_sends.rule_key", PAYMENT_STEP_RULE_KEY);
    })
    .select("estimates.*", "ce.kind as checkout_kind", "ce.updated_at as checkout_last_touch_at");

  if (!candidates.length) return 0;
  if (!isEnabled("paymentStepFollowup")) {
    logger.info(
      `[est-followup] Payment-step shadow: ${candidates.length} candidate(s), gate off — no sends`,
    );
    return 0;
  }

  for (const est of candidates) {
    let claimed = false;
    try {
      const gate = await safetyGate(est, now);
      if (gate.skip) {
        logger.info(
          `[est-followup] Payment-step skip ${est.id}: ${gate.reason}`,
        );
        continue;
      }
      if (!(await paymentStepStillRequiresCard(est, est.checkout_kind))) {
        logger.info(
          `[est-followup] Payment-step skip ${est.id}: card-no-longer-required`,
        );
        continue;
      }
      // Portal-wide email opt-out for customer-linked estimates — same gate
      // the deposit stage applies. Fails CLOSED: an unreadable pref means no
      // send this tick (email is the only leg), retry next tick.
      if (est.customer_id) {
        try {
          const prefs = await db("notification_prefs")
            .where({ customer_id: est.customer_id })
            .first("email_enabled");
          if (prefs?.email_enabled === false) {
            logger.info(
              `[est-followup] Payment-step skip ${est.id}: email disabled in prefs`,
            );
            continue;
          }
        } catch (err) {
          logger.warn(
            `[est-followup] Payment-step skip ${est.id}: prefs unverifiable: ${err.message}`,
          );
          continue;
        }
      }
      if (!(await claimFollowupSend(est.id, PAYMENT_STEP_RULE_KEY, PAYMENT_STEP_TEMPLATE_KEY, {
        kind: est.checkout_kind,
        last_touch_at: est.checkout_last_touch_at,
      }))) {
        logger.info(`[est-followup] Payment-step skip ${est.id}: lost-claim`);
        continue;
      }
      claimed = true;
      const firstName = (est.customer_name || "").split(" ")[0] || "there";
      const { emailUrl } = await mintStageLinks(est, "estimate_followup_payment_step");
      const ok = await sendDualChannel(est, {
        email: {
          templateKey: PAYMENT_STEP_TEMPLATE_KEY,
          stage: "payment_step",
          payload: estimateEmailPayload(est, firstName, emailUrl),
        },
      });
      if (ok) {
        // The email is SENT — the ledger row must survive a bookkeeping
        // failure (releasing it would re-email on the next tick). The bump
        // is atomic with the ledger's counted_at stamp; if it fails, the
        // row stays uncounted and repairFollowupCounters heals it before
        // the engine next judges this estimate's caps.
        claimed = false;
        await bumpFollowupCounters(est.id, PAYMENT_STEP_RULE_KEY);
        sent++;
      }
    } catch (e) {
      logger.error(`[est-followup] Payment-step send failed: ${e.message}`);
    } finally {
      if (claimed) {
        try {
          await releaseFollowupSend(est.id, PAYMENT_STEP_RULE_KEY);
        } catch (e) {
          logger.error(
            `[est-followup] Payment-step release failed: ${e.message}`,
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

    // 1. Sent but NOT viewed after 24 hours
    try {
      const unviewed = await db("estimates")
        .where({ status: "sent" })
        .whereNull("archived_at")
        .whereNull("viewed_at")
        .where("sent_at", "<", new Date(Date.now() - 24 * 3600000))
        .where("sent_at", ">", new Date(Date.now() - 48 * 3600000))
        .where((q) =>
          q.whereNotNull("customer_phone").orWhereNotNull("customer_email"),
        )
        .where((q) =>
          q
            .where("followup_unviewed_sent", false)
            .orWhereNull("followup_unviewed_sent"),
        )
        // Engagement-engine dedupe (codex 2736 r2): the engine's
        // delivery_unopened_24h rule targets the same non-view — one
        // unopened nudge per estimate across both lanes. (The engine's
        // sweep/predicate mirror this via followup_unviewed_sent.)
        .whereNotExists(function excludeEngineUnopened() {
          this.select(db.raw("1"))
            .from("estimate_followup_sends")
            .whereRaw("estimate_followup_sends.estimate_id = estimates.id")
            .where("estimate_followup_sends.rule_key", "delivery_unopened_24h");
        });

      for (const est of unviewed) {
        let claimed = false;
        try {
          const gate = await safetyGate(est);
          if (gate.skip) {
            logger.info(
              `[est-followup] Unviewed skip ${est.id}: ${gate.reason}`,
            );
            continue;
          }
          if (!(await claimStage(est.id, "followup_unviewed_sent", {
            excludeEngineRuleKeys: ["delivery_unopened_24h"],
          }))) {
            logger.info(`[est-followup] Unviewed skip ${est.id}: lost-claim`);
            continue;
          }
          claimed = true;
          const firstName = (est.customer_name || "").split(" ")[0] || "there";
          const { smsUrl, emailUrl } = await mintStageLinks(est, "estimate_followup_unviewed");
          const smsBody = await renderTemplate("estimate_followup_unviewed", {
            first_name: firstName,
            estimate_url: smsUrl,
          }, {
            workflow: "estimate_follow_up",
            entity_type: "estimate",
            entity_id: est.id,
          });
          if (!smsBody) {
            logger.warn(
              `[est-followup] estimate_followup_unviewed template missing/disabled — continuing without SMS for est ${est.id}`,
            );
          }
          const ok = await sendDualChannel(est, {
            sms: smsBody,
            email: {
              templateKey: "estimate.unviewed_followup",
              stage: "unviewed",
              payload: estimateEmailPayload(est, firstName, emailUrl),
            },
          });
          if (ok) {
            await db("estimates")
              .where({ id: est.id })
              .update({
                follow_up_count: db.raw("COALESCE(follow_up_count, 0) + 1"),
                last_follow_up_at: db.fn.now(),
              });
            sent++;
            claimed = false; // success path keeps the flag set
          }
          // !ok → claim stays true; finally releases so next tick retries
        } catch (e) {
          logger.error(`[est-followup] Unviewed send failed: ${e.message}`);
        } finally {
          if (claimed) {
            try {
              await releaseStage(est.id, "followup_unviewed_sent");
            } catch (e) {
              logger.error(
                `[est-followup] Unviewed release failed: ${e.message}`,
              );
            }
          }
        }
      }
    } catch {
      /* columns may not exist */
    }

    // 2. Viewed but NOT accepted after 48 hours
    try {
      const viewedNotAccepted = await db("estimates")
        .where({ status: "viewed" })
        .whereNull("archived_at")
        .whereNotNull("viewed_at")
        .where("viewed_at", "<", new Date(Date.now() - 48 * 3600000))
        .where("viewed_at", ">", new Date(Date.now() - 72 * 3600000))
        .where((q) =>
          q.whereNotNull("customer_phone").orWhereNotNull("customer_email"),
        )
        .where((q) =>
          q
            .where("followup_viewed_sent", false)
            .orWhereNull("followup_viewed_sent"),
        );

      for (const est of viewedNotAccepted) {
        let claimed = false;
        try {
          const gate = await safetyGate(est);
          if (gate.skip) {
            logger.info(`[est-followup] Viewed skip ${est.id}: ${gate.reason}`);
            continue;
          }
          if (!(await claimStage(est.id, "followup_viewed_sent"))) {
            logger.info(`[est-followup] Viewed skip ${est.id}: lost-claim`);
            continue;
          }
          claimed = true;
          const firstName = (est.customer_name || "").split(" ")[0] || "there";
          const { smsUrl, emailUrl } = await mintStageLinks(est, "estimate_followup_viewed");
          const smsBody = await renderTemplate("estimate_followup_viewed", {
            first_name: firstName,
            estimate_url: smsUrl,
          }, {
            workflow: "estimate_follow_up",
            entity_type: "estimate",
            entity_id: est.id,
          });
          if (!smsBody) {
            logger.warn(
              `[est-followup] estimate_followup_viewed template missing/disabled — continuing without SMS for est ${est.id}`,
            );
          }
          const ok = await sendDualChannel(est, {
            sms: smsBody,
            email: {
              templateKey: "estimate.viewed_followup",
              stage: "viewed",
              payload: estimateEmailPayload(est, firstName, emailUrl),
            },
          });
          if (ok) {
            await db("estimates")
              .where({ id: est.id })
              .update({
                follow_up_count: db.raw("COALESCE(follow_up_count, 0) + 1"),
                last_follow_up_at: db.fn.now(),
              });
            sent++;
            claimed = false;
          }
        } catch (e) {
          logger.error(
            `[est-followup] Viewed-not-accepted send failed: ${e.message}`,
          );
        } finally {
          if (claimed) {
            try {
              await releaseStage(est.id, "followup_viewed_sent");
            } catch (e) {
              logger.error(
                `[est-followup] Viewed release failed: ${e.message}`,
              );
            }
          }
        }
      }
    } catch {
      /* columns may not exist */
    }

    // 3. Viewed but NOT accepted after 5 days (final nudge)
    try {
      const finalNudge = await db("estimates")
        .where({ status: "viewed" })
        .whereNull("archived_at")
        .whereNotNull("viewed_at")
        .where("viewed_at", "<", new Date(Date.now() - 5 * 86400000))
        .where("viewed_at", ">", new Date(Date.now() - 6 * 86400000))
        .where((q) =>
          q.whereNotNull("customer_phone").orWhereNotNull("customer_email"),
        )
        .where((q) =>
          q
            .where("followup_final_sent", false)
            .orWhereNull("followup_final_sent"),
        );

      for (const est of finalNudge) {
        let claimed = false;
        try {
          const gate = await safetyGate(est);
          if (gate.skip) {
            logger.info(`[est-followup] Final skip ${est.id}: ${gate.reason}`);
            continue;
          }
          if (!(await claimStage(est.id, "followup_final_sent"))) {
            logger.info(`[est-followup] Final skip ${est.id}: lost-claim`);
            continue;
          }
          claimed = true;
          const firstName = (est.customer_name || "").split(" ")[0] || "there";
          const { smsUrl, emailUrl } = await mintStageLinks(est, "estimate_followup_final");
          const smsBody = await renderTemplate("estimate_followup_final", {
            first_name: firstName,
            estimate_url: smsUrl,
          }, {
            workflow: "estimate_follow_up",
            entity_type: "estimate",
            entity_id: est.id,
          });
          if (!smsBody) {
            logger.warn(
              `[est-followup] estimate_followup_final template missing/disabled — continuing without SMS for est ${est.id}`,
            );
          }
          const ok = await sendDualChannel(est, {
            sms: smsBody,
            email: {
              templateKey: "estimate.followup_final",
              stage: "final",
              payload: estimateEmailPayload(est, firstName, emailUrl),
            },
          });
          if (ok) {
            await db("estimates")
              .where({ id: est.id })
              .update({
                follow_up_count: db.raw("COALESCE(follow_up_count, 0) + 1"),
                last_follow_up_at: db.fn.now(),
              });
            sent++;
            claimed = false;
          }
        } catch (e) {
          logger.error(`[est-followup] Final nudge send failed: ${e.message}`);
        } finally {
          if (claimed) {
            try {
              await releaseStage(est.id, "followup_final_sent");
            } catch (e) {
              logger.error(`[est-followup] Final release failed: ${e.message}`);
            }
          }
        }
      }
    } catch {
      /* columns may not exist */
    }

    // 4. Expiring in 1-3 days
    try {
      const expiring = await db("estimates")
        .whereIn("status", ["sent", "viewed"])
        .whereNull("archived_at")
        .whereNotNull("expires_at")
        .where((q) =>
          q.whereNotNull("customer_phone").orWhereNotNull("customer_email"),
        )
        .whereBetween("expires_at", [
          new Date(Date.now() + 1 * 86400000),
          new Date(Date.now() + 3 * 86400000),
        ])
        .where((q) =>
          q
            .where("followup_expiring_sent", false)
            .orWhereNull("followup_expiring_sent"),
        )
        // Engagement-engine dedupe (codex 2736 r2): the engine's expiring_*
        // rules target the same deadline — one expiry reminder per estimate
        // across both lanes. (The engine mirrors via followup_expiring_sent.)
        .whereNotExists(function excludeEngineExpiring() {
          this.select(db.raw("1"))
            .from("estimate_followup_sends")
            .whereRaw("estimate_followup_sends.estimate_id = estimates.id")
            .whereIn("estimate_followup_sends.rule_key", [
              "expiring_engaged",
              "expiring_never_viewed",
            ]);
        });

      for (const est of expiring) {
        let claimed = false;
        try {
          const gate = await safetyGate(est);
          if (gate.skip) {
            logger.info(
              `[est-followup] Expiring skip ${est.id}: ${gate.reason}`,
            );
            continue;
          }
          if (!(await claimStage(est.id, "followup_expiring_sent", {
            excludeEngineRuleKeys: ["expiring_engaged", "expiring_never_viewed"],
          }))) {
            logger.info(`[est-followup] Expiring skip ${est.id}: lost-claim`);
            continue;
          }
          claimed = true;
          const firstName = (est.customer_name || "").split(" ")[0] || "there";
          const { smsUrl, emailUrl } = await mintStageLinks(est, "estimate_followup_expiring");
          const expDate = new Date(est.expires_at).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "America/New_York",
          });
          const smsBody = await renderTemplate("estimate_followup_expiring", {
            first_name: firstName,
            estimate_url: smsUrl,
            expires_at: expDate,
          }, {
            workflow: "estimate_follow_up",
            entity_type: "estimate",
            entity_id: est.id,
          });
          if (!smsBody) {
            logger.warn(
              `[est-followup] estimate_followup_expiring template missing/disabled — continuing without SMS for est ${est.id}`,
            );
          }
          const ok = await sendDualChannel(est, {
            sms: smsBody,
            email: {
              templateKey: "estimate.expiring_notice",
              stage: "expiring",
              payload: {
                ...estimateEmailPayload(est, firstName, emailUrl),
                expires_at: expDate,
              },
            },
          });
          if (ok) {
            await db("estimates")
              .where({ id: est.id })
              .update({
                follow_up_count: db.raw("COALESCE(follow_up_count, 0) + 1"),
                last_follow_up_at: db.fn.now(),
              });
            sent++;
            claimed = false;
          }
        } catch (e) {
          logger.error(`[est-followup] Expiry reminder failed: ${e.message}`);
        } finally {
          if (claimed) {
            try {
              await releaseStage(est.id, "followup_expiring_sent");
            } catch (e) {
              logger.error(
                `[est-followup] Expiring release failed: ${e.message}`,
              );
            }
          }
        }
      }
    } catch {
      /* columns may not exist */
    }

    // 5. Deposit started but never completed
    try {
      sent += await checkDepositAbandoned();
    } catch {
      /* columns may not exist */
    }

    // 6. Reached the save-a-card step but never accepted
    try {
      sent += await checkPaymentStepAbandoned();
    } catch {
      /* tables may not exist */
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
  checkPaymentStepAbandoned,
  paymentStepStillRequiresCard,
  claimFollowupSend,
  releaseFollowupSend,
  bumpFollowupCounters,
  repairFollowupCounters,
  safetyGate,
  claimStage,
  mintStageLinks,
  hasRepliedRecently,
  wasRecentlyOpened,
};
