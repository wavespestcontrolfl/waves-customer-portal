const crypto = require("crypto");
const db = require("../models/db");
const logger = require("./logger");
const TaxCalculator = require("./tax-calculator");
const DiscountEngine = require("./discount-engine");
const { etDateString, addETDays } = require("../utils/datetime-et");
const { shortenOrPassthrough, invoiceShortCodePrefix } = require("./short-url");
const { publicPortalUrl } = require("../utils/portal-url");
const { loadInvoiceAnnualPrepay, buildPrepayCoverageSummary } = require("./invoice-prepay");

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
const SEND_CLAIMABLE_STATUSES = [
  "draft",
  "scheduled",
  "sent",
  "viewed",
  "overdue",
];
const SEND_FINALIZABLE_STATUSES = [...SEND_CLAIMABLE_STATUSES, "sending"];

// Invoice statuses that are safe to auto-void when the underlying scheduled
// service is cancelled. Mirrors assertInvoiceVoidable: paid / processing
// money-states are off-limits (refund is the right path); 'scheduled' is
// included so a queued send for a cancelled job never goes out.
const CANCELLED_SERVICE_VOIDABLE_STATUSES = [
  "draft",
  "scheduled",
  "sent",
  "viewed",
  "overdue",
  // 'prepaid' by ACCOUNT CREDIT (no cash) must be voidable here so a cancelled
  // service returns the customer's applied credit (restoreAccountCreditForVoidedInvoice).
  // The sweep's payment_recorded_at / paid-payment guard still skips cash-backed
  // prepayments (they book a payment row at issuance), so this only catches
  // credit-covered invoices.
  "prepaid",
];

// Stripe PaymentIntent states where money is in flight or already captured /
// authorized — an invoice attached to one of these must never be auto-voided.
const PI_MONEY_IN_FLIGHT_STATUSES = ["processing", "succeeded", "requires_capture"];

// line_items is JSONB (array when read from PG, string on some paths).
function parseInvoiceLineItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Fail-closed: does the invoice carry ANY positive charge beyond the covered base
// visit line (client_id `…_primary`)? Add-ons are tagged `…_addon_`, but pre-minted
// mobile-checkout invoices can add positive `extraLineItems` with no such id — so we
// treat any positive NON-primary line as "not fully covered" and defer to the caller
// (void today; the base-covered/extras-collectible SPLIT is a dedicated follow-up).
// Negative lines (discounts, deposit_credit) are handled elsewhere.
function invoiceHasNonBaseCharges(invoice) {
  return parseInvoiceLineItems(invoice.line_items).some(
    (li) => Number(li.amount) > 0 && !String(li.client_id || "").includes("_primary"),
  );
}

// Ledger-backed estimate deposit credit rides as a `deposit_credit` line; voidInvoice
// restores it (restoreDepositCreditForVoidedInvoice). Settling 'prepaid' would strand
// it, so these defer to the caller's void.
function invoiceHasDepositCreditLine(invoice) {
  return parseInvoiceLineItems(invoice.line_items).some(
    (li) => String(li.category || "") === "deposit_credit",
  );
}

function appendPayUrlParams(url, params = null) {
  if (!params || typeof params !== "object") return url;
  try {
    const parsed = new URL(url);
    Object.entries(params).forEach(([key, value]) => {
      if (value == null || value === "") return;
      parsed.searchParams.set(key, String(value));
    });
    return parsed.toString();
  } catch {
    return url;
  }
}

function generateToken() {
  // 32 random bytes → 64 hex chars. Unguessable. Legacy short tokens still resolve via DB lookup.
  return crypto.randomBytes(32).toString("hex");
}

async function nextInvoiceNumber(database = db) {
  const year = new Date().getFullYear();
  const prefix = `WPC-${year}-`;
  const last = await database("invoices")
    .where("invoice_number", "like", `${prefix}%`)
    .orderBy("invoice_number", "desc")
    .first();
  if (!last) return `${prefix}0001`;
  const num = parseInt(last.invoice_number.replace(prefix, "")) + 1;
  return `${prefix}${String(num).padStart(4, "0")}`;
}

async function stopInvoiceFollowupSequence(invoiceId, reason) {
  try {
    await require("./invoice-followups").stopSequence(invoiceId, { reason });
  } catch (err) {
    logger.error(
      `[invoice-followups] stopSequence failed for invoice ${invoiceId}: ${err.message}`,
    );
  }
}

function isInvoiceNumberCollision(err) {
  return err?.code === "23505" &&
    `${err.constraint || ""} ${err.detail || ""}`.includes("invoice_number");
}

async function insertInvoiceRow(database, invoiceRow) {
  const insertWith = async (client) => {
    const [invoice] = await client("invoices")
      .insert(invoiceRow)
      .returning("*");
    return invoice;
  };

  if (database !== db && typeof database.transaction === "function") {
    return database.transaction(insertWith);
  }

  return insertWith(database);
}

function normalizeInvoiceLineItems(lineItems = []) {
  return lineItems.map((item) => {
    const quantity = Number(item.quantity) || 1;
    const unitPrice = Number(item.unit_price) || 0;
    return {
      ...item,
      quantity,
      unit_price: unitPrice,
      amount: Math.round(quantity * unitPrice * 100) / 100,
    };
  });
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function hasNumericValue(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function isStoredDiscountLineItem(
  item,
  trustedSources = new Set(["scheduled_service"]),
) {
  return (
    trustedSources.has(item?.stored_discount_source) &&
    hasNumericValue(item?.discount_dollars)
  );
}

function resolveStoredDiscountLineItem(item, row) {
  const dollars = Math.max(
    0,
    roundMoney(
      hasNumericValue(item.discount_dollars)
        ? item.discount_dollars
        : Math.abs(Number(item.amount) || 0),
    ),
  );
  item.quantity = 1;
  item.unit_price = -dollars;
  item.amount = -dollars;
  return {
    id: row?.id || item.discount_id || null,
    row: row || null,
    name: item.description || row?.name || "Stored discount",
    discount_type: item.discount_type || row?.discount_type || "fixed_amount",
    amount: hasNumericValue(item.discount_amount)
      ? roundMoney(item.discount_amount)
      : roundMoney(hasNumericValue(row?.amount) ? row.amount : dollars),
    dollars,
  };
}

function resolveLineItemDiscount(row, item, parentAmount) {
  let amount = Number(row.amount) || 0;
  let dollars = 0;
  const itemDollars = Math.abs(Number(item.amount) || 0);
  const isCustomPercentage =
    row.discount_type === "variable_percentage" ||
    (row.discount_type === "percentage" &&
      (row.discount_key === "custom_percent" || !(amount > 0)));
  const isCustomAmount =
    row.discount_type === "variable_amount" ||
    (row.discount_type === "fixed_amount" &&
      (row.discount_key === "custom_dollar" || !(amount > 0)));

  if (isCustomPercentage) {
    amount = firstPositiveNumber(
      item.custom_discount_percentage,
      item.discount_percentage,
      row.amount,
    );
    dollars = roundMoney(parentAmount * (amount / 100));
    if (row.max_discount_dollars)
      dollars = Math.min(dollars, Number(row.max_discount_dollars));
  } else if (row.discount_type === "percentage") {
    dollars = roundMoney(parentAmount * (amount / 100));
    if (row.max_discount_dollars)
      dollars = Math.min(dollars, Number(row.max_discount_dollars));
  } else if (isCustomAmount) {
    amount = firstPositiveNumber(
      item.custom_discount_amount,
      item.discount_amount,
      row.amount,
    );
    dollars = amount;
  } else if (row.discount_type === "fixed_amount") {
    dollars = amount;
  } else if (row.discount_type === "free_service") {
    amount = parentAmount;
    dollars = parentAmount;
  }

  dollars = Math.min(parentAmount, Math.max(0, roundMoney(dollars)));
  return { amount: roundMoney(amount), dollars };
}

async function loadInvoiceDiscountRows(ids = [], database = db) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!uniqueIds.length) return [];
  return database("discounts")
    .whereIn("id", uniqueIds)
    .where({ is_active: true, show_in_invoices: true });
}

function buildDiscountLineItem({
  parentClientId,
  discountId,
  discountName,
  discountType,
  discountAmount,
  discountDollars,
}) {
  if (!hasNumericValue(discountDollars)) return null;
  const dollars = roundMoney(discountDollars);
  if (!(dollars > 0)) return null;
  const scope = parentClientId || "appointment";
  return {
    client_id: `discount_${discountId || "custom"}_${scope}`,
    _kind: "discount",
    discount_id: discountId || null,
    discount_for: parentClientId || null,
    description: discountName || "Line item discount",
    quantity: 1,
    unit_price: -dollars,
    amount: -dollars,
    discount_amount:
      discountAmount != null ? Number(discountAmount) : undefined,
    discount_type: discountType || undefined,
    discount_dollars: dollars,
    use_stored_discount: true,
    stored_discount_source: "scheduled_service",
  };
}

async function buildScheduledServiceInvoiceLines(
  scheduledServiceId,
  {
    fallbackAmount = 0,
    fallbackDescription = "Service visit",
    extraLineItems = [],
  } = {},
) {
  if (!scheduledServiceId) {
    return {
      lineItems:
        Number(fallbackAmount) > 0
          ? [
              {
                description: fallbackDescription,
                quantity: 1,
                unit_price: Number(fallbackAmount),
                amount: Number(fallbackAmount),
                category: fallbackDescription,
              },
            ]
          : [],
      discountIds: [],
    };
  }

  const scheduled = await db("scheduled_services")
    .where({ id: scheduledServiceId })
    .first()
    .catch(() => null);
  if (!scheduled) {
    return {
      lineItems:
        Number(fallbackAmount) > 0
          ? [
              {
                description: fallbackDescription,
                quantity: 1,
                unit_price: Number(fallbackAmount),
                amount: Number(fallbackAmount),
                category: fallbackDescription,
              },
            ]
          : [],
      discountIds: [],
    };
  }

  const addons = await db("scheduled_service_addons")
    .where({ scheduled_service_id: scheduledServiceId })
    .orderBy("created_at", "asc")
    .catch(() => []);
  const primaryBaseKnown = hasNumericValue(scheduled.primary_line_price);
  const appointmentGrossKnown =
    primaryBaseKnown &&
    addons.every((addon) => hasNumericValue(addon.base_price));

  const addonBaseTotal = addons.reduce(
    (sum, addon) =>
      sum + firstPositiveNumber(addon.base_price, addon.estimated_price),
    0,
  );
  const scheduledAmount = firstPositiveNumber(
    fallbackAmount,
    scheduled.estimated_price,
  );
  const primaryBase = primaryBaseKnown
    ? Math.max(0, roundMoney(scheduled.primary_line_price))
    : Math.max(
        0,
        roundMoney(
          addonBaseTotal > 0
            ? scheduledAmount - addonBaseTotal
            : scheduledAmount,
        ),
      );

  const lineItems = [];
  const discountIds = [];
  const primaryClientId = `scheduled_${scheduledServiceId}_primary`;
  if (primaryBase > 0) {
    lineItems.push({
      client_id: primaryClientId,
      description: scheduled.service_type || fallbackDescription,
      quantity: 1,
      unit_price: roundMoney(primaryBase),
      amount: roundMoney(primaryBase),
      category: scheduled.service_type || fallbackDescription,
    });
    const lineDiscount = primaryBaseKnown
      ? buildDiscountLineItem({
          parentClientId: primaryClientId,
          discountId: scheduled.line_discount_id,
          discountName: scheduled.line_discount_name,
          discountType: scheduled.line_discount_type,
          discountAmount: scheduled.line_discount_amount,
          discountDollars: scheduled.line_discount_dollars,
        })
      : null;
    if (lineDiscount) lineItems.push(lineDiscount);
  }

  for (const addon of addons) {
    const addonBaseKnown = hasNumericValue(addon.base_price);
    const addonBase = addonBaseKnown
      ? Math.max(0, roundMoney(addon.base_price))
      : firstPositiveNumber(addon.estimated_price);
    if (!(addonBase > 0)) continue;
    const clientId = `scheduled_${scheduledServiceId}_addon_${addon.id || lineItems.length}`;
    lineItems.push({
      client_id: clientId,
      description: addon.service_name || "Service add-on",
      quantity: 1,
      unit_price: roundMoney(addonBase),
      amount: roundMoney(addonBase),
      category: addon.service_name || null,
    });
    const addonDiscount = addonBaseKnown
      ? buildDiscountLineItem({
          parentClientId: clientId,
          discountId: addon.discount_id,
          discountName: addon.discount_name,
          discountType: addon.discount_type,
          discountAmount: addon.discount_amount,
          discountDollars: addon.discount_dollars,
        })
      : null;
    if (addonDiscount) lineItems.push(addonDiscount);
  }

  const appointmentDiscount = appointmentGrossKnown
    ? buildDiscountLineItem({
        discountId: scheduled.discount_id,
        discountName: scheduled.discount_name,
        discountType: scheduled.discount_type,
        discountAmount: scheduled.discount_amount,
        discountDollars: scheduled.discount_dollars,
      })
    : null;
  if (appointmentDiscount) lineItems.push(appointmentDiscount);

  const storedNetAmount = hasNumericValue(scheduled.estimated_price)
    ? roundMoney(scheduled.estimated_price)
    : roundMoney(fallbackAmount);
  const replayNetAmount = roundMoney(
    lineItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
  );
  if (hasNumericValue(storedNetAmount) && replayNetAmount > storedNetAmount) {
    const adjustment = roundMoney(replayNetAmount - storedNetAmount);
    lineItems.push({
      client_id: `discount_scheduled_price_${scheduledServiceId}`,
      _kind: "discount",
      discount_id: null,
      discount_for: null,
      description: "Scheduled price adjustment",
      quantity: 1,
      unit_price: -adjustment,
      amount: -adjustment,
      discount_type: "fixed_amount",
      discount_amount: adjustment,
      discount_dollars: adjustment,
      use_stored_discount: true,
      stored_discount_source: "scheduled_service",
    });
  }

  return {
    lineItems: [...lineItems, ...extraLineItems],
    discountIds,
  };
}

async function calculateUpdateFinancials({
  lineItems,
  customer,
  invoice,
  taxRate,
}) {
  const items = normalizeInvoiceLineItems(lineItems);
  const subtotal =
    Math.round(
      items.reduce((sum, item) => {
        const amount = Number(
          item.amount ??
            (Number(item.quantity) || 1) * (Number(item.unit_price) || 0),
        );
        return amount > 0 ? sum + amount : sum;
      }, 0) * 100,
    ) / 100;
  const serviceLineByClientId = new Map(
    items
      .filter((item) => Number(item.amount) > 0 && item.client_id)
      .map((item) => [String(item.client_id), item]),
  );

  const lineItemDiscountIds = items
    .filter((item) => Number(item.amount) < 0 && item.discount_id)
    .map((item) => item.discount_id);
  const lineItemDiscountRows =
    await loadInvoiceDiscountRows(lineItemDiscountIds);
  const trustedStoredDiscountIds = new Set(
    items
      .filter(
        (item) =>
          Number(item.amount) < 0 &&
          item.discount_id &&
          isStoredDiscountLineItem(item),
      )
      .map((item) => String(item.discount_id)),
  );
  const lineItemDiscountRowById = new Map(
    lineItemDiscountRows.map((row) => [String(row.id), row]),
  );
  // Deposit credits are prior payment, not discounts — keep them out of the
  // discount/tax base on edits too, or an admin save would silently convert
  // an after-tax credit into a pre-tax discount. Mirrors create().
  const updateDepositCreditTotal =
    Math.round(
      items
        .filter((item) => item.category === "deposit_credit")
        .reduce((sum, item) => sum + Math.abs(Number(item.amount) || 0), 0) *
        100,
    ) / 100;
  const lineItemDiscountAmount = items
    .filter(
      (item) => Number(item.amount) < 0 && item.category !== "deposit_credit",
    )
    .reduce((sum, item) => {
      const row = item.discount_id
        ? lineItemDiscountRowById.get(String(item.discount_id))
        : null;
      if (isStoredDiscountLineItem(item)) {
        return sum + resolveStoredDiscountLineItem(item, row).dollars;
      }
      const parent = item.discount_for
        ? serviceLineByClientId.get(String(item.discount_for))
        : null;
      if (!row || !parent) {
        if (item.discount_id || item.discount_for)
          throw new Error("Invalid line-item discount");
        return sum + Math.round(Math.abs(Number(item.amount) || 0) * 100) / 100;
      }

      const parentAmount = Math.max(0, Number(parent.amount) || 0);
      const { dollars } = resolveLineItemDiscount(row, item, parentAmount);
      item.quantity = 1;
      item.unit_price = -dollars;
      item.amount = -dollars;
      return sum + dollars;
    }, 0);

  const discountAmount = Math.min(
    subtotal,
    Math.round(lineItemDiscountAmount * 100) / 100,
  );
  const afterDiscount = subtotal - discountAmount;
  const isCommercial =
    customer?.property_type === "commercial" ||
    customer?.property_type === "business";
  // Third-party Bill-To: a tax-exempt payer zeroes tax on its invoices (create()
  // forces rate 0). Preserve that on edit — otherwise re-taxing a commercial
  // invoice here would put tax back on a tax-exempt payer's AP total that
  // creation/preview correctly omitted. Read the exemption off the invoice's
  // FROZEN payer_id (honors a per-job payer); degrades to normal tax if the
  // payers table doesn't exist yet (migration not run) or the payer is inactive.
  let payerTaxExempt = false;
  if (invoice?.payer_id) {
    const payerRow = await db("payers")
      .where({ id: invoice.payer_id })
      .first("tax_exempt", "active")
      .catch(() => null);
    payerTaxExempt = !!(payerRow && payerRow.active !== false && payerRow.tax_exempt);
  }
  let rate = 0;
  let taxAmount = 0;
  if (isCommercial && !payerTaxExempt) {
    const defaultRate =
      invoice?.tax_rate != null ? Number(invoice.tax_rate) : 0.07;
    rate = taxRate !== undefined ? Number(taxRate) : defaultRate;
    taxAmount = Math.round(afterDiscount * rate * 100) / 100;
  }
  const labelParts = [
    lineItemDiscountAmount > 0 ? "Line-item discounts" : null,
  ].filter(Boolean);

  return {
    line_items: JSON.stringify(items),
    subtotal,
    discount_amount: discountAmount,
    discount_label: labelParts.length ? labelParts.join(" + ") : null,
    tax_rate: rate,
    tax_amount: taxAmount,
    total: Math.max(
      0,
      Math.round(
        (afterDiscount + taxAmount - updateDepositCreditTotal) * 100,
      ) / 100,
    ),
  };
}

