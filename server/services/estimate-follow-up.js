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
async function claimStage(estId, flag) {
  const affected = await db("estimates")
    .where({ id: estId })
    .whereNull("archived_at")
    .where((q) => q.where(flag, false).orWhereNull(flag))
    .update({ [flag]: true });
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

// 5. Deposit started but never completed (2-72h after the last pending
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
      // At least one deliverable leg or skip WITHOUT claiming — a claim with
      // zero legs would permanently mark the stage sent while sending nothing
      // (the exact silent-skip this stage used to have).
      const emailLeg = est.customer_email
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
        );

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
          if (!(await claimStage(est.id, "followup_unviewed_sent"))) {
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
        );

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
          if (!(await claimStage(est.id, "followup_expiring_sent"))) {
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
  safetyGate,
  claimStage,
  mintStageLinks,
};
