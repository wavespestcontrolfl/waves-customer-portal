const db = require("../../models/db");
const TwilioService = require("../twilio");
const logger = require("../logger");
const { etDateString, addETDays } = require("../../utils/datetime-et");
const { shortenOrPassthrough } = require("../short-url");
const { sendCustomerMessage } = require("../messaging/send-customer-message");
const { renderSmsTemplate } = require("../sms-template-renderer");
const { publicPortalUrl } = require("../../utils/portal-url");

class BalanceReminder {
  async dailyCheck() {
    const today = etDateString();
    const day7 = etDateString(addETDays(new Date(), 7));

    const upcoming = await db("scheduled_services")
      .where("scheduled_date", ">=", today)
      .where("scheduled_date", "<=", day7)
      .whereIn("scheduled_services.status", ["pending", "confirmed"])
      .leftJoin("customers", "scheduled_services.customer_id", "customers.id")
      .where("customers.active", true)
      .whereNotNull("customers.waveguard_tier")
      .select(
        "scheduled_services.*",
        "customers.id as cust_id",
        "customers.first_name",
        "customers.last_name",
        "customers.phone",
        "customers.waveguard_tier",
        "customers.monthly_rate",
        "customers.nearest_location_id",
      );

    let sent = 0;
    for (const service of upcoming) {
      try {
        const balance = await this.getCustomerBalance(service.cust_id);
        if (!balance || balance.totalBalance <= 0) continue;

        const daysUntil = Math.floor(
          (new Date(service.scheduled_date) - new Date()) / 86400000,
        );

        const prevReminders = await db("sms_log")
          .where({
            customer_id: service.cust_id,
            message_type: "balance_reminder",
          })
          .where("created_at", ">", new Date(Date.now() - 14 * 86400000))
          .orderBy("created_at", "desc");

        if (prevReminders.length >= 3) continue;
        if (
          prevReminders.some(
            (r) =>
              new Date(r.created_at).toDateString() ===
              new Date().toDateString(),
          )
        )
          continue;

        let tier;
        if (prevReminders.length === 0 && daysUntil > 3 && daysUntil <= 7)
          tier = "gentle";
        else if (prevReminders.length <= 1 && daysUntil > 1 && daysUntil <= 3)
          tier = "firm";
        else if (daysUntil <= 1) tier = "urgent";
        else continue;

        await this.sendReminder(service, balance, tier, daysUntil);
        sent++;
      } catch (err) {
        logger.error(
          `Balance check failed for ${service.cust_id}: ${err.message}`,
        );
      }
    }
    logger.info(
      `Balance reminder: checked ${upcoming.length} services, sent ${sent} reminders`,
    );
  }

  async getCustomerBalance(customerId) {
    const outstanding = await db("payments")
      .where({ "payments.customer_id": customerId })
      .whereIn("status", ["failed", "upcoming"])
      .where("payment_date", "<", etDateString())
      .orderBy("payment_date", "asc");

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
      .orderByRaw("COALESCE(due_date::timestamp, created_at) asc")
      .first();

    return {
      totalBalance,
      invoiceCount: outstanding.length,
      oldestInvoiceId: oldestInvoice?.id || null,
      oldestInvoiceUrl: oldestInvoice?.token
        ? `${publicPortalUrl()}/pay/${oldestInvoice.token}`
        : `${publicPortalUrl()}/pay/${customerId}`,
      oldestDueDate: oldest.payment_date,
      daysOverdue,
    };
  }

