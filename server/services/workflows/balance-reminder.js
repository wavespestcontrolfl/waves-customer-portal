const db = require("../../models/db");
const TwilioService = require("../twilio");
const logger = require("../logger");
const { etDateString, addETDays } = require("../../utils/datetime-et");
const { shortenOrPassthrough } = require("../short-url");
const { sendCustomerMessage } = require("../messaging/send-customer-message");
const { renderSmsTemplate } = require("../sms-template-renderer");
const { publicPortalUrl } = require("../../utils/portal-url");
const EmailTemplateLibrary = require("../email-template-library");
const { currency } = require("../email-template");
const { dateOnlyString, formatDateOnly } = require("../../utils/date-only");
const { WAVES_SUPPORT_PHONE_DISPLAY } = require("../../constants/business");
const { collectionsChannelPermitted } = require("../collections/rail-guard");
const ContactLedger = require("../collections/contact-ledger");
const { billingChannelAllowed, explicitBillingChannels } = require('../billing-delivery-channels');
const { reminderProgress, sendReminderChannels } = require('../billing-reminder-delivery');
const { dispatchUnderBillingEmailAuthority } = require('../billing-channel-email-authority');
const { billingEmailRecipient, billingEmailSendOutcome, billingEmailSendFailure } = require('../billing-email-sender');
const { originalBillingContactArgs, previouslySettledBillingLegs } = require('../messaging/billing-channel-routing');

async function markReminderDelivery(ledger, result) {
  return ContactLedger.markDelivered(ledger, ...originalBillingContactArgs(result));
}

const LATE_PAYMENT_EMAIL_BY_SMS_TEMPLATE = {
  late_payment_7d: { templateKey: "billing_late_payment_7_day", stageDays: 7 },
  late_payment_14d: { templateKey: "billing_late_payment_14_day", stageDays: 14 },
  late_payment_30d: { templateKey: "billing_late_payment_30_day", stageDays: 30 },
  late_payment_60d: { templateKey: "billing_late_payment_60_day", stageDays: 60 },
  late_payment_90d: { templateKey: "billing_late_payment_90_day", stageDays: 90 },
};

const EMAIL_ELIGIBLE_INVOICE_STATUSES = new Set(["sent", "viewed", "overdue", "unpaid"]);
// Overdue stage thresholds, highest first; below 14 days is the 7-day stage.
const LATE_PAYMENT_STAGE_DAYS = [90, 60, 30, 14];
const CONTACT_EMAIL = "contact@wavespestcontrol.com";

// The invoice title and service-date phrasing every late-payment text
// renders, shared by the explicit-channel and legacy paths.
function latePaymentCopy(invoice) {
  const completedOn = formatDateOnly(invoice?.service_date);
  return {
    invoiceTitle: invoice?.title || invoice?.service_type || "your service",
    completedOn,
    dateClause: completedOn ? ` completed on ${completedOn}` : "",
  };
}

function smsLogMetadata(row) {
  try {
    return (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) || {};
  } catch {
    return {};
  }
}

// Account-level reminders stop if ANY invoice behind the balance is held.
// Read failures skip this run; late-payment-checker owns verification nudges.
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

function invoiceCanReceiveLatePaymentEmail(invoice) {
  if (!invoice?.id || !invoice?.token) return false;
  const status = String(invoice.status || "").toLowerCase();
  if (!EMAIL_ELIGIBLE_INVOICE_STATUSES.has(status)) return false;
  if (invoice.deleted_at || invoice.written_off_at || invoice.write_off_at || invoice.cancelled_at || invoice.canceled_at) return false;
  if (invoice.paid_at) return false;
  return true;
}

function latePaymentPayload({ customer, invoice, balance, invoiceTitle, serviceDateClause, payUrl }) {
  const fallbackDueDate = invoice.due_date || balance.oldestDueDate || invoice.created_at;
  return {
    first_name: customer.first_name || "there",
    invoice_title: invoiceTitle || invoice.title || invoice.service_type || "your service",
    service_date_clause: serviceDateClause || "",
    pay_url: payUrl,
    amount_due: currency(balance.totalBalance || invoice.total || 0),
    due_date: formatDateOnly(fallbackDueDate, { fallback: "" }),
    invoice_number: invoice.invoice_number || "",
    customer_portal_url: `${publicPortalUrl()}/?tab=billing`,
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
    company_email: CONTACT_EMAIL,
  };
}

