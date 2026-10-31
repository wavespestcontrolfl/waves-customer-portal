const db = require("../../models/db");
const TwilioService = require("../twilio");
const logger = require("../logger");
const { etDateString, addETDays } = require("../../utils/datetime-et");
const { sendCustomerMessage } = require("../messaging/send-customer-message");
const { renderSmsTemplate } = require("../sms-template-renderer");
const { publicPortalUrl } = require("../../utils/portal-url");
const { dateOnlyString } = require("../../utils/date-only");

// Balance reminders. The legacy pre-visit tiers (dailyCheck) and the account
// late-payment ladder (latePaymentCheck) are gone: the pre-visit balance
// reminder (previsit-balance-reminder.js) and the invoice follow-up ladder
// (invoice-followups.js, Day 3-90, with orphan adoption) own those texts and
// emails. What stays here is the one duty neither has an equivalent for, the
// internal heads-up to the owner, plus the balance read and the
// payment-received thank-you.

// Account-level reminders stop if ANY invoice behind the balance is held.
// Read failures skip this run.
async function customerDunningStopped(balance, selectedInvoiceId) {
  try {
    const ids = [...new Set([
      ...(balance.invoiceIds || []), balance.oldestInvoiceId, selectedInvoiceId,
    ].filter(Boolean).map(String))];
    if (!ids.length) return false;
    const InvoiceFollowUps = require('../invoice-followups');
    for (const id of ids) {
      if (await InvoiceFollowUps.hasActiveSequence(id)) return true;
      if (await InvoiceFollowUps.isDunningStopped(id)) return true;
    }
    const activePlan = await db('payment_plans')
      .whereIn('invoice_id', ids)
      .where({ status: 'active' })
      .first('id');
    if (activePlan) return true;
    const rows = await db('invoices')
      .whereIn('id', ids)
      .whereNotNull('stripe_payment_intent_id')
      .select('id', 'stripe_payment_intent_id');
    const StripeService = require('../stripe');
    for (const inv of rows) {
      if (await StripeService.isInvoiceAwaitingMicrodepositVerification(inv, { throwOnError: true })) return true;
    }
    return false;
  } catch (err) {
    logger.warn(`[balance-reminder] dunning-stop check failed — skipping this customer's reminder this run (fail closed): ${err.message}`);
    return true;
  }
}

class BalanceReminder {
  // The one duty of the old daily reminder that the pre-visit reminder has no
  // equivalent for: an internal heads-up to ADAM_PHONE when a customer with a
  // balance at least 30 days overdue has service today or tomorrow. It runs
  // on its own from the 11:00 cron, independent of whether a customer
  // reminder is sent by anything (the pre-visit reminder's own send is a
  // separate, narrower trigger: recurring-lane debt only, up to leadDays()
  // out).
  async imminentOverdueOwnerAlertSweep() {
    const today = etDateString();
    const tomorrow = etDateString(addETDays(new Date(), 1));
    const upcoming = await db("scheduled_services")
      .where("scheduled_date", ">=", today)
      .where("scheduled_date", "<=", tomorrow)
      .whereIn("scheduled_services.status", ["pending", "confirmed"])
      .leftJoin("customers", "scheduled_services.customer_id", "customers.id")
      .where("customers.active", true)
      .whereNull("customers.deleted_at")
      .whereNotNull("customers.waveguard_tier")
      .select(
        "scheduled_services.*",
        "customers.id as cust_id",
        "customers.first_name",
        "customers.last_name",
      );
    // One alert per customer per visit day: several services on the same
    // day must produce one alert, not one each (Codex #5294 r1 P2).
    const alerted = new Set();
    for (const service of upcoming) {
      try {
        const alertKey = `${service.cust_id}:${dateOnlyString(service.scheduled_date)}`;
        if (alerted.has(alertKey)) continue;
        const balance = await this.getCustomerBalance(service.cust_id);
        // Scope: a real balance (totalBalance > 0) on an unpaid invoice
        // (oldestInvoiceId).
        if (!balance || balance.totalBalance <= 0 || balance.daysOverdue < 30 || !balance.oldestInvoiceId) continue;
        // scheduled_date is a DATE column — comparing it against `new Date()`
        // as instants (Codex P1) shifts by TZ: on Railway (TZ=UTC) a DATE
        // parses to UTC midnight, and this cron runs ~10 AM ET (~14:00 UTC),
        // so today's visit floors to -1 (skipped) and tomorrow's floors to 0
        // (mislabeled "today"). Compare calendar dates instead —
        // dateOnlyString reads the stored date with no TZ shift, same as the
        // query above that selected this row by scheduled_date.
        const serviceDateEt = dateOnlyString(service.scheduled_date);
        if (serviceDateEt !== today && serviceDateEt !== tomorrow) continue;
        if (await customerDunningStopped(balance)) continue;
        const daysUntil = serviceDateEt === today ? 0 : 1;
        await TwilioService.sendSMS(
          process.env.ADAM_PHONE || "+19415993489",
          `💰 Overdue: ${service.first_name} ${service.last_name} — $${balance.totalBalance.toFixed(2)} (${balance.daysOverdue} days). Service ${daysUntil === 0 ? "today" : "tomorrow"}.`,
          { messageType: "internal_alert" },
        );
        alerted.add(alertKey);
      } catch (err) {
        logger.error(`Imminent overdue owner alert failed for ${service.cust_id}: ${err.message}`);
      }
    }
  }

