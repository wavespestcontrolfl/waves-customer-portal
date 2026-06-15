/**
 * Hermes vendor price-scan worker.
 *
 * Machine-to-machine endpoint (HERMES_SERVICE_TOKEN) for reporting scraped /
 * account vendor prices. Reported prices are NOT trusted blindly: each one is
 * landed into the existing review-queue pipeline as
 *   price_snapshots -> pending vendor_pricing -> price_approval_events
 * so it surfaces in GET /api/admin/inventory/price-sync/review-queue. An
 * operator approves it there, and the existing approve handler activates the
 * price and recomputes products_catalog.best_price. This route never touches
 * best_price or activates a price directly.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { hermesAuth } = require('../middleware/hermes-auth');

router.use(hermesAuth);

// Enum values are CHECK-constrained in migration 20260528000006; an invalid
// value would make the insert fail, so we validate before writing.
const PRICE_TYPES = ['account', 'contract', 'public', 'promo', 'quote', 'manual', 'manual_seed'];
const AVAILABILITY_STATUSES = ['in_stock', 'limited', 'out_of_stock', 'backorder', 'unknown'];
// source_type is free-form (no CHECK) — tag every Hermes-reported price so it is
// distinguishable from manual / feed / api prices.
const SOURCE_TYPE = 'hermes_price_report';
// Hermes logs into vendor accounts, so account pricing is the sensible default.
const DEFAULT_PRICE_TYPE = 'account';
const REVIEW_REASON = 'Hermes price report — pending operator review';

function cleanString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

// Strict numeric check: a finite JS number, or a plain decimal string. Rejects
// booleans, arrays, objects, and junk like "12abc" that Number() would silently
// coerce (Number(true) === 1, Number([12]) === 12) into a fake price.
function isNumericInput(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return /^-?\d+(\.\d+)?$/.test(value.trim());
  return false;
}

function toPositiveAmount(value) {
  if (!isNumericInput(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toDecimalOrNull(value) {
  if (value === '' || value == null) return null;
  if (!isNumericInput(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Unit-cost fields (normalized_unit_price, landed_unit_price) drive best-price
// ordering on approval (COALESCE(landed_unit_price, normalized_unit_price, ...)
// ASC), so a 0/negative value would wrongly win best price. Treat non-positive
// as "not provided" rather than letting it poison the ordering.
function toPositiveDecimalOrNull(value) {
  const n = toDecimalOrNull(value);
  return n != null && n > 0 ? n : null;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// Two numeric values are "equal" within the cent tolerance. Both null = equal;
// exactly one null = not equal.
function approxEqual(a, b, tol = 0.005) {
  const na = a == null ? null : Number(a);
  const nb = b == null ? null : Number(b);
  if (na == null && nb == null) return true;
  if (na == null || nb == null) return false;
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.abs(na - nb) < tol;
}

// A reported price is "the same" as an existing/pending one only if the dollar
// price AND any unit-cost fields the report PROVIDES match. Best-price ordering
// uses landed/normalized unit price, so a same-dollar report with a changed
// landed/normalized cost is a material change that must still be queued. Fields
// the report omits (null) are not treated as changes.
function priceFingerprintMatches(rowLike, newPrice, common) {
  const rowPrice = rowLike.price_amount != null ? rowLike.price_amount
    : (rowLike.new_price_amount != null ? rowLike.new_price_amount : rowLike.price);
  if (!approxEqual(rowPrice, newPrice)) return false;
  if (common && common.landed_unit_price != null
      && !approxEqual(rowLike.landed_unit_price, common.landed_unit_price)) return false;
  if (common && common.normalized_unit_price != null
      && !approxEqual(rowLike.normalized_unit_price, common.normalized_unit_price)) return false;
  return true;
}

/**
 * Validate + normalize one reported price item. Pure: no DB access.
 */