async function logLatePaymentEmailAttempt({
  customerId,
  invoiceId,
  templateKey,
  stageDays,
  status,
  providerMessageId = null,
  sentAt = null,
  failureReason = null,
}) {
  try {
    await db("customer_interactions").insert({
      customer_id: customerId,
      interaction_type: "email_outbound",
      subject: `${stageDays}-day late payment email ${status}`,
      body: failureReason
        ? `Late payment email ${status}: ${failureReason}`
        : `${stageDays}-day late payment email ${status}.`,
      metadata: JSON.stringify({
        invoice_id: invoiceId,
        customer_id: customerId,
        template_key: templateKey,
        overdue_stage_days: stageDays,
        channel: "email",
        provider_message_id: providerMessageId,
        status,
        sent_at: sentAt,
        failure_reason: failureReason,
      }),
    });
  } catch (err) {
    logger.warn(`[balance-reminder] late-payment email audit log failed for invoice ${invoiceId}: ${err.message}`);
  }
}

class BalanceReminder {
  // GATE_BALANCE_REMINDER_LEGACY_OFF, read at call time (strict 'true'):
  // dailyCheck() retires ONLY once its replacement — the pre-visit balance
  // reminder — is actually live, not merely on the newer 5-day window.
  // GATE_PREVISIT_BALANCE_5DAY only changes that reminder's lead window and
  // says nothing about whether it runs at all; the reminder itself needs
  // BOTH of its own dark levers — PREVISIT_BALANCE_REMINDER=true AND its
  // seeded previsit_balance_reminder SMS template active — or its 10:05
  // sweep returns inert too (dunning unification round-2 review, Codex P2).
  // Legacy-off with either lever still dark logs a warning and keeps
  // dailyCheck's legacy body running unchanged, so upcoming customers are
  // never left with no pre-visit balance nudge at all.
  async dailyCheckRetired() {
    if (process.env.GATE_BALANCE_REMINDER_LEGACY_OFF !== 'true') return false;
    const PrevisitBalanceReminder = require('../previsit-balance-reminder');
    if (!PrevisitBalanceReminder.gateEnabled() || !(await PrevisitBalanceReminder.smsTemplateActive())) {
      logger.warn('[balance-reminders] GATE_BALANCE_REMINDER_LEGACY_OFF ignored for dailyCheck: the pre-visit balance reminder replacement (PREVISIT_BALANCE_REMINDER + its SMS template) is not live yet');
      return false;
    }
    return true;
  }

