/**
 * Inventory unit review — shared fix applier + the nightly alias auto-fix.
 *
 * applyInventoryUnitFix() is the ONE write path for normalizing a product's
 * inventory_unit (extracted from POST /admin/inventory/unit-review/:id/fix,
 * behavior-identical for the route): transaction + forUpdate, optional stock/
 * threshold conversion via convertInventoryQuantity, and a
 * product_inventory_movements 'correction' audit row.
 *
 * runInventoryUnitAutofixSweep() clears the unit-review queue's PURE-ALIAS
 * rows only: products whose inventory_unit is an unsupported string that
 * normalizes to exactly one supported, unambiguous unit at conversion factor
 * 1 ("Gallons" -> gal, "FL  OZ" -> fl_oz). It NEVER touches missing-unit
 * rows or ambiguous-oz rows — those stay parked for human review (they need
 * a judgment call, not a spelling fix). Applies with NO quantity conversion
 * (an alias is the same unit, so the numbers are already right), capped per
 * run, one digest bell per sweep. Gate: inventoryUnitAutofix
 * (GATE_INVENTORY_UNIT_AUTOFIX === 'true', opt-in in EVERY environment —
 * auto-writer pattern, same as dataHygieneAutoApply). Cron: 3:45am ET,
 * runExclusive 'inventory-unit-autofix' (job_health via cron-lock).
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const {
  convertInventoryQuantity,
  normalizeInventoryUnit,
  unitDefinition,
} = require('./inventory-units');

// Same clamp posture as data-hygiene auto-apply: env-tunable, hard ceiling.
const BATCH_CAP = clampCap(process.env.INVENTORY_UNIT_AUTOFIX_BATCH, 50);

function clampCap(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

// The unit-review queue's "unsupported unit" branch — MUST stay in lockstep
// with dashboard-alerts.js and GET /admin/inventory/unit-review. This is the
// only branch the autofix reads: missing-unit rows need a human to pick a
// unit, and 'oz'/'ounce' normalize into the supported (ambiguous) set so
// they never match this predicate.
const UNSUPPORTED_UNIT_SQL = `
  nullif(trim(coalesce(inventory_unit, '')), '') is not null
  AND regexp_replace(lower(replace(trim(inventory_unit), ' ', '_')), 's$', '') NOT IN ('fl_oz','floz','gal','gallon','qt','quart','pt','pint','ml','l','liter','oz','ounce','lb','pound','g','gram','kg')
`;

// Long-form supported spellings collapse to the catalog's canonical short
// unit so "Gallons" lands as gal, not gallon (both are factor-128 volume —
// the alias check below proves the factor-1 equivalence either way).
const CANONICAL_UNIT = {
  gallon: 'gal',
  quart: 'qt',
  pint: 'pt',
  liter: 'l',
  pound: 'lb',
  gram: 'g',
  floz: 'fl_oz',
};

/**
 * Resolve a raw inventory_unit string to its canonical supported unit, ONLY
 * when the fix is a pure alias/case/plural rename:
 *   - normalizes to a supported unit (else: parked, human review),
 *   - of unambiguous dimension (excludes the oz family by construction),
 *   - at conversion factor exactly 1 (same unit, different spelling).
 * Returns the target unit string, or null (= stays parked).
 */
function resolveInventoryUnitAlias(rawUnit) {
  const raw = String(rawUnit || '').trim();
  if (!raw) return null; // missing unit — never autofix
  const normalized = normalizeInventoryUnit(raw);
  const def = unitDefinition(normalized);
  if (!def) return null; // not a recognizable alias
  if (def.dimension === 'ambiguous') return null; // oz family — judgment call
  const target = CANONICAL_UNIT[normalized] || normalized;
  // Pure alias means the quantity numbers are ALREADY in the target unit.
  if (convertInventoryQuantity(1, raw, target) !== 1) return null;
  return target;
}

/**
 * Normalize one product's inventory unit. Extracted from the admin route —
 * route behavior is unchanged (same guards, same conversion, same movement
 * row). Sweep-only additions are opt-in flags:
 *   expectedCurrentUnit — refuse (outcome 'stale') if the locked row's unit
 *     changed since the caller selected it (an admin fix mid-sweep wins).
 *   alwaysRecordMovement — audit a zero-quantity 'correction' movement even
 *     when no numbers changed, so every autonomous rename leaves a trail.
 * Throws err.statusCode 400/404 like the route always did.
 */