function parseReportItem(item, topVendorId) {
  const safe = item && typeof item === 'object' ? item : {};
  const vendorId = cleanString(safe.vendor_id) || cleanString(topVendorId);
  const price = toPositiveAmount(safe.price ?? safe.price_amount);
  const productId = cleanString(safe.product_id);
  const vendorSku = cleanString(safe.vendor_sku);
  const productUrl = cleanString(safe.product_url || safe.source_url);
  const priceType = cleanString(safe.price_type) || DEFAULT_PRICE_TYPE;
  const availabilityStatus = cleanString(safe.availability_status) || 'unknown';
  const currency = (cleanString(safe.currency) || 'USD').toUpperCase();

  const errors = [];
  if (!vendorId) errors.push('vendor_id is required (top-level or per item)');
  if (price == null) errors.push('price must be a positive number');
  if (!productId && !vendorSku && !productUrl) {
    errors.push('product_id, vendor_sku, or product_url is required');
  }
  if (!PRICE_TYPES.includes(priceType)) {
    errors.push(`price_type must be one of: ${PRICE_TYPES.join(', ')}`);
  }
  if (!AVAILABILITY_STATUSES.includes(availabilityStatus)) {
    errors.push(`availability_status must be one of: ${AVAILABILITY_STATUSES.join(', ')}`);
  }
  // The review queue and products_catalog.best_price are bare USD amounts with
  // no FX/display, so a non-USD price would be approved as if it were USD.
  if (currency !== 'USD') {
    errors.push('currency must be USD — multi-currency pricing is not supported');
  }

  return { vendorId, price, productId, vendorSku, productUrl, priceType, availabilityStatus, currency, errors };
}

/**
 * Price-change delta vs the vendor's current price. Pure.
 */
function computeChange(oldPrice, newPrice) {
  if (oldPrice == null) return { changeAmount: null, changePercent: null };
  const changeAmount = round4(newPrice - oldPrice);
  const changePercent = oldPrice !== 0 ? round4(((newPrice - oldPrice) / oldPrice) * 100) : null;
  return { changeAmount, changePercent };
}

/**
 * Idempotency / dedupe decision for a reported price vs the existing PENDING
 * review-queue events for the same (product, vendor). Pure.
 *  - An identical pending price (within half a cent) is a retry/duplicate: skip
 *    re-inserting and reuse the existing event.
 *  - A different price supersedes the stale pending events (so an old duplicate
 *    can't be approved later and clobber a newer price); return their ids to
 *    reject before inserting the fresh one.
 */
function classifyAgainstPending(pendingEvents, newPrice, common) {
  const rows = Array.isArray(pendingEvents) ? pendingEvents : [];
  // Duplicate detection spans ALL sources (never double-queue a price that's
  // already pending review, whoever queued it).
  const duplicate = rows.find((e) => priceFingerprintMatches(e, newPrice, common));
  if (duplicate) return { duplicate: true, duplicateEvent: duplicate, supersedeIds: [] };
  // Supersede only OUR OWN prior Hermes-sourced pending events — never reject a
  // manual/feed review item (leave those for an operator to resolve).
  const supersedeIds = rows.filter((e) => e.source_type === SOURCE_TYPE).map((e) => e.id);
  return { duplicate: false, duplicateEvent: null, supersedeIds };
}

/**
 * True when the reported price already equals the vendor's LIVE approved price
 * (same cent tolerance), using best_price's own definition of live
 * (is_active AND approved/auto_approved). Lets recurring scans no-op an
 * unchanged price instead of refilling the review queue with 0-change events.
 * Pure.
 */
function isUnchangedApprovedPrice(existing, newPrice, common) {
  if (!existing) return false;
  if (existing.is_active !== true) return false;
  if (!['approved', 'auto_approved'].includes(existing.approval_status)) return false;
  const current = existing.price_amount != null
    ? Number(existing.price_amount)
    : (existing.price != null ? Number(existing.price) : null);
  if (current == null || !Number.isFinite(current)) return false;
  return priceFingerprintMatches(existing, newPrice, common);
}