  // The one dailyCheck() duty the pre-visit reminder carries no equivalent
  // for (Codex P2, round 2): an internal heads-up to ADAM_PHONE when a
  // customer with a balance at least 30 days overdue has service today or
  // tomorrow. Kept running on its own once dailyCheck retires — same
  // threshold, same copy, independent of whether a customer reminder is
  // sent by anything (the pre-visit reminder's own send is a separate,
  // narrower trigger: recurring-lane debt only, up to leadDays() out).
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
    // day used to produce one alert (the legacy reminder's same-day history
    // check suppressed the rest), so dedupe here too (Codex #5294 r1 P2).
    const alerted = new Set();
    for (const service of upcoming) {
      try {
        const alertKey = `${service.cust_id}:${dateOnlyString(service.scheduled_date)}`;
        if (alerted.has(alertKey)) continue;
        const balance = await this.getCustomerBalance(service.cust_id);
        // Same scope the legacy alert had: a real balance (dailyCheck skipped
        // totalBalance <= 0) on an unpaid invoice (sendReminder needed one
        // before it alerted).
        if (!balance || balance.totalBalance <= 0 || balance.daysOverdue < 30 || !balance.oldestInvoiceId) continue;
        // scheduled_date is a DATE column — comparing it against `new Date()`
        // as instants (Codex P1) shifts by TZ: on Railway (TZ=UTC) a DATE
        // parses to UTC midnight, and this cron runs ~10 AM ET (~14:00 UTC),
        // so today's visit floors to -1 (skipped) and tomorrow's floors to 0
        // (mislabeled "today"). Compare calendar dates instead —
        // dateOnlyString reads the stored date with no TZ shift, same as the
        // legacy query above that selected this row by scheduled_date.
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

  async dailyCheck() {
    if (await this.dailyCheckRetired()) {
      logger.info('[balance-reminders] dailyCheck retired: GATE_BALANCE_REMINDER_LEGACY_OFF, the pre-visit balance reminder owns these now');
      await this.imminentOverdueOwnerAlertSweep();
      return;
    }
    const today = etDateString();
    const day7 = etDateString(addETDays(new Date(), 7));

    const upcoming = await db("scheduled_services")
      .where("scheduled_date", ">=", today)
      .where("scheduled_date", "<=", day7)
      .whereIn("scheduled_services.status", ["pending", "confirmed"])
      .leftJoin("customers", "scheduled_services.customer_id", "customers.id")
      .where("customers.active", true)
      .whereNull("customers.deleted_at")
      // AR / balance reminders are about money owed, NOT WaveGuard membership —
      // keep flat commercial accounts (they carry balances too).
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

        let channels = null;
        try {
          channels = explicitBillingChannels(await db('notification_prefs').where({ customer_id: service.cust_id }).first() || {}, 'billing');
        } catch {
          logger.warn('Balance reminder skipped: delivery preferences unavailable');
          continue;
        }
        const progress = channels ? await reminderProgress(service.cust_id, 'balance_reminder_workflow', channels) : [];
        const pending = progress.find((event) => !event.complete
          && event.metadata.invoiceId === balance.oldestInvoiceId
          && event.metadata.scheduledDate === formatDateOnly(service.scheduled_date));
        if (pending) {
          if (await this.sendReminder(service, balance, pending.metadata.tier, daysUntil)) sent++;
          continue;
        }
        const smsHistory = await db("sms_log")
          .where({
            customer_id: service.cust_id,
            message_type: "balance_reminder",
          })
          .where("created_at", ">", new Date(Date.now() - 14 * 86400000))
          .orderBy("created_at", "desc");
        // Explicit channels count every keyed episode with a delivered leg
        // (a partially delivered episode still reached the customer) plus
        // the legacy sms_log history: a reminder texted before the
        // customer's first channel save carries no event key and must still
        // consume the 14-day allowance. An sms_log row is skipped only when
        // its episode was counted here, so a keyed Text is counted once.
        const window = new Date(Date.now() - 14 * 86400000);
        const counted = progress.filter((event) => event.deliveredAt && new Date(event.deliveredAt) > window);
        const countedKeys = new Set(counted.map((event) => event.metadata.notificationEventKey));
        const prevReminders = channels ? [
          ...counted.map((event) => ({ created_at: event.deliveredAt })),
          ...smsHistory.filter((row) => !countedKeys.has(smsLogMetadata(row).notificationEventKey)),
        ] : smsHistory;

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

        // A policy hold or ledger outage returns false — a skip, not a
        // send (codex r-gh2: the counter claimed sends that never left).
        if ((await this.sendReminder(service, balance, tier, daysUntil)) !== false) sent++;
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

  async sendReminder(service, balance, tier, daysUntil) {
    if (await customerDunningStopped(balance)) return false;
    if (!balance.oldestInvoiceId || !balance.oldestInvoiceUrl) {
      throw new Error(
        "balance reminder payment-link SMS skipped: no unpaid invoice id/token found",
      );
    }
    // Collections policy (gate off ⇒ permitted without consulting — this
    // rail stays byte-identical, pinned). A denial is a quiet skip, not a
    // thrown error: policy holds are expected states, not failures.
    let selectedChannels = null;
    try {
      selectedChannels = explicitBillingChannels(await db('notification_prefs').where({ customer_id: service.cust_id }).first() || {}, 'billing');
    } catch {
      logger.warn('Balance reminder skipped: delivery preferences unavailable');
      return false;
    }
    if (!selectedChannels && !(await collectionsChannelPermitted({
      customerId: service.cust_id,
      invoiceId: balance.oldestInvoiceId,
      channel: "sms",
      purpose: "balance_reminder",
      source: "balance_reminder_workflow",
      logTag: "balance-reminder",
    }))) {
      return false;
    }
    // scheduled_date arrives as a JS Date (pg `date` column), not a string —
    // string concatenation here rendered "Invalid Date" into customer SMS.
    const datePretty = formatDateOnly(service.scheduled_date, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: undefined,
    });
    const appointmentDate = dateOnlyString(service.scheduled_date);
    const appointmentServiceType = service.service_type || "service";
    const link = await shortenOrPassthrough(balance.oldestInvoiceUrl, {
      kind: "invoice",
      entityType: "invoices",
      entityId: balance.oldestInvoiceId,
      customerId: service.cust_id,
    });

    const appointmentRenderedOn = etDateString();
    const serviceTiming = daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
    const message = await renderSmsTemplate(`balance_reminder_${tier}`, {
      first_name: service.first_name || "there",
      service_date: datePretty,
      service_type: appointmentServiceType,
      service_timing: serviceTiming,
      pay_url: link,
    }, {
      workflow: `balance_reminder_${tier}`,
      entity_type: "invoice",
      entity_id: balance.oldestInvoiceId,
    });
    if (!message) {
      throw new Error(`balance_reminder_${tier} template missing/disabled`);
    }

    if (selectedChannels) {
      const eventKey = `balance-reminder:${balance.oldestInvoiceId}:${tier}:${formatDateOnly(service.scheduled_date)}`;
      const result = await sendReminderChannels({
        customerId: service.cust_id, invoiceId: balance.oldestInvoiceId,
        source: 'balance_reminder_workflow', purpose: 'balance_reminder', eventKey,
        channels: selectedChannels, metadata: { tier, days_until: daysUntil,
          invoiceId: balance.oldestInvoiceId, scheduledDate: formatDateOnly(service.scheduled_date) },
        send: (channel, ledger) => sendCustomerMessage({
          to: service.phone, body: message, channel,
          audience: 'customer', purpose: 'payment_link', customerId: service.cust_id,
          invoiceId: balance.oldestInvoiceId, appointmentId: service.id,
          entryPoint: 'balance_reminder_workflow',
          metadata: { original_message_type: 'balance_reminder', billingDeliveryCategory: 'billing',
            notificationEventKey: eventKey, billingDeliveryLeg: channel,
            appointment_date: appointmentDate,
            appointment_service_type: appointmentServiceType,
            appointment_rendered_on: appointmentRenderedOn,
            ...(channel === 'push' ? { appOnly: true } : {}),
            // A queued Email retry re-checks the collections rail excluding
            // this leg's own reservation, then marks it delivered.
            ...(channel === 'email' && ledger?.id ? { collections_ledger_id: ledger.id } : {}) },
          preDispatchCheck: require('../invoice-helpers').selfPayAtDispatch(balance.oldestInvoiceId, db),
        }),
      });
      for (const channel of result.deliveredNow) await db('customer_interactions').insert({
        customer_id: service.cust_id, interaction_type: `${channel}_outbound`,
        subject: `Balance reminder (${tier})`, body: `Sent ${tier} reminder via ${channel}.`,
        metadata: JSON.stringify({ tier, channel, notificationEventKey: eventKey }),
      });
      if (result.complete && result.deliveredNow.length && balance.daysOverdue >= 30 && tier === 'urgent') {
        await TwilioService.sendSMS(process.env.ADAM_PHONE || '+19415993489',
          `💰 Overdue: ${service.first_name} ${service.last_name} — $${balance.totalBalance.toFixed(2)} (${balance.daysOverdue} days). Service ${daysUntil === 0 ? 'today' : 'tomorrow'}.`,
          { messageType: 'internal_alert' });
      }
      return result.complete;
    }

    // RECORD-THEN-SEND (collections ledger discipline): the row precedes the
    // delivery attempt; an insert failure skips the send — no unledgered
    // customer contact, ever. A failed delivery stamps the standing row.
    let ledgerEntry;
    try {
      ledgerEntry = await ContactLedger.recordContact({
        customerId: service.cust_id,
        channel: "sms",
        purpose: "balance_reminder",
        invoiceIds: [balance.oldestInvoiceId],
        source: "balance_reminder_workflow",
        metadata: { tier, days_until: daysUntil },
      });
    } catch (ledgerErr) {
      logger.warn(`[balance-reminder] reminder skipped for customer ${service.cust_id} — contact ledger unavailable: ${ledgerErr.message}`);
      return false;
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
      metadata: {
        original_message_type: "balance_reminder",
        billingDeliveryCategory: 'billing',
        notificationEventKey: `balance-reminder:${balance.oldestInvoiceId}:${tier}:${formatDateOnly(service.scheduled_date)}`,
      },
      // The last ownership check, run by the canonical sender immediately
      // before provider preparation (Codex #4311 r43 P1): a Bill-To change
      // during the balance render must not text the homeowner an AP-owned
      // balance and pay link. Fail-closed.
      preDispatchCheck: balance.oldestInvoiceId
        ? require("../invoice-helpers").selfPayAtDispatch(balance.oldestInvoiceId, db)
        : undefined,
    });
    if (sendResult.blocked || sendResult.sent === false) {
      await ContactLedger.markSendFailed(ledgerEntry, { code: sendResult.code || "blocked" });
      throw new Error(
        `balance reminder SMS blocked: ${sendResult.code || sendResult.reason || "unknown"}`,
      );
    }
    await ContactLedger.markDelivered(ledgerEntry);

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

    // Owner alert below is INTERNAL comms to ADAM_PHONE — deliberately no
    // collections-policy consult and no ledger row: the ledger records
    // CUSTOMER contacts, and an internal heads-up must never consume the
    // customer's frequency window (pinned).
    if (balance.daysOverdue >= 30 && tier === "urgent") {
      const amt = balance.totalBalance.toFixed(2);
      await TwilioService.sendSMS(
        process.env.ADAM_PHONE || "+19415993489",
        `💰 Overdue: ${service.first_name} ${service.last_name} — $${amt} (${balance.daysOverdue} days). Service ${daysUntil === 0 ? "today" : "tomorrow"}.`,
        { messageType: "internal_alert" },
      );
    }
  }

  async sendLatePaymentEmail({
    customer,
    invoice,
    balance,
    smsTemplateKey,
    invoiceTitle,
    serviceDateClause,
    payUrl,
  }) {
    const config = LATE_PAYMENT_EMAIL_BY_SMS_TEMPLATE[smsTemplateKey];
    if (!config) return { ok: false, skipped: true, reason: "no_email_template_mapping" };

    const latestInvoice = await db("invoices").where({ id: invoice.id }).first();
    // OWNERSHIP on the email sidecar's own fresh row (local audit on r43):
    // the eligibility check below reads status alone, and a Bill-To change
    // that lands after the text succeeded would still email the homeowner a
    // payment demand for AP-owned debt.
    if (latestInvoice
      && (latestInvoice.payer_id
        || require("../invoice-helpers").invoiceWithdrawnFromCustomer(latestInvoice))) {
      logger.info(`[balance-reminder] late-payment email skipped for invoice ${invoice.id}: billed to a third-party payer`);
      return { ok: false, skipped: true, reason: "invoice_payer_billed" };
    }
    if (!invoiceCanReceiveLatePaymentEmail(latestInvoice)) {
      logger.info(
        `[balance-reminder] late-payment email skipped for invoice ${invoice.id}: invoice status is ${latestInvoice?.status || "missing"}`,
      );
      return { ok: false, skipped: true, reason: "invoice_not_eligible" };
    }

    if (!payUrl) {
      logger.warn(`[balance-reminder] late-payment email skipped for invoice ${invoice.id}: missing pay_url`);
      return { ok: false, skipped: true, reason: "missing_pay_url" };
    }

    // The customer's billing choices, recipient and invoice ownership come
    // from the shared billing email authority (owner ruling 2026-09-27): read
    // here, then again under its locks at the provider handoff, with the
    // recipient and suppression rechecks the routed billing Email leg uses.
    const authorityInput = {
      customerId: customer.id, invoiceId: invoice.id, channel: "email",
      metadata: { billingDeliveryCategory: "billing" },
    };
    const { recipient, to, refusal } = await billingEmailRecipient(authorityInput, "balance-reminder");
    if (refusal) return refusal;

    const payload = latePaymentPayload({
      customer: { ...customer, first_name: recipient.name || customer.first_name },
      invoice: latestInvoice,
      balance,
      invoiceTitle,
      serviceDateClause,
      payUrl,
    });
    if (!payload.due_date) {
      logger.warn(`[balance-reminder] late-payment email skipped for invoice ${latestInvoice.id}: missing due date`);
      return { ok: false, skipped: true, reason: "missing_due_date" };
    }

    const log = (fields) => logLatePaymentEmailAttempt({
      customerId: customer.id,
      invoiceId: latestInvoice.id,
      templateKey: config.templateKey,
      stageDays: config.stageDays,
      ...fields,
    });
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: config.templateKey,
        to,
        payload,
        recipientType: "customer",
        recipientId: customer.id,
        triggerEventId: `late_payment:${latestInvoice.id}:${config.stageDays}`,
        idempotencyKey: `late_payment_email:${latestInvoice.id}:${config.stageDays}`,
        categories: [
          "billing",
          "late_payment",
          `late_payment_${config.stageDays}d`,
        ],
        suppressionGroupKey: "transactional_required",
        withProviderHandoff: (dispatch) => dispatchUnderBillingEmailAuthority({
          input: authorityInput, recipientEmail: to, templateKey: config.templateKey, dispatch, state,
        }),
      });
      const outcome = await billingEmailSendOutcome(result, state, log);
      if (outcome.ok && !outcome.deduped) {
        logger.info(`[balance-reminder] late-payment ${config.stageDays}d email sent for invoice ${latestInvoice.id}`);
      }
      return outcome;
    } catch (err) {
      return billingEmailSendFailure(err, state.handoffStarted, log, {
        logTag: "balance-reminder", label: `late-payment ${config.stageDays}d for invoice ${latestInvoice.id}`,
      });
    }
  }

  async sendExplicitLatePaymentReminder(customer, balance, prefs, channels) {
    const invoice = await db('invoices').where({ customer_id: customer.id })
      .whereIn('status', ['sent', 'viewed', 'overdue', 'unpaid']).whereNull('payer_id')
      .where(function notWithdrawn() {
        this.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%');
      }).orderByRaw('COALESCE(due_date::timestamp, created_at) asc').first();
    if (!invoice?.id || !invoice.token) return false;
    if (await customerDunningStopped(balance, invoice.id)) return false;
    const source = 'balance_reminder_late_payment_check';
    const progress = await reminderProgress(customer.id, source, channels);
    const pending = progress.find((event) => !event.complete && event.metadata.invoiceId === invoice.id);
    // A fresh episode keeps the legacy seven-day spacing: any keyed episode
    // with a delivered leg (partial delivery still reached the customer)
    // and the sms_log history (reminders texted before the first explicit
    // channel save carry no key) both count.
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    if (!pending && (progress.some((event) => event.deliveredAt && new Date(event.deliveredAt) > sevenDaysAgo)
      || await db('sms_log').where({ customer_id: customer.id, message_type: 'late_payment' })
        .where('created_at', '>', sevenDaysAgo).first())) return false;
    const stage = LATE_PAYMENT_STAGE_DAYS.find((days) => balance.daysOverdue >= days) || 7;
    const templateKey = pending?.metadata.templateKey || `late_payment_${stage}d`;
    const eventKey = pending?.metadata.notificationEventKey || `balance-late-payment:${invoice.id}:${templateKey}`;
    if (progress.some((event) => event.complete && event.metadata.notificationEventKey === eventKey)) return false;
    const link = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
      kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: customer.id,
    });
    const { invoiceTitle, completedOn, dateClause } = latePaymentCopy(invoice);
    const message = await renderSmsTemplate(templateKey, {
      first_name: customer.first_name || 'there', invoice_title: invoiceTitle,
      service_date: completedOn || 'your service date', service_date_clause: dateClause, pay_url: link,
    }, { workflow: 'balance_late_payment_check', entity_type: 'invoice', entity_id: invoice.id });
    if (!message) return false;
    const result = await sendReminderChannels({
      customerId: customer.id, invoiceId: invoice.id, source, purpose: 'late_payment', eventKey, channels,
      metadata: { invoiceId: invoice.id, templateKey, template_key: templateKey, days_overdue: balance.daysOverdue },
      send: (channel, ledger) => channel === 'email'
        ? this.sendLatePaymentEmail({ customer, invoice, balance, smsTemplateKey: templateKey,
          invoiceTitle, serviceDateClause: dateClause, payUrl: link })
        : sendCustomerMessage({
          to: customer.phone, body: message, channel, audience: 'customer', purpose: 'payment_link',
          customerId: customer.id, invoiceId: invoice.id, entryPoint: 'balance_reminder_late_payment_check',
          metadata: { original_message_type: 'late_payment', billingDeliveryCategory: 'billing',
            notificationEventKey: eventKey, billingDeliveryLeg: channel,
            ...(ledger?.id ? { collections_ledger_id: ledger.id } : {}),
            ...(channel === 'push' ? { appOnly: true } : {}) },
          hasEmailLeg: true, preDispatchCheck: require('../invoice-helpers').selfPayAtDispatch(invoice.id, db),
        }),
    });
    for (const channel of result.deliveredNow.filter((method) => method !== 'email')) await db('customer_interactions').insert({
      customer_id: customer.id, interaction_type: `${channel}_outbound`,
      subject: `Late payment ${templateKey} via ${channel}`,
      body: `$${balance.totalBalance.toFixed(2)} overdue ${balance.daysOverdue} days.`,
      metadata: JSON.stringify({ channel, notificationEventKey: eventKey }),
    });
    if (stage >= 60 && result.deliveredNow.length) await db('customers').where({ id: customer.id }).update({
      pipeline_stage: 'at_risk', pipeline_stage_changed_at: new Date(),
    });
    return result.deliveredNow.length > 0;
  }

  async latePaymentCheck() {
    // Retired (dunning unification, owner ruling 2026-09-27) — but ONLY
    // together with GATE_DUNNING_LADDER_90: the Day 60/90 steps that
    // replace this account-level 7/14/30/60/90 check exist only under the
    // ladder gate (Codex P2), so retiring latePaymentCheck while the ladder
    // gate is unset would drop every 60/90-day reminder with nothing
    // replacing it. dailyCheck() has its own, separate coupling above.
    if (process.env.GATE_BALANCE_REMINDER_LEGACY_OFF === 'true') {
      // An invoice with no follow-up sequence also needs an owner: the
      // late-payment checker while it runs, or orphan adoption once it
      // retires (Codex #5294 r1 P1). Otherwise this stays the fallback.
      const InvoiceFollowUps = require('../invoice-followups');
      const sequencelessOwned = !InvoiceFollowUps.latePaymentCheckerRetiredLive()
        || InvoiceFollowUps.adoptOrphanInvoicesLive();
      // Legacy `unpaid`-status invoices are covered by neither the checker
      // nor adoption (both read sent/viewed/overdue), so while any exists
      // this stays the owner (Codex #5294 r2 P1; prod had none 2026-09-28).
      // An unreadable count keeps it running.
      let legacyUnpaidOpen = true;
      try {
        legacyUnpaidOpen = !!(await db('invoices').where({ status: 'unpaid' }).first('id'));
      } catch (err) {
        logger.warn(`[balance-reminders] legacy unpaid-invoice check failed, latePaymentCheck keeps running: ${err.message}`);
      }
      if (legacyUnpaidOpen) {
        logger.warn('[balance-reminders] GATE_BALANCE_REMINDER_LEGACY_OFF ignored for latePaymentCheck: legacy unpaid-status invoices still need it');
      } else if (process.env.GATE_DUNNING_LADDER_90 === 'true' && sequencelessOwned) {
        logger.info('[balance-reminders] latePaymentCheck retired: GATE_BALANCE_REMINDER_LEGACY_OFF, the invoice follow-up ladder and late-payment-checker.js (or orphan adoption) own these');
        return;
      }
      if (!legacyUnpaidOpen) {
        logger.warn(process.env.GATE_DUNNING_LADDER_90 === 'true'
          ? '[balance-reminders] GATE_BALANCE_REMINDER_LEGACY_OFF ignored for latePaymentCheck: the late-payment checker is retired and orphan adoption is not live'
          : '[balance-reminders] GATE_BALANCE_REMINDER_LEGACY_OFF ignored for latePaymentCheck: GATE_DUNNING_LADDER_90 is not live');
      }
    }
    const customers = await db("customers")
      .where({ active: true })
      .whereNull("deleted_at")
      // AR / late-payment reminders are about a billable balance, NOT WaveGuard
      // membership — keep flat commercial accounts (they owe money too). The
      // template branches on tier for any WaveGuard-specific wording.
      .whereNotNull("waveguard_tier");

    let sent = 0;
    for (const customer of customers) {
      const balance = await this.getCustomerBalance(customer.id);
      if (!balance || balance.totalBalance <= 0 || balance.daysOverdue < 7)
        continue;

      let prefs = null;
      try {
        prefs = await db('notification_prefs').where({ customer_id: customer.id }).first();
      } catch {
        logger.warn('Late payment reminder skipped: delivery preferences unavailable');
        continue;
      }
      const channels = explicitBillingChannels(prefs || {}, 'billing');
      if (channels) {
        if (await this.sendExplicitLatePaymentReminder(customer, balance, prefs, channels)) sent++;
        continue;
      }

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

      // Get oldest unpaid invoice for title and service date. Third-party
      // Bill-To: exclude payer-billed invoices — the homeowner is never the
      // bill-to and must not be texted/emailed a payer invoice's pay link.
      const oldestInvoice = await db("invoices")
        .where({ customer_id: customer.id })
        .whereIn("status", ["sent", "viewed", "overdue", "unpaid"])
        .whereNull("payer_id")
        .where(function notWithdrawn() {
          this.whereNull("scheduled_send_error").orWhereNot("scheduled_send_error", "like", "payer_billed:%");
        })
        .orderByRaw("COALESCE(due_date::timestamp, created_at) asc")
        .first();
      if (!oldestInvoice?.id || !oldestInvoice?.token) {
        logger.warn(
          `[balance-reminder] late-payment SMS skipped for customer ${customer.id}: no unpaid invoice id/token found`,
        );
        continue;
      }
      if (await customerDunningStopped(balance, oldestInvoice.id)) continue;
      const link = await shortenOrPassthrough(
        `${publicPortalUrl()}/pay/${oldestInvoice.token}`,
        {
          kind: "invoice",
          entityType: "invoices",
          entityId: oldestInvoice.id,
          customerId: customer.id,
        },
      );
      // service_date is a JS Date (pg `date` column); the old string concat
      // produced "Invalid Date" (toLocaleDateString never throws, so the
      // try/catch was dead code) and the SMS guard blocked the send.
      const { invoiceTitle, completedOn, dateClause } = latePaymentCopy(oldestInvoice);

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
        }, {
          workflow: "balance_late_payment_check",
          entity_type: "invoice",
          entity_id: oldestInvoice.id,
        });
      }

      if (!message) {
        logger.warn(
          `[balance-reminder] ${templateKey} template missing/disabled — skipping customer ${customer.id}`,
        );
        continue;
      }

      const explicitEmailSelected = billingChannelAllowed(prefs || {}, 'billing', 'email') === true;
      const emailPolicyPermitted = await collectionsChannelPermitted({
        customerId: customer.id,
        invoiceId: oldestInvoice.id,
        channel: 'email',
        purpose: 'late_payment',
        source: 'balance_reminder_late_payment_check',
        logTag: 'balance-reminder',
      });
      const smsPolicyPermitted = await collectionsChannelPermitted({
        customerId: customer.id,
        invoiceId: oldestInvoice.id,
        channel: "sms",
        purpose: "late_payment",
        source: "balance_reminder_late_payment_check",
        logTag: "balance-reminder",
      });
      let emailResult = null;
      let emailAttempted = false;
      const attemptEmail = async () => {
        if (emailAttempted || !emailPolicyPermitted) return emailResult;
        emailAttempted = true;
        let emailLedger = null;
        try {
          emailLedger = await ContactLedger.recordContact({
            customerId: customer.id,
            channel: 'email',
            purpose: 'late_payment',
            invoiceIds: [oldestInvoice.id],
            source: 'balance_reminder_late_payment_check',
            metadata: { template_key: templateKey, days_overdue: balance.daysOverdue },
          });
        } catch (ledgerErr) {
          logger.warn(`[balance-reminder] late-payment email sidecar skipped for customer ${customer.id} — contact ledger unavailable: ${ledgerErr.message}`);
        }
        if (!emailLedger) return emailResult;
        emailResult = await this.sendLatePaymentEmail({
          customer, invoice: oldestInvoice, balance, smsTemplateKey: templateKey,
          invoiceTitle, serviceDateClause: dateClause, payUrl: link,
        }).catch((err) => {
          logger.error(`[balance-reminder] late-payment email sidecar failed for customer ${customer.id}: ${err.message}`);
          return null;
        });
        if (emailResult?.ok === true) await markReminderDelivery(emailLedger, emailResult);
        else if (emailResult?.deliveryOutcome !== 'uncertain') {
          // A retryable refusal before the provider never reached the
          // customer. This row is unkeyed, so it is stamped never_contacted
          // (the pre-send doctrine, outbound-voice/origination.js), retried
          // once, or the collections 24-hour window would refuse this
          // customer's next run over a contact that never happened.
          const neverContacted = emailResult?.retryable === true && emailResult.deliveryOutcome === 'not_sent';
          const stamp = { reason: emailResult?.reason || 'email_not_sent', ...(neverContacted ? { never_contacted: true } : {}) };
          const stamped = await ContactLedger.markSendFailed(emailLedger, stamp);
          if (!stamped && neverContacted) await ContactLedger.markSendFailed(emailLedger, stamp);
        }
        return emailResult;
      };
      if (explicitEmailSelected) await attemptEmail();

      // RECORD-THEN-SEND: ledger row precedes the delivery attempt; insert
      // failure skips the send, delivery failure stamps the standing row.
      let smsLedger = null;
      if (smsPolicyPermitted && (customer.phone || billingChannelAllowed(prefs || {}, 'billing', 'push') === true)) try {
        smsLedger = await ContactLedger.recordContact({
          customerId: customer.id,
          channel: "sms",
          purpose: "late_payment",
          invoiceIds: [oldestInvoice.id],
          source: "balance_reminder_late_payment_check",
          metadata: { template_key: templateKey, days_overdue: balance.daysOverdue },
        });
      } catch (ledgerErr) {
        logger.warn(`[balance-reminder] late-payment SMS skipped for customer ${customer.id} — contact ledger unavailable: ${ledgerErr.message}`);
      }
      const sendResult = smsLedger ? await sendCustomerMessage({
        to: customer.phone,
        body: message,
        channel: "sms",
        audience: "customer",
        purpose: "payment_link",
        customerId: customer.id,
        invoiceId: oldestInvoice.id,
        entryPoint: "balance_reminder_late_payment_check",
        metadata: {
          original_message_type: "late_payment",
          billingDeliveryCategory: 'billing',
          notificationEventKey: `balance-late-payment:${oldestInvoice.id}:${balance.daysOverdue}`,
          collections_ledger_id: smsLedger.id,
        },
        hasEmailLeg: true,
        // Same provider-boundary ownership guard as the balance leg.
        preDispatchCheck: require("../invoice-helpers").selfPayAtDispatch(oldestInvoice.id, db),
      }) : { sent: false, blocked: true, code: customer.phone ? 'COLLECTIONS_POLICY' : 'NO_PHONE' };
      if (sendResult.blocked || sendResult.sent === false) {
        if (smsLedger) await ContactLedger.markSendFailed(smsLedger, { code: sendResult.code || "blocked" });
        logger.warn(
          `[balance-reminder] late-payment SMS blocked for customer ${customer.id}: ${sendResult.code || "unknown"} ${sendResult.reason || ""}`,
        );
        if (emailResult?.ok !== true) continue;
      } else {
        await markReminderDelivery(smsLedger, sendResult);
      }
      await attemptEmail();
      if (previouslySettledBillingLegs([sendResult, emailResult])) continue;
      await db("customer_interactions").insert({
        customer_id: customer.id,
        interaction_type: sendResult.sent ? "sms_outbound" : "email_outbound",
        subject: `Late payment tier ${count + 1} — ${balance.daysOverdue} days`,
        body: `$${balance.totalBalance.toFixed(2)} overdue ${balance.daysOverdue} days. Tier ${count + 1} sent.`,
      });
      sent++;
    }
    logger.info(`Late payment check: sent ${sent} reminders`);
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
