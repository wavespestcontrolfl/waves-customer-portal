const crypto = require("crypto");
const { isDeepStrictEqual } = require("node:util");
const db = require("../models/db");
const logger = require("./logger");
const TaxCalculator = require("./tax-calculator");
const DiscountEngine = require("./discount-engine");
const {
  percentageDiscountDollars,
  stackDocumentDiscounts,
  isPercentDiscountType,
  isFixedDiscountType,
  isVariableOrCustomDiscountPreset,
} = require("./discount-stack");
const { discountStackingLive } = require("../config/feature-gates");
const { etDateString, addETDays, etCalendarDayOf } = require("../utils/datetime-et");
const { shortenOrPassthrough, invoiceShortCodePrefix } = require("./short-url");
const { publicPortalUrl } = require("../utils/portal-url");
const { loadInvoiceAnnualPrepay, buildPrepayCoverageSummary } = require("./invoice-prepay");
const PhotoService = require("./photos");
const config = require("../config");
const { customerSafeServiceNotes } = require("./project-types");
const {
  SEND_CLAIMABLE_STATUSES,
  SEND_FINALIZABLE_STATUSES,
  isStaleClaimReviewHold,
  staleClaimReviewHoldError,
} = require("./invoice-helpers");

// Customer-facing presign TTL: photo URLs mint per page-load, so the TTL must
// cover page DWELL time, not link age (the customer-photo blank-render class).
// Falls back to 24h until PhotoService.CUSTOMER_DWELL_TTL_SECONDS ships.
const SERVICE_PHOTO_VIEW_TTL_SECONDS =
  PhotoService.CUSTOMER_DWELL_TTL_SECONDS || 24 * 60 * 60;

// Recover the S3 object key from a legacy stored service_photos.s3_url so
// pre-fix invoice snapshots (URL-only, long expired) can be re-signed instead
// of served dead. Only trusts amazonaws.com hosts; unknown shapes return null.
function s3KeyFromStoredUrl(storedUrl) {
  if (!storedUrl || typeof storedUrl !== "string") return null;
  try {
    const url = new URL(storedUrl);
    if (!url.hostname.endsWith(".amazonaws.com")) return null;
    const path = decodeURIComponent(url.pathname.replace(/^\/+/, "")).split("?")[0];
    const bucket = config.s3?.bucket;
    if (!path || !bucket) return null;
    // Virtual-hosted style: <bucket>.s3.<region>.amazonaws.com/<key>
    if (url.hostname.startsWith(`${bucket}.`)) return path;
    // Path-style: s3.<region>.amazonaws.com/<bucket>/<key>
    if (path.startsWith(`${bucket}/`)) return path.slice(bucket.length + 1);
    return null;
  } catch {
    return null;
  }
}

// Presign snapshot photos fresh at read time (presign-first, stored-URL-last).
// Snapshots persist the durable s3_key; s3_url in the OUTPUT is always a fresh
// presign when a key is resolvable, so no consumer ever renders an expired URL.
async function withFreshServicePhotoUrls(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return photos || [];
  return Promise.all(
    photos.map(async (photo) => {
      const key =
        photo?.s3_key || photo?.storage_key || s3KeyFromStoredUrl(photo?.s3_url);
      if (key) {
        try {
          const fresh = await PhotoService.getViewUrl(
            key,
            SERVICE_PHOTO_VIEW_TTL_SECONDS,
          );
          return { ...photo, s3_url: fresh, url: fresh };
        } catch (err) {
          logger.warn(`[invoice] photo presign failed key=${key}: ${err.message}`);
        }
      }
      return { ...photo, url: photo?.s3_url || null };
    }),
  );
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
// Statuses the generic admin edit (InvoiceService.update) may rewrite.
// sent/viewed/overdue joined draft/scheduled by owner ruling 2026-07-17
// (edit a delivered invoice, then resend so the customer sees the new
// version): a delivered-but-unpaid invoice is still collectible, and both
// its pay page and a resent PDF render from the live row, so a rewrite is
// consistent everywhere the customer can reach it — only the already-
// delivered email/PDF goes stale, which the post-edit resend prompt exists
// to fix. The money fences are unchanged: paid/prepaid/processing/void/
// sending stay locked here, and the PaymentIntent / payment-plan /
// prepay-term / credit guards in update() still block any invoice a
// payment has actually touched.
const EDIT_ALLOWED_STATUSES = [...SEND_CLAIMABLE_STATUSES];

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

// Line-level base-application identity — THE shared predicate (PR #3476):
// the base visit charge is tagged client_id `scheduled_<id>_primary`
// (createFromService below) and the converter's acceptance line reads
// "First service application". Every consumer — switch-supersede restore,
// prepay-switch undo, the setup-fee obligation detector and its alerts —
// shares this identity so line-identity changes land in ONE place.
// Whether a matching line must ALSO carry a positive amount is a
// caller-level billing-evidence requirement, not part of the identity.
function lineIsBaseApplication(li) {
  return /_primary$/.test(String(li?.client_id || ""))
    || /^first (service )?application$/i.test(String(li?.description || "").trim());
}

// Ledger-backed estimate deposit credit rides as a `deposit_credit` line; voidInvoice
// restores it (restoreDepositCreditForVoidedInvoice). Settling 'prepaid' would strand
// it, so these defer to the caller's void.
// On-site prepay-switch markers (see admin-schedule prepay-switch): the
// superseded-by marker rides a voided per-application invoice's notes keyed
// by the prepay invoice that replaced it; the restore marker rides the
// replacement's notes keyed by the voided row. Together they make every
// restore idempotent and every superseded row findable when its prepay dies.
function prepaySwitchSupersededByMarker(prepayInvoiceId) {
  return `[prepay-switch-superseded-by:${prepayInvoiceId}]`;
}
function prepaySwitchRestoreMarker(voidedInvoiceId) {
  return `[prepay-switch-restore:${voidedInvoiceId}]`;
}
// A REPLACEMENT must never inherit the superseded-by marker (Codex
// on-site-switch P0 r11): if the replacement is itself voided later, a
// subsequent sync for the old prepay would read it as ANOTHER superseded
// invoice and mint fresh collectible AR.
function stripPrepaySwitchSupersededMarkers(notes) {
  return String(notes || "").replace(/\n?\[prepay-switch-superseded-by:[^\]]+\]/g, "");
}

// The date the restore's overlap assert runs against: the RESTORED VISIT's
// date, falling back for an UNATTACHED setup-only row (Codex P0 r13) to the
// first upcoming visit of the accept's own series (the provenance stamp
// carries the estimate id) — today only as the last resort. Shared by the
// term-cancel restore and the undo endpoint so the two can never disagree.
async function prepaySwitchRestoreAssertDate(trx, row) {
  const dateOf = (v) => {
    const m = /^\d{4}-\d{2}-\d{2}/.exec(v instanceof Date ? v.toISOString() : String(v || ""));
    return m ? m[0] : null;
  };
  if (row.scheduled_service_id) {
    const visitRow = await trx("scheduled_services")
      .where({ id: row.scheduled_service_id })
      .first("scheduled_date");
    const d = visitRow && dateOf(visitRow.scheduled_date);
    if (d) return d;
  }
  const est = /Auto-generated from accepted estimate #([^\s.]+)/i.exec(String(row.notes || ""));
  if (est) {
    try {
      const seriesRows = await trx("scheduled_services")
        .where({ source_estimate_id: est[1] })
        .whereNotIn("status", ["cancelled", "canceled", "rescheduled"])
        .select("scheduled_date");
      const today = etDateString();
      const dates = seriesRows.map((r) => dateOf(r.scheduled_date)).filter(Boolean).sort();
      const upcoming = dates.find((d) => d >= today);
      if (upcoming) return upcoming;
      if (dates.length) return dates[dates.length - 1];
    } catch { /* fall through to today */ }
  }
  return etDateString();
}

function invoiceHasDepositCreditLine(invoice) {
  return parseInvoiceLineItems(invoice.line_items).some(
    (li) => String(li.category || "") === "deposit_credit",
  );
}

// Linked-visit guards for unvoidInvoice (Codex #3493 r2/r3). Runs TWICE:
// pre-transaction as a fast fail, and again INSIDE the restore transaction
// on the freshly-locked invoice row — a cancellation, free re-service
// conversion, or annual-prepay stamping can commit between the two, and the
// cancellation sweep only voids non-void invoices, so it would miss a
// restore that commits on a stale verdict. All reads fail CLOSED.
async function assertUnvoidableLinkedVisit(conn, invoiceRow, { lock = false } = {}) {
  if (!invoiceRow.scheduled_service_id) return;
  let svc = null;
  try {
    // The in-transaction pass takes the visit row lock (Codex #3493 r8): a
    // concurrent writer holding the row (coverage stamping, cancellation)
    // is uncommitted-invisible to a plain MVCC read, so a lockless second
    // read could pass on the stale version while both commit. FOR UPDATE
    // waits for the in-flight writer and reads the committed result.
    let q = conn("scheduled_services").where({ id: invoiceRow.scheduled_service_id });
    if (lock) q = q.forUpdate();
    svc = await q.first();
  } catch (err) {
    throw new Error(
      `Could not verify the linked service visit — refusing to unvoid (${err.message})`,
    );
  }
  if (!svc) return;
  // Cancellation and no-show deliberately void the visit's open invoices
  // (voidOpenInvoicesForCancelledService; the no-show flow may also charge
  // the no-show fee) — restoring one while the visit stays terminal would
  // bill work that was not performed.
  const svcStatus = String(svc.status || "").toLowerCase();
  if (["cancelled", "canceled", "rescheduled", "no_show", "skipped"].includes(svcStatus)) {
    throw new Error(
      `Cannot unvoid — the linked service visit is ${svcStatus}; restore or re-book the visit before restoring its invoice`,
    );
  }
  // Free re-service conversion (admin-schedule update-details) zero-prices
  // the visit and voids its unpaid invoices ON PURPOSE — charge-now and
  // completion reuse a non-void invoice by scheduled_service_id, so a
  // restored stale charge would be presented/collected for a visit that is
  // now free.
  if (svc.is_callback && !(Number(svc.estimated_price) > 0)) {
    throw new Error(
      "Cannot unvoid — this visit was converted to a free re-service and its invoice was retired with it; re-price the visit before restoring a charge",
    );
  }
  // Annual-prepay stamping: prepaid_method + amount + term link mean the
  // base work's money lives on the term's prepay invoice (the dispatch
  // add-ons fallback voids exactly these invoices with NO invoice-level
  // term stamp). annualPrepayCoversVisit is deliberately NOT used here: it
  // fails OPEN (returns false on read errors) — right for billing
  // suppression, wrong for a restore guard. The stamps alone refuse: fail
  // closed, no async failure modes, and the annual-prepay flows own any
  // stale-stamp cleanup.
  const AnnualPrepay = require("./annual-prepay-renewals");
  if (
    svc.prepaid_method === AnnualPrepay.ANNUAL_PREPAY_PREPAID_METHOD
    && Number(svc.prepaid_amount) > 0
    && svc.annual_prepay_term_id
  ) {
    throw new Error(
      "Cannot unvoid — this visit is stamped prepaid by an annual prepay term, so its base work is already paid; bill any extras on a new invoice instead",
    );
  }
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

// overrideDollars: the SCOPED document stack's own resolved dollars for this
// stamp (only ever passed for a document-wide appointment stamp narrowed to
// one service — see stackInvoiceDocumentDiscounts's documentStoredDollarsByItem)
// — a stamp narrowed to a service this invoice no longer carries resolves
// against an empty pool there and must be 0, not the frozen amount recorded
// when the line still existed. Omitted (undefined) for every other stored
// item (a per-line stamp, or an unscoped document-wide one), which keep the
// frozen dollars exactly as before this lane.
function resolveStoredDiscountLineItem(item, row, overrideDollars) {
  const dollars = overrideDollars != null ? overrideDollars : storedDiscountDollars(item);
  // Codex pre-push audit P0 (round 6 on PR #4655, post-push): overrideDollars
  // is the DOCUMENT-STACK-RESOLVED amount (computeStackedDocumentDiscountLines,
  // gate ON) — it can be LESS than the stamp's original face value when a
  // competing document-wide credit clamps what's left for it (a $50 line
  // credit resolved to $23.33 by an $80 document credit already ahead of
  // it in canonical order). Before this fix, only item.unit_price/.amount
  // (the invoice's own display/total fields) picked up the clamped
  // number — item.discount_dollars, the field storedDiscountDollars()
  // falls back to for the NEXT resolve with no override (every gate-OFF
  // edit, and any gate-ON resolve of an item the stack doesn't touch),
  // stayed at its stale, larger original value. An unrelated LATER edit —
  // even under gate OFF, even with this exact item unchanged — silently
  // replayed the stale $50 instead of the $23.33 this invoice was ACTUALLY
  // saved with, changing the total out from under the operator. Now
  // persists the resolved amount as the row's own discount_dollars (the
  // field every future resolve reads), preserving the pre-clamp face
  // value ONCE under discount_face_value for audit — never overwritten on
  // a later resolve, so it always reads the ORIGINAL stamped amount.
  if (overrideDollars != null) {
    if (item.discount_face_value == null && hasNumericValue(item.discount_dollars)) {
      item.discount_face_value = item.discount_dollars;
    }
    item.discount_dollars = dollars;
  }
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

// Codex pre-push audit P1 (round 4 on PR #4655): loadInvoiceDiscountRows'
// active/visible filter is correct for a FRESH pick (a retired row must
// never become newly selectable) but wrong for a non-stackable-group
// CONFLICT check against a row that is already trusted/persisted on this
// invoice — a discount disabled or hidden after being applied silently
// dropped out of assertNewStackGroupConflicts's input entirely, so a fresh
// same-group pick next to it compounded instead of being rejected. Bare,
// UNFILTERED catalog metadata (id/name/stack_group/is_stackable) for
// specific ids — used ONLY to widen the row map the conflict check reads,
// never to make a retired row a valid fresh pick.
async function loadDiscountStackMetaRows(ids = [], database = db) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!uniqueIds.length) return [];
  return database("discounts").whereIn("id", uniqueIds);
}

// Codex pre-push audit P2 x2 (round 5 on PR #4655): the earlier version of
// this helper merged retired metadata straight into the SAME id-keyed map
// every negative item's `row` is looked up from — so a brand-new, FRESH
// line item that merely happened to reuse a retired discount_id (a stale
// picker cache, or a direct API call) got that retired row back too, was
// treated as a valid pick, and applied the retired discount again,
// bypassing the "Invalid line-item discount" refusal a fresh item pointing
// at a missing/retired row must always hit. This now returns ONLY the
// newly-fetched metadata, in its OWN separate map — never merged into
// rowById, so nothing downstream that resolves a row generically (pricing,
// lineEntries admission) can see it. computeStackedDocumentDiscountLines
// below reads this map ONLY as a per-entry fallback, and ONLY for an entry
// whose OWN item is already trusted/persisted (entry.stored) — a fresh
// item can never reach it regardless of which discount_id it names.
async function loadTrustedGroupConflictMeta({
  items,
  rowById,
  trustedStoredSources,
  persistedClientIds = new Set(),
  database = db,
}) {
  const isFrozenByPosition = (item) => !!(item?.client_id && persistedClientIds.has(item.client_id));
  const isTrusted = (item) => isStoredDiscountLineItem(item, trustedStoredSources) || isFrozenByPosition(item);
  const missingIds = [...new Set(
    (items || [])
      .filter((item) => Number(item.amount) < 0 && item.discount_id
        && isTrusted(item) && !rowById.has(String(item.discount_id)))
      .map((item) => String(item.discount_id)),
  )];
  if (!missingIds.length) return new Map();
  const metaRows = await loadDiscountStackMetaRows(missingIds, database);
  return new Map(metaRows.map((row) => [String(row.id), row]));
}

// --- GATE_DISCOUNT_STACKING document-wide compounding (slice 5 of #4405) ---
//
// Below is reached ONLY when discountStackingLive() — create()'s own branch
// (further down) is the only caller. Gate off keeps the pre-lane math above
// (resolveLineItemDiscount, and each manual pick independently against the
// untouched subtotal) completely untouched, in its own branch.
//
// The frozen dollars a stored (already-resolved) discount item carries —
// same reading resolveStoredDiscountLineItem already uses, factored out so
// the document stack can build a `fixed_amount` term from it without
// duplicating the fallback-to-|amount| logic.
function storedDiscountDollars(item) {
  return Math.max(
    0,
    roundMoney(
      hasNumericValue(item.discount_dollars)
        ? item.discount_dollars
        : Math.abs(Number(item.amount) || 0),
    ),
  );
}

// The (type, amount, cap) a FRESH (non-stored) line-item discount row
// contributes to its parent line's stack: a catalog row carries its own
// amount; a variable/custom preset (custom_percent, custom_dollar, or the
// variable_* types) takes the operator-entered value the editor put on the
// item — same resolution resolveLineItemDiscount uses for the gate-off path,
// minus the dollar computation itself (the engine does that once the term
// reaches its line's remaining balance).
function lineItemDiscountTerm(row, item) {
  let amount = Number(row.amount) || 0;
  const isVariablePreset = isVariableOrCustomDiscountPreset(row);
  if (isVariablePreset && isPercentDiscountType(row.discount_type)) {
    amount = firstPositiveNumber(
      item.custom_discount_percentage,
      item.discount_percentage,
      row.amount,
    );
  } else if (isVariablePreset && isFixedDiscountType(row.discount_type)) {
    amount = firstPositiveNumber(
      item.custom_discount_amount,
      item.discount_amount,
      row.amount,
    );
  }
  return {
    discountType: row.discount_type,
    amount: roundMoney(amount),
    maxDiscountDollars: row.max_discount_dollars,
  };
}

// Classify one negative invoice line item for the document stack: does its
// discount_for name a specific service line (a fresh pick or a stored
// per-line stamp), or does it reach the WHOLE document (spansAll)? ANY
// unparented negative item spans the whole document — not only an
// appointment-level stamp flagged document_discount:true (Codex pre-push
// audit P0: a validated_checkout stamp, the builder's own "Scheduled price
// adjustment" reconciliation row, and an ordinary literal credit like
// "Referral Credit" all have discount_for:null too, and all were being
// subtracted OUTSIDE the stack — invisible to it, so a fresh percentage
// compounded against the untouched base instead of what the credit left:
// $100 with a $30 unparented credit plus a 10% line pick saved $60, not the
// specified $63). document_discount / the scope fields stay meaningful only
// for WHICH stored stamps carry a service-key/category scope to honor
// (buildDiscountLineItem is the only source of those two fields) — they no
// longer decide whether an item spans the document at all.
function classifyInvoiceDiscountItem(item, serviceLineByClientId) {
  if (item.discount_for) {
    return {
      parent: serviceLineByClientId.get(String(item.discount_for)) || null,
      spansAll: false,
    };
  }
  return { parent: null, spansAll: true };
}

// The document-wide interleave (owner ruling 2026-09-11): a fixed invoice-
// level credit lands BEFORE line percentages compound, not after — a $30
// invoice credit plus a 10% line discount on $100 must print $63, not the
// $60 applying the credit after the line percentage would give. The
// stacking ORDER is stackDocumentDiscounts (discount-stack.js) — the same
// four-step mechanism stackVisitDiscounts runs, so this file doesn't grow a
// second copy of it. What stays here is invoice-specific: grouping negative
// line items by their parent line, narrowing a scoped stamp's document term
// to the lines it actually reaches (or leaving it unscoped when this
// invoice carries no service-key snapshots at all — a pre-lane invoice, see
// invoiceCarriesServiceScope below), and turning a stored stamp / a plain
// literal credit / a catalog row into the generic {discountType, amount,
// maxDiscountDollars} terms that module understands.
//
// serviceLines: EVERY positive line (keyed or not) — a line with no discount
// of its own still occupies a pool slot and gets its pro-rata share of a
// document-wide fixed credit like every other line.
// lineEntries: classified negative items WITH a parent line — a fresh
// catalog pick OR a stored per-line stamp.
// manualDiscountRows: the admin's discountIds picks — reach every line.
// documentDiscountEntries: classified negative items with NO parent
// (spansAll) — EVERY unparented credit, not only a stored one: a stored
// stamp (scheduled_service / validated_checkout / the builder's own
// "Scheduled price adjustment" reconciliation row) contributes its frozen
// face value, and a plain literal credit (no discount_id, e.g. "Referral
// Credit") contributes its own |amount| — an unparented item with a
// discount_id that is NEITHER stored NOR resolvable is not a valid entry
// here (the caller's own "Invalid line-item discount" check catches it by
// omission — see computeStackedDocumentDiscountLines). Every one of these
// reduces the base OTHER document terms compound against exactly like a
// fresh manual pick does (Codex pre-push audit P0: excluding them let a
// fresh percentage compound against the untouched base instead of what the
// credit already took — a $30 unparented credit plus a 10% line pick on
// $100 saved $60, not the specified $63).
// Returns { lineItemMap: Map(item -> {amount, dollars}) for EVERY line
// entry, stored or fresh (Codex pre-push audit P0: a stored line credit
// used to reply with its own frozen face value even when a competing
// document credit's canonical-order allocation had already clamped its
// line's remaining balance below that — $50/$100 lines, a frozen $50 credit
// on line one plus an $80 document credit resolves $103.33 in the engine
// but recorded $130, silently driving that line's net negative), the
// manualDiscounts: [{row, dollars}] the caller already had, and
// documentDollarsByItem: Map(item -> dollars) for EVERY document entry
// (stored or plain), honoring scope — a scoped stamp whose target line was
// removed resolves an empty pool here and so gets 0 (the lane rule: keys
// present but unmatched ⇒ orphaned ⇒ $0 credit, never a silent overcharge
// replay of a frozen amount the invoice no longer earns). }
function stackInvoiceDocumentDiscounts(serviceLines, lineEntries, manualDiscountRows, documentDiscountEntries) {
  const entriesByParent = new Map();
  for (const entry of lineEntries) {
    const key = String(entry.parent.client_id);
    if (!entriesByParent.has(key)) entriesByParent.set(key, []);
    entriesByParent.get(key).push(entry);
  }
  const groups = serviceLines.map((line) => {
    const group = entriesByParent.get(String(line.client_id)) || [];
    // Frozen stamps first, so a fresh pick on the same line compounds on
    // what the stamp already left instead of the line's full gross.
    const ordered = [
      ...group.filter((entry) => entry.stored),
      ...group.filter((entry) => !entry.stored),
    ];
    const terms = ordered.map(({ row, item, stored }) => (stored
      ? { discountType: "fixed_amount", amount: storedDiscountDollars(item) }
      : lineItemDiscountTerm(row, item)));
    return { ordered, terms, parentAmount: Math.max(0, Number(line.amount) || 0) };
  });

  // Can this invoice express a service-key scope at all? Only lines built by
  // buildScheduledServiceInvoiceLines carry service_key. An invoice with no
  // snapshot anywhere (hand-built, or minted before this lane) never scopes
  // a stamp — the lane rule's "no keys anywhere ⇒ unscoped" half.
  const invoiceCarriesServiceScope = serviceLines.some(
    (line) => line && line.service_key != null && String(line.service_key) !== "",
  );
  // Codex pre-push audit P1 (round 1 on PR #4655): when a stamp carries
  // BOTH a key and a category filter, a line must satisfy EVERY configured
  // predicate — the same AND admin-schedule.js's own booking calculation
  // requires (admin-schedule.js:2088-2092) — not just one. The old `||`
  // let a line match on category alone even when the stamp also named a
  // specific key, so a line sharing only the CATEGORY of a removed keyed
  // service could still absorb the frozen credit instead of the stamp
  // correctly resolving orphaned ($0). A filter that is absent (null)
  // never constrains — only a filter the stamp actually set has to match.
  const scopeEligibleLines = (scopeKey, scopeCategory) => {
    if (!invoiceCarriesServiceScope || (!scopeKey && !scopeCategory)) return null;
    const matchesKey = (line) => !scopeKey || String(line.service_key || "") === String(scopeKey);
    const matchesCategory = (line) => !scopeCategory || String(line.service_category || "") === String(scopeCategory);
    return serviceLines
      .map((line, i) => (matchesKey(line) && matchesCategory(line) ? i : -1))
      .filter((i) => i >= 0);
  };
  // A plain literal credit (no discount_id) has no scope concept of its own
  // — only a stored stamp's document_scope_service_key/_category, set
  // exclusively by buildDiscountLineItem's appointment-level branch, can
  // narrow a document term.
  //
  // Scope extension (2026-09): a FRESH, catalog-backed document-wide pick
  // (entry.row resolved, not yet stored/persisted) must preserve its OWN
  // type — a document PERCENTAGE term occupies a DIFFERENT canonical-order
  // bucket than a fixed credit (percentages compound LAST; fixed credits
  // compound FIRST, discount-stack.js's stackOrder), so forcing it to
  // fixed_amount here would silently save a different total than the one
  // just previewed whenever the invoice carries any other term ($100 line
  // at 10% line + 10% invoice previews $81 either way ONLY if the
  // invoice term stays a genuine percentage; forced-fixed saves $81.90).
  // lineItemDiscountTerm already resolves a variable/custom preset's
  // operator-entered rate the same way a per-line pick does — id carried
  // through (same reason a manual pick's id rides its term below) so two
  // distinct same-rate/same-cap document terms don't fall through to
  // array-order tie-breaking.
  const documentEntryTerms = documentDiscountEntries.map((entry) => {
    const eligibleLines = entry.stored
      ? scopeEligibleLines(entry.item.document_scope_service_key, entry.item.document_scope_service_category)
      : null;
    if (entry.stored) {
      return {
        discountType: "fixed_amount",
        amount: storedDiscountDollars(entry.item),
        ...(eligibleLines ? { eligibleLines } : {}),
      };
    }
    if (entry.row) {
      return { ...lineItemDiscountTerm(entry.row, entry.item), id: entry.row.id };
    }
    return {
      discountType: "fixed_amount",
      amount: Math.abs(Number(entry.item.amount) || 0),
    };
  });
  // Codex pre-push audit P2 (round 1 on PR #4655): carry each manual pick's
  // stable id into its term — stackOrder's canonical key falls back to a
  // term's `id` (identified before anonymous) ONLY when two terms tie on
  // slot/kind/value/cap/scope; omitting it here meant two DISTINCT same-
  // rate/same-cap manual discounts fell through to raw array/query order
  // instead, so which one got credited with the larger, earlier-compounded
  // share could swap between the preview and the save (a different DB
  // return order) even though the invoice TOTAL stayed the same —
  // recordInvoiceDiscounts then rolled the wrong per-discount dollar figure
  // into discounts.total_discount_given for each id.
  const documentManualTerms = manualDiscountRows.map((d) => ({
    id: d.id,
    discountType: d.discount_type,
    amount: Number(d.amount) || 0,
    maxDiscountDollars: d.max_discount_dollars,
  }));

  const stacked = stackDocumentDiscounts({
    lines: groups.map((group) => ({ gross: group.parentAmount, terms: group.terms })),
    documentTerms: [...documentEntryTerms, ...documentManualTerms],
  });

  const lineItemMap = new Map();
  groups.forEach((group, groupIdx) => {
    const termDollars = stacked.lines[groupIdx].termDollars;
    group.ordered.forEach(({ item }, i) => {
      const term = group.terms[i];
      lineItemMap.set(item, {
        amount: term.discountType === "free_service" ? group.parentAmount : term.amount,
        dollars: termDollars[i],
      });
    });
  });
  const manualDiscounts = manualDiscountRows.map((d, i) => ({
    row: d,
    dollars: stacked.documentTerms[documentEntryTerms.length + i].dollars,
  }));
  const documentDollarsByItem = new Map(
    documentDiscountEntries.map((entry, i) => [entry.item, stacked.documentTerms[i].dollars]),
  );
  return { lineItemMap, manualDiscounts, documentDollarsByItem };
}

// Codex pre-push audit P0 (round 3 on PR #4655, "the gate-transition
// class"): a NON-stackable-group conflict must only be enforced against
// discount rows that are actually NEW in this submission. An invoice saved
// (gate off, or under an earlier catalog configuration) with two
// conflicting tier rows already on it must stay editable for everything
// ELSE — a price or description change must not start throwing 400 until
// an operator manually deletes a historical discount. Only a conflict that
// involves at least one row NOT already on the invoice is rejected.
// Mirrors stackGroupConflict's own clash predicate (discount-stack.js) —
// duplicated locally rather than widening that shared module's signature,
// which admin-schedule.js also calls and must not have its behavior
// changed by an invoice-only concern.
function assertNewStackGroupConflicts(rows) {
  const byGroup = new Map();
  for (const row of rows) {
    if (!row || !row.stack_group || row.is_stackable === true) continue;
    const group = String(row.stack_group);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(row);
  }
  for (const [group, groupRows] of byGroup) {
    if (!groupRows.some((row) => row._isNew)) continue;
    const seen = [];
    for (const row of groupRows) {
      const clash = seen.find((first) => (
        String(first.id || first.name) !== String(row.id || row.name)
        || first.spansAll === true
        || row.spansAll === true
        || String(first.scope ?? "") === String(row.scope ?? "")
      ));
      if (clash && (row._isNew || clash._isNew)) {
        const label = group === "tier" ? "WaveGuard tier discount" : `${group} discount`;
        const err = new Error(`Only one ${label} can apply: ${(clash.name || "discount")} and ${(row.name || "discount")} cannot be combined`);
        // Claude-fallback pre-push audit P1 (round 5 on PR #4655, post-push):
        // a bare `err.status = 400` is invisible to server/middleware/errors.js'
        // errorHandler, which branches on `err.isOperational` (using
        // `err.statusCode`, not `err.status`) before falling through to a
        // generic 500 — the SAME shape the gate-divergence error a few
        // hundred lines below already uses, specifically so the admin
        // routes' own isOperational/statusCode checks (and the global
        // handler, for any caller that has neither) surface this everyday
        // business-rule rejection as a clean 400, never an opaque 500.
        err.statusCode = 400;
        err.status = 400;
        err.isOperational = true;
        err.code = "DISCOUNT_STACK_GROUP_CONFLICT";
        throw err;
      }
      seen.push(row);
    }
  }
}

// Shared by create() and calculateUpdateFinancials (Codex pre-push audit
// P0: an earlier version of this delegation lived ONLY in create(), so an
// unchanged edit resubmit of a $111/10%+5% invoice recomputed the additive
// $16.65 over the compounded $16.10 the create just saved — an invoice's
// total could change on a no-op save). ONE implementation, called from
// both write paths, so they can no longer independently drift the way that
// finding — and the ORIGINAL rule-15 finding this whole slice exists to fix
// (discount-engine.js's preview vs. this file's additive save) — both did.
//
// items: normalized line items (both callers already have this shape).
// serviceLineByClientId: Map(client_id -> positive line item), both callers
// already build this for their own parent lookups.
// lineItemDiscountRowById: Map(discount_id -> catalog row), both callers
// already load this via loadInvoiceDiscountRows.
// manualDiscountRows: create()'s discountIds picks; calculateUpdateFinancials
// has none (edits carry no invoice-level discountIds) — pass [].
// trustedStoredSources: the Set isStoredDiscountLineItem checks against.
// persistedClientIds (Codex pre-push audit P0, round 3, "the gate-transition
// class"): the client_ids already on the invoice BEFORE this write —
// create() always passes the default empty set (nothing persisted yet, so
// every row is new — unchanged behavior). calculateUpdateFinancials passes
// the PRE-edit invoice's own line_items' client_ids: a row that was already
// on the invoice is FROZEN — its own submitted dollars are trusted exactly
// like a stored stamp, regardless of which regime (additive or compounded)
// priced it originally or which regime is live now — so a gate flip between
// create-time and a LATER, unrelated edit (description, due date, a
// different line's price) can never silently reprice an untouched discount
// row. Only a row whose client_id is genuinely NEW in this submission gets
// computed fresh, under whichever regime is live now. Same set also decides
// which rows count as "new" for assertNewStackGroupConflicts above.
// Returns { manualDiscounts, lineItemDiscounts } in the exact shape both
// callers already consume downstream (labels, discount_amount, the
// invoice_discounts audit rows) — mutates each negative item's quantity/
// unit_price/amount to its resolved dollars, same contract both callers
// relied on before this extraction.
function computeStackedDocumentDiscountLines({
  items,
  serviceLineByClientId,
  lineItemDiscountRowById,
  manualDiscountRows,
  trustedStoredSources,
  persistedClientIds = new Set(),
  // Codex pre-push audit P2 x2 (round 5 on PR #4655): retired-catalog
  // metadata for trusted/persisted discount_ids, loaded separately by
  // loadTrustedGroupConflictMeta — read ONLY below, as a fallback for an
  // entry whose OWN item is already trusted (entry.stored), never merged
  // into lineItemDiscountRowById itself. A fresh item sharing that same
  // discount_id must never resolve a row from here.
  groupConflictMetaById = new Map(),
}) {
  const positiveServiceLines = items.filter((item) => Number(item.amount) > 0);
  const negativeItems = items.filter(
    (item) => Number(item.amount) < 0 && item.category !== "deposit_credit",
  );
  const isFrozenByPosition = (item) => !!(item?.client_id && persistedClientIds.has(item.client_id));
  const isTrusted = (item) => isStoredDiscountLineItem(item, trustedStoredSources) || isFrozenByPosition(item);
  const classifiedNegativeItems = negativeItems.map((item) => {
    const { parent, spansAll } = classifyInvoiceDiscountItem(item, serviceLineByClientId);
    return {
      item,
      stored: isTrusted(item),
      row: item.discount_id
        ? lineItemDiscountRowById.get(String(item.discount_id))
        : null,
      parent,
      spansAll,
    };
  });
  // Codex pre-push audit P1 (round 2 on PR #4655): the same non-stackable
  // stack_group enforcement DiscountEngine.calculateDiscounts applies to
  // its own eligible list must also run here — without it, the invoice
  // editor could place WaveGuard Silver on one line and Gold on another
  // and this stack would compound both, even though both belong to the
  // non-stackable 'tier' group. Every catalog-identified row (stored or
  // fresh — a row-less item has nothing to check) is decorated with its
  // scope: a document-wide item (spansAll, from either an unparented
  // credit or a manual discountIds pick) always conflicts with anything
  // else in its group; a line-scoped item's scope is its own parent's
  // client_id, so the SAME catalog row reaching two different lines is
  // still fine (the same-row-different-lane carve-out) while two
  // DIFFERENT same-group rows across lines are not. assertNewStackGroupConflicts
  // (round 3) only enforces a clash that involves a row NOT already
  // persisted on the invoice — see its own comment above.
  // Codex pre-push audit P0 (round 4 on PR #4655): "new" for this check
  // must mean "the admin just picked this in this request," not merely
  // "not positionally persisted on a prior save." create() (mint,
  // create-and-send, completion) always passes an empty persistedClientIds
  // (nothing IS persisted yet — the invoice doesn't exist), so
  // isFrozenByPosition alone marked every booking-time scheduled_service/
  // validated_checkout stamp as new — a visit legitimately booked before
  // the gate existed, with conflicting non-stackable tier stamps on
  // separate lines, threw at completion mint even though neither discount
  // was newly added to the request. entry.stored already IS isTrusted(item)
  // (source-trusted OR positionally-frozen) — a trusted stamp was
  // committed at booking time, never "new," in EVERY create path, not just
  // edits.
  assertNewStackGroupConflicts([
    ...classifiedNegativeItems
      .map((entry) => ({
        ...entry,
        // Codex pre-push audit P2 x2 (round 5): the retired-metadata
        // fallback is gated on entry.stored — a FRESH item can never
        // pull a group-check row from groupConflictMetaById, regardless
        // of whether some OTHER trusted item shares its discount_id.
        groupRow: entry.row || (entry.stored && entry.item.discount_id
          ? groupConflictMetaById.get(String(entry.item.discount_id))
          : null),
      }))
      .filter((entry) => entry.groupRow)
      .map((entry) => ({
        ...entry.groupRow,
        _isNew: !entry.stored,
        ...(entry.spansAll
          ? { spansAll: true }
          : { scope: entry.parent ? String(entry.parent.client_id) : undefined }),
      })),
    ...manualDiscountRows.map((row) => ({ ...row, spansAll: true, _isNew: true })),
  ]);
  // A stamp needs only its parent (or spansAll); a fresh pick needs its
  // catalog row too — same validity rule as the "Invalid line-item
  // discount" throw below.
  const lineEntries = classifiedNegativeItems.filter(
    (entry) => entry.parent && (entry.stored || entry.row),
  );
  // Every unparented credit joins the document stack — stored, a FRESH
  // catalog-backed pick that resolves to a real row (scope extension,
  // 2026-09: a document-wide discountIds-style pick made through a line
  // item instead of the top-level discountIds array — see
  // stackInvoiceDocumentDiscounts' own documentEntryTerms for how its
  // type is preserved, never forced to fixed_amount), OR a plain literal
  // with no discount_id at all. An unparented item with a discount_id
  // that resolves to NEITHER a stored stamp NOR a live catalog row is
  // deliberately excluded (falls through to the throw below, unchanged
  // from the pre-lane validation) — the client can never fabricate a
  // discount by posting an id that names nothing.
  const documentEntries = classifiedNegativeItems.filter(
    (entry) => entry.spansAll && (entry.stored || entry.row || !entry.item.discount_id),
  );
  const stacked = stackInvoiceDocumentDiscounts(
    positiveServiceLines,
    lineEntries,
    manualDiscountRows,
    documentEntries,
  );
  const lineItemDiscounts = negativeItems.map((item) => {
    // Codex pre-push audit P1 (round 6 on PR #4655): stamp every discount
    // line THIS engine (gate-ON only — computeStackedDocumentDiscountLines
    // is never reached when the gate is off) resolves, so a LATER edit
    // under a rolled-back gate can tell "this row was priced under
    // compounding, its own dollars are a commitment" from "this row
    // predates the lane entirely, nothing has ever recomputed it under
    // compounding" — calculateUpdateFinancials's gate-OFF branch freezes
    // ONLY a row carrying this marker (see its own comment), so a
    // pre-lane row still recomputes exactly as main always did.
    item.stacking_regime = "compound";
    const row = item.discount_id
      ? lineItemDiscountRowById.get(String(item.discount_id))
      : null;
    const lineResolved = stacked.lineItemMap.get(item);
    const documentDollars = stacked.documentDollarsByItem.get(item);
    // Codex pre-push audit P1 (round 4 on PR #4655): a LINE-scoped item
    // (discount_for set) whose target line is gone gets parent:null from
    // classifyInvoiceDiscountItem, so it joins neither lineEntries (needs
    // a parent) nor documentEntries (spansAll is only ever true for an
    // UNPARENTED item) — it never reaches the engine at all, and both
    // lineResolved and documentDollars stay undefined. resolveStoredDiscountLineItem's
    // own override check (`overrideDollars != null`) treats undefined the
    // same as "no override," so a TRUSTED item here fell through to its
    // raw frozen face value — replaying the exact "silent overcharge of an
    // orphaned stamp" this slice already forbids for document-wide
    // credits (scopeEligibleLines), just not for this per-line case. An
    // orphaned line-scoped item resolves to $0 explicitly, the same
    // orphaned ⇒ $0 rule, instead of falling through to "no override."
    const isOrphanedLineScopedItem = !!item.discount_for
      && !serviceLineByClientId.has(String(item.discount_for));
    const resolvedDollars = isOrphanedLineScopedItem
      ? 0
      : (lineResolved ? lineResolved.dollars : documentDollars);

    if (isTrusted(item)) {
      return resolveStoredDiscountLineItem(item, row, resolvedDollars);
    }
    if (lineResolved) {
      const dollars = lineResolved.dollars;
      item.quantity = 1;
      item.unit_price = -dollars;
      item.amount = -dollars;
      return {
        id: row.id,
        row,
        name: row.name,
        discount_type: row.discount_type,
        amount: lineResolved.amount,
        dollars,
      };
    }
    if (documentDollars != null) {
      const dollars = documentDollars;
      item.quantity = 1;
      item.unit_price = -dollars;
      item.amount = -dollars;
      // Scope extension (2026-09): a FRESH document-wide pick with a
      // resolvable catalog row (documentEntryTerms above already sized it
      // under its OWN type, not a forced fixed_amount) keeps its catalog
      // attribution — the same {id, row, discount_type, amount} shape the
      // LINE-scoped branch above returns — so invoice_discounts.discount_id
      // is recorded and discounts.times_applied / total_discount_given
      // roll up correctly (DiscountEngine.recordInvoiceDiscounts reads
      // d.id). A plain literal credit (no row at all) keeps the pre-lane
      // anonymous shape unchanged.
      if (row) {
        return {
          id: row.id,
          row,
          name: row.name,
          discount_type: row.discount_type,
          amount: lineItemDiscountTerm(row, item).amount,
          dollars,
        };
      }
      return {
        id: null,
        row: null,
        name: item.description || "Line item discount",
        discount_type: "fixed_amount",
        amount: dollars,
        dollars,
      };
    }
    if (item.discount_id || item.discount_for) {
      throw new Error("Invalid line-item discount");
    }
    // Unreachable in practice — every unparented, id-less credit joins
    // documentEntries above — kept as a defensive literal fallback.
    const dollars = Math.round(Math.abs(Number(item.amount) || 0) * 100) / 100;
    return {
      id: null,
      row: null,
      name: item.description || "Line item discount",
      discount_type: "fixed_amount",
      amount: dollars,
      dollars,
    };
  });
  return { manualDiscounts: stacked.manualDiscounts, lineItemDiscounts };
}

function buildDiscountLineItem({
  parentClientId,
  discountId,
  discountName,
  discountType,
  discountAmount,
  discountDollars,
  // An appointment-level stamp (no parentClientId) reaches the WHOLE
  // invoice under the discount-stack engine (stackInvoiceDocumentDiscounts,
  // below) — document_discount marks it as such so create() can tell it
  // apart from a plain negative line with no discount_id/discount_for. A
  // stamp narrowed to one service at booking time
  // (scheduled_services.discount_service_key_filter /
  // _category_filter) carries that scope through so the invoice replay
  // narrows the document pool to just the lines it reaches instead of
  // spreading a scoped credit over every line (#4405 review finding
  // "Preserve category scope on appointment invoice stamps").
  documentScopeServiceKey = null,
  documentScopeServiceCategory = null,
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
    document_discount: !parentClientId,
    document_scope_service_key: !parentClientId ? (documentScopeServiceKey || null) : undefined,
    document_scope_service_category: !parentClientId ? (documentScopeServiceCategory || null) : undefined,
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
    // Mint-serialization (WaveGuard #3338 fast-follow): a mint that holds
    // FOR UPDATE on the visit row must build its lines on the SAME
    // connection, or the price read here would come from a different
    // connection's snapshot and the lock would be theater.
    database = null,
  } = {},
) {
  const conn = database || db;
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

  const scheduled = await conn("scheduled_services")
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

  const addons = await conn("scheduled_service_addons")
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
      // Identity the document stack matches a scoped appointment stamp
      // against (see buildDiscountLineItem's documentScopeServiceKey).
      // Absent on a hand-built invoice line, which is never scoped.
      service_key: scheduled.service_key_snapshot || null,
      service_category: scheduled.service_category_snapshot || null,
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
      service_key: addon.service_key_snapshot || null,
      service_category: addon.service_category_snapshot || null,
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
        documentScopeServiceKey: scheduled.discount_service_key_filter || null,
        documentScopeServiceCategory: scheduled.discount_service_category_filter || null,
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

// #4405 review finding "Trust checkout-stamped discounts during invoice
// edits" (carried into slice 5): a catalog discount minted by mobile
// checkout is persisted with stored_discount_source: 'validated_checkout'
// (server/routes/admin-schedule.js), which create() already trusts when the
// caller passes it via trustedStoredDiscountSources. calculateUpdateFinancials
// (an existing draft's line-item/tax-only edit) has no such caller-supplied
// list and used isStoredDiscountLineItem's bare default (trusts only
// 'scheduled_service'), so a checkout stamp — which also has no discount_for
// parent — fell through to the fresh-pick branch, found neither a catalog
// row nor a parent line, and threw "Invalid line-item discount", making the
// draft uneditable. Independent of GATE_DISCOUNT_STACKING: a stamp is either
// trusted or it isn't, regardless of whether stacking compounds.
const EDIT_TRUSTED_DISCOUNT_SOURCES = new Set(["scheduled_service", "validated_checkout"]);

async function calculateUpdateFinancials({
  lineItems,
  customer,
  invoice,
  taxRate,
  // Codex pre-push audit P1 (round 4 on PR #4655): the client's submit-time
  // freshness probe only confirms the gate value FOR THAT PROBE REQUEST —
  // nothing bound the arithmetic regime this write actually saves under to
  // what the client previewed. A gate flip (or a rolling deploy routing
  // the probe and this write to pods reading different values) between
  // the two requests let the probe pass while the server retotaled under
  // the OPPOSITE regime. undefined (no field sent) skips the check
  // entirely — every existing caller stays byte-identical.
  expectedDiscountStacking,
}) {
  if (
    expectedDiscountStacking !== undefined &&
    expectedDiscountStacking !== discountStackingLive()
  ) {
    const err = new Error(
      "Discount rules changed since this was previewed — reload the invoice and try again",
    );
    err.statusCode = 409;
    err.status = 409;
    err.isOperational = true;
    err.code = "DISCOUNT_STACKING_GATE_DIVERGED";
    throw err;
  }
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
  // Codex pre-push audit P0 (round 3 on PR #4655, "the gate-transition
  // class"): the client_ids already on the invoice BEFORE this edit — a
  // row this old is FROZEN regardless of which regime (additive or
  // compounded) priced it, or which regime is live NOW, so an unrelated
  // edit (title, due date, a different line's price) after a gate flip
  // can never silently reprice a discount the operator never touched.
  // Threaded into computeStackedDocumentDiscountLines below (gate on) and
  // the gate-off branch's own per-item resolution (both trust a
  // positionally-persisted row's own submitted dollars, same mechanism a
  // stored stamp already uses). Only a client_id genuinely NEW in this
  // submission is computed fresh, under whichever regime is live now.
  const persistedClientIds = new Set(
    parseInvoiceLineItems(invoice?.line_items)
      .map((item) => item?.client_id)
      .filter(Boolean),
  );
  const isFrozenByPosition = (item) => !!(item?.client_id && persistedClientIds.has(item.client_id));

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
          isStoredDiscountLineItem(item, EDIT_TRUSTED_DISCOUNT_SOURCES),
      )
      .map((item) => String(item.discount_id)),
  );
  const lineItemDiscountRowById = new Map(
    lineItemDiscountRows.map((row) => [String(row.id), row]),
  );
  // Codex pre-push audit P1 (round 4 on PR #4655): a persisted discount
  // retired/hidden since it was applied must still count in its
  // non-stackable group — separate, SCOPED metadata (never merged into
  // lineItemDiscountRowById itself — round 5 P2 x2: a shared merged map
  // let a FRESH item sharing that same retired id apply it too).
  const groupConflictMetaById = discountStackingLive()
    ? await loadTrustedGroupConflictMeta({
      items,
      rowById: lineItemDiscountRowById,
      trustedStoredSources: EDIT_TRUSTED_DISCOUNT_SOURCES,
      persistedClientIds,
    })
    : new Map();
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
  // GATE_DISCOUNT_STACKING (slice 5 of #4405): the SAME compounding engine
  // create() uses (computeStackedDocumentDiscountLines, above) — not a
  // second, independently-drifting copy. Codex pre-push audit P0: an
  // earlier version of this fix lived ONLY in create(), so re-saving an
  // UNCHANGED $111/10%+5% invoice through this edit path recomputed the
  // additive $16.65 instead of the compounded $16.10 the create just
  // saved — a no-op save silently changed the invoice's total. Gate off
  // keeps the exact pre-lane per-item reduce in its own untouched branch.
  let lineItemDiscounts;
  if (discountStackingLive()) {
    ({ lineItemDiscounts } = computeStackedDocumentDiscountLines({
      items,
      serviceLineByClientId,
      lineItemDiscountRowById,
      manualDiscountRows: [], // the edit path carries no invoice-level discountIds
      trustedStoredSources: EDIT_TRUSTED_DISCOUNT_SOURCES,
      persistedClientIds,
      groupConflictMetaById,
    }));
  } else {
    lineItemDiscounts = items
      .filter(
        (item) => Number(item.amount) < 0 && item.category !== "deposit_credit",
      )
      .map((item) => {
        const row = item.discount_id
          ? lineItemDiscountRowById.get(String(item.discount_id))
          : null;
        // Codex pre-push audit P1 (round 6 on PR #4655): freeze-by-position
        // here is gated on item.stacking_regime === "compound" — the
        // marker computeStackedDocumentDiscountLines stamps on every row
        // IT resolves (gate ON only). A pre-lane row, or any row never
        // once saved while the gate was live, carries no marker and falls
        // through to the SAME live recompute (resolveLineItemDiscount
        // below) main has always done — gate OFF stays byte-identical to
        // main for every row main could ever have produced. A row this
        // lane itself priced under compounding is a genuinely NEW kind of
        // data main never wrote (main has no stacking_regime field at
        // all) — once stamped, it stays pinned to its own compounded
        // dollars even if the gate is later rolled back, never silently
        // reverted to additive math out from under an already-quoted
        // total — the same "a committed figure doesn't drift under an
        // unrelated edit" principle a scheduled_service stamp already
        // gets, just for a row this lane's own engine (not a booking
        // flow) committed.
        if (
          isStoredDiscountLineItem(item, EDIT_TRUSTED_DISCOUNT_SOURCES)
          || (isFrozenByPosition(item) && item.stacking_regime === "compound")
        ) {
          return resolveStoredDiscountLineItem(item, row);
        }
        const parent = item.discount_for
          ? serviceLineByClientId.get(String(item.discount_for))
          : null;
        if (!row || !parent) {
          if (item.discount_id || item.discount_for)
            throw new Error("Invalid line-item discount");
          const dollars = Math.round(Math.abs(Number(item.amount) || 0) * 100) / 100;
          return {
            id: null,
            row: null,
            name: item.description || "Line item discount",
            discount_type: "fixed_amount",
            amount: dollars,
            dollars,
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
  }
  const lineItemDiscountAmount = lineItemDiscounts.reduce(
    (sum, item) => sum + item.dollars,
    0,
  );

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
  // Mirror create()'s resolved-name labeling (codex 2652 r2: an admin edit
  // recomputed the label back to the generic literal, wiping the promised
  // "Referral Credit" from the pay page/PDF). Names come from each negative
  // line's catalog row or its own description; same varchar(100) bound.
  const editDiscountNames = [...new Set(
    items
      .filter((item) => Number(item.amount) < 0 && item.category !== "deposit_credit")
      .map((item) => {
        const row = item.discount_id
          ? lineItemDiscountRowById.get(String(item.discount_id))
          : null;
        // Catalog rows keep their CANONICAL name (codex 2652 r3: the editor
        // sends verbose descriptions like "WaveGuard Silver (Pest Control)",
        // which would drift the label on a no-op save and eat the 100-char
        // cap); only plain negative lines label from their own description.
        return String((row && row.name) || item.description || "").trim();
      })
      .filter(Boolean),
  )];
  const labelParts = [
    ...(lineItemDiscountAmount > 0
      ? (editDiscountNames.length ? editDiscountNames : ["Line-item discounts"])
      : []),
  ].filter(Boolean);

  const editJoinedLabel = labelParts.join(" + ");
  return {
    line_items: JSON.stringify(items),
    subtotal,
    discount_amount: discountAmount,
    discount_label: labelParts.length
      ? (editJoinedLabel.length > 100 ? `${editJoinedLabel.slice(0, 97)}...` : editJoinedLabel)
      : null,
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
  formatCardLine,
} = require("./invoice-helpers");

function whereSendClaimOwned(query, claimToken) {
  return claimToken
    ? query.where({ send_claim_token: claimToken })
    : query.whereNull("send_claim_token");
}

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

// A first delivery that finds the row already delivered (round-6 P1
// #4131): the office create's immediate send is a FIRST delivery, never a
// resend — the completion (or another concurrent send) may have claimed and
// texted the invoice between the caller's own pre-check and this claim.
// Refused atomically instead of being treated as an intentional resend.
function invoiceAlreadyDeliveredError(invoice) {
  const e = new Error(`Invoice ${invoice?.invoice_number || invoice?.id || ""} was already delivered (status: ${invoice?.status || "unknown"}) — not sent again`);
  e.code = "already_delivered";
  return e;
}

// Pre-push audit P1 (PR #4633): two first-delivery claims racing the SAME
// atomic flip — the loser's re-read sees the row still 'sending' under the
// WINNER's claim token, neither delivered nor parked. That is a legitimate
// supersession, not a generic failure: the caller's own request was never
// attempted because a concurrent, equally-valid first delivery beat it to
// the claim. Reported distinctly so the UI never shows "failed to send" for
// a send that is, in fact, already in progress under someone else's claim.
function firstDeliveryInProgressError(invoice) {
  const e = new Error(`Invoice ${invoice?.invoice_number || invoice?.id || ""} is already being delivered by another request — not sent again`);
  e.code = "delivery_in_progress";
  return e;
}

// 'sending' is NOT delivered here — a live claim is reported as the
// in-progress conflict instead, and the caller re-reads the row afterwards.
// email_sent_at/sms_sent_at are each channel's own durable stamp, written
// the moment its provider ACCEPTS the message — before any bookkeeping that
// could throw and leave status looking claimable again (a failed finalize
// restoring 'draft', say). Checked here rather than relying solely on each
// caller's own pre-claim guard — this is the ONE chokepoint every
// firstDeliveryOnly claimant shares.
const DELIVERED_FOR_FIRST_SEND_STATUSES = ["sent", "viewed", "overdue", "paid", "prepaid"];
function alreadyDeliveredForFirstSend(invoice) {
  return !!invoice
    && (!!invoice.sent_at || !!invoice.sms_sent_at || !!invoice.email_sent_at
      || DELIVERED_FOR_FIRST_SEND_STATUSES.includes(invoice.status));
}

function sendClaimLostError() {
  return Object.assign(
    new Error("Invoice send claim changed; delivery not attempted"),
    { code: "send_claim_lost" },
  );
}

async function linkedScheduledServiceId(invoice, database = db) {
  if (invoice?.scheduled_service_id) return invoice.scheduled_service_id;
  if (!invoice?.service_record_id) return null;
  const record = await database("service_records")
    .where({ id: invoice.service_record_id })
    .first("scheduled_service_id");
  return record?.scheduled_service_id || null;
}

// A text that carries THIS invoice's pay link and is queued for the send
// window still owns the delivery after its sender released the 'sending'
// claim (#4131): the replay body is frozen and its executor has no delivery
// recheck, so a claim taken meanwhile would text the pay link twice. The
// queued row is the owner until it delivers (markDeliverySent finalizes) or
// terminally fails (the row leaves scheduled/sending). A row the worker has
// already settled as 'sent' but not yet finalized (finalize_pending stamped
// atomically with the settlement; markDeliverySent runs AFTER it) is still
// an owner: a claim taken in that gap — or after a crash before the
// finalizer ran — would find the invoice still draft and text the same pay
// link again. Three queues: the completion text (dispatch_completion_deferred),
// the held decline notice (autopay_completion_decline_deferred) and the
// invoice send's own held SMS leg (invoice_send_deferred — queued while the
// email leg may still fail and restore the row to draft). The invoice-send
// path passes adoptsQueuedInvoiceSend: a RETRY of that send adopts its
// queued row by design (never re-queues) — adoption CONSUMES a still-
// scheduled row (consumeQueuedInvoiceSend, under the claim) so the live send
// owns the only delivery; a row the worker has already claimed ('sending',
// or sent awaiting finalization) refuses the adopter like any other queue.
// Every other claimant is refused by any live row with code queued_pay_link.
const PAY_LINK_QUEUE_ENTRY_POINTS = ["dispatch_completion_deferred", "autopay_completion_decline_deferred", "invoice_send_deferred"];
const INVOICE_SEND_DEFERRED_ENTRY_POINT = "invoice_send_deferred";
const QUEUE_ADOPTION_PENDING_KEY = "invoice_send_adoption_pending";
// Durable delivery fence: stamped with the adopting claim token right before
// the provider handoff. From then on the text may have gone out, so only
// the SAME episode (which knows its provider outcome) may ever restore the
// row; a later resend can re-adopt and resolve it, never re-schedule it.
const QUEUE_ADOPTION_HANDOFF_KEY = "invoice_send_adoption_handoff_token";
const QUEUE_ADOPTION_HANDOFF_AT_KEY = "invoice_send_adoption_handoff_at";
// Live = queued, mid-send, or delivered-but-unfinalized.
const LIVE_PAY_LINK_QUEUE_ROW_SQL = "(status IN ('scheduled', 'sending') OR (status = 'sent' AND metadata->>'finalize_pending' = 'true'))";
// The adopter's view: the same, except a still-scheduled invoice_send_deferred
// row is its own (about to be consumed), not a blocker. A scheduled row the
// stale-finalization sweep re-queued with finalize_only (scheduler.js) is
// NOT unsent work: its text already reached the provider and only the
// bookkeeping is owed, so it blocks like a delivered row.
const FINALIZE_ONLY_ROW_SQL = "COALESCE(metadata->>'finalize_only', 'false') = 'true'";
const ADOPTABLE_PAY_LINK_QUEUE_ROW_SQL = `(status = 'sending' OR (status = 'sent' AND metadata->>'finalize_pending' = 'true') OR (status = 'scheduled' AND (metadata->>'entry_point' <> ? OR ${FINALIZE_ONLY_ROW_SQL})))`;
async function queuedPayLinkText(invoiceId, { adoptsQueuedInvoiceSend = false, database = db } = {}) {
  const query = database("sms_log")
    .whereRaw("metadata->>'invoice_id' = ?", [String(invoiceId)])
    .whereRaw("metadata->>'entry_point' = ANY(?)", [PAY_LINK_QUEUE_ENTRY_POINTS]);
  if (adoptsQueuedInvoiceSend) query.whereRaw(ADOPTABLE_PAY_LINK_QUEUE_ROW_SQL, [INVOICE_SEND_DEFERRED_ENTRY_POINT]);
  else query.whereRaw(LIVE_PAY_LINK_QUEUE_ROW_SQL);
  return query.first("id", "scheduled_for");
}

// The adopting send consumes its own still-scheduled held SMS leg: the row
// is cancelled (terminal for the executor and the stranded-finalization
// sweep) with the reason stamped, and the live send that holds the invoice
// claim now owns the delivery. Only rows still 'scheduled' are consumable —
// one the worker has flipped to 'sending' stays its own, and the strict
// re-check after this refuses. Returns the consumed rows (id + their
// original scheduled_for): this cancellation runs BEFORE the replacement
// delivery is even attempted, so if that delivery then fails, the caller
// needs these ids back to UNDO the cancellation (restoreConsumedQueuedSend).
async function consumeQueuedInvoiceSend(invoiceId, database = db) {
  const rows = await database("sms_log")
    .whereRaw("metadata->>'entry_point' = ?", [INVOICE_SEND_DEFERRED_ENTRY_POINT])
    .whereRaw("metadata->>'invoice_id' = ?", [String(invoiceId)])
    // A prior attempt can have crashed after cancelling this row but before
    // restoring it. The marker is written by the original consume itself,
    // so a later authorized retry can adopt the unresolved row again without
    // mistaking historical, successfully superseded cancellations for work.
    .whereRaw(`(status = 'scheduled' OR (status = 'cancelled' AND metadata->>'${QUEUE_ADOPTION_PENDING_KEY}' = 'true'))`)
    // Never consume a delivered row awaiting finalization only.
    .whereRaw(`NOT (${FINALIZE_ONLY_ROW_SQL})`)
    .update({
      status: "cancelled",
      updated_at: new Date(),
      metadata: database.raw(`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancelled_reason', 'superseded_by_live_send', 'cancelled_at', ?::text, '${QUEUE_ADOPTION_PENDING_KEY}', true)`, [new Date().toISOString()]),
    })
    .returning(["id", "scheduled_for"]);
  return Array.isArray(rows) ? rows : [];
}

// Undoes consumeQueuedInvoiceSend's cancellation when the replacement
// delivery it was consumed FOR ultimately fails and nothing else picked up
// the obligation — same row (matched by id), same scheduled_for (never
// touched by the cancel), guarded to only restore a row still exactly in
// the state this call itself put it in (never a row something else has
// since claimed or that a fresh replacement already supersedes).
async function restoreConsumedQueuedSend(consumedRows, database = db, claimToken = null) {
  if (!consumedRows?.length) return;
  const allIds = consumedRows.map((row) => row.id).filter(Boolean);
  if (!allIds.length) return;
  try {
    // Only rows never handed to a provider, or handed over by THIS episode
    // (which knows its outcome was a definite non-delivery), go back on the
    // schedule. A row an EARLIER episode fenced may already have delivered:
    // it stays cancelled and pending — re-adoptable, resolvable, never
    // re-scheduled.
    const restoredRows = await database("sms_log")
      .whereIn("id", allIds)
      .where({ status: "cancelled" })
      .whereRaw("metadata->>'cancelled_reason' = 'superseded_by_live_send'")
      .whereRaw(`metadata->>'${QUEUE_ADOPTION_PENDING_KEY}' = 'true'`)
      .whereRaw(`(metadata->>'${QUEUE_ADOPTION_HANDOFF_KEY}' IS NULL OR metadata->>'${QUEUE_ADOPTION_HANDOFF_KEY}' = ?)`, [String(claimToken || "")])
      .update({
        status: "scheduled",
        updated_at: new Date(),
        metadata: database.raw(`((((metadata - 'cancelled_reason') - 'cancelled_at') - '${QUEUE_ADOPTION_PENDING_KEY}') - '${QUEUE_ADOPTION_HANDOFF_KEY}') - '${QUEUE_ADOPTION_HANDOFF_AT_KEY}'`),
      })
      .returning(["id"]);
    const restoredIds = new Set((Array.isArray(restoredRows) ? restoredRows : []).map((row) => row.id));
    for (const id of allIds) {
      if (restoredIds.has(id)) continue;
      const row = await database("sms_log").where({ id }).first("id", "metadata");
      const meta = typeof row?.metadata === "string" ? JSON.parse(row.metadata) : (row?.metadata || {});
      const fence = meta[QUEUE_ADOPTION_HANDOFF_KEY];
      if (fence && fence !== String(claimToken)) {
        logger.warn(`[invoice] Adopted queued pay-link text ${id} left cancelled: an earlier send may have delivered it`);
        continue;
      }
      throw new Error(`row ${id} was not restored`);
    }
  } catch (err) {
    logger.error(`[invoice] queued pay-link SMS restore FAILED for ${allIds.join(", ")} — the customer's original scheduled send did not resume: ${err.message}`);
    // The pending marker was committed by consumeQueuedInvoiceSend before
    // the provider attempt. Propagate so restoreSendClaim cannot expose the
    // invoice as claimable; a later authorized retry re-adopts this exact
    // row through consumeQueuedInvoiceSend.
    const restoreErr = new Error(`Could not restore the queued pay-link SMS obligation for invoice send: ${err.message}`);
    restoreErr.code = "queued_sms_restore_failed";
    restoreErr.cause = err;
    throw restoreErr;
  }
}

// A provider-accepted SMS, replacement queued SMS, or full-credit outcome
// discharges the adopted row. Clear its pending marker durably so a later
// resend cannot mistake a historically superseded row for an owed SMS leg.
async function resolveConsumedQueuedSend(invoiceId, claimToken, consumedRows, database = db) {
  if (!consumedRows?.length) return true;
  const ids = consumedRows.map((row) => row.id).filter(Boolean);
  if (!ids.length) return true;
  try {
    return await database.transaction(async (trx) => {
      const owned = await trx("invoices").where({ id: invoiceId, send_claim_token: claimToken }).forUpdate().first("id");
      if (!owned) return false;
      // Deliberately matches already-resolved rows too: post-provider recovery
      // repeats this step when invoice finalization fails after the first
      // resolution committed, so the transition must be idempotent.
      const resolved = await trx("sms_log")
        .whereIn("id", ids)
        .where({ status: "cancelled" })
        .whereRaw("metadata->>'cancelled_reason' = 'superseded_by_live_send'")
        .update({
          updated_at: new Date(),
          metadata: trx.raw(`(((metadata - '${QUEUE_ADOPTION_PENDING_KEY}') - '${QUEUE_ADOPTION_HANDOFF_KEY}') - '${QUEUE_ADOPTION_HANDOFF_AT_KEY}') || jsonb_build_object('adoption_resolved_at', ?::text)`, [new Date().toISOString()]),
        });
      if (Number(resolved) !== ids.length) {
        throw new Error(`resolved ${Number(resolved) || 0} of ${ids.length} row(s)`);
      }
      return true;
    });
  } catch (err) {
    const resolutionErr = new Error(`Could not resolve adopted queued pay-link SMS rows: ${err.message}`);
    resolutionErr.code = "queued_sms_resolution_failed";
    resolutionErr.cause = err;
    throw resolutionErr;
  }
}

// After the provider accepted the text (or credit settled the invoice) the
// send is a success whatever happens to the queue bookkeeping: a failed
// resolution must never surface as a failed send, or the caller records a
// delivered SMS as not sent and can restore the adopted queued text on top
// of it. Returns an outcome to spread onto the result: {} when settled,
// { queueResolutionError } when the adopted rows stay pending.
async function resolveAdoptedRowsAfterDelivery(invoiceId, claimToken, consumedRows, invoiceNumber) {
  try {
    const resolved = await resolveConsumedQueuedSend(invoiceId, claimToken, consumedRows);
    if (resolved) return {};
    const message = "send claim no longer owned when resolving the adopted queued text";
    logger.error(`[invoice] Adopted queued text for ${invoiceNumber || invoiceId} stays pending after a delivered send — ${message}`);
    return { queueResolutionError: message };
  } catch (e) {
    logger.error(`[invoice] Adopted queued text for ${invoiceNumber || invoiceId} stays pending after a delivered send — resolution failed: ${e.message}`);
    return { queueResolutionError: e.message };
  }
}

// Runs right before the SMS provider handoff of a send that adopted queued
// rows. A throw here happens BEFORE the provider, so the caller treats it as
// a definite non-delivery and restores the rows. Rows already fenced by an
// earlier episode keep that fence.
async function fenceAdoptedRowsBeforeHandoff(consumedRows, claimToken, database = db) {
  const ids = (consumedRows || []).map((row) => row.id).filter(Boolean);
  if (!ids.length) return;
  await database("sms_log")
    .whereIn("id", ids)
    .where({ status: "cancelled" })
    .whereRaw(`metadata->>'${QUEUE_ADOPTION_PENDING_KEY}' = 'true'`)
    .whereRaw(`metadata->>'${QUEUE_ADOPTION_HANDOFF_KEY}' IS NULL`)
    .update({
      updated_at: new Date(),
      metadata: database.raw(`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('${QUEUE_ADOPTION_HANDOFF_KEY}', ?::text, '${QUEUE_ADOPTION_HANDOFF_AT_KEY}', ?::text)`, [String(claimToken), new Date().toISOString()]),
    });
}

function queuedPayLinkError(queued) {
  const e = new Error(`Invoice send already in progress — a text carrying this pay link is queued for the send window${queued.scheduled_for ? ` (${new Date(queued.scheduled_for).toISOString()})` : ""}; it delivers then`);
  e.code = "queued_pay_link";
  e.scheduledFor = queued.scheduled_for ? new Date(queued.scheduled_for) : null;
  return e;
}

// Queue-adoption / reconciliation UNDER the claim: the flip compares status
// only, so draft → sending → draft in between (another sender claimed,
// queued its held SMS leg, failed its email leg and restored the row) is
// invisible to it. Any LIVE queue row seen here was inserted before this
// claim and owns the delivery — give the claim back and refuse.
// adoptsQueuedInvoiceSend additionally consumes this send's OWN
// still-scheduled held leg (superseded by the live send), then re-checks
// strictly: a worker that claimed the row meanwhile keeps the delivery and
// the claim is given back. A lookup/consume that THROWS gives the claim
// back too — the caller never receives it.
async function reconcileQueuedSendUnderClaim(invoiceId, previousStatus, claimToken, adoptsQueuedInvoiceSend, database = db) {
  let queuedUnderClaim;
  try {
    queuedUnderClaim = await queuedPayLinkText(invoiceId, { adoptsQueuedInvoiceSend, database });
  } catch (lookupErr) {
    await restoreSendClaim(invoiceId, previousStatus, true, [], database, claimToken);
    throw lookupErr;
  }
  if (queuedUnderClaim) {
    await restoreSendClaim(invoiceId, previousStatus, true, [], database, claimToken);
    throw queuedPayLinkError(queuedUnderClaim);
  }
  if (!adoptsQueuedInvoiceSend) return [];
  let outcome;
  try {
    outcome = await database.transaction(async (trx) => {
      const owned = await trx("invoices")
        .where({ id: invoiceId, status: "sending", send_claim_token: claimToken })
        .forUpdate()
        .first("id");
      if (!owned) return { claimLost: true, consumedRows: [] };
      const consumedRows = await consumeQueuedInvoiceSend(invoiceId, trx);
      if (consumedRows.length) logger.info(`[invoice] Queued pay-link SMS for invoice ${invoiceId} consumed by a live send (${consumedRows.length} row${consumedRows.length === 1 ? "" : "s"} cancelled)`);
      const stillQueued = await queuedPayLinkText(invoiceId, { database: trx });
      if (!stillQueued) return { consumedRows };

      // The strict recheck found another live obligation. Restore both the
      // adopted rows and this ordinary claim while the token row stays
      // locked, so a replacement sender cannot enter between them.
      await restoreConsumedQueuedSend(consumedRows, trx, claimToken);
      if (previousStatus !== "sending") {
        await trx("invoices")
          .where({ id: invoiceId, status: "sending", send_claim_token: claimToken })
          .update({ status: previousStatus, send_claim_token: null, updated_at: new Date() });
      }
      return { consumedRows: [], error: queuedPayLinkError(stillQueued) };
    });
  } catch (adoptErr) {
    // The adoption transaction rolled back, so it has no consumed rows to
    // repair. Restore only this still-owned invoice claim before surfacing.
    await restoreSendClaim(invoiceId, previousStatus, true, [], database, claimToken);
    throw adoptErr;
  }
  if (outcome.claimLost) {
    const latest = await database("invoices").where({ id: invoiceId }).first();
    throw invoiceNotSendableError(latest);
  }
  if (outcome.error) throw outcome.error;
  return outcome.consumedRows;
}

// Shared by BOTH claimInvoiceForSend branches (fresh claim and the
// allowClaimed preclaim callback) so the two guards below can never drift
// apart between them (round-0 audit P1 #4131: the preclaim branch
// originally lost both checks entirely).
//
// Third audit P1 (#4131): the hold used to be inferred from
// operatorInitiated/firstDeliveryOnly instead of a caller stating its
// intent outright — a batch/automated caller that happened to carry
// operatorInitiated:true (or a firstDeliveryOnly row whose stamps looked
// like a resend) could silently clear a parked row it never asked to
// override. overridesReviewHold is now the ONE explicit switch: only a
// caller that says so may claim a parked row, independent of
// operatorInitiated (which keeps its own, unrelated meaning — the
// send-window bypass) and of firstDeliveryOnly.
// Mutual exclusivity of intent (fourth audit #4131): a request cannot be
// BOTH a first delivery and a deliberate operator override of the review
// hold — the two express opposite claims about the same row (never
// delivered vs. deliberately reclaiming a parked one). Shared by
// claimInvoiceForSend and claimPacketInvoiceForSend so both fail the same
// way, before either ever opens a transaction or touches the row.
function assertFirstDeliveryNotAnOverride(firstDeliveryOnly, overridesReviewHold, context) {
  if (firstDeliveryOnly && overridesReviewHold) {
    throw new Error(`${context}: a request cannot be both a first delivery and a deliberate Resend override of the review hold`);
  }
}

function refuseFirstDeliveryHold(current, invoiceId, firstDeliveryOnly, overridesReviewHold) {
  // Round-1 Codex P1 (PR #4633): checked BEFORE already-delivered. A row
  // can be BOTH parked (processScheduledSends recovered a stale 'sending'
  // claim, delivery unverified) AND carrying a delivery stamp from that
  // SAME unverified attempt (the provider may have accepted the message
  // before the crash) — already-delivered would read that as a normal,
  // benign no-op success and hide the fact that an operator still needs to
  // confirm delivery. The review hold is the stronger, more cautious
  // claim and must win: it always surfaces for review, never gets
  // silently resolved as "already sent, nothing to do".
  if (isStaleClaimReviewHold(current) && !overridesReviewHold) {
    throw staleClaimReviewHoldError(invoiceId);
  }
  if (firstDeliveryOnly && alreadyDeliveredForFirstSend(current)) {
    throw invoiceAlreadyDeliveredError(current);
  }
}

// Nothing due on an invoice linked to a scheduled visit (a credit, prepaid
// coverage, or a retotal took it to $0) while it still sits in a claimable
// status: the ONE zero-balance guard every sender AND the scheduled-send
// worker share (#4131 slice 4). Deliberately narrower than the originating
// design: a visit that never ran is already caught on main by the void
// sweep (CANCELLED_SERVICE_VOIDABLE_STATUSES includes 'sending') and the
// INVOICE_VISIT_TERMINAL check inside the provider dispatch — duplicating
// that here as a second, differently-coded refusal would race it instead of
// reinforcing it. The out-of-band-prepayment reconciler the originating
// design also covered here has not been ported to main (a later slice).
async function zeroDueVisitInvoice(row, database = db) {
  if (!row) return false;
  if (!SEND_CLAIMABLE_STATUSES.includes(row.status)) return false;
  if (row.total == null) return false;
  // Cheap checks first: only a genuinely zero-due row ever needs the
  // linkage lookup below. Codex round-1 P1 (#4131 slice 4): most
  // post-completion invoices carry only service_record_id, never
  // scheduled_service_id directly (migration 20260420000002) — reading
  // scheduled_service_id alone silently excluded them from this guard.
  // linkedScheduledServiceId is a no-op DB read when scheduled_service_id
  // is already set, so the common (non-zero-due) case never touches it.
  if (invoiceAmountDue(row) !== 0) return false;
  const scheduledServiceId = await linkedScheduledServiceId(row, database);
  return !!scheduledServiceId;
}

// Lightweight, side-effect-free zero-due DETECTION for a claim path to
// throw — carries no settlement of its own. Every claim-path detection
// point below (the fresh-claim pre-flip check, the post-claim re-check,
// the preclaimed under-claim re-check) throws exactly this and nothing
// more: settleZeroBalance is invoked from exactly ONE place —
// settleZeroDueBeforeSend, further down — never from inside a claim's own
// transaction (Codex round-5 #4131: four separate call sites each used to
// settle a zero-due invoice their own way; one settled INSIDE a packet
// claim's own transaction, whose later throw then rolled that very
// settlement back while still reporting success to the caller).
function zeroDueDetectedError(invoiceId) {
  const e = new Error(`Invoice ${invoiceId} appears zero-due — resolve via settleZeroDueBeforeSend before reporting an outcome`);
  e.code = "zero_due_detected";
  return e;
}

// True when a retotal to $0 landed between the pre-claim read and the
// flip (or between a preclaim and this re-check). claimedFromStatus
// reconstructs the row's status as of the read this claim is based on
// (the preclaimed branch's `current` already reads 'sending' — its own
// claim — so the caller passes 'scheduled' to recreate the check that
// would have run had the flip happened here instead).
async function zeroDueUnderClaim(claimedRow, claimedFromStatus, database = db) {
  return zeroDueVisitInvoice({ ...claimedRow, status: claimedFromStatus }, database);
}

// Restores the claim, THEN throws the lightweight detection error above —
// never settles here.
async function reverifyClaimedVisitInvoice(invoiceId, invoice, previousStatus, database = db) {
  if (!(await zeroDueUnderClaim(invoice, previousStatus, database))) return;
  await restoreSendClaim(invoiceId, previousStatus, true, [], database, invoice.send_claim_token);
  throw zeroDueDetectedError(invoiceId);
}

// Same re-check for a row claimInvoiceForSend's allowClaimed branch never
// owns (the caller — processScheduledSends — took this exact claim itself;
// see the comment on that branch). This whole `if (allowClaimed)` branch
// never touches the invoice row itself, so detection alone throws, marked
// deliveryNeverAttempted (verified pre-provider): the rare race where this
// throw reaches processScheduledSends' own catch with no chokepoint call
// in between is treated like an ordinary retryable send failure, never an
// unrecoverable crash.
async function refuseZeroDuePreclaimedInvoice(invoiceId, current, database) {
  if (!(await zeroDueUnderClaim(current, "scheduled", database))) return;
  const err = zeroDueDetectedError(invoiceId);
  err.deliveryNeverAttempted = true;
  throw err;
}

// Settle (prepaid, system:zero_balance) or report the RECOGNIZED business
// reason settleZeroBalance itself returned for not settling (in-flight
// reconciliation, existing payment work, and similar — every `skip(...)`
// reason that function's own code names). Deliberately does NOT catch: an
// unexpected throw (a bug, a DB error, an assertion failure inside
// settleZeroBalance) is not a recognized refusal and must propagate rather
// than being silently reinterpreted as "nothing due, try again later" —
// that swallowed a permanently unsettleable invoice into an infinite,
// silent retry loop (pre-push audit P1, #4131 slice 4).
async function settleZeroDueVisitInvoice(invoiceId, database = db, { requireDueBy = null } = {}) {
  const settlement = await InvoiceService.settleZeroBalance(invoiceId, database, { requireDueBy });
  if (settlement?.settled) {
    logger.info(`[invoice] ${invoiceId}: nothing due on the visit-linked invoice — settled instead of delivering a $0 pay link`);
    return settlement;
  }
  return { settled: false, reason: settlement?.reason || "refused", invoice: settlement?.invoice || null };
}

function depositSettlementPendingError(invoiceId, reason) {
  logger.warn(`[invoice] ${invoiceId}: nothing due on the visit-linked invoice but zero-balance settlement was refused (${reason}) — send refused`);
  const e = new Error(`Nothing is due on this invoice, but it could not be settled yet (${reason}) — not sent. Retry shortly; the visit's completion (or the next scheduled pass) settles it too.`);
  e.code = "deposit_settlement_pending";
  return e;
}

// Voids (+ restores credit) via the established sweep — every zero-due
// 'terminal' outcome below shares this ONE cleanup. Returns whether THIS
// invoice was actually voided: the sweep can safety-refuse (a live
// PaymentIntent, money in flight, an unverifiable Stripe lookup), in
// which case a caller with a retry rail (the worker) must not leave the
// row due with nothing spent.
async function voidTerminalZeroDueInvoice(invoiceId, scheduledServiceId) {
  const voided = scheduledServiceId
    ? await InvoiceService.voidOpenInvoicesForCancelledService(scheduledServiceId)
    : [];
  return voided.includes(invoiceId);
}

const ZERO_DUE_TERMINAL_ERROR = "Linked visit is terminal; delivery not attempted";

function zeroDueRefusalReasonText(outcome) {
  return outcome.kind === "terminal"
    ? ZERO_DUE_TERMINAL_ERROR
    : `Nothing is due on this invoice, but it could not be settled yet (${outcome.reason}) — not sent. Retry shortly; the visit's completion (or the next scheduled pass) settles it too.`;
}

// THE single place InvoiceService.settleZeroBalance is invoked on any send
// path (Codex round-5 #4131 — rounds 1 through 4 each fixed a different
// leak at a different call site on this same seam: packet ownership
// fenced AFTER settlement, a settlement committed inside a packet claim's
// own transaction then rolled back by that claim's later throw while
// still reporting success, a terminal verdict collapsed into a generic
// retryable refusal, an assistant tool reading a settled outcome as a
// delivered send). Every claim-path detector above only throws; this is
// the only function that actually calls settleZeroBalance, and it always
// does so through the top-level `db` — NEVER a caller's own transaction
// (a packet claim's `trx` included) — so a settlement this function
// commits can never be undone by anything the caller does afterward.
//
// Packet ownership is fenced FIRST, before settleZeroBalance ever runs: a
// live payer withdrawal always wins over a zero-due settlement that would
// otherwise mark the homeowner's allocation paid. Reuses
// claimPacketInvoiceForSend's own locked fence (fenceOnly) rather than a
// second ownership path.
//
// Returns one descriptor:
//   { kind: 'not_zero_due' }
//   { kind: 'settled', invoice }
//   { kind: 'refused', code: 'payer_billed' | 'deposit_settlement_pending', reason }
//   { kind: 'terminal', reason: 'visit_never_ran', scheduledServiceId }
async function settleZeroDueBeforeSend(invoiceId, { fenceOwnership = false, row = null } = {}) {
  // `row` lets a caller that already holds the invoice in memory (the
  // worker's due loop, reusing its own due-query SELECT) skip a redundant
  // read — this keeps the whole check a pure, no-extra-query read unless
  // the invoice is actually zero-due, exactly like every caller before
  // this chokepoint existed. A caller with only an invoiceId (a claim
  // path's zero_due_detected catch) reads fresh.
  //
  // workerOriginated (Codex round-8 audit P2 #4131): captured BEFORE row
  // is defaulted below — true only when the CALLER supplied a row, which
  // today is exclusively the due loop's own reused SELECT. That row is a
  // snapshot from before this call, and can go stale (an operator
  // reschedule landing in the gap) — requireDueBy re-verifies it under
  // settleZeroBalance's OWN row lock before any status change, so a
  // rescheduled invoice is never settled (or its packet review enrolled)
  // ahead of its new send time. Not applied to non-worker callers (a
  // direct claim-path resolve, an operator-initiated send) — they have no
  // due-list snapshot to go stale in the first place.
  const workerOriginated = !!row;
  // Codex pre-push P1 (round 2 of the owner's audit): the tagged try used
  // to start only at the settlement call, AFTER the row read, the
  // zero-due detection and the packet fenceOnly claim — a transient throw
  // from any of those (a DB fault) escaped untagged, so collections read
  // it as ambiguous and stamped delivery_unknown for a text that was
  // never attempted. NONE of this chokepoint ever reaches a provider —
  // every step here is pre-provider — so the whole thing is one tagged
  // try, not just the settlement call.
  let settlement;
  try {
    row = row || await db("invoices").where({ id: invoiceId }).first();
    if (!(await zeroDueVisitInvoice(row, db))) return { kind: "not_zero_due" };
    if (fenceOwnership && row.visit_completion_packet_id && !row.payer_id) {
      const fence = await claimPacketInvoiceForSend(invoiceId, row.visit_completion_packet_id, { fenceOnly: true });
      if (fence.payerBilled) {
        logger.info(`[invoice] ${invoiceId}: zero-due settlement skipped — the visit is now billed to payer ${fence.payerId}`);
        return { kind: "refused", code: "payer_billed", reason: `withdrawn to payer ${fence.payerId}` };
      }
    }
    settlement = await settleZeroDueVisitInvoice(invoiceId, db, { requireDueBy: workerOriginated ? new Date() : null });
  } catch (settlementErr) {
    // Settlement-stage throw → definite non-delivery (#4131 slice 5, #4634
    // deferral, invoice.js ~1297): settleZeroBalance never contacts a
    // provider — everything it can throw (e.g. visit_busy from the NOWAIT
    // visit lock in lockVisitForSettlement, or a genuine DB fault) happens
    // strictly BEFORE any send attempt. Tag it deliveryNeverAttempted, the
    // SAME marker claimInvoiceForSend's own preclaimed zero-due re-check
    // already uses for exactly this class of pre-provider throw (set
    // unconditionally, same convention, since nothing upstream of this
    // catch ever tags it first), then re-throw — this does NOT swallow the
    // error (settleZeroDueVisitInvoice's own contract, a prior pre-push
    // fix, is that an unrecognized throw must still propagate rather than
    // loop silently forever): it only tells every caller of this
    // chokepoint, definitively, that no text went out. Direct callers of
    // sendViaSMS (collections-conversation.js, the AI-assistant send tool)
    // otherwise read ANY throw here as ambiguous delivery and stamp
    // delivery_unknown, freezing a retry that is actually always safe.
    settlementErr.deliveryNeverAttempted = true;
    throw settlementErr;
  }
  if (settlement.reason === "rescheduled") {
    logger.info(`[invoice] ${invoiceId}: due-list row went stale — rescheduled to a later time before settlement could run; deferred, not settled`);
    return { kind: "rescheduled" };
  }
  if (settlement.settled) {
    // A combined-visit (packet) invoice settled here has no payment
    // webhook to trigger the packet's own review enrollment (the non-cash
    // prepaid transition emits none) — the other no-webhook settlement
    // rails (covered_by_credit) already call this. Best-effort, same as
    // those other sites (Codex round-5 audit non-P1 #4131 slice 4): this
    // runs AFTER the settlement above already committed — an enrollment
    // error must never surface as a failure of the settlement itself,
    // or the worker would count a genuinely settled invoice as failed.
    if (row.visit_completion_packet_id) {
      try {
        await enrollPacketReviewAfterCredit(invoiceId, row.visit_completion_packet_id);
      } catch (enrollErr) {
        logger.error(`[invoice] ${invoiceId}: review enrollment after zero-due settlement threw — settlement stands: ${enrollErr.message}`);
      }
    } else if (row.service_record_id) {
      // Codex round-9 audit P2 (#4131 slice 4, #4634): an ORDINARY
      // completion invoice (linked via service_record_id, no packet) that
      // settles zero-due here ALSO gets no payment webhook — the same
      // no-webhook gap enrollPacketReviewAfterCredit closes for packets
      // just above. Without this, a send with review intent that resolves
      // to a zero-due settlement (a deposit or prior credit covers it)
      // never enrolls the review the completion recorded: the at-delivery
      // path (invoice.js ~4616) defers an unpaid completion invoice's
      // review ask to the eventual paid webhook, which a non-cash prepaid
      // transition never fires. Reuses the SAME shared helper the Stripe
      // paid-invoice webhook and the admin record-payment path already
      // call for this exact purpose (enrollForPaidInvoice reads the
      // completion's own requestReview/visitOutcome from structured_notes
      // and no-ops for a standalone invoice) — no new enrollment logic.
      try {
        await require("./review-request").enrollForPaidInvoice(row, { source: "zero_due_settled" });
      } catch (enrollErr) {
        logger.error(`[invoice] ${invoiceId}: review enrollment after zero-due settlement threw — settlement stands: ${enrollErr.message}`);
      }
    }
    return { kind: "settled", invoice: settlement.invoice };
  }
  if (settlement.reason === "visit_never_ran") {
    logger.warn(`[invoice] ${invoiceId}: nothing due, but its linked visit never ran — routed to the terminal-visit cleanup instead of a retryable settlement refusal`);
    const scheduledServiceId = await linkedScheduledServiceId(row, db);
    return { kind: "terminal", reason: settlement.reason, scheduledServiceId };
  }
  if (settlement.reason === "payer_billed") {
    // settleZeroBalance's own re-validation caught a withdrawal this
    // fence never saw (Codex round-9 audit P1 #4131) — same descriptor
    // shape as the pre-emptive fence branch above so every caller of this
    // chokepoint keeps ONE payer_billed shape to read, whichever check
    // caught it.
    const withdrawnInvoice = settlement.invoice || {};
    const payerId = withdrawnInvoice.payer_id
      || String(withdrawnInvoice.scheduled_send_error || "").match(/^payer_billed:([^:]+)/)?.[1]
      || "unknown";
    logger.info(`[invoice] ${invoiceId}: zero-due settlement refused under its own lock — the visit is now billed to payer ${payerId}`);
    return { kind: "refused", code: "payer_billed", reason: `withdrawn to payer ${payerId}` };
  }
  if (settlement.reason === "already_settled" && settlement.invoice?.status === "prepaid") {
    // A concurrent zero-due settlement won the race between this caller's
    // detection and its own settleZeroBalance call (Codex round-9 audit
    // P2 #4131): the row is ALREADY the same completed no-op success this
    // caller would have produced — report it that way, not a retryable
    // deposit_settlement_pending/not_zero_due refusal for an invoice the
    // competing request already settled.
    logger.info(`[invoice] ${invoiceId}: zero-due settlement lost a concurrent race — another caller already marked it prepaid; reporting the same settled no-op success`);
    return { kind: "settled", invoice: settlement.invoice };
  }
  if (settlement.reason === "balance_due") {
    // Codex round-8 audit P2 (#4131 slice 4): a credit reversal or retotal
    // restored a positive balance BETWEEN this function's pre-lock
    // zeroDueVisitInvoice snapshot and settleZeroBalance's own FOR UPDATE
    // re-read — the exact same race `not_zero_due` already covers for a
    // claim-path re-check, just caught one lock later. The invoice is
    // genuinely collectible again, not stuck: map it to the SAME retry
    // descriptor so every caller's existing not_zero_due handling (the
    // wrapper's bounded retryOnceFn, the worker's due loop falling through
    // to its normal send flow) applies here too, instead of the generic
    // deposit_settlement_pending fallback below burning a direct-send 409
    // or a worker attempt on a balance that is no longer zero.
    logger.info(`[invoice] ${invoiceId}: zero-due settlement found a genuinely positive balance under its own lock — treated as not-zero-due, not a settlement refusal`);
    return { kind: "not_zero_due" };
  }
  logger.warn(`[invoice] ${invoiceId}: nothing due on the visit-linked invoice but zero-balance settlement was refused (${settlement.reason}) — send refused`);
  return { kind: "refused", code: "deposit_settlement_pending", reason: settlement.reason };
}

// Direct-SMS result shape (sendViaSMS / the AI-assistant tool / batch
// sendImmediately): { sent: false, ok, code, ... } — sent is ALWAYS false
// here; every one of these outcomes means nothing was ever delivered.
async function zeroDueDirectSendOutcome(invoiceId, outcome) {
  if (outcome.kind === "settled") {
    return { sent: false, ok: true, code: "zero_due", settled_zero_due: true,
      reason: "Nothing is due on this invoice — settled instead of delivering a $0 pay link" };
  }
  if (outcome.kind === "terminal") {
    // The sweep can safety-refuse the void (a live PaymentIntent, money
    // in flight, an unverifiable Stripe lookup) — voidTerminalZeroDueInvoice
    // reports that as `false`. This was previously discarded, reporting
    // INVOICE_VISIT_TERMINAL (handled) regardless (Codex round-6 audit
    // P1 #4131): the invoice may never be due for the worker again, so a
    // caller reading `ok: false` as "handled" left it un-voided with no
    // operator visibility at all. Mirror the worker's own path: a
    // distinct, non-terminal-looking code the shared classifier maps to
    // held-for-review, never reported as handled.
    const voided = await voidTerminalZeroDueInvoice(invoiceId, outcome.scheduledServiceId);
    if (!voided) {
      logger.warn(`[invoice] ${invoiceId}: zero-due terminal-visit invoice could not be safely voided (a live PaymentIntent, money in flight, or an unverifiable lookup) — held for review, not reported handled`);
      return { sent: false, ok: false, code: "INVOICE_VISIT_TERMINAL_UNVOIDED", voided: false, deliveryOutcome: "not_sent", retryable: true,
        reason: `${ZERO_DUE_TERMINAL_ERROR}, but the invoice could not be safely voided yet — held for review` };
    }
    return { sent: false, ok: false, code: "INVOICE_VISIT_TERMINAL", deliveryOutcome: "not_sent",
      reason: ZERO_DUE_TERMINAL_ERROR };
  }
  if (outcome.code === "payer_billed") {
    return { sent: false, ok: false, code: "payer_billed", reason: "Suppressed — the visit is now billed to a third-party payer" };
  }
  if (outcome.kind === "not_zero_due") {
    // The one _zeroDueRetried retry (see the call sites above) is
    // exhausted, or this call had no retry rail to begin with — the
    // balance changed WHILE this send was being resolved, genuinely
    // retryable, but NOT a recognized settlement refusal. The old
    // fallthrough below reused deposit_settlement_pending's "nothing is
    // due" wording for this too — false (the invoice IS collectible
    // again) and, with no `outcome.reason` on this descriptor, it
    // literally rendered "(undefined)" (Codex round-7 audit P1 #4131).
    return { sent: false, ok: false, code: "balance_changed_retry", deliveryOutcome: "not_sent", retryable: true,
      reason: "The balance changed while sending; try again" };
  }
  // Codex pre-push P1 (round 1 of the owner's audit): a `rescheduled`
  // branch was added here defensively (#4634's own round-11 note flagged
  // it as latent/unreachable), but the repo disallows speculative
  // future-proofing — only processScheduledSends' own due loop can ever
  // produce this kind, and it handles that inline without ever routing
  // through this mapper. Removed rather than kept as dead code; add it
  // back if a real caller ever needs to route `rescheduled` through here.
  return { sent: false, ok: false, code: "deposit_settlement_pending", deliveryOutcome: "not_sent", retryable: true,
    reason: zeroDueRefusalReasonText(outcome) };
}

// Wrapper-shaped outcome when `err` is a zero-due detection (see
// zeroDueDetectedError), or null when the caller must handle/rethrow it
// itself. One shared resolve-and-map step for sendViaSMSAndEmail's two
// claim-acquisition sites (the packet ownership claim and the plain
// claim), so neither duplicates the chokepoint call + mapping inline.
//
// `retryOnceFn`, when given, is called instead of mapping a `not_zero_due`
// outcome to a refusal (Codex round-6 P2 #4131): a concurrent credit
// reversal or retotal can restore a positive balance between the claim's
// own zero-due detection and this chokepoint's re-read — the invoice is
// genuinely collectible again, not stuck. Bounded to the one retry the
// caller's own `_zeroDueRetried` guard allows; omit it (or leave the
// guard already tripped) to map `not_zero_due` like any other outcome.
async function zeroDueWrapperOutcomeIfDetected(invoiceId, err, allowClaimed, retryOnceFn = null) {
  if (err?.code !== "zero_due_detected") return null;
  const outcome = await settleZeroDueBeforeSend(invoiceId, { fenceOwnership: !allowClaimed });
  if (outcome.kind === "not_zero_due" && retryOnceFn) return retryOnceFn();
  return zeroDueWrapperOutcome(invoiceId, outcome);
}

// Wrapper result shape (sendViaSMSAndEmail): { ok, sms, email, payUrl }.
async function zeroDueWrapperOutcome(invoiceId, outcome) {
  if (outcome.kind === "settled") {
    return { ok: true, settled_zero_due: true, sms: { ok: false, code: "settled_zero_due" }, email: { ok: false, code: "settled_zero_due" }, payUrl: null };
  }
  if (outcome.kind === "terminal") {
    // Same round-6 audit P1 fix, mirrored here for the wrapper shape: a
    // safety-refused void must never be reported the same as a completed
    // one.
    const voided = await voidTerminalZeroDueInvoice(invoiceId, outcome.scheduledServiceId);
    if (!voided) {
      logger.warn(`[invoice] ${invoiceId}: zero-due terminal-visit invoice could not be safely voided (a live PaymentIntent, money in flight, or an unverifiable lookup) — held for review, not reported handled`);
      const reason = `${ZERO_DUE_TERMINAL_ERROR}, but the invoice could not be safely voided yet — held for review`;
      return { ok: false, code: "INVOICE_VISIT_TERMINAL_UNVOIDED", voided: false, error: reason,
        sms: { ok: false, code: "INVOICE_VISIT_TERMINAL_UNVOIDED", deliveryOutcome: "not_sent" },
        email: { ok: false, code: "INVOICE_VISIT_TERMINAL_UNVOIDED", deliveryOutcome: "not_sent" } };
    }
    return { ok: false, code: "INVOICE_VISIT_TERMINAL", error: ZERO_DUE_TERMINAL_ERROR,
      sms: { ok: false, code: "INVOICE_VISIT_TERMINAL", deliveryOutcome: "not_sent" },
      email: { ok: false, code: "INVOICE_VISIT_TERMINAL", deliveryOutcome: "not_sent" } };
  }
  if (outcome.code === "payer_billed") {
    return { ok: false, error: "Suppressed — the visit is now billed to a third-party payer", code: "payer_billed",
      sms: { ok: false, code: "payer_billed" }, email: { ok: false, code: "payer_billed" } };
  }
  if (outcome.kind === "not_zero_due") {
    // Same round-7 audit P1 fix, mirrored here for the wrapper shape: an
    // exhausted retry must report an honest, retryable not-sent outcome —
    // never the pending/nothing-due wording, and never "(undefined)".
    const reason = "The balance changed while sending; try again";
    return { ok: false, code: "balance_changed_retry", error: reason,
      sms: { ok: false, code: "balance_changed_retry", deliveryOutcome: "not_sent" },
      email: { ok: false, code: "balance_changed_retry", deliveryOutcome: "not_sent" } };
  }
  // Same #4634 round-11 latent-branch removal as zeroDueDirectSendOutcome
  // above (Codex pre-push P1, round 1) — unreachable today for the same
  // reason, and the repo disallows speculative future-proofing.
  const err = depositSettlementPendingError(invoiceId, outcome.reason);
  return { ok: false, code: err.code, error: err.message, sms: { ok: false, code: err.code }, email: { ok: false, code: err.code } };
}

// processScheduledSends' due loop calls settleZeroDueBeforeSend BEFORE
// ever claiming. A settlement (or a payer withdrawal) leaves the row
// already off the queue (nothing further to do). A settlement REFUSAL is
// a failure to settle — not a window hold like quiet-hours or a provider
// retry — so it consumes an attempt and rides the SAME five-attempt cap
// and terminal-failure reporting (scheduled_send_error) as an ordinary
// send failure below; a permanently unsettleable invoice (a bug, stuck
// payment work) must eventually stop being retried and surface, not loop
// forever unclaimed and unreported. Moves scheduled_send_at forward like
// every other retry rail (Codex round-5 P2 #4131): leaving it due
// immediately let a persistently-refused row hold the 25-row due page
// against genuinely payable invoices behind it, every single tick.
async function recordZeroDueSchedulingOutcome(reasonText, inv) {
  const updated = await db("invoices")
    .where({ id: inv.id, status: "scheduled" })
    .whereNotNull("scheduled_send_at")
    .where("scheduled_send_at", "<=", new Date())
    .where((q) => q.whereNull("scheduled_send_attempts").orWhere("scheduled_send_attempts", "<", 5))
    .update({
      scheduled_send_attempts: db.raw("COALESCE(scheduled_send_attempts, 0) + 1"),
      scheduled_send_at: new Date(Date.now() + 5 * 60 * 1000),
      scheduled_send_error: reasonText,
      updated_at: new Date(),
    });
  if (!updated) {
    logger.warn(`[invoice] Zero-due refusal for ${inv.id} matched no row — already claimed by another pass, rescheduled, or already at the attempt cap`);
    return 0;
  }
  return 1;
}

// Codex round-8 audit P1 (#4131 slice 4): a payer_billed zero-due refusal
// is NOT always "the row is already off the queue" (the comment above this
// section used to assume that unconditionally). settleZeroDueBeforeSend's
// pre-emptive fence (claimPacketInvoiceForSend fenceOnly) only fires when
// the row's OWN payer_id is still NULL — a packet invoice already billed
// to a payer (payer_id set from creation, or a stamp an earlier pass
// already recorded) skips that fence entirely and resolves straight
// through settleZeroBalance's own read-only payer_billed skip, which never
// writes anything. Left alone, such a row's scheduled_send_at never moves
// and it is re-selected on every single due-page pass forever, occupying a
// slot the 25-row cap could give to a payable invoice behind it. This
// durably takes it off the queue (clearing scheduled_send_at, same as a
// stale-claim review hold or a parked payer withdrawal) — never a failure,
// no attempt spent, since nothing was ever collectible here to begin with.
// Idempotent against the SAME due predicate the claim itself requires: a
// row the pre-emptive fence already moved off the queue (scheduled_send_at
// cleared, status flipped) simply does not match here and this is a
// harmless no-op.
async function dequeuePayerOwnedZeroDueInvoice(inv, reasonText) {
  const updated = await db("invoices")
    .where({ id: inv.id, status: "scheduled" })
    .whereNotNull("scheduled_send_at")
    .where("scheduled_send_at", "<=", new Date())
    .update({
      scheduled_send_at: null,
      scheduled_send_error: reasonText,
      updated_at: new Date(),
    });
  if (!updated) {
    logger.info(`[invoice] Payer-owned zero-due dequeue for ${inv.id} matched no row — already moved off the queue`);
    return 0;
  }
  return 1;
}

// The scheduled-send worker's due-claim: the ONE place the queue predicates
// (still scheduled, due now, under the attempt cap) and the dedicated claim
// token are carried atomically. Shared by processScheduledSends' own loop
// and claimPacketInvoiceForSend's requireDue branch so a fairness change
// (the attempt cap, the due predicate) only has to be made once.
async function claimDueScheduledInvoiceForSend(database, invoiceId) {
  const claimToken = crypto.randomUUID();
  // Full row (pre-push audit P1, #4131 slice 4): claimPacketInvoiceForSend's
  // requireDue branch used to return "*" as claim.invoice before sharing
  // this helper, and downstream consumers of a packet claim read fields
  // (customer_id, token, invoice_number, payer_id, scheduled_service_id)
  // this narrower column list silently dropped. Costs nothing to widen —
  // the worker loop below still only reads the four fields it needs.
  const [claimed] = await database("invoices")
    .where({ id: invoiceId, status: "scheduled" })
    .whereNotNull("scheduled_send_at")
    .where("scheduled_send_at", "<=", new Date())
    .where((q) => q.whereNull("scheduled_send_attempts").orWhere("scheduled_send_attempts", "<", 5))
    .update({ status: "sending", updated_at: new Date(), send_claim_token: claimToken })
    .returning("*");
  return claimed || null;
}

async function claimInvoiceForSend(invoiceId, {
  allowClaimed = false,
  claimToken = null,
  firstDeliveryOnly = false,
  overridesReviewHold = false,
  adoptsQueuedInvoiceSend = false,
  database = db,
} = {}) {
  assertFirstDeliveryNotAnOverride(firstDeliveryOnly, overridesReviewHold, "claimInvoiceForSend");
  const current = await database("invoices").where({ id: invoiceId }).first();
  if (!current) throw invoiceNotSendableError(current);
  await require("./estimate-deposits").assertInvoiceDepositSettlementReady(database, current, { lock: false });

  if (allowClaimed) {
    if (!claimToken || current.send_claim_token !== claimToken) throw sendClaimLostError();
    if (!SEND_FINALIZABLE_STATUSES.includes(current.status)) throw invoiceNotSendableError(current);
    // Round-0 audit P1 (#4131): a preclaimed caller asking for a first
    // delivery must not lose the already-delivered / stale-claim-review-
    // hold guards the fresh-claim branch below already enforces — this
    // row can reach here already fully delivered (a resumed worker
    // preclaim racing a direct send) or still parked for operator review.
    refuseFirstDeliveryHold(current, invoiceId, firstDeliveryOnly, overridesReviewHold);
    // Zero-due re-check for a PRECLAIMED row (#4131 slice 4):
    // processScheduledSends' own settleZeroDueBeforeSend check runs BEFORE
    // it ever claims, so this only fires on the rare race where a retotal
    // to $0 lands between that read and this claim.
    await refuseZeroDuePreclaimedInvoice(invoiceId, current, database);
    // A preclaimed row (the scheduled-send worker flips 'scheduled' →
    // 'sending' itself, then calls back in with allowClaimed:true) still
    // needs the queued-obligation check: an earlier DIRECT send that held
    // its own pay-link text on the scheduled rail (invoice_send_deferred)
    // is otherwise invisible to this branch and would deliver the same
    // frozen pay link a second time. previousStatus here is current.status
    // itself ('sending', the caller's own preclaim) so restoreSendClaim's
    // guard never touches the invoice row on a refusal — only the
    // preclaimer's own claim-token restore may move it; a consumed queue
    // row is still restored.
    const consumedQueuedSendRows = await reconcileQueuedSendUnderClaim(invoiceId, current.status, claimToken, adoptsQueuedInvoiceSend, database);
    return { invoice: current, previousStatus: current.status, claimed: false, consumedQueuedSendRows };
  }

  // A first delivery that finds the row already delivered (round-6 P1
  // #4131) is refused atomically here, before the claimable-statuses check
  // below: a delivered row can sit at a claimable status (sent/viewed/
  // overdue) and a plain status check alone would let a first-delivery
  // request re-claim it as if it were an intentional resend. The
  // stale-claim review hold (same call, see refuseFirstDeliveryHold) is
  // gated on ONE explicit switch — overridesReviewHold — never inferred
  // from operatorInitiated or firstDeliveryOnly (third audit P1 #4131).
  refuseFirstDeliveryHold(current, invoiceId, firstDeliveryOnly, overridesReviewHold);
  if (!SEND_CLAIMABLE_STATUSES.includes(current.status)) {
    throw invoiceNotSendableError(current);
  }

  // Nothing due on a visit-linked invoice: detect it here (never settle —
  // settleZeroDueBeforeSend is the ONE place that ever does) and refuse
  // the claim so the caller resolves the real outcome through the
  // chokepoint. Never hand out a claim that would text a $0 pay link.
  if (await zeroDueVisitInvoice(current, database)) throw zeroDueDetectedError(invoiceId);

  // A live deferred pay-link text (quiet-hours queue) already owns this
  // invoice's delivery — refuse before claiming, unless this send is
  // authorized to adopt (consume) its own earlier held leg.
  const queuedBefore = await queuedPayLinkText(invoiceId, { adoptsQueuedInvoiceSend, database });
  if (queuedBefore) throw queuedPayLinkError(queuedBefore);

  const freshClaimToken = crypto.randomUUID();
  // The two guards above evaluated a snapshot. The flip below carries them
  // as predicates too, so a same-status ABA transition between the read and
  // the flip (another worker claims, reaches an uncertain outcome, and
  // stale-claim recovery parks the row back to 'scheduled' with a delivery
  // stamp) cannot pass a first delivery or an unauthorized reclaim through.
  const claimFlip = database("invoices").where({ id: invoiceId, status: current.status });
  if (firstDeliveryOnly) {
    claimFlip.whereNull("sent_at").whereNull("sms_sent_at").whereNull("email_sent_at");
  }
  if (!overridesReviewHold) {
    // COALESCE keeps the predicate NULL-safe: a scheduled row with no error
    // at all would otherwise make the LIKE, and so the whole NOT, evaluate
    // to NULL and never match the flip.
    claimFlip.whereRaw(
      "NOT (status = 'scheduled' AND scheduled_send_at IS NULL AND COALESCE(scheduled_send_error, '') LIKE ?)",
      [`${require("./invoice-helpers").STALE_SEND_PARK_ERROR}%`],
    );
  }
  const [invoice] = await claimFlip
    .update({ status: "sending", send_claim_token: freshClaimToken, updated_at: new Date() })
    .returning("*");
  if (!invoice) {
    const latest = await database("invoices").where({ id: invoiceId }).first();
    // The row moved between the read and the flip: report the guard the
    // latest row trips (review hold first, then delivered for a first
    // delivery) rather than a generic "not sendable" (round-6 P1 #4131).
    refuseFirstDeliveryHold(latest, invoiceId, firstDeliveryOnly, overridesReviewHold);
    // Pre-push audit P1 (PR #4633): neither guard above tripped, but the
    // row is 'sending' under SOME claim token — a concurrent first
    // delivery won this exact race. Distinct from "not sendable": the
    // customer's pay link IS on its way, just not from this request.
    if (firstDeliveryOnly && latest?.status === "sending" && latest.send_claim_token) {
      throw firstDeliveryInProgressError(latest);
    }
    throw invoiceNotSendableError(latest);
  }
  invoice.send_claim_token = freshClaimToken;
  await reverifyClaimedVisitInvoice(invoiceId, invoice, current.status, database);
  const consumedQueuedSendRows = await reconcileQueuedSendUnderClaim(invoiceId, current.status, freshClaimToken, adoptsQueuedInvoiceSend, database);
  return { invoice, previousStatus: current.status, claimed: true, consumedQueuedSendRows };
}

// A combined-visit invoice minted self-pay is re-checked against live Bill-To
// ownership at delivery time, not only when it was scheduled. The customer
// and billed member rows are held FOR SHARE while ownership is resolved and
// the send is claimed, so a payer assignment serializes behind the claim
// instead of racing it. A payer means the debt now belongs to AP: the
// invoice leaves the scheduled-send queue and the visit goes on billing hold.
async function claimPacketInvoiceForSend(invoiceId, packetId, {
  allowClaimed = false,
  claimToken = null,
  requireDue = false,
  firstDeliveryOnly = false,
  overridesReviewHold = false,
  // Runs ONLY the locked ownership fence below (resolve + withdraw) and
  // returns without ever claiming — the SAME fence every other caller of
  // this function already runs, reused rather than duplicated (Codex
  // round-3 P1 #4131): a combined-visit invoice's zero-due pre-claim
  // settlement must not mark the homeowner's allocation paid before a
  // Bill-To move to a payer is (re)checked live. Mutually exclusive with
  // requireDue/allowClaimed — a worker/preclaimed caller always follows
  // this fence with its own claim in the SAME call, never a separate one.
  fenceOnly = false,
  // Threaded into the ordinary (non-requireDue, non-fenceOnly) claim below
  // exactly like claimInvoiceForSend's own callers already do for a
  // non-packet invoice (#4131 slice 5 — deferred by #4632 r2 P2). Without
  // this, an operator retry of a packet-backed invoice whose earlier
  // combined send queued its SMS leg on the scheduled rail was refused
  // outright with queued_pay_link until the window, instead of adopting
  // (cancelling) that row the way the ordinary claim path already can.
  adoptsQueuedInvoiceSend = false,
} = {}) {
  // requireDue is the scheduled-send worker's claim: an automatic queue
  // send, never a first-delivery request, and never an operator override —
  // its due predicate (scheduled_send_at <= now) is also why a parked row
  // (scheduled_send_at NULL) can never be claimed here, so the review hold
  // holds by construction. Keep the flags mutually exclusive rather than
  // threading the first-delivery/override guards into a branch no caller
  // can reach with them.
  if (requireDue && (firstDeliveryOnly || overridesReviewHold)) {
    throw new Error("claimPacketInvoiceForSend: requireDue is the queue worker's claim and cannot be a first delivery or override the review hold");
  }
  if (fenceOnly && (requireDue || allowClaimed)) {
    throw new Error("claimPacketInvoiceForSend: fenceOnly cannot be combined with requireDue or allowClaimed");
  }
  assertFirstDeliveryNotAnOverride(firstDeliveryOnly, overridesReviewHold, "claimPacketInvoiceForSend");
  const Packets = require("./visit-completion-packets");
  return db.transaction(async (trx) => {
    // The worker's claim keeps the scheduled queue's own predicates: due
    // now, still scheduled, under the attempt cap.
    if (requireDue) {
      const due = await trx("invoices").where({ id: invoiceId, status: "scheduled" })
        .whereNotNull("scheduled_send_at").where("scheduled_send_at", "<=", new Date())
        .where((q) => q.whereNull("scheduled_send_attempts").orWhere("scheduled_send_attempts", "<", 5)).first("id");
      if (!due) return { payerBilled: false, claim: null };
    }
    const { visit, billed, payerId } = await Packets.resolvePacketOwnershipLocked(packetId, trx);
    if (visit && payerId && await Packets.withdrawPacketInvoiceForPayer(trx, { packetId, invoiceId, visit, billed, payerId })) {
      await trx("invoices").where({ id: invoiceId }).update({ send_claim_token: null });
      return { payerBilled: true, payerId };
    }
    if (fenceOnly) return { payerBilled: false, claim: null };
    if (requireDue) {
      // The status transition carries the queue predicates: a reschedule
      // that committed between the due read and this claim leaves the row
      // scheduled for later, and it must stay there. Shares
      // claimDueScheduledInvoiceForSend with processScheduledSends' own
      // loop — one chokepoint for the due predicates and the claim token.
      const invoice = await claimDueScheduledInvoiceForSend(trx, invoiceId);
      return { payerBilled: false, claim: invoice ? { invoice, previousStatus: "scheduled", claimed: true } : null };
    }
    return { payerBilled: false, claim: await claimInvoiceForSend(invoiceId, { allowClaimed, claimToken, firstDeliveryOnly, overridesReviewHold, adoptsQueuedInvoiceSend, database: trx }) };
  });
}

// A combined-visit invoice settled entirely by account credit is paid without
// a payment webhook or a manual payment: the packet's requested review is
// enrolled from the coverage path itself (best-effort; the recovery sweep
// owns retries through the packet).
async function enrollPacketReviewAfterCredit(invoiceId, packetId) {
  if (!packetId) return null;
  let result = null;
  try {
    result = await require("./review-request").enrollForPaidInvoice({ id: invoiceId, visit_completion_packet_id: packetId }, { source: "credit_covered" });
  } catch (err) {
    logger.warn(`[invoice] review enrollment after credit coverage failed for ${invoiceId}: ${err.message}`);
    return null;
  }
  // Credit coverage has no payment webhook to redeliver: an enrollment the
  // packet could neither record nor reopen for is lost unless someone is
  // told. The settlement stands; the office enrolls the review by hand.
  if (result && result.enrolled === false && result.recorded === false) {
    logger.error(`[invoice] review enrollment after credit coverage unrecorded for ${invoiceId} (packet ${packetId}): ${result.error || result.reason}`);
    // notifyAdmin swallows its own insert failure and returns null (Codex
    // #4311 r38 P1), so its result is checked and a SECOND durable signal —
    // the same visit_closeout_review alert the other settlement rails raise —
    // is written when it could not land. Credit coverage has no webhook to
    // redeliver, so this is the last chance to leave a record.
    let notified = null;
    try {
      notified = await require("./notification-service").notifyAdmin(
        "alert",
        "Visit review not enrolled after credit coverage",
        `Invoice ${invoiceId} was settled by account credit, but the completed visit's review request could not be recorded. Enroll the review from the visit if it is still wanted.`,
        { link: "/admin/communications", metadata: { dedupeKey: `review-enrollment-unrecorded:${invoiceId}`, invoice_id: invoiceId, packet_id: packetId } },
      );
    } catch (err) {
      logger.warn(`[invoice] unrecorded review enrollment alert failed for ${invoiceId}: ${err.message}`);
    }
    if (!notified) {
      try {
        const open = await db("dispatch_alerts").where({ type: "visit_closeout_review" }).whereNull("resolved_at")
          .whereRaw("payload->>'reason' = 'review_enrollment_unrecorded'")
          .whereRaw("payload->>'invoiceIds' LIKE ?", [`%${invoiceId}%`])
          .first("id");
        if (!open) {
          await require("./dispatch-alerts").createAlert({
            type: "visit_closeout_review",
            severity: "warn",
            payload: {
              reason: "review_enrollment_unrecorded",
              source: "credit_covered",
              invoiceIds: [invoiceId],
              packetId,
              detail: "This credit-settled invoice owes a review ask that could not be recorded — enroll it from the visit or ask manually.",
            },
          });
        }
      } catch (alertErr) {
        logger.error(`[invoice] BOTH unrecorded-enrollment signals failed for ${invoiceId} (packet ${packetId}): ${alertErr.message}`);
      }
    }
  }
  return result;
}

// THE chokepoint for giving a send claim back. Restore any consumed queued
// pay-link SMS BEFORE exposing the invoice as claimable again — otherwise
// another sender could claim the invoice between those two writes and race
// the restored text for the same pay link. A previous status of 'sending'
// belongs to the outer scheduled-send preclaimer, whose token must remain
// untouched for its own guarded restore, so only the queue is restored then
// (consumedQueuedSendRows is independent of `claimed`: a preclaimed
// caller's OWN adoption inside claimInvoiceForSend still needs undoing on
// refusal even though it never owns the invoice-status transition).
async function restoreSendClaim(invoiceId, previousStatus, claimed, consumedQueuedSendRows = [], database = db, claimToken = null) {
  if (!claimToken || !previousStatus) return false;
  try {
    return await database.transaction(async (trx) => {
      const owned = await trx("invoices")
        .where({ id: invoiceId, status: "sending", send_claim_token: claimToken })
        .forUpdate()
        .first("id");
      if (!owned) return false;
      await restoreConsumedQueuedSend(consumedQueuedSendRows, trx, claimToken);
      if (!claimed || previousStatus === "sending") return true;
      const restored = await trx("invoices")
        .where({ id: invoiceId, status: "sending", send_claim_token: claimToken })
        .update({ status: previousStatus, send_claim_token: null, updated_at: new Date() });
      return restored !== 0;
    });
  } catch (err) {
    logger.warn(`[invoice] Could not restore send claim for ${invoiceId}: ${err.message}`);
    return false;
  }
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
async function convertLeadOnInvoiceSent({ invoiceId, customerId, priorStatus, priorDelivered = false }) {
  // priorDelivered: the invoice carried delivery stamps (sent_at /
  // sms_sent_at) BEFORE this send. An unvoided invoice returns to 'draft'
  // with its historical stamps retained, so priorStatus alone would read
  // its resend as a first delivery and the contact fallback could mark an
  // unrelated newer lead won (Codex #3493 r7).
  if (!customerId || priorDelivered || !FIRST_SEND_STATUSES.includes(priorStatus)) return;
  try {
    const { convertLeadFromEvent } = require("./lead-estimate-link");
    await convertLeadFromEvent({ source: "invoice_sent", customerId });
  } catch (leadErr) {
    logger.warn(`[invoice] lead conversion on send failed (${invoiceId}): ${leadErr.message}`);
  }
}

async function optionalInvoiceRead(database, read, fallback) {
  try {
    return database?.isTransaction && typeof database.transaction === "function"
      ? await database.transaction(read)
      : await read(database);
  } catch {
    return fallback;
  }
}

async function annualPrepayInvoiceTableExists(database = db) {
  if (!database.schema?.hasTable) return false;
  return optionalInvoiceRead(database, (conn) => conn.schema.hasTable("annual_prepay_terms"), false);
}

async function loadAnnualPrepayTermForInvoice(invoiceId, database = db) {
  if (!invoiceId) return null;
  const exists = await annualPrepayInvoiceTableExists(database);
  if (!exists) return null;
  const term = await optionalInvoiceRead(database, (conn) => conn("annual_prepay_terms")
    .where({ prepay_invoice_id: invoiceId }).first(), null);
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
// Durable machine marker linking a rodent-setup re-bill draft to the
// reversed invoice it replaced (codex #3591 r46 P1) — the revival sweep
// voids unsent replacements by it.
function rodentSetupRebillMarker(invoiceId) {
  return `[rodent-setup-rebill:${invoiceId}]`;
}

const InvoiceService = {
  async buildLineItemsForScheduledService(scheduledServiceId, options = {}) {
    return buildScheduledServiceInvoiceLines(scheduledServiceId, options);
  },

  /**
   * Create an invoice — optionally linked to a service record.
   * If serviceRecordId is provided, pulls products, photos, tech info automatically.
   */
  async create(createArgs, packetWrite = null) {
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
      // Batch idempotency key (POST /admin/invoices/batch): persisted on the
      // row so a batch retry can detect invoices the earlier attempt already
      // created; the partial unique index (customer_id, batch_key) makes the
      // concurrent-retry case lose atomically at the DB.
      batchKey = null,
      // Canonical hash of the batch payload the key rode in with — a later
      // keyed duplicate with a DIFFERENT fingerprint is a misused key, not a
      // retry (the batch route refuses it).
      batchFingerprint = null,
      // skipAccrual: this invoice must NOT accrue to a payer statement even for a
      // NET-terms payer — set by callers that immediately settle the invoice
      // (annual-prepay, paid in the same flow) or create a throwaway preview
      // (project send dry-run). Accruing those would double-bill (already paid) or
      // leave a phantom statement line (cancelled preview).
      skipAccrual = false,
      // frozenTaxAuthority: the caller's explicit taxRate is FROZEN money
      // (the completion resume contract: backfillMintTaxRate →
      // mintInvoiceTaxRate → here) — it was derived by the calculator at
      // the freeze point, and the resume validator proves the mint against
      // those exact frozen numbers. Skip the verified-exemption recheck for
      // these callers only: an exemption verified AFTER the freeze would
      // otherwise mint a total that contradicts the frozen contract and
      // wedge the retry. Ordinary caller-supplied rates keep the recheck.
      frozenTaxAuthority = false,
      // The Bill-To identity the frozen rate was derived FOR (undefined =
      // caller didn't freeze one; null = frozen self-pay). Meaningful only
      // with frozenTaxAuthority: mint-time payer resolution must land on
      // this same entity or create() fails CLOSED — a payer assigned or
      // removed after the freeze would otherwise mint the frozen rate for
      // a party it was never derived for (e.g. a self-pay exempt 0% onto a
      // newly assigned non-exempt payer's AP invoice).
      frozenPayerId = undefined,
      // Codex pre-push audit P1 (round 4 on PR #4655): mirrors
      // calculateUpdateFinancials' own check — the admin form's submit-time
      // freshness probe only confirms the gate for that probe request; this
      // binds the CONFIRMED value it previewed under to the write itself.
      // undefined (no caller passes it — every internal mint/batch/retry
      // caller included) skips the check, byte-identical to before.
      expectedDiscountStacking = undefined,
    } = createArgs;

    if (
      expectedDiscountStacking !== undefined &&
      expectedDiscountStacking !== discountStackingLive()
    ) {
      const gateDivergedErr = new Error(
        "Discount rules changed since this was previewed — reload and try again",
      );
      gateDivergedErr.statusCode = 409;
      gateDivergedErr.status = 409;
      gateDivergedErr.isOperational = true;
      gateDivergedErr.code = "DISCOUNT_STACKING_GATE_DIVERGED";
      throw gateDivergedErr;
    }

    // Only the packet coordinator passes the second argument. Never accept
    // shared ownership from route line items or other customer-supplied fields.
    if (packetWrite && (!database?.isTransaction || !packetWrite.packetId)) {
      throw new Error('Visit invoice creation requires its owning transaction');
    }
    let linkedScheduledServiceId = scheduledServiceId;
    let linkedRecordServiceDate = null;
    if (serviceRecordId) {
      const linkedRecord = await database('service_records')
        .where({ id: serviceRecordId, customer_id: customerId })
        .first('scheduled_service_id', 'service_date');
      if (!linkedScheduledServiceId) linkedScheduledServiceId = linkedRecord?.scheduled_service_id || null;
      linkedRecordServiceDate = linkedRecord?.service_date || null;
    }

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
      const pre = await PayerSvc.resolveForInvoice({ database: db, customerId, scheduledServiceId: linkedScheduledServiceId, throwOnError: true });
      if (pre.payerId && ["net15", "net30"].includes(pre.paymentTerms)) {
        return db.transaction((trx) => InvoiceService.create({ ...createArgs, database: trx }, packetWrite));
      }
    }

    // CHOKE-POINT serialization (Codex P0, PR #3476): EVERY create that
    // links a scheduled visit or carries the accepted-estimate stamp
    // holds the shared advisory locks — route-level wrapping alone left
    // direct writers (converter accept mints, public acceptance) able to
    // commit between an alert transaction's coverage scans and its
    // instruction write. Canonical order: mint lock → setup-fee lock.
    // Re-acquisition inside an already-locked caller transaction is a
    // no-op; unwrapped linked/stamped creates get their own transaction
    // (the best-effort tax/discount catches then abort with it — accepted
    // for linked money writes; plain unlinked creates keep the
    // untransacted path).
    const stampedEstimateIdInNotes = require('./setup-fee-alert-reconcile').acceptedEstimateIdFromNotes(notes);
    if (linkedScheduledServiceId || stampedEstimateIdInNotes) {
      if (database && database.isTransaction) {
        if (linkedScheduledServiceId) {
          const { acquireScheduledInvoiceMintLock } = require("./scheduled-invoice-mint");
          await acquireScheduledInvoiceMintLock(database, linkedScheduledServiceId);
        }
        if (stampedEstimateIdInNotes) {
          await database.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`unminted_setup_fee_manual_billing:${stampedEstimateIdInNotes}`]);
        }
      } else if (typeof (database || db).transaction === 'function') {
        // Resolve the record link again INSIDE the transaction, before any
        // mint lock. A pre-transaction link never selects the guarded member.
        return (database || db).transaction((trx) => InvoiceService.create({ ...createArgs, database: trx }, packetWrite));
      }
      // Harness databases may omit transaction(); production knex does not.
    }
    if (linkedScheduledServiceId) {
      const { assertScheduledInvoiceNotPacketOwned } = require('./scheduled-invoice-mint');
      await assertScheduledInvoiceNotPacketOwned(database, linkedScheduledServiceId, packetWrite?.packetId);
    } else if (packetWrite) {
      throw new Error('Visit invoice requires a billed member');
    }
    // A stamped writer may have waited behind packet adoption. Recheck its
    // owner inside the mint transaction, before creating another charge.
    if (stampedEstimateIdInNotes) {
      const packetConflict = () => Object.assign(
        new Error('This estimate is billed by its saved visit closeout. Resume that closeout.'),
        { status: 409, statusCode: 409, isOperational: true, code: 'VISIT_PACKET_OWNS_BILLING' });
      const contention = (error) => {
        if (error?.code !== '55P03') throw error;
        throw Object.assign(new Error('Estimate billing is being updated. Retry in a moment.'),
          { status: 409, statusCode: 409, isOperational: true, code: 'VISIT_PACKET_OWNS_BILLING' });
      };
      // Match the date create() will persist: explicit input wins, then a
      // service record's own completion date, then a scheduled-only visit.
      // Pin a derived value so the later context read cannot validate one
      // date here and insert another after a concurrent edit.
      if (!serviceDate && serviceRecordId) serviceDate = linkedRecordServiceDate;
      if (!serviceDate && !serviceRecordId && scheduledServiceId) {
        const linkedScheduled = await database('scheduled_services')
          .where({ id: scheduledServiceId, customer_id: customerId }).first('scheduled_date');
        serviceDate = linkedScheduled?.scheduled_date || null;
      }
      let packetOwners;
      try {
        packetOwners = await database('invoices as i')
          .join('visit_completion_packet_items as p', 'p.invoice_id', 'i.id')
          .join('scheduled_services as s', 's.id', 'p.scheduled_service_id')
          .where({ 'i.customer_id': customerId })
          .whereRaw('s.source_estimate_id::text = ?', [stampedEstimateIdInNotes])
          .whereNotNull('i.visit_completion_packet_id').orderBy('i.id')
          .forUpdate('i').noWait().select('i.id', 'i.status', 'i.service_date', 'i.line_items', 'i.notes');
      } catch (error) { contention(error); }
      const { classifyAcceptedEstimateInvoiceCoverage,
        sumPositiveSetupFeeCents } = require('./estimate-first-application-invoice');
      // Compare the calculated invoice amounts, not caller-supplied amount.
      const normalizedSetupLines = normalizeInvoiceLineItems(lineItems || []);
      const incomingCoverage = classifyAcceptedEstimateInvoiceCoverage(
        { line_items: normalizedSetupLines }, serviceDate,
      );
      const separateSetupFee = incomingCoverage.setupFeeOnly
        && normalizedSetupLines.filter((line) => line.amount > 0)
          .every((line) => /^WaveGuard Membership — one-time setup fee$/i.test(String(line.description || '').trim()))
        && packetOwners.every((owner) => {
          const lines = parseInvoiceLineItems(owner.line_items);
          return lines.length > 0 && lines.every((line) => line && Number.isFinite(Number(line.amount)));
        });
      let separateSetupFeeAllowed = separateSetupFee;
      if (packetOwners.length && separateSetupFee) {
        // The estimate advisory lock serializes concurrent replacement writers.
        // Lock their fee coverage too, failing operationally on a busy row.
        let stampedCoverage;
        try {
          stampedCoverage = await database('invoices').where({ customer_id: customerId })
            .where('notes', 'ilike', `%accepted estimate #${stampedEstimateIdInNotes}%`)
            .orderBy('id').forUpdate().noWait().select('id');
        } catch (error) { contention(error); }
        const obligation = await require('./setup-fee-obligation').findUnmintedSetupFeeObligation({
          sourceEstimateId: stampedEstimateIdInNotes, customerId,
        }, database);
        // The obligation reader counts stamped rows. Packet ownership also
        // survives edited notes; count each unstamped owner once, and retain
        // refunded cents as covered so deliberately refunded fees are not rebilled.
        const stampedIds = new Set(stampedCoverage.map((row) => String(row.id)));
        const unstampedOwners = [...new Map(packetOwners.map((row) => [String(row.id), row])).values()]
          .filter((row) => !stampedIds.has(String(row.id)) && !['void', 'canceled', 'cancelled'].includes(row.status));
        const packetFeeCents = unstampedOwners.reduce((sum, row) => sum + sumPositiveSetupFeeCents(row), 0);
        separateSetupFeeAllowed = obligation.owed && Number.isSafeInteger(obligation.setupFeeRemainingCents)
          && sumPositiveSetupFeeCents({ line_items: normalizedSetupLines }) <= obligation.setupFeeRemainingCents - packetFeeCents;
      }
      // Application ownership is visit-date scoped, matching the inverse
      // packet guard: an explicit other date is a different application,
      // while either side missing a date fails closed. Setup-fee coverage is
      // estimate-wide and therefore deliberately uses every packet owner.
      const matchingPacketOwners = packetOwners.filter((owner) =>
        classifyAcceptedEstimateInvoiceCoverage(owner, serviceDate).matchesApplicationDate);
      if ((incomingCoverage.hasSetupFee && packetOwners.length && (!separateSetupFee || !separateSetupFeeAllowed))
        || (!incomingCoverage.hasSetupFee && matchingPacketOwners.length)) throw packetConflict();
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
    // party. Reuse the same link resolved for the mint lock above; the row's own
    // scheduled_service_id linkage below is unchanged.
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
      scheduledServiceId: linkedScheduledServiceId,
      // Fail closed under the statements gate: if payer resolution is uncertain,
      // a NET-terms job must NOT silently fall back to self-pay and create an
      // individually-collectible invoice instead of accruing. (Default fail-soft
      // when the gate is off — unchanged for everyone today.)
      // Also fail closed under a FROZEN Bill-To contract (codex pre-push r5
      // P0): a fail-soft lookup error would report self-pay, match a frozen
      // frozenPayerId === null, and mint the frozen (possibly exempt-0)
      // rate onto the homeowner while a real non-exempt payer exists.
      throwOnError: isEnabled("payerStatements") || frozenTaxAuthority,
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
        return db.transaction((trx) => InvoiceService.create({ ...createArgs, database: trx }, packetWrite));
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
    // Frozen Bill-To identity check (codex pre-push r4 P0): when the
    // caller's taxRate is frozen money, the mint-time payer must be the
    // same entity the rate was derived for. Divergence fails CLOSED with a
    // retryable conflict — never mint a frozen rate for a different party.
    // A frozen contract is EFFECTIVE only when the identity stamp is
    // complete (r8 P0): a legacy record frozen before backfillMintPayerId
    // existed may carry the old flat 7% rate that never encoded payer
    // exemption — for those, create()'s normal exemption semantics stay in
    // force (resolvedTaxExempt zeroing + the self-pay recheck), exactly as
    // they corrected legacy rates before this contract existed.
    const frozenContractComplete = frozenTaxAuthority && frozenPayerId !== undefined;
    if (frozenContractComplete
      && String(resolvedPayerId || '') !== String(frozenPayerId || '')) {
      const divergedErr = new Error(
        'Bill-To changed since this completion froze its tax basis — re-run the completion so the invoice is derived for the current payer.',
      );
      divergedErr.statusCode = 409;
      divergedErr.status = 409;
      divergedErr.isOperational = true;
      divergedErr.code = 'FROZEN_PAYER_DIVERGED';
      throw divergedErr;
    }

    // A tax-exempt payer (builder/HOA with a resale/exemption cert on file)
    // zeroes tax on its invoices — even commercial jobs that would otherwise
    // carry the +7%. Force the rate to 0 so the tax block below resolves to 0.
    // NOT under frozenTaxAuthority: the frozen rate already encoded the
    // payer's exemption at the freeze (identity pinned above), so a
    // post-freeze exemption flip must not mutate the frozen contract.
    if (resolvedTaxExempt && !frozenContractComplete) taxRate = 0;

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

        // Snapshot the durable s3_key, not a presigned URL — stored URLs expire
        // (new uploads don't even populate s3_url), so the read path presigns
        // fresh at view time. Legacy s3_url kept only as a last-resort fallback.
        const photos = await database("service_photos")
          .where({ service_record_id: serviceRecordId })
          .orderBy("sort_order", "asc")
          .select("photo_type", "s3_key", "s3_url", "caption");

        const invoiceServiceDate = serviceDate || sr.service_date;
        serviceData = {
          service_record_id: serviceRecordId,
          technician_id: sr.technician_id,
          service_date: invoiceServiceDate,
          service_type: sr.service_type,
          tech_name: sr.tech_name,
          // The invoice snapshots these notes durably and the pay page serves
          // them on an unauthenticated invoice token — a WDO completion's
          // notes get the same legacy inspection-fee scrub as every other
          // customer render (codex #2817).
          tech_notes: customerSafeServiceNotes(sr.technician_notes, sr.structured_notes),
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

    // GATE_DISCOUNT_STACKING (slice 5 of #4405): manual picks and per-line
    // discounts compound through the SAME engine the admin previewed
    // (discount-engine.js's /calculate delegates to discountStackingLive()
    // in this same change) — a fixed credit lands before percentages
    // compound, and a fresh pick compounds on what a stored stamp already
    // left rather than the line's/subtotal's full gross. Gate off keeps
    // the exact pre-lane math in the else branch, byte-identical: each
    // line discount off its own full line, each manual discount
    // independently against the untouched subtotal.
    let manualDiscounts;
    let lineItemDiscounts;
    if (discountStackingLive()) {
      // Codex pre-push audit P1 (round 4 on PR #4655): a stored visit
      // stamp's discount_id can point at a now-retired/hidden row — load
      // its bare metadata separately (round 5 P1: on the SAME `database`
      // — the caller's transaction when create() is running inside one,
      // e.g. a linked scheduled-service mint — never a second, independent
      // pooled connection that could starve the pool while this trx still
      // holds its own; round 5 P2 x2: a SEPARATE map, never merged into
      // lineItemDiscountRowById, so a fresh item sharing that discount_id
      // can never resolve a row from it) before the group check runs.
      const groupConflictMetaById = await loadTrustedGroupConflictMeta({
        items,
        rowById: lineItemDiscountRowById,
        trustedStoredSources,
        database,
      });
      ({ manualDiscounts, lineItemDiscounts } = computeStackedDocumentDiscountLines({
        items,
        serviceLineByClientId,
        lineItemDiscountRowById,
        manualDiscountRows,
        trustedStoredSources,
        groupConflictMetaById,
      }));
    } else {
      manualDiscounts = manualDiscountRows.map((d) => {
        const amt = Number(d.amount) || 0;
        let dollars = 0;
        if (
          d.discount_type === "percentage" ||
          d.discount_type === "variable_percentage"
        ) {
          // Cent-exact (Codex pre-push audit P1, round 6): the old
          // `Math.round(subtotal * (amt / 100) * 100) / 100` float formula
          // rounded 5% of $20.70 down to $1.03, never the correct half-up
          // $1.04 — the SAME bug server/services/discount-stack.js's
          // percentage math was fixed for, and the discount-engine.js
          // preview delegates to. percentageDiscountDollars is that same
          // fix, exported so this line uses the ONE place this rounding
          // rule is written instead of a second, independently-buggy copy.
          // This fix is UNCONDITIONAL (both gate states); only the
          // COMPOUNDING above is gated.
          dollars = percentageDiscountDollars(subtotal, amt, d.max_discount_dollars);
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
      lineItemDiscounts = items
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
    }
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

    // Line-item discounts label with their RESOLVED names (owner 2026-07-11:
    // the invoice shows the same discount label the estimate promised —
    // "Referral Credit", not the generic "Line-item discounts"). The literal
    // survives only as the fallback for a nameless line.
    // Codex pre-push audit P2 (round 4 on PR #4655): a document term can
    // legitimately resolve to $0 (an earlier credit already exhausted its
    // eligible balance) — this mapping used to retain every term's name
    // regardless, so two $100 fixed discounts on a $100 invoice printed
    // BOTH names though only the first actually applied. Build labels only
    // from terms whose resolved dollars are positive, matching the
    // dollars > 0 filter recordInvoiceDiscounts' audit rows already use.
    const lineItemDiscountNames = [...new Set(
      lineItemDiscounts
        .filter((m) => m.dollars > 0)
        .map((m) => String(m.name || "").trim())
        .filter(Boolean),
    )];
    const labelParts = [
      ...manualDiscounts.filter((m) => m.dollars > 0).map((m) => m.row.name),
      ...(lineItemDiscountAmount > 0
        ? (lineItemDiscountNames.length ? lineItemDiscountNames : ["Line-item discounts"])
        : []),
    ].filter(Boolean);
    // invoices.discount_label is varchar(100) while discount names allow 200
    // chars (codex 2652 r1) — bound the joined label so the insert can never
    // fail on a long or multi-name label.
    const joinedDiscountLabel = labelParts.join(" + ");
    const discountLabel = labelParts.length
      ? (joinedDiscountLabel.length > 100 ? `${joinedDiscountLabel.slice(0, 97)}...` : joinedDiscountLabel)
      : null;

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
    // A COMPLETE frozen contract outranks the current property_type (codex
    // pre-push r9 P0): the committed rate is the money truth for a required
    // resume — a post-freeze flip to residential must not re-derive 0% and
    // underbill the frozen commercial tax. Ordinary invoices and incomplete
    // legacy freezes keep the residential zero.
    if (!isCommercial && !frozenContractComplete) {
      rate = 0;
      taxAmount = 0;
    } else if (taxRate !== undefined) {
      rate = taxRate;
      // An explicit rate must not override the customer's VERIFIED tax
      // exemption: TaxCalculator zeroes tax for a verified certificate
      // (and preview runs the calculator), so honoring a caller's flat
      // rate here minted tax the preview never showed and the certificate
      // forbids. One implementation — the calculator's own helper. Fail
      // SAFE on lookup error: keep the caller's rate (tax stays charged),
      // never fail open to 0. Self-pay ONLY: on a payer-billed invoice the
      // snapshotted Bill-To entity owes the tax and its own tax_exempt flag
      // (resolvedTaxExempt above) governs — the service customer's
      // certificate must not zero a non-exempt payer's bill.
      if (Number(rate) > 0 && !resolvedPayerId && !frozenContractComplete) {
        try {
          // SAVEPOINT when riding a caller transaction (codex r11 P1): a
          // caught statement error would otherwise leave the transaction
          // aborted and the invoice insert below would fail instead of
          // using this catch's fallback. A nested knex transaction is a
          // savepoint — the failed statement rolls back to it alone.
          const exemption = await (database !== db && typeof database.transaction === "function"
            ? database.transaction((sp) => TaxCalculator.findVerifiedExemption(customerId, { database: sp }))
            : TaxCalculator.findVerifiedExemption(customerId, { database }));
          if (exemption) rate = 0;
        } catch (err) {
          logger.warn(
            `[invoice] verified-exemption check failed for explicit taxRate (customer ${customerId}): ${err.message}`,
          );
        }
      }
      taxAmount = Math.round(afterDiscount * rate * 100) / 100;
    } else {
      try {
        // Ride the caller's connection: when create() runs inside a caller's
        // transaction (schedule mint under acquireScheduledInvoiceMintLock),
        // a bare calculateTax would grab a SECOND pool connection while the
        // first is held — concurrent mints can then deadlock-wait the pool.
        // Payer-billed: the service customer's certificate must not zero a
        // non-exempt payer's automatic rate either — an EXEMPT payer already
        // zeroed via resolvedTaxExempt (explicit rate 0) and never reaches
        // this branch.
        // Same savepoint discipline as the exemption recheck above (r11
        // P1): the legacy-fallback catch below is only reachable if the
        // failed statement did not abort the caller's transaction.
        const taxResult = await (database !== db && typeof database.transaction === "function"
          ? database.transaction((sp) => TaxCalculator.calculateTax(
              customerId,
              serviceData.service_type || title,
              afterDiscount,
              { database: sp, skipCustomerExemption: !!resolvedPayerId },
            ))
          : TaxCalculator.calculateTax(
              customerId,
              serviceData.service_type || title,
              afterDiscount,
              { database, skipCustomerExemption: !!resolvedPayerId },
            ));
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
          // Freeze at creation even when the bar is disabled: a primary flip
          // can commit between this customer read and the invoice INSERT.
          customer_address_snapshot: require('./invoice-address').invoiceAddressSnapshot(customer),
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
          ...(packetWrite ? { visit_completion_packet_id: packetWrite.packetId } : {}),
          ...(resolvedPayerId ? { payer_id: resolvedPayerId } : {}),
          ...(resolvedPoNumber ? { po_number: resolvedPoNumber } : {}),
          ...(batchKey ? { batch_key: batchKey } : {}),
          ...(batchKey && batchFingerprint ? { batch_fingerprint: batchFingerprint } : {}),
          ...(resolvedPayerSnapshot ? { payer_snapshot: JSON.stringify(resolvedPayerSnapshot) } : {}),
          ...(accruedStatementId ? { payer_statement_id: accruedStatementId } : {}),
          ...serviceData,
          // The record link identifies a billed member; its treatment is not
          // the whole visit. Keep packet invoice copy neutral after tax used
          // the validated service basis. Each report owns its treatment detail.
          ...(packetWrite ? {
            service_type: 'Combined service visit', tech_notes: null,
            products_applied: JSON.stringify([]), service_photos: JSON.stringify([]),
          } : {}),
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
      // Codex pre-push audit P2 (round 3 on PR #4655): a resolved term can
      // be legitimately $0 — an orphaned scoped stamp (its target service
      // removed) or a credit an earlier one already exhausted the line's
      // remaining balance against — and still carries its catalog id.
      // recordInvoiceDiscounts increments discounts.times_applied for
      // every row it's handed regardless of dollars, so a $0 replay would
      // report as a successful use of a discount that took nothing off
      // this invoice. Filter before recording, not after — the ledger
      // rollup (discounts.total_discount_given) already nets to the same
      // total either way since a $0 row contributes nothing to it, but
      // times_applied has no such self-correcting property.
      for (const m of scaledManualDiscounts) {
        if (!(m.dollars > 0)) continue;
        auditRows.push({
          id: m.row.id,
          name: m.row.name,
          discount_type: m.row.discount_type,
          amount: Number(m.row.amount) || 0,
          discount_dollars: m.dollars,
        });
      }
      for (const m of scaledLineItemDiscounts) {
        if (!(m.dollars > 0)) continue;
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
    let previewPayerBilled = false;
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
      previewPayerBilled = !!resolved.payerId;
    } catch { /* preview proceeds with the normal tax calc */ }

    const isCommercial =
      cust.property_type === "commercial" || cust.property_type === "business";
    let rate, taxAmount;
    if (!isCommercial || payerTaxExempt) {
      rate = 0;
      taxAmount = 0;
    } else {
      try {
        // Mirror create(): a non-exempt payer's preview must not show the
        // service customer's certificate zeroing tax the payer invoice will
        // actually charge.
        const taxResult = await TaxCalculator.calculateTax(
          customerId,
          serviceType || title,
          subtotal,
          { database, skipCustomerExemption: previewPayerBilled },
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
  /**
   * Retention offer (cancel-flow C1): the negative line for a GRANTED
   * offer on this visit's service family. Applies only to a RECURRING,
   * non-callback scheduled visit — the offer discounts "the next charges
   * of the kept service", never one-time work. Pure lookup + math; the
   * CAS consumption happens in the mint transaction after create.
   */
  async buildRetentionOfferLineForMint({ customerId, scheduledServiceId, lineItems, database }) {
    if (!customerId || !scheduledServiceId) return null;
    const dbh = database || db;
    // Catalog identity joins along (codex r1 P1): familyOfServiceRow is
    // catalog-authoritative — a stale free-form service_type must not pick
    // the wrong family's offer.
    const visit = await dbh("scheduled_services as s")
      .leftJoin("services as sv", "s.service_id", "sv.id")
      .where("s.id", scheduledServiceId)
      .first("s.service_type", "s.is_recurring", "s.recurring_ongoing", "s.is_callback", "s.source", "sv.service_key", "sv.name as service_name");
    if (!visit) return null;
    if (visit.is_callback === true) return null;
    if (!(visit.is_recurring === true || visit.recurring_ongoing === true)) return null;
    const { familyOfServiceRow } = require("./cancellation-processor");
    const family = familyOfServiceRow(visit);
    if (!family) return null;
    const offer = await dbh("retention_offers")
      .where({ customer_id: customerId, family_key: family, status: "granted" })
      .orderBy("granted_at", "asc")
      .first();
    if (!offer) return null;
    const { retentionDiscountForInvoice } = require("./cancellation-resolution/retention-offer");
    // Eligible subtotal = the visit's net recurring charge (positive lines
    // minus stored visit discounts) — already post-tier-discount by design.
    // Codex pre-push audit P1 (round 2 on PR #4655): under
    // GATE_DISCOUNT_STACKING, a stamped item's `amount` here is still its
    // FROZEN face value as buildScheduledServiceInvoiceLines built it —
    // scope resolution (an orphaned scoped stamp collapsing to $0) only
    // happens inside computeStackedDocumentDiscountLines, which create()
    // itself runs LATER, after this retention line is already sized and
    // reserved. A $100 visit with an orphaned frozen $30 stamp used to
    // size a 15% retention credit off the raw $70 ($10.50) instead of the
    // real eligible $100 ($15) the invoice actually saves — permanently
    // under-crediting the offer's charges-applied counter against the
    // WRONG amount. Resolve the same computation here first (idempotent:
    // create() reruns it on its own copy of these items and reaches the
    // identical resolved amounts), so the retention line reserves against
    // the subtotal the invoice will actually save. Gate off never scopes
    // anything, so raw item.amount is already correct pre-lane — skip.
    let resolvedLineItems = lineItems;
    if (discountStackingLive() && Array.isArray(lineItems) && lineItems.length) {
      const resolvedItems = normalizeInvoiceLineItems(lineItems);
      const serviceLineByClientId = new Map(
        resolvedItems
          .filter((item) => Number(item.amount) > 0 && item.client_id)
          .map((item) => [String(item.client_id), item]),
      );
      const lineItemDiscountIds = resolvedItems
        .filter((item) => Number(item.amount) < 0 && item.discount_id)
        .map((item) => item.discount_id);
      const lineItemDiscountRowById = new Map(
        (await loadInvoiceDiscountRows(lineItemDiscountIds, dbh)).map((row) => [String(row.id), row]),
      );
      // Codex pre-push audit P1 (round 4 on PR #4655): the retention-sizing
      // pass runs its OWN group check (same shared function) — a persisted
      // stamp pointing at a retired discount must count there too, or a
      // conflict would slip through this earlier call only to be caught
      // (or missed) again by create()'s own later, identical pass. Round 5
      // P1: on `dbh` — this runs inside the mint's own transaction, and a
      // second call through the global pool here could starve it while dbh
      // still holds its own connection. Round 5 P2 x2: a SEPARATE map,
      // never merged into lineItemDiscountRowById, so a fresh item sharing
      // that discount_id can never resolve a row from it.
      const groupConflictMetaById = await loadTrustedGroupConflictMeta({
        items: resolvedItems,
        rowById: lineItemDiscountRowById,
        trustedStoredSources: EDIT_TRUSTED_DISCOUNT_SOURCES,
        database: dbh,
      });
      // Codex pre-push audit P1 (round 2 on PR #4655): reuse the file's
      // own EDIT_TRUSTED_DISCOUNT_SOURCES (scheduled_service AND
      // validated_checkout) instead of a narrower ad-hoc literal — an
      // unparented validated_checkout stamp on this same invoice would
      // otherwise classify as neither a line entry (no parent) nor a
      // document entry (documentEntries requires stored || no discount_id,
      // and this item has both discount_for:null and a discount_id), and
      // computeStackedDocumentDiscountLines would throw "Invalid line-item
      // discount" out of this retention/cancellation path for an
      // otherwise-valid invoice.
      computeStackedDocumentDiscountLines({
        items: resolvedItems,
        serviceLineByClientId,
        lineItemDiscountRowById,
        manualDiscountRows: [],
        trustedStoredSources: EDIT_TRUSTED_DISCOUNT_SOURCES,
        groupConflictMetaById,
      });
      resolvedLineItems = resolvedItems;
    }
    const eligibleSubtotal = (resolvedLineItems || []).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    const application = retentionDiscountForInvoice(offer, eligibleSubtotal, {});
    if (!application) return null;
    return {
      offerId: offer.id,
      expectedChargesApplied: Number(offer.charges_applied) || 0,
      amount: application.amount,
      lineItem: application.lineItem,
      exhaustsOffer: application.exhaustsOffer,
    };
  },

  /**
   * Retention-offer lookup + slot reservation for a mint, run on the mint
   * transaction under a SAVEPOINT. Fail-soft by contract — but a plain
   * try/catch on the caller's trx is NOT fail-open in Postgres: any failed
   * statement aborts the WHOLE transaction, so the mint that followed died
   * with "current transaction is aborted" and four priced completions went
   * out unbilled with a report-only text (2026-08-31→09-01, a bad column
   * in the visit select). The savepoint rolls back only this block; the
   * invoice still mints. Returns the retention application ({ offerId,
   * lineItem, … }) when a slot was reserved, else null.
   */
  async applyRetentionOfferUnderSavepoint({ customerId, scheduledServiceId, lineItems, trx }) {
    if (!trx) return null;
    try {
      return await trx.transaction(async (sp) => {
        // Reserve the offer slot with a CAS UPDATE inside the SAME mint
        // transaction BEFORE the line exists (codex P0): a concurrent mint
        // that loses the race reserves nothing and adds no line, so the
        // charge count and the $75 cap can never be exceeded. A rolled-back
        // mint reverts the reservation with it.
        const retention = await this.buildRetentionOfferLineForMint({
          customerId,
          scheduledServiceId,
          lineItems,
          database: sp,
        });
        if (!retention) return null;
        const { reserveRetentionSlot } = require("./cancellation-resolution/retention-offer");
        const reserved = await reserveRetentionSlot(retention, sp);
        return reserved ? retention : null;
      });
    } catch (retentionErr) {
      logger.warn(`[invoice] retention-offer check failed for customer ${customerId}: ${retentionErr.message}`);
      return null;
    }
  },

  async createFromService(
    serviceRecordId,
    {
      amount,
      description,
      taxRate,
      useScheduledReplay = false,
      dueDate,
      skipDepositCredit = false,
      // Caller-supplied lines appended AFTER the service's own lines (secure
      // plan-choice setup fee): the caller owns the claim/idempotency for
      // these — this method just carries them into the same mint so the fee
      // and the visit share one invoice.
      extraLineItems = [],
      // The estimated_price the caller's `amount` was DERIVED from (codex
      // #3344 r2): replay callers that pre-compute a price from the row
      // (billing recovery, live completion) pass it so the locked rebuild
      // can prove the row hasn't been repriced since — fallbackAmount
      // outranks the row price in the line builder, so without this check
      // a stale amount would silently win over the freshly locked value.
      // Omitted = the amount is its own authority (operator-typed).
      scheduledPriceBasis = undefined,
      // skipAccrual (Codex P1, PR #2897 fix round 5): threaded through to
      // create(), which owns the option (see its comment). The backdated
      // backfill closeout mints a quiet REVIEW invoice — for a NET-terms
      // payer visit under the payerStatements gate, create() would otherwise
      // attach it to the payer's OPEN monthly statement and roll the
      // statement total up, i.e. the unreviewed invoice lands on a
      // consolidated bill before anyone looks at it. With the opt-out the
      // invoice stays a plain payer invoice (payer_id / PO / snapshot
      // intact, individually sendable). Attachment happens only at create,
      // so a reviewer who wants it consolidated voids + re-creates it.
      skipAccrual = false,
      // Threaded to create(): the completion mint's taxRate is frozen money
      // — see create()'s frozenTaxAuthority / frozenPayerId comments.
      frozenTaxAuthority = false,
      frozenPayerId = undefined,
      // Caller's open transaction (codex r6 P1): a caller that already
      // holds the schedule.invoice.mint advisory lock (billing recovery)
      // MUST thread its transaction here — the replay mint otherwise opens
      // a SEPARATE connection and requests the same lock, deadlocking on
      // the caller until timeout (advisory locks are only re-entrant
      // within one session). Threaded transactions run the mint under a
      // SAVEPOINT, so deposit-machinery failures stay isolated from the
      // caller's transaction, and the invoice commits atomically with the
      // caller's own writes.
      database = null,
    },
  ) {
    const sr = await db("service_records")
      .where({ id: serviceRecordId })
      .first();
    if (!sr) throw new Error("Service record not found");
    const runMintTransaction = (fn) => (
      database && database.isTransaction ? database.transaction(fn) : db.transaction(fn)
    );

    const hasExplicitAmount =
      amount !== undefined && amount !== null && Number(amount) > 0;
    const replayFromScheduled =
      (useScheduledReplay || !hasExplicitAmount) && !!sr.scheduled_service_id;
    // Params are built PER MINT ATTEMPT, on the minting connection
    // (mint-serialization, WaveGuard #3338 fast-follow): the replay path
    // derives its price from the scheduled row, so that read happens under
    // FOR UPDATE inside the same transaction the invoice mints in — a
    // concurrent reprice (the tier-extension apply holds the same lock)
    // either commits first and is billed, or waits for this mint. The
    // explicit-amount path bills the operator's figure and needs no lock.
    let retentionOfferApplication = null;
    const buildParams = async (conn = null) => {
      retentionOfferApplication = null;
      if (replayFromScheduled && conn) {
        const {
          acquireScheduledMintLockChain,
          scheduledPriceMovedError,
        } = require("./scheduled-invoice-mint");
        // The shared lock chain (codex #3344 r9 P1 — this was the last
        // hand-rolled copy of the key-share → visit-lock order): the
        // advisory re-acquire inside the chain is a same-transaction no-op
        // after adoptUnderMintLock, and the customer-before-visit order the
        // extension accept path establishes is owned by the ONE module.
        const lockedRow = await acquireScheduledMintLockChain(conn, {
          scheduledServiceId: sr.scheduled_service_id,
          customerId: sr.customer_id,
          visitColumns: ["id", "estimated_price"],
        });
        // Stale-basis refusal (codex #3344 r2): when the caller's amount
        // was derived from the row price, a locked price that no longer
        // matches means a reprice (the WaveGuard extension) landed since —
        // and fallbackAmount would outrank the fresh price in the line
        // builder. Terminal 409, same contract as the shared mint helper:
        // the retry re-reads and bills the current price.
        if (
          lockedRow &&
          scheduledPriceBasis !== undefined &&
          scheduledPriceBasis !== null
        ) {
          const cents = (v) =>
            v === null || v === undefined ? null : Math.round(Number(v) * 100);
          if (cents(lockedRow.estimated_price) !== cents(scheduledPriceBasis)) {
            throw scheduledPriceMovedError(lockedRow);
          }
        }
      }
      const scheduledInvoice = replayFromScheduled
        ? await buildScheduledServiceInvoiceLines(sr.scheduled_service_id, {
            fallbackAmount: amount,
            fallbackDescription: description || sr.service_type,
            database: conn,
          })
        : null;
      let lineItems = scheduledInvoice?.lineItems?.length
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
      // Retention offer (cancel-flow C1, 15% × 2 charges / $75 cap): a
      // GRANTED offer discounts the VISIT's recurring lines only — computed
      // BEFORE extras (setup fees, operator additions) are appended, so the
      // 15% never touches supplemental charges (codex r1 P2). Fail-soft —
      // a lookup problem never blocks the invoice; consumption is CAS'd in
      // the mint transaction, under a SAVEPOINT (see the helper).
      if (conn) {
        const retention = await this.applyRetentionOfferUnderSavepoint({
          customerId: sr.customer_id,
          scheduledServiceId: sr.scheduled_service_id || null,
          lineItems,
          trx: conn,
        });
        if (retention) {
          lineItems = [...lineItems, retention.lineItem];
          retentionOfferApplication = retention;
        }
      }
      if (Array.isArray(extraLineItems) && extraLineItems.length) {
        lineItems = [...lineItems, ...extraLineItems];
      }
      return {
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
        skipAccrual,
        frozenTaxAuthority,
        frozenPayerId,
      };
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
    // machinery failures leave invoicing on hold for manual reconciliation;
    // an unknown deposit balance must never become a full-balance pay link.
    //
    // skipDepositCredit (Codex P1, PR #2897 fix round): callers whose
    // contract is an UNTOUCHED invoice for operator review — the backdated
    // backfill closeout — opt out entirely. The ledger is neither read nor
    // consumed, no credit line is added, and the invoice mints at face
    // value; the unapplied balance stays on the estimate for the reviewer
    // to apply deliberately. (The consume path is pure ledger math — no
    // receipt or customer notification — but it moves deposit money and
    // reduces/zeroes the invoice, which is exactly the mutation the review
    // contract forbids.)
    // The shared mint serialization, not a parallel one (pre-push P0,
    // codex r6 round; consolidated into scheduled-invoice-mint in r8):
    // every scheduled-service invoice writer serializes on the two-key
    // ['schedule.invoice.mint', ssId] advisory lock with an in-lock replay
    // re-check. The replay transactions below lock the visit ROW, but a
    // Charge Now / completion mint that wins that lock and commits first
    // would leave this transaction to wake and blindly create a SECOND
    // collectible invoice for the same visit. Take the same advisory lock
    // FIRST (same order as the helper: advisory → customer key-share →
    // visit lock, the latter two inside buildParams), then adopt any
    // non-terminal invoice that landed — the caller's reuse filters ran
    // before this transaction and cannot have seen it.
    // The slot was RESERVED in buildParams (same trx); after the invoice
    // row exists, stamp its id on the offer. A failure throws inside the
    // transaction so the mint AND the reservation roll back together —
    // there is no path where a discount line commits unconsumed.
    const settleRetention = async (created, dbh) => {
      if (!retentionOfferApplication || !created || !created.id) return;
      const { stampRetentionApplied } = require("./cancellation-resolution/retention-offer");
      const updated = await stampRetentionApplied({ offerId: retentionOfferApplication.offerId, ref: created.id }, dbh || db);
      if (!updated) throw new Error(`retention offer ${retentionOfferApplication.offerId} vanished before invoice ${created.id} could be stamped`);
    };

    const adoptUnderMintLock = async (trx) => {
      if (!replayFromScheduled) return null;
      const { adoptScheduledInvoiceUnderMintLock } = require("./scheduled-invoice-mint");
      return adoptScheduledInvoiceUnderMintLock(trx, sr.scheduled_service_id);
    };

    let sourceEstimateId = null;
    if (!skipDepositCredit && sr.scheduled_service_id) {
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
        acquireEstimateDepositLedgerLock,
        pendingDepositCredit,
        consumeDepositCredit,
      } = require("./estimate-deposits");
      let depositError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await runMintTransaction(async (trx) => {
            // EVERY linked mint holds the shared advisory lock (Codex PR
            // r9 P1): the deposit-credit path returns before the
            // explicit-amount lock branch below, and adoptUnderMintLock
            // is a no-op for non-replay mints — without this, a linked
            // deposit-credit invoice can commit between a completion
            // alert's scans and its instruction write. Re-acquire is a
            // same-transaction no-op on the replay path.
            if (sr.scheduled_service_id) {
              const { acquireScheduledInvoiceMintLock } = require("./scheduled-invoice-mint");
              await acquireScheduledInvoiceMintLock(trx, sr.scheduled_service_id);
            }
            // An adopted invoice already ran its own deposit/credit flow —
            // return it untouched; the roll-forward belongs to the mint
            // that actually created the invoice.
            const adopted = await adoptUnderMintLock(trx);
            if (adopted) return adopted;
            const createParams = await buildParams(trx);
            await acquireEstimateDepositLedgerLock(trx, sourceEstimateId);
            const depositCredit = await pendingDepositCredit(sourceEstimateId, trx);
            // Request the full unapplied balance; create() caps it against
            // its own post-discount, after-tax total (a pre-discount cap
            // here consumed ledger dollars the discounted invoice never
            // reflected) and reports the effective amount back.
            const created = await this.create({
              ...createParams,
              database: trx,
              depositCredit: depositCredit ? { amount: depositCredit.amount, estimateId: sourceEstimateId } : null,
            });
            await settleRetention(created, trx);
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
          depositError = err;
          // Stale-price/authorization refusals are terminal — retrying the
          // same stale params can't fix them (mirrors the shared mint
          // helper's contract).
          if (err.status) throw err;
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
      throw depositError;
    }

    if (replayFromScheduled) {
      return runMintTransaction(async (trx) => {
        const adopted = await adoptUnderMintLock(trx);
        if (adopted) return adopted;
        const created = await this.create({ ...(await buildParams(trx)), database: trx });
        await settleRetention(created, trx);
        return created;
      });
    }
    // LINKED explicit-amount mints serialize under the same advisory mint
    // lock (owner ruling 2026-08-25, Codex #3476): every writer that
    // attaches an invoice to a scheduled visit must hold the
    // schedule.invoice.mint lock, or a manual invoice can commit between a
    // completion-alert transaction's coverage scans and its instruction
    // write — the alert then records a bill-again instruction for a charge
    // that just got billed. Unlinked creates keep the untransacted path.
    if (sr.scheduled_service_id) {
      return runMintTransaction(async (trx) => {
        const { acquireScheduledInvoiceMintLock } = require("./scheduled-invoice-mint");
        await acquireScheduledInvoiceMintLock(trx, sr.scheduled_service_id);
        const created = await this.create({ ...(await buildParams(trx)), database: trx });
        await settleRetention(created, trx);
        return created;
      });
    }
    {
      const created = await this.create({
        ...(await buildParams(null)),
        ...(database ? { database } : {}),
      });
      await settleRetention(created, database || null);
      return created;
    }
  },

  /**
   * Get invoice by public token — for the /pay page.
   * Also records view and updates status unless this is a follow-up read.
   */
  async getByToken(token, { recordView = true, database = db } = {}) {
    let invoice = await database("invoices").where({ token }).first();
    if (!invoice) return null;
    // NOTE: do NOT block payer_statement_id here — getByToken also backs the
    // PERMANENT receipt endpoints (receipt-v2), which must never 404 (AGENTS.md).
    // The accrued-invoice "statement-only" block lives in the PAY + invoice-PDF
    // routes instead (the collection surfaces), not this shared loader.

    // The pay page rereads after its deposit fence. That read must not count
    // as another view. Keep the write conditional on the LIVE status: a
    // settlement between the first SELECT and this UPDATE must stay prepaid.
    const seenAt = new Date();
    if (recordView) {
      await database("invoices").where({ id: invoice.id }).update({
        view_count: database.raw("COALESCE(view_count, 0) + 1"),
        viewed_at: database.raw("COALESCE(viewed_at, ?)", [seenAt]),
        status: database.raw("CASE WHEN status = 'sent' THEN 'viewed' ELSE status END"),
      });
      invoice = await database("invoices").where({ id: invoice.id }).first();
      if (!invoice) return null;
    }

    // Enrich with customer info
    const customer = await database("customers")
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
    const annualPrepayTerm = await loadAnnualPrepayTermForInvoice(invoice.id, database);

    const line_items =
      typeof invoice.line_items === "string"
        ? JSON.parse(invoice.line_items)
        : invoice.line_items;

    // Annual-prepay coverage callout (null for ordinary invoices). Built from
    // the parsed line items so setup-fee-waived detection sees the real text.
    const annual_prepay = await loadInvoiceAnnualPrepay({ ...invoice, line_items }, database);

    return {
      ...invoice,
      customer: require('./invoice-address').invoiceCustomerAddress(invoice, customer),
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
      service_photos: await withFreshServicePhotoUrls(
        typeof invoice.service_photos === "string"
          ? JSON.parse(invoice.service_photos)
          : invoice.service_photos || [],
      ),
      annual_prepay_term: annualPrepayTerm,
    };
  },

  /**
   * Send invoice via Twilio SMS — the unified service recap + invoice message.
   */
  async sendViaSMS(invoiceId, { allowClaimed = false, claimToken = null, firstDeliveryOnly = false, overridesReviewHold = false, payUrlParams = null, operatorInitiated = false, actorTechnicianId = null, adoptsQueuedInvoiceSend = true,
    // Internal-only: sends this same call once more after a not_zero_due
    // chokepoint outcome (Codex round-6 P2 #4131) — a caller never sets
    // this itself, so a real race can retry at most once, never loop.
    _zeroDueRetried = false,
  } = {}) {
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
    // A combined-visit invoice minted self-pay is re-judged against live
    // Bill-To ownership under held rows here too: the direct SMS callers (the
    // assistant's send tool, collections calls) otherwise read only the stale
    // invoice field. The wrapper (allowClaimed) already ran this fence.
    let claim;
    let pre = null;
    try {
      if (!allowClaimed) {
        pre = await db("invoices").where({ id: invoiceId }).first("visit_completion_packet_id", "payer_id");
        const packetClaim = pre?.visit_completion_packet_id && !pre.payer_id
          ? await claimPacketInvoiceForSend(invoiceId, pre.visit_completion_packet_id, { firstDeliveryOnly, overridesReviewHold, adoptsQueuedInvoiceSend }) : null;
        if (packetClaim?.payerBilled) {
          return { sent: false, reason: "Suppressed — the visit is now billed to a third-party payer", code: "payer_billed" };
        }
        claim = packetClaim ? packetClaim.claim : await claimInvoiceForSend(invoiceId, { allowClaimed, claimToken, firstDeliveryOnly, overridesReviewHold, adoptsQueuedInvoiceSend });
      } else {
        claim = await claimInvoiceForSend(invoiceId, { allowClaimed, claimToken, adoptsQueuedInvoiceSend, firstDeliveryOnly, overridesReviewHold });
      }
    } catch (claimErr) {
      // Codex round-5 #4131: a claim path detecting zero-due never settles
      // itself (see zeroDueDetectedError) — direct callers of sendViaSMS
      // (collections-conversation.js, the AI-assistant send tool, batch
      // sendImmediately, the from-service SMS path) treat ANY thrown error
      // as an ambiguous delivery outcome (stamp delivery_unknown, close the
      // retry latch), so the ONE chokepoint is resolved here and mapped to
      // a structured, unambiguous result instead of ever letting the
      // detection itself escape as a throw.
      if (claimErr?.code === "zero_due_detected") {
        const outcome = await settleZeroDueBeforeSend(invoiceId, { fenceOwnership: !allowClaimed });
        // A concurrent credit reversal / retotal restored a positive
        // balance between the claim's own zero-due check and the
        // chokepoint's re-read (Codex round-6 P2 #4131): the invoice is
        // collectible again, not stuck — retry the whole claim+send once
        // rather than refusing it as deposit_settlement_pending. A SECOND
        // not_zero_due (vanishingly rare) is mapped normally, never a
        // second retry.
        if (outcome.kind === "not_zero_due" && !_zeroDueRetried) {
          return this.sendViaSMS(invoiceId, {
            allowClaimed, claimToken, firstDeliveryOnly, overridesReviewHold, payUrlParams,
            operatorInitiated, actorTechnicianId, adoptsQueuedInvoiceSend, _zeroDueRetried: true,
          });
        }
        return zeroDueDirectSendOutcome(invoiceId, outcome);
      }
      throw claimErr;
    }
    const { invoice, previousStatus, claimed, consumedQueuedSendRows = [] } = claim;

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
        // Resolve the adopted rows while the token still owns the row —
        // the resolution is token-scoped and would be a silent no-op after
        // the clear below.
        const queueOutcome = await resolveAdoptedRowsAfterDelivery(invoiceId, invoice.send_claim_token, consumedQueuedSendRows, invoice.invoice_number);
        const cleared = await db("invoices")
          .where({ id: invoiceId, send_claim_token: invoice.send_claim_token })
          .update({ send_claim_token: null, updated_at: new Date() });
        if (!cleared) throw sendClaimLostError();
        await enrollPacketReviewAfterCredit(invoiceId, pre?.visit_completion_packet_id);
        // Covered by credit IS success for the caller (the invoice is now 'prepaid',
        // settled — nothing to send). Direct callers check `sent || ok`, so flag
        // ok:true; sent stays false because no SMS went out. No claim to restore —
        // the apply flipped the row to the terminal 'prepaid' state.
        return { sent: false, ok: true, covered_by_credit: true, code: "covered_by_credit", reason: "Invoice covered by account credit — nothing to collect", ...queueOutcome };
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
      await restoreSendClaim(invoiceId, previousStatus, claimed, consumedQueuedSendRows, db, invoice.send_claim_token);
      return { sent: false, reason: "Suppressed — invoice billed to a third-party payer", code: "payer_billed" };
    }

    const customer = await db("customers")
      .where({ id: invoice.customer_id })
      .first();
    if (!customer?.phone) {
      const restored = await restoreSendClaim(invoiceId, previousStatus, claimed, consumedQueuedSendRows, db, invoice.send_claim_token);
      if (restored) await reverseSmsCreditOnFailure();
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

    const serviceType = invoice.service_type || invoice.title || "your service";

    // Service-date framing, all on the ET calendar day. Knex returns DATE as a
    // UTC-midnight Date; etCalendarDayOf reads that and a plain YYYY-MM-DD
    // string as the same calendar day (etDateString would shift the Date to
    // the previous ET day and wrongly drop the "today" clause). An unparseable
    // value falls back to undated copy.
    let serviceYmd = "";
    try {
      serviceYmd = invoice.service_date ? etCalendarDayOf(invoice.service_date) : "";
    } catch {
      serviceYmd = "";
    }
    const todayYmd = etDateString(new Date());
    // The annual-prepay "Today's visit is the first of N" clause is gated on
    // today: a resend from sent/viewed/overdue or a delayed/scheduled send can
    // run on a day other than service_date, where a same-day claim would be false.
    const serviceDateIsTodayET = serviceYmd === todayYmd;
    // A service date still in the future — the setup + first-application
    // invoice auto-sent at estimate acceptance is the common case — must not
    // use the generic "...completed on {service_date}" copy. ISO YYYY-MM-DD
    // compares lexicographically === chronologically.
    const serviceDateIsFutureET = serviceYmd > todayYmd;
    const formattedDate = serviceYmd
      ? new Date(`${serviceYmd}T12:00:00`).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "America/New_York",
      })
      : "";

    // Pre-service copy: a future service date, or a linked visit that has not
    // completed. An overdue or same-day appointment can still be open, so its
    // completion state decides rather than its date; an unreadable status
    // fails toward the pre-service copy.
    let preServiceCopy = serviceDateIsFutureET;
    if (!preServiceCopy && invoice.scheduled_service_id) {
      try {
        const visit = await db("scheduled_services").where({ id: invoice.scheduled_service_id }).first("status");
        preServiceCopy = visit?.status !== "completed";
      } catch (err) {
        logger.warn(`[invoice] Linked visit status lookup failed for ${invoiceId}: ${err.message}`);
        preServiceCopy = true;
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
      const firstName = customer.first_name || "";
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
          first_name: firstName,
          coverage_summary: coverageSummary,
          first_visit_clause: firstVisitClause,
          pay_url: payUrl,
        }, tplOpts);
      }
      // Upfront invoices — the setup + first-application invoice auto-sent at
      // estimate acceptance, or any invoice billed before its service date —
      // must not use the generic "...completed on {service_date}" copy, which
      // asserts a not-yet-performed service AND prints a future date. A future
      // service date or an uncompleted linked visit selects a pre-service
      // variant with no completion claim and no date placeholder. Gated on the same base `invoice` kill
      // switch as the prepay variant (a disabled invoice_sent skips this too,
      // keeping the invoice retryable); a missing/disabled variant row falls
      // through to the standard copy below so the send is never blocked.
      if (!body && preServiceCopy && invoiceSmsActive) {
        body = await templates.getTemplate("invoice_sent_upfront", {
          first_name: firstName,
          service_type: serviceType,
          pay_url: payUrl,
        }, tplOpts);
      }
      if (!body) {
        // Either an ordinary invoice, or the prepay template was missing/disabled
        // — fall back to the standard invoice_sent copy so a missing variant row
        // never blocks the send.
        body = await templates.getTemplate("invoice_sent", {
          first_name: firstName,
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
      const restored = await restoreSendClaim(invoiceId, previousStatus, claimed, consumedQueuedSendRows, db, invoice.send_claim_token);
      if (restored) await reverseSmsCreditOnFailure();
      return {
        sent: false,
        reason: "template-missing",
        code: "INVOICE_SENT_TEMPLATE_MISSING",
      };
    }

    // Post-delivery finalize, extracted so the delivered-SMS recovery in the
    // catch below can retry it once after a transient DB failure.
    const finalizeInvoiceAfterSms = () => whereSendClaimOwned(
      db("invoices").where({ id: invoiceId }).whereIn("status", SEND_FINALIZABLE_STATUSES),
      invoice.send_claim_token,
    ).update({
        status: db.raw(
          "CASE WHEN status IN ('draft', 'scheduled', 'sending') THEN 'sent' ELSE status END",
        ),
        sent_at: new Date(),
        sms_sent_at: new Date(),
        scheduled_send_at: null,
        scheduled_send_error: require("./invoice-helpers").preserveWithdrawalStamp(db),
        scheduled_request_review: false,
        scheduled_review_delay_minutes: null,
        updated_at: new Date(),
      });
    // Keep a direct SMS's episode identity through post-delivery bookkeeping.
    // A retry can finish that work when PostgreSQL committed the finalize but
    // the acknowledgement was lost; a later explicit resend may supersede the
    // token, in which case this episode's exact-token writes become no-ops.
    // Nested SMS leaves release to the combined SMS+email finalizer.
    const releaseDirectSmsClaim = async () => {
      if (allowClaimed) return;
      try {
        await whereSendClaimOwned(
          db("invoices").where({ id: invoiceId }),
          invoice.send_claim_token,
        ).update({ send_claim_token: null, updated_at: new Date() });
      } catch (err) {
        // The provider already accepted the SMS and terminal bookkeeping has
        // run. A failed cleanup acknowledgement must not turn that delivery
        // into a failed send or invite an automatic replay.
        logger.error(`[invoice] SMS delivered for ${invoice.invoice_number} but send-claim cleanup failed: ${err.message}`);
      }
    };
    // Flips the moment the provider accepts the message. Everything after
    // that point is bookkeeping — its failure must never be reported as a
    // failed SEND (the UI reads a restored 'draft' as "provably unsent" and
    // offers Resend, duplicating a text the customer already received).
    let smsDelivered = false;
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
      const sendInvoice = await db("invoices").where({ id: invoiceId }).first();
      await require("./estimate-deposits").assertInvoiceDepositSettlementReady(db, sendInvoice, { lock: false });
      await fenceAdoptedRowsBeforeHandoff(consumedQueuedSendRows, invoice.send_claim_token);
      const sendResult = await sendCustomerMessage({
        to: customer.phone,
        body,
        channel: "sms",
        audience: "customer",
        purpose: "payment_link",
        customerId: customer.id,
        invoiceId,
        entryPoint: "invoice_send_via_sms",
        // Send-window operator marker: this shared path serves both the
        // admin send click and automated resends — only the authenticated
        // routes pass operatorInitiated (see validators/send-window.js).
        ...(operatorInitiated ? { operatorInitiated: true } : {}),
        // Preserve the legacy messageType so the admin-sms-templates
        // 'invoice' template kill switch (invoice → invoice_sent) still
        // applies. If ops disables the invoice template to halt broken
        // billing texts, this flow needs to stop too.
        metadata: { original_message_type: "invoice" },
        // The canonical sender owns push-first / push+SMS / Twilio routing.
        // Wrap that ONE provider dispatcher so the invoice row and estimate
        // deposit ledger stay stable through whichever delivery leg it picks.
        // The canonical message audit runs after this callback commits.
        withProviderHandoff: async (dispatch) => {
          let dispatchedOutcome = null;
          let providerStarted = false;
          try {
            const outcome = await require("./estimate-deposits").withInvoiceDepositSettlement(
              invoiceId,
              async (trx, current) => {
                if (current.send_claim_token !== invoice.send_claim_token
                  || !SEND_FINALIZABLE_STATUSES.includes(current.status)) {
                  return { sent: false, blocked: true, deliveryOutcome: "not_sent",
                    code: "send_claim_lost", error: "Invoice send claim changed; delivery not attempted",
                    validator: "check_invoice_send_claim" };
                }
                const scheduledServiceId = await linkedScheduledServiceId(current, trx);
                const terminalVisit = await require("./invoice-helpers")
                  .visitRefusesSettlement(trx, scheduledServiceId);
                if (terminalVisit) {
                  return { sent: false, blocked: true, deliveryOutcome: "not_sent",
                    code: "INVOICE_VISIT_TERMINAL", error: `Linked visit is ${terminalVisit}; delivery not attempted`,
                    validator: "check_invoice_visit_status" };
                }
                const ownership = await require("./invoice-helpers").selfPayAtDispatch(invoiceId, trx)();
                if (ownership.ok !== true) {
                  return { sent: false, blocked: true, deliveryOutcome: "not_sent",
                    code: ownership.code, error: ownership.reason, validator: "check_invoice_ownership_boundary" };
                }
                if (invoiceAmountDue(current) <= 0
                  || invoiceAmountDue(current) !== invoiceAmountDue(sendInvoice)
                  || !isDeepStrictEqual(parseInvoiceLineItems(current.line_items), parseInvoiceLineItems(sendInvoice.line_items))) {
                  return { sent: false, blocked: true, deliveryOutcome: "not_sent",
                    code: "INVOICE_BALANCE_CHANGED", error: "Invoice balance changed while preparing delivery; retry send",
                    validator: "check_invoice_deposit_settlement" };
                }
                providerStarted = true;
                dispatchedOutcome = await dispatch();
                return dispatchedOutcome;
              },
            );
            return outcome || { sent: false, blocked: true, deliveryOutcome: "not_sent",
              code: "INVOICE_UNREADABLE", error: "Invoice could not be re-read before delivery",
              validator: "check_invoice_deposit_settlement" };
          } catch (err) {
            // A commit/connection error AFTER provider acceptance cannot be
            // rewritten as a definite non-send: that would restore the send
            // claim and offer an automatic retry of a message the customer
            // already received. Preserve the provider's actual provenance;
            // normal delivered bookkeeping below remains idempotent.
            if (dispatchedOutcome
              && (dispatchedOutcome.sent || dispatchedOutcome.deliveryOutcome !== "not_sent")) {
              logger.error(`[invoice] Provider outcome known for ${invoiceId} but deposit-settlement handoff could not close: ${err.message}`);
              return { ...dispatchedOutcome, settlementHandoffError: err.message };
            }
            if (providerStarted) {
              return { sent: false, blocked: true, deliveryOutcome: "uncertain",
                code: err.code || "INVOICE_PROVIDER_OUTCOME_UNCERTAIN", error: err.message,
                retryable: false, validator: "check_invoice_deposit_settlement" };
            }
            return { sent: false, blocked: true, deliveryOutcome: "not_sent",
              code: err.code || "INVOICE_DEPOSIT_SETTLEMENT_FAILED", error: err.message,
              retryable: err.retryable === true, validator: "check_invoice_deposit_settlement" };
          }
        },
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
        err.deliveryOutcome = sendResult.deliveryOutcome;
        // Send-window deferral contract: a QUIET_HOURS_HOLD is "try again at
        // 8 AM", not a delivery failure — carry the hold metadata so
        // sendViaSMSAndEmail / processScheduledSends can reschedule instead
        // of burning one of the five generic scheduled-send attempts. The
        // rendered body + recipient ride along so a direct (non-scheduled)
        // caller can requeue the exact pay-link text on the scheduled rail.
        if (sendResult.deferred) err.deferred = true;
        if (sendResult.nextAllowedAt) err.nextAllowedAt = sendResult.nextAllowedAt;
        if (sendResult.retryAfterMs) err.retryAfterMs = sendResult.retryAfterMs;
        err.smsBody = body;
        err.toPhone = customer.phone;
        throw err;
      }

      smsDelivered = true;
      const finalized = await finalizeInvoiceAfterSms();
      if (!finalized) return { sent: true, payUrl, claimLost: true };

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
        await convertLeadOnInvoiceSent({ invoiceId, customerId: invoice.customer_id, priorStatus: previousStatus, priorDelivered: Boolean(invoice.sent_at || invoice.sms_sent_at) });
        // Invoice issued ⇒ visit completed (owner ruling 2026-09-07, dark
        // behind GATE_INVOICE_ISSUED_CLOSES_VISIT). DIRECT SMS-only sends
        // (admin batch, AI assistant, collections) own it here; when
        // sendViaSMSAndEmail drives this leg (allowClaimed) the wrapper owns
        // it after both legs, so the closeout runs once per delivery.
        const { closeOutVisitForIssuedInvoice } = require("./invoice-issued-closeout");
        await closeOutVisitForIssuedInvoice({ invoiceId, trigger: "sent", actorTechnicianId });
      }

      const queueOutcome = await resolveAdoptedRowsAfterDelivery(invoiceId, invoice.send_claim_token, consumedQueuedSendRows, invoice.invoice_number);
      await releaseDirectSmsClaim();

      return { sent: true, payUrl, ...queueOutcome };
    } catch (err) {
      err.deliveryOutcome ||= err.providerOutcome?.deliveryOutcome;
      if (smsDelivered) {
        // The customer HAS the pay-link text — this is a post-delivery
        // bookkeeping failure (invoice finalize, follow-up scheduling, lead
        // conversion), NOT a failed send. Restoring the claim to draft here
        // would make the UI's "still draft ⇒ provably unsent ⇒ offer
        // Resend" check duplicate a delivered SMS, and reversing the credit
        // would refund a message that went out. Retry the finalize once;
        // if it still fails, leave the 'sending' claim in place — the
        // stale-claim recovery in processScheduledSends PARKS such rows for
        // operator review (delivery unverified, no automatic resend) — and
        // report the send as delivered.
        logger.error(
          `[invoice] SMS DELIVERED for ${invoice.invoice_number} but post-delivery bookkeeping failed: ${err.message} — retrying finalize`,
        );
        try {
          const finalized = await finalizeInvoiceAfterSms();
          if (!finalized) return { sent: true, payUrl, claimLost: true, finalizeError: err.message };
        } catch (retryErr) {
          logger.error(
            `[invoice] finalize retry failed for ${invoice.invoice_number}: ${retryErr.message} — row left under its send claim; do NOT auto-resend`,
          );
          return { sent: true, payUrl, finalizeError: err.message };
        }
        // Finalize is durable — run the normal post-delivery bookkeeping
        // (each leg best-effort/idempotent, mirroring the happy path) so a
        // recovered send still gets its collection follow-ups, audit line,
        // and lead conversion instead of silently losing them.
        try {
          await require("./invoice-followups").scheduleForInvoice(invoiceId);
        } catch (e) {
          logger.error(`[invoice-followups] scheduleForInvoice failed (post-recovery): ${e.message}`);
        }
        await db("activity_log")
          .insert({
            customer_id: invoice.customer_id,
            action: "invoice_sent",
            description: `Invoice ${invoice.invoice_number} sent via SMS: $${invoiceAmountDue(invoice)}`,
            metadata: JSON.stringify({ invoiceId, payUrl }),
          })
          .catch(() => {});
        if (!allowClaimed) {
          try {
            await convertLeadOnInvoiceSent({ invoiceId, customerId: invoice.customer_id, priorStatus: previousStatus, priorDelivered: Boolean(invoice.sent_at || invoice.sms_sent_at) });
          } catch (e) {
            logger.error(`[invoice] lead conversion failed (post-recovery) for ${invoice.invoice_number}: ${e.message}`);
          }
          // A recovered send is a durable send (GitHub r1 P1): the customer
          // has the pay link and the finalize committed, so the linked visit
          // closes out here exactly as on the happy path — otherwise the
          // invoice is sent while its visit stays open, the state this gate
          // exists to end.
          try {
            const { closeOutVisitForIssuedInvoice } = require("./invoice-issued-closeout");
            await closeOutVisitForIssuedInvoice({ invoiceId, trigger: "sent", actorTechnicianId });
          } catch (e) {
            logger.error(`[invoice] issued-invoice closeout failed (post-recovery) for ${invoice.invoice_number}: ${e.message}`);
          }
        }
        const queueOutcome = await resolveAdoptedRowsAfterDelivery(invoiceId, invoice.send_claim_token, consumedQueuedSendRows, invoice.invoice_number);
        await releaseDirectSmsClaim();
        if (queueOutcome.queueResolutionError) return { sent: true, payUrl, finalizeError: err.message, ...queueOutcome };
        return { sent: true, payUrl, finalizeError: err.message };
      }
      if (claimed && err.code === "INVOICE_VISIT_TERMINAL" && err.deliveryOutcome === "not_sent") {
        const scheduledServiceId = await linkedScheduledServiceId(invoice);
        const voided = scheduledServiceId
          ? await InvoiceService.voidOpenInvoicesForCancelledService(scheduledServiceId, {
              invoiceId,
              refusedClaimToken: invoice.send_claim_token,
            })
          : [];
        if (voided.includes(invoiceId)) {
          logger.info(`[invoice] Voided ${invoice.invoice_number} after a definitive terminal-visit SMS refusal`);
          throw err;
        }
        // Exact-token cleanup declined (replacement claim, money/PI fence,
        // reactivated visit, or DB fault). Keep this episode parked for
        // review; restoring it would make a definitely-refused cancelled-job
        // send eligible for dunning or scheduler retries again.
        logger.warn(`[invoice] Terminal-visit SMS refusal for ${invoice.invoice_number} could not be safely voided — claim retained for review`);
        throw err;
      }
      if (err.deliveryOutcome === "uncertain") {
        // The provider request started, but its result is unknown. Preserve
        // this exact claim as the durable do-not-retry marker; restoring the
        // prior status or credit could duplicate a delivered pay link.
        logger.warn(`[invoice] SMS provider outcome is unverified for ${invoice.invoice_number} — claim retained for review`);
        throw err;
      }
      const restored = await restoreSendClaim(invoiceId, previousStatus, claimed, consumedQueuedSendRows, db, invoice.send_claim_token);
      // Provider/Twilio error after we auto-applied credit above — the pay
      // link was never delivered, so return the credit rather than leave it
      // consumed + the invoice edit-locked.
      if (restored) await reverseSmsCreditOnFailure();
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
      claimToken = null,
      firstDeliveryOnly = false,
      overridesReviewHold = false,
      emailRecipientOverride = null,
      payUrlParams = null,
      operatorInitiated = false,
      // The staff user behind an operator send (attribution for the
      // invoice-issued closeout's audit row); null for automated sends.
      actorTechnicianId = null,
      // Internal-only: retries this same call once more after a
      // not_zero_due chokepoint outcome (Codex round-6 P2 #4131) — a real
      // caller never sets this, so a race can retry at most once.
      _zeroDueRetried = false,
    } = {},
  ) {
    const retryOnce = () => this.sendViaSMSAndEmail(invoiceId, {
      requestReview, reviewDelayMinutes, allowClaimed, claimToken, firstDeliveryOnly, overridesReviewHold,
      emailRecipientOverride, payUrlParams, operatorInitiated, actorTechnicianId, _zeroDueRetried: true,
    });
    // Phase 2: an accrued invoice (on a payer statement) is never delivered
    // individually. Refuse BEFORE claiming/applying credit so we don't flip its
    // status to 'sending'. (sendInvoiceEmail also fails closed; this is the early gate.)
    const accrualPre = await db("invoices").where({ id: invoiceId }).first("payer_statement_id", "visit_completion_packet_id", "payer_id");
    if (accrualPre?.payer_statement_id) {
      return { ok: false, error: "Invoice is billed on the payer’s monthly statement; not sent individually.", sms: { ok: false }, email: { ok: false } };
    }
    // A combined-visit invoice minted self-pay claims its send under held
    // customer and billed-member rows with a live Bill-To recheck (see
    // claimPacketInvoiceForSend); a payer assigned since scheduling owns the
    // debt, so the homeowner never receives the pay link. Either claim path
    // below can throw zero_due_detected (Codex round-5 #4131) — the ONE
    // chokepoint, settleZeroDueBeforeSend, resolves what actually happened
    // (it runs the SAME packet ownership fence first on its own, so a live
    // payer withdrawal still always wins over a zero-due settlement) and
    // this wrapper maps its descriptor to its own result shape.
    let packetClaim = null;
    if (accrualPre?.visit_completion_packet_id && !accrualPre.payer_id) {
      try {
        packetClaim = await claimPacketInvoiceForSend(invoiceId, accrualPre.visit_completion_packet_id, { allowClaimed, claimToken, firstDeliveryOnly, overridesReviewHold, adoptsQueuedInvoiceSend: true });
      } catch (err) {
        const zeroDueResult = await zeroDueWrapperOutcomeIfDetected(invoiceId, err, allowClaimed, _zeroDueRetried ? null : retryOnce);
        if (zeroDueResult) return zeroDueResult;
        // The scheduled-send worker already fenced and claimed this send; a
        // transient failure of the re-judge here left no provider request
        // behind, so the invoice goes back to its queue slot instead of
        // sitting in 'sending' until stale-claim recovery strands it.
        if (!allowClaimed) throw err;
        await restoreSendClaim(invoiceId, "scheduled", true, [], db, claimToken);
        logger.warn(`[invoice] Bill-To re-judge failed for ${invoiceId} — send left queued: ${err.message}`);
        return { ok: false, error: `Bill-To check failed: ${err.message}`, code: "bill_to_fence_failed",
          sms: { ok: false, code: "bill_to_fence_failed" }, email: { ok: false, code: "bill_to_fence_failed" } };
      }
    }
    if (packetClaim?.payerBilled) {
      return { ok: false, error: "Suppressed — the visit is now billed to a third-party payer", code: "payer_billed",
        sms: { ok: false, code: "payer_billed" }, email: { ok: false, code: "payer_billed" } };
    }
    // Claim FIRST, then apply credit. Applying before the claim strands credit when
    // two sends race: the loser draws down the balance, but the winner already owns
    // the 'sending' row — reverseAppliedCredit refuses 'sending', so the loser can't
    // undo its apply, and the winner sees applied=0 (balance already consumed) and
    // never reverses it either, leaving an undelivered, edit-locked invoice with
    // credit_applied set. Claiming first means a lost race throws here before any
    // credit is drawn down — nothing to reverse.
    let claim;
    try {
      claim = packetClaim ? packetClaim.claim : await claimInvoiceForSend(invoiceId, { allowClaimed, claimToken, firstDeliveryOnly, overridesReviewHold, adoptsQueuedInvoiceSend: true });
    } catch (err) {
      const zeroDueResult = await zeroDueWrapperOutcomeIfDetected(invoiceId, err, allowClaimed, _zeroDueRetried ? null : retryOnce);
      if (zeroDueResult) return zeroDueResult;
      throw err;
    }
    const consumedQueuedSendRows = claim.consumedQueuedSendRows || [];
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
      // Resolve the adopted rows while the token still owns the row — the
      // resolution is token-scoped and would be a silent no-op after the
      // clear below.
      const queueOutcome = await resolveAdoptedRowsAfterDelivery(invoiceId, claim.invoice.send_claim_token, consumedQueuedSendRows, claim.invoice.invoice_number);
      const cleared = await db("invoices")
        .where({ id: invoiceId, send_claim_token: claim.invoice.send_claim_token })
        .update({ send_claim_token: null, updated_at: new Date() });
      if (!cleared) {
        return { ok: false, code: "send_claim_lost", error: "Invoice send claim changed; delivery not attempted",
          sms: { ok: false, code: "send_claim_lost" }, email: { ok: false, code: "send_claim_lost" } };
      }
      await enrollPacketReviewAfterCredit(invoiceId, accrualPre?.visit_completion_packet_id);
      return {
        ok: true,
        covered_by_credit: true,
        sms: { ok: false, code: "covered_by_credit" },
        email: { ok: false, code: "covered_by_credit" },
        payUrl: null,
        ...queueOutcome,
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
        // The nested call does not adopt (adoptsQueuedInvoiceSend: false
        // below), so this wrapper fences the rows it adopted itself before
        // the provider sees the text. A throw here is pre-provider: the
        // SMS leg reports a definite non-delivery and the rows restore.
        await fenceAdoptedRowsBeforeHandoff(consumedQueuedSendRows, claim.invoice.send_claim_token);
        const smsResult = await this.sendViaSMS(invoiceId, {
          allowClaimed: true,
          claimToken: claim.invoice.send_claim_token,
          payUrlParams,
          operatorInitiated,
          // This wrapper's own claim above already adopted (and will
          // restore/resolve) any queued pay-link SMS this send supersedes —
          // the nested claim must not adopt it a second time.
          adoptsQueuedInvoiceSend: false,
        });
        if (smsResult?.payUrl) payUrl = smsResult.payUrl;
        if (smsResult?.settled_zero_due) {
          // Defensive mirror of the covered_by_credit shape above:
          // settleZeroDueBeforeSend's own 'sending' guard (inside
          // settleZeroBalance) means the nested preclaimed sendViaSMS call
          // cannot currently reach this outcome (it can only ever report
          // deposit_settlement_pending there), but a resolved, non-throwing
          // success must never be read as an ordinary SMS failure by the
          // generic branch below if that ever changes (Codex round-5 #4131).
          return { ok: true, settled_zero_due: true,
            sms: { ok: false, code: "settled_zero_due" }, email: { ok: false, code: "settled_zero_due" },
            payUrl: payUrl || null };
        }
        if (smsResult?.code === "deposit_settlement_pending") {
          // Promote the SMS leg's pending code to the wrapper result
          // (Codex round-6 P2 #4131): the nested preclaimed sendViaSMS
          // call resolves this refusal on ITS OWN leg only — copying it
          // into sms.code alone let it disappear at the top level (no
          // promoted-code branch below recognizes it), so /:id/send fell
          // through to a generic 400 instead of the 409 the RESOLVED
          // pre-claim path already gives this exact code, and the batch
          // routes counted it failed instead of held. Skip the email leg
          // too — nothing is due to email either.
          //
          // This wrapper still owns the OUTER claim (the nested call was
          // told adoptsQueuedInvoiceSend: false and never touches it) — the
          // nested leg resolving on its own claim doesn't release ours, so
          // restore it here exactly like every other early exit does
          // (round-10 #4634 P1: without this the invoice was left
          // 'sending' until stale-claim recovery parked it).
          const restored = await restoreSendClaim(invoiceId, previousStatus, claimed, consumedQueuedSendRows, db, claim.invoice.send_claim_token);
          // Round-11 #4634 P1: this retryable early return can follow a
          // PARTIAL autoApplyAccountCreditIfEnabled apply above (~4211) —
          // same failure shape as the generic path at ~4622, so reverse it
          // the same way. Reverse ONLY when we own the claim (restored &&
          // !allowClaimed): a preclaimed scheduled send leaves the row
          // 'sending', where reverseAppliedCredit refuses, and the worker
          // reverses off creditApplied below after its own restore instead
          // (~5231) — report creditApplied unconditionally so that read works.
          if (restored && !allowClaimed && sendCreditResult?.applied > 0) {
            try {
              const { reverseAppliedCredit } = require("./customer-credit");
              await reverseAppliedCredit({ invoiceId, amount: sendCreditResult.applied, createdBy: "system:send_retry_deposit_pending" });
            } catch (e) {
              logger.warn(`[invoice] credit reversal after deposit_settlement_pending retry skipped for ${invoiceId}: ${e.message}`);
            }
          }
          return { ok: false, code: "deposit_settlement_pending", error: smsResult.reason,
            sms: { ok: false, code: "deposit_settlement_pending", deliveryOutcome: "not_sent" },
            email: { ok: false, code: "deposit_settlement_pending" },
            payUrl: payUrl || null,
            creditApplied: sendCreditResult?.applied || 0 };
        }
        // Codex round-8 audit P2 (#4131 slice 4): same promotion, for the
        // nested preclaimed sendViaSMS call's OTHER resolved zero-due
        // refusal — a locked re-read that found the balance genuinely
        // positive again. Without this branch the code fell through to the
        // generic sms.code copy below, which no top-level branch recognizes,
        // so /:id/send returned a bare 400 and /batch/send counted a
        // genuinely retryable race as a failure instead of the SAME 409/held
        // treatment the RESOLVED direct-call path already gives this code.
        // Skip the email leg too — nothing is due to email either.
        //
        // Same outer-claim restore as deposit_settlement_pending above
        // (round-10 #4634 P1) — this early return bypassed it too, leaving
        // the invoice 'sending' with scheduled_send_at cleared until
        // stale-claim recovery parked it.
        if (smsResult?.code === "balance_changed_retry") {
          const restored = await restoreSendClaim(invoiceId, previousStatus, claimed, consumedQueuedSendRows, db, claim.invoice.send_claim_token);
          // Round-11 #4634 P1: same gap as deposit_settlement_pending above —
          // a PARTIAL autoApplyAccountCreditIfEnabled apply (~4211) survived
          // this retryable early return with nothing to reverse it and no
          // creditApplied on the result for the scheduled worker's own
          // reversal (~5231) to read. Same posture as the generic failure
          // path at ~4622: reverse locally only when we own the claim
          // (restored && !allowClaimed) — a preclaimed send leaves the row
          // 'sending' (reverseAppliedCredit refuses it there; the worker
          // reverses after its own restore instead) — and report
          // creditApplied unconditionally either way.
          if (restored && !allowClaimed && sendCreditResult?.applied > 0) {
            try {
              const { reverseAppliedCredit } = require("./customer-credit");
              await reverseAppliedCredit({ invoiceId, amount: sendCreditResult.applied, createdBy: "system:send_retry_balance_changed" });
            } catch (e) {
              logger.warn(`[invoice] credit reversal after balance_changed_retry retry skipped for ${invoiceId}: ${e.message}`);
            }
          }
          return { ok: false, code: "balance_changed_retry", error: smsResult.reason,
            sms: { ok: false, code: "balance_changed_retry", deliveryOutcome: "not_sent" },
            email: { ok: false, code: "balance_changed_retry" },
            payUrl: payUrl || null,
            creditApplied: sendCreditResult?.applied || 0 };
        }
        if (smsResult?.sent) {
          sms.ok = true;
        } else {
          sms.error = smsResult?.reason || smsResult?.code || "SMS not sent";
          if (smsResult?.code) sms.code = smsResult.code;
          // The zero-due chokepoint's terminal/refused shapes carry
          // deliveryOutcome on a RESOLVED result (not just a thrown one) —
          // the deep provider-dispatch INVOICE_VISIT_TERMINAL check further
          // down keys on sms.deliveryOutcome === 'not_sent' to route this
          // exact code to its own void + credit-restore cleanup (Codex
          // round-5 #4131).
          if (smsResult?.deliveryOutcome) sms.deliveryOutcome = smsResult.deliveryOutcome;
        }
      } catch (err) {
        sms.error = err.message;
        if (err.code) sms.code = err.code;
        if (err.deliveryOutcome) sms.deliveryOutcome = err.deliveryOutcome;
        // Preserve the send-window hold so callers with a retry rail
        // (processScheduledSends) can move the due time to the window open
        // instead of treating the hold as a spent delivery attempt.
        if (err.deferred) sms.deferred = true;
        if (err.nextAllowedAt) sms.nextAllowedAt = err.nextAllowedAt;
        if (err.retryAfterMs) sms.retryAfterMs = err.retryAfterMs;
        if (err.smsBody) sms.heldBody = err.smsBody;
        if (err.toPhone) sms.heldToPhone = err.toPhone;
      }
    }

    // DIRECT callers (estimate acceptance/conversion, admin resends —
    // anything not on the scheduled queue): the email leg below finalizes
    // the invoice, which clears every retry hook, so a held SMS pay link
    // must be persisted on the scheduled-SMS rail FIRST or the customer
    // never receives it. The queued row replays the exact rendered body at
    // 8:00 AM under the same payment_link policy. Scheduled callers
    // (allowClaimed) skip this — their whole send defers below instead.
    if (!allowClaimed
      && ["QUIET_HOURS_HOLD", "PUSH_IN_FLIGHT", "APP_DELIVERY_HOLD", "APP_PROVIDER_RETRY"].includes(sms.code)
      && sms.deliveryOutcome !== "uncertain"
      && sms.deferred
      && sms.nextAllowedAt
      && sms.heldBody
      && sms.heldToPhone) {
      try {
        // Retry-idempotent: when the email leg fails, this method restores
        // the send claim and callers legitimately retry — a second pass
        // must adopt the already-queued row, not enqueue a duplicate that
        // double-texts the pay link at 8:00 AM.
        const existingQueued = await db("sms_log")
          .whereIn("status", ["scheduled", "sending"])
          .whereRaw("metadata->>'entry_point' = 'invoice_send_deferred'")
          .whereRaw("metadata->>'invoice_id' = ?", [String(invoiceId)])
          .first("id");
        if (existingQueued) {
          sms.scheduled = true;
          logger.info(`[invoice] Pay-link SMS for invoice ${invoiceId} already queued for the window open (${existingQueued.id}) — not re-queued`);
        } else {
          const TWILIO_NUMBERS = require("../config/twilio-numbers");
          await db("sms_log").insert({
            customer_id: claim.invoice.customer_id,
            direction: "outbound",
            from_phone: TWILIO_NUMBERS.getOutboundNumber(),
            to_phone: sms.heldToPhone,
            message_body: sms.heldBody,
            status: "scheduled",
            scheduled_for: new Date(sms.nextAllowedAt),
            message_type: "invoice",
            metadata: JSON.stringify({
              entry_point: "invoice_send_deferred",
              invoice_id: invoiceId,
              original_block_code: sms.code,
              replay_purpose: "payment_link",
              refresh_customer_phone: true,
              resolve_from_by_customer: true,
              // Delivery-time finalization (executor → markDeliverySent):
              // when the email leg ALSO failed, this queued row is the only
              // delivery, and without the flip the morning SMS would carry
              // a live pay link while the invoice sits in draft with
              // follow-ups unarmed. Idempotent when the email leg DID
              // finalize (markDeliverySent no-ops on non-finalizable
              // status / leaves 'sent' unchanged).
              mark_invoice_delivery: true,
            }),
          });
          sms.scheduled = true;
          logger.info(`[invoice] Pay-link SMS for invoice ${invoiceId} held outside the 8AM-8PM ET send window — queued for ${sms.nextAllowedAt}`);
        }
      } catch (queueErr) {
        // The scheduled rail does NOT own the held text — the email leg
        // below must not run: its success would finalize the invoice and
        // clear the send claim, permanently losing the requested SMS
        // pay-link leg. Failing the whole send keeps the claim
        // restorable, and the caller's retry adopts the queued row (or
        // re-queues) via the idempotent lookup above.
        sms.holdUnowned = true;
        logger.error(`[invoice] Held pay-link SMS requeue FAILED for invoice ${invoiceId}: ${queueErr.message} — deferring the whole send (email leg skipped) so the claim stays retryable`);
      }
    }
    delete sms.heldBody;
    delete sms.heldToPhone;

    // A send-window hold on a SCHEDULED delivery defers the WHOLE send: a
    // successful email here would make `ok` true, finalize the invoice and
    // clear scheduled_send_at — stranding the held SMS pay link with no
    // retry rail. Skipping the email leg keeps ok=false, so
    // processScheduledSends moves the due time to nextAllowedAt and both
    // legs go out together at 8:00 AM. Direct callers (estimate-accept
    // night sends, admin resends) are NOT deferred: their documented
    // gate-ON behavior is email-immediate with the SMS leg held.
    const scheduledSmsHeld = allowClaimed
      && ["QUIET_HOURS_HOLD", "PUSH_IN_FLIGHT", "APP_DELIVERY_HOLD", "APP_PROVIDER_RETRY"].includes(sms.code)
      && Boolean(sms.nextAllowedAt);
    const terminalSmsRefusal = sms.code === "INVOICE_VISIT_TERMINAL"
      && sms.deliveryOutcome === "not_sent";
    if (terminalSmsRefusal) {
      // The locked SMS boundary proved the linked visit terminal before any
      // provider request. Do not start a second channel for the same invalid
      // invoice; the outer claim owner can now make one safe cleanup decision.
      email.error = "Linked visit is terminal; email delivery not attempted";
      email.code = "INVOICE_VISIT_TERMINAL";
      email.deliveryOutcome = "not_sent";
    } else if (scheduledSmsHeld || sms.holdUnowned) {
      email.error = sms.holdUnowned
        ? "Held SMS pay link could not be queued — whole send deferred so the claim stays retryable"
        : "Deferred with the held SMS leg — outside 8AM-8PM ET send window";
      email.code = sms.code;
    } else {
      try {
        const r = await sendInvoiceEmail(invoiceId, {
          recipientOverride: emailRecipientOverride,
          payUrlParams,
          claimToken: claim.invoice.send_claim_token,
        });
        if (r?.ok) email.ok = true;
        else if (r?.error) email.error = r.error;
        if (r?.code) email.code = r.code;
        if (r?.deliveryOutcome) email.deliveryOutcome = r.deliveryOutcome;
        if (!payUrl && r?.payUrl) payUrl = r.payUrl;
        if (r?.recipient) email.recipient = r.recipient;
        if (r?.messageId) email.messageId = r.messageId;
      } catch (err) {
        email.error = err.message;
      }
    }

    const ok = sms.ok || email.ok;
    // An adopted queued pay-link text is discharged by the SMS leg's OWN
    // outcome only: provider acceptance or a replacement on the scheduled
    // rail. Email success says nothing about it — a definite SMS failure
    // beside a delivered email must give the original queued text back
    // (before finalize clears the token) or the customer never receives it;
    // an uncertain SMS outcome leaves the adopted rows pending for review.
    const smsObligationDischarged = sms.ok === true || sms.scheduled === true;
    const smsDefinitelyNotSent = (sms.deliveryOutcome === "not_sent" && sms.scheduled !== true)
      || (claim.invoice?.payer_id && sms.code === "payer_billed");
    const terminalVisitRefused = !ok
      && smsDefinitelyNotSent
      && email.code === "INVOICE_VISIT_TERMINAL"
      && email.deliveryOutcome === "not_sent";
    const terminalVisitObserved = !ok && (sms.code === "INVOICE_VISIT_TERMINAL"
      || email.code === "INVOICE_VISIT_TERMINAL");
    const deliveryOutcomeUncertain = !ok && (sms.deliveryOutcome === "uncertain"
      || email.deliveryOutcome === "uncertain");
    let ownedDeliveryFinalized = false;
    let queueOutcome = {};
    let adoptedQueueUnrestored = false;
    // Codex round-8 audit P1 (#4131 slice 4): defaults to voided=true for the
    // !claimed (preclaimed) branch below, which never attempts a void here —
    // processScheduledSends owns that cleanup independently (own comment a
    // few lines down) and always re-verifies its OWN void result before
    // reporting terminal to its caller, so this function's code is advisory
    // there. Only the `claimed` branch's own void attempt can prove false.
    let terminalVisitVoided = true;
    if (ok) {
      // Settle the adopted rows BEFORE the finalize below clears
      // send_claim_token — both the resolve and the restore are token-scoped
      // so they can never touch a queue row this claim episode didn't adopt.
      if (smsObligationDischarged) {
        queueOutcome = await resolveAdoptedRowsAfterDelivery(invoiceId, claim.invoice.send_claim_token, consumedQueuedSendRows, claim.invoice.invoice_number);
      } else if (sms.deliveryOutcome === "uncertain") {
        if (consumedQueuedSendRows.length) logger.warn(`[invoice] SMS outcome unverified for ${claim.invoice.invoice_number} — adopted queued text left pending for review`);
      } else if (consumedQueuedSendRows.length) {
        const queueRestored = await restoreSendClaim(invoiceId, previousStatus, false, consumedQueuedSendRows, db, claim.invoice.send_claim_token);
        if (!queueRestored) {
          // The customer's queued text is still cancelled (its pending
          // marker keeps it re-adoptable) and nothing automatic will send
          // it. Same posture as a post-delivery bookkeeping failure: keep
          // the 'sending' claim instead of finalizing, so stale-claim
          // recovery in processScheduledSends PARKS the invoice for operator
          // review and the operator's resend re-adopts the row.
          adoptedQueueUnrestored = true;
          logger.error(`[invoice] Could not give back the adopted queued pay-link text for ${claim.invoice.invoice_number} after an email-only delivery — claim retained for review`);
        }
      }
      if (!adoptedQueueUnrestored) {
        const finalized = await whereSendClaimOwned(
          db("invoices").where({ id: invoiceId }).whereIn("status", SEND_FINALIZABLE_STATUSES),
          claim.invoice.send_claim_token,
        )
          .update({
            status: db.raw(
              "CASE WHEN status IN ('draft', 'scheduled', 'sending') THEN 'sent' ELSE status END",
            ),
            sent_at: new Date(),
            scheduled_send_at: null,
            scheduled_send_error: require("./invoice-helpers").preserveWithdrawalStamp(db),
            scheduled_request_review: false,
            scheduled_review_delay_minutes: null,
            send_claim_token: null,
            updated_at: new Date(),
          });
        ownedDeliveryFinalized = finalized !== 0;
        // First send finalized on SMS and/or email — convert the originating lead.
        // Covers the email-only case the inner sendViaSMS hook can't (it skips when
        // allowClaimed). Resend-safe via the priorStatus gate.
        if (ownedDeliveryFinalized) {
          await convertLeadOnInvoiceSent({ invoiceId, customerId: claim.invoice.customer_id, priorStatus: previousStatus, priorDelivered: Boolean(claim.invoice.sent_at || claim.invoice.sms_sent_at) });
        }
        // Arm/re-arm follow-ups on ANY successful channel (Codex #3493 r5):
        // the inner sendViaSMS hook only runs on SMS success, so an
        // email-only delivery finalized here armed nothing — a fresh invoice
        // got no dunning, and an unvoided one stayed under its
        // 'invoice_voided' stop forever. Idempotent when the SMS leg already
        // scheduled (existing rows are returned unchanged; the void-stop
        // re-arm is conditional).
        if (ownedDeliveryFinalized) {
          try {
            await require("./invoice-followups").scheduleForInvoice(invoiceId);
          } catch (e) {
            logger.error(`[invoice-followups] scheduleForInvoice failed (post-send finalize): ${e.message}`);
          }
        }
      }
    } else if (terminalVisitRefused) {
      if (claimed) {
        const scheduledServiceId = await linkedScheduledServiceId(claim.invoice);
        const voided = scheduledServiceId
          ? await InvoiceService.voidOpenInvoicesForCancelledService(scheduledServiceId, {
              invoiceId,
              refusedClaimToken: claim.invoice.send_claim_token,
            })
          : [];
        terminalVisitVoided = voided.includes(invoiceId);
        if (!terminalVisitVoided) {
          logger.warn(`[invoice] Terminal-visit combined refusal for ${claim.invoice.invoice_number} could not be safely voided — claim retained for review`);
        }
      }
      // A pre-claimed scheduled send is owned by processScheduledSends; it
      // performs the same exact-token terminal cleanup. Neither owner may
      // restore/reverse here and turn a cancelled-job send retryable again.
    } else if (terminalVisitObserved) {
      // One channel proved the visit terminal, but the other channel's
      // provider outcome is not a definite non-send. Preserve the claim as
      // delivery-unverified evidence; neither restore nor destructive void is
      // licensed until an operator resolves the ambiguous channel.
      logger.warn(`[invoice] Terminal visit detected for ${claim.invoice.invoice_number} with an unverified sibling-channel outcome — claim retained for review`);
    } else if (deliveryOutcomeUncertain) {
      logger.warn(`[invoice] Delivery outcome is unverified for ${claim.invoice.invoice_number} — claim retained for review`);
    } else {
      // A replacement already sits on the scheduled rail (quiet-hours hold
      // met again): the adopted rows are discharged by it, and restoring
      // them too would queue the same pay link twice.
      let rowsToRestore = consumedQueuedSendRows;
      if (smsObligationDischarged && consumedQueuedSendRows.length) {
        rowsToRestore = [];
        queueOutcome = await resolveAdoptedRowsAfterDelivery(invoiceId, claim.invoice.send_claim_token, consumedQueuedSendRows, claim.invoice.invoice_number);
      }
      const restored = await restoreSendClaim(
        invoiceId,
        previousStatus,
        claimed,
        rowsToRestore,
        db,
        claim.invoice.send_claim_token,
      );
      // Adopted rows that could not be given back (restore failed, or the
      // claim was no longer ours to restore under) leave the customer's
      // text cancelled with only its pending marker. Report a hold instead
      // of an ordinary failure so a preclaimed scheduled-send worker keeps
      // its claim (stale-claim recovery parks it for review) rather than
      // requeueing a second send over an unrestored text.
      adoptedQueueUnrestored = !restored && rowsToRestore.length > 0;
      // No channel delivered — reverse the credit this seam auto-applied before
      // the send so we don't consume the customer's credit and edit-lock an
      // invoice whose pay link never went out. Reverse ONLY when WE own the claim:
      // for a pre-claimed (allowClaimed) scheduled send, restoreSendClaim is a
      // no-op and the row is still 'sending', so reverseAppliedCredit would refuse
      // — the caller (processScheduledSends) restores 'scheduled' then reverses
      // creditApplied from the result.
      if (restored && !allowClaimed && sendCreditResult?.applied > 0) {
        try {
          const { reverseAppliedCredit } = require("./customer-credit");
          await reverseAppliedCredit({ invoiceId, amount: sendCreditResult.applied, createdBy: "system:send_failed" });
        } catch (e) {
          logger.warn(`[invoice] credit reversal after failed send skipped for ${invoiceId}: ${e.message}`);
        }
      }
    }
    // Invoice issued ⇒ visit completed (owner ruling 2026-09-07, dark
    // behind GATE_INVOICE_ISSUED_CLOSES_VISIT): a delivered invoice closes
    // the open visit it bills, quietly. Best-effort after the send — the
    // customer already has the invoice either way.
    let issuedCloseout = null;
    if (ownedDeliveryFinalized) {
      const { closeOutVisitForIssuedInvoice } = require("./invoice-issued-closeout");
      issuedCloseout = await closeOutVisitForIssuedInvoice({ invoiceId, trigger: "sent", actorTechnicianId });
    }
    const { issuedCloseoutOwnsRecord } = require("./invoice-issued-closeout");

    // The review decision waits for the closeout (GitHub r4 P1 #4127): a
    // linked pre-completion invoice has no service_record_id until the
    // closeout writes it, so deciding first would classify it standalone
    // and enroll an at-delivery review ask — the one thing the quiet
    // closeout promises never to send. A closeout that completed the visit
    // suppresses the ask outright (its record froze requestReview: false, so
    // the paid webhook enrolls nothing later either); otherwise the fresh
    // read below sees whatever linkage now stands.
    if (effectiveRequestReview && ownedDeliveryFinalized) {
      try {
        const ReviewService = require("./review-request");
        if (issuedCloseout?.closed) {
          logger.info(`[invoice] Review ask suppressed for invoice ${invoiceId}: the invoice-issued closeout completed visit ${issuedCloseout.visitId} quietly`);
        } else {
          const inv = await db("invoices")
            .where({ id: invoiceId })
            .select("customer_id", "service_record_id", "status")
            .first();
          // Unpaid COMPLETION invoices defer the review ask to payment — the
          // Stripe paid-invoice webhook enrolls then, reading the completion's
          // requestReview intent from the service record. Enrolling here would
          // text a review ask alongside an open pay link (Codex P1, PR #3104
          // r1). Standalone invoices (no service_record_id) keep the legacy
          // at-delivery ask: their operator opt-in has no other trigger (a
          // cash/manual payment never reaches the webhook).
          const deferToPayment = inv
            && inv.service_record_id
            && !["paid", "prepaid"].includes(String(inv.status || ""));
          if (deferToPayment) {
            logger.info(`[invoice] Review ask deferred to payment for invoice ${invoiceId} (unpaid completion invoice)`);
          } else if (inv && await issuedCloseoutOwnsRecord(inv.service_record_id)) {
            // A closeout that committed its record (frozen requestReview:
            // false) but reported closed: false — post-commit failure, or a
            // later send on an already-closed visit — still owns the ask
            // (pre-push P1 r7): the durable provenance decides, not this
            // invocation's return value.
            logger.info(`[invoice] Review ask suppressed for invoice ${invoiceId}: record ${inv.service_record_id} was committed by the invoice-issued closeout`);
          } else if (inv) {
            await ReviewService.enrollPostService({
              customerId: inv.customer_id,
              serviceRecordId: inv.service_record_id || null,
              triggeredBy: "auto",
              delayMinutes: effectiveReviewDelayMinutes,
            });
          }
        }
      } catch (err) {
        logger.error(
          `[invoice] Review request schedule failed: ${err.message}`,
        );
      }
    }
    return { ok, sms, email, payUrl, creditApplied: sendCreditResult?.applied || 0,
      ...queueOutcome,
      ...(adoptedQueueUnrestored ? { code: "ADOPTED_QUEUE_RESTORE_FAILED", deliveryHeld: true } : {}),
      ...(terminalVisitRefused
        ? (terminalVisitVoided
          ? { code: "INVOICE_VISIT_TERMINAL" }
          // Codex round-8 audit P1 (#4131 slice 4): the void sweep declined
          // cleanup (a live PaymentIntent, money in flight, an unverifiable
          // Stripe lookup) — the invoice is still 'sending' for review, not
          // voided/settled. Mirror zeroDueDirectSendOutcome/
          // zeroDueWrapperOutcome's own UNVOIDED code so admin-invoices.js's
          // ONE shared classifier reads this exactly like that sibling path
          // (held for review) instead of a completed no-op.
          : { code: "INVOICE_VISIT_TERMINAL_UNVOIDED" })
        : terminalVisitObserved
          ? { code: "INVOICE_VISIT_TERMINAL_OUTCOME_UNCERTAIN" }
          : deliveryOutcomeUncertain ? { code: "INVOICE_DELIVERY_OUTCOME_UNCERTAIN" } : {}) };
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
      // The operator behind the delivery (GitHub r3 P2 #4127): the
      // invoice-issued closeout below writes them up as the actor of the
      // visit transition; null = an automated finalization (the system).
      actorTechnicianId = null,
      // Claim-scoped finalize (#4131 slice 5, Codex pre-push P1): a caller
      // that took claimInvoiceForSend's ordinary send_claim_token claim for
      // this exact delivery (the payment-failed decline notice) passes its
      // own token here so the finalize UPDATE both requires and releases it
      // atomically — never a separate restore-then-finalize pair, which
      // exposes an unclaimed row in the gap and lets a concurrent sender
      // claim and re-send it, and never a finalize with no token predicate
      // at all, which could otherwise clear a DIFFERENT episode's live
      // claim out from under it. Callers with no claim to release (the
      // deferred-queue rails, project reports) omit it — unchanged.
      claimToken = null,
    } = {},
  ) {
    const invoice = await db("invoices").where({ id: invoiceId }).first();
    if (!invoice) return null;
    if (!SEND_FINALIZABLE_STATUSES.includes(invoice.status)) return invoice;
    // Codex pre-push P1 (round 1 of the owner's audit — complexity
    // simplification): a claimToken mismatch pre-check used to short-
    // circuit here too, ahead of the finalize UPDATE's own token
    // predicate below — genuinely redundant, since that predicate (and the
    // post-update fresh re-read a few lines down) already give the exact
    // same correctness guarantee without a second decision point. Removed.

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
      scheduled_send_error: require("./invoice-helpers").preserveWithdrawalStamp(db),
      scheduled_request_review: false,
      scheduled_review_delay_minutes: null,
      updated_at: now,
    };
    if (sms) updates.sms_sent_at = db.raw("COALESCE(sms_sent_at, ?)", [now]);

    const finalizeQuery = db("invoices")
      .where({ id: invoiceId })
      .whereIn("status", SEND_FINALIZABLE_STATUSES);
    // Require-and-release together, one decision: a claimed caller's token
    // both gates the UPDATE (never finalize a row this exact episode
    // doesn't own) and is what gets cleared by it — merged into the single
    // predicate/payload pair below rather than two separate `if`s.
    if (claimToken) {
      finalizeQuery.where({ send_claim_token: claimToken });
      updates.send_claim_token = null;
    }
    const [updated] = await finalizeQuery.update(updates).returning("*");
    // A claimed caller that loses the race (another episode already
    // restored/re-claimed/finalized this exact token's row between the
    // pre-check above and this UPDATE) gets the CURRENT row back rather
    // than the stale pre-update snapshot, so it never reports a delivery
    // this call did not actually perform.
    if (claimToken && !updated) return db("invoices").where({ id: invoiceId }).first();
    const finalInvoice = updated || invoice;

    // First delivery via this path (combined project send / completion-with-
    // invoice) closes the deal — convert the originating lead. `updated` confirms
    // this call performed the write; the helper's priorStatus gate (read pre-
    // update) keeps a resend of an already-sent invoice from converting.
    if (updated) {
      await convertLeadOnInvoiceSent({ invoiceId, customerId: invoice.customer_id, priorStatus: invoice.status, priorDelivered: Boolean(invoice.sent_at || invoice.sms_sent_at) });
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

    // Invoice issued ⇒ visit completed (owner ruling 2026-09-07, dark behind
    // GATE_INVOICE_ISSUED_CLOSES_VISIT): every delivery finalization that
    // does not run through sendViaSMS / sendViaSMSAndEmail (deferred rails,
    // project reports with an invoice, completion-owned notices) lands here.
    // Best-effort; the closeout refuses a visit that is already completed,
    // so a completion-owned finalization is a quiet no-op.
    const { closeOutVisitForIssuedInvoice } = require("./invoice-issued-closeout");
    const issuedCloseout = await closeOutVisitForIssuedInvoice({ invoiceId, trigger: "sent", actorTechnicianId });

    // Queue the review request only when THIS call performed the finalization
    // (`updated` set) — a concurrent path that finalized first cleared the
    // stored flags itself and already took the review decision. Decided
    // AFTER the closeout (GitHub r4 P1 #4127): a linked pre-completion
    // invoice has no service_record_id until the closeout writes it, and a
    // closeout that completed the visit quietly suppresses the ask outright
    // — its record froze requestReview: false, so nothing enrolls later.
    if (updated && effectiveRequestReview) {
      try {
        if (issuedCloseout?.closed) {
          logger.info(`[invoice] Review ask suppressed for invoice ${invoiceId}: the invoice-issued closeout completed visit ${issuedCloseout.visitId} quietly (source=${source})`);
        } else {
          // The DURABLE linkage, re-read after the closeout (GitHub r5 P1
          // #4127) — never the pre-closeout row: a closeout that committed
          // the record and this invoice's back-link but failed in its
          // post-commit work reports closed: false (the attempt stays
          // resumable), and the stale read would still say "standalone".
          const linked = await db("invoices")
            .where({ id: invoiceId })
            .select("service_record_id", "status")
            .first();
          const linkage = linked ? { ...finalInvoice, ...linked } : finalInvoice;
          // Same unpaid-completion-invoice hold as sendViaSMSAndEmail (Codex
          // P1, PR #3104 r1): delivery of an unpaid completion invoice must
          // not start review outreach — the paid webhook enrolls on payment
          // from the service record's requestReview intent. Standalone
          // invoices (no service_record_id) keep the legacy at-delivery ask.
          const deferToPayment = linkage.service_record_id
            && !["paid", "prepaid"].includes(String(linkage.status || ""));
          const { issuedCloseoutOwnsRecord } = require("./invoice-issued-closeout");
          if (deferToPayment) {
            logger.info(`[invoice] Review ask deferred to payment for invoice ${invoiceId} (unpaid completion invoice, source=${source})`);
          } else if (await issuedCloseoutOwnsRecord(linkage.service_record_id)) {
            // Durable provenance over this invocation's verdict (pre-push
            // P1 r7): a closeout that committed the record but failed after
            // — or a resend on a visit it already closed — reports closed:
            // false, yet the record froze requestReview: false.
            logger.info(`[invoice] Review ask suppressed for invoice ${invoiceId}: record ${linkage.service_record_id} was committed by the invoice-issued closeout (source=${source})`);
          } else {
            const ReviewService = require("./review-request");
            await ReviewService.enrollPostService({
              customerId: invoice.customer_id,
              serviceRecordId: linkage.service_record_id || null,
              triggeredBy: "auto",
              delayMinutes: effectiveReviewDelayMinutes,
            });
          }
        }
      } catch (err) {
        logger.error(
          `[invoice] Review request schedule failed after ${source}: ${err.message}`,
        );
      }
    }

    return finalInvoice;
  },

  async processScheduledSends({ limit = 25 } = {}) {
    // Stale-claim recovery PARKS the row instead of re-arming it: a claim
    // that died mid-send may have died AFTER the provider accepted the SMS
    // (a delivered send whose finalize failed is deliberately left under its
    // claim — see sendViaSMS's post-delivery recovery), and DB state cannot
    // distinguish that from a crash before delivery. Clearing
    // scheduled_send_at keeps the row out of the due query below, so an
    // ambiguous claim is surfaced for operator review (fail closed) rather
    // than automatically re-texting a message the customer may already have.
    await db("invoices")
      .where({ status: "sending" })
      .where("updated_at", "<", db.raw("NOW() - INTERVAL '10 minutes'"))
      .update({
        status: "scheduled",
        scheduled_send_at: null,
        scheduled_send_error: require("./invoice-helpers").STALE_SEND_PARK_ERROR,
        send_claim_token: null,
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
        // For the send-window pre-claim guard's SMS-leg check: a
        // payer-billed invoice is delivered email-only by design.
        "payer_id",
        "customer_id",
        "scheduled_service_id",
        "service_record_id",
        // A combined-visit invoice re-resolves live Bill-To under held rows
        // before its queue claim.
        "visit_completion_packet_id",
        // For the zero-due pre-claim settlement check below.
        "status",
        "total",
        "credit_applied",
      );

    let sent = 0;
    let held = 0;
    let failed = 0;
    let deferred = 0;
    // Send-window pre-claim guard (mirrors the appointment-reminders
    // pre-send guard): a scheduled send due outside 8AM-8PM ET moves to the
    // window open WITHOUT claiming or burning one of the five attempts.
    // Deferring the whole send — email leg included — keeps the invoice
    // arriving as one unit at 8:00 AM; letting the email go overnight would
    // finalize the row ('sent', scheduled_send_at cleared) with the SMS pay
    // link held and no rail left to retry it. Checked per row: pure clock
    // math, and a batch that starts at 19:59 can straddle the cutoff.
    const { isEnabled } = require("../config/feature-gates");
    const {
      isWithinSendWindowET,
      nextSendWindowOpenET,
    } = require("./messaging/send-window");
    for (const inv of due) {
      // A delivery preclaim changes scheduled -> sending, which the
      // canonical zero-balance settlement rightly refuses as an in-flight
      // send — so settle FIRST, under settleZeroBalance's own row lock and
      // payment/visit fences, before this ever claims. Neither outcome
      // spends a send attempt: this whole check is a pure read unless the
      // invoice is actually zero-due (#4131 slice 4 retry fairness). A
      // refusal-to-settle-yet moves the row a few minutes out so it cannot
      // starve later payable invoices behind it in the same due page.
      try {
        // Codex round-5 #4131: settleZeroDueBeforeSend is the ONE
        // chokepoint — it runs the packet ownership fence first on its
        // own (fenceOwnership: true), so a live payer withdrawal is
        // reported here as an ordinary 'refused' payer_billed rather than
        // this loop needing a second, separate fence of its own.
        const outcome = await settleZeroDueBeforeSend(inv.id, { fenceOwnership: true, row: inv });
        if (outcome.kind === "settled") continue;
        if (outcome.kind === "rescheduled") {
          // Codex round-8 audit P2 #4131: an operator reschedule landed
          // between this due-list read and settleZeroBalance's own locked
          // re-read — the row is no longer due at its OLD time and must
          // not be settled (or its packet review enrolled) ahead of the
          // new one. Deferred, not failed or held: nothing is wrong here,
          // and no attempt is spent — the row is simply due later now.
          deferred += 1;
          logger.info(`[invoice] Scheduled send for ${inv.invoice_number} was rescheduled between the due read and zero-due settlement — deferred to its new time, not settled`);
          continue;
        }
        if (outcome.kind === "terminal") {
          // A terminal (never-ran) linked visit is not a retryable
          // settlement refusal — route it to the void + credit-restore
          // cleanup instead of burning an attempt on a row that can never
          // settle.
          const voided = await voidTerminalZeroDueInvoice(inv.id, outcome.scheduledServiceId);
          if (voided) {
            held += 1;
          } else {
            // The sweep's own safety refusals (a live PaymentIntent,
            // money in flight, an unverifiable Stripe lookup) left the
            // row un-voided — it must not sit due with nothing spent
            // (Codex round-4 P1 #4131): re-selected every tick forever
            // otherwise. Recorded exactly like any other terminal
            // settlement refusal — a capped attempt, surfacing as failed
            // once the cap is hit — so an operator eventually sees it.
            logger.warn(`[invoice] Scheduled send for ${inv.invoice_number} is zero-due on a terminal visit but could not be safely voided — recording it as a failed refusal instead of leaving it due`);
            failed += await recordZeroDueSchedulingOutcome(zeroDueRefusalReasonText(outcome), inv);
          }
          continue;
        }
        if (outcome.kind === "refused") {
          if (outcome.code === "payer_billed") {
            held += 1;
            logger.info(`[invoice] Scheduled send for ${inv.invoice_number} withdrawn — the zero-due visit is now billed to a payer`);
            // Codex round-8 audit P1 (#4131 slice 4): the pre-emptive fence
            // only dequeues a row whose payer_id was still NULL when it ran
            // (a live withdrawal it just caught) — a row already billed to
            // a payer skips that fence and resolves through
            // settleZeroBalance's own read-only skip instead, which never
            // moves it off the queue. Idempotent no-op when the fence
            // already did (see the helper's own comment).
            await dequeuePayerOwnedZeroDueInvoice(
              inv,
              `Nothing due — invoice is billed to a third-party payer (${outcome.reason || "payer_billed"}); removed from the automated send queue`,
            );
            continue;
          }
          failed += await recordZeroDueSchedulingOutcome(zeroDueRefusalReasonText(outcome), inv);
          continue;
        }
        // not_zero_due: fall through to the normal send flow below.
      } catch (zeroDueErr) {
        // Isolate the row, never the batch: an unexpected error inside the
        // settlement check (a DB fault, a bug in settleZeroBalance) is
        // reported against THIS invoice — spending an attempt best-effort
        // so a persistent fault still meets the cap — and the loop moves on
        // to the invoices behind it. Nothing was claimed or sent here.
        logger.error(`[invoice] Zero-due check failed for scheduled send ${inv.invoice_number}: ${zeroDueErr.message}`);
        failed += 1;
        await recordZeroDueSchedulingOutcome(`Zero-due check failed: ${zeroDueErr.message}`, inv)
          .catch((e) => logger.warn(`[invoice] Could not record the zero-due check failure for ${inv.id}: ${e.message}`));
        continue;
      }
      if (isEnabled("smsSendWindow") && !isWithinSendWindowET()) {
        // SMS-leg check: the window is an SMS fence, so an invoice with no
        // SMS leg must not have its EMAIL delayed by it — a third-party
        // payer invoice is delivered email-only by design, a customer with
        // no phone can only be emailed, and an SMS-opted-out customer
        // (sms_enabled=false — texted STOP or flipped the toggle) would
        // deterministically block the SMS leg anyway. Those fall through
        // and send at their requested time. Fail toward deferral on a
        // lookup error: worst case an email waits for 8:00 AM, never a
        // night text.
        let hasSmsLeg = !inv.payer_id;
        if (hasSmsLeg) {
          try {
            const cust = await db("customers")
              .where({ id: inv.customer_id })
              .first("phone");
            hasSmsLeg = Boolean(String(cust?.phone || "").trim());
          } catch {
            hasSmsLeg = true;
          }
        }
        if (hasSmsLeg) {
          try {
            const prefs = await db("notification_prefs")
              .where({ customer_id: inv.customer_id })
              .first("sms_enabled");
            if (prefs?.sms_enabled === false) hasSmsLeg = false;
          } catch {
            /* keep hasSmsLeg — defer on an unreadable pref */
          }
        }
        if (!hasSmsLeg) {
          logger.info(
            `[invoice] Scheduled send for ${inv.invoice_number} has no SMS leg — sending at its requested time despite the send window`,
          );
        } else {
          const nextOpen = nextSendWindowOpenET();
          // Mirror the claim predicates (still due, still attempt-eligible),
          // not just id+status: an admin can reschedule the invoice between
          // the due-list read and this update, and a bare id+status match
          // would overwrite their newly chosen scheduled_send_at with the
          // window open. 0 rows affected = the row changed underneath — the
          // newer schedule owns it, count nothing.
          const deferredRows = await db("invoices")
            .where({ id: inv.id, status: "scheduled" })
            .whereNotNull("scheduled_send_at")
            .where("scheduled_send_at", "<=", new Date())
            .where((q) =>
              q
                .whereNull("scheduled_send_attempts")
                .orWhere("scheduled_send_attempts", "<", 5),
            )
            .update({
              scheduled_send_at: nextOpen,
              scheduled_send_error:
                "QUIET_HOURS_HOLD — outside 8AM-8PM ET send window, deferred to window open",
              updated_at: new Date(),
            });
          if (deferredRows) {
            deferred += 1;
            logger.info(
              `[invoice] Scheduled send for ${inv.invoice_number} outside 8AM-8PM ET send window — deferred to ${nextOpen.toISOString()}`,
            );
          }
          continue;
        }
      }
      let claimed = null;
      // A combined-visit invoice re-resolves live Bill-To ownership under
      // held rows before its queue claim; a payer means the homeowner send is
      // withdrawn for good, not retried.
      if (inv.visit_completion_packet_id && !inv.payer_id) {
        // A failed fence leaves the invoice queued for the next pass; the
        // batch never aborts on it.
        const fenced = await claimPacketInvoiceForSend(inv.id, inv.visit_completion_packet_id, { allowClaimed: false, requireDue: true })
          .catch((err) => ({ payerBilled: false, error: err }));
        if (fenced.payerBilled) {
          held += 1;
          logger.info(`[invoice] Scheduled send for ${inv.invoice_number} withdrawn — the visit is now billed to payer ${fenced.payerId}`);
          continue;
        }
        if (fenced.error) {
          logger.warn(`[invoice] Scheduled send for ${inv.invoice_number} left queued — Bill-To fence failed: ${fenced.error.message}`);
          continue;
        }
        if (!fenced.claim?.claimed) continue;
        claimed = fenced.claim.invoice;
      } else {
        claimed = await claimDueScheduledInvoiceForSend(db, inv.id);
      }
      if (!claimed) continue;

      const restoreClaimedInvoice = (payload) => db("invoices")
        .where({ id: inv.id, status: "sending", send_claim_token: claimed.send_claim_token })
        .update({ ...payload, send_claim_token: null });

      let result;
      try {
        result = await this.sendViaSMSAndEmail(claimed.id, {
          requestReview: Boolean(claimed.scheduled_request_review),
          reviewDelayMinutes: claimed.scheduled_review_delay_minutes,
          allowClaimed: true,
          claimToken: claimed.send_claim_token,
        });
      } catch (err) {
        if (err?.code === "queued_pay_link") {
          // A live deferred text already owns this pay link's delivery, so
          // the reconciliation refused the preclaimed send and deliberately
          // left this worker's 'sending' claim alone. Give the exact claim
          // back to the queue, deferred past the text's slot (or ten minutes
          // out when unknown) so the next pass finds the invoice finalized
          // by that delivery, and keep the batch moving.
          const retryAt = new Date(Math.max(Date.now() + 10 * 60 * 1000, err.scheduledFor?.getTime?.() || 0));
          await restoreClaimedInvoice({ status: "scheduled", scheduled_send_at: retryAt, updated_at: new Date() });
          logger.info(`[invoice] Scheduled send for ${inv.invoice_number} deferred to ${retryAt.toISOString()}: ${err.message}`);
          deferred += 1;
          continue;
        }
        // claimInvoiceForSend's allowClaimed branch marks a pre-provider
        // refusal (the zero-due re-check above all — #4131 slice 4)
        // deliveryNeverAttempted before throwing it: synthesize the same
        // failure shape sendViaSMSAndEmail returns on an ordinary send
        // failure and let the existing failed-handling below retry it —
        // no credit was ever applied and nothing was sent. Anything else is
        // ambiguous (it could have been thrown after a provider was
        // contacted) and must keep propagating rather than auto-retry.
        if (!err?.deliveryNeverAttempted) throw err;
        result = { ok: false, sms: { error: err.message, code: err.code }, email: { error: null }, creditApplied: 0 };
      }
      if (result.ok) {
        sent += 1;
        continue;
      }
      if (result.code === "payer_billed") {
        // Withdrawn at delivery: the invoice already left the queue.
        held += 1;
        continue;
      }
      if (result.code === "bill_to_fence_failed") {
        await restoreClaimedInvoice({ status: "scheduled", updated_at: new Date() });
        continue;
      }
      if (result.code === "INVOICE_VISIT_TERMINAL") {
        const scheduledServiceId = await linkedScheduledServiceId(inv);
        const voided = scheduledServiceId
          ? await InvoiceService.voidOpenInvoicesForCancelledService(scheduledServiceId, {
              invoiceId: inv.id,
              refusedClaimToken: claimed.send_claim_token,
            })
          : [];
        held += 1;
        if (!voided.includes(inv.id)) {
          logger.warn(`[invoice] Scheduled send for ${inv.invoice_number} hit a terminal visit but could not be safely voided — claim retained for review`);
        }
        continue;
      }
      if (result.code === "INVOICE_VISIT_TERMINAL_OUTCOME_UNCERTAIN") {
        held += 1;
        logger.warn(`[invoice] Scheduled send for ${inv.invoice_number} found a terminal visit after an unverified channel outcome — claim retained for review`);
        continue;
      }
      if (result.code === "ADOPTED_QUEUE_RESTORE_FAILED") {
        held += 1;
        logger.warn(`[invoice] Scheduled send for ${inv.invoice_number} could not give back the queued text it adopted — claim retained for review`);
        continue;
      }
      if (result.code === "INVOICE_DELIVERY_OUTCOME_UNCERTAIN") {
        held += 1;
        logger.warn(`[invoice] Scheduled send for ${inv.invoice_number} has an unverified provider outcome — claim retained for review`);
        continue;
      }

      const error =
        [
          result.sms?.error && `sms: ${result.sms.error}`,
          result.email?.error && `email: ${result.email.error}`,
        ]
          .filter(Boolean)
          .join(" | ") || "send failed";
      // A send-window hold that slipped past the pre-claim guard (the
      // 19:59→20:01 race) is a deferral, not a failure: move the due time
      // to the window open and leave the attempt counter alone — five
      // overnight cron passes must not permanently fail the send.
      const smsHeld =
        ["QUIET_HOURS_HOLD", "PUSH_IN_FLIGHT", "APP_DELIVERY_HOLD"].includes(result.sms?.code) && result.sms?.nextAllowedAt;
      let restored = 0;
      if (smsHeld) {
        deferred += 1;
        restored = await restoreClaimedInvoice({
          status: "scheduled",
          scheduled_send_at: new Date(result.sms.nextAllowedAt),
          scheduled_send_error: error,
          updated_at: new Date(),
        });
      } else {
        failed += 1;
        // A temporary native failure consumes an attempt under this
        // queue's existing five-attempt cap, but cannot replay before
        // the provider delay. Window/eligibility holds above spend none.
        const nativeRetryMs = result.sms?.code === "APP_PROVIDER_RETRY"
          ? Math.max(60000, Number(result.sms.retryAfterMs) || 60000)
            * (2 ** Number(inv.scheduled_send_attempts || 0)) * (1 + Math.random() * 0.2)
          : null;
        restored = await restoreClaimedInvoice({
          status: "scheduled",
          scheduled_send_attempts: Number(inv.scheduled_send_attempts || 0) + 1,
          ...(nativeRetryMs ? { scheduled_send_at: new Date(Date.now() + nativeRetryMs) } : {}),
          scheduled_send_error: error,
          updated_at: new Date(),
        });
      }
      // We pre-claimed this row, so sendViaSMSAndEmail couldn't reverse the credit
      // it auto-applied (the row was 'sending'). Now that it's back to 'scheduled'
      // and nothing was delivered, return that credit so it isn't stranded +
      // edit-locking the invoice until the next attempt.
      if (restored && result.creditApplied > 0) {
        try {
          const { reverseAppliedCredit } = require("./customer-credit");
          await reverseAppliedCredit({ invoiceId: inv.id, amount: result.creditApplied, createdBy: "system:scheduled_send_failed" });
        } catch (e) {
          logger.warn(`[invoice] credit reversal after failed scheduled send skipped for ${inv.id}: ${e.message}`);
        }
      }
      if (smsHeld) {
        logger.info(
          `[invoice] Scheduled send for ${inv.invoice_number} outside 8AM-8PM ET send window — deferred to ${result.sms.nextAllowedAt}`,
        );
      } else {
        logger.error(
          `[invoice] Scheduled send failed for ${inv.invoice_number}: ${error}`,
        );
      }
    }
    return { sent, failed, deferred };
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
  // hasEmailLeg: the caller declares whether THIS receipt attempt is paired
  // with a sendReceiptEmail sidecar (the receipt-delivery queue, the batch
  // resend, the prepaid completion receipt). It opts the SMS leg into the
  // email-only channel gate (channelGate 'opt_in' on the payment_receipt
  // policy) — a paired caller's SMS skips as channel_email_only and the email
  // carries the receipt. Manual single-channel operator sends (via='sms')
  // must NOT declare it: the operator explicitly chose the text, and there is
  // no email leg on that route to carry the receipt (codex round 5).
  /**
   * The customer-facing money facts a payment-receipt text needs: exact
   * amount collected, the " (Visa ending 4242)" card clause, and the
   * shortened receipt link. Shared by sendReceipt and the combined
   * completion+receipt SMS (admin-dispatch completion) so both always cite
   * the same figures.
   *
   * Amount comes from the PAYMENT row, not invoiceAmountDue(invoice): a full
   * refund zeroes credit_applied, after which invoiceAmountDue returns the
   * gross total. On a recorded refund show net cash kept (amount − refunded)
   * to match the receipt page/PDF; otherwise amount due (total − applied
   * credit). Falls back to amount due when no payment row exists.
   */
  async receiptSmsFacts(invoice) {
    const domain = publicPortalUrl();
    const longReceiptUrl = invoice.token
      ? `${domain}/pay/${invoice.token}`
      : "";
    const receiptUrl = longReceiptUrl
      ? await shortenOrPassthrough(longReceiptUrl, {
          kind: "receipt",
          entityType: "invoices",
          entityId: invoice.id,
          customerId: invoice.customer_id,
          codePrefix: invoiceShortCodePrefix(invoice),
        })
      : "";
    const cardLine = formatCardLine(invoice.card_brand, invoice.card_last_four);
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
    return { amount, cardLine, receiptUrl };
  },

  async sendReceipt(invoiceId, { force = false, recordActivity = true, hasEmailLeg = false, operatorInitiated = false, customerInitiated = false } = {}) {
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

    // Template body has a {card_line} placeholder that renders as e.g.
    // " (Visa ending 4242)" when card metadata is present, or empty otherwise.
    const { amount, cardLine, receiptUrl } = await InvoiceService.receiptSmsFacts(invoice);

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
      // Send-window operator marker: only the admin manual-resend routes
      // set it (an operator chose to text THIS receipt now).
      ...(operatorInitiated ? { operatorInitiated: true } : {}),
      // Payment provenance (owner ruling 2026-08-29 + Codex P1 on
      // PR #3598): a receipt for the customer's OWN payment sends at any
      // hour; machine charges (autopay, sweeps, no-show fees) leave this
      // unset and stay fenced, riding the receipt queue to the window
      // open. Callers assert it only from verified provenance (the
      // receipt queue's persisted flag; Pay-route enqueues).
      ...(customerInitiated ? { customerInitiated: true } : {}),
      metadata: { original_message_type: "receipt" },
      // Caller-declared (see the sendReceipt option doc above) — only flows
      // that actually pair this SMS with a sendReceiptEmail sidecar opt in.
      hasEmailLeg,
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
      // Same for a receipt-texts opt-out (payment_receipt=false or the
      // portal's payment_confirmation_sms toggle off): the customer asked for
      // this suppression, so it must not read as a delivery failure.
      if (sendResult.code === "PURPOSE_OPTED_OUT") {
        logger.info(
          `[invoice] Receipt SMS skipped for ${invoice.invoice_number} — customer opted out of receipt texts`,
        );
        return { sent: false, reason: "receipt_texts_opted_out" };
      }
      // A STOP-style SMS opt-out is permanent until the customer texts START
      // — retrying can never deliver this leg, so it must not wedge the
      // receipt job either. (STOP writes a messaging_suppression row, which
      // the pipeline checks BEFORE consent, so an email-only customer who
      // texted STOP surfaces here as SUPPRESSED_OPT_OUT rather than
      // CHANNEL_EMAIL_ONLY.) The email leg — when the customer has one — is
      // the receipt.
      if (sendResult.code === "SUPPRESSED_OPT_OUT" || sendResult.code === "SMS_OPTED_OUT") {
        logger.info(
          `[invoice] Receipt SMS skipped for ${invoice.invoice_number} — recipient has opted out of SMS (${sendResult.code})`,
        );
        return { sent: false, reason: "sms_suppressed" };
      }
      const err = new Error(
        `receipt SMS blocked: ${sendResult.code || sendResult.reason || "unknown"}`,
      );
      err.code = sendResult.code;
      err.reason = sendResult.reason;
      // Send-window hold: carry the window-open time so the receipt queue
      // schedules its retry there instead of burning generic backoff
      // attempts overnight (an after-8PM payment's receipt must go out at
      // 8:00 AM, not fail permanently ~75 minutes in).
      if (sendResult.nextAllowedAt) err.nextAllowedAt = sendResult.nextAllowedAt;
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
        // Saved-card state rides along so a deep-linked invoice row keeps
        // its card badge and Charge-card action (Codex PR #3476 r20 P2).
        // customers has NO card_on_file column — it is the default
        // payment_methods row, computed exactly as the list query does
        // (a bare column read 500'd every admin invoice detail in prod).
        db.raw(`(
          SELECT json_build_object('brand', card_brand, 'last_four', last_four)
          FROM payment_methods
          WHERE customer_id = customers.id AND is_default = true
          LIMIT 1
        ) AS card_on_file`),
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
      customer: require('./invoice-address').invoiceCustomerAddress(invoice, customer),
      active_payment_plan: activePaymentPlan,
      annual_prepay,
      annual_prepay_term: annualPrepayTerm,
      // Fourth audit gap #4131: the Send modal's "parked" state must read
      // the SAME predicate claimInvoiceForSend enforces, not a client-side
      // guess at the error text — isStaleClaimReviewHold is the one source
      // of truth for both.
      review_hold: isStaleClaimReviewHold(invoice),
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
        q.where("invoices.status", "paid")
          .whereNull("invoices.receipt_sent_at")
          // payment_receipt=false customers opted out of receipts on every
          // channel — their paid invoices are handled, not "needing" a
          // receipt, and listing them here nudges the operator to resend
          // against the customer's own preference (the manual resend path is
          // deliberately not gated). Payer-billed invoices stay listed: the
          // receipt goes to the payer AP inbox, which homeowner prefs don't
          // govern.
          .andWhere(function () {
            this.whereNotNull("invoices.payer_id").orWhereNotExists(
              db("notification_prefs")
                .select(db.raw("1"))
                .whereRaw(
                  "notification_prefs.customer_id = invoices.customer_id",
                )
                .where("notification_prefs.payment_receipt", false),
            );
          });
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

    // Fourth audit gap #4131: same review_hold field as getById, computed
    // from the SAME predicate (isStaleClaimReviewHold) — one source of
    // truth for the list AND detail rows the Send modal reads.
    return {
      invoices: invoices.map((invoice) => ({ ...invoice, review_hold: isStaleClaimReviewHold(invoice) })),
      total: parseInt(count, 10),
    };
  },

  async update(id, updates) {
    // `status` deliberately omitted — admins must use the explicit
    // /void, /charge-card, /record-payment, /archive, /unarchive routes
    // to transition state. Allowing a free-form `status` write here
    // lets a tech mark an invoice "paid" with no Stripe charge / no
    // payments-ledger row, or flip a paid invoice back to "draft" and
    // erase the audit trail. See INVOICE_UPDATE_ALLOWED_FIELDS export.

    // Editability guard. The generic update path can only safely rewrite an
    // invoice that has not accrued payment side-state. We re-read the CURRENT
    // row here (not the one the editor was opened with) so a status race — the
    // invoice gets paid via the pay link, Charge in person, or Add payment
    // after the edit form opened — is caught at the write:
    //   - status must still be in EDIT_ALLOWED_STATUSES (draft/scheduled/
    //     sent/viewed/overdue — see the constant for the owner ruling that
    //     opened delivered-but-unpaid invoices to edits; paid money is never
    //     rewritten)
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
    if (!EDIT_ALLOWED_STATUSES.includes(currentStatus)) {
      throw new Error(
        "Only unpaid invoices can be edited — this invoice has been paid, is collecting payment, or is voided",
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

    // In-flight follow-up fence: a dun touch renders the invoice's amount,
    // title, and pay link and sends externally without a transaction —
    // fireStep stamps touch_claimed_at on the sequence row for the duration.
    // Refuse edits while a fresh claim exists so the reminder the customer
    // receives and the pay page it links can't diverge mid-send. Crashed
    // senders self-heal past the 10-minute freshness window. Fail CLOSED on
    // read errors, same as the payment-plan guard.
    const touchClaimFreshCutoff = new Date(Date.now() - 10 * 60 * 1000);
    let inFlightTouch = null;
    try {
      inFlightTouch = await db("invoice_followup_sequences")
        .where({ invoice_id: id })
        .where("touch_claimed_at", ">", touchClaimFreshCutoff)
        .first("id");
    } catch (err) {
      throw new Error(
        `Could not verify the follow-up send state — refusing to edit (${err.message})`,
      );
    }
    if (inFlightTouch) {
      throw new Error(
        "A payment reminder for this invoice is sending right now — try again in a minute",
      );
    }

    // Applied-money fence for retotals (mirrors voidInvoice). A delivered
    // invoice can stay in sent/viewed/overdue with money already recorded
    // against it:
    //   - a partial in-person prepayment reduces `total`, stamps
    //     payment_recorded_at, and books a paid ledger row while the invoice
    //     stays collectible (admin-dispatch / admin-schedule completion);
    //   - a charge dispute reopens the invoice as overdue and clears its PI
    //     while the original payment sits in 'disputed'; the dispute-won
    //     handler later restores that payment against whatever the invoice
    //     then says.
    // A line-item/tax retotal recomputes from the stored lines and would
    // erase the partial-payment reduction (resent invoice demands collected
    // money again) or let a dispute settle against edited amounts. Metadata
    // edits (title/notes/email_message/due_date) stay allowed. Fail CLOSED
    // if the ledger can't be read, same as the payment-plan guard.
    const isRetotal = Boolean(updates.line_items) || updates.tax_rate !== undefined;
    // Lock-window send guard applies to DELIVERED retotals only: dun
    // sequences are created at send, so a draft/scheduled invoice has no
    // touch that could race the edit (the claim fences still run for every
    // edit as the cheap backstop). Keying on the pre-read status also keeps
    // the WDO draft repricer and other draft-only retotal paths free of the
    // extra aggregate read.
    const sendWindowGuarded =
      isRetotal && ["sent", "viewed", "overdue"].includes(currentStatus);
    // Send-progress snapshot for runEdit's lock-window compare — see the
    // in-transaction check for why the claim fences alone can't see a touch
    // that claimed, delivered, and released entirely before the row lock.
    let preSendState = null;
    if (isRetotal) {
      if (existing.payment_recorded_at) {
        throw new Error(
          "Cannot edit amounts on an invoice with payment already applied — refund it or issue a new invoice instead",
        );
      }
      let appliedMoneyRow = null;
      try {
        // All three supported payment→invoice linkage keys (mirrors the
        // webhook's findInvoiceForPayment): the dispute handler stamps
        // dispute_invoice_id — checking only invoice_id would let a
        // dispute-reopened invoice slip through this fence.
        appliedMoneyRow = await db("payments")
          .whereIn("status", ["paid", "processing", "disputed"])
          .whereRaw(
            "(metadata::jsonb ->> 'invoice_id' = ? OR metadata::jsonb ->> 'dispute_invoice_id' = ? OR metadata::jsonb ->> 'waves_invoice_id' = ?)",
            [id, id, id],
          )
          .first("id", "status");
      } catch (err) {
        throw new Error(
          `Could not verify the payment ledger — refusing to edit (${err.message})`,
        );
      }
      if (appliedMoneyRow) {
        throw new Error(
          appliedMoneyRow.status === "disputed"
            ? "Cannot edit amounts on an invoice with a payment dispute in progress — resolve the dispute first"
            : `Cannot edit amounts on an invoice with payment already applied (payment ${appliedMoneyRow.id}) — refund it or issue a new invoice instead`,
        );
      }
      // Saved-card (charge-card) attempts commit a durable claimed/ambiguous
      // row BEFORE the charge reconciles — in that window there may be no
      // payments row and no invoice PI yet, but an off-session charge may
      // still settle. A retotal would let the webhook/reconciler bind
      // collected money to a different live total. Same unresolved-attempt
      // shape the pay page's cross-rail fence uses.
      let unresolvedChargeAttempt = null;
      try {
        unresolvedChargeAttempt = await db("stripe_invoice_charge_attempts")
          .where({ invoice_id: id })
          .whereNull("resolved_at")
          .whereIn("status", ["claimed", "ambiguous"])
          .first("id");
      } catch (err) {
        throw new Error(
          `Could not verify the saved-card charge state — refusing to edit (${err.message})`,
        );
      }
      if (unresolvedChargeAttempt) {
        throw new Error(
          "A saved-card charge for this invoice is still processing or awaiting reconciliation — wait for it to resolve before editing amounts",
        );
      }
      // Snapshot the invoice's aggregate send progress BEFORE the retotal
      // work below. fireStep's progression write (touches_sent+1,
      // last_touch_at) commits before its finally-block releases the
      // claim, so any touch delivered after this read leaves evidence one
      // of the runEdit checks will see: claim still fresh → the in-txn
      // claim re-check; claim already released → this snapshot no longer
      // matches. Aggregated across the invoice's sequence rows (SUM/MAX)
      // so duplicate cadences can't hide a send. Fail CLOSED, same as the
      // claim read above.
      if (sendWindowGuarded) {
        try {
          preSendState = await db("invoice_followup_sequences")
            .where({ invoice_id: id })
            .first(
              db.raw("COALESCE(SUM(touches_sent), 0) AS touches_sent"),
              db.raw("MAX(last_touch_at) AS last_touch_at"),
            );
        } catch (err) {
          throw new Error(
            `Could not verify the follow-up send state — refusing to edit (${err.message})`,
          );
        }
      }
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
          expectedDiscountStacking: updates.expected_discount_stacking,
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
    } else if (updates.tax_rate !== undefined) {
      // A tax_rate-only body used to write the rate column with tax_amount /
      // total left stale — an invoice reading "Tax (0.00%) $7.00" beside the
      // old total. No shipped caller sends tax_rate without line_items, so
      // this is API hardening: recompute totals against the EXISTING line
      // items so the stored money always matches the stored rate. Same
      // ledger-backed edit-locks as a line-item retotal — a recompute moves
      // invoice.total, which deposit-credit and applied-credit ledgers are
      // balanced against dollar-for-dollar.
      const invoice = existing;
      const hasDepositCreditLine = (items) => {
        try {
          const arr = typeof items === "string" ? JSON.parse(items) : items;
          return Array.isArray(arr) && arr.some((i) => i?.category === "deposit_credit");
        } catch {
          return false;
        }
      };
      if (hasDepositCreditLine(invoice.line_items)) {
        throw new Error(
          "This invoice carries an estimate deposit credit — void it (the deposit returns to the customer's ledger) and create a replacement instead of changing the tax rate",
        );
      }
      if (parseFloat(invoice.credit_applied || 0) > 0) {
        throw new Error(
          "This invoice has account credit applied (prepaid) — reverse the applied credit before changing the tax rate",
        );
      }
      const existingLineItems =
        typeof invoice.line_items === "string"
          ? JSON.parse(invoice.line_items)
          : invoice.line_items || [];
      const customer = await db("customers")
        .where({ id: invoice.customer_id })
        .first();
      Object.assign(
        data,
        await calculateUpdateFinancials({
          lineItems: existingLineItems,
          customer,
          invoice,
          taxRate: updates.tax_rate,
        }),
      );
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
    // A changed due date must re-anchor the follow-up sequence ATOMICALLY
    // with the edit (inside runEdit): committing the new due date first
    // would leave a gap where a cron worker claims the still-due sequence
    // and sends the old reminder. Compared as calendar dates (the column is
    // a DATE; the editor sends YYYY-MM-DD) so an unchanged date doesn't
    // re-anchor a send-anchored cadence. The comparison itself happens
    // inside runEdit against the LOCKED row — comparing against the
    // pre-lock `existing` snapshot would let a second admin's stale form
    // write an older due date back without moving the sequence.
    const asDateOnly = (v) => {
      if (!v) return "";
      const d = new Date(v);
      return Number.isNaN(d.getTime())
        ? String(v)
        : d.toISOString().slice(0, 10);
    };

    const runEdit = async (client) => {
      // Serialize against in-flight dun sends: lock the invoice row FIRST.
      // fireStep's claim transaction locks this same row before stamping
      // touch_claimed_at, so one of the two strictly precedes the other —
      // then the claim re-check below runs on a fresh statement that can
      // see the winner's commit (the pre-check alone could read a snapshot
      // taken before a concurrent claim committed).
      const lockedRow = await client("invoices")
        .where({ id })
        .forUpdate()
        .first();
      if (!lockedRow) {
        throw new Error(
          "Only unpaid invoices can be edited — its status or payment state changed while you were editing",
        );
      }
      const inFlightNow = await client("invoice_followup_sequences")
        .where({ invoice_id: id })
        .where("touch_claimed_at", ">", touchClaimFreshCutoff)
        .first("id");
      if (inFlightNow) {
        throw new Error(
          "A payment reminder for this invoice is sending right now — try again in a minute",
        );
      }
      // Lock-window send detection (retotals): the claim fences only see a
      // claim that is STILL fresh. A touch that claimed, delivered, and
      // released entirely between the guard reads above and this row lock
      // left no claim — committing the retotal would put a new total
      // behind the pay link the customer was just texted. The cycle can't
      // hide: fireStep commits its progression write (touches_sent+1,
      // last_touch_at) before its finally-block clears the claim, so under
      // this lock either the claim is still visible (caught above) or the
      // aggregates have moved past the pre-check snapshot. Sends that
      // completed before the snapshot are the ordinary edit-after-send
      // case, mitigated by the invoice_edited_after_send resend trail.
      // Fail closed; the admin re-applies against the post-send state.
      if (sendWindowGuarded) {
        let nowSendState = null;
        try {
          nowSendState = await client("invoice_followup_sequences")
            .where({ invoice_id: id })
            .first(
              db.raw("COALESCE(SUM(touches_sent), 0) AS touches_sent"),
              db.raw("MAX(last_touch_at) AS last_touch_at"),
            );
        } catch (err) {
          throw new Error(
            `Could not verify the follow-up send state — refusing to edit (${err.message})`,
          );
        }
        const touchesBefore = Number(preSendState?.touches_sent) || 0;
        const touchesNow = Number(nowSendState?.touches_sent) || 0;
        const lastBefore = preSendState?.last_touch_at
          ? new Date(preSendState.last_touch_at).getTime()
          : 0;
        const lastNow = nowSendState?.last_touch_at
          ? new Date(nowSendState.last_touch_at).getTime()
          : 0;
        if (touchesNow > touchesBefore || lastNow > lastBefore) {
          throw new Error(
            "A payment reminder for this invoice just went out — re-check the invoice and try again",
          );
        }
      }
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
      // Extending an overdue invoice's due date into the future makes it
      // current again — restore the delivered status ('viewed' if the
      // customer ever opened it, else 'sent') so the stats bucket and the
      // red list badge stop reporting it overdue. Server-decided
      // transition: `status` stays banned from INVOICE_UPDATE_ALLOWED_FIELDS.
      if (
        String(lockedRow.status || "").toLowerCase() === "overdue" &&
        data.due_date !== undefined &&
        asDateOnly(data.due_date) >= etDateString(new Date())
      ) {
        data.status = lockedRow.viewed_at ? "viewed" : "sent";
      }
      let editQuery = client("invoices")
        .where({ id })
        .whereIn("status", EDIT_ALLOWED_STATUSES)
        .whereNull("stripe_payment_intent_id")
        .whereNull("annual_prepay_term_id")
        .whereNotExists(function () {
          this.select(db.raw("1"))
            .from("payment_plans")
            .whereRaw("payment_plans.invoice_id = invoices.id")
            .where("payment_plans.status", "active");
        })
        // In-flight-touch fence re-asserted at write time: a dun send that
        // claimed the sequence between the guard read and this write must
        // fail the edit closed, not race the reminder it's rendering.
        .whereNotExists(function () {
          this.select(db.raw("1"))
            .from("invoice_followup_sequences")
            .whereRaw("invoice_followup_sequences.invoice_id = invoices.id")
            .where(
              "invoice_followup_sequences.touch_claimed_at",
              ">",
              touchClaimFreshCutoff,
            );
        });
      // Retotals also re-assert the applied-money fences at write time so a
      // partial payment, dispute, or auto-applied account credit recorded
      // between the guard read and this write fails closed instead of
      // rewriting collected money (a dun's autoApplyAccountCreditIfEnabled
      // can stamp credit_applied while the invoice stays sent).
      if (isRetotal) {
        editQuery = editQuery
          .whereNull("payment_recorded_at")
          .whereRaw("COALESCE(credit_applied, 0) = 0")
          .whereNotExists(function () {
            this.select(db.raw("1"))
              .from("payments")
              .whereRaw(
                "(payments.metadata::jsonb ->> 'invoice_id' = invoices.id::text OR payments.metadata::jsonb ->> 'dispute_invoice_id' = invoices.id::text OR payments.metadata::jsonb ->> 'waves_invoice_id' = invoices.id::text)",
              )
              .whereIn("payments.status", ["paid", "processing", "disputed"]);
          })
          .whereNotExists(function () {
            this.select(db.raw("1"))
              .from("stripe_invoice_charge_attempts")
              .whereRaw(
                "stripe_invoice_charge_attempts.invoice_id = invoices.id",
              )
              .whereNull("stripe_invoice_charge_attempts.resolved_at")
              .whereIn("stripe_invoice_charge_attempts.status", [
                "claimed",
                "ambiguous",
              ]);
          });
      }
      const [edited] = await editQuery.update(data).returning("*");
      if (!edited) {
        throw new Error(
          "Only unpaid invoices can be edited — its status or payment state changed while you were editing",
        );
      }
      // Phase 2: an edited accrued invoice changes the statement total — reroll in
      // the SAME transaction so a reroll failure ABORTS the edit; we never commit
      // a changed invoice beside a stale statement subtotal/tax/total.
      if (edited.payer_statement_id) {
        await require("./payer-statements").rollupStatement(edited.payer_statement_id, client);
      }
      if (
        data.due_date !== undefined &&
        asDateOnly(lockedRow.due_date) !== asDateOnly(data.due_date)
      ) {
        // In the SAME transaction (and under the invoice row lock): a cron
        // worker's claim can't interleave between the committed due date and
        // the moved sequence, and a reschedule failure aborts the edit
        // rather than leaving the old dunning timeline against the new date.
        // Delta from the LOCKED row's due date, so a concurrent edit that
        // already moved it (and its anchor) is shifted back correctly.
        await require("./invoice-followups").rescheduleForInvoiceEdit(
          id,
          { previousDueDate: lockedRow.due_date, newDueDate: data.due_date },
          client,
        );
      }
      return edited;
    };
    // Every edit runs in a transaction now: the invoice row lock at the top
    // of runEdit is the serialization point against fireStep's claim, and
    // the statement reroll / follow-up re-anchor must commit atomically
    // with the edit.
    const edited = await db.transaction(runEdit);
    // Audit trail: a delivered invoice was rewritten after the customer could
    // have seen it — the emailed PDF is now stale until it's resent. Keyed on
    // the SAVED row's status, not the pre-read one: a scheduled send can
    // complete between the guard read and the atomic write (the predicate
    // deliberately allows that edit in its new 'sent' state), and that rewrite
    // must leave the same trail. Outside the write on purpose (best-effort; a
    // logging failure must not roll back or fail a committed edit).
    const editedStatus = String(edited?.status || "").toLowerCase();
    if (["sent", "viewed", "overdue"].includes(editedStatus)) {
      await db("activity_log")
        .insert({
          customer_id: existing.customer_id,
          action: "invoice_edited_after_send",
          description:
            `Invoice ${existing.invoice_number} was edited after delivery — ` +
            "resend it so the customer sees the updated version",
        })
        .catch((err) =>
          logger.warn(
            `[invoice:update] activity_log insert failed: ${err.message}`,
          ),
        );
    }
    return edited;
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
      // RE-ENTRY HEALS (codex #3591 r55 local P0): a prior void whose
      // annual-prepay sync failed post-commit left the term/claim state
      // behind — re-running the idempotent sync here makes "retry the
      // void" the repair path instead of a permanent stranding.
      await require("./annual-prepay-renewals").syncTermForInvoicePayment(current);
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
      // A combined PI is stamped on its SIBLINGS too (codex #3427 r16 P2):
      // canceling it while voiding one allocated invoice must unbind every
      // other collectible row, or they stay stuck behind a canceled intent
      // (edits blocked, open sibling pages posting to a dead PI).
      await require("./pay-combined").clearPaymentIntentStamps(db, triagedVoidPiId, { keepInvoiceIds: [String(id)] });
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
        .update({ status: "void", send_claim_token: null, updated_at: new Date() })
        .returning("*");
      if (!updated) {
        throw new Error("Invoice status changed while voiding — re-check and retry");
      }
      // A voided standard invoice that billed the rodent bait-station setup
      // puts the obligation back on the living series (codex #3591 r44 P1).
      await this.restoreRodentSetupObligationForReversedInvoice(trx, updated);
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
      // A void is a terminal exit for the invoice's collection path — an
      // ACTIVE payment plan must not survive it (it blocks edits/credit
      // reversal forever on a dead invoice). Cancel it in the SAME
      // transaction, stamped system:invoice_void. Deliberately NO dunning
      // re-arm: a void invoice collects nothing, so the plan-owned sequence
      // stop simply becomes moot with the invoice terminal.
      await trx("payment_plans")
        .where({ invoice_id: id, status: "active" })
        .update({
          status: "cancelled",
          cancelled_at: new Date(),
          cancelled_by: "system:invoice_void",
          updated_at: new Date(),
        });
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
      // The void is COMMITTED but the term/claim restorations did not run
      // (codex #3591 r55 local P0) — surfacing the failure makes the retry
      // path real: re-voiding an already-void invoice re-runs the
      // idempotent sync above.
      logger.error(
        `[invoice] annual prepay sync FAILED after void ${invoice.invoice_number}: ${err.message} — the invoice IS void; retry the void to rerun the sync`,
      );
      throw new Error(
        `Invoice ${invoice.invoice_number} was voided, but its annual-prepay/setup restorations failed (${err.message}). Retry the void — it reruns the restorations.`,
      );
    }
    logger.info(`[invoice] Voided: ${invoice.invoice_number}`);
    // Coverage-changing transition (PR #3476): a voided stamped/linked
    // invoice may have been the setup-fee alert's coverage — reopen it.
    await require("./setup-fee-alert-reconcile").reconcileSetupFeeAlertForInvoice(invoice);
    return invoice;
  },

  /**
   * Restore a VOIDED invoice to an editable, collectible 'draft' — the
   * operator's undo for an accidental void. Deliberately narrow: any void
   * that returned money state REFUSES (fail closed) and names the correct
   * path instead of trying to re-take the money here:
   *   - deposit_credit line: voidInvoice's ledger restore re-opened the
   *     deposit rows (they may have rolled forward onto another invoice
   *     since) but the negative line stays on this invoice — restoring it
   *     would collect a total reduced by credit the ledger no longer holds
   *     against it. The replacement path is a NEW invoice, where the
   *     deposit credit re-applies through the normal roll-forward.
   *   - annual prepay term: voidInvoice synced the term; the term flow owns
   *     its prepay invoice lifecycle.
   * Applied ACCOUNT credit needs no guard: restoreAccountCreditForVoidedInvoice
   * zeroed credit_applied (and the prepaid/paid stamps) on this row when it
   * returned the balance, so the restored draft collects its full total and
   * the operator can re-apply credit deliberately. A payment plan cancelled
   * at void time stays cancelled — recreate it on the restored invoice.
   */
  async unvoidInvoice(id) {
    const current = await db("invoices").where({ id }).first();
    if (!current) throw new Error("Invoice not found");
    if (current.status !== "void") {
      throw new Error(
        `Only a voided invoice can be unvoided (current status: ${current.status})`,
      );
    }
    if (current.annual_prepay_term_id) {
      throw new Error(
        "Cannot unvoid — this invoice belongs to an annual prepay term; manage it from Annual prepay instead",
      );
    }
    // The denormalized stamp above is NOT a reliable test on its own:
    // annual_prepay_term_id is null on some prod prepay invoices (see the
    // pending-completion sweep in annual-prepay-renewals — it compares
    // against the TERM's prepay_invoice_id for the same reason). A term's
    // own prepay invoice restored as an ordinary draft would collect the
    // annual's money beside (or instead of) the term's coverage. Fail
    // CLOSED on read errors, same as the payment-plan guard (Codex #3493).
    let owningTerm = null;
    try {
      owningTerm = await db("annual_prepay_terms")
        .where({ prepay_invoice_id: id })
        .first("id");
    } catch (err) {
      throw new Error(
        `Could not verify the annual prepay term link — refusing to unvoid (${err.message})`,
      );
    }
    if (owningTerm) {
      throw new Error(
        "Cannot unvoid — this invoice belongs to an annual prepay term; manage it from Annual prepay instead",
      );
    }
    // A conversion-minted annual prepay invoice whose TERM creation failed
    // was voided with NO term row and NO invoice stamp (estimate-converter's
    // fail-closed catch) — the guards above can't see it, but restoring it
    // would collect an annual charge that activates no coverage. The
    // converter titles these invoices distinctively; refuse on the title and
    // route the rebuild through the annual-prepay flow (Codex #3493 r4).
    if (/annual prepay/i.test(String(current.title || ""))) {
      throw new Error(
        "Cannot unvoid — this is an annual prepay charge; rebuild it through Annual prepay so coverage activates with the payment",
      );
    }
    // A void carrying the prepay-switch marker was deliberately superseded
    // by an annual prepay: its guarded restore path
    // (restoreSwitchSupersededInvoicesForPrepay) re-checks coverage and
    // partial re-billing when the prepay is reversed/refunded. Restoring it
    // here while the prepay stays active would double-bill the covered
    // visit (Codex #3493).
    if (/\[prepay-switch-superseded-by:[^\]]+\]/.test(String(current.notes || ""))) {
      throw new Error(
        "Cannot unvoid — this invoice was superseded by an annual prepay switch; reversing that prepay (Annual prepay) restores it with the coverage checks applied",
      );
    }
    if (invoiceHasDepositCreditLine(current)) {
      throw new Error(
        "Cannot unvoid — the deposit credit on this invoice was returned to the customer's deposit when it was voided; create a replacement invoice so the credit re-applies cleanly",
      );
    }
    // A voided invoice still carrying the annual-coverage settlement stamp
    // was settled as NON-CASH coverage before the void — its paid/prepaid
    // stamps and 'annual_prepay_covered' follow-up stop are retained, and
    // the coverage reopen path ignores non-'prepaid' rows. Restoring this
    // shape would make a covered charge collectible with reminders
    // permanently suppressed (Codex #3493 r14).
    if (current.annual_prepay_covered_term_id) {
      throw new Error(
        "Cannot unvoid — this invoice was settled as annual prepay coverage before it was voided; manage it from Annual prepay instead",
      );
    }
    // Linked-visit guards, fast-fail pass (re-checked inside the restore
    // transaction — see assertUnvoidableLinkedVisit).
    await assertUnvoidableLinkedVisit(db, current);
    // Phase 2 mirror of voidInvoice: a voided line was EXCLUDED from its
    // statement's rollup — restoring it under a finalized/sent statement
    // would change the document under the frozen total.
    if (current.payer_statement_id) {
      const stmt = await db("payer_statements")
        .where({ id: current.payer_statement_id })
        .first("status");
      if (stmt && stmt.status !== "open") {
        throw new Error(
          "This invoice is on a finalized payer statement — bill it as a new line on the next statement instead of restoring a voided one",
        );
      }
    }
    // Stale pay-session stamp triage (fail closed, mirrors voidInvoice's):
    // void cancels the open PaymentIntent but keeps the stamp on this row.
    // Verify it is really dead before clearing — restoring a collectible
    // invoice beside a live client secret would let a stale pay page charge
    // an amount nothing reconciles.
    if (current.stripe_payment_intent_id) {
      const StripeService = require("./stripe");
      let pi;
      try {
        pi = await StripeService.retrievePaymentIntent(
          current.stripe_payment_intent_id,
        );
      } catch (e) {
        throw new Error(
          `Open payment session ${current.stripe_payment_intent_id} could not be verified (${e.message}); resolve it before unvoiding`,
        );
      }
      if (!pi) {
        throw new Error(
          `Open payment session ${current.stripe_payment_intent_id} could not be verified (payment service unavailable); resolve it before unvoiding`,
        );
      }
      if (pi.status !== "canceled") {
        throw new Error(
          `This invoice still has a live payment session (${pi.status}); resolve it before unvoiding`,
        );
      }
    }
    let invoice = null;
    // Cancelled deferred rows whose entry point registers an onTerminal
    // hook — collected inside the transaction, hooks run after commit
    // (the terminal_pending stamp written WITH the cancel makes the
    // obligation durable: the registry sweep re-runs it if we crash first).
    const cancelledHookRows = [];
    await db.transaction(async (trx) => {
      // OWNERSHIP ROWS FIRST, before this transaction touches the invoice
      // (local audit P0 + the earlier lock-order P1): the restore must decide
      // live Bill-To ownership ATOMICALLY — a collectible draft committed
      // ahead of a separate reconciliation can be paid by the homeowner in
      // between, and a swallowed failure would leave it collectible for good
      // — and the withdrawal it may need takes customer and member rows,
      // which every Bill-To writer takes before the invoice. Taking them here
      // puts this restore on that same order; the reconciliation below is
      // then re-entrant on rows this transaction already holds.
      if (current.visit_completion_packet_id && current.customer_id) {
        await trx("customers").where({ id: current.customer_id }).forShare().first("id");
        const billedMembers = await trx("visit_completion_packet_items")
          .where({ packet_id: current.visit_completion_packet_id })
          .pluck("scheduled_service_id");
        if (billedMembers.length) {
          await trx("scheduled_services").whereIn("id", billedMembers.filter(Boolean)).orderBy("id").forShare().select("id");
        }
      }
      // Statement re-check under lock (a concurrent close could finalize it
      // between the fast pre-check above and this write).
      if (current.payer_statement_id) {
        const locked = await trx("payer_statements")
          .where({ id: current.payer_statement_id })
          .forUpdate()
          .first("status");
        if (locked && locked.status !== "open") {
          throw new Error(
            "This invoice is on a finalized payer statement — bill it as a new line on the next statement instead of restoring a voided one",
          );
        }
      }
      const [updated] = await trx("invoices")
        .where({ id, status: "void" })
        .update({
          status: "draft",
          send_claim_token: null,
          // A draft can't stay tucked under the Archived filter.
          archived_at: null,
          // Verified-canceled above; a kept stamp would trip the edit
          // guard's "already started paying" fence forever.
          stripe_payment_intent_id: null,
          scheduled_send_at: null,
          scheduled_send_attempts: 0,
          scheduled_send_error: require("./invoice-helpers").preserveWithdrawalStamp(db),
          scheduled_request_review: false,
          scheduled_review_delay_minutes: null,
          updated_at: new Date(),
        })
        .returning("*");
      if (!updated) {
        throw new Error("Invoice status changed while unvoiding — re-check and retry");
      }
      // The preserved withdrawal stamp is re-judged against LIVE ownership
      // (Codex #4311 r30 P1): a withdrawn invoice that was voided is skipped
      // by the Bill-To reconciliation (void is terminal), so a payer cleared
      // in the meantime would leave the restored self-pay draft stamped —
      // unpayable and unschedulable for good. The shared reconciliation
      // releases it when the packet is self-pay again and keeps the stamp
      // (re-pointed if the payer changed) while a payer still owes it.
      // EVERY restored packet invoice is re-judged HERE, stamped or not, and
      // the verdict commits with the restore (local audit P0): an invoice
      // voided BEFORE a payer was assigned carries no stamp — the withdrawal
      // skips terminal rows — so the unvoid would otherwise hand the
      // homeowner a collectible link for debt that is now payer-owned, and a
      // payer sitting on a SIBLING billed member escapes the payment rail's
      // representative-service lookup entirely. The ownership rows were taken
      // at the top of this transaction, so both calls are re-entrant on the
      // established order.
      if (updated.visit_completion_packet_id) {
        const Packets = require("./visit-completion-packets");
        // A stamp that outlived the void is re-pointed or released…
        await Packets.reconcileWithdrawnPacketInvoices(trx, { customerId: updated.customer_id });
        // …and a restored row whose live owner is a payer is withdrawn before
        // it can ever be collected.
        await Packets.withdrawPacketInvoicesForOwner(trx, { customerId: updated.customer_id });
      }
      // Term-link TOCTOU re-check on the FRESH row under the lock (Codex
      // #3493 r2): a concurrent /annual-prepay can create the term and
      // stamp the invoice between the pre-transaction guards and this
      // update. Throwing rolls the restore back.
      if (updated.annual_prepay_term_id) {
        throw new Error(
          "Cannot unvoid — this invoice belongs to an annual prepay term; manage it from Annual prepay instead",
        );
      }
      // The void restored the rodent setup obligation (stamp or replacement
      // draft) — unvoiding makes THIS invoice's setup line collectible
      // again, so those artifacts are retired with the restore or the fee
      // collects twice (codex #3591 r47 P1). UNCONDITIONAL (codex #3591
      // r74 P1): the old exact-description gate skipped the cleanup when
      // staff had renamed the setup line, leaving the restored stamp or
      // replacement draft collectible beside the reinstated invoice. The
      // helper's own provenance probes (immutable claim, then the durable
      // rebill marker) early-return null for ordinary invoices; unvoids
      // are rare staff actions, so the extra lookups are cheap. Errors
      // propagate → unvoid rolls back.
      await InvoiceService.retireRodentSetupObligationForReinstatedInvoice(trx, id, { strict: true });
      let owningTermNow = null;
      try {
        owningTermNow = await trx("annual_prepay_terms")
          .where({ prepay_invoice_id: id })
          .first("id");
      } catch (err) {
        throw new Error(
          `Could not verify the annual prepay term link — refusing to unvoid (${err.message})`,
        );
      }
      if (owningTermNow) {
        throw new Error(
          "Cannot unvoid — this invoice belongs to an annual prepay term; manage it from Annual prepay instead",
        );
      }
      // Money-landed-after-void guard, on the FRESH row under the lock
      // (mirrors voidInvoice's ordering): a late webhook can record a
      // payment against a voided row without flipping the status this
      // update keys on. Rolling back beats restoring beside collected
      // money, which would double-collect.
      const appliedPayment = await trx("payments")
        .whereIn("status", ["paid", "processing"])
        .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [updated.id])
        .first("id");
      if (updated.payment_recorded_at || appliedPayment) {
        throw new Error(
          `Cannot unvoid an invoice with payment already applied (${appliedPayment ? `payment ${appliedPayment.id}` : "payment recorded"})`,
        );
      }
      // Saved-card reconciliation fence (Codex #3493 r12): a timed-out or
      // rolled-back saved-card charge leaves durable
      // stripe_invoice_charge_attempts / stripe_orphan_charges records with
      // NO payment row and NO PaymentIntent stamp on the invoice — Stripe
      // may already have collected the card. Restoring a collectible draft
      // beside that would enable a second collection; the shared fence
      // fails closed until reconciliation resolves it.
      await require("./stripe").assertNoInvoiceChargeReconciliationPending(id, trx);
      // Linked-visit TOCTOU re-check on the locked row (Codex #3493 r3): a
      // cancellation / re-service conversion / prepay stamping that
      // committed after the fast-fail pass rolls the restore back — its own
      // invoice sweep skips 'void' rows, so it cannot repair a restore that
      // commits on the stale verdict.
      await assertUnvoidableLinkedVisit(trx, updated, { lock: true });
      // In-flight dunning touch fence (Codex #3493 r9, same fence as the
      // edit path): fireStep stamps touch_claimed_at for the duration of a
      // touch and writes the sequence back UNCONDITIONALLY afterward — a
      // void+unvoid landing inside that window would let the in-flight
      // touch send its stale reminder and then re-arm the sequence on the
      // restored draft. Refuse (rolling back) while a fresh claim exists;
      // crashed senders self-heal past the 10-minute freshness window.
      // Fail CLOSED on read errors, matching the edit fence.
      const touchClaimFreshCutoff = new Date(Date.now() - 10 * 60 * 1000);
      let inFlightTouch = null;
      try {
        inFlightTouch = await trx("invoice_followup_sequences")
          .where({ invoice_id: id })
          .where("touch_claimed_at", ">", touchClaimFreshCutoff)
          .first("id");
      } catch (err) {
        throw new Error(
          `Could not verify the follow-up send state — refusing to unvoid (${err.message})`,
        );
      }
      if (inFlightTouch) {
        throw new Error(
          "Cannot unvoid — a payment reminder for this invoice is sending right now; retry in a few minutes",
        );
      }
      // The void-time lifecycle stop is BEST-EFFORT (stopInvoiceFollowupSequence
      // swallows failures, so voidInvoice can succeed with the sequence still
      // ACTIVE), and runPending excludes only terminal invoice statuses — an
      // active row would dun the restored draft before any resend. Apply the
      // missed stop atomically with the restore (idempotent; the resend
      // re-arm owns the revival) (Codex #3493 r4).
      // 'autopay_hold' repairs too (Codex #3493 r10): a held row on the
      // restored draft can be ACTIVATED later by an autopay failure
      // (releaseFromAutopayHold treats draft as nonterminal) — the
      // is_autopay_held flag is left in place so the resend re-arm can
      // restore the hold for a still-enrolled customer.
      await trx("invoice_followup_sequences")
        .where({ invoice_id: id })
        .whereIn("status", ["active", "autopay_hold"])
        .update({
          status: "stopped",
          stopped_reason: "invoice_voided",
          stopped_by_admin_id: null,
          next_touch_at: null,
          updated_at: new Date(),
        });
      // Deferred rails queued BEFORE the void survive it as
      // status='scheduled' sms_log rows (while void, the executor's
      // staleness recheck suppresses them as terminal — but a restored
      // draft is collectible again and the frozen body/pay-link text is
      // stale by definition). Cancel them atomically with the restore; an
      // explicit post-restore resend re-queues fresh copy (Codex #3493).
      // The completion rails (dispatch_completion_deferred /
      // autopay_completion_decline_deferred) register onTerminal hooks
      // that hand the send back to the service record (the 'deferred'
      // stamp is an owned obligation — left in place it suppresses every
      // future completion attempt and strands any bundled review
      // fallback), so those rows are cancelled WITH the terminal_pending
      // stamp (durable obligation, same contract as the executor's
      // terminal flips) and their hooks run after commit (Codex #3493 r15).
      const { requiresTerminalHook } = require("./messaging/deferred-replay-registry");
      const deferredRows = await trx("sms_log")
        .where({ status: "scheduled" })
        .whereRaw("metadata->>'entry_point' IN ('invoice_send_deferred', 'invoice_followup_deferred', 'autopay_completion_decline_deferred', 'dispatch_completion_deferred')")
        .whereRaw("metadata->>'invoice_id' = ?", [String(updated.id)])
        // A finalize_only row is NOT an unsent message: its SMS already
        // DELIVERED and the scheduled replay re-runs only the post-delivery
        // finalization. Cancelling it would drop that obligation (and run
        // onTerminal — marking a delivered completion failed and arming a
        // duplicate review). The finalization fence below refuses the whole
        // restore instead (Codex #3493 r16).
        .whereRaw("COALESCE(metadata->>'finalize_only', 'false') <> 'true'")
        .select("id", "metadata");
      const hookRows = [];
      const plainIds = [];
      for (const row of deferredRows) {
        let meta = row.metadata;
        if (typeof meta === "string") {
          try { meta = JSON.parse(meta); } catch { meta = {}; }
        }
        meta = meta || {};
        if (requiresTerminalHook(meta.entry_point)) {
          hookRows.push({ id: row.id, meta });
        } else {
          plainIds.push(row.id);
        }
      }
      // Both cancels keep the status='scheduled' predicate: a row a worker
      // claimed between the read above and this write stays untouched and
      // the 'sending' fence below refuses (rolling everything back).
      if (plainIds.length) {
        await trx("sms_log")
          .whereIn("id", plainIds)
          .where({ status: "scheduled" })
          .update({
            status: "cancelled",
            updated_at: new Date(),
            metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancelled_reason', 'invoice_unvoided')"),
          });
      }
      for (const row of hookRows) {
        const cancelled = await trx("sms_log")
          .where({ id: row.id, status: "scheduled" })
          .update({
            status: "cancelled",
            updated_at: new Date(),
            metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancelled_reason', 'invoice_unvoided', 'terminal_pending', true, 'terminal_attempts', COALESCE((metadata->>'terminal_attempts')::int, 0) + 1)"),
          });
        if (cancelled) cancelledHookRows.push(row);
      }
      // In-flight claim fence (Codex #3493 r2): the scheduled-SMS worker
      // claims rows scheduled→'sending' BEFORE its staleness recheck. A row
      // claimed just before this restore is missed by the cancel above, and
      // once we commit, the worker's recheck reads a collectible draft and
      // dispatches the stale frozen body. The cancel above has already
      // locked every still-'scheduled' row, so no NEW claim can slip in;
      // refuse (rolling back) while an existing claim is mid-dispatch — the
      // worker either delivered against the still-void invoice (its recheck
      // suppresses terminal statuses) or the operator retries in a minute.
      const dispatchingNow = await trx("sms_log")
        .where({ status: "sending" })
        .whereRaw("metadata->>'entry_point' IN ('invoice_send_deferred', 'invoice_followup_deferred', 'autopay_completion_decline_deferred', 'dispatch_completion_deferred')")
        .whereRaw("metadata->>'invoice_id' = ?", [String(updated.id)])
        .first("id");
      if (dispatchingNow) {
        throw new Error(
          "Cannot unvoid — a deferred message for this invoice is dispatching right now; retry in a minute",
        );
      }
      // Post-delivery finalization fence (Codex #3493 r16): a deferred SMS
      // that already reached the provider leaves either status='sent' with
      // finalize_pending (settlement stamped, finalization hook not yet
      // run) or status='scheduled' with finalize_only (the recovery
      // sweep's bounded finalization replay). Both represent a DELIVERED
      // send whose state writes (invoice sent flip, follow-up arming,
      // receipt claims) have not landed — committing the restore under
      // them would let that finalizer mark the restored draft sent and arm
      // follow-ups without a resend. Runs LAST, after the 'sending' fence,
      // so a dispatch that settled mid-transaction is still caught here.
      const finalizingNow = await trx("sms_log")
        .whereRaw("metadata->>'entry_point' IN ('invoice_send_deferred', 'invoice_followup_deferred', 'autopay_completion_decline_deferred', 'dispatch_completion_deferred')")
        .whereRaw("metadata->>'invoice_id' = ?", [String(updated.id)])
        .whereRaw("((status = 'sent' AND metadata->>'finalize_pending' = 'true') OR (status = 'scheduled' AND metadata->>'finalize_only' = 'true'))")
        .first("id");
      if (finalizingNow) {
        throw new Error(
          "Cannot unvoid — a delivered message for this invoice is still finalizing; retry in a few minutes",
        );
      }
      // Phase 2: an accrued draft re-enters its still-open statement total in
      // the same transaction (rollupStatement excludes only status='void').
      if (updated.payer_statement_id) {
        await require("./payer-statements").rollupStatement(
          updated.payer_statement_id,
          trx,
        );
      }
      invoice = updated;
    });
    logger.info(`[invoice] Unvoided to draft: ${invoice.invoice_number}`);
    // Dunning stays under the system void stop while the restored invoice
    // sits in draft — reminders against an unpublished draft would be
    // wrong. The RESEND is the lifecycle point that re-arms it:
    // scheduleForInvoice conditionally lifts the 'invoice_voided' system
    // stop under the invoice lock (preserving admin stops and the autopay
    // hold) — see the re-arm branch there (Codex #3493 r2).
    // Post-commit work is BEST-EFFORT: the restore is committed, so a
    // failure here must never surface as a failed unvoid — the operator
    // would retry into the not-void conflict while the invoice already
    // sits in draft (Codex #3493 r15). Each obligation has its own
    // recovery rail: the terminal hooks are stamped terminal_pending
    // (the registry sweep re-runs them), and the setup-fee reconcile is
    // idempotent and re-runs on the next coverage-changing transition.
    for (const row of cancelledHookRows) {
      try {
        const { runTerminalHookDurably } = require("./messaging/deferred-replay-registry");
        await runTerminalHookDurably(row.id, row.meta.entry_point, row.meta, { alreadyClaimed: true });
      } catch (err) {
        logger.warn(`[invoice] unvoid terminal hook failed for sms_log ${row.id} — sweep will retry: ${err.message}`);
      }
    }
    try {
      // Coverage-changing transition (mirrors void/edit): the restored
      // charge may satisfy the setup-fee alert again.
      await require("./setup-fee-alert-reconcile").reconcileSetupFeeAlertForInvoice(invoice);
    } catch (err) {
      logger.warn(`[invoice] unvoid committed but setup-fee alert reconcile failed for invoice ${invoice.id}: ${err.message}`);
    }
    return invoice;
  },

  /**
   * Close an invoice whose existing discounts/deposit/account-credit allocation
   * leave exactly nothing due. Uses the non-cash prepaid state and keeps its
   * existing allocations for the canonical void/reversal paths. No new credit,
   * payment row, provider call or receipt is created by this transition.
   */
  async settleZeroBalance(id, database = db, { requireDueBy = null } = {}) {
    const run = async (trx) => {
      // Lock order (#4131 slice 5, #4634 deferral, invoice.js ~1385): most
      // of the packet-invoice send/claim machinery — resolvePacketOwnershipLocked
      // (customer FOR SHARE first), claimPacketInvoiceForSend, and
      // admin-schedule.js's Bill-To edit ("OWNERSHIP ROWS FIRST for a
      // Bill-To edit", server/routes/admin-schedule.js) — locks the customer
      // row before any invoice row it may go on to touch. This function was
      // the one reversed order (invoice, then customer), so a concurrent
      // pair — this settlement racing a Bill-To edit on the same invoice's
      // customer — could deadlock; PostgreSQL aborts one side (40P01), the
      // worker retries next pass and the operator retries the edit. An
      // unlocked pre-read gets customer_id without yet holding the invoice
      // row, so the customer lock lands first, matching the majority order.
      const preCustomer = await trx("invoices").where({ id }).first("customer_id");
      if (!preCustomer) return { settled: false, reason: "not_found", invoice: null };
      await trx("customers").where({ id: preCustomer.customer_id }).forUpdate().first("id");
      const invoice = await trx("invoices").where({ id }).forUpdate().first();
      if (!invoice) return { settled: false, reason: "not_found", invoice: null };
      const skip = (reason) => ({ settled: false, reason, invoice });
      // Codex pre-push P1 (round 1 of the owner's audit): a customer merge
      // can repoint invoices.customer_id between the unlocked pre-read
      // above and this FOR UPDATE — the lock just taken would then be on
      // the WRONG (retired) customer, while this settlement marks an
      // invoice the SURVIVOR now owns as prepaid without ever holding the
      // survivor's own customer lock, so a concurrent Bill-To edit on the
      // survivor is not actually serialized behind it. Re-verify under the
      // invoice's own lock: a real merge racing a settlement is rare and
      // this transaction has made no writes yet, so fail closed and
      // retryable (the worker retries next pass, a direct caller's own
      // retry rail applies) rather than attempt a mid-transaction lock
      // swap.
      if (invoice.customer_id !== preCustomer.customer_id) {
        return { ...skip("owner_changed"), retryable: true };
      }
      // Packet ownership RE-VALIDATED under THIS lock (Codex round-9 audit
      // P1 #4131): settleZeroDueBeforeSend's own packet fence
      // (claimPacketInvoiceForSend fenceOnly) commits and returns in its
      // OWN transaction, before this one ever opens — a Bill-To withdrawal
      // (withdrawPacketInvoiceForPayer) landing in that gap is invisible to
      // a fence check that already ran. The withdrawal leaves payer_id
      // NULL and records ownership ONLY in the scheduled_send_error stamp
      // (`payer_billed:<payerId>[:park]`), so re-check BOTH under the row
      // this transaction just locked — the same row-aware helper every
      // other collection seam already reads that stamp through
      // (invoiceWithdrawnFromCustomer), not a second hand-rolled regex. A
      // distinct reason (not one of the generic refusals below) lets
      // settleZeroDueBeforeSend map it to the SAME { kind: 'refused',
      // code: 'payer_billed' } descriptor its pre-emptive fence already
      // returns, instead of the generic deposit_settlement_pending retry.
      if (invoice.visit_completion_packet_id
        && (invoice.payer_id || require("./invoice-helpers").invoiceWithdrawnFromCustomer(invoice))) {
        return skip("payer_billed");
      }
      // Worker-originated calls only (requireDueBy is set exclusively by
      // settleZeroDueBeforeSend when it was handed the due loop's own row —
      // Codex round-8 audit P2 #4131): an operator reschedule landing
      // between the due-list SELECT and this LOCKED re-read must win. The
      // due loop's own row is a snapshot from before this lock; without
      // this check a reschedule to a LATER time could still be settled
      // (and its packet review enrolled) here, ahead of the new send time.
      if (requireDueBy && (invoice.status !== "scheduled"
        || !invoice.scheduled_send_at || new Date(invoice.scheduled_send_at) > requireDueBy)) {
        return skip("rescheduled");
      }
      if (!require("./invoice-helpers").isInvoiceCollectibleStatus(invoice.status)) return skip("already_settled");
      const totalCents = Math.round(Number(invoice.total) * 100);
      const creditCents = Math.round(Number(invoice.credit_applied || 0) * 100);
      const validAmounts = [totalCents, creditCents].every((cents) => Number.isSafeInteger(cents) && cents >= 0);
      if (invoice.total == null || !validAmounts || creditCents > totalCents) return skip("invalid_balance");
      if (totalCents !== creditCents) return skip("balance_due");
      await require("./stripe").assertNoInvoiceChargeReconciliationPending(id, trx);
      if ([invoice.payer_id, invoice.payer_statement_id, invoice.annual_prepay_term_id,
        invoice.stripe_payment_intent_id, invoice.payment_recorded_at].some(Boolean)) {
        return skip("existing_payment_work");
      }
      const payment = await trx("payments").whereIn("status", ["paid", "processing"])
        .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [id]).first("id");
      const plan = await trx("payment_plans").where({ invoice_id: id, status: "active" }).first("id");
      if (payment || plan) return skip("existing_payment_work");
      // Delivery owns the invoice row while its pay link is being handed to a
      // provider. The deposit credit is already durable, so this is a retryable
      // close gap after delivery resolves; it is not evidence of payment work.
      if (invoice.status === "sending") {
        return { ...skip("invoice_delivery_in_flight"), retryable: true };
      }
      const sequence = await trx("invoice_followup_sequences").where({ invoice_id: id }).forUpdate()
        .first("id", "status", "touch_claimed_at");
      if (sequence?.status === "stopped") return skip("collection_stopped");
      // fireStep claims under this same invoice lock, then renders/sends
      // outside its transaction. Let that existing ten-minute lease finish.
      if (new Date(sequence?.touch_claimed_at).getTime() > Date.now() - 10 * 60 * 1000) {
        return { ...skip("followup_in_flight"), retryable: true };
      }
      // The customer row is already locked above (moved ahead of the
      // invoice lock for the lock-order fix, #4131 slice 5) — re-acquiring
      // it here would be a redundant round trip, not a correctness need.
      // Resolve the CANONICAL linked visit before this terminal check
      // (Codex round-3 P1 #4131): invoice.scheduled_service_id alone is
      // null for most post-completion invoices, which carry only
      // service_record_id (migration 20260420000002) — reading it
      // directly silently skipped the terminal-visit refusal for those
      // rows, letting a service-record-only invoice on a cancelled/
      // no-show visit settle to 'prepaid' instead of routing to the void +
      // credit-restore cleanup. Resolved fresh inside this same
      // transaction, before any state change below.
      const canonicalScheduledServiceId = await linkedScheduledServiceId(invoice, trx);
      if (await require("./invoice-helpers").visitRefusesSettlement(trx, canonicalScheduledServiceId)) {
        return skip("visit_never_ran");
      }
      // Codex round-8 audit P1 (#4131 slice 4): a queued pay-link text can
      // already own this invoice's delivery independent of the invoice's
      // OWN status — the queue row is a separate sms_log entry, so the
      // 'sending' in-flight check above never sees it. Lock all three
      // queue types' live rows under THIS SAME row lock — settleZeroBalance
      // is the one place every zero-due settlement path (the send
      // chokepoint, the completion-payment writer, the deposit reconciler)
      // converges, so every caller gets the guarantee.
      //
      // Round 9 (#4634) narrowed what happens next per entry point, after
      // round 8's blanket direct cancel of a still-'scheduled' row proved
      // wrong for two of the three: cancelling dispatch_completion_deferred
      // drops the WHOLE completion/report text (not just the stale pay
      // link) and, worse, bypasses the registry's onTerminal hook — a
      // direct status write here never stamps terminal_pending, so
      // onTerminal never runs, and completionSmsStatus is stranded at
      // 'deferred' forever (the completion dedupe treats that as an owned
      // send) with any bundled review request never re-armed. The same
      // hazard applies to autopay_completion_decline_deferred, which
      // registers its own onTerminal to restore paymentFailedNoticeStatus
      // off 'deferred' for the next attempt. Both now rely entirely on
      // their OWN deferred-replay recheck (invoiceStillCollectible, which
      // already treats 'prepaid' as terminal) to handle staleness AT REPLAY
      // TIME, through the executor's own correct terminal-block path —
      // dispatch_completion_deferred's recheck strips just the pay-link
      // line and still sends the report; autopay_completion_decline_
      // deferred's recheck suppresses the whole notice and its onTerminal
      // runs normally. invoice_send_deferred has no onTerminal to bypass
      // (its own status IS the obligation) and is already cancelled this
      // same direct way elsewhere in this file (consumeQueuedInvoiceSend,
      // an invoice-send retry adopting its own held leg) — cancelling it
      // here too is safe and keeps this the one place that retires it.
      //
      // NOWAIT (round-10 pre-push audit P1): this transaction already holds
      // the invoice and customer rows. Waiting here on an sms_log row that a
      // scheduler worker holds while it goes on to touch the invoice is the
      // exact cross-table cycle lockVisitForSettlement documents; never
      // WAIT on another table while holding the invoice. A held queue row
      // means a worker is claiming that very text right now, which is the
      // same retryable in-flight posture as the status check below. The
      // lock is taken inside a SAVEPOINT (knex nested transaction): a
      // 55P03 aborts the enclosing PG transaction otherwise, and the caller
      // still owns this transaction after a refusal. Row locks acquired in
      // the savepoint survive its release.
      let livePayLinkRows;
      try {
        livePayLinkRows = await trx.transaction((savepoint) => savepoint("sms_log")
          .whereRaw("metadata->>'invoice_id' = ?", [String(id)])
          .whereRaw("metadata->>'entry_point' = ANY(?)", [PAY_LINK_QUEUE_ENTRY_POINTS])
          .whereRaw(LIVE_PAY_LINK_QUEUE_ROW_SQL)
          .forUpdate()
          .noWait()
          .select("id", "status", savepoint.raw("metadata->>'entry_point' as entry_point")));
      } catch (err) {
        if (err?.code !== "55P03") throw err;
        return { ...skip("queued_pay_link_in_flight"), retryable: true };
      }
      if (livePayLinkRows.some((row) => row.status !== "scheduled")) {
        // Already mid-send (a worker claimed it) or delivered-but-
        // unfinalized — same posture as the invoice's own 'sending' check
        // above: a retryable close gap after delivery resolves, not
        // evidence of payment work.
        return { ...skip("queued_pay_link_in_flight"), retryable: true };
      }
      const cancellableRows = livePayLinkRows.filter(
        (row) => row.entry_point === INVOICE_SEND_DEFERRED_ENTRY_POINT,
      );
      if (cancellableRows.length) {
        await trx("sms_log").whereIn("id", cancellableRows.map((row) => row.id)).update({
          status: "cancelled",
          updated_at: trx.fn.now(),
          metadata: trx.raw(
            "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancelled_reason', 'settled_zero_due', 'cancelled_at', ?::text)",
            [new Date().toISOString()],
          ),
        });
      }
      const [settled] = await trx("invoices").where({ id }).update({
        status: "prepaid", prepaid_prev_status: invoice.status,
        prepaid_at: trx.fn.now(), prepaid_by: "system:zero_balance",
        paid_at: trx.fn.now(), updated_at: trx.fn.now(),
      }).returning("*");
      if (sequence) await trx("invoice_followup_sequences").where({ id: sequence.id }).update({
        status: "completed", next_touch_at: null, touch_claimed_at: null, updated_at: trx.fn.now(),
      });
      await require("./audit-log").recordAuditEvent({
        actor_type: "system", action: "invoice.zero_balance_settled",
        resource_type: "invoice", resource_id: id,
        metadata: { previous_status: invoice.status, total_cents: totalCents, credit_applied_cents: creditCents },
        critical: true, trx,
      });
      return { settled: true, reason: null, invoice: settled };
    };
    return database.isTransaction ? run(database) : database.transaction(run);
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
      // Unbind combined siblings from the canceled PI (codex #3427 r16 P2)
      // — coverage-settling one allocated invoice must not strand the rest.
      await require("./pay-combined").clearPaymentIntentStamps(db, triagedPiId, { keepInvoiceIds: [String(id)] });
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
      // The coverage settlement closes the invoice — an active payment plan
      // has nothing left to collect. Same-trx, idempotent (codex r1 P1).
      await require("./payment-plans").completeActivePlansForInvoice(id, trx);
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
  /**
   * Put back the durable per-application setup claim a prepay mint retired
   * (codex #3591 r34 P1). The on-site switch and the secure-plan prepay bill
   * a DIRECT rodent series' unwaived setup on the prepay invoice and retire
   * the series parent's pending_setup_fee so the next completion cannot
   * bill it twice; when that prepay is voided/refunded the fee is owed
   * again and nothing else ever re-stamps it. Keyed by the immutable
   * setup_fee_claims record the mint wrote for the prepay invoice; the
   * record is consumed on restore so a re-run of the cancel sync is a
   * no-op. Re-stamped onto a NULL stamp only — a live or mid-mint claim is
   * never overwritten. Returns the restored descriptor or null.
   */
  /**
   * A STANDARD (non-prepay) invoice carrying the rodent bait-station setup
   * line was voided/refunded while the series lives on (codex #3591 r44
   * P1): the accept billed the setup only as this line — no claim record,
   * no stamp — so the reversal must put the obligation back as a
   * pending_setup_fee stamp on the series anchor or the fee is silently
   * gone. Anchor resolution: the invoice's own scheduled_service_id's root
   * first, else the customer's live direct rodent root. CAS onto a NULL
   * stamp only. UNEXPECTED failures PROPAGATE (codex #3591 r46 local P0):
   * the caller's transaction rolls back and the void/refund retries, so a
   * transient blip can never commit a reversal that lost the obligation.
   * Deliberate data-states (no setup line, prepay claims-ledger row,
   * occupied stamp, no rodent anchor) return null — no-anchor pages a
   * human rather than wedging the reversal forever. Prepay invoices are
   * the claims ledger's job and are skipped here.
   */
  async restoreRodentSetupObligationForReversedInvoice(conn, invoiceRow) {
    if (!invoiceRow || !invoiceRow.customer_id) return null;
    // Durable claim FIRST (codex #3591 r55 P1): the claims-ledger row is
    // immutable provenance — a staff-renamed line must not hide the setup
    // from its own reversal. The editable description only decides for
    // claim-less invoices (unsent accept drafts).
    let completionClaimToConsume = null;
    const claimRecord = await conn("setup_fee_claims").where({ invoice_id: invoiceRow.id }).first("id", "amount", "scheduled_service_id");
    let lines = invoiceRow.line_items;
    if (typeof lines === "string") { try { lines = JSON.parse(lines); } catch { lines = []; } }
    const setupLine = (Array.isArray(lines) ? lines : []).find((li) => /^Bait Station Setup — one-time setup fee$/.test(String(li?.description || "").trim()));
    const lineAmount = Math.round(Number(setupLine?.amount ?? setupLine?.unit_price) * 100) / 100;
    const claimAmount = claimRecord ? Math.round(Number(claimRecord.amount) * 100) / 100 : NaN;
    const amount = Number.isFinite(claimAmount) && claimAmount > 0 ? claimAmount : lineAmount;
    if (!(amount > 0)) return null;
    if (!setupLine && !claimRecord) return null;
    if (claimRecord) {
      // Only TERM-BACKED prepay claims restore through the claims-ledger
      // sync (codex #3591 r48 P1) — a COMPLETION invoice writes a claim
      // record too (crash-resume evidence, admin-dispatch), and its
      // reversal must put the stamp back HERE, consuming the record.
      const termBacked = await conn("annual_prepay_terms").where({ prepay_invoice_id: invoiceRow.id }).first("id");
      if (termBacked) return null; // prepay lane — restored via the claims ledger
      // Consumed only AFTER a successful re-stamp/re-bill (codex #3591 r53
      // local P0): an ambiguous or failed restore keeps the durable
      // evidence for retry / manual reconciliation.
      completionClaimToConsume = claimRecord.id;
    }
    const { authoritativeServiceKey } = require("./secure-appointment-plans");
    // The claim's anchored series is provenance (codex #3591 r69 P1): the
    // standard/invoice-mode accept mints record the exact rodent root, so an
    // unattached invoice (or one attached to a non-rodent first visit) on a
    // customer with several rodent series restores onto THAT root instead of
    // paging on the account-wide scan's ambiguity.
    let anchorId = claimRecord?.scheduled_service_id || null;
    if (!anchorId && invoiceRow.scheduled_service_id) {
      const own = await conn("scheduled_services")
        .where({ id: invoiceRow.scheduled_service_id })
        .first("id", "recurring_parent_id", "service_type", "service_id");
      const root = own && own.recurring_parent_id
        ? await conn("scheduled_services").where({ id: own.recurring_parent_id }).first("id", "service_type", "service_id")
        : own;
      if (root && require("./secure-appointment-plans").isRodentBaitProgramKey(await authoritativeServiceKey(conn, root))) anchorId = root.id;
    }
    if (!anchorId) {
      // Shared liveness predicate, not a status filter (codex #3591 r73
      // P1): a cancelled root with a live child can still consume the
      // restored stamp — the same rule every carried-setup probe uses.
      const { seriesCanStillConsume } = require("./secure-appointment-plans");
      const roots = await conn("scheduled_services")
        .where({ customer_id: invoiceRow.customer_id })
        .whereNull("recurring_parent_id")
        .select("id", "service_type", "service_id", "status");
      const baitRoots = [];
      for (const root of roots || []) {
        if (!(await seriesCanStillConsume(conn, root))) continue;
        if (require("./secure-appointment-plans").isRodentBaitProgramKey(await authoritativeServiceKey(conn, root))) baitRoots.push(root.id);
      }
      // A UNIQUE match only (codex #3591 r51 local P0): a customer with
      // multiple rodent series must never have an unrelated series'
      // stamp/claim mutated — ambiguity stays anchor-less/paged.
      if (baitRoots.length === 1) anchorId = baitRoots[0];
    }
    if (!anchorId) {
      logger.error(`[invoice] FIX: reversed invoice ${invoiceRow.id} billed a $${amount.toFixed(2)} bait-station setup but no rodent series anchor was found — re-bill the setup manually`);
      return null;
    }
    // Same billable-visit guard as the prepay restoration (codex #3591 r45
    // P1): a stamp on a series with no future completion is inert — mint a
    // collectible DRAFT re-bill instead.
    const anchorRow = await conn("scheduled_services").where({ id: anchorId }).first("id", "status", "pending_setup_fee");
    let billable = ["pending", "confirmed", "rescheduled"].includes(String(anchorRow?.status || "").toLowerCase());
    if (!billable) {
      const liveChild = await conn("scheduled_services")
        .where({ recurring_parent_id: anchorId })
        .whereIn("status", ["pending", "confirmed", "rescheduled"])
        .first("id");
      billable = !!liveChild;
    }
    if (!billable) {
      const reInvoice = await this.create({
        database: conn,
        customerId: invoiceRow.customer_id,
        title: "Bait Station Setup",
        lineItems: [{
          description: "Bait Station Setup — one-time setup fee",
          quantity: 1,
          unit_price: amount,
          category: "Setup fee",
        }],
        notes: `Re-billed after invoice ${invoiceRow.id} was voided/refunded — the series has no future visit left to collect the setup on (visit ${anchorId}). ${rodentSetupRebillMarker(invoiceRow.id)}`,
        dueDate: etDateString(),
      });
      if (completionClaimToConsume) await conn("setup_fee_claims").where({ id: completionClaimToConsume }).delete();
      logger.info(`[invoice] reversed invoice ${invoiceRow.id}: setup re-billed as draft ${reInvoice?.invoice_number || reInvoice?.id} — dead series ${anchorId}`);
      return { scheduledServiceId: anchorId, amount, reInvoiceId: reInvoice?.id || null };
    }
    const stamped = await conn("scheduled_services")
      .where({ id: anchorId })
      .whereNull("pending_setup_fee")
      .update({ pending_setup_fee: amount, updated_at: new Date() });
    if (stamped !== 1) {
      logger.warn(`[invoice] reversed invoice ${invoiceRow.id}: rodent setup NOT re-stamped on series ${anchorId} (stamp occupied) — obligation already tracked`);
      return null;
    }
    // The claim is KEPT on the stamp path (codex #3591 r74 P1): unlike the
    // rebill branch (whose replacement invoice carries the durable
    // rodentSetupRebillMarker), a restored stamp leaves no other provenance
    // linking it to this invoice — a later refund failure/unvoid on a
    // STAFF-RENAMED setup line could then never retire the restored stamp
    // and both charges would go live. The kept row is inert while the
    // invoice is terminal (settledSetupClaimForInvoice and the anchor-claim
    // probes apply the live-invoice rule), re-entry stays idempotent (the
    // occupied-stamp CAS above refuses), and the reinstatement retires the
    // stamp from exactly this record.
    logger.info(`[invoice] rodent setup obligation restored on series ${anchorId} ($${amount.toFixed(2)}) — invoice ${invoiceRow.id} reversed (claim kept as reinstatement provenance)`);
      return { scheduledServiceId: anchorId, amount };
  },

  /**
   * A refunded/disputed prepay that billed the rodent setup was REVIVED
   * (re-paid / dispute won back) after the refund sync restored the
   * per-application claim (codex #3591 r45 local P0): the prepay's own
   * setup line is live again, so the restored stamp must be retired and
   * the claims-ledger record recreated — or the next completion bills the
   * setup a SECOND time. Idempotent (record insert is onConflict-ignored;
   * stamp CAS by exact value). Unexpected failures PROPAGATE so the
   * revival sync retries (codex #3591 r46 local P0); a missing anchor or
   * mid-mint stamp pages a human instead of wedging the revival.
   */
  // The lost-dispute cancel re-minted the switch-superseded per-application
  // invoice (prepay-switch-restore marker) — a REVIVED prepay's coverage
  // makes that restored AR a duplicate (codex #3591 r54 P1): void the
  // untouched/unpaid restorations; money attached pages a human.
  async _retireSwitchRestoredInvoicesForRevivedPrepay(conn, prepayInvoiceId) {
    const restored = await conn("invoices")
      .whereIn("id", function restoredIds() {
        // restored rows carry prepaySwitchRestoreMarker(<voidedId>) where the
        // VOIDED row's notes carry the superseded-by marker for THIS prepay.
        this.select(conn.raw("i2.id"))
          .from({ i2: "invoices" })
          .join({ v: "invoices" }, conn.raw("i2.notes like '%[prepay-switch-restore:' || v.id || ']%'"))
          .where("v.notes", "like", `%[prepay-switch-superseded-by:${prepayInvoiceId}]%`);
      })
      .whereNotIn("status", ["void", "cancelled", "canceled", "refunded"])
      .select("id", "status", "sent_at", "paid_at", "payment_recorded_at", "stripe_payment_intent_id", "payer_statement_id", "credit_applied");
    let voided = 0;
    for (const inv of restored || []) {
      const moneyAttached = inv.paid_at || inv.payment_recorded_at || inv.stripe_payment_intent_id
        || inv.payer_statement_id || Number(inv.credit_applied) > 0
        || ["paid", "prepaid", "processing"].includes(String(inv.status).toLowerCase());
      if (!moneyAttached) {
        voided += await conn("invoices")
          .where({ id: inv.id, status: inv.status })
          .whereNull("paid_at").whereNull("payment_recorded_at").whereNull("stripe_payment_intent_id").whereNull("payer_statement_id").where(function creditFree() { this.whereNull("credit_applied").orWhere("credit_applied", 0); })
          .update({ status: "void", send_claim_token: null, updated_at: new Date() });
      } else {
        logger.error(`[invoice] FIX: revived prepay ${prepayInvoiceId}: switch-restored invoice ${inv.id} has money attached (${inv.status}) — refund/reconcile so the coverage is not collected twice`);
      }
    }
    if (voided) logger.info(`[invoice] revived prepay ${prepayInvoiceId}: ${voided} switch-restored per-application invoice(s) voided — coverage is prepaid again`);
    return voided;
  },

  async retireRodentSetupObligationForRevivedPrepay(conn, prepayInvoiceId) {
    if (!prepayInvoiceId) return null;
    const invoiceRow = await conn("invoices")
      .where({ id: prepayInvoiceId })
      .first("id", "customer_id", "scheduled_service_id", "line_items");
    if (!invoiceRow) return null;
    let lines = invoiceRow.line_items;
    if (typeof lines === "string") { try { lines = JSON.parse(lines); } catch { lines = []; } }
    const setupLine = (Array.isArray(lines) ? lines : []).find((li) => /^Bait Station Setup — one-time setup fee$/.test(String(li?.description || "").trim()));
    let amount = Math.round(Number(setupLine?.amount ?? setupLine?.unit_price) * 100) / 100;
    const { authoritativeServiceKey, recordSetupFeeClaimForInvoice } = require("./secure-appointment-plans");
    let anchorId = null;
    if (invoiceRow.scheduled_service_id) {
      const own = await conn("scheduled_services")
        .where({ id: invoiceRow.scheduled_service_id })
        .first("id", "recurring_parent_id", "service_type", "service_id");
      const root = own && own.recurring_parent_id
        ? await conn("scheduled_services").where({ id: own.recurring_parent_id }).first("id", "service_type", "service_id")
        : own;
      if (root && require("./secure-appointment-plans").isRodentBaitProgramKey(await authoritativeServiceKey(conn, root))) anchorId = root.id;
    }
    let accountBaitRoots = [];
    if (!anchorId) {
      // Liveness via the shared predicate, not a status filter (codex #3591
      // r73 P1): a cancelled root whose child can still complete is still
      // the series that carries/collected the setup — dropping it by status
      // would re-ledger the claim anchor-less while its restored stamp
      // stays collectible.
      const { seriesCanStillConsume } = require("./secure-appointment-plans");
      const roots = await conn("scheduled_services")
        .where({ customer_id: invoiceRow.customer_id })
        .whereNull("recurring_parent_id")
        .select("id", "service_type", "service_id", "pending_setup_fee", "status");
      for (const root of roots || []) {
        if (!(await seriesCanStillConsume(conn, root))) continue;
        if (require("./secure-appointment-plans").isRodentBaitProgramKey(await authoritativeServiceKey(conn, root))) accountBaitRoots.push(root);
      }
      // A UNIQUE match only (codex #3591 r51 local P0): a customer with
      // multiple rodent series must never have an unrelated series'
      // stamp/claim mutated — ambiguity stays anchor-less/paged.
      if (accountBaitRoots.length === 1) anchorId = accountBaitRoots[0].id;
    }
    if (!setupLine || !(amount > 0)) {
      // Renamed/repriced setup line (codex #3591 r71 P1): the refund's
      // restore stamped the anchor with the consumed claim's EXACT amount —
      // that restored stamp is the surviving provenance, so the revival
      // retires it (and re-ledgers the claim) from the stamp instead of
      // returning early and leaving both the stamp and the revived
      // invoice's setup collectible.
      let stampedAmount = null;
      if (anchorId) {
        const probe = await conn("scheduled_services").where({ id: anchorId }).first("pending_setup_fee");
        const v = Number(probe?.pending_setup_fee);
        if (v > 0) stampedAmount = Math.round(v * 100) / 100;
      } else {
        const stampedRoots = accountBaitRoots.filter((root) => Number(root.pending_setup_fee) > 0);
        if (stampedRoots.length === 1) {
          anchorId = stampedRoots[0].id;
          stampedAmount = Math.round(Number(stampedRoots[0].pending_setup_fee) * 100) / 100;
        }
      }
      // No stamp either (codex #3591 r75 P1): a refund on a series with no
      // billable visits minted a marker-keyed replacement draft and consumed
      // the claim instead of stamping — the live replacement is the
      // surviving provenance. Fall back to its line amount and continue so
      // the marker sweep below voids it and the claim is re-ledgered;
      // otherwise the revived prepay and the replacement both collect.
      if (!(stampedAmount > 0)) {
        const markerRebill = await conn("invoices")
          .where("notes", "like", `%${rodentSetupRebillMarker(prepayInvoiceId)}%`)
          .whereNotIn("status", ["void", "cancelled", "canceled", "refunded"])
          .first("id", "line_items");
        let rbLines = markerRebill?.line_items;
        if (typeof rbLines === "string") { try { rbLines = JSON.parse(rbLines); } catch { rbLines = []; } }
        const rbAmount = Math.round(Number(rbLines?.[0]?.amount ?? rbLines?.[0]?.unit_price) * 100) / 100;
        if (!(rbAmount > 0)) return null;
        logger.warn(`[invoice] revived prepay ${prepayInvoiceId}: setup line missing/renamed and no stamp — retiring the live $${rbAmount.toFixed(2)} replacement draft from its rebill marker`);
        amount = rbAmount;
      } else {
        logger.warn(`[invoice] revived prepay ${prepayInvoiceId}: setup line missing/renamed — retiring the restored $${stampedAmount.toFixed(2)} stamp on series ${anchorId} from claim provenance`);
        amount = stampedAmount;
      }
    }
    // (sibling-completion retire happens after anchor resolution below)
    // The marker sweep runs regardless of an anchor (codex #3591 r47 P1):
    // a cancelled-root series still minted a replacement draft on the
    // refund, and the revived prepay's own line is live again.
    const voidedRebills = await InvoiceService._voidUntouchedRodentSetupRebills(conn, prepayInvoiceId);
    if (!anchorId) {
      // Ledger the claim anchor-less (the restore resolves an anchor from
      // the term's provenance later) so a future re-refund still restores.
      await recordSetupFeeClaimForInvoice(conn, { invoiceId: prepayInvoiceId, anchorId: null, amount });
      logger.info(`[invoice] revived prepay ${prepayInvoiceId}: no live rodent anchor (series cancelled?) — claim re-ledgered anchor-less${voidedRebills ? `, ${voidedRebills} replacement draft(s) voided` : ""}`);
      return { scheduledServiceId: null, amount, retired: false };
    }
    // SERIALIZED with completion (codex #3591 r46 P1): the parent is read
    // FOR UPDATE so a technician's in-flight claim (negative stamp) cannot
    // slip between an unlocked read and the CAS. A mid-claim stamp FAILS
    // the revival — the sync rolls back and the event retries after the
    // completion settles, instead of double-billing the setup.
    // Taken BEFORE the sibling scan (codex #3591 r52 P1): a completion
    // claiming/clearing the stamp between an unlocked scan and this lock
    // would hide its freshly minted sibling from the reconciliation.
    const parent = await conn("scheduled_services").where({ id: anchorId }).forUpdate().first("id", "pending_setup_fee");
    const stamp = parent?.pending_setup_fee != null ? Number(parent.pending_setup_fee) : null;
    if (stamp != null && stamp < 0) {
      throw new Error(`revived prepay ${prepayInvoiceId}: series ${anchorId} has a completion mid-claim — retrying after it settles`);
    }
    // A COMPLETION billed this setup while the prepay was dead (the
    // negative-marker retry path — codex #3591 r48 P1): its claim record
    // sits on the same anchor. The revived prepay's own line is live again,
    // so an untouched DRAFT completion setup invoice is voided (claim
    // consumed); anything sent/paid pages a human.
    const siblingClaims = await conn("setup_fee_claims")
      .where({ scheduled_service_id: anchorId })
      .whereNot({ invoice_id: prepayInvoiceId })
      .select("id", "invoice_id");
    for (const sc of siblingClaims || []) {
      const sib = await conn("invoices")
        .where({ id: sc.invoice_id })
        .first("id", "status", "sent_at", "paid_at", "payment_recorded_at", "stripe_payment_intent_id", "payer_statement_id", "credit_applied");
      const sibTerminal = sib && ["void", "cancelled", "canceled", "refunded"].includes(String(sib.status).toLowerCase());
      const moneyAttached = !sib || sib.paid_at || sib.payment_recorded_at || sib.stripe_payment_intent_id
        || sib.payer_statement_id || Number(sib.credit_applied) > 0
        || ["paid", "prepaid", "processing"].includes(String(sib?.status).toLowerCase());
      if (sib && sibTerminal) {
        await conn("setup_fee_claims").where({ id: sc.id }).delete();
      } else if (!moneyAttached) {
        // Unpaid — sent included (codex #3591 r49 local P0): a live pay
        // link on the duplicate is a double charge waiting. The claim is
        // consumed ONLY when the guarded void wins (codex #3591 r50 P1) —
        // a lost CAS means money arrived mid-flight and a human reconciles.
        const sibVoided = await conn("invoices")
          .where({ id: sib.id, status: sib.status })
          .whereNull("paid_at").whereNull("payment_recorded_at").whereNull("stripe_payment_intent_id").whereNull("payer_statement_id").where(function creditFree() { this.whereNull("credit_applied").orWhere("credit_applied", 0); })
          .update({ status: "void", send_claim_token: null, updated_at: new Date() });
        if (sibVoided === 1) {
          await conn("setup_fee_claims").where({ id: sc.id }).delete();
          logger.info(`[invoice] revived prepay ${prepayInvoiceId}: completion setup invoice ${sib.id} voided (its claim consumed) — the prepay's own setup line is live again`);
        } else {
          logger.error(`[invoice] FIX: revived prepay ${prepayInvoiceId}: completion setup invoice ${sib.id} gained a payment anchor mid-void — refund/reconcile so the setup is not collected twice (claim kept)`);
        }
      } else {
        logger.error(`[invoice] FIX: revived prepay ${prepayInvoiceId}: invoice ${sc.invoice_id} also carries this series' setup claim with money attached (${sib ? sib.status : "unreadable"}) — refund/reconcile so the setup is not collected twice`);
      }
    }
    await recordSetupFeeClaimForInvoice(conn, { invoiceId: prepayInvoiceId, anchorId, amount });
    let retired = 0;
    if (stamp != null && stamp > 0) {
      retired = await conn("scheduled_services")
        .where({ id: anchorId, pending_setup_fee: parent.pending_setup_fee })
        .update({ pending_setup_fee: null, updated_at: new Date() });
    }
    logger.info(`[invoice] revived prepay ${prepayInvoiceId}: setup claim re-ledgered on series ${anchorId}${retired === 1 ? ", restored stamp retired" : ""}${voidedRebills ? `, ${voidedRebills} replacement draft(s) voided` : ""}`);
    return { scheduledServiceId: anchorId, amount, retired: retired === 1 };
  },

  /**
   * The refund BOUNCED / the debit reversal failed and the invoice is
   * leaving 'refunded' (codex #3591 r47 local P0): Stripe kept the money,
   * so the refunded-transition side effects — the restored
   * pending_setup_fee stamp and/or the draft re-bill — must be retired
   * with the flip or the setup collects twice. Exact-value CAS only (a
   * stamp that no longer equals the setup line is someone else's claim —
   * paged, never clobbered); untouched draft re-bills are voided, anything
   * sent/paid pages a human. Prepay invoices (claims-ledger row) are the
   * term sync's job and are skipped. Unexpected failures PROPAGATE so the
   * unwind retries.
   */
  // Void every UNPAID replacement carrying the re-bill marker for
  // `sourceInvoiceId` — sent-but-unpaid included (codex #3591 r49 local
  // P0: a live pay link on a duplicate setup is a double charge waiting;
  // the voided pay page reads "no longer payable"). Only a replacement
  // with MONEY attached (paid, payment recorded, or a PaymentIntent in
  // flight) pages a human for an explicit refund/reconcile. Returns the
  // voided count. Shared by the prepay revival and the reinstated-invoice
  // cleanup (codex #3591 r46/r47 P1).
  async _voidUntouchedRodentSetupRebills(conn, sourceInvoiceId) {
    const rebills = await conn("invoices")
      .where("notes", "like", `%${rodentSetupRebillMarker(sourceInvoiceId)}%`)
      .whereNotIn("status", ["void", "cancelled", "canceled", "refunded"])
      .select("id", "status", "sent_at", "paid_at", "payment_recorded_at", "stripe_payment_intent_id", "payer_statement_id", "credit_applied");
    let voided = 0;
    for (const rb of rebills || []) {
      // A payer-statement accrual counts as money attached (codex #3591 r50
      // P1): a direct status flip would leave the statement charging the
      // voided duplicate — that reconciliation is a human's.
      const moneyAttached = rb.paid_at || rb.payment_recorded_at || rb.stripe_payment_intent_id
        || rb.payer_statement_id || Number(rb.credit_applied) > 0
        || ["paid", "prepaid", "processing"].includes(String(rb.status).toLowerCase());
      if (!moneyAttached) {
        voided += await conn("invoices")
          .where({ id: rb.id, status: rb.status })
          .whereNull("paid_at").whereNull("payment_recorded_at").whereNull("stripe_payment_intent_id").whereNull("payer_statement_id").where(function creditFree() { this.whereNull("credit_applied").orWhere("credit_applied", 0); })
          .update({ status: "void", send_claim_token: null, updated_at: new Date() });
      } else {
        logger.error(`[invoice] FIX: replacement setup invoice ${rb.id} for reversed invoice ${sourceInvoiceId} has money attached (${rb.status}) — refund/reconcile so the setup is not collected twice`);
      }
    }
    return voided;
  },

  async retireRodentSetupObligationForReinstatedInvoice(conn, invoiceId, { strict = false } = {}) {
    if (!invoiceId) return null;
    const invoiceRow = await conn("invoices")
      .where({ id: invoiceId })
      .first("id", "customer_id", "scheduled_service_id", "line_items");
    if (!invoiceRow) return null;
    // Durable claim FIRST (codex #3591 r64 P1), the same provenance rule the
    // reversal applies: the claims-ledger row is immutable, while the line
    // description/amount are staff-editable — a renamed or repriced
    // completion invoice must still retire exactly the stamp its reversal
    // restored, or the restored stamp / replacement invoice stays
    // collectible as a second charge once the webhook re-flips this one to
    // paid. The editable line decides only for claim-less invoices.
    const claimRecord = await conn("setup_fee_claims").where({ invoice_id: invoiceRow.id }).first("id", "amount", "scheduled_service_id");
    let lines = invoiceRow.line_items;
    if (typeof lines === "string") { try { lines = JSON.parse(lines); } catch { lines = []; } }
    const setupLine = (Array.isArray(lines) ? lines : []).find((li) => /^Bait Station Setup — one-time setup fee$/.test(String(li?.description || "").trim()));
    const lineAmount = Math.round(Number(setupLine?.amount ?? setupLine?.unit_price) * 100) / 100;
    const claimAmount = claimRecord ? Math.round(Number(claimRecord.amount) * 100) / 100 : NaN;
    // No claim and no recognizable line (codex #3591 r74 P1): the dead-series
    // reversal consumed the claim after minting its replacement draft, and a
    // staff-renamed line hides the setup from the editable text — but the
    // replacement carries the durable rodentSetupRebillMarker keyed to THIS
    // invoice. A live replacement is the surviving provenance: retire from
    // its line amount so the reinstated invoice becomes the only carrier.
    // (The stamp-restore path keeps its claim since r74, so it resolves
    // through claimRecord above.)
    let markerRebillAmount = null;
    if (!setupLine && !claimRecord) {
      const markerRebill = await conn("invoices")
        .where("notes", "like", `%${rodentSetupRebillMarker(invoiceRow.id)}%`)
        .whereNotIn("status", ["void", "cancelled", "canceled", "refunded"])
        .first("id", "line_items");
      if (!markerRebill) return null;
      let rbLines = markerRebill.line_items;
      if (typeof rbLines === "string") { try { rbLines = JSON.parse(rbLines); } catch { rbLines = []; } }
      const rbAmount = Math.round(Number(rbLines?.[0]?.amount ?? rbLines?.[0]?.unit_price) * 100) / 100;
      if (rbAmount > 0) markerRebillAmount = rbAmount;
    }
    const amount = Number.isFinite(claimAmount) && claimAmount > 0
      ? claimAmount
      : (markerRebillAmount ?? lineAmount);
    if (!(amount > 0)) return null;
    if (claimRecord) {
      // Term-backed prepay claims are the term sync's revival's job; a
      // COMPLETION invoice's own claim rides its reinstatement here
      // (codex #3591 r48 P1 — claims are not prepay-only).
      const termBacked = await conn("annual_prepay_terms").where({ prepay_invoice_id: invoiceRow.id }).first("id");
      if (termBacked) return null;
    }
    const { authoritativeServiceKey } = require("./secure-appointment-plans");
    // The claim's own anchor is provenance too — the series the mint
    // consumed the stamp from — so it outranks the invoice's (editable)
    // visit link and the customer-wide root scan.
    let anchorId = claimRecord?.scheduled_service_id || null;
    if (!anchorId && invoiceRow.scheduled_service_id) {
      const own = await conn("scheduled_services")
        .where({ id: invoiceRow.scheduled_service_id })
        .first("id", "recurring_parent_id", "service_type", "service_id");
      const root = own && own.recurring_parent_id
        ? await conn("scheduled_services").where({ id: own.recurring_parent_id }).first("id", "service_type", "service_id")
        : own;
      if (root && require("./secure-appointment-plans").isRodentBaitProgramKey(await authoritativeServiceKey(conn, root))) anchorId = root.id;
    }
    if (!anchorId) {
      // Shared liveness predicate, not a status filter (codex #3591 r73
      // P1): a cancelled root with a live child can still consume — same
      // rule as the revival lookup above.
      const { seriesCanStillConsume } = require("./secure-appointment-plans");
      const roots = await conn("scheduled_services")
        .where({ customer_id: invoiceRow.customer_id })
        .whereNull("recurring_parent_id")
        .select("id", "service_type", "service_id", "status");
      const baitRoots = [];
      for (const root of roots || []) {
        if (!(await seriesCanStillConsume(conn, root))) continue;
        if (require("./secure-appointment-plans").isRodentBaitProgramKey(await authoritativeServiceKey(conn, root))) baitRoots.push(root.id);
      }
      // A UNIQUE match only (codex #3591 r51 local P0): a customer with
      // multiple rodent series must never have an unrelated series'
      // stamp/claim mutated — ambiguity stays anchor-less/paged.
      if (baitRoots.length === 1) anchorId = baitRoots[0];
    }
    let retired = 0;
    if (anchorId) {
      const parent = await conn("scheduled_services").where({ id: anchorId }).forUpdate().first("id", "pending_setup_fee");
      const stamp = parent?.pending_setup_fee != null ? Number(parent.pending_setup_fee) : null;
      if (stamp != null && stamp < 0) {
        // A completion is mid-claim on this very setup (codex #3591 r48
        // P1): committing through would leave both charges live. Throwing
        // aborts a staff unvoid outright; the webhook flip retries after
        // the completion settles.
        throw new Error(`invoice ${invoiceRow.id}: series ${anchorId} has a completion mid-claim on the setup — retry after it settles`);
      }
      // A SIBLING claim on the same series (another invoice collected the
      // setup while this one was reversed — codex #3591 r48 P1):
      // reinstating this invoice would make the fee doubly collectible.
      // Strict (staff unvoid) refuses; the automated flip pages a human
      // and proceeds (a poisoned webhook retry loop is worse than a paged
      // reconcile).
      // EVERY sibling claim is reconciled, not just an unordered first
      // (codex #3591 r85 P1): a series reversed more than once can carry
      // several sibling claims — an old terminal one AND a later paid
      // one. Processing only the first could delete the terminal claim
      // and retire the stamp while the paid sibling stays silently
      // collectible alongside the reinstated invoice. Same per-sibling
      // disposition as the prepay-revival loop above.
      const siblingClaims = await conn("setup_fee_claims")
        .where({ scheduled_service_id: anchorId })
        .whereNot({ invoice_id: invoiceRow.id })
        .select("id", "invoice_id");
      for (const siblingClaim of siblingClaims || []) {
        // An UNPAID sibling is retired automatically (codex #3591 r49
        // local P0) — the reinstated invoice becomes THE setup carrier;
        // only money attached needs a human refund/reconcile.
        const sib = await conn("invoices")
          .where({ id: siblingClaim.invoice_id })
          .first("id", "status", "paid_at", "payment_recorded_at", "stripe_payment_intent_id", "payer_statement_id", "credit_applied");
        const sibTerminal = sib && ["void", "cancelled", "canceled", "refunded"].includes(String(sib.status).toLowerCase());
        const moneyAttached = !sib || sib.paid_at || sib.payment_recorded_at || sib.stripe_payment_intent_id
          || sib.payer_statement_id || Number(sib.credit_applied) > 0
          || ["paid", "prepaid", "processing"].includes(String(sib?.status).toLowerCase());
        if (sib && sibTerminal) {
          await conn("setup_fee_claims").where({ id: siblingClaim.id }).delete();
        } else if (!moneyAttached) {
          const sibVoided = await conn("invoices")
            .where({ id: sib.id, status: sib.status })
            .whereNull("paid_at").whereNull("payment_recorded_at").whereNull("stripe_payment_intent_id").whereNull("payer_statement_id").where(function creditFree() { this.whereNull("credit_applied").orWhere("credit_applied", 0); })
            .update({ status: "void", send_claim_token: null, updated_at: new Date() });
          if (sibVoided === 1) {
            await conn("setup_fee_claims").where({ id: siblingClaim.id }).delete();
            logger.info(`[invoice] invoice ${invoiceRow.id} reinstated — sibling setup invoice ${sib.id} voided (claim consumed) so the fee is carried once`);
          } else if (strict) {
            throw new Error(`Cannot restore invoice ${invoiceRow.id} — sibling setup invoice ${sib.id} gained a payment anchor mid-void; reconcile which invoice carries the fee first`);
          } else {
            logger.error(`[invoice] FIX: invoice ${invoiceRow.id} left 'refunded' but sibling setup invoice ${sib.id} gained a payment anchor mid-void — refund/reconcile so the setup is not collected twice (claim kept)`);
          }
        } else if (strict) {
          throw new Error(`Cannot restore invoice ${invoiceRow.id} — invoice ${siblingClaim.invoice_id} already collected this series' bait-station setup; reconcile which invoice carries the fee first`);
        } else {
          logger.error(`[invoice] FIX: invoice ${invoiceRow.id} left 'refunded' but invoice ${siblingClaim.invoice_id} also carries this series' setup claim with money attached — refund/reconcile so the setup is not collected twice`);
        }
      }
      if (stamp != null && Math.round(stamp * 100) === Math.round(amount * 100)) {
        retired = await conn("scheduled_services")
          .where({ id: anchorId, pending_setup_fee: parent.pending_setup_fee })
          .update({ pending_setup_fee: null, updated_at: new Date() });
      } else if (stamp != null && stamp !== 0) {
        logger.error(`[invoice] FIX: invoice ${invoiceRow.id} left 'refunded' but series ${anchorId} carries a $${stamp} stamp that is not its $${amount.toFixed(2)} setup — reconcile so the setup is not collected twice`);
      }
    }
    const voidedRebills = await InvoiceService._voidUntouchedRodentSetupRebills(conn, invoiceRow.id);
    if (retired || voidedRebills) {
      logger.info(`[invoice] refund-bounce cleanup for invoice ${invoiceRow.id}: ${retired ? "restored setup stamp retired" : ""}${retired && voidedRebills ? ", " : ""}${voidedRebills ? `${voidedRebills} replacement draft(s) voided` : ""}`);
    }
    return { retired: retired === 1, voidedRebills };
  },

  async restoreRetiredSetupFeeClaimForPrepay(prepayInvoiceId, conn = db, { sourceEstimateId = null, customerId = null, coverageServiceType = null } = {}) {
    if (!prepayInvoiceId) return null;
    // Re-stamp + record consume run in ONE transaction with the record
    // locked (codex #3591 r40 P1): an autocommitted re-stamp followed by a
    // failed delete would leave a live fee AND a live record, and the next
    // re-entry (a repeated refund sync) would restore — and bill — it again.
    const run = async (trx) => this._restoreRetiredSetupFeeClaimLocked(trx, prepayInvoiceId, { sourceEstimateId, customerId, coverageServiceType });
    return typeof conn.transaction === "function" && !conn.isTransaction
      ? conn.transaction(run)
      : run(conn);
  },

  async _restoreRetiredSetupFeeClaimLocked(conn, prepayInvoiceId, { sourceEstimateId = null, customerId = null, coverageServiceType = null } = {}) {
    const claim = await conn("setup_fee_claims")
      .where({ invoice_id: prepayInvoiceId })
      .forUpdate()
      .first("id", "scheduled_service_id", "amount");
    if (!claim) return null;
    const amount = Math.round(Number(claim.amount) * 100) / 100;
    if (!(amount > 0)) return null;
    // An ANCHOR-LESS record (codex #3591 r39 P1): the estimate-accept prepay
    // billed the setup before any series existed (manual Mark Won seeds the
    // series later). Resolve the rodent root NOW from the term's source
    // estimate; with no root to carry the obligation the record is kept and
    // a human is paged — the fee is owed and nothing else re-stamps it.
    let anchorId = claim.scheduled_service_id || null;
    if (!anchorId) {
      const { authoritativeServiceKey } = require("./secure-appointment-plans");
      // Liveness per root through the shared consumable-series predicate
      // (codex #3591 r69 P1): a CANCELLED root whose pending/confirmed child
      // remains is still the series the refunded setup restores onto — a
      // status filter here left the claim anchor-less and the child
      // completed without the $99.
      const { seriesCanStillConsume } = require("./secure-appointment-plans");
      if (sourceEstimateId) {
        const roots = await conn("scheduled_services")
          .where({ source_estimate_id: sourceEstimateId })
          .whereNull("recurring_parent_id")
          .select("id", "service_type", "service_id", "status");
        // EXACTLY ONE rodent root or refuse (codex #3591 r61 P1): with two
        // live rodent roots linked to the same estimate, first-returned
        // ordering would re-stamp an arbitrary series and consume the
        // immutable claim record against it — the same unique-anchor rule
        // the neighboring reversal/revival paths enforce. Ambiguity keeps
        // the claim anchor-less and pages for reconciliation.
        const estimateRodentRootIds = [];
        for (const root of roots || []) {
          if (!(await seriesCanStillConsume(conn, root))) continue;
          if (require("./secure-appointment-plans").isRodentBaitProgramKey(await authoritativeServiceKey(conn, root))) estimateRodentRootIds.push(root.id);
        }
        if (estimateRodentRootIds.length > 1) {
          logger.error(`[invoice] FIX: anchor-less setup-fee claim for prepay ${prepayInvoiceId} matches ${estimateRodentRootIds.length} live rodent roots on estimate ${sourceEstimateId} (${estimateRodentRootIds.join(", ")}) — pick the series that owes the $${amount.toFixed(2)} bait-station setup and restore it manually (record kept)`);
          return null;
        }
        if (estimateRodentRootIds.length === 1) anchorId = estimateRodentRootIds[0];
      }
      // A Customer 360 prepay sold before any series existed (codex #3591
      // r41 P1): the term's coverage names the DIRECT series the renewals
      // seeding created afterwards.
      if (!anchorId && customerId && coverageServiceType) {
        const { serviceMatchesCoverage } = require("./annual-prepay-renewals");
        const roots = await conn("scheduled_services")
          .where({ customer_id: customerId })
          .whereNull("recurring_parent_id")
          .select("id", "service_type", "service_id", "source_estimate_id", "status");
        // Same unique-anchor rule as the estimate path above (codex #3591
        // r61 P1): coverage matching two live direct rodent roots must not
        // restore onto whichever Postgres returned first.
        const coverageRodentRootIds = [];
        for (const root of roots || []) {
          if (root.source_estimate_id || !serviceMatchesCoverage(root, coverageServiceType)) continue;
          if (!(await seriesCanStillConsume(conn, root))) continue;
          if (require("./secure-appointment-plans").isRodentBaitProgramKey(await authoritativeServiceKey(conn, root))) coverageRodentRootIds.push(root.id);
        }
        if (coverageRodentRootIds.length > 1) {
          logger.error(`[invoice] FIX: anchor-less setup-fee claim for prepay ${prepayInvoiceId} matches ${coverageRodentRootIds.length} live direct rodent roots for customer ${customerId} coverage "${coverageServiceType}" (${coverageRodentRootIds.join(", ")}) — pick the series that owes the $${amount.toFixed(2)} bait-station setup and restore it manually (record kept)`);
          return null;
        }
        if (coverageRodentRootIds.length === 1) anchorId = coverageRodentRootIds[0];
      }
      if (!anchorId) {
        logger.error(`[invoice] FIX: anchor-less setup-fee claim for prepay ${prepayInvoiceId} (estimate ${sourceEstimateId || 'none'}, coverage ${coverageServiceType || 'n/a'}) has no rodent series root to restore onto — $${amount.toFixed(2)} bait-station setup is owed again; bill it manually or re-run once the series is booked (record kept)`);
        return null;
      }
    }
    // The record itself is the provenance (codex #3591 r37 P1): only the
    // prepay mints that billed the setup as their own line write one (switch,
    // secure-plan, prepay-on-book, estimate-accept prepay), so an
    // estimate-origin parent restores exactly like a direct one — a standard
    // accept never writes a record and never lands here.
    const parent = await conn("scheduled_services")
      .where({ id: anchorId })
      .first("id", "customer_id", "source_estimate_id", "pending_setup_fee", "status");
    if (!parent) return null;
    // A pending_setup_fee stamp is only ever consumed by a FUTURE completion
    // mint (codex #3591 r43 P1): when the series has no billable visit left
    // (root completed/cancelled, no live child), a re-stamp is inert and the
    // refunded setup would never be collected. Mint a collectible DRAFT
    // setup invoice instead (staff send it from Invoices), consuming the
    // record the same way. Fail safe: an unreadable probe or failed mint
    // keeps the record and pages a human.
    const parentLive = ["pending", "confirmed", "rescheduled"].includes(String(parent.status || "").toLowerCase());
    let billableRemains = parentLive;
    if (!billableRemains) {
      const liveChild = await conn("scheduled_services")
        .where({ recurring_parent_id: parent.id })
        .whereIn("status", ["pending", "confirmed", "rescheduled"])
        .first("id");
      billableRemains = !!liveChild;
    }
    if (!billableRemains) {
      if (!parent.customer_id) {
        logger.error(`[invoice] FIX: setup-fee claim for dead series ${parent.id} (prepay ${prepayInvoiceId}) has no customer to re-bill — $${amount.toFixed(2)} bait-station setup is owed; bill it manually (record kept)`);
        return null;
      }
      try {
        const reInvoice = await this.create({
          database: conn,
          customerId: parent.customer_id,
          title: "Bait Station Setup",
          lineItems: [{
            description: "Bait Station Setup — one-time setup fee",
            quantity: 1,
            unit_price: amount,
            category: "Setup fee",
          }],
          notes: `Re-billed after prepay invoice ${prepayInvoiceId} was voided/refunded — the series has no future visit left to collect the setup on (visit ${parent.id}). ${rodentSetupRebillMarker(prepayInvoiceId)}`,
          dueDate: etDateString(),
        });
        await conn("setup_fee_claims").where({ id: claim.id }).delete();
        logger.info(`[invoice] setup re-billed as draft ${reInvoice?.invoice_number || reInvoice?.id} — dead series ${parent.id}, prepay ${prepayInvoiceId} refunded ($${amount.toFixed(2)})`);
        return { scheduledServiceId: parent.id, amount, reInvoiceId: reInvoice?.id || null };
      } catch (mintErr) {
        // PROPAGATES (codex #3591 r47 local P0): the term cancellation and
        // this replacement mint commit TOGETHER — a swallowed mint failure
        // committed a cancelled term no sync re-selects, stranding the
        // claim record and the $99 forever. The throw rolls the whole
        // refund sync back and the event retries.
        logger.error(`[invoice] setup re-bill mint failed for dead series ${parent.id} (prepay ${prepayInvoiceId}): ${mintErr.message} — failing the reversal so it retries`);
        throw mintErr;
      }
    }
    const restored = await conn("scheduled_services")
      .where({ id: parent.id })
      .whereNull("pending_setup_fee")
      .update({ pending_setup_fee: amount, updated_at: new Date() });
    if (restored !== 1) {
      logger.warn(`[invoice] retired setup-fee claim NOT restored on series ${parent.id}: stamp already ${parent.pending_setup_fee} — prepay ${prepayInvoiceId} dead, record kept`);
      return null;
    }
    await conn("setup_fee_claims").where({ id: claim.id }).delete();
    logger.info(`[invoice] setup-fee claim restored on series ${parent.id} ($${amount.toFixed(2)}) — prepay ${prepayInvoiceId} is dead`);
    return { scheduledServiceId: parent.id, amount };
  },

  /**
   * Restore invoices the ON-SITE PREPAY SWITCH retired, keyed by the prepay
   * invoice that superseded them (the switch stamps each voided row with
   * prepaySwitchSupersededByMarker(prepayInvoiceId)). Called from the
   * annual-prepay true-void/refund sync so that cancelling an UNPAID switch
   * prepay through the ordinary Invoices flow puts the per-application
   * invoice (setup fee included) back on the books — without this, the
   * accept-minted AR is silently gone the moment the sheet closes (Codex
   * on-site-switch P0 r7). Idempotent via prepaySwitchRestoreMarker: a row
   * whose replacement already exists is skipped, never double-minted.
   * Best-effort per row; returns the restored descriptors.
   */
  async restoreSwitchSupersededInvoicesForPrepay(prepayInvoiceId, conn = db) {
    if (!prepayInvoiceId) return [];
    const marker = prepaySwitchSupersededByMarker(prepayInvoiceId);
    const candidates = await conn("invoices")
      .where({ status: "void" })
      .where("notes", "like", `%${marker}%`)
      .select("id");
    // Each restore runs with the SUPERSEDED ROW LOCKED and the marker check
    // + re-mint in one transaction (Codex on-site-switch P0 r8): the undo
    // endpoint locks the same row the same way, so the two restorers — an
    // operator tapping Restore while another tab finishes voiding the
    // prepay — serialize on the row instead of both observing "no marker"
    // and each minting a collectible replacement.
    const restoreOne = async (trx, id) => {
      // LOCK ORDER matches the switch and every mint writer (Codex P1 r21):
      // per-customer prepay advisory lock → scheduled-invoice mint lock →
      // invoice row lock. An unlocked pre-read supplies the ids and dates the
      // advisory steps need; every guard then re-runs on the LOCKED re-read,
      // so nothing decided here rests on the unlocked snapshot.
      const preRow = await trx("invoices")
        .where({ id })
        .first("id", "customer_id", "scheduled_service_id", "notes", "status");
      if (!preRow || String(preRow.status || "").toLowerCase() !== "void") return null;
      // The superseding prepay's id rides the durable marker — used by the
      // containment exclusion and the reconciliation guard below.
      const sbForRecon = /\[prepay-switch-superseded-by:([^\]]+)\]/.exec(String(preRow.notes || ""));
      // The double-bill question is whether coverage spans the RESTORED
      // VISIT, not today (Codex P0 r11): an aborted FUTURE-start renewal
      // switch must still restore even while the current year runs.
      const assertDate = await prepaySwitchRestoreAssertDate(trx, preRow);
      // Advisory lock ONLY (allowOverlap=true): the shared assert's overlap
      // test is start-agnostic — built for "new term starting at X", it
      // reads ANY term ending after assertDate as a conflict, so a future
      // term starting after this visit would park the restore forever
      // (Codex P0 r23). The double-bill question is CONTAINMENT: a binding
      // term whose window actually spans the restored visit's date.
      const { lockAndAssertNoAnnualPrepayOverlap } = require("../routes/admin-customers")._private;
      await lockAndAssertNoAnnualPrepayOverlap(trx, preRow.customer_id, assertDate, true);
      const { annualPrepayOverlapStatusClause } = require("../services/secure-appointment-plans");
      const covering = await trx("annual_prepay_terms")
        .where({ customer_id: preRow.customer_id })
        .where(annualPrepayOverlapStatusClause())
        .where("term_start", "<=", assertDate)
        .where("term_end", ">=", assertDate)
        // The superseding prepay's OWN term never blocks its restore (Codex
        // P0 r30): a decided renewed/switch_plan window whose invoice just
        // refunded still reads as covering here, but that coverage is
        // precisely what the refund removed.
        .modify((q) => { if (sbForRecon) q.whereNot({ prepay_invoice_id: sbForRecon[1] }); })
        .first("id");
      if (covering) {
        logger.warn(`[invoice] switch-supersede restore skipped for ${preRow.id}: a prepaid year covers ${assertDate} — restoring would double-bill`);
        return null;
      }
      // The superseding prepay must have NO unresolved Stripe outcome
      // (Codex P0 r29): a charged-but-orphaned or ambiguous tender means
      // money may be collected with nothing local — restoring the old
      // receivable beside it re-bills a paid customer. Fail toward manual
      // review on any refusal or unverifiable read.
      if (sbForRecon) {
        try {
          await require("./stripe").assertNoInvoiceChargeReconciliationPending(sbForRecon[1], trx);
        } catch (reconErr) {
          logger.warn(`[invoice] switch-supersede restore deferred for ${preRow.id}: prepay ${sbForRecon[1]} has an unresolved charge outcome (${reconErr.message}) — manual review`);
          return null;
        }
      }
      if (preRow.scheduled_service_id) {
        const { acquireScheduledInvoiceMintLock } = require("./scheduled-invoice-mint");
        await acquireScheduledInvoiceMintLock(trx, preRow.scheduled_service_id);
      }
      const row = await trx("invoices")
        .where({ id })
        .forUpdate()
        .first("id", "invoice_number", "status", "line_items", "notes", "title",
          "scheduled_service_id", "customer_id");
      // Identity recheck on the locked row.
      if (!row || String(row.status || "").toLowerCase() !== "void") return null;
      const restoreMarker = prepaySwitchRestoreMarker(row.id);
      const existing = await trx("invoices")
        .where("notes", "like", `%${restoreMarker}%`)
        .first("id");
      if (existing) return null;
      let lines = parseInvoiceLineItems(row.line_items)
        .map((li) => ({
          description: String(li?.description || ""),
          quantity: Number(li?.quantity) > 0 ? Number(li.quantity) : 1,
          unit_price: Number(li?.unit_price ?? li?.amount),
        }))
        .filter((li) => li.description && Number.isFinite(li.unit_price));
      // Live AR classification under the mint lock (Codex P0 r9/r17/r19):
      // only an invoice provably billing the BASE application demotes the
      // restore to setup-fee-only; unrelated live invoices keep the full
      // restore; unreadable ones defer to manual review.
      if (row.scheduled_service_id) {
        const liveOnVisit = await trx("invoices")
          .where({ scheduled_service_id: row.scheduled_service_id })
          .whereNot({ id: row.id })
          .whereNotIn("status", ["void", "cancelled", "canceled", "refunded"])
          .select("id", "invoice_number", "line_items");
        if (liveOnVisit.length > 0) {
          // Identity + the positive-amount billing-evidence layer (Codex
          // PR r11 P1): a zero/credited legacy "First application" line
          // must not read as billed and strip the restore.
          const billsApplication = (inv) => parseInvoiceLineItems(inv.line_items).some((li) => {
            const qty = li?.quantity != null ? Number(li.quantity) : 1;
            const amt = li?.amount != null ? Number(li.amount) : Number(li?.unit_price) * qty;
            return Number.isFinite(amt) && amt > 0 && lineIsBaseApplication(li);
          });
          const unreadable = liveOnVisit.some((inv) => parseInvoiceLineItems(inv.line_items).length === 0);
          if (unreadable) {
            logger.warn(`[invoice] switch-supersede restore deferred for ${row.invoice_number || row.id}: live invoice on the visit has unreadable lines — manual review`);
            return null;
          }
          if (liveOnVisit.some(billsApplication)) {
            lines = lines.filter((li) => /setup fee/i.test(li.description));
            if (lines.length === 0) {
              logger.info(`[invoice] switch-supersede restore skipped for ${row.invoice_number || row.id}: the application is already billed and no setup fee rode the superseded row`);
              return null;
            }
            logger.info(`[invoice] switch-supersede restoring SETUP FEE ONLY for ${row.invoice_number || row.id}: application billed by a live visit invoice`);
          }
          // else: live invoices bill something unrelated — full restore.
        }
      }
      if (lines.length === 0) {
        logger.warn(`[invoice] switch-supersede restore skipped for ${row.invoice_number || row.id}: no readable line items`);
        return null;
      }
      const recreated = await this.create({
        database: trx,
        customerId: row.customer_id,
        scheduledServiceId: row.scheduled_service_id,
        title: row.title || "Service invoice",
        lineItems: lines,
        notes: `${stripPrepaySwitchSupersededMarkers(row.notes)}\n${restoreMarker} Re-created after the annual prepay that superseded it was cancelled; replaces voided ${row.invoice_number || row.id}.`.trim(),
        // ET calendar, never UTC — after ~8PM Eastern a UTC slice dates the
        // restored invoice tomorrow.
        dueDate: etDateString(),
      });
      return { replacedInvoiceId: row.id, invoiceId: recreated?.id || null, invoiceNumber: recreated?.invoice_number || null };
    };
    const restored = [];
    for (const candidate of candidates) {
      const out = conn.isTransaction
        ? await restoreOne(conn, candidate.id)
        : await conn.transaction((trx) => restoreOne(trx, candidate.id));
      if (out) restored.push(out);
    }
    return restored;
  },

  /**
   * Durable repair sweep for the on-site prepay switch (Codex P0 r13): a
   * restore that failed transiently inside a term-cancel sync must not lose
   * the AR forever — the superseded-by markers persist on the void rows, so
   * this sweep finds every void invoice still carrying one whose superseding
   * prepay is terminal and re-runs the (idempotent, lock-guarded) restore.
   * Wired into the daily billing cron; safe to run any number of times.
   */
  async sweepOrphanedPrepaySwitchRestores(conn = db) {
    const rows = await conn("invoices")
      .where({ status: "void" })
      .where("notes", "like", "%[prepay-switch-superseded-by:%")
      .select("id", "notes");
    const prepayIds = new Set();
    for (const row of rows) {
      const m = /\[prepay-switch-superseded-by:([^\]]+)\]/.exec(String(row.notes || ""));
      if (m) prepayIds.add(m[1]);
    }
    const restored = [];
    // A switch prepay ABANDONED mid-tender (browser crash, tab eviction —
    // Codex P0 r14) sits payment_pending forever: an unsent draft nobody can
    // pay, with the superseded invoice void beside it. Any such draft older
    // than this cutoff is expired here — voidInvoice cancels its pending
    // term through the canonical sync, and the restore below re-mints the
    // superseded AR in the same pass. Generous cutoff: a real tender ends in
    // minutes; a day means no live flow can be yanked out from under.
    const ABANDONED_SWITCH_PREPAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    for (const prepayId of prepayIds) {
      const prepay = await conn("invoices")
        .where({ id: prepayId })
        .first("id", "status", "sent_at", "paid_at", "stripe_payment_intent_id", "created_at");
      let dead = !!prepay
        && ["void", "cancelled", "canceled", "refunded"].includes(String(prepay.status || "").toLowerCase());
      // A FULL Stripe refund cancels the TERM through the payment sync while
      // the invoice itself commonly stays 'paid' (Codex P0 r22) — deadness
      // must also read the canonical term state. Only a TRUE void/refund
      // cancel counts (renewal_decision NULL): a decided renewal lapse keeps
      // its paid, covered year, and restoring beside it would double-bill.
      if (!dead && prepay) {
        const term = await conn("annual_prepay_terms")
          .where({ prepay_invoice_id: prepayId })
          .first("status", "renewal_decision");
        if (term && String(term.status || "") === "cancelled" && !term.renewal_decision) {
          dead = true;
        }
      }
      if (!dead && prepay
        && String(prepay.status || "").toLowerCase() === "draft"
        && !prepay.sent_at && !prepay.paid_at
        && prepay.created_at
        && Date.now() - new Date(prepay.created_at).getTime() > ABANDONED_SWITCH_PREPAY_MAX_AGE_MS) {
        // A PI on the draft usually means a tender FAILED mid-collection
        // (a settling one flips the invoice off draft) — but verify against
        // the payments ledger and fail CLOSED: any non-terminal payment row,
        // or an unreadable ledger, leaves the draft alone (Codex P0 r15).
        let expirable = true;
        if (prepay.stripe_payment_intent_id) {
          // Invoice linkage lives in payments.metadata, not a column — the
          // same parameterized lookup voidInvoice's own money guard uses
          // (Codex P0 r16: a bare invoice_id column query throws on every
          // row, and the catch's fail-closed then parked the repair forever).
          try {
            const livePayment = await conn("payments")
              .whereNotIn("status", ["failed", "canceled", "cancelled"])
              .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [String(prepay.id)])
              .first("id");
            expirable = !livePayment;
          } catch {
            expirable = false;
          }
        }
        if (expirable) {
          // A charge can have succeeded at Stripe with NOTHING local — the
          // supported STRIPE_CHARGED_DB_FAILED shape leaves the draft with
          // no PI and no payments row (Codex P0 r29). The canonical
          // reconciliation guard reads the durable tender-attempt and
          // orphan-charge markers; anything pending — or an unverifiable
          // read — leaves the draft for manual review, never auto-void.
          try {
            await require("./stripe").assertNoInvoiceChargeReconciliationPending(prepay.id, conn);
          } catch (reconErr) {
            logger.warn(`[invoice] switch-restore sweep leaving prepay ${prepay.id} for manual review: ${reconErr.message}`);
            continue;
          }
          try {
            await this.voidInvoice(prepay.id);
            dead = true;
            logger.info(`[invoice] switch-restore sweep expired abandoned prepay ${prepay.id} — term cancelled, restoring superseded AR`);
          } catch (err) {
            logger.warn(`[invoice] switch-restore sweep could not expire abandoned prepay ${prepay.id}: ${err.message} — next sweep retries`);
            continue;
          }
        }
      }
      if (!dead) continue;
      // voidInvoice's term sync is best-effort and can have failed at void
      // time, leaving the term payment_pending — the overlap assert would
      // then skip the restore forever (Codex P0 r15). Re-run the idempotent
      // sync for every terminal prepay before restoring: a still-pending
      // term is cancelled now, an already-cancelled one is a no-op.
      try {
        await require("./annual-prepay-renewals").syncTermForInvoicePayment(prepayId, conn);
      } catch (err) {
        logger.warn(`[invoice] switch-restore sweep term-sync failed for prepay ${prepayId}: ${err.message} — next sweep retries`);
        continue;
      }
      try {
        restored.push(...await this.restoreSwitchSupersededInvoicesForPrepay(prepayId, conn));
      } catch (err) {
        logger.warn(`[invoice] switch-restore sweep failed for prepay ${prepayId}: ${err.message} — next sweep retries`);
      }
    }
    if (restored.length) {
      logger.info(`[invoice] switch-restore sweep re-minted ${restored.length} invoice(s): ${restored.map((r) => r.invoiceNumber || r.invoiceId).join(", ")}`);
    }
    return restored;
  },

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
  async voidOpenInvoicesForCancelledService(
    scheduledServiceId,
    { invoiceId = null, refusedClaimToken = null } = {},
  ) {
    const voided = [];
    if (!scheduledServiceId) return voided;
    const refusedSendCleanup = Boolean(invoiceId && refusedClaimToken);
    try {
      const candidateQuery = db("invoices");
      if (refusedSendCleanup) {
        candidateQuery.where({ id: invoiceId, status: "sending", send_claim_token: refusedClaimToken });
      } else {
        // Widened (Codex round-4 P1 #4131, raised twice for this slice):
        // most post-completion invoices carry only service_record_id, never
        // scheduled_service_id directly (migration 20260420000002) — the
        // inverse of linkedScheduledServiceId's own fallback. Matching
        // scheduled_service_id alone left those rows permanently un-voidable
        // by this sweep; done once here, not duplicated at each caller.
        candidateQuery
          .where((q) => {
            q.where({ scheduled_service_id: scheduledServiceId })
              .orWhereIn(
                "service_record_id",
                db("service_records").where({ scheduled_service_id: scheduledServiceId }).select("id"),
              );
          })
          .whereIn("status", CANCELLED_SERVICE_VOIDABLE_STATUSES);
      }
      const candidates = await candidateQuery
        .select("id", "invoice_number", "stripe_payment_intent_id", "payer_statement_id");
      if (candidates.length === 0) return voided;
      const StripeService = require("./stripe");
      for (const candidate of candidates) {
        try {
          // ── Stripe PI triage (pre-lock) ────────────────────────────────
          const triagedPiId = candidate.stripe_payment_intent_id || null;
          // The refused-send cleanup runs after provider preparation. Never
          // perform an external Stripe cancellation from that delayed path:
          // a reactivated visit/replacement episode could have attached the
          // PI after the refusal snapshot. Leave any PI-bearing row claimed
          // for explicit money review. Normal cancellation keeps its existing
          // triage below.
          if (refusedSendCleanup && triagedPiId) {
            logger.warn(
              `[invoice] NOT auto-voiding ${candidate.invoice_number} after terminal delivery refusal — PaymentIntent ${triagedPiId} is attached; needs manual review`,
            );
            continue;
          }
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
            // Unbind combined siblings from the canceled PI — REGARDLESS of
            // who canceled it (codex #3427 r17 P2: an already-canceled PI,
            // e.g. via the Stripe dashboard, must not leave stale bindings).
            await require("./pay-combined").clearPaymentIntentStamps(db, triagedPiId, { keepInvoiceIds: [String(candidate.id)] });
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
            if (refusedSendCleanup) {
              if (locked.status !== "sending" || locked.send_claim_token !== refusedClaimToken) {
                return { skipped: "delivery claim changed; replacement episode retained", invoice: locked };
              }
              // A deferred invoice message may already own this delivery.
              // Keep the invoice claimed while that message is queued,
              // dispatching, or finalizing so terminal-refusal cleanup cannot
              // erase its pay link or accepted-provider evidence.
              const liveQueuedDelivery = await trx("sms_log")
                .whereRaw("metadata->>'entry_point' IN ('invoice_send_deferred', 'invoice_followup_deferred', 'autopay_completion_decline_deferred', 'dispatch_completion_deferred')")
                .whereRaw("metadata->>'invoice_id' = ?", [String(locked.id)])
                .whereRaw("(status IN ('scheduled', 'sending') OR (status = 'sent' AND metadata->>'finalize_pending' = 'true'))")
                .first("id");
              if (liveQueuedDelivery) {
                return { skipped: `queued delivery ${liveQueuedDelivery.id} is still live; needs delivery review`, invoice: locked };
              }
              const linkedVisitId = await linkedScheduledServiceId(locked, trx);
              if (String(linkedVisitId || "") !== String(scheduledServiceId)) {
                return { skipped: "linked visit changed after refusal", invoice: locked };
              }
              const terminalVisit = await require("./invoice-helpers")
                .visitRefusesSettlement(trx, linkedVisitId);
              if (!terminalVisit) {
                return { skipped: "linked visit is no longer terminal", invoice: locked };
              }
            } else if (!CANCELLED_SERVICE_VOIDABLE_STATUSES.includes(locked.status)) {
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
            const voidQuery = trx("invoices")
              .where({ id: locked.id, status: locked.status });
            if (refusedSendCleanup) voidQuery.where({ send_claim_token: refusedClaimToken });
            const [voidedInvoice] = await voidQuery
              .update({ status: "void", send_claim_token: null, updated_at: new Date() })
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
            // A cancelled visit's auto-voided invoice may have billed the
            // rodent bait-station setup (codex #3591 r58 P1) — restore the
            // obligation to the living series exactly like voidInvoice does
            // (billable-visit guard + dead-series re-bill inside).
            await InvoiceService.restoreRodentSetupObligationForReversedInvoice(trx, voidedInvoice);
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
    } finally {
      // Inspection credit: a cancelled booking must not keep its $75.
      // Reversal lives HERE — in the one helper every cancellation path
      // already calls — so no cancel surface can forget to wire it, and
      // the ordering is guaranteed by construction: voiding an invoice
      // RESTORES any credit applied to it, so reversing before the void
      // would find the balance short and then hand the credit back
      // spendable (Codex #3178 r7 P0). `finally` covers the no-invoice
      // early return too — a cancel with nothing to void still reverses.
      // Idempotent and never throws; the hourly sweep stays as recovery.
      if (!refusedSendCleanup || voided.includes(invoiceId)) {
        try {
          const rev = await require('./inspection-credit').reverseInspectionCreditForBooking({
            scheduledServiceId,
            createdBy: 'system:inspection_credit_cancellation_void_hook',
          });
          // Surfaced for callers that COUNT reversals (the hourly sweep,
          // which now routes through this seam — Codex #3178 r33 P2): a
          // property on the returned array is additive and invisible to
          // every array-consuming caller. Assigned in finally, so the
          // no-invoice early return carries it too.
          voided.inspectionCreditReversal = rev;
        } catch (revErr) {
          logger.error(
            `[invoice] inspection credit reversal failed for cancelled service ${scheduledServiceId}: ${revErr.message}`,
          );
        }
      }
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
          // Collected = NET CASH: face + captured card surcharge, minus
          // refunds. refunded_amount is face-denominated. The fee side uses
          // the explicit refunded_surcharge cumulative when a refund stamped
          // it (cancel-signup refunds are FACE-ONLY — the retained fee stays
          // collected); legacy rows without the stamp keep the historical
          // proration, matching what those sweeps actually returned. amount
          // and on_hand stay face-only by design (the credit authority).
          "COALESCE(SUM(GREATEST(amount - COALESCE(refunded_amount, 0), 0) + COALESCE(CASE WHEN refunded_surcharge IS NOT NULL THEN GREATEST(COALESCE(card_surcharge, 0) - refunded_surcharge, 0) ELSE COALESCE(card_surcharge, 0) * GREATEST(amount - COALESCE(refunded_amount, 0), 0) / NULLIF(amount, 0) END, 0)) FILTER (WHERE received_at IS NOT NULL), 0) as collected",
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
  calculateUpdateFinancials,
  // Exposed for unit tests (scope extension, 2026-09): the shared
  // create()/calculateUpdateFinancials engine, driven directly with no DB
  // mocking — every input it needs (items, the two row/id maps) is a
  // plain in-memory value.
  computeStackedDocumentDiscountLines,
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
InvoiceService.lineIsBaseApplication = lineIsBaseApplication;

InvoiceService.rodentSetupRebillMarker = rodentSetupRebillMarker;
module.exports = InvoiceService;
module.exports.prepaySwitchSupersededByMarker = prepaySwitchSupersededByMarker;
module.exports.prepaySwitchRestoreMarker = prepaySwitchRestoreMarker;
module.exports.stripPrepaySwitchSupersededMarkers = stripPrepaySwitchSupersededMarkers;
module.exports.prepaySwitchRestoreAssertDate = prepaySwitchRestoreAssertDate;
// Exposed for unit tests (pure helpers).
module.exports._invoiceHasNonBaseCharges = invoiceHasNonBaseCharges;
module.exports._invoiceHasDepositCreditLine = invoiceHasDepositCreditLine;
module.exports._parseInvoiceLineItems = parseInvoiceLineItems;
module.exports.CANCELLED_SERVICE_VOIDABLE_STATUSES = CANCELLED_SERVICE_VOIDABLE_STATUSES;
module.exports._s3KeyFromStoredUrl = s3KeyFromStoredUrl;
module.exports._withFreshServicePhotoUrls = withFreshServicePhotoUrls;
// Test-only seam (#4131 slice 4): exercises the atomic attempt-increment
// SQL directly, without going through a full processScheduledSends due-read
// cycle — needed to model two overlapping worker passes off the SAME stale
// in-memory snapshot (see invoice-scheduled-readiness-postgres.test.js).
module.exports._recordZeroDueSchedulingOutcome = recordZeroDueSchedulingOutcome;
module.exports._dequeuePayerOwnedZeroDueInvoice = dequeuePayerOwnedZeroDueInvoice;
// Test-only seams (#4131 slice 4 round-5): the ONE zero-due chokepoint and
// its two result-shape mappers, exercised directly rather than only
// end-to-end through claimInvoiceForSend/sendViaSMS/sendViaSMSAndEmail.
module.exports._settleZeroDueBeforeSend = settleZeroDueBeforeSend;
module.exports._zeroDueDirectSendOutcome = zeroDueDirectSendOutcome;
module.exports._zeroDueWrapperOutcome = zeroDueWrapperOutcome;
module.exports.claimPacketInvoiceForSend = claimPacketInvoiceForSend;
module.exports.claimInvoiceForSend = claimInvoiceForSend;
// Test-only seam (#4131 slice 5): the ONE chokepoint for giving a send claim
// back, exercised directly by the ported Postgres adoption-restore cases
// (invoice-claim-ownership-postgres.test.js) so a genuine restore failure can
// be asserted against real schema without driving the whole send twice.
module.exports.restoreSendClaim = restoreSendClaim;