/**
 * Collapse candidate verified mappings to a single product. Pure.
 *  - 0 candidates  -> { productId: null } (caller treats as unresolved)
 *  - 1 distinct    -> { productId }
 *  - >1 distinct   -> { ambiguous: true } (caller rejects; require explicit id)
 */
function resolveDistinctProductId(mappings) {
  const rows = Array.isArray(mappings) ? mappings : [];
  const ids = [...new Set(rows.map((m) => m.product_id).filter(Boolean))];
  if (ids.length === 0) return { productId: null, ambiguous: false, productIds: [] };
  if (ids.length > 1) return { productId: null, ambiguous: true, productIds: ids };
  return { productId: ids[0], ambiguous: false, productIds: ids };
}

/**
 * Shared price/availability fields written to both price_snapshots and a new
 * pending vendor_pricing row. Pure.
 */
function buildCommonPriceFields(parsed, item, mapping) {
  const safe = item && typeof item === 'object' ? item : {};
  return {
    currency: parsed.currency || 'USD',
    quantity: cleanString(safe.quantity),
    normalized_unit_price: toPositiveDecimalOrNull(safe.normalized_unit_price),
    landed_unit_price: toPositiveDecimalOrNull(safe.landed_unit_price),
    availability_status: parsed.availabilityStatus,
    branch_id: cleanString(safe.branch_id),
    branch_name: cleanString(safe.branch_name),
    mapping_confidence: toDecimalOrNull(safe.mapping_confidence)
      ?? (mapping ? toDecimalOrNull(mapping.mapping_confidence) : null),
    price_confidence: toDecimalOrNull(safe.price_confidence),
  };
}

/**
 * Snapshot row (the raw captured price). Pure — caller adds timestamps.
 */
function buildSnapshotRow({ parsed, item, mapping, vendorPricingId, change, oldPrice }) {
  const safe = item && typeof item === 'object' ? item : {};
  return {
    product_id: parsed.productId,
    vendor_id: parsed.vendorId,
    vendor_pricing_id: vendorPricingId,
    distributor_product_map_id: mapping?.id || null,
    price: parsed.price,
    price_amount: parsed.price,
    previous_price_amount: oldPrice,
    change_amount: change.changeAmount,
    change_percent: change.changePercent,
    uom: cleanString(safe.unit),
    source_type: SOURCE_TYPE,
    price_type: parsed.priceType,
    source_url: parsed.productUrl,
    raw_price_text: cleanString(safe.raw_price_text),
    raw_payload_json: JSON.stringify({ source: SOURCE_TYPE, item: safe }),
    requires_approval: true,
    approval_reason: REVIEW_REASON,
    ...buildCommonPriceFields(parsed, item, mapping),
  };
}

/**
 * Pending vendor_pricing row — created only when the (product, vendor) pair has
 * no row yet. Stays inactive/pending so best_price ignores it until approved.
 *
 * Deliberately leaves price / price_amount NULL: the legacy recalcBestPrice in
 * admin-inventory.js sorts vendor_pricing by price WITHOUT an approval_status
 * filter (it only excludes null/<=0 price), so a populated price here could be
 * promoted into best_price before review. The approve handler copies the price
 * from the snapshot on approval, at which point the row becomes eligible.
 * Pure — caller adds timestamps.
 */
function buildPendingVendorPricingRow({ parsed, item, mapping }) {
  const safe = item && typeof item === 'object' ? item : {};
  return {
    product_id: parsed.productId,
    vendor_id: parsed.vendorId,
    distributor_product_map_id: mapping?.id || null,
    price_type: parsed.priceType,
    approval_status: 'pending',
    is_active: false,
    source_type: SOURCE_TYPE,
    vendor_sku: parsed.vendorSku,
    vendor_product_url: parsed.productUrl,
    unit: cleanString(safe.unit),
    ...buildCommonPriceFields(parsed, item, mapping),
  };
}

/**
 * Review-queue event row. Pure.
 */