  async sendReminder(service, balance, tier, daysUntil) {
    if (!balance.oldestInvoiceId) {
      throw new Error(
        "balance reminder payment-link SMS skipped: no unpaid invoice id found",
      );
    }
    const datePretty = new Date(
      service.scheduled_date + "T12:00:00",
    ).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "America/New_York",
    });
    const link = await shortenOrPassthrough(balance.oldestInvoiceUrl, {
      kind: "invoice",
      entityType: "invoices",
      entityId: balance.oldestInvoiceId,
      customerId: service.cust_id,
    });

    const serviceTiming = daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
    const message = await renderSmsTemplate(`balance_reminder_${tier}`, {
      first_name: service.first_name || "there",
      service_date: datePretty,
      service_type: service.service_type || "service",
      service_timing: serviceTiming,
      pay_url: link,
    });
    if (!message) {
      throw new Error(`balance_reminder_${tier} template missing/disabled`);
    }

    const sendResult = await sendCustomerMessage({
      to: service.phone,
      body: message,
      channel: "sms",
      audience: "customer",
      purpose: "payment_link",
      customerId: service.cust_id,
      invoiceId: balance.oldestInvoiceId,
      entryPoint: "balance_reminder_workflow",
      metadata: { original_message_type: "balance_reminder" },
    });
    if (sendResult.blocked || sendResult.sent === false) {
      throw new Error(
        `balance reminder SMS blocked: ${sendResult.code || sendResult.reason || "unknown"}`,
      );
    }

    await db("customer_interactions").insert({
      customer_id: service.cust_id,
      interaction_type: "sms_outbound",
      subject: `Balance reminder (${tier})`,
      body: `Sent ${tier} reminder. Service: ${datePretty}. Days until: ${daysUntil}.`,
      metadata: JSON.stringify({
        tier,
        balance: balance.totalBalance,
        daysUntil,
        daysOverdue: balance.daysOverdue,
      }),
    });

    if (balance.daysOverdue >= 30 && tier === "urgent") {
      const amt = balance.totalBalance.toFixed(2);
      await TwilioService.sendSMS(
        process.env.ADAM_PHONE || "+19413187612",
        `💰 Overdue: ${service.first_name} ${service.last_name} — $${amt} (${balance.daysOverdue} days). Service ${daysUntil === 0 ? "today" : "tomorrow"}.`,
        { messageType: "internal_alert" },
      );
    }
  }

  async latePaymentCheck() {
    const customers = await db("customers")
      .where({ active: true })
      .whereNotNull("waveguard_tier");

    let sent = 0;
    for (const customer of customers) {
      const balance = await this.getCustomerBalance(customer.id);
      if (!balance || balance.totalBalance <= 0 || balance.daysOverdue < 7)
        continue;

      const prevCount = await db("sms_log")
        .where({ customer_id: customer.id, message_type: "late_payment" })
        .where("created_at", ">", new Date(Date.now() - 90 * 86400000))
        .count("* as count")
        .first();
      const count = parseInt(prevCount?.count || 0);

      const sentRecently = await db("sms_log")
        .where({ customer_id: customer.id, message_type: "late_payment" })
        .where("created_at", ">", new Date(Date.now() - 7 * 86400000))
        .first();
      if (sentRecently) continue;

      // Get oldest unpaid invoice for title and service date
      const oldestInvoice = await db("invoices")
        .where({ customer_id: customer.id })
        .whereIn("status", ["sent", "overdue", "unpaid"])
        .orderByRaw("COALESCE(due_date::timestamp, created_at) asc")
        .first();
      if (!oldestInvoice?.id || !oldestInvoice?.token) {
        logger.warn(
          `[balance-reminder] late-payment SMS skipped for customer ${customer.id}: no unpaid invoice id/token found`,
        );
        continue;
      }
      const link = await shortenOrPassthrough(
        `${publicPortalUrl()}/pay/${oldestInvoice.token}`,
        {
          kind: "invoice",
          entityType: "invoices",
          entityId: oldestInvoice.id,
          customerId: customer.id,
        },
      );
      const invoiceTitle =
        oldestInvoice?.title || oldestInvoice?.service_type || "your service";
      let completedOn = "";
      if (oldestInvoice?.service_date) {
        try {
          completedOn = new Date(
            oldestInvoice.service_date + "T12:00:00",
          ).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "America/New_York",
          });
        } catch {
          completedOn = "";
        }
      }
      const dateClause = completedOn ? ` completed on ${completedOn}` : "";

      let message;
      let templateKey;

      if (balance.daysOverdue >= 7 && balance.daysOverdue < 14 && count === 0) {
        templateKey = "late_payment_7d";
      } else if (
        balance.daysOverdue >= 14 &&
        balance.daysOverdue < 30 &&
        count <= 1
      ) {
        templateKey = "late_payment_14d";
      } else if (
        balance.daysOverdue >= 30 &&
        balance.daysOverdue < 60 &&
        count <= 2
      ) {
        templateKey = "late_payment_30d";
      } else if (
        balance.daysOverdue >= 60 &&
        balance.daysOverdue < 90 &&
        count <= 3
      ) {
        templateKey = "late_payment_60d";
        await db("customers")
          .where({ id: customer.id })
          .update({
            pipeline_stage: "at_risk",
            pipeline_stage_changed_at: new Date(),
          });
      } else if (balance.daysOverdue >= 90 && count <= 4) {
        templateKey = "late_payment_90d";
        await db("customers")
          .where({ id: customer.id })
          .update({
            pipeline_stage: "at_risk",
            pipeline_stage_changed_at: new Date(),
          });
      } else continue;

      if (templateKey) {
        message = await renderSmsTemplate(templateKey, {
          first_name: customer.first_name || "there",
          invoice_title: invoiceTitle,
          service_date: completedOn || "your service date",
          service_date_clause: dateClause,
          pay_url: link,
        });
      }

      if (!message) {
        logger.warn(
          `[balance-reminder] ${templateKey} template missing/disabled — skipping customer ${customer.id}`,
        );
        continue;
      }

      const sendResult = await sendCustomerMessage({
        to: customer.phone,
        body: message,
        channel: "sms",
        audience: "customer",
        purpose: "payment_link",
        customerId: customer.id,
        invoiceId: oldestInvoice.id,
        entryPoint: "balance_reminder_late_payment_check",
        metadata: { original_message_type: "late_payment" },
      });
      if (sendResult.blocked || sendResult.sent === false) {
        logger.warn(
          `[balance-reminder] late-payment SMS blocked for customer ${customer.id}: ${sendResult.code || "unknown"} ${sendResult.reason || ""}`,
        );
        continue;
      }
      await db("customer_interactions").insert({
        customer_id: customer.id,
        interaction_type: "sms_outbound",
        subject: `Late payment tier ${count + 1} — ${balance.daysOverdue} days`,
        body: `$${balance.totalBalance.toFixed(2)} overdue ${balance.daysOverdue} days. Tier ${count + 1} sent.`,
      });
      sent++;
    }
    logger.info(`Late payment check: sent ${sent} reminders`);
  }

  async onPaymentReceived(customerId, amount) {
    const customer = await db("customers").where({ id: customerId }).first();
    if (!customer) return;

    const recentReminder = await db("sms_log")
      .where({ customer_id: customerId })
      .whereIn("message_type", ["balance_reminder", "late_payment"])
      .where("created_at", ">", new Date(Date.now() - 7 * 86400000))
      .first();

    if (recentReminder) {
      const body = await renderSmsTemplate("balance_payment_received", {
        first_name: customer.first_name || "there",
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