const {
  INVOICE_UPDATE_ALLOWED_FIELDS,
  INVOICE_UNCOLLECTIBLE_STATUSES,
  assertInvoiceVoidable,
  invoiceAmountDue,
} = require("./invoice-helpers");

function invoiceNotSendableError(invoice) {
  if (!invoice) return new Error("Invoice not found");
  if (invoice.status === "sending")
    return new Error("Invoice send already in progress");
  if (invoice.status === "paid") return new Error("Cannot send a paid invoice");
  if (invoice.status === "prepaid") return new Error("Cannot send a prepaid invoice");
  if (invoice.status === "processing")
    return new Error("Cannot send an invoice while payment is processing");
  if (invoice.status === "void")
    return new Error("Cannot send a voided invoice");
  return new Error(
    `Invoice is not sendable (status: ${invoice.status || "unknown"})`,
  );
}

async function claimInvoiceForSend(invoiceId, { allowClaimed = false } = {}) {
  const current = await db("invoices").where({ id: invoiceId }).first();
  if (!current) throw invoiceNotSendableError(current);

  if (allowClaimed) {
    if (!SEND_FINALIZABLE_STATUSES.includes(current.status)) {
      throw invoiceNotSendableError(current);
    }
    return { invoice: current, previousStatus: current.status, claimed: false };
  }

  if (!SEND_CLAIMABLE_STATUSES.includes(current.status)) {
    throw invoiceNotSendableError(current);
  }

  const [invoice] = await db("invoices")
    .where({ id: invoiceId, status: current.status })
    .update({ status: "sending", updated_at: new Date() })
    .returning("*");
  if (!invoice) {
    const latest = await db("invoices").where({ id: invoiceId }).first();
    throw invoiceNotSendableError(latest);
  }
  return { invoice, previousStatus: current.status, claimed: true };
}

async function restoreSendClaim(invoiceId, previousStatus, claimed) {
  if (!claimed || !previousStatus) return;
  await db("invoices")
    .where({ id: invoiceId, status: "sending" })
    .update({ status: previousStatus, updated_at: new Date() })
    .catch((err) =>
      logger.warn(
        `[invoice] Could not restore send claim for ${invoiceId}: ${err.message}`,
      ),
    );
}

// Statuses an invoice can move FROM into 'sent' on its first delivery. A send
// from any other status (sent/viewed/overdue) is a RESEND — the CASE updates in
// the send paths leave the status unchanged there.
const FIRST_SEND_STATUSES = ["draft", "scheduled", "sending"];

// Convert the originating lead to won when an invoice FIRST transitions to sent
// on ANY channel (SMS, email, or a combined/project delivery). Gated on the
// pre-send status so a RESEND of an already-sent invoice never converts an
// unrelated new lead, and so email-only sends (which finalize in
// sendViaSMSAndEmail / markDeliverySent, not sendViaSMS) are still covered.
// Best-effort + idempotent; the resolver only matches open, never-converted
// leads and never throws.
async function convertLeadOnInvoiceSent({ invoiceId, customerId, priorStatus }) {
  if (!customerId || !FIRST_SEND_STATUSES.includes(priorStatus)) return;
  try {
    const { convertLeadFromEvent } = require("./lead-estimate-link");
    await convertLeadFromEvent({ source: "invoice_sent", customerId });
  } catch (leadErr) {
    logger.warn(`[invoice] lead conversion on send failed (${invoiceId}): ${leadErr.message}`);
  }
}

async function annualPrepayInvoiceTableExists() {
  if (!db.schema?.hasTable) return false;
  return db.schema
    .hasTable("annual_prepay_terms")
    .catch(() => false);
}

async function loadAnnualPrepayTermForInvoice(invoiceId) {
  if (!invoiceId) return null;
  const exists = await annualPrepayInvoiceTableExists();
  if (!exists) return null;
  const term = await db("annual_prepay_terms")
    .where({ prepay_invoice_id: invoiceId })
    .first();
  if (!term) return null;
  return {
    id: term.id,
    customerId: term.customer_id,
    sourceEstimateId: term.source_estimate_id,
    prepayInvoiceId: term.prepay_invoice_id,
    planLabel: term.plan_label,
    monthlyRate: term.monthly_rate != null ? Number(term.monthly_rate) : null,
    prepayAmount: term.prepay_amount != null ? Number(term.prepay_amount) : null,
    termStart: term.term_start,
    termEnd: term.term_end,
    status: term.status,
    lastScheduledServiceId: term.last_scheduled_service_id,
    lastScheduledServiceDate: term.last_scheduled_service_date,
    renewalDecision: term.renewal_decision,
    renewalDecisionAt: term.renewal_decision_at,
  };
}