function buildApprovalEventRow({ parsed, snapshotId, vendorPricingId, change, oldPrice }) {
  return {
    snapshot_id: snapshotId,
    product_id: parsed.productId,
    vendor_id: parsed.vendorId,
    vendor_pricing_id: vendorPricingId,
    old_price_amount: oldPrice,
    new_price_amount: parsed.price,
    change_amount: change.changeAmount,
    change_percent: change.changePercent,
    approval_status: 'pending',
    approval_reason: REVIEW_REASON,
  };
}

// GET / — contract description (token-gated).
router.get('/', (req, res) => {
  res.json({
    worker: 'vendor-price-worker',
    report: {
      method: 'POST',
      path: '/report',
      body: {
        vendor_id: 'uuid (optional default for all items)',
        items: [
          {
            product_id: 'uuid — OR vendor_sku / product_url to resolve via distributor_product_map',
            price: 'number > 0 (required)',
            price_type: PRICE_TYPES,
            currency: 'ISO 4217 (default USD)',
            quantity: 'e.g. "2.5 gal"',
            unit: 'e.g. "oz"',
            normalized_unit_price: 'number (cost per oz, optional)',
            landed_unit_price: 'number (incl. shipping/fees, optional)',
            availability_status: AVAILABILITY_STATUSES,
            branch_id: 'string (optional)',
            branch_name: 'string (optional)',
            source_url: 'vendor product URL (optional)',
            raw_price_text: 'verbatim price string (optional)',
          },
        ],
      },
      behavior:
        'Each price is queued for operator review (price_snapshots + pending vendor_pricing + price_approval_events). '
        + 'Approve at /api/admin/inventory/price-sync/review-queue/:id/approve to activate it and recompute best_price.',
    },
    price_types: PRICE_TYPES,
    availability_statuses: AVAILABILITY_STATUSES,
  });
});