async function applyInventoryUnitFix({
  dbi = db,
  productId,
  nextUnit,
  convertExistingStock = true,
  movementSource = 'inventory_unit_review_fix',
  adjustedBy = null,
  expectedCurrentUnit = undefined,
  alwaysRecordMovement = false,
}) {
  // Mirrors the route's assertSupportedInventoryUnit exactly (including its
  // empty-string pass-through) so extracting this changed no route behavior.
  const targetUnit = String(nextUnit || '').trim();
  if (targetUnit && !unitDefinition(targetUnit)) {
    const err = new Error('Inventory unit is not supported');
    err.statusCode = 400;
    throw err;
  }

  return dbi.transaction(async (trx) => {
    const product = await trx('products_catalog')
      .where({ id: productId })
      .forUpdate()
      .first();
    if (!product) {
      const err = new Error('Product not found');
      err.statusCode = 404;
      throw err;
    }
    const currentUnit = product.inventory_unit || null;
    if (expectedCurrentUnit !== undefined
      && String(currentUnit || '') !== String(expectedCurrentUnit || '')) {
      // The row changed between the caller's read and this lock — a human
      // (or another sweep) already acted; leave their choice alone.
      return { outcome: 'stale', product };
    }
    const numberOrNull = (value) => {
      if (value === '' || value == null) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const stockBefore = numberOrNull(product.inventory_on_hand);
    const thresholdBefore = numberOrNull(product.low_stock_threshold);
    let stockAfter = stockBefore;
    let thresholdAfter = thresholdBefore;
    let conversion = null;

    if (convertExistingStock && currentUnit && normalizeInventoryUnit(currentUnit) !== normalizeInventoryUnit(targetUnit)) {
      stockAfter = stockBefore != null ? convertInventoryQuantity(stockBefore, currentUnit, targetUnit) : null;
      thresholdAfter = thresholdBefore != null ? convertInventoryQuantity(thresholdBefore, currentUnit, targetUnit) : null;
      if ((stockBefore != null && stockAfter == null) || (thresholdBefore != null && thresholdAfter == null)) {
        const err = new Error(`Cannot convert existing inventory from ${currentUnit} to ${targetUnit}`);
        err.statusCode = 400;
        throw err;
      }
      conversion = {
        fromUnit: currentUnit,
        toUnit: targetUnit,
        stockBefore,
        stockAfter,
        thresholdBefore,
        thresholdAfter,
      };
    }

    await trx('products_catalog').where({ id: product.id }).update({
      inventory_unit: targetUnit,
      inventory_on_hand: stockAfter,
      low_stock_threshold: thresholdAfter,
      updated_at: new Date(),
    });

    if (conversion && stockBefore != null) {
      const stockBeforeInNextUnit = convertInventoryQuantity(stockBefore, currentUnit, targetUnit);
      await trx('product_inventory_movements').insert({
        product_id: product.id,
        movement_type: 'correction',
        quantity: Number(((stockAfter || 0) - (stockBeforeInNextUnit || 0)).toFixed(4)),
        unit: targetUnit,
        stock_before: stockBeforeInNextUnit,
        stock_after: stockAfter || 0,
        metadata: {
          source: movementSource,
          reason: 'Inventory unit normalization',
          conversion,
          adjustedBy,
        },
      });
    } else if (alwaysRecordMovement) {
      // Pure rename (no quantity change): zero-quantity audit row so the
      // autonomous fix is visible in the movement history.
      await trx('product_inventory_movements').insert({
        product_id: product.id,
        movement_type: 'correction',
        quantity: 0,
        unit: targetUnit,
        stock_before: stockBefore != null ? stockBefore : 0,
        stock_after: stockAfter != null ? stockAfter : 0,
        metadata: {
          source: movementSource,
          reason: 'Inventory unit alias normalization (no quantity change)',
          fromUnit: currentUnit,
          toUnit: targetUnit,
          adjustedBy,
        },
      });
    }

    const updated = await trx('products_catalog').where({ id: product.id }).first();
    return { outcome: 'applied', product: updated };
  });
}

/**
 * The nightly sweep. One product per transaction (via applyInventoryUnitFix)
 * so one bad row can't poison the batch; ends with ONE digest bell.
 */
async function runInventoryUnitAutofixSweep({ dbi = db } = {}) {
  if (!isEnabled('inventoryUnitAutofix')) {
    return { skipped: 'gate_off' };
  }

  const candidates = await dbi('products_catalog')
    .whereRaw(UNSUPPORTED_UNIT_SQL)
    .select('id', 'name', 'inventory_unit')
    .orderBy('name')
    .limit(BATCH_CAP);

  const results = { applied: 0, parked: 0, stale: 0, errors: 0, fixes: [] };
  for (const candidate of candidates) {
    const target = resolveInventoryUnitAlias(candidate.inventory_unit);
    if (!target) {
      results.parked += 1;
      continue;
    }
    try {
      const { outcome } = await applyInventoryUnitFix({
        dbi,
        productId: candidate.id,
        nextUnit: target,
        // Pure alias — the numbers are already in the target unit.
        convertExistingStock: false,
        movementSource: 'inventory_unit_review_autofix',
        adjustedBy: 'auto:inventory-unit-autofix',
        expectedCurrentUnit: candidate.inventory_unit,
        alwaysRecordMovement: true,
      });
      if (outcome === 'applied') {
        results.applied += 1;
        results.fixes.push({ productId: candidate.id, name: candidate.name, from: candidate.inventory_unit, to: target });
      } else {
        results.stale += 1;
      }
    } catch (err) {
      results.errors += 1;
      logger.warn(`[inventory-unit-autofix] fix failed for product ${candidate.id} (left parked): ${err.message}`);
    }
  }

  if (results.applied > 0) {
    try {
      // Remaining-for-review = the FULL unit-review predicate (missing unit,
      // ambiguous oz, still-unsupported), same shape as dashboard-alerts.
      const remaining = await dbi('products_catalog')
        .where(function unitIssue() {
          this.where(function missingUnit() {
            this.whereNull('inventory_unit')
              .where(function hasInventoryValue() {
                this.whereNotNull('inventory_on_hand').orWhereNotNull('low_stock_threshold');
              });
          })
            .orWhereRaw("lower(coalesce(inventory_unit, '')) = 'oz'")
            .orWhereRaw(UNSUPPORTED_UNIT_SQL);
        })
        .count('* as count')
        .first();
      const remainingCount = Number.parseInt(remaining?.count || 0, 10);
      const sample = results.fixes.slice(0, 5)
        .map((f) => `${f.name} (${f.from} → ${f.to})`)
        .join(', ');
      const more = results.fixes.length > 5 ? ` and ${results.fixes.length - 5} more` : '';
      await require('./notification-service').notifyAdmin(
        'system',
        `Inventory: ${results.applied} unit alias${results.applied === 1 ? '' : 'es'} auto-fixed`,
        `${sample}${more}. Pure spelling/plural renames only — no quantities changed; each fix left a movement audit row. ${remainingCount} product${remainingCount === 1 ? '' : 's'} still need${remainingCount === 1 ? 's' : ''} unit review.`,
        {
          link: '/admin/inventory?tab=unit-review',
          metadata: {
            applied: results.applied,
            parked: results.parked,
            stale: results.stale,
            errors: results.errors,
            remainingForReview: remainingCount,
            fixes: results.fixes,
          },
        },
      );
    } catch (notifyErr) {
      logger.warn(`[inventory-unit-autofix] digest notify failed (non-blocking): ${notifyErr.message}`);
    }
  }

  logger.info(`[inventory-unit-autofix] sweep: applied=${results.applied} parked=${results.parked} stale=${results.stale} errors=${results.errors}`);
  return results;
}

module.exports = {
  applyInventoryUnitFix,
  resolveInventoryUnitAlias,
  runInventoryUnitAutofixSweep,
  _test: { BATCH_CAP, CANONICAL_UNIT, UNSUPPORTED_UNIT_SQL },
};