  async getCustomerBalance(customerId) {
    const allOutstanding = await db("payments")
      .where({ "payments.customer_id": customerId })
      .whereIn("status", ["failed", "upcoming"])
      .whereNull("superseded_by_payment_id")
      .where("payment_date", "<", etDateString())
      .orderBy("payment_date", "asc");

    // Third-party Bill-To: a payer-billed invoice's payment rows sit under the
    // homeowner's customer_id but are the payer's debt — drop them so an AP
    // ACH/card failure doesn't inflate the homeowner's balance / overdue age and
    // trigger an early or incorrect balance reminder.
    const payerInvRows = await db("invoices")
      .where({ customer_id: customerId })
      // payer_id OR the withdrawal stamp (Codex #4311 r43 P1): a combined-visit
      // invoice withdrawn to a payer keeps payer_id NULL, so an id-only test
      // let its failed AP payments inflate the homeowner's balance.
      .where(function payerOwned() {
        this.whereNotNull("payer_id").orWhere("scheduled_send_error", "like", "payer_billed:%");
      })
      .select("id")
      .catch(() => []);
    const payerInvoiceIds = new Set(payerInvRows.map((r) => String(r.id)));
    const paymentInvoiceId = (p) => {
      try {
        const m = typeof p.metadata === "string" ? JSON.parse(p.metadata) : p.metadata;
        return m && m.invoice_id != null ? String(m.invoice_id) : null;
      } catch {
        return null;
      }
    };
    const isPayerPayment = (p) => {
      const invId = paymentInvoiceId(p);
      return !!(invId && payerInvoiceIds.has(invId));
    };
    const outstanding = payerInvoiceIds.size === 0
      ? allOutstanding
      : allOutstanding.filter((p) => !isPayerPayment(p));

    if (!outstanding.length) return null;

    const totalBalance = outstanding.reduce(
      (sum, p) => sum + parseFloat(p.amount || 0),
      0,
    );
    const oldest = outstanding[0];
    const daysOverdue = Math.max(
      0,
      Math.floor((Date.now() - new Date(oldest.payment_date)) / 86400000),
    );
    const oldestInvoice = await db("invoices")
      .where({ customer_id: customerId })
      .whereIn("status", ["sent", "viewed", "overdue", "unpaid"])
      // Third-party Bill-To: never surface a payer-billed invoice as the
      // homeowner's oldest unpaid invoice / pay link — AR routes to the payer.
      // The withdrawal stamp is the same ownership move on a row whose
      // payer_id stays NULL (Codex #4311 r43 P1).
      .whereNull("payer_id")
      .where(function notWithdrawn() {
        this.whereNull("scheduled_send_error").orWhereNot("scheduled_send_error", "like", "payer_billed:%");
      })
      .orderByRaw("COALESCE(due_date::timestamp, created_at) asc")
      .first();

    // Include payment-linked debt as well as the invoice chosen for the link.
    const invoiceIds = [...new Set([
      ...outstanding.map((p) => paymentInvoiceId(p)).filter(Boolean),
      ...(oldestInvoice?.id ? [String(oldestInvoice.id)] : []),
    ])];

    return {
      totalBalance,
      invoiceIds,
      invoiceCount: outstanding.length,
      oldestInvoiceId: oldestInvoice?.id || null,
      // /pay/ is keyed by the invoice token only — a customer id there opens a
      // "not found" pay page, so a tokenless invoice gets no link at all.
      oldestInvoiceUrl: oldestInvoice?.token
        ? `${publicPortalUrl()}/pay/${oldestInvoice.token}`
        : null,
      oldestDueDate: oldest.payment_date,
      daysOverdue,
    };
  }

  async onPaymentReceived(customerId, amount) {
    const customer = await db("customers").where({ id: customerId }).first();
    // Archived customers get no outbound asks — event-driven path, so the
    // cron-side deleted_at filters don't cover it.
    if (!customer || customer.deleted_at) return;

    const recentReminder = await db("sms_log")
      .where({ customer_id: customerId })
      .whereIn("message_type", ["balance_reminder", "late_payment"])
      .where("created_at", ">", new Date(Date.now() - 7 * 86400000))
      .first();

    if (recentReminder) {
      const body = await renderSmsTemplate("balance_payment_received", {
        first_name: customer.first_name || "there",
      }, {
        workflow: "balance_payment_received",
        entity_type: "customer",
        entity_id: customerId,
      });
      if (!body) {
        logger.warn(
          `[balance-reminder] balance_payment_received template missing/disabled — skipping customer ${customerId}`,
        );
      } else {
        const sendResult = await sendCustomerMessage({
          to: customer.phone,
          body,
          channel: "sms",
          audience: "customer",
          purpose: "payment_receipt",
          customerId,
          entryPoint: "balance_reminder_payment_received",
          metadata: { original_message_type: "confirmation" },
        });
        if (sendResult.blocked || sendResult.sent === false) {
          logger.warn(
            `[balance-reminder] payment thank-you SMS blocked for customer ${customerId}: ${sendResult.code || "unknown"} ${sendResult.reason || ""}`,
          );
        }
      }
    }

    if (customer.pipeline_stage === "at_risk") {
      const remaining = await this.getCustomerBalance(customerId);
      if (!remaining || remaining.totalBalance <= 0) {
        await db("customers")
          .where({ id: customerId })
          .update({
            pipeline_stage: "active_customer",
            pipeline_stage_changed_at: new Date(),
          });
      }
    }
  }
}

module.exports = new BalanceReminder();