// POST /report — land a batch of reported prices into the review queue.
router.post('/report', async (req, res, next) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items)
      ? body.items
      : (Array.isArray(body.prices) ? body.prices : []);
    if (!items.length) {
      return res.status(400).json({ error: 'items[] (or prices[]) is required' });
    }
    const topVendorId = cleanString(body.vendor_id);

    const results = [];
    const rowErrors = [];

    for (const [index, item] of items.entries()) {
      const rowNumber = index + 1;
      try {
        const parsed = parseReportItem(item, topVendorId);
        if (parsed.errors.length) {
          rowErrors.push({ row: rowNumber, errors: parsed.errors });
          continue;
        }

        const vendor = await db('vendors').where({ id: parsed.vendorId }).first();
        if (!vendor) {
          rowErrors.push({ row: rowNumber, errors: ['Vendor not found'] });
          continue;
        }

        // Resolve the internal product, directly or via the SKU/URL mapping.
        let mapping = null;
        if (!parsed.productId && (parsed.vendorSku || parsed.productUrl)) {
          // Only a VERIFIED mapping may auto-resolve the product, and it must be
          // unambiguous: distributor_product_map has no uniqueness on SKU/URL, so
          // multiple verified rows pointing at DIFFERENT products would otherwise
          // let .first() attach a scraped price to the wrong product (and bake it
          // into best_price on approval). Require exactly one distinct product.
          const candidates = await db('distributor_product_map')
            .where({ vendor_id: parsed.vendorId, active: true, mapping_status: 'verified' })
            .where(function byIdentifier() {
              if (parsed.vendorSku) this.orWhere({ distributor_sku: parsed.vendorSku });
              if (parsed.productUrl) {
                this.orWhere({ product_url: parsed.productUrl }).orWhere({ source_url: parsed.productUrl });
              }
            })
            .select('id', 'product_id', 'mapping_confidence');
          const resolution = resolveDistinctProductId(candidates);
          if (resolution.ambiguous) {
            rowErrors.push({
              row: rowNumber,
              errors: [`Ambiguous mapping: ${resolution.productIds.length} verified products match this vendor_sku/product_url — pass product_id explicitly`],
            });
            continue;
          }
          if (resolution.productId) {
            parsed.productId = resolution.productId;
            mapping = candidates.find((m) => m.product_id === resolution.productId) || null;
          }
        } else if (parsed.productId && (parsed.vendorSku || parsed.productUrl)) {
          // product_id is explicit; only attach the mapping FK as metadata.
          mapping = await db('distributor_product_map')
            .where({ vendor_id: parsed.vendorId, product_id: parsed.productId, active: true })
            .first();
        }

        if (!parsed.productId) {
          rowErrors.push({
            row: rowNumber,
            errors: ['No verified product mapping: pass product_id, or add a verified distributor_product_map for this vendor_sku/product_url first'],
          });
          continue;
        }

        const product = await db('products_catalog').where({ id: parsed.productId }).first();
        if (!product) {
          rowErrors.push({ row: rowNumber, errors: ['Product not found'] });
          continue;
        }

        const written = await db.transaction(async (trx) => {
          // Serialize concurrent reports for the same (product, vendor) so the
          // pending-event dedupe/supersede read-decide-write stays atomic — two
          // reports can't both observe "no pending" and enqueue conflicting
          // prices. Matches the advisory-lock pattern in booking.js / onboarding.js.
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [
            'vendor_price_report',
            `${parsed.productId}:${parsed.vendorId}`,
          ]);

          const existing = await trx('vendor_pricing')
            .where({ product_id: parsed.productId, vendor_id: parsed.vendorId })
            .first();
          const oldPrice = existing ? toDecimalOrNull(existing.price_amount ?? existing.price) : null;
          const change = computeChange(oldPrice, parsed.price);
          // Material fingerprint (dollar price + unit costs) for dedupe/no-op.
          const common = buildCommonPriceFields(parsed, item, mapping);

          // Idempotency: dedupe against existing PENDING review-queue events for
          // this (product, vendor). A retry of the same price+unit-cost is
          // skipped; a different one supersedes (rejects) the stale pending
          // events so an old duplicate can't be approved later and clobber a
          // newer price. Join the snapshot for the unit-cost fields.
          const pendingEvents = await trx('price_approval_events as pae')
            .leftJoin('price_snapshots as ps', 'ps.id', 'pae.snapshot_id')
            .where({
              'pae.product_id': parsed.productId,
              'pae.vendor_id': parsed.vendorId,
              'pae.approval_status': 'pending',
            })
            .select(
              'pae.id',
              'pae.snapshot_id',
              'pae.vendor_pricing_id',
              'pae.new_price_amount',
              'pae.old_price_amount',
              'ps.landed_unit_price',
              'ps.normalized_unit_price',
              'ps.source_type',
            );
          const verdict = classifyAgainstPending(pendingEvents, parsed.price, common);
          if (verdict.duplicate) {
            const dup = verdict.duplicateEvent;
            return {
              duplicate: true,
              eventId: dup.id,
              snapshotId: dup.snapshot_id,
              vendorPricingId: dup.vendor_pricing_id,
              oldPrice: dup.old_price_amount != null ? Number(dup.old_price_amount) : null,
              change,
            };
          }
          if (verdict.supersedeIds.length) {
            // Re-check approval_status in the UPDATE itself: between the SELECT
            // above and here an admin may have approved one of these events, so
            // reject ONLY rows that are still pending (never clobber an approved
            // one). Matches the atomic pending-only claim in admin-inventory.js.
            await trx('price_approval_events')
              .whereIn('id', verdict.supersedeIds)
              .where('approval_status', 'pending')
              .update({
                approval_status: 'rejected',
                rejected_by: 'hermes',
                rejected_at: trx.fn.now(),
                approval_reason: 'Superseded by a newer Hermes price report',
              });
          }

          // No-op a recurring scan that reports the already-live price AND the
          // same unit economics: don't refill the queue with a 0-change
          // approval. Runs AFTER supersede so a stale pending Hermes change is
          // still invalidated even when this report matches the live price.
          if (isUnchangedApprovedPrice(existing, parsed.price, common)) {
            return {
              unchanged: true,
              eventId: null,
              snapshotId: null,
              vendorPricingId: existing.id,
              oldPrice,
              change,
            };
          }

          // Reference the live row if it exists (approve updates it in place);
          // otherwise create a pending/inactive row so best_price ignores it.
          let vendorPricingId;
          if (existing) {
            vendorPricingId = existing.id;
          } else {
            const [vp] = await trx('vendor_pricing')
              .insert({
                ...buildPendingVendorPricingRow({ parsed, item, mapping }),
                last_checked_at: trx.fn.now(),
                created_at: trx.fn.now(),
                updated_at: trx.fn.now(),
              })
              .returning('id');
            vendorPricingId = vp?.id || vp;
          }

          const [snap] = await trx('price_snapshots')
            .insert({
              ...buildSnapshotRow({ parsed, item, mapping, vendorPricingId, change, oldPrice }),
              fetched_at: trx.fn.now(),
              captured_at: trx.fn.now(),
            })
            .returning('id');
          const snapshotId = snap?.id || snap;

          // Point the (new) pending row at its snapshot. Leave a live row's
          // latest_snapshot_id untouched until the price is approved.
          if (!existing) {
            await trx('vendor_pricing')
              .where({ id: vendorPricingId })
              .update({ latest_snapshot_id: snapshotId, updated_at: trx.fn.now() });
          }

          const [evt] = await trx('price_approval_events')
            .insert(buildApprovalEventRow({ parsed, snapshotId, vendorPricingId, change, oldPrice }))
            .returning('id');
          const eventId = evt?.id || evt;

          return { duplicate: false, vendorPricingId, snapshotId, eventId, oldPrice, change };
        });

        results.push({
          row: rowNumber,
          product_id: parsed.productId,
          product_name: product.name,
          vendor_id: parsed.vendorId,
          vendor_name: vendor.name,
          approval_event_id: written.eventId,
          snapshot_id: written.snapshotId,
          vendor_pricing_id: written.vendorPricingId,
          old_price: written.oldPrice,
          new_price: parsed.price,
          change_amount: written.change.changeAmount,
          status: written.unchanged
            ? 'already_current'
            : (written.duplicate ? 'already_queued' : 'queued_for_review'),
        });
      } catch (rowErr) {
        logger.error(`[vendor-price-worker] row ${rowNumber} failed: ${rowErr.message}`);
        rowErrors.push({ row: rowNumber, errors: [rowErr.message] });
      }
    }

    const queuedCount = results.filter((r) => r.status === 'queued_for_review').length;
    const duplicateCount = results.filter((r) => r.status === 'already_queued').length;
    const unchangedCount = results.filter((r) => r.status === 'already_current').length;
    return res.status(202).json({
      accepted: rowErrors.length === 0,
      rowsReceived: items.length,
      queued: queuedCount,
      duplicates: duplicateCount,
      unchanged: unchangedCount,
      results,
      rowErrors,
      message: `${queuedCount} price${queuedCount === 1 ? '' : 's'} queued for review`
        + (duplicateCount ? `, ${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'} skipped` : '')
        + (unchangedCount ? `, ${unchangedCount} unchanged` : '')
        + `. ${rowErrors.length} row${rowErrors.length === 1 ? '' : 's'} rejected.`,
    });
  } catch (err) { next(err); }
});

router._test = {
  isNumericInput,
  toPositiveDecimalOrNull,
  approxEqual,
  priceFingerprintMatches,
  parseReportItem,
  computeChange,
  isUnchangedApprovedPrice,
  classifyAgainstPending,
  resolveDistinctProductId,
  buildCommonPriceFields,
  buildSnapshotRow,
  buildPendingVendorPricingRow,
  buildApprovalEventRow,
  PRICE_TYPES,
  AVAILABILITY_STATUSES,
  SOURCE_TYPE,
};

module.exports = router;
