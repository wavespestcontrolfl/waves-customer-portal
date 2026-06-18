const crypto = require("crypto");
const db = require("../models/db");
const logger = require("./logger");
const TaxCalculator = require("./tax-calculator");
const DiscountEngine = require("./discount-engine");
const { etDateString, addETDays } = require("../utils/datetime-et");
const { shortenOrPassthrough, invoiceShortCodePrefix } = require("./short-url");
const { publicPortalUrl } = require("../utils/portal-url");
const { loadInvoiceAnnualPrepay } = require("./invoice-prepay");

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
];

// Stripe PaymentIntent states where money is in flight or already captured /
// authorized — an invoice attached to one of these must never be auto-voided.
const PI_MONEY_IN_FLIGHT_STATUSES = ["processing", "succeeded", "requires_capture"];

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
  let rate = 0;
  let taxAmount = 0;
  if (isCommercial) {
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
  async create({
    database = db,
    customerId,
    serviceRecordId,
    scheduledServiceId,
    title,
    lineItems,
    notes,
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
  }) {
    const customer = await database("customers").where({ id: customerId }).first();
    if (!customer) throw new Error("Customer not found");
    const trustedStoredSources = new Set(trustedStoredDiscountSources);

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
    let appliedDepositCredit = 0;
    if (depositCredit && Number(depositCredit.amount) > 0) {
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
          due_date: dueDate || etDateString(addETDays(new Date(), 30)),
          status: "draft",
          ...(scheduledServiceId
            ? { scheduled_service_id: scheduledServiceId }
            : {}),
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
        const recordArgs = [invoice.id, auditRows, "system"];
        if (database !== db) recordArgs.push(database);
        await DiscountEngine.recordInvoiceDiscounts(...recordArgs);
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

    const isCommercial =
      cust.property_type === "commercial" || cust.property_type === "business";
    let rate, taxAmount;
    if (!isCommercial) {
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
    const claim = await claimInvoiceForSend(invoiceId, { allowClaimed });
    const { invoice, previousStatus, claimed } = claim;

    const customer = await db("customers")
      .where({ id: invoice.customer_id })
      .first();
    if (!customer?.phone) {
      await restoreSendClaim(invoiceId, previousStatus, claimed);
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
        }
      } catch {
        formattedDate = "";
      }
    }

    // Body comes from the editable invoice_sent template. If the row is
    // missing/disabled, we skip the SMS rather than falling back to inline copy.
    let body = null;
    try {
      const templates = require("../routes/admin-sms-templates");
      body = await templates.getTemplate("invoice_sent", {
        first_name: customer.first_name || "",
        service_type: serviceType,
        service_date: formattedDate || "today",
        pay_url: payUrl,
      }, {
        workflow: "invoice_send",
        entity_type: "invoice",
        entity_id: invoiceId,
      });
    } catch (err) {
      logger.warn(`[invoice] Template lookup failed: ${err.message}`);
    }

    if (!body) {
      logger.warn(
        `[invoice] invoice_sent template missing/disabled — skipping SMS for invoice ${invoiceId}`,
      );
      await restoreSendClaim(invoiceId, previousStatus, claimed);
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
          description: `Invoice ${invoice.invoice_number} sent via SMS: $${invoice.total}`,
          metadata: JSON.stringify({ invoiceId, payUrl }),
        })
        .catch(() => {});

      logger.info(
        `[invoice] SMS sent for ${invoice.invoice_number} (customerId=${customer.id})`,
      );
      return { sent: true, payUrl };
    } catch (err) {
      await restoreSendClaim(invoiceId, previousStatus, claimed);
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
    const claim = await claimInvoiceForSend(invoiceId, { allowClaimed });
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
    } else {
      await restoreSendClaim(invoiceId, previousStatus, claimed);
    }
    return { ok, sms, email, payUrl };
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
    const receiptAmount = Number.parseFloat(invoice.total || 0);
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

    // Apply the column-based editability predicates ATOMICALLY on the write so
    // a worker that stamps stripe_payment_intent_id, flips status off
    // draft/scheduled, or links a prepay term between the guard read above and
    // this write cannot be clobbered. If those predicates no longer hold the
    // update matches zero rows and we fail closed instead of rewriting money.
    const [invoice] = await db("invoices")
      .where({ id })
      .whereIn("status", ["draft", "scheduled"])
      .whereNull("stripe_payment_intent_id")
      .whereNull("annual_prepay_term_id")
      .update(data)
      .returning("*");
    if (!invoice) {
      throw new Error(
        "Only draft or scheduled invoices can be edited — its status or payment state changed while you were editing",
      );
    }
    return invoice;
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
    if (current.status === "void") {
      await stopInvoiceFollowupSequence(id, "invoice_voided");
      return current;
    }
    // Void + deposit-ledger restore commit TOGETHER: a committed void beside
    // a still-consumed deposit strands the customer's money — the credit can
    // no longer roll forward or refund (a restore failure rolls the void
    // back; a blocked void beats stranded money). The status-conditional
    // update makes a concurrent void/payment lose cleanly, so the restore
    // can never run twice for one invoice.
    let invoice = null;
    await db.transaction(async (trx) => {
      const [updated] = await trx("invoices")
        .where({ id, status: current.status })
        .update({ status: "void", updated_at: new Date() })
        .returning("*");
      if (!updated) {
        throw new Error("Invoice status changed while voiding — re-check and retry");
      }
      const { restoreDepositCreditForVoidedInvoice } = require("./estimate-deposits");
      await restoreDepositCreditForVoidedInvoice({ invoice: updated, trx });
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
        .select("id", "invoice_number", "stripe_payment_intent_id");
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
          "COALESCE(SUM(total) FILTER (WHERE status = 'paid'), 0) as total_collected",
        ),
        db.raw(
          "COALESCE(SUM(total) FILTER (WHERE status NOT IN ('paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled')), 0) as total_outstanding",
        ),
      )
      .whereNull("archived_at");
    return {
      total: parseInt(totals.total),
      paid: parseInt(totals.paid),
      outstanding: parseInt(totals.outstanding),
      overdue: parseInt(totals.overdue),
      totalCollected: parseFloat(totals.total_collected),
      totalOutstanding: parseFloat(totals.total_outstanding),
    };
  },
};

InvoiceService._internals = {
  insertInvoiceRow,
  isInvoiceNumberCollision,
};

module.exports = InvoiceService;