// ══════════════════════════════════════════════════════════════
// INVOICE SERVICE
// ══════════════════════════════════════════════════════════════
const InvoiceService = {
  async buildLineItemsForScheduledService(scheduledServiceId, options = {}) {
    return buildScheduledServiceInvoiceLines(scheduledServiceId, options);
  },

  /**
   * Create an invoice — optionally linked to a service record.
   * If serviceRecordId is provided, pulls products, photos, tech info automatically.
   */
  async create(createArgs) {
    // `let` (not const): create() reassigns some of these below (e.g. taxRate for
    // a tax-exempt payer), matching the original mutable function-parameter shape.
    let {
      database = db,
      customerId,
      serviceRecordId,
      scheduledServiceId,
      title,
      lineItems,
      notes,
      emailMessage,
      dueDate,
      taxRate,
      discountIds,
      serviceDate,
      trustedStoredDiscountSources = [],
      // Deposit credit REQUEST: create() caps it against its own
      // post-discount, after-tax total and appends the line item itself —
      // callers that compute the cap from raw line items get it wrong as soon
      // as discounts or commercial tax are in play (the cap must see the same
      // math that produces `total`). The amount actually applied is returned
      // on the invoice as `applied_deposit_credit`; consume exactly that from
      // the ledger, never the requested amount.
      depositCredit = null,
      // skipAccrual: this invoice must NOT accrue to a payer statement even for a
      // NET-terms payer — set by callers that immediately settle the invoice
      // (annual-prepay, paid in the same flow) or create a throwaway preview
      // (project send dry-run). Accruing those would double-bill (already paid) or
      // leave a phantom statement line (cancelled preview).
      skipAccrual = false,
    } = createArgs;

    // Phase 2 atomicity: a NET-terms accrual (statement get/create + invoice
    // insert + rollup) must be atomic, so run the whole create in one transaction
    // when no caller transaction was supplied. But ONLY for an actual accrual —
    // wrapping EVERY create would break create()'s best-effort tax/discount
    // catches (a caught error inside a Postgres transaction still aborts it,
    // rolling back the insert). So resolve the payer terms up front to decide;
    // resolution THROWS under the gate (fail closed — a NET-terms job must not
    // silently fall back to an individually-collectible invoice). insertInvoiceRow
    // savepoints each insert, so the collision retry still works inside the txn.
    if (!skipAccrual && database === db && require("../config/feature-gates").isEnabled("payerStatements")) {
      const PayerSvc = require("./payer");
      let preSsId = scheduledServiceId;
      if (!preSsId && serviceRecordId) {
        const srLink = await db("service_records").where({ id: serviceRecordId, customer_id: customerId }).first("scheduled_service_id").catch(() => null);
        if (srLink?.scheduled_service_id) preSsId = srLink.scheduled_service_id;
      }
      const pre = await PayerSvc.resolveForInvoice({ database: db, customerId, scheduledServiceId: preSsId, throwOnError: true });
      if (pre.payerId && ["net15", "net30"].includes(pre.paymentTerms)) {
        return db.transaction((trx) => InvoiceService.create({ ...createArgs, database: trx }));
      }
    }

    const customer = await database("customers").where({ id: customerId }).first();
    if (!customer) throw new Error("Customer not found");
    const trustedStoredSources = new Set(trustedStoredDiscountSources);

    // Resolve third-party Bill-To payer (builder / property manager / etc.):
    // scheduled_service.payer_id ?? customer.payer_id. Snapshot onto the
    // invoice so the bill-to is frozen on the document even if the link later
    // changes. resolveForInvoice() fails soft to self-pay and never throws, so
    // a payer lookup can never block invoicing — and the inserted row is
    // unchanged for the (overwhelmingly common) self-pay case.
    const PayerService = require("./payer");
    const PayerStatements = require("./payer-statements");
    const { isEnabled } = require("../config/feature-gates");
    // When the caller passes only a serviceRecordId (e.g. completion-time
    // invoicing), derive that visit's scheduled_service_id so a per-job payer
    // override on the appointment is honored — resolveForInvoice keys per-job
    // Bill-To routing off the scheduled service, and without this the invoice
    // would fall back to the customer default (or self-pay) and bill the wrong
    // party. Only the payer lookup uses the derived id; the row's own
    // scheduled_service_id linkage below is unchanged.
    let payerScheduledServiceId = scheduledServiceId;
    if (!payerScheduledServiceId && serviceRecordId) {
      const srLink = await database("service_records")
        .where({ id: serviceRecordId, customer_id: customerId })
        .first("scheduled_service_id")
        .catch(() => null);
      if (srLink?.scheduled_service_id) payerScheduledServiceId = srLink.scheduled_service_id;
    }
    const {
      payerId: resolvedPayerId,
      poNumber: resolvedPoNumber,
      taxExempt: resolvedTaxExempt,
      snapshot: resolvedPayerSnapshot,
      paymentTerms: resolvedPaymentTerms,
    } = await PayerService.resolveForInvoice({
      database,
      customerId,
      customer,
      scheduledServiceId: payerScheduledServiceId,
      // Fail closed under the statements gate: if payer resolution is uncertain,
      // a NET-terms job must NOT silently fall back to self-pay and create an
      // individually-collectible invoice instead of accruing. (Default fail-soft
      // when the gate is off — unchanged for everyone today.)
      throwOnError: isEnabled("payerStatements"),
    });

    // Phase 2 (gated by GATE_PAYER_STATEMENTS): a NET-terms payer invoice is held
    // from individual AP delivery and ACCRUED to the payer's OPEN monthly
    // statement. We resolve/attach the statement here and stamp
    // `payer_statement_id` on the insert below; the rollup runs after insert. The
    // statement get-or-create is concurrency-safe via the partial unique index
    // and rides the caller's transaction when one was passed. due_on_receipt
    // payers (everyone today) and the gate-off path are byte-identical to before.
    // Fail soft: a statement-resolution error never blocks invoicing — it falls
    // back to a normal payer invoice (the Phase-1 guards still protect the
    // homeowner; the AP just gets an individual invoice instead of a line).
    let accruedStatementId = null;
    if (!skipAccrual
      && resolvedPayerId
      && ['net15', 'net30'].includes(resolvedPaymentTerms)
      && isEnabled('payerStatements')) {
      // TOCTOU guard: the transaction wrap at the top was decided from a preflight
      // resolve. If the payer/terms flipped to NET between that preflight and this
      // definitive resolution, we can reach here with database === db (no
      // transaction) — re-enter create() in one so accrual stays atomic. (The
      // re-entry's database is the trx, so its own preflight won't re-wrap.)
      if (database === db) {
        return db.transaction((trx) => InvoiceService.create({ ...createArgs, database: trx }));
      }
      try {
        const stmt = await PayerStatements.getOrCreateOpenStatement({
          payerId: resolvedPayerId,
          termsSnapshot: resolvedPaymentTerms,
          database,
        });
        accruedStatementId = stmt.id;
      } catch (err) {
        // Fail CLOSED: never create an unguarded individual invoice for a
        // NET-terms payer when accrual fails — it would be individually
        // sendable/collectible and bypass the consolidated-statement contract.
        // getOrCreateOpenStatement is robust (advisory lock + partial-unique
        // backstop + race re-select), so this is a genuine error worth surfacing
        // to the caller rather than silently degrading.
        logger.error(`[invoice] payer-statement accrual failed for payer ${resolvedPayerId}: ${err.message}`);
        throw err;
      }
    }
    // A tax-exempt payer (builder/HOA with a resale/exemption cert on file)
    // zeroes tax on its invoices — even commercial jobs that would otherwise
    // carry the +7%. Force the rate to 0 so the tax block below resolves to 0.
    if (resolvedTaxExempt) taxRate = 0;

    // Pull service record context if linked
    let serviceData = serviceDate ? { service_date: serviceDate } : {};
    if (serviceRecordId) {
      const sr = await database("service_records")
        .where({ "service_records.id": serviceRecordId })
        .andWhere({ "service_records.customer_id": customerId })
        .leftJoin(
          "technicians",
          "service_records.technician_id",
          "technicians.id",
        )
        .select("service_records.*", "technicians.name as tech_name")
        .first();

      if (!sr) {
        throw new Error("Service record not found for customer");
      }

      if (sr) {
        const products = await database("service_products")
          .where({ service_record_id: serviceRecordId })
          .select(
            "product_name",
            "product_category",
            "active_ingredient",
            "application_rate",
            "rate_unit",
            "notes",
          );

        const photos = await database("service_photos")
          .where({ service_record_id: serviceRecordId })
          .orderBy("sort_order", "asc")
          .select("photo_type", "s3_url", "caption");

        const invoiceServiceDate = serviceDate || sr.service_date;
        serviceData = {
          service_record_id: serviceRecordId,
          technician_id: sr.technician_id,
          service_date: invoiceServiceDate,
          service_type: sr.service_type,
          tech_name: sr.tech_name,
          tech_notes: sr.technician_notes,
          products_applied: JSON.stringify(products),
          service_photos: JSON.stringify(photos),
        };

        // Auto-generate title from service type if not provided
        if (!title) {
          const dateForTitle =
            typeof invoiceServiceDate === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(invoiceServiceDate)
              ? new Date(`${invoiceServiceDate}T12:00:00`)
              : new Date(invoiceServiceDate);
          const dateStr = dateForTitle.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "America/New_York",
          });
          title = `${sr.service_type} — ${dateStr}`;
        }
      }
    }
    // NOTE: the service_type resolved here keys the county-aware tax below.
    // previewInvoiceTotals() mirrors this resolution — keep them in sync.
    if (!serviceRecordId && scheduledServiceId) {
      let scheduled = null;
      try {
        scheduled = await db("scheduled_services")
          .where({ "scheduled_services.id": scheduledServiceId })
          .leftJoin("technicians", "scheduled_services.technician_id", "technicians.id")
          .select("scheduled_services.*", "technicians.name as tech_name")
          .first();
      } catch (err) {
        logger.warn(
          `[invoice] scheduled service context lookup skipped for ${scheduledServiceId}: ${err.message}`,
        );
      }
      if (scheduled && String(scheduled.customer_id || customerId) === String(customerId)) {
        serviceData = {
          ...serviceData,
          technician_id: scheduled.technician_id || serviceData.technician_id || null,
          service_date: serviceDate || scheduled.scheduled_date || serviceData.service_date,
          service_type: scheduled.service_type || serviceData.service_type || null,
          tech_name: scheduled.tech_name || serviceData.tech_name || null,
        };
      }
    }

    // Calculate financials
    const items = (lineItems || []).map((item) => {
      const quantity = Number(item.quantity) || 1;
      const unitPrice = Number(item.unit_price) || 0;
      return {
        ...item,
        quantity,
        unit_price: unitPrice,
        amount: Math.round(quantity * unitPrice * 100) / 100,
      };
    });
    const serviceSubtotal = items.reduce((sum, item) => {
      const amount = Number(
        item.amount ??
          (Number(item.quantity) || 1) * (Number(item.unit_price) || 0),
      );
      return amount > 0 ? sum + amount : sum;
    }, 0);
    const subtotal = Math.round(serviceSubtotal * 100) / 100;
    const serviceLineByClientId = new Map(
      items
        .filter((item) => Number(item.amount) > 0 && item.client_id)
        .map((item) => [String(item.client_id), item]),
    );

    // Manually-selected discounts from the invoice form. Mirrors discount-engine math
    // so the stored total matches what the admin previewed. WaveGuard tier rows are
    // valid choices here, but customer tier never applies a hidden discount.
    const manualDiscountRows =
      Array.isArray(discountIds) && discountIds.length
        ? await loadInvoiceDiscountRows(discountIds, database)
        : [];
    const manualDiscounts = manualDiscountRows.map((d) => {
      const amt = Number(d.amount) || 0;
      let dollars = 0;
      if (
        d.discount_type === "percentage" ||
        d.discount_type === "variable_percentage"
      ) {
        dollars = Math.round(subtotal * (amt / 100) * 100) / 100;
        if (d.max_discount_dollars)
          dollars = Math.min(dollars, Number(d.max_discount_dollars));
      } else if (
        d.discount_type === "fixed_amount" ||
        d.discount_type === "variable_amount"
      ) {
        dollars = amt;
      } else if (d.discount_type === "free_service") {
        dollars = subtotal;
      }
      return { row: d, dollars: Math.round(dollars * 100) / 100 };
    });
    // Deposit credits are PRIOR PAYMENT backed dollar-for-dollar by consumed
    // estimate_deposits ledger rows — only the `depositCredit` param below
    // may mint one (create() caps it and the caller consumes the ledger in
    // the same transaction). A caller-supplied deposit_credit line item
    // (admin manual/batch invoice routes pass request line items straight
    // through) would subtract real dollars from the total with NO ledger
    // backing.
    if (items.some((item) => item?.category === "deposit_credit")) {
      throw new Error(
        "deposit_credit line items are ledger-backed and cannot be supplied directly — use the depositCredit parameter",
      );
    }
    const lineItemDiscountIds = items
      .filter((item) => Number(item.amount) < 0 && item.discount_id)
      .map((item) => item.discount_id);
    const lineItemDiscountRows =
      await loadInvoiceDiscountRows(lineItemDiscountIds, database);
    const trustedStoredDiscountIds = new Set(
      items
        .filter(
          (item) =>
            Number(item.amount) < 0 &&
            item.discount_id &&
            isStoredDiscountLineItem(item, trustedStoredSources),
        )
        .map((item) => String(item.discount_id)),
    );
    const lineItemDiscountRowById = new Map(
      lineItemDiscountRows.map((row) => [String(row.id), row]),
    );
    const lineItemDiscounts = items
      .filter(
        (item) =>
          Number(item.amount) < 0 && item.category !== "deposit_credit",
      )
      .map((item) => {
        const row = item.discount_id
          ? lineItemDiscountRowById.get(String(item.discount_id))
          : null;
        if (isStoredDiscountLineItem(item, trustedStoredSources)) {
          return resolveStoredDiscountLineItem(item, row);
        }
        const parent = item.discount_for
          ? serviceLineByClientId.get(String(item.discount_for))
          : null;
        if (!row || !parent) {
          if (item.discount_id || item.discount_for) {
            throw new Error("Invalid line-item discount");
          }
          return {
            id: null,
            row: null,
            name: item.description || "Line item discount",
            discount_type: "fixed_amount",
            amount: Math.round(Math.abs(Number(item.amount) || 0) * 100) / 100,
            dollars: Math.round(Math.abs(Number(item.amount) || 0) * 100) / 100,
          };
        }
        const parentAmount = Math.max(0, Number(parent.amount) || 0);
        const resolved = resolveLineItemDiscount(row, item, parentAmount);
        const dollars = resolved.dollars;
        item.quantity = 1;
        item.unit_price = -dollars;
        item.amount = -dollars;
        return {
          id: row.id,
          row,
          name: row.name,
          discount_type: row.discount_type,
          amount: resolved.amount,
          dollars,
        };
      });
    const lineItemDiscountAmount = lineItemDiscounts.reduce(
      (sum, item) => sum + item.dollars,
      0,
    );
    const manualDiscountAmount =
      manualDiscounts.reduce((s, m) => s + m.dollars, 0) +
      lineItemDiscounts.reduce((s, m) => s + m.dollars, 0);

    // Cap combined discount at subtotal so total never goes negative. When the
    // sum exceeds subtotal, scale each component proportionally so per-discount
    // audit rows in invoice_discounts sum to invoices.discount_amount exactly —
    // otherwise discounts.total_discount_given (rolled up from invoice_discounts)
    // overstates what was actually applied.
    const uncappedDiscount = Math.round(manualDiscountAmount * 100) / 100;
    let scaledManualDiscounts = manualDiscounts;
    let scaledLineItemDiscounts = lineItemDiscounts;
    let discountAmount = uncappedDiscount;
    if (uncappedDiscount > subtotal && uncappedDiscount > 0) {
      const factor = subtotal / uncappedDiscount;
      scaledManualDiscounts = manualDiscounts.map((m) => ({
        ...m,
        dollars: Math.round(m.dollars * factor * 100) / 100,
      }));
      scaledLineItemDiscounts = lineItemDiscounts.map((m) => ({
        ...m,
        dollars: Math.round(m.dollars * factor * 100) / 100,
      }));
      // Absorb cents-rounding remainder so the audit rows sum to exactly subtotal.
      // Apply the remainder to the row with the most headroom — never the smallest —
      // so a -0.01 adjustment can't drive a near-zero row negative and then
      // decrement discounts.total_discount_given via .increment() in
      // DiscountEngine.recordInvoiceDiscounts.
      const scaledSum =
        Math.round(
          (scaledManualDiscounts.reduce((s, m) => s + m.dollars, 0) +
            scaledLineItemDiscounts.reduce((s, m) => s + m.dollars, 0)) *
            100,
        ) / 100;
      const remainder = Math.round((subtotal - scaledSum) * 100) / 100;
      if (remainder !== 0) {
        let targetIdx = -1;
        let targetGroup = "manual";
        let targetDollars = 0;
        scaledManualDiscounts.forEach((m, i) => {
          if (m.dollars > targetDollars) {
            targetIdx = i;
            targetGroup = "manual";
            targetDollars = m.dollars;
          }
        });
        scaledLineItemDiscounts.forEach((m, i) => {
          if (m.dollars > targetDollars) {
            targetIdx = i;
            targetGroup = "line";
            targetDollars = m.dollars;
          }
        });
        if (targetIdx !== -1 && targetGroup === "manual") {
          const m = scaledManualDiscounts[targetIdx];
          scaledManualDiscounts[targetIdx] = {
            ...m,
            dollars: Math.round((m.dollars + remainder) * 100) / 100,
          };
        } else {
          const m = scaledLineItemDiscounts[targetIdx];
          scaledLineItemDiscounts[targetIdx] = {
            ...m,
            dollars: Math.round((m.dollars + remainder) * 100) / 100,
          };
        }
      }
      discountAmount = subtotal;
    }

    const labelParts = [
      ...manualDiscounts.map((m) => m.row.name),
      lineItemDiscountAmount > 0 ? "Line-item discounts" : null,
    ].filter(Boolean);
    const discountLabel = labelParts.length ? labelParts.join(" + ") : null;

    const afterDiscount = subtotal - discountAmount;

    // Tax — use TaxCalculator for automatic county-aware tax when taxRate not explicit.
    // Residential customers never see tax on invoices/receipts per operator
    // policy, so we force rate + amount to zero regardless of what the
    // caller passed. This is the single source of truth; display surfaces
    // (pay page, receipt page, PDF) can rely on stored tax_amount == 0.
    // NOTE: previewInvoiceTotals() mirrors this block (and the service-type
    // resolution above) for the dry-run preview — keep them in sync.
    const isCommercial =
      customer.property_type === "commercial" ||
      customer.property_type === "business";
    let rate, taxAmount;
    if (!isCommercial) {
      rate = 0;
      taxAmount = 0;
    } else if (taxRate !== undefined) {
      rate = taxRate;
      taxAmount = Math.round(afterDiscount * rate * 100) / 100;
    } else {
      try {
        const taxResult = await TaxCalculator.calculateTax(
          customerId,
          serviceData.service_type || title,
          afterDiscount,
        );
        rate = taxResult.rate;
        taxAmount = taxResult.amount;
      } catch (err) {
        logger.warn(
          `[invoice] TaxCalculator failed, falling back to legacy logic: ${err.message}`,
        );
        rate = 0.07;
        taxAmount = Math.round(afterDiscount * rate * 100) / 100;
      }
    }
    // Deposit credit applies AFTER tax — prior payment, not a discount.
    // The `depositCredit` param is capped HERE against the actual after-tax
    // value so no requested dollar is consumed without appearing in the
    // total. The floor guards rounding edges.
    // Third-party Bill-To: a homeowner's estimate deposit must never be credited
    // against a payer-billed invoice — that applies the service recipient's money
    // to the third-party AP's bill (wrong-party credit) and would consume the
    // homeowner's deposit ledger against an invoice they don't owe, leaving the
    // payer invoice/ledger unreconcilable. Skip the credit entirely when this
    // invoice resolved to a payer; the deposit stays received on the homeowner's
    // ledger (callers gate their consume on the returned applied_deposit_credit,
    // so 0 here leaves the ledger untouched). Payer-billed deposit handling
    // (roll-forward / refund) is Phase 2.
    let appliedDepositCredit = 0;
    if (!resolvedPayerId && depositCredit && Number(depositCredit.amount) > 0) {
      const ceilingCents = Math.max(
        0,
        Math.round((afterDiscount + taxAmount) * 100),
      );
      const appliedCents = Math.min(
        Math.round(Number(depositCredit.amount) * 100),
        ceilingCents,
      );
      appliedDepositCredit = appliedCents / 100;
      if (appliedDepositCredit > 0) {
        items.push({
          description: depositCredit.description || "Deposit credit (paid at acceptance)",
          quantity: 1,
          unit_price: -appliedDepositCredit,
          amount: -appliedDepositCredit,
          category: "deposit_credit",
          // The line is the application record: voiding this invoice reads
          // the stamp to return the consumed dollars to the right ledger
          // (restoreDepositCreditForVoidedInvoice).
          ...(depositCredit.estimateId ? { estimate_id: depositCredit.estimateId } : {}),
        });
      }
    }
    const total = Math.max(
      0,
      Math.round(
        (afterDiscount + taxAmount - appliedDepositCredit) * 100,
      ) / 100,
    );

    const token = generateToken();
    let invoice = null;
    let invoiceNumber = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      invoiceNumber = await nextInvoiceNumber(database);
      try {
        invoice = await insertInvoiceRow(database, {
          token,
          invoice_number: invoiceNumber,
          customer_id: customerId,
          title,
          line_items: JSON.stringify(items),
          subtotal,
          discount_amount: discountAmount,
          discount_label: discountLabel,
          tax_rate: rate,
          tax_amount: taxAmount,
          total,
          notes: notes || null,
          email_message: emailMessage || null,
          due_date: dueDate || etDateString(addETDays(new Date(), 30)),
          status: "draft",
          ...(scheduledServiceId
            ? { scheduled_service_id: scheduledServiceId }
            : {}),
          ...(resolvedPayerId ? { payer_id: resolvedPayerId } : {}),
          ...(resolvedPoNumber ? { po_number: resolvedPoNumber } : {}),
          ...(resolvedPayerSnapshot ? { payer_snapshot: JSON.stringify(resolvedPayerSnapshot) } : {}),
          ...(accruedStatementId ? { payer_statement_id: accruedStatementId } : {}),
          ...serviceData,
        });
        break;
      } catch (err) {
        if (isInvoiceNumberCollision(err)) {
          logger.warn(
            `[invoice] Invoice number collision on ${invoiceNumber}; retrying`,
          );
          continue;
        }
        throw err;
      }
    }
    if (!invoice) throw new Error("Could not allocate invoice number");

    // Recompute the statement rollup now this accrued invoice is attached. This
    // runs inside the create transaction (the caller's, or the one opened above),
    // so a rollup failure ABORTS the create — we never commit an accrued invoice
    // beside a drifted statement total.
    if (accruedStatementId) {
      await PayerStatements.rollupStatement(accruedStatementId, database);
    }

    // Record applied discounts in invoice_discounts table
    try {
      const auditRows = [];
      for (const m of scaledManualDiscounts) {
        auditRows.push({
          id: m.row.id,
          name: m.row.name,
          discount_type: m.row.discount_type,
          amount: Number(m.row.amount) || 0,
          discount_dollars: m.dollars,
        });
      }
      for (const m of scaledLineItemDiscounts) {
        auditRows.push({
          id: m.id || m.row?.id || null,
          name: m.name,
          discount_type: m.discount_type,
          amount: m.amount,
          discount_dollars: m.dollars,
        });
      }
      if (auditRows.length > 0) {
        // This is best-effort (the catch below swallows errors), but for a
        // NET-terms accrual create() runs inside a transaction — and a SQL error
        // inside a Postgres txn leaves it ABORTED, so a swallowed error here would
        // still roll back the invoice + statement rollup on commit. Run the audit
        // in a SAVEPOINT (nested transaction) when inside a txn so its failure
        // rolls back only the savepoint and the catch can keep it best-effort.
        if (database !== db) {
          await database.transaction((sp) => DiscountEngine.recordInvoiceDiscounts(invoice.id, auditRows, "system", sp));
        } else {
          await DiscountEngine.recordInvoiceDiscounts(invoice.id, auditRows, "system");
        }
      }
    } catch (err) {
      logger.warn(
        `[invoice] Could not record invoice_discounts: ${err.message}`,
      );
    }

    logger.info(
      `[invoice] Created ${invoiceNumber} for customer ${customerId}: $${total}`,
    );
    // Not a column — the effective deposit credit rides back to the caller
    // so the ledger consume matches what the invoice actually absorbed.
    invoice.applied_deposit_credit = appliedDepositCredit;
    return invoice;
  },

  /**
   * Preview the totals create() would store for a simple one-positive-line,
   * no-discount invoice WITHOUT creating it (the WDO combined-send dry-run).
   *
   * This MUST mirror create()'s financial path exactly — preview/billed drift
   * has shipped three times now (legacy fallback rate, service-record tax key,
   * scheduled-service tax key from #1520), which is why the mirror lives here
   * next to create() instead of in a route file. If you touch create()'s
   * service-type resolution or tax block, update this and the parity test
   * (tests/invoice-preview-parity.test.js).
   *
   * Same semantics as create(), including the throw when serviceRecordId
   * doesn't belong to the customer — a preview that would fail to bill should
   * fail the same way, not show a number the send can't produce.
   */
  async previewInvoiceTotals({
    customerId,
    customer = null,
    amount,
    serviceRecordId = null,
    scheduledServiceId = null,
    title = null,
    database = db,
  }) {
    const cust =
      customer ||
      (await database("customers").where({ id: customerId }).first());
    if (!cust) throw new Error("Customer not found");

    const subtotal = Math.round((Number(amount) || 0) * 100) / 100;

    // Mirrors create()'s service-type resolution: linked service record
    // (customer-guarded, throws when missing) → scheduled service (lenient
    // lookup, customer-guarded) → null, with the title as the final tax key.
    let serviceType = null;
    if (serviceRecordId) {
      const sr = await database("service_records")
        .where({
          "service_records.id": serviceRecordId,
          "service_records.customer_id": customerId,
        })
        .first();
      if (!sr) throw new Error("Service record not found for customer");
      serviceType = sr.service_type || null;
    } else if (scheduledServiceId) {
      let scheduled = null;
      try {
        scheduled = await database("scheduled_services")
          .where({ id: scheduledServiceId })
          .first();
      } catch (err) {
        logger.warn(
          `[invoice] scheduled service context lookup skipped for ${scheduledServiceId}: ${err.message}`,
        );
      }
      if (
        scheduled &&
        String(scheduled.customer_id || customerId) === String(customerId)
      ) {
        serviceType = scheduled.service_type || null;
      }
    }

    // A tax-exempt third-party payer zeroes tax — mirror create()'s resolution
    // so the confirmation total matches the invoice that will actually be
    // created (esp. for WDO report+invoice bundles billed to an exempt builder).
    let payerTaxExempt = false;
    try {
      const PayerService = require("./payer");
      // Mirror create(): when linked only by serviceRecordId, derive the visit's
      // scheduled_service_id so a per-job (tax-exempt) payer override is reflected
      // in the dry-run total — otherwise the preview shows tax the real, exempt
      // invoice won't actually bill.
      let previewScheduledServiceId = scheduledServiceId;
      if (!previewScheduledServiceId && serviceRecordId) {
        const srLink = await database("service_records")
          .where({ id: serviceRecordId, customer_id: customerId })
          .first("scheduled_service_id")
          .catch(() => null);
        if (srLink?.scheduled_service_id) previewScheduledServiceId = srLink.scheduled_service_id;
      }
      const resolved = await PayerService.resolveForInvoice({
        database, customerId, customer: cust, scheduledServiceId: previewScheduledServiceId,
      });
      payerTaxExempt = !!resolved.taxExempt;
    } catch { /* preview proceeds with the normal tax calc */ }

    const isCommercial =
      cust.property_type === "commercial" || cust.property_type === "business";
    let rate, taxAmount;
    if (!isCommercial || payerTaxExempt) {
      rate = 0;
      taxAmount = 0;
    } else {
      try {
        const taxResult = await TaxCalculator.calculateTax(
          customerId,
          serviceType || title,
          subtotal,
        );
        rate = taxResult.rate;
        taxAmount = taxResult.amount;
      } catch (err) {
        logger.warn(
          `[invoice] preview TaxCalculator failed, falling back to legacy logic: ${err.message}`,
        );
        rate = 0.07;
        taxAmount = Math.round(subtotal * rate * 100) / 100;
      }
    }
    const total = Math.round((subtotal + taxAmount) * 100) / 100;
    return { subtotal, tax_rate: rate, tax_amount: taxAmount, total };
  },

  /**
   * Create an invoice directly from a service record + simple amount.
   * Convenience method for post-service flow.
   */
  async createFromService(
    serviceRecordId,
    { amount, description, taxRate, useScheduledReplay = false, dueDate },
  ) {
    const sr = await db("service_records")
      .where({ id: serviceRecordId })
      .first();
    if (!sr) throw new Error("Service record not found");

    const hasExplicitAmount =
      amount !== undefined && amount !== null && Number(amount) > 0;
    const scheduledInvoice =
      (useScheduledReplay || !hasExplicitAmount) && sr.scheduled_service_id
        ? await buildScheduledServiceInvoiceLines(sr.scheduled_service_id, {
            fallbackAmount: amount,
            fallbackDescription: description || sr.service_type,
          })
        : null;
    const lineItems = scheduledInvoice?.lineItems?.length
      ? scheduledInvoice.lineItems
      : [
          {
            description: description || sr.service_type,
            quantity: 1,
            unit_price: amount,
            amount,
            category: sr.service_type,
          },
        ];

    const createParams = {
      customerId: sr.customer_id,
      serviceRecordId,
      scheduledServiceId: sr.scheduled_service_id || undefined,
      lineItems,
      discountIds: scheduledInvoice?.discountIds || undefined,
      taxRate,
      dueDate,
      trustedStoredDiscountSources: scheduledInvoice
        ? ["scheduled_service"]
        : [],
    };

    // Estimate-deposit roll-forward: when this service traces back to an
    // accepted estimate (scheduled_services.source_estimate_id) that still
    // holds unapplied deposit money, credit it against this invoice. This is
    // how one-time pay-at-visit deposits get applied — their first invoice
    // IS the completed-visit invoice — and how any remainder a cheap first
    // invoice couldn't absorb reaches the next visit instead of stranding.
    // Same atomic discipline as the converter: credit line exists IFF the
    // ledger consumed exactly that amount in the same transaction; a
    // mismatch rolls back and one retry re-reads the fresh balance. Deposit
    // machinery failures NEVER block visit invoicing — fall back to the
    // plain create and alert for manual reconciliation.
    let sourceEstimateId = null;
    if (sr.scheduled_service_id) {
      try {
        const ss = await db("scheduled_services")
          .where({ id: sr.scheduled_service_id })
          .first("source_estimate_id");
        sourceEstimateId = ss?.source_estimate_id || null;
      } catch (err) {
        logger.warn(
          `[invoice] source-estimate lookup failed for service ${serviceRecordId}: ${err.message}`,
        );
      }
    }
    if (sourceEstimateId) {
      const {
        pendingDepositCredit,
        consumeDepositCredit,
      } = require("./estimate-deposits");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let depositCredit = null;
        try {
          depositCredit = await pendingDepositCredit(sourceEstimateId);
        } catch {
          break; // ledger unreadable — invoice proceeds uncredited
        }
        const requested = depositCredit ? depositCredit.amount : 0;
        if (!(requested > 0)) break;
        try {
          return await db.transaction(async (trx) => {
            // Request the full unapplied balance; create() caps it against
            // its own post-discount, after-tax total (a pre-discount cap
            // here consumed ledger dollars the discounted invoice never
            // reflected) and reports the effective amount back.
            const created = await this.create({
              ...createParams,
              database: trx,
              depositCredit: { amount: requested, estimateId: sourceEstimateId },
            });
            const effective = Number(created?.applied_deposit_credit) || 0;
            if (created?.id && effective > 0) {
              const allocated = await consumeDepositCredit({
                estimateId: sourceEstimateId,
                amount: effective,
                invoiceId: created.id,
                trx,
              });
              if (Math.round(allocated * 100) !== Math.round(effective * 100)) {
                throw new Error(
                  `deposit allocation mismatch (applied ${effective}, allocated ${allocated})`,
                );
              }
            }
            return created;
          });
        } catch (err) {
          logger.warn(
            `[invoice] deposit roll-forward failed for estimate ${sourceEstimateId} (attempt ${attempt + 1}): ${err.message}`,
          );
          if (attempt === 1) {
            try {
              const { triggerNotification } = require("./notification-triggers");
              await triggerNotification("estimate_deposit_reconcile_needed", {
                estimateId: sourceEstimateId,
              });
            } catch (notifyErr) {
              logger.error(
                `[invoice] failed to raise deposit reconcile alert: ${notifyErr.message}`,
              );
            }
          }
        }
      }
    }

    return this.create(createParams);
  },

  /**
   * Get invoice by public token — for the /pay page.
   * Also records view and updates status.
   */
  async getByToken(token) {
    const invoice = await db("invoices").where({ token }).first();
    if (!invoice) return null;
    // NOTE: do NOT block payer_statement_id here — getByToken also backs the
    // PERMANENT receipt endpoints (receipt-v2), which must never 404 (AGENTS.md).
    // The accrued-invoice "statement-only" block lives in the PAY + invoice-PDF
    // routes instead (the collection surfaces), not this shared loader.

    // Record view
    const updates = { view_count: (invoice.view_count || 0) + 1 };
    if (!invoice.viewed_at) updates.viewed_at = new Date();
    if (invoice.status === "sent") updates.status = "viewed";
    await db("invoices").where({ id: invoice.id }).update(updates);

    // Enrich with customer info
    const customer = await db("customers")
      .where({ id: invoice.customer_id })
      .select(
        "first_name",
        "last_name",
        "email",
        "phone",
        "address_line1",
        "city",
        "state",
        "zip",
        "waveguard_tier",
        "property_sqft",
        "property_type",
      )
      .first();
    const annualPrepayTerm = await loadAnnualPrepayTermForInvoice(invoice.id);

    const line_items =
      typeof invoice.line_items === "string"
        ? JSON.parse(invoice.line_items)
        : invoice.line_items;

    // Annual-prepay coverage callout (null for ordinary invoices). Built from
    // the parsed line items so setup-fee-waived detection sees the real text.
    const annual_prepay = await loadInvoiceAnnualPrepay({ ...invoice, line_items });

    return {
      ...invoice,
      ...updates,
      customer,
      annual_prepay,
      // Amount the customer actually pays = total − applied account credit. The
      // pay page renders this (and a credit line) so the displayed amount matches
      // what the Stripe/Terminal charge paths bill.
      amount_due: invoiceAmountDue(invoice),
      credit_applied: Number(invoice.credit_applied) || 0,
      line_items,
      products_applied:
        typeof invoice.products_applied === "string"
          ? JSON.parse(invoice.products_applied)
          : invoice.products_applied || [],
      service_photos:
        typeof invoice.service_photos === "string"
          ? JSON.parse(invoice.service_photos)
          : invoice.service_photos || [],
      annual_prepay_term: annualPrepayTerm,
    };
  },

  /**
   * Send invoice via Twilio SMS — the unified service recap + invoice message.
   */
  async sendViaSMS(invoiceId, { allowClaimed = false, payUrlParams = null } = {}) {
    // Direct callers (batch sendImmediately, the AI-assistant send tool, the
    // from-service SMS-only path) bypass sendViaSMSAndEmail, which applies credit
    // before its own claim — so apply it here too, or those pay links bill the
    // gross total. Skipped when allowClaimed: that's the wrapper calling in, and
    // it already applied + handled full coverage before claiming. Gated +
    // best-effort + idempotent; full coverage flips the invoice to 'prepaid' and
    // the claim below rejects it as not-sendable (nothing left to collect).
    // Claim FIRST so a lost concurrent-send race throws before any credit is drawn
    // down — applying before the claim strands credit the winner can't see and we
    // can't reverse off the winner's 'sending' row (reverseAppliedCredit refuses
    // 'sending').
    const claim = await claimInvoiceForSend(invoiceId, { allowClaimed });
    const { invoice, previousStatus, claimed } = claim;

    // Direct callers (batch sendImmediately, the AI-assistant send tool, the
    // from-service SMS-only path) bypass sendViaSMSAndEmail, so apply credit here too
    // or those pay links bill the gross total. Skipped when allowClaimed: that's the
    // wrapper calling in, which already applied + handled full coverage. Now that we
    // own the claim. Gated + best-effort + idempotent; full coverage flips the
    // now-'sending' invoice to 'prepaid'.
    let smsCreditResult = null;
    if (!allowClaimed) {
      const { autoApplyAccountCreditIfEnabled } = require("./customer-credit");
      smsCreditResult = await autoApplyAccountCreditIfEnabled(invoiceId);
      if (smsCreditResult?.fullyCovered) {
        // Covered by credit IS success for the caller (the invoice is now 'prepaid',
        // settled — nothing to send). Direct callers check `sent || ok`, so flag
        // ok:true; sent stays false because no SMS went out. No claim to restore —
        // the apply flipped the row to the terminal 'prepaid' state.
        return { sent: false, ok: true, covered_by_credit: true, code: "covered_by_credit", reason: "Invoice covered by account credit — nothing to collect" };
      }
    }
    // Reverse this seam's credit application if the SMS ultimately isn't delivered
    // (no phone / provider error) — otherwise we'd consume credit and edit-lock an
    // invoice whose pay link never went out. No-op when nothing was applied here.
    // Each failure path below restores the 'sending' claim first, so this can run.
    const reverseSmsCreditOnFailure = async () => {
      if (allowClaimed || !(smsCreditResult?.applied > 0)) return;
      try {
        const { reverseAppliedCredit } = require("./customer-credit");
        await reverseAppliedCredit({ invoiceId, amount: smsCreditResult.applied, createdBy: "system:sms_send_failed" });
      } catch (e) {
        logger.warn(`[invoice] credit reversal after failed SMS send skipped for ${invoiceId}: ${e.message}`);
      }
    };

    // Third-party Bill-To: never text the homeowner a pay link for a
    // payer-billed invoice — the pay link + AR route to the payer (email).
    if (invoice.payer_id) {
      await restoreSendClaim(invoiceId, previousStatus, claimed);
      return { sent: false, reason: "Suppressed — invoice billed to a third-party payer", code: "payer_billed" };
    }

    const customer = await db("customers")
      .where({ id: invoice.customer_id })
      .first();
    if (!customer?.phone) {
      await restoreSendClaim(invoiceId, previousStatus, claimed);
      await reverseSmsCreditOnFailure();
      throw new Error("Customer has no phone number");
    }

    const domain = publicPortalUrl();
    const longPayUrl = appendPayUrlParams(`${domain}/pay/${invoice.token}`, payUrlParams);
    const payUrl = await shortenOrPassthrough(longPayUrl, {
      kind: "invoice",
      entityType: "invoices",
      entityId: invoice.id,
      customerId: customer.id,
      codePrefix: invoiceShortCodePrefix(invoice),
    });

    const techName = invoice.tech_name || "Our team";
    const serviceType = invoice.service_type || invoice.title || "your service";

    let formattedDate = "";
    // Whether the invoice's service date is *today* in ET. The annual-prepay
    // "Today's visit is the first of N" clause is gated on this: a resend from
    // sent/viewed/overdue or a delayed/scheduled send can run on a day other
    // than service_date, where a same-day claim would be false.
    let serviceDateIsTodayET = false;
    // Whether the service date is still in the future (ET). An invoice billed
    // before its service has happened — the setup + first-application invoice
    // auto-sent at estimate acceptance is the common case — must not use the
    // generic "...completed on {service_date}" copy. Selects the pre-service
    // variant below.
    let serviceDateIsFutureET = false;
    if (invoice.service_date) {
      try {
        // Knex returns DATE as a Date object (UTC midnight). Avoid the broken
        // `date + 'T12:00:00'` string concat and always format in ET.
        const d =
          invoice.service_date instanceof Date
            ? invoice.service_date
            : new Date(invoice.service_date + "T12:00:00");
        if (!isNaN(d.getTime())) {
          formattedDate = d.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "America/New_York",
          });
          // Compare date-only values, not the midnight Date through ET: Knex
          // returns DATE as a Date at UTC midnight, which etDateString() would
          // format as the previous ET calendar day and wrongly drop the clause
          // on the real service date. The raw YYYY-MM-DD already is the calendar
          // date (UTC-midnight Date → toISOString slice; string → leading slice).
          const serviceYmd =
            invoice.service_date instanceof Date
              ? invoice.service_date.toISOString().slice(0, 10)
              : String(invoice.service_date).slice(0, 10);
          const todayYmd = etDateString(new Date());
          serviceDateIsTodayET = serviceYmd === todayYmd;
          // ISO YYYY-MM-DD compares lexicographically === chronologically.
          serviceDateIsFutureET = serviceYmd > todayYmd;
        }
      } catch {
        formattedDate = "";
      }
    }

    // Annual-prepay invoices use a dedicated, coverage-aware template — the
    // generic invoice_sent copy ("...completed on {service_date}") misframes a
    // full year of prepaid visits as a single completed service. Resolve the
    // term up front; a cancelled/refunded term reverts to the standard copy.
    const annualPrepay = await loadInvoiceAnnualPrepay(invoice).catch(() => null);
    // coverageActive is the descriptor's single source of truth for "is this
    // term still covered" — it keeps a renewal lapse (cancelled +
    // renewal_decision='cancel', still covered through term_end) active while
    // excluding true void/refund terms, matching the billing guard.
    const prepayActive = !!annualPrepay && annualPrepay.coverageActive;
    const coverage = prepayActive ? buildPrepayCoverageSummary(annualPrepay) : null;

    // Body comes from the editable invoice_sent template (or its annual-prepay
    // variant). If the row is missing/disabled, we skip the SMS rather than
    // falling back to inline copy.
    let body = null;
    try {
      const templates = require("../routes/admin-sms-templates");
      const tplOpts = {
        workflow: "invoice_send",
        entity_type: "invoice",
        entity_id: invoiceId,
      };
      // The annual-prepay variant is its own template row, so it would render
      // even when ops disabled the base invoice_sent kill switch — and the
      // provider (messageType 'invoice' → invoice_sent) would then swallow the
      // send as a fake success and mark the invoice sent without delivery,
      // blocking retries. Honor the base kill switch here so a disabled
      // invoice_sent skips the variant too and the invoice stays retryable
      // (falls through to the null-body skip + restoreSendClaim path below).
      const invoiceSmsActive = await templates.isTemplateActive("invoice");
      if (prepayActive && invoiceSmsActive) {
        // Coverage summary is built when a visit count is configured; a
        // display-only prepay flag (no count) still gets the prepay framing via
        // a generic phrase instead of the misleading "completed on" copy.
        const coverageSummary = coverage?.coverageSummary || "your annual service plan";
        // Only claim "today" when the service date actually is today in ET —
        // resends and delayed sends run on other days. Off-day sends drop the
        // clause; the coverage summary still conveys the full-term framing.
        const firstVisitClause = coverage && serviceDateIsTodayET
          ? ` Today's visit is the first of ${coverage.coverageCount}.`
          : "";
        body = await templates.getTemplate("invoice_sent_annual_prepay", {
          first_name: customer.first_name || "",
          coverage_summary: coverageSummary,
          first_visit_clause: firstVisitClause,
          pay_url: payUrl,
        }, tplOpts);
      }
      // Upfront invoices — the setup + first-application invoice auto-sent at
      // estimate acceptance, or any invoice billed before its service date —
      // must not use the generic "...completed on {service_date}" copy, which
      // asserts a not-yet-performed service AND prints a future date. A service
      // date still in the future selects a pre-service variant with no completion
      // claim and no date placeholder. Gated on the same base `invoice` kill
      // switch as the prepay variant (a disabled invoice_sent skips this too,
      // keeping the invoice retryable); a missing/disabled variant row falls
      // through to the standard copy below so the send is never blocked.
      if (!body && serviceDateIsFutureET && invoiceSmsActive) {
        body = await templates.getTemplate("invoice_sent_upfront", {
          first_name: customer.first_name || "",
          service_type: serviceType,
          pay_url: payUrl,
        }, tplOpts);
      }
      if (!body) {
        // Either an ordinary invoice, or the prepay template was missing/disabled
        // — fall back to the standard invoice_sent copy so a missing variant row
        // never blocks the send.
        body = await templates.getTemplate("invoice_sent", {
          first_name: customer.first_name || "",
          service_type: serviceType,
          service_date: formattedDate || "today",
          pay_url: payUrl,
        }, tplOpts);
      }
    } catch (err) {
      logger.warn(`[invoice] Template lookup failed: ${err.message}`);
    }

    if (!body) {
      logger.warn(
        `[invoice] invoice_sent template missing/disabled — skipping SMS for invoice ${invoiceId}`,
      );
      await restoreSendClaim(invoiceId, previousStatus, claimed);
      await reverseSmsCreditOnFailure();
      return {
        sent: false,
        reason: "template-missing",
        code: "INVOICE_SENT_TEMPLATE_MISSING",
      };
    }

    try {
      // Routed through customer-message middleware. payment_link is a
      // sensitive purpose: policy.requireIds includes customerId +
      // invoiceId, and policy.minIdentityTrust is phone_matches_customer.
      // Both are satisfied here (we resolved the invoice and customer
      // by id, and the customer's stored phone matches the recipient).
      // Payment-link SMS bodies legitimately contain a tap-to-pay URL
      // but never an exact dollar amount in the SMS itself — the URL
      // points to the pay page where the amount is shown.
      const {
        sendCustomerMessage,
      } = require("./messaging/send-customer-message");
      const sendResult = await sendCustomerMessage({
        to: customer.phone,
        body,
        channel: "sms",
        audience: "customer",
        purpose: "payment_link",
        customerId: customer.id,
        invoiceId,
        entryPoint: "invoice_send_via_sms",
        // Preserve the legacy messageType so the admin-sms-templates
        // 'invoice' template kill switch (invoice → invoice_sent) still
        // applies. If ops disables the invoice template to halt broken
        // billing texts, this flow needs to stop too.
        metadata: { original_message_type: "invoice" },
      });

      if (!sendResult.sent) {
        logger.warn(
          `[invoice] payment-link SMS BLOCKED for invoice ${invoiceId}: ${sendResult.code} — ${sendResult.reason}`,
        );
        // Don't mark the invoice as sent if the wrapper blocked us.
        // The follow-up cron + admin can retry once the underlying
        // condition (consent, opt-out, etc.) is resolved.
        await reverseSmsCreditOnFailure();
        const err = new Error(`payment-link SMS blocked: ${sendResult.code}`);
        err.code = sendResult.code;
        err.reason = sendResult.reason;
        throw err;
      }

      await db("invoices")
        .where({ id: invoiceId })
        .whereIn("status", SEND_FINALIZABLE_STATUSES)
        .update({
          status: db.raw(
            "CASE WHEN status IN ('draft', 'scheduled', 'sending') THEN 'sent' ELSE status END",
          ),
          sent_at: new Date(),
          sms_sent_at: new Date(),
          scheduled_send_at: null,
          scheduled_send_error: null,
          scheduled_request_review: false,
          scheduled_review_delay_minutes: null,
          updated_at: new Date(),
        });

      // Kick off the per-invoice automated follow-up sequence (Day 0/3/7/14/30)
      try {
        await require("./invoice-followups").scheduleForInvoice(invoiceId);
      } catch (e) {
        logger.error(
          `[invoice-followups] scheduleForInvoice failed: ${e.message}`,
        );
      }

      // Log
      await db("activity_log")
        .insert({
          customer_id: customer.id,
          action: "invoice_sent",
          description: `Invoice ${invoice.invoice_number} sent via SMS: $${invoiceAmountDue(invoice)}`,
          metadata: JSON.stringify({ invoiceId, payUrl }),
        })
        .catch(() => {});

      logger.info(
        `[invoice] SMS sent for ${invoice.invoice_number} (customerId=${customer.id})`,
      );

      // First send means the deal closed — convert the originating lead. Only
      // for DIRECT SMS-only sends: when sendViaSMSAndEmail drives this (allowClaimed),
      // the wrapper owns the finalize + conversion, so skip here to avoid a double
      // pass. Resend-safe via the priorStatus gate inside the helper.
      if (!allowClaimed) {
        await convertLeadOnInvoiceSent({ invoiceId, customerId: invoice.customer_id, priorStatus: previousStatus });
      }

      return { sent: true, payUrl };
    } catch (err) {
      await restoreSendClaim(invoiceId, previousStatus, claimed);
      // Provider/Twilio error (or invoice-update failure) after we auto-applied
      // credit above — the pay link was never delivered, so return the credit
      // rather than leave it consumed + the invoice edit-locked.
      await reverseSmsCreditOnFailure();
      logger.error(
        `[invoice] SMS failed for ${invoice.invoice_number}: ${err.message}`,
      );
      throw err;
    }
  },

  async sendViaSMSAndEmail(
    invoiceId,
    {
      requestReview = null,
      reviewDelayMinutes = null,
      allowClaimed = false,
      emailRecipientOverride = null,
      payUrlParams = null,
    } = {},
  ) {
    // Phase 2: an accrued invoice (on a payer statement) is never delivered
    // individually. Refuse BEFORE claiming/applying credit so we don't flip its
    // status to 'sending'. (sendInvoiceEmail also fails closed; this is the early gate.)
    const accrualPre = await db("invoices").where({ id: invoiceId }).first("payer_statement_id");
    if (accrualPre?.payer_statement_id) {
      return { ok: false, error: "Invoice is billed on the payer’s monthly statement; not sent individually.", sms: { ok: false }, email: { ok: false } };
    }
    // Claim FIRST, then apply credit. Applying before the claim strands credit when
    // two sends race: the loser draws down the balance, but the winner already owns
    // the 'sending' row — reverseAppliedCredit refuses 'sending', so the loser can't
    // undo its apply, and the winner sees applied=0 (balance already consumed) and
    // never reverses it either, leaving an undelivered, edit-locked invoice with
    // credit_applied set. Claiming first means a lost race throws here before any
    // credit is drawn down — nothing to reverse.
    const claim = await claimInvoiceForSend(invoiceId, { allowClaimed });
    // Now that we own the claim, apply available account credit so the pay link the
    // customer receives bills amount due (total − applied credit), not the gross
    // total. Auto-apply otherwise only runs at dispatch completion, so invoices
    // created via the manual / batch / from-service paths would send a gross pay
    // link. Gated + best-effort + idempotent (sendViaSMS + sendInvoiceEmail both
    // re-read the invoice by id, so they pick up the reduced amount). Full coverage
    // flips the now-'sending' invoice to 'prepaid' — nothing to collect, report it
    // covered; on a delivery failure the !ok path below restores the claim and
    // reverses this seam's applied credit.
    const { autoApplyAccountCreditIfEnabled } = require("./customer-credit");
    const sendCreditResult = await autoApplyAccountCreditIfEnabled(invoiceId);
    if (sendCreditResult?.fullyCovered) {
      return {
        ok: true,
        covered_by_credit: true,
        sms: { ok: false, code: "covered_by_credit" },
        email: { ok: false, code: "covered_by_credit" },
        payUrl: null,
      };
    }
    const { previousStatus, claimed } = claim;
    const { sendInvoiceEmail } = require("./invoice-email");
    const sms = { ok: false };
    const email = { ok: false };
    let payUrl = null;

    // Callers that take no review decision (SendInvoiceModal posts {},
    // /batch/send passes no options) inherit the review request configured
    // at schedule time — the success path below clears
    // scheduled_request_review unconditionally, so without this fallback an
    // early manual send silently drops it. An explicit true/false still wins.
    let effectiveRequestReview = requestReview;
    let effectiveReviewDelayMinutes = reviewDelayMinutes;
    if (effectiveRequestReview == null) {
      effectiveRequestReview = Boolean(claim.invoice.scheduled_request_review);
      if (effectiveRequestReview && effectiveReviewDelayMinutes == null) {
        effectiveReviewDelayMinutes = claim.invoice.scheduled_review_delay_minutes;
      }
    }

    // Third-party Bill-To: a payer-billed invoice must NOT text the homeowner
    // a pay link — AR and the pay link route to the payer (email) instead.
    // The homeowner is the service recipient, not the party being asked to pay.
    if (claim.invoice?.payer_id) {
      sms.error = "Suppressed — invoice billed to a third-party payer";
      sms.code = "payer_billed";
    } else {
      try {
        const smsResult = await this.sendViaSMS(invoiceId, {
          allowClaimed: true,
          payUrlParams,
        });
        if (smsResult?.payUrl) payUrl = smsResult.payUrl;
        if (smsResult?.sent) {
          sms.ok = true;
        } else {
          sms.error = smsResult?.reason || smsResult?.code || "SMS not sent";
          if (smsResult?.code) sms.code = smsResult.code;
        }
      } catch (err) {
        sms.error = err.message;
        if (err.code) sms.code = err.code;
      }
    }

    try {
      const r = await sendInvoiceEmail(invoiceId, {
        recipientOverride: emailRecipientOverride,
        payUrlParams,
      });
      if (r?.ok) email.ok = true;
      else if (r?.error) email.error = r.error;
      if (!payUrl && r?.payUrl) payUrl = r.payUrl;
      if (r?.recipient) email.recipient = r.recipient;
      if (r?.messageId) email.messageId = r.messageId;
    } catch (err) {
      email.error = err.message;
    }

    if (effectiveRequestReview && (sms.ok || email.ok)) {
      try {
        const ReviewService = require("./review-request");
        const inv = await db("invoices")
          .where({ id: invoiceId })
          .select("customer_id", "service_record_id")
          .first();
        if (inv) {
          await ReviewService.create({
            customerId: inv.customer_id,
            serviceRecordId: inv.service_record_id || null,
            triggeredBy: "auto",
            delayMinutes: effectiveReviewDelayMinutes,
          });
        }
      } catch (err) {
        logger.error(
          `[invoice] Review request schedule failed: ${err.message}`,
        );
      }
    }

    const ok = sms.ok || email.ok;
    if (ok) {
      await db("invoices")
        .where({ id: invoiceId })
        .whereIn("status", SEND_FINALIZABLE_STATUSES)
        .update({
          status: db.raw(
            "CASE WHEN status IN ('draft', 'scheduled', 'sending') THEN 'sent' ELSE status END",
          ),
          sent_at: new Date(),
          scheduled_send_at: null,
          scheduled_send_error: null,
          scheduled_request_review: false,
          scheduled_review_delay_minutes: null,
          updated_at: new Date(),
        });
      // First send finalized on SMS and/or email — convert the originating lead.
      // Covers the email-only case the inner sendViaSMS hook can't (it skips when
      // allowClaimed). Resend-safe via the priorStatus gate.
      await convertLeadOnInvoiceSent({ invoiceId, customerId: claim.invoice.customer_id, priorStatus: previousStatus });
    } else {
      await restoreSendClaim(invoiceId, previousStatus, claimed);
      // No channel delivered — reverse the credit this seam auto-applied before
      // the send so we don't consume the customer's credit and edit-lock an
      // invoice whose pay link never went out. Reverse ONLY when WE own the claim:
      // for a pre-claimed (allowClaimed) scheduled send, restoreSendClaim is a
      // no-op and the row is still 'sending', so reverseAppliedCredit would refuse
      // — the caller (processScheduledSends) restores 'scheduled' then reverses
      // creditApplied from the result.
      if (!allowClaimed && sendCreditResult?.applied > 0) {
        try {
          const { reverseAppliedCredit } = require("./customer-credit");
          await reverseAppliedCredit({ invoiceId, amount: sendCreditResult.applied, createdBy: "system:send_failed" });
        } catch (e) {
          logger.warn(`[invoice] credit reversal after failed send skipped for ${invoiceId}: ${e.message}`);
        }
      }
    }
    return { ok, sms, email, payUrl, creditApplied: sendCreditResult?.applied || 0 };
  },

  async markDeliverySent(
    invoiceId,
    {
      sms = false,
      email = false,
      source = "invoice_delivery",
      payUrl = null,
      requestReview = null,
      reviewDelayMinutes = null,
    } = {},
  ) {
    const invoice = await db("invoices").where({ id: invoiceId }).first();
    if (!invoice) return null;
    if (!SEND_FINALIZABLE_STATUSES.includes(invoice.status)) return invoice;

    // Same contract as sendViaSMSAndEmail (the #1604 fix): callers that take
    // no review decision inherit the review request configured at schedule
    // time — the update below clears scheduled_request_review unconditionally,
    // so a delivery finalized through this path (combined project send,
    // completion SMS with invoice) must not silently drop it. An explicit
    // true/false from the caller still wins.
    let effectiveRequestReview = requestReview;
    let effectiveReviewDelayMinutes = reviewDelayMinutes;
    if (effectiveRequestReview == null) {
      effectiveRequestReview = Boolean(invoice.scheduled_request_review);
      if (effectiveRequestReview && effectiveReviewDelayMinutes == null) {
        effectiveReviewDelayMinutes = invoice.scheduled_review_delay_minutes;
      }
    }

    const now = new Date();
    const updates = {
      status: db.raw(
        "CASE WHEN status IN ('draft', 'scheduled', 'sending') THEN 'sent' ELSE status END",
      ),
      sent_at: db.raw("COALESCE(sent_at, ?)", [now]),
      scheduled_send_at: null,
      scheduled_send_error: null,
      scheduled_request_review: false,
      scheduled_review_delay_minutes: null,
      updated_at: now,
    };
    if (sms) updates.sms_sent_at = db.raw("COALESCE(sms_sent_at, ?)", [now]);

    const [updated] = await db("invoices")
      .where({ id: invoiceId })
      .whereIn("status", SEND_FINALIZABLE_STATUSES)
      .update(updates)
      .returning("*");
    const finalInvoice = updated || invoice;

    // First delivery via this path (combined project send / completion-with-
    // invoice) closes the deal — convert the originating lead. `updated` confirms
    // this call performed the write; the helper's priorStatus gate (read pre-
    // update) keeps a resend of an already-sent invoice from converting.
    if (updated) {
      await convertLeadOnInvoiceSent({ invoiceId, customerId: invoice.customer_id, priorStatus: invoice.status });
    }

    // Queue the review request only when THIS call performed the finalization
    // (`updated` set) — a concurrent path that finalized first cleared the
    // stored flags itself and already took the review decision.
    if (updated && effectiveRequestReview) {
      try {
        const ReviewService = require("./review-request");
        await ReviewService.create({
          customerId: invoice.customer_id,
          serviceRecordId: invoice.service_record_id || null,
          triggeredBy: "auto",
          delayMinutes: effectiveReviewDelayMinutes,
        });
      } catch (err) {
        logger.error(
          `[invoice] Review request schedule failed after ${source}: ${err.message}`,
        );
      }
    }

    try {
      await require("./invoice-followups").scheduleForInvoice(invoiceId);
    } catch (err) {
      logger.error(
        `[invoice-followups] scheduleForInvoice failed after ${source}: ${err.message}`,
      );
    }

    await db("activity_log")
      .insert({
        customer_id: finalInvoice.customer_id,
        action: "invoice_sent",
        description: `Invoice ${finalInvoice.invoice_number} sent via ${[
          sms && "SMS",
          email && "email",
        ].filter(Boolean).join(" + ") || "customer message"}`,
        metadata: JSON.stringify({ invoiceId, source, payUrl }),
      })
      .catch((err) =>
        logger.warn(`[invoice] activity_log insert failed: ${err.message}`),
      );

    return finalInvoice;
  },

  async processScheduledSends({ limit = 25 } = {}) {
    await db("invoices")
      .where({ status: "sending" })
      .where("updated_at", "<", db.raw("NOW() - INTERVAL '10 minutes'"))
      .update({
        status: "scheduled",
        scheduled_send_error: "Recovered from stale sending claim",
        updated_at: new Date(),
      });

    const due = await db("invoices")
      .where({ status: "scheduled" })
      .whereNotNull("scheduled_send_at")
      .where("scheduled_send_at", "<=", new Date())
      .where((q) =>
        q
          .whereNull("scheduled_send_attempts")
          .orWhere("scheduled_send_attempts", "<", 5),
      )
      .orderBy("scheduled_send_at", "asc")
      .limit(limit)
      .select(
        "id",
        "invoice_number",
        "scheduled_send_attempts",
        "scheduled_request_review",
        "scheduled_review_delay_minutes",
      );

    let sent = 0;
    let failed = 0;
    for (const inv of due) {
      const [claimed] = await db("invoices")
        .where({ id: inv.id, status: "scheduled" })
        .whereNotNull("scheduled_send_at")
        .where("scheduled_send_at", "<=", new Date())
        .where((q) =>
          q
            .whereNull("scheduled_send_attempts")
            .orWhere("scheduled_send_attempts", "<", 5),
        )
        .update({ status: "sending", updated_at: new Date() })
        .returning([
          "id",
          "scheduled_request_review",
          "scheduled_review_delay_minutes",
        ]);
      if (!claimed) continue;

      const result = await this.sendViaSMSAndEmail(claimed.id, {
        requestReview: Boolean(claimed.scheduled_request_review),
        reviewDelayMinutes: claimed.scheduled_review_delay_minutes,
        allowClaimed: true,
      });
      if (result.ok) {
        sent += 1;
        continue;
      }

      failed += 1;
      const error =
        [
          result.sms?.error && `sms: ${result.sms.error}`,
          result.email?.error && `email: ${result.email.error}`,
        ]
          .filter(Boolean)
          .join(" | ") || "send failed";
      await db("invoices")
        .where({ id: inv.id })
        .update({
          status: "scheduled",
          scheduled_send_attempts: Number(inv.scheduled_send_attempts || 0) + 1,
          scheduled_send_error: error,
          updated_at: new Date(),
        });
      // We pre-claimed this row, so sendViaSMSAndEmail couldn't reverse the credit
      // it auto-applied (the row was 'sending'). Now that it's back to 'scheduled'
      // and nothing was delivered, return that credit so it isn't stranded +
      // edit-locking the invoice until the next attempt.
      if (result.creditApplied > 0) {
        try {
          const { reverseAppliedCredit } = require("./customer-credit");
          await reverseAppliedCredit({ invoiceId: inv.id, amount: result.creditApplied, createdBy: "system:scheduled_send_failed" });
        } catch (e) {
          logger.warn(`[invoice] credit reversal after failed scheduled send skipped for ${inv.id}: ${e.message}`);
        }
      }
      logger.error(
        `[invoice] Scheduled send failed for ${inv.invoice_number}: ${error}`,
      );
    }
    return { sent, failed };
  },

  /**
   * Send payment confirmation SMS receipt.
   *
   * Idempotent: skips if invoices.receipt_sent_at is already set, unless
   * `force: true` is passed (admin manual resend). On successful Twilio
   * send the column is stamped and an activity_log row is inserted, so
   * the invoice activity feed reflects the auto-receipt regardless of
   * which payment path triggered it (Stripe webhook, /pay confirm, etc.).
   *
   * Throws on Twilio failure so callers can surface it. The Stripe
   * webhook and pay-v2 confirm handlers wrap the call in their own
   * .catch() with loud error logging.
   */
  async sendReceipt(invoiceId, { force = false, recordActivity = true } = {}) {
    const invoice = await db("invoices").where({ id: invoiceId }).first();
    if (!invoice || invoice.status !== "paid")
      return { sent: false, reason: "not-paid" };

    // Third-party Bill-To: never text the homeowner a receipt for a
    // payer-billed invoice — the receipt page would expose the payer's
    // payment-method last4, and AR/receipts route to the payer (email).
    if (invoice.payer_id) {
      return { sent: false, reason: "payer_billed" };
    }

    if (invoice.receipt_sent_at && !force) {
      logger.info(
        `[invoice] Receipt already sent for ${invoice.invoice_number} — skipping`,
      );
      return { sent: false, reason: "already-sent" };
    }

    const customer = await db("customers")
      .where({ id: invoice.customer_id })
      .first();
    if (!customer?.phone) return { sent: false, reason: "no-phone" };

    const domain = publicPortalUrl();
    const longReceiptUrl = invoice.token
      ? `${domain}/pay/${invoice.token}`
      : "";
    const receiptUrl = longReceiptUrl
      ? await shortenOrPassthrough(longReceiptUrl, {
          kind: "receipt",
          entityType: "invoices",
          entityId: invoice.id,
          customerId: customer.id,
          codePrefix: invoiceShortCodePrefix(invoice),
        })
      : "";

    // Template body has a {card_line} placeholder that renders as e.g.
    // " (Visa ending 4242)" when card metadata is present, or empty otherwise.
    const cardBrand = invoice.card_brand;
    const cardLast4 = invoice.card_last_four;
    const cardLine =
      cardBrand && cardLast4
        ? ` (${cardBrand.charAt(0).toUpperCase() + cardBrand.slice(1)} ending ${cardLast4})`
        : "";
    // Receipt amount from the PAYMENT row, not invoiceAmountDue(invoice): a full
    // refund zeroes credit_applied, after which invoiceAmountDue returns the gross
    // total. On a recorded refund show net cash kept (amount − refunded) to match
    // the receipt page/PDF; otherwise amount due (total − applied credit). Falls
    // back to amount due when no payment row exists.
    const receiptPayment = await db("payments")
      .where({ customer_id: invoice.customer_id })
      .whereIn("status", ["paid", "refunded"])
      .whereRaw(`metadata::jsonb ->> 'invoice_id' = ?`, [invoice.id])
      .orderBy("created_at", "desc")
      .first()
      .catch(() => null);
    const receiptRefunded = receiptPayment ? Number(receiptPayment.refund_amount || 0) : 0;
    const receiptAmount = receiptRefunded > 0
      ? Math.max(0, Number(receiptPayment.amount || 0) - receiptRefunded)
      : invoiceAmountDue(invoice);
    const amount = Number.isFinite(receiptAmount)
      ? receiptAmount.toFixed(2)
      : "0.00";

    let body = null;
    try {
      const templates = require("../routes/admin-sms-templates");
      body = await templates.getTemplate("invoice_receipt", {
        first_name: customer.first_name || "",
        invoice_number: invoice.invoice_number,
        amount,
        card_line: cardLine,
        receipt_url: receiptUrl,
      }, {
        workflow: "invoice_receipt",
        entity_type: "invoice",
        entity_id: invoiceId,
      });
    } catch (err) {
      logger.warn(`[invoice] Receipt template lookup failed: ${err.message}`);
    }
    if (!body) {
      logger.warn(
        `[invoice] invoice_receipt template missing/disabled — skipping receipt for ${invoice.invoice_number}`,
      );
      return { sent: false, reason: "template-missing" };
    }

    const {
      sendCustomerMessage,
    } = require("./messaging/send-customer-message");
    const sendResult = await sendCustomerMessage({
      to: customer.phone,
      body,
      channel: "sms",
      audience: "customer",
      purpose: "payment_receipt",
      customerId: customer.id,
      invoiceId,
      entryPoint: "invoice_receipt_sms",
      metadata: { original_message_type: "receipt" },
    });
    if (sendResult.blocked || sendResult.sent === false) {
      // Email-only delivery preference is an intentional suppression, not a
      // failure — return a skip (like payer_billed above) so callers such as
      // the receipt-delivery queue don't retry/fail a receipt whose email leg
      // delivered fine.
      if (sendResult.code === "CHANNEL_EMAIL_ONLY") {
        logger.info(
          `[invoice] Receipt SMS skipped for ${invoice.invoice_number} — customer prefers email-only receipts`,
        );
        return { sent: false, reason: "channel_email_only" };
      }
      const err = new Error(
        `receipt SMS blocked: ${sendResult.code || sendResult.reason || "unknown"}`,
      );
      err.code = sendResult.code;
      err.reason = sendResult.reason;
      throw err;
    }
    logger.info(`[invoice] Receipt SMS sent for ${invoice.invoice_number}`);

    if (!invoice.receipt_sent_at) {
      await db("invoices")
        .where({ id: invoiceId })
        .update({
          receipt_sent_at: db.fn.now(),
        })
        .catch((err) =>
          logger.error(
            `[invoice] receipt_sent_at stamp failed for ${invoice.invoice_number}: ${err.message}`,
          ),
        );
    }

    if (recordActivity) {
      await db("activity_log")
        .insert({
          customer_id: invoice.customer_id,
          action: "invoice_receipt_sent",
          description: `Receipt sent for invoice ${invoice.invoice_number} (sms)`,
        })
        .catch((err) =>
          logger.warn(`[invoice] activity_log insert failed: ${err.message}`),
        );
    }

    return { sent: true };
  },

  // ── Admin CRUD ──

  async getById(id) {
    const invoice = await db("invoices").where({ id }).first();
    if (!invoice) return null;
    const customer = await db("customers")
      .where({ id: invoice.customer_id })
      .select(
        "first_name",
        "last_name",
        "phone",
        "email",
        "waveguard_tier",
        "address_line1",
        "city",
        "state",
        "zip",
      )
      .first();
    const activePaymentPlan = await db("payment_plans")
      .where({ invoice_id: id })
      .where("status", "active")
      .orderBy("created_at", "desc")
      .first()
      .catch(() => null);
    const annual_prepay = await loadInvoiceAnnualPrepay({
      ...invoice,
      line_items:
        typeof invoice.line_items === "string"
          ? JSON.parse(invoice.line_items)
          : invoice.line_items,
    });
    const annualPrepayTerm = await loadAnnualPrepayTermForInvoice(invoice.id);
    return {
      ...invoice,
      customer,
      active_payment_plan: activePaymentPlan,
      annual_prepay,
      annual_prepay_term: annualPrepayTerm,
    };
  },

  async list({
    status,
    customerId,
    limit = 50,
    offset = 0,
    archived = "hide",
    search,
    from,
    to,
    sort = "newest",
  } = {}) {
    const today = etDateString();
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const dateColumn =
      "COALESCE(invoices.service_date, invoices.created_at::date)";
    const invoiceDate = db.raw(dateColumn);
    const validDate = (value) =>
      typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    const normalizedStatus = String(status || "")
      .trim()
      .toLowerCase();
    const hasAnnualPrepayTerms = await annualPrepayInvoiceTableExists();
    const directStatuses = new Set([
      "draft",
      "scheduled",
      "sending",
      "sent",
      "viewed",
      "paid",
      "prepaid",
      "processing",
      "void",
      "refunded",
      "canceled",
      "cancelled",
    ]);

    // archived semantics:
    //   'hide' (default) — WHERE archived_at IS NULL
    //   'only'            — WHERE archived_at IS NOT NULL
    //   'all'             — no filter
    const applyFilters = (q) => {
      if (archived === "only") q.whereNotNull("invoices.archived_at");
      else if (archived !== "all") q.whereNull("invoices.archived_at");

      if (customerId) q.where("invoices.customer_id", customerId);

      if (normalizedStatus === "overdue") {
        q.whereNotIn("invoices.status", INVOICE_UNCOLLECTIBLE_STATUSES).andWhere(function () {
          this.where("invoices.status", "overdue").orWhere(
            "invoices.due_date",
            "<",
            today,
          );
        });
      } else if (normalizedStatus === "unpaid") {
        q.whereNotIn("invoices.status", INVOICE_UNCOLLECTIBLE_STATUSES);
      } else if (normalizedStatus === "needs_receipt") {
        q.where("invoices.status", "paid").whereNull(
          "invoices.receipt_sent_at",
        );
      } else if (directStatuses.has(normalizedStatus)) {
        q.where("invoices.status", normalizedStatus);
      }

      if (validDate(from)) q.where(invoiceDate, ">=", from);
      if (validDate(to)) q.where(invoiceDate, "<=", to);

      const term = String(search || "").trim();
      if (term) {
        const like = `%${term}%`;
        q.andWhere(function () {
          this.whereRaw("invoices.invoice_number ILIKE ?", [like])
            .orWhereRaw("COALESCE(invoices.title, '') ILIKE ?", [like])
            .orWhereRaw("COALESCE(customers.first_name, '') ILIKE ?", [like])
            .orWhereRaw("COALESCE(customers.last_name, '') ILIKE ?", [like])
            .orWhereRaw("COALESCE(customers.phone, '') ILIKE ?", [like])
            .orWhereRaw("COALESCE(customers.email, '') ILIKE ?", [like])
            .orWhereRaw(
              "CONCAT_WS(' ', customers.first_name, customers.last_name) ILIKE ?",
              [like],
            );
        });
      }

      return q;
    };

    const listBase = db("invoices").leftJoin(
      "customers",
      "invoices.customer_id",
      "customers.id",
    );
    if (hasAnnualPrepayTerms) {
      listBase.leftJoin(
        "annual_prepay_terms as apt",
        "apt.id",
        "invoices.annual_prepay_term_id",
      );
    }

    const selectColumns = [
      "invoices.*",
      "customers.first_name",
      "customers.last_name",
      "customers.phone",
      "customers.email",
      "customers.waveguard_tier",
      // property_type drives taxability; the edit form needs the CURRENT value
      // (not the rate stored on the invoice) so its tax preview matches the
      // server retotal when a customer's type changed after invoice creation.
      "customers.property_type",
      db.raw(`(
          SELECT json_build_object('brand', card_brand, 'last_four', last_four)
          FROM payment_methods
          WHERE customer_id = invoices.customer_id AND is_default = true
          LIMIT 1
        ) AS card_on_file`),
      db.raw(`(
          SELECT json_build_object(
            'id', pp.id,
            'payment_amount', pp.payment_amount,
            'payment_frequency', pp.payment_frequency,
            'next_payment_date', pp.next_payment_date,
            'total_balance', pp.total_balance,
            'status', pp.status
          )
          FROM payment_plans pp
          WHERE pp.invoice_id = invoices.id AND pp.status = 'active'
          ORDER BY pp.created_at DESC
          LIMIT 1
        ) AS active_payment_plan`),
    ];
    if (hasAnnualPrepayTerms) {
      selectColumns.push(
        "apt.id as annual_prepay_id",
        "apt.status as annual_prepay_status",
        "apt.plan_label as annual_prepay_plan_label",
        "apt.term_start as annual_prepay_term_start",
        "apt.term_end as annual_prepay_term_end",
        "apt.prepay_amount as annual_prepay_amount",
      );
    }

    const query = applyFilters(listBase).select(...selectColumns);

    if (sort === "oldest") {
      query
        .orderByRaw(`${dateColumn} ASC NULLS LAST`)
        .orderBy("invoices.created_at", "asc");
    } else if (sort === "amount_high") {
      query
        .orderBy("invoices.total", "desc")
        .orderByRaw(`${dateColumn} DESC NULLS LAST`);
    } else if (sort === "amount_low") {
      query
        .orderBy("invoices.total", "asc")
        .orderByRaw(`${dateColumn} DESC NULLS LAST`);
    } else {
      query
        .orderByRaw(`${dateColumn} DESC NULLS LAST`)
        .orderBy("invoices.created_at", "desc");
    }

    const invoices = await query.limit(safeLimit).offset(safeOffset);
    const [{ count }] = await applyFilters(
      db("invoices").leftJoin(
        "customers",
        "invoices.customer_id",
        "customers.id",
      ),
    ).countDistinct("invoices.id as count");

    return { invoices, total: parseInt(count, 10) };
  },

  async update(id, updates) {
    // `status` deliberately omitted — admins must use the explicit
    // /void, /charge-card, /record-payment, /archive, /unarchive routes
    // to transition state. Allowing a free-form `status` write here
    // lets a tech mark an invoice "paid" with no Stripe charge / no
    // payments-ledger row, or flip a paid invoice back to "draft" and
    // erase the audit trail. See INVOICE_UPDATE_ALLOWED_FIELDS export.

    // Editability guard. The generic update path can only safely rewrite an
    // invoice that has not yet entered collection or accrued payment
    // side-state. We re-read the CURRENT row here (not the one the editor was
    // opened with) so a status race — the invoice gets sent/paid via the pay
    // link, Charge in person, Add payment, or the scheduled-send cron after
    // the edit form opened — is caught at the write:
    //   - status must still be draft/scheduled (never rewrite sent/paid money)
    //   - no live Stripe PaymentIntent: /pay/:token /setup stamps
    //     stripe_payment_intent_id while the invoice stays collectible; a
    //     retotal here would leave a stale pay page able to confirm the old
    //     amount with no way to reconcile it.
    //   - no active payment plan / annual-prepay term: those capture the total
    //     at creation (payment_plans.total_balance, annual_prepay_terms
    //     .prepay_amount); retotalling invoices alone leaves them collecting /
    //     displaying the stale figure.
    // Deposit-credit and applied-account-credit invoices stay blocked below
    // (line-item path) for their own ledger reasons.
    const existing = await db("invoices").where({ id }).first();
    if (!existing) return null;
    // Phase 2: a draft invoice ACCRUED to a payer statement may be edited only
    // while that statement is still OPEN. Once it is finalized/sent the invoice is
    // a billed line — editing it would change the document under the frozen total.
    // (The post-edit reroll below no-ops on a frozen statement, so block here.)
    if (existing.payer_statement_id) {
      const stmt = await db("payer_statements").where({ id: existing.payer_statement_id }).first("status");
      if (stmt && stmt.status !== "open") {
        throw new Error("This invoice is on a finalized payer statement — adjust it with a credit on the next statement, not by editing a billed line");
      }
    }
    const currentStatus = String(existing.status || "").toLowerCase();
    if (currentStatus !== "draft" && currentStatus !== "scheduled") {
      throw new Error(
        "Only draft or scheduled invoices can be edited — this invoice has already been sent or paid",
      );
    }
    if (existing.stripe_payment_intent_id) {
      throw new Error(
        "A customer has already started paying this invoice — void it and create a replacement instead of editing",
      );
    }
    if (existing.annual_prepay_term_id) {
      throw new Error(
        "This invoice is part of an annual prepay term — edit the term (Annual prepay) instead of the invoice",
      );
    }
    // Fail CLOSED: if we can't confirm the payment-plan state (migration
    // drift, permissions, transient DB error) we must refuse the edit rather
    // than assume there's no plan — assuming none is exactly the committed-
    // workflow drift this guard prevents.
    let activePlan = null;
    try {
      activePlan = await db("payment_plans")
        .where({ invoice_id: id, status: "active" })
        .first();
    } catch (err) {
      throw new Error(
        `Could not verify the active payment plan state — refusing to edit (${err.message})`,
      );
    }
    if (activePlan) {
      throw new Error(
        "This invoice has an active payment plan — cancel the plan before editing the invoice",
      );
    }

    const allowed = INVOICE_UPDATE_ALLOWED_FIELDS;
    const data = { updated_at: new Date() };
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        data[key] =
          key === "line_items" ? JSON.stringify(updates[key]) : updates[key];
      }
    }

    // Recalculate totals if line items changed. This mirrors the hardened
    // create() rules: subtotal only counts positive service rows, negative
    // discount rows are scoped to their parent line item, and residential
    // tax is always forced to zero.
    if (updates.line_items) {
      const invoice = existing;
      // Deposit-credited invoices are edit-locked on line items: the credit
      // line is backed dollar-for-dollar by consumed estimate_deposits
      // ledger rows, and a recalculation here can neither re-cap the credit
      // against the new total nor re-balance the ledger — an edit could
      // shrink the invoice below the credit (over-applied ledger money) or
      // drop the credit line entirely while the deposit stays consumed.
      // Void the invoice (which restores the ledger) and re-create instead.
      const hasDepositCreditLine = (items) => {
        try {
          const arr = typeof items === "string" ? JSON.parse(items) : items;
          return Array.isArray(arr) && arr.some((i) => i?.category === "deposit_credit");
        } catch {
          return false;
        }
      };
      if (hasDepositCreditLine(invoice.line_items) || hasDepositCreditLine(updates.line_items)) {
        throw new Error(
          "This invoice carries an estimate deposit credit — void it (the deposit returns to the customer's ledger) and create a replacement instead of editing line items",
        );
      }
      // Account-credit-prepaid invoices are likewise edit-locked on line items:
      // the consumed customer_credit_ledger entry is backed dollar-for-dollar
      // against the current total, and a retotal here can neither re-cap nor
      // rebalance that ledger (an edit below the applied credit would leave the
      // ledger over-consumed). Reverse the credit before editing.
      if (parseFloat(invoice.credit_applied || 0) > 0) {
        throw new Error(
          "This invoice has account credit applied (prepaid) — reverse the applied credit before editing line items",
        );
      }
      const customer = await db("customers")
        .where({ id: invoice.customer_id })
        .first();
      Object.assign(
        data,
        await calculateUpdateFinancials({
          lineItems: updates.line_items,
          customer,
          invoice,
          taxRate: updates.tax_rate,
        }),
      );
      // KNOWN LIMITATION (accepted): a line-item retotal here updates
      // invoices.discount_amount but does NOT reconcile the create-time
      // discount audit trail (invoice_discounts rows + discounts.times_applied
      // / total_discount_given). So changing/removing a discount on a draft can
      // drift the Discounts report from the edited invoice. Left as-is on
      // purpose: it's reporting-only (no money/ledger/customer impact), the
      // counters are already created-time best-effort and count unsent/voided
      // drafts too, and there is no reversal primitive to mirror — reconciling
      // would have to reverse + re-record across multiple create paths. Revisit
      // if discount reporting needs to be exact to the penny on edited drafts.
    }

    // Apply the editability predicates ATOMICALLY on the write so a worker
    // that mutates the same invoice between the guard read above and this write
    // cannot be clobbered. Column predicates cover a worker stamping
    // stripe_payment_intent_id, flipping status off draft/scheduled, or linking
    // a prepay term; the correlated NOT EXISTS covers a second admin creating
    // an active payment plan (POST /:id/payment-plan inserts into payment_plans
    // without stamping the invoice, so it isn't visible as a column here). If
    // any predicate no longer holds the update matches zero rows and we fail
    // closed instead of rewriting money.
    //
    // KNOWN LIMITATION (accepted): these predicates only see committed state.
    // POST /:id/payment-plan and POST /:id/annual-prepay read invoice.total
    // without locking the invoice row, so if one of those creations is in
    // flight (uncommitted) while this edit commits, the plan/term can be born
    // with the pre-edit total. Closing it fully would mean locking + re-reading
    // the invoice (SELECT ... FOR UPDATE) inside those two creation
    // transactions. Left as-is on purpose: it needs two admins on the SAME
    // draft within a sub-second window, the already-exists cases are blocked
    // above, and any resulting total mismatch is visible and recoverable.
    const runEdit = async (client) => {
      // Accrued: lock the parent statement and re-verify it's still OPEN inside
      // this transaction, so a concurrent close can't finalize between the
      // pre-check above and this write.
      if (existing.payer_statement_id) {
        const locked = await client("payer_statements")
          .where({ id: existing.payer_statement_id })
          .forUpdate()
          .first("status");
        if (locked && locked.status !== "open") {
          throw new Error("This invoice is on a finalized payer statement — adjust it with a credit on the next statement, not by editing a billed line");
        }
      }
      const [edited] = await client("invoices")
        .where({ id })
        .whereIn("status", ["draft", "scheduled"])
        .whereNull("stripe_payment_intent_id")
        .whereNull("annual_prepay_term_id")
        .whereNotExists(function () {
          this.select(db.raw("1"))
            .from("payment_plans")
            .whereRaw("payment_plans.invoice_id = invoices.id")
            .where("payment_plans.status", "active");
        })
        .update(data)
        .returning("*");
      if (!edited) {
        throw new Error(
          "Only draft or scheduled invoices can be edited — its status or payment state changed while you were editing",
        );
      }
      // Phase 2: an edited accrued invoice changes the statement total — reroll in
      // the SAME transaction so a reroll failure ABORTS the edit; we never commit
      // a changed invoice beside a stale statement subtotal/tax/total.
      if (edited.payer_statement_id) {
        await require("./payer-statements").rollupStatement(edited.payer_statement_id, client);
      }
      return edited;
    };
    // An accrued invoice's edit + statement reroll must commit atomically; other
    // invoices keep the existing single-statement write (no transaction).
    return existing.payer_statement_id ? db.transaction(runEdit) : runEdit(db);
  },

  async voidInvoice(id) {
    // Refuse to void a paid invoice. A paid invoice has a payments-ledger
    // row + (usually) a Stripe charge; flipping it to "void" silently
    // hides the revenue from dashboards but leaves the money collected
    // — the right path is a refund via StripeService.refund. ACH in
    // flight is also off-limits; assertInvoiceVoidable encodes the
    // transition matrix so the unit tests can verify it without DB.
    const current = await db("invoices").where({ id }).first();
    if (!current) throw new Error("Invoice not found");
    assertInvoiceVoidable(current.status);
    // Phase 2: an accrued invoice on a FINALIZED/sent statement is a billed line —
    // refuse to void it (which would change the document under the frozen total);
    // the correction is a credit on the next statement. Voiding while the
    // statement is still OPEN is fine (the reroll below drops it from the total).
    if (current.payer_statement_id) {
      const stmt = await db("payer_statements").where({ id: current.payer_statement_id }).first("status");
      if (stmt && stmt.status !== "open") {
        throw new Error("This invoice is on a finalized payer statement — adjust it with a credit on the next statement, not by voiding a billed line");
      }
    }
    if (current.status === "void") {
      await stopInvoiceFollowupSequence(id, "invoice_voided");
      return current;
    }
    // 'prepaid' passes assertInvoiceVoidable so a credit-covered invoice can be
    // voided (the txn returns the applied credit). But 'prepaid' alone can't tell
    // a credit-only prepayment from a CASH-backed one. A cash-backed invoice books
    // a payment row + sets payment_recorded_at at issuance; voiding it (instead of
    // refunding) would hide collected money. Account-CREDIT prepayment sets neither
    // signal (it only moves the credit ledger), so this still lets credit-covered
    // invoices void. Mirrors the cancelled-service auto-void money guard.
    const voidAppliedPayment = await db("payments")
      .whereIn("status", ["paid", "processing"])
      .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [current.id])
      .first("id");
    if (current.payment_recorded_at || voidAppliedPayment) {
      throw new Error(
        `Cannot void an invoice with payment already applied (${voidAppliedPayment ? `payment ${voidAppliedPayment.id}` : "payment recorded"}) — issue a refund instead`,
      );
    }
    // PI ↔ invoice ↔ webhook amount agreement: with partial credit, a collectible
    // invoice can carry a live PaymentIntent (a customer mid-pay on /pay). Voiding
    // returns the applied credit, so the PI must be cancelled FIRST — else the live
    // client secret could still charge the reduced amount while the credit is back
    // on the balance and the webhook skips the void invoice. Refuse if money is in
    // flight; cancel a still-cancelable intent. Pre-lock Stripe triage (mirrors the
    // apply-credit route); the transaction re-checks the PI id under the row lock.
    const triagedVoidPiId = current.stripe_payment_intent_id || null;
    if (triagedVoidPiId) {
      const StripeService = require("./stripe");
      let voidPi;
      try {
        voidPi = await StripeService.retrievePaymentIntent(triagedVoidPiId);
      } catch (e) {
        throw new Error(`Open payment session ${triagedVoidPiId} could not be verified (${e.message}); resolve it before voiding`);
      }
      if (!voidPi) {
        throw new Error(`Open payment session ${triagedVoidPiId} could not be verified (payment service unavailable); resolve it before voiding`);
      }
      if (PI_MONEY_IN_FLIGHT_STATUSES.includes(voidPi.status)) {
        throw new Error(`A payment is already in flight (${voidPi.status}); wait for it to settle or refund it before voiding`);
      }
      if (voidPi.status !== "canceled") {
        try {
          await StripeService.cancelPaymentIntent(triagedVoidPiId, { cancellation_reason: "abandoned" });
        } catch (e) {
          throw new Error(`Couldn't cancel the open payment session ${triagedVoidPiId} (${e.message}); resolve it before voiding`);
        }
      }
    }
    // Void + deposit-ledger restore commit TOGETHER: a committed void beside
    // a still-consumed deposit strands the customer's money — the credit can
    // no longer roll forward or refund (a restore failure rolls the void
    // back; a blocked void beats stranded money). The status-conditional
    // update makes a concurrent void/payment lose cleanly, so the restore
    // can never run twice for one invoice.
    let invoice = null;
    await db.transaction(async (trx) => {
      // Phase 2: lock + re-verify the parent statement is still OPEN inside the
      // transaction (the pre-check above is a fast fail, but a concurrent close
      // could finalize the statement between it and this write — that would let
      // the void commit while rollupStatement no-ops against a frozen total).
      if (current.payer_statement_id) {
        const locked = await trx("payer_statements")
          .where({ id: current.payer_statement_id })
          .forUpdate()
          .first("status");
        if (locked && locked.status !== "open") {
          throw new Error("This invoice is on a finalized payer statement — adjust it with a credit on the next statement, not by voiding a billed line");
        }
      }
      const [updated] = await trx("invoices")
        .where({ id, status: current.status })
        .update({ status: "void", updated_at: new Date() })
        .returning("*");
      if (!updated) {
        throw new Error("Invoice status changed while voiding — re-check and retry");
      }
      // A customer could have opened /pay and minted a NEW PaymentIntent between
      // the pre-lock triage above and this locked update. If the attached PI
      // changed, refuse — rolling back so the operator retries and the new PI gets
      // triaged, rather than returning credit while a fresh client secret can charge.
      if ((updated.stripe_payment_intent_id || null) !== triagedVoidPiId) {
        throw new Error("A new payment session started for this invoice — re-check and retry the void");
      }
      // Re-check the money guard under the row lock: a cash payment could have
      // recorded between the pre-transaction check and this update (a webhook can
      // set payment_recorded_at / insert a paid payment row without flipping the
      // status the conditional update keys on). Rolling back beats voiding away
      // freshly-collected money.
      const voidAppliedPaymentLocked = await trx("payments")
        .whereIn("status", ["paid", "processing"])
        .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [updated.id])
        .first("id");
      if (updated.payment_recorded_at || voidAppliedPaymentLocked) {
        throw new Error("A payment was applied to this invoice while voiding — issue a refund instead");
      }
      const { restoreDepositCreditForVoidedInvoice } = require("./estimate-deposits");
      await restoreDepositCreditForVoidedInvoice({ invoice: updated, trx });
      // Return any auto-applied/prepaid account credit to the customer's balance
      // so voiding a credit-covered invoice never strands the credit.
      const { restoreAccountCreditForVoidedInvoice } = require("./customer-credit");
      await restoreAccountCreditForVoidedInvoice({ invoice: updated, createdBy: "system:void" }, trx);
      // Phase 2: drop a voided accrued invoice from its statement total in the
      // SAME transaction (rollupStatement excludes status='void'), so the void
      // and the statement total commit together. No-op once the statement is
      // frozen.
      if (updated.payer_statement_id) {
        await require("./payer-statements").rollupStatement(updated.payer_statement_id, trx);
      }
      invoice = updated;
    });
    await stopInvoiceFollowupSequence(id, "invoice_voided");
    try {
      await require("./annual-prepay-renewals").syncTermForInvoicePayment(
        invoice,
      );
    } catch (err) {
      logger.warn(
        `[invoice] annual prepay sync skipped after void ${invoice.invoice_number}: ${err.message}`,
      );
    }
    logger.info(`[invoice] Voided: ${invoice.invoice_number}`);
    return invoice;
  },

  /**
   * Settle a covered visit's PRE-EXISTING invoice as NON-CASH annual-prepay
   * coverage — the money was already collected on the term's own prepay invoice,
   * so this books NO `payments` row (which would double-count revenue; every
   * revenue rollup keys on payments.status='paid'). Mirrors the account-credit
   * `prepaid` close-out (status='prepaid' + paid_at leaves AR and is excluded from
   * collected-revenue), anchored on the DEDICATED invoices.annual_prepay_covered_term_id
   * (NOT annual_prepay_term_id, which means "this IS the term's prepay invoice").
   * Replaces void-on-covered, which loses the invoice + service record.
   *
   * FULL COVERAGE ONLY (invoice has no add-ons): an invoice with tech-added add-on
   * lines is left for the caller (the base-covered / add-ons-collectible SPLIT is a
   * dedicated follow-up). Fail-closed like void: refuses if a payment is applied
   * (refund instead) or money is in flight; cancels an open PaymentIntent first.
   * Returns { settled, reason, invoice } — settled=true only when marked prepaid.
   */
  async settleInvoiceAsAnnualPrepayCovered(id, termId, { recordedBy = "system:annual_prepay" } = {}) {
    if (!id || !termId) return { settled: false, reason: "bad_args", invoice: null };
    const current = await db("invoices").where({ id }).first();
    if (!current) return { settled: false, reason: "not_found", invoice: null };
    const status = String(current.status || "").toLowerCase();
    // Refuse non-collectible / money-in-flight statuses (matches
    // INVOICE_UNCOLLECTIBLE_STATUSES) — 'processing' is ACH in flight and must never
    // be flipped to prepaid; the rest are already terminal/settled.
    if (["paid", "prepaid", "processing", "void", "refunded", "canceled", "cancelled"].includes(status)) {
      return { settled: false, reason: "already_settled", invoice: current };
    }
    // Already coverage-settled by THIS term (dedicated marker) — no-op.
    if (String(current.annual_prepay_covered_term_id || "") === String(termId)) {
      return { settled: false, reason: "already_covered", invoice: current };
    }
    // The homeowner's prepay can never settle a third-party payer invoice.
    if (current.payer_id) return { settled: false, reason: "payer_billed", invoice: current };
    // Applied account credit: voidInvoice RESTORES credit_applied to the customer's
    // balance before closing; settling 'prepaid' here would consume that credit while
    // the prepay also covers the work. Defer to the caller's void (which restores it).
    if (Number(current.credit_applied) > 0) return { settled: false, reason: "has_applied_credit", invoice: current };
    // Ledger-backed estimate deposit credit → voidInvoice restores it; defer.
    if (invoiceHasDepositCreditLine(current)) return { settled: false, reason: "has_deposit_credit", invoice: current };
    // Any positive non-base charge (add-ons / checkout extras) → the base-covered /
    // extras-collectible split is a follow-up; the caller voids so nothing double-bills.
    if (invoiceHasNonBaseCharges(current)) return { settled: false, reason: "has_add_ons", invoice: current };
    // A cash-backed invoice (payment applied) must be refunded, not settled away.
    const appliedPayment = await db("payments")
      .whereIn("status", ["paid", "processing"])
      .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [current.id])
      .first("id");
    if (current.payment_recorded_at || appliedPayment) {
      throw new Error("Cannot annual-prepay-settle an invoice with a payment applied — issue a refund instead");
    }
    // Cancel any open PaymentIntent first (same triage as voidInvoice): the visit is
    // covered, so a live client secret must not still charge the card.
    const triagedPiId = current.stripe_payment_intent_id || null;
    if (triagedPiId) {
      const StripeService = require("./stripe");
      let pi;
      try {
        pi = await StripeService.retrievePaymentIntent(triagedPiId);
      } catch (e) {
        throw new Error(`Open payment session ${triagedPiId} could not be verified (${e.message}); resolve it before settling`);
      }
      if (!pi) throw new Error(`Open payment session ${triagedPiId} could not be verified (payment service unavailable); resolve it before settling`);
      if (PI_MONEY_IN_FLIGHT_STATUSES.includes(pi.status)) {
        throw new Error(`A payment is already in flight (${pi.status}); wait for it to settle or refund it before settling`);
      }
      if (pi.status !== "canceled") {
        try {
          await StripeService.cancelPaymentIntent(triagedPiId, { cancellation_reason: "abandoned" });
        } catch (e) {
          throw new Error(`Couldn't cancel the open payment session ${triagedPiId} (${e.message}); resolve it before settling`);
        }
      }
    }
    let settled = null;
    await db.transaction(async (trx) => {
      const locked = await trx("invoices").where({ id, status: current.status }).forUpdate().first();
      if (!locked) throw new Error("Invoice status changed while settling — re-check and retry");
      // Re-run the pre-lock business guards against the LOCKED row: a concurrent
      // account-credit apply, add-on add, or payer attach that kept the same status
      // would otherwise be overwritten (consuming credit / settling a payer or add-on
      // invoice as prepay). Aborting rolls back; the caller leaves it for normal handling.
      if (locked.payer_id) throw new Error("Invoice became payer-billed while settling — aborting");
      if (Number(locked.credit_applied) > 0) throw new Error("Account credit was applied while settling — aborting (void restores it)");
      if (invoiceHasDepositCreditLine(locked)) throw new Error("Deposit credit present while settling — aborting (void restores it)");
      if (invoiceHasNonBaseCharges(locked)) throw new Error("Extra charges were added while settling — aborting");
      if ((locked.stripe_payment_intent_id || null) !== triagedPiId) {
        throw new Error("A new payment session started for this invoice — re-check and retry the settlement");
      }
      const lockedApplied = await trx("payments")
        .whereIn("status", ["paid", "processing"])
        .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [locked.id])
        .first("id");
      if (locked.payment_recorded_at || lockedApplied) {
        throw new Error("A payment was applied to this invoice while settling — issue a refund instead");
      }
      const stamp = etDateString();
      const noteLine = `[${stamp}] Covered by annual prepay (term ${termId}) — non-cash, no charge due`;
      const [updated] = await trx("invoices").where({ id, status: current.status }).update({
        status: "prepaid",
        prepaid_prev_status: String(locked.status || "").toLowerCase() === "sending" ? "sent" : locked.status,
        prepaid_at: trx.fn.now(),
        prepaid_by: recordedBy,
        paid_at: trx.fn.now(),
        annual_prepay_covered_term_id: termId,
        notes: locked.notes ? `${locked.notes}\n${noteLine}` : noteLine,
        updated_at: trx.fn.now(),
      }).returning("*");
      if (!updated) throw new Error("Invoice status changed while settling — re-check and retry");
      settled = updated;
    });
    // Terminally close any dunning sequence, matching voidInvoice and the
    // account-credit close-out. The runner would skip 'prepaid' anyway
    // (TERMINAL_INVOICE_STATUSES), but leaving the sequence row 'active'
    // misreports its outcome. Best-effort (the wrapper swallows errors).
    await stopInvoiceFollowupSequence(id, "annual_prepay_covered");
    logger.info(`[invoice] Annual-prepay settled ${settled.invoice_number} (full: prepaid, non-cash)`);
    return { settled: true, invoice: settled };
  },

  /**
   * Reverse annual-prepay coverage settlements when a term's prepay is
   * refunded/cancelled (mirrors clearPrepaidStampsForTerm for the visit stamps).
   * Full-covered invoices (status='prepaid' via annual_prepay_covered_term_id)
   * reopen to their pre-settlement collectible status so the work is owed again.
   * NEVER reopens a cash-paid invoice. Best-effort per invoice.
   */
  async reopenAnnualPrepayCoveredInvoicesForTerm(termId, conn = db) {
    if (!termId) return 0;
    let reopened = 0;
    const reopenedIds = [];
    const rows = await conn("invoices")
      .where({ annual_prepay_covered_term_id: termId, status: "prepaid" });
    for (const inv of rows) {
      // A cash payment landed after settlement → don't reopen (refund handles it).
      if (inv.payment_recorded_at) continue;
      const paidPayment = await conn("payments")
        .whereIn("status", ["paid", "processing"])
        .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [inv.id])
        .first("id");
      if (paidPayment) continue;
      try {
        const updated = await conn("invoices").where({ id: inv.id, status: "prepaid" }).update({
          status: inv.prepaid_prev_status || "sent",
          paid_at: null,
          prepaid_at: null,
          prepaid_prev_status: null,
          prepaid_by: null,
          // Clear the coverage marker: the settlement is undone, so a stale
          // "settled by term X" claim must not survive (it would no-op a future
          // legitimate re-settlement by the same term as `already_covered`).
          annual_prepay_covered_term_id: null,
          updated_at: conn.fn.now(),
        });
        if (updated) {
          reopened += 1;
          reopenedIds.push(inv.id);
        }
      } catch (err) {
        logger.warn(`[invoice] annual-prepay coverage reopen skipped for ${inv.invoice_number || inv.id}: ${err.message}`);
      }
    }
    // The reopened invoices are collectible again, but settlement terminally
    // STOPPED their dunning sequences — re-arm reminders, mirroring the admin
    // reverse-prepaid flow (resumeSequence reactivates an existing row;
    // scheduleForInvoice creates one if none exists). Both read committed state
    // via the global db, so this only works outside a caller transaction —
    // every current caller passes the default db; if a future caller wraps this
    // in a trx, warn loudly (re-arm must then run post-commit) instead of
    // silently leaving reminders dead. Best-effort: never blocks the refund sync.
    if (reopenedIds.length && conn.isTransaction) {
      logger.warn(`[invoice] annual-prepay reopen ran inside a transaction — follow-up re-arm skipped for ${reopenedIds.length} invoice(s); re-arm post-commit`);
    } else {
      for (const invId of reopenedIds) {
        try {
          const FollowUps = require("./invoice-followups");
          await FollowUps.resumeSequence(invId);
          await FollowUps.scheduleForInvoice(invId);
        } catch (err) {
          logger.warn(`[invoice] annual-prepay reopen follow-up re-arm failed for ${invId}: ${err.message}`);
        }
      }
    }
    return reopened;
  },

  /**
   * Void any still-open invoices minted for a now-cancelled scheduled
   * service ("Charge now" pre-mints, completion mints) so dunning doesn't
   * chase a cancelled job. Shared by every admin cancellation surface
   * (schedule single + bulk, dispatch single + series).
   *
   * Money-state rules:
   *   - Only safely-voidable statuses are touched (never paid/processing —
   *     mirrors assertInvoiceVoidable).
   *   - Invoices with money already applied are skipped: a PARTIAL prepaid
   *     credit leaves the invoice in a voidable status (e.g. draft) while a
   *     paid payments row + payment_recorded_at already exist — auto-voiding
   *     would strand that money with no refund/credit path.
   *   - A live attached PaymentIntent is cancelled at Stripe FIRST: /pay
   *     setup stamps invoices.stripe_payment_intent_id before any payments
   *     row exists, and ACH / Express Checkout can charge Stripe before
   *     /confirm. Voiding without cancelling the PI would let a real charge
   *     land against a void invoice, unreconciled. If the PI is
   *     processing / succeeded / requires_capture — or the cancel attempt
   *     races a confirmation and throws — the invoice is skipped and flagged
   *     for manual review instead.
   *   - The final re-check + void run atomically under SELECT ... FOR UPDATE
   *     on the invoice row, so a payment landing concurrently
   *     (applyPrepaidCredit / Stripe webhook paths also lock the row) can't
   *     slip in between the check and the void. Stripe triage happens BEFORE
   *     the lock (never hold a row lock across a network call); the trx
   *     re-checks that no new PI was attached after triage.
   *
   * Best-effort: logs and continues, never throws. Returns voided invoice ids.
   */
  async voidOpenInvoicesForCancelledService(scheduledServiceId) {
    const voided = [];
    if (!scheduledServiceId) return voided;
    try {
      const candidates = await db("invoices")
        .where({ scheduled_service_id: scheduledServiceId })
        .whereIn("status", CANCELLED_SERVICE_VOIDABLE_STATUSES)
        .select("id", "invoice_number", "stripe_payment_intent_id", "payer_statement_id");
      if (candidates.length === 0) return voided;
      const StripeService = require("./stripe");
      for (const candidate of candidates) {
        try {
          // ── Stripe PI triage (pre-lock) ────────────────────────────────
          const triagedPiId = candidate.stripe_payment_intent_id || null;
          if (triagedPiId) {
            let pi;
            try {
              pi = await StripeService.retrievePaymentIntent(triagedPiId);
            } catch (e) {
              logger.warn(
                `[invoice] NOT auto-voiding ${candidate.invoice_number} for cancelled service ${scheduledServiceId} — PaymentIntent ${triagedPiId} lookup failed (${e.message}); needs manual review`,
              );
              continue;
            }
            if (!pi) {
              // A PI id is stamped but Stripe isn't configured/reachable —
              // can't verify the money state, so fail closed.
              logger.warn(
                `[invoice] NOT auto-voiding ${candidate.invoice_number} for cancelled service ${scheduledServiceId} — PaymentIntent ${triagedPiId} attached but unverifiable; needs manual review`,
              );
              continue;
            }
            if (PI_MONEY_IN_FLIGHT_STATUSES.includes(pi.status)) {
              logger.warn(
                `[invoice] NOT auto-voiding ${candidate.invoice_number} for cancelled service ${scheduledServiceId} — payment in flight (PI ${triagedPiId} is ${pi.status}); needs manual refund/credit review`,
              );
              continue;
            }
            if (pi.status !== "canceled") {
              try {
                await StripeService.cancelPaymentIntent(triagedPiId, {
                  cancellation_reason: "abandoned",
                });
                logger.info(
                  `[invoice] Cancelled PaymentIntent ${triagedPiId} (was ${pi.status}) before voiding ${candidate.invoice_number} — scheduled service ${scheduledServiceId} cancelled`,
                );
              } catch (e) {
                // Cancel races a confirmation → the PI may now be charging.
                logger.warn(
                  `[invoice] NOT auto-voiding ${candidate.invoice_number} for cancelled service ${scheduledServiceId} — PaymentIntent ${triagedPiId} cancel failed (${e.message}); needs manual review`,
                );
                continue;
              }
            }
          }

          // ── Atomic re-check + void (row lock) ──────────────────────────
          const result = await db.transaction(async (trx) => {
            // Phase 2: parent-before-child lock order (matches the edit/void
            // paths) so a concurrent accrued edit/void + this cancellation can't
            // AB-BA deadlock. Lock the statement FIRST (using the
            // payer_statement_id carried from the candidate scan — it never
            // changes after creation), skip a finalized one, then lock the
            // invoice.
            if (candidate.payer_statement_id) {
              const stmt = await trx("payer_statements").where({ id: candidate.payer_statement_id }).forUpdate().first("status");
              if (stmt && stmt.status !== "open") {
                return { skipped: "on a finalized payer statement; needs a credit on the next statement", invoice: candidate };
              }
            }
            const locked = await trx("invoices")
              .where({ id: candidate.id })
              .forUpdate()
              .first();
            if (!locked) return { skipped: "invoice no longer exists" };
            if (!CANCELLED_SERVICE_VOIDABLE_STATUSES.includes(locked.status)) {
              return { skipped: `status moved to ${locked.status}`, invoice: locked };
            }
            // A different/new PI attached after triage means a customer is
            // actively starting a payment — skip.
            if ((locked.stripe_payment_intent_id || null) !== triagedPiId) {
              return {
                skipped: `PaymentIntent changed to ${locked.stripe_payment_intent_id || "none"} after triage (payment in progress); needs manual review`,
                invoice: locked,
              };
            }
            // Payments reference invoices via metadata.invoice_id (prepaid
            // credits, Stripe charges alike — there is no payments.invoice_id
            // column). Either signal means applied money: skip the auto-void.
            const appliedPayment = await trx("payments")
              .whereIn("status", ["paid", "processing"])
              .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [locked.id])
              .first("id");
            if (locked.payment_recorded_at || appliedPayment) {
              return {
                skipped: `money already applied (${appliedPayment ? `payment ${appliedPayment.id}` : "payment_recorded_at set"}); needs manual refund/credit review`,
                invoice: locked,
              };
            }
            const [voidedInvoice] = await trx("invoices")
              .where({ id: locked.id, status: locked.status })
              .update({ status: "void", updated_at: new Date() })
              .returning("*");
            if (!voidedInvoice) return { skipped: "concurrent status change", invoice: locked };
            // Same-transaction ledger restore, matching voidInvoice: a
            // cancelled job's pre-minted first invoice may carry the
            // estimate's deposit credit, which must become available again
            // (roll-forward or terminal sweep) once this invoice stops
            // billing.
            const { restoreDepositCreditForVoidedInvoice } = require("./estimate-deposits");
            await restoreDepositCreditForVoidedInvoice({ invoice: voidedInvoice, trx });
            // Return any auto-applied account credit too (a partially credit-
            // covered collectible invoice for a cancelled service).
            const { restoreAccountCreditForVoidedInvoice } = require("./customer-credit");
            await restoreAccountCreditForVoidedInvoice({ invoice: voidedInvoice, createdBy: "system:service_cancel" }, trx);
            // Phase 2: drop the voided accrued child from its OPEN statement total
            // in the same transaction (rollupStatement excludes status='void').
            if (voidedInvoice.payer_statement_id) {
              await require("./payer-statements").rollupStatement(voidedInvoice.payer_statement_id, trx);
            }
            return { voided: true, invoice: voidedInvoice, previousStatus: locked.status };
          });

          if (!result.voided) {
            if (result.skipped && result.invoice) {
              logger.warn(
                `[invoice] NOT auto-voiding ${result.invoice.invoice_number} for cancelled service ${scheduledServiceId} — ${result.skipped}`,
              );
            }
            continue;
          }

          voided.push(result.invoice.id);
          logger.info(
            `[invoice] Voided ${result.invoice.invoice_number} (was ${result.previousStatus}, $${result.invoice.total}) — scheduled service ${scheduledServiceId} cancelled`,
          );
          // Post-commit side effects, matching voidInvoice.
          await stopInvoiceFollowupSequence(result.invoice.id, "invoice_voided");
          try {
            await require("./annual-prepay-renewals").syncTermForInvoicePayment(
              result.invoice,
            );
          } catch (err) {
            logger.warn(
              `[invoice] annual prepay sync skipped after void ${result.invoice.invoice_number}: ${err.message}`,
            );
          }
        } catch (e) {
          logger.error(
            `[invoice] Failed to void invoice ${candidate.id} for cancelled service ${scheduledServiceId}: ${e.message}`,
          );
        }
      }
    } catch (e) {
      logger.error(
        `[invoice] Void sweep failed for cancelled service ${scheduledServiceId}: ${e.message}`,
      );
    }
    return voided;
  },

  async getStats() {
    const today = etDateString();
    const [totals] = await db("invoices")
      .select(
        db.raw("COUNT(*) as total"),
        db.raw("COUNT(*) FILTER (WHERE status = 'paid') as paid"),
        db.raw(
          "COUNT(*) FILTER (WHERE status NOT IN ('paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled')) as outstanding",
        ),
        db.raw(
          "COUNT(*) FILTER (WHERE status NOT IN ('paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled') AND (status = 'overdue' OR due_date < ?)) as overdue",
          [today],
        ),
        db.raw(
          // Cash collected, not invoiced value: a partial-credit paid invoice keeps
          // its gross `total`, so summing it would book referral/goodwill account
          // credit as collected revenue. Sum amount due (total − credit_applied).
          "COALESCE(SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)) FILTER (WHERE status = 'paid'), 0) as total_collected",
        ),
        db.raw(
          "COALESCE(SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)) FILTER (WHERE status NOT IN ('paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled')), 0) as total_outstanding",
        ),
      )
      .whereNull("archived_at");

    // Estimate-deposit visibility: deposits live in their own ledger
    // (estimate_deposits), never as payments/invoices rows, so without this
    // block collected deposit money is invisible on the invoices surface.
    // "On hand" = received rows' unapplied remainder (same formula as
    // pendingDepositCredit); "collected" = all money that ever arrived
    // (received/credited/refunding/refunded — received_at is only stamped on
    // real Stripe success). Fail-soft: a ledger read miss must not take down
    // the invoice stats header.
    let deposits = { onHand: 0, onHandCount: 0, collected: 0 };
    try {
      const [d] = await db("estimate_deposits").select(
        db.raw(
          "COALESCE(SUM(GREATEST(amount - COALESCE(credited_amount, 0) - COALESCE(refunded_amount, 0), 0)) FILTER (WHERE status = 'received'), 0) as on_hand",
        ),
        db.raw(
          "COUNT(*) FILTER (WHERE status = 'received' AND amount - COALESCE(credited_amount, 0) - COALESCE(refunded_amount, 0) > 0) as on_hand_count",
        ),
        db.raw(
          "COALESCE(SUM(amount - COALESCE(refunded_amount, 0)) FILTER (WHERE received_at IS NOT NULL), 0) as collected",
        ),
      );
      deposits = {
        onHand: parseFloat(d.on_hand),
        onHandCount: parseInt(d.on_hand_count),
        collected: parseFloat(d.collected),
      };
    } catch (err) {
      logger.warn(`[invoice] deposit stats read failed: ${err.message}`);
    }

    return {
      total: parseInt(totals.total),
      paid: parseInt(totals.paid),
      outstanding: parseInt(totals.outstanding),
      overdue: parseInt(totals.overdue),
      totalCollected: parseFloat(totals.total_collected),
      totalOutstanding: parseFloat(totals.total_outstanding),
      deposits,
    };
  },
};

InvoiceService._internals = {
  insertInvoiceRow,
  isInvoiceNumberCollision,
};

// Invoice statuses that need NO further money handling when their linked
// scheduled service is cancelled: nothing left to collect, send, refund, or
// review. Exported for callers of voidOpenInvoicesForCancelledService that
// post-check its silent skips — the sweep intentionally leaves what it can't
// safely void OPEN without throwing, so a caller reporting an auto-processing
// outcome must re-query for anything OUTSIDE this set: still-collectible
// statuses the sweep skipped, a transient 'sending' claim, or captured /
// in-flight money ('paid' / 'processing') that now needs a refund/credit
// decision because the service won't happen.
InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES = ['void', 'refunded', 'canceled', 'cancelled'];

module.exports = InvoiceService;
// Exposed for unit tests (pure helpers).
module.exports._invoiceHasNonBaseCharges = invoiceHasNonBaseCharges;
module.exports._invoiceHasDepositCreditLine = invoiceHasDepositCreditLine;
module.exports._parseInvoiceLineItems = parseInvoiceLineItems;
