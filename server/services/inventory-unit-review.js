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
 *
 * Second phase (owner 2026-11-01, Action inbox agents A): DRY products whose
 * unit is a bare ounce are converted to g or lb (exact weight conversion,
 * stock and threshold converted with it). Its own gate,
 * GATE_INVENTORY_UNIT_AUTOFIX_DRY_OZ === 'true', read at call time via
 * inventoryUnitAutofixDryOzLive(); it also needs the sweep gate above. resolveDryOzTarget() decides, and parks everything doubtful.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled, inventoryUnitAutofixDryOzLive } = require('../config/feature-gates');
const {
  convertInventoryQuantity,
  normalizeInventoryUnit,
  unitDefinition,
} = require('./inventory-units');

// Same clamp posture as data-hygiene auto-apply: env-tunable, hard ceiling.
const BATCH_CAP = clampCap(process.env.INVENTORY_UNIT_AUTOFIX_BATCH, 50);

// Candidate SCAN page size — deliberately independent of BATCH_CAP. The
// candidate predicate also selects park-only rows ('bottles', 'cases', ...)
// so an identically-ordered LIMIT BATCH_CAP could fill with the same parked
// rows on every run and starve the fixable aliases sorted behind them
// forever. The sweep pages through candidates and filters RESOLVABLE
// aliases BEFORE applying the cap, so parked rows never consume batch slots.
const CANDIDATE_PAGE_SIZE = 200;

function clampCap(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

// The unit-review queue's "unsupported unit" branch. Since r15 the lockstep
// with dashboard-alerts.js and GET /admin/inventory/unit-review is
// STRUCTURAL: all three consume applyUnitReviewQueueFilter below instead of
// carrying copies. NOT the sweep's candidate filter: this predicate
// normalizes spellings before its NOT IN, so the very aliases the autofix
// exists to fix ('Gallons', 'Liters', 'FL OZ') read as supported and would
// never be selected.
const UNSUPPORTED_UNIT_SQL = `
  nullif(trim(coalesce(inventory_unit, '')), '') is not null
  AND regexp_replace(lower(replace(trim(inventory_unit), ' ', '_')), 's$', '') NOT IN ('fl_oz','floz','gal','gallon','qt','quart','pt','pint','ml','l','liter','oz','ounce','lb','pound','g','gram','kg','each')
`;

// The catalog's CANONICAL storage keys — the exact strings a fixed row ends
// up holding. The sweep's candidate filter excludes ONLY these exact strings
// (any other spelling differs from its canonical form and is worth showing
// to resolveInventoryUnitAlias, which decides park-vs-fix), plus the whole
// oz family ('oz'/'ounce' in any case/plural), which is ambiguous and must
// never even occupy a slot in the capped batch.
const CANONICAL_STORAGE_UNITS = ['fl_oz', 'gal', 'qt', 'pt', 'ml', 'l', 'lb', 'g', 'kg', 'each'];
const OZ_FAMILY_SQL = "regexp_replace(lower(replace(trim(inventory_unit), ' ', '_')), 's$', '') IN ('oz','ounce')";

/**
 * The unit-review QUEUE predicate — ONE definition consumed by the sweep's
 * digest remaining-count, GET /admin/inventory/unit-review, and
 * dashboard-alerts, so the notification can never count rows the review
 * page doesn't show (r15: the route still used a bare whereNull for
 * missing and an exact lower(...)='oz' for ambiguous, so 'Ounces' and
 * whitespace-only units counted in the digest but were invisible on the
 * page). Branches, in queue terms:
 *   - BLANK unit (SQL NULL or whitespace-only — same trim the resolver
 *     applies) while the product carries inventory numbers;
 *   - the AMBIGUOUS ounce family in any spelling/plural (OZ_FAMILY_SQL);
 *   - any other UNSUPPORTED spelling (UNSUPPORTED_UNIT_SQL).
 */
function applyUnitReviewQueueFilter(query) {
  return query.where(function unitIssue() {
    this.where(function missingUnit() {
      this.whereRaw("nullif(trim(coalesce(inventory_unit, '')), '') is null")
        .where(function hasInventoryValue() {
          this.whereNotNull('inventory_on_hand').orWhereNotNull('low_stock_threshold');
        });
    })
      .orWhereRaw(OZ_FAMILY_SQL)
      .orWhereRaw(UNSUPPORTED_UNIT_SQL);
  });
}

/**
 * Candidate filter for the autofix sweep, applied to a knex query on
 * products_catalog: rows with a non-empty stored unit that is not already an
 * exact canonical key and not in the oz family. resolveInventoryUnitAlias
 * makes the actual fix-or-park call per row (bounded by BATCH_CAP).
 */
function applyAutofixCandidateFilter(query) {
  return query
    .whereRaw("nullif(trim(coalesce(inventory_unit, '')), '') is not null")
    .whereNotIn('inventory_unit', CANONICAL_STORAGE_UNITS)
    .whereRaw(`NOT (${OZ_FAMILY_SQL})`);
}

// Pure JS mirror of applyAutofixCandidateFilter's SQL — one predicate, two
// dialects, pinned against each other in tests so they cannot drift.
function isAutofixCandidateUnit(rawUnit) {
  const raw = String(rawUnit == null ? '' : rawUnit);
  if (!raw.trim()) return false;
  // EXACT match like the SQL's NOT IN — ' gal ' or 'Gal' differs from its
  // canonical form and stays a candidate (the resolver renames it).
  if (CANONICAL_STORAGE_UNITS.includes(raw)) return false;
  const squashed = raw.trim().replace(/ /g, '_').toLowerCase().replace(/s$/, '');
  if (squashed === 'oz' || squashed === 'ounce') return false;
  return true;
}

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

// Moved here from routes/admin-inventory.js so the Unit Review page and the
// dry-oz sweep share ONE definition of "looks liquid".
function looksLiquidProduct(product = {}) {
  const text = `${product.name || ''} ${product.category || ''} ${product.subcategory || ''} ${product.formulation || ''} ${product.unit_type || ''}`.toLowerCase();
  return /\b(liquid|flowable|sc|sl|ec|ew|solution|sprayable|hydretain|talstar|atrazine|dismiss|headway|medallion|primo|acelepryn|dispatch|carbonpro|k-flow)\b/.test(text);
}

// --- Dry-oz target -------------------------------------------------------
// A bare "oz" is ambiguous (weight or fluid). A product whose formulation is
// positively dry (WDG, granular, powder, dust, paste, gel bait...) holds
// WEIGHT ounces, so oz -> g / lb is an exact conversion. Anything else stays
// parked for a human.
const DRY_FORMULATION_RE = /\b(wdg|wg|wsg|wp|sp|df|sg)\b|granul|powder|dust|\bpaste\b|\bgel\b|pellet|\bmeal\b|\bdry\b|bait block|bait chunk/;
// Count stock lives in 'each' (inventory-units.js refuses oz <-> each). Count
// words are read across EVERY catalog text field, not only the formulation: a
// "Granular Bait Station" (formulation granular) is counted by the station. A
// bare "bait" word is deliberately NOT dry evidence and NOT a count sign.
const COUNT_WORD_RE = /cartridge|briquet|station|tablet|\btrap|supply|live plug|foam|\beach\b|\bcount\b|\bpieces?\b/;
const COUNT_BASE_UNITS = new Set(['each', 'ea', 'count', 'ct', 'piece', 'pc', 'station', 'placement']);
const LIQUID_FORMULATION_RE = /\b(sc|se|ec|ew|cs|me|mec|sl|aq|flowable|liquid|concentrate|suspension|emulsion|emulsifiable|microemulsion|oil|solution)\b/;
const VOLUME_BASE_UNITS = new Set(['fl_oz', 'floz', 'gal', 'gallon', 'qt', 'quart', 'pt', 'pint', 'ml', 'l', 'liter', 'litre']);
// A pound or more of weight ounces.
const DRY_OZ_POUND_THRESHOLD_OZ = 16;

function isOzFamilyUnit(rawUnit) {
  const squashed = String(rawUnit == null ? '' : rawUnit).trim().replace(/ /g, '_').toLowerCase().replace(/s$/, '');
  return squashed === 'oz' || squashed === 'ounce';
}

// The quantity part of a rate/default unit ("fl_oz/1000sf" -> fl_oz,
// "each/station" -> each), spelling-normalized.
function baseUnitOf(rawUnit) {
  return String(rawUnit == null ? '' : rawUnit).split('/')[0]
    .trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, '_').replace(/s$/, '');
}

function isVolumeBaseUnit(rawUnit) {
  return VOLUME_BASE_UNITS.has(baseUnitOf(rawUnit));
}

function hasDryEvidence(formulation) {
  if (!formulation || formulation === 'unspecified') return false;
  if (!DRY_FORMULATION_RE.test(formulation)) return false;
  return !LIQUID_FORMULATION_RE.test(formulation);
}

// Any sign the product is stocked by the piece: a count word in the name,
// category, subcategory, formulation or unit type, or a rate/default unit
// counted per item ("each/station").
function hasCountEvidence(product) {
  const text = [product.name, product.category, product.subcategory, product.formulation, product.unit_type]
    .map((value) => String(value == null ? '' : value)).join(' ').toLowerCase();
  if (COUNT_WORD_RE.test(text)) return true;
  return [product.rate_unit, product.default_unit].some((unit) => COUNT_BASE_UNITS.has(baseUnitOf(unit)));
}

/**
 * 'g', 'lb' or null (null = stays parked for a human). Pure.
 * Target: 'lb' from 16 oz of stock up (the bag convention), else 'g' (keeps
 * small containers readable: 0.4433 oz = 12.5673 g but 0.0277 lb). Both are
 * exact weight conversions. Null or zero stock -> 'g'.
 */
function resolveDryOzTarget(product = {}) {
  if (!isOzFamilyUnit(product.inventory_unit)) return null;
  const formulation = String(product.formulation == null ? '' : product.formulation).trim().toLowerCase();
  if (!hasDryEvidence(formulation)) return null;
  if (hasCountEvidence(product)) return null;
  if (looksLiquidProduct(product)) return null;
  if (isVolumeBaseUnit(product.rate_unit) || isVolumeBaseUnit(product.default_unit)) return null;
  return Number(product.inventory_on_hand) >= DRY_OZ_POUND_THRESHOLD_OZ ? 'lb' : 'g';
}

// Zero is zero in every unit of the same dimension. convertInventoryQuantity
// refuses a non-positive amount, so a row counted down to 0 could never be
// fixed: the Unit Review Fix answered 400 and the dry-oz sweep would retry it
// every night. Units that cannot convert still return null (refused).
function convertStockAmount(amount, fromUnit, toUnit) {
  if (amount === 0) return convertInventoryQuantity(1, fromUnit, toUnit) == null ? null : 0;
  return convertInventoryQuantity(amount, fromUnit, toUnit);
}

// True when the locked row no longer matches what the caller decided on.
function isStaleLock(product, { expectedCurrentUnit, lockedCheck }) {
  if (expectedCurrentUnit !== undefined
    && String(product.inventory_unit || '') !== String(expectedCurrentUnit || '')) return true;
  return Boolean(lockedCheck) && !lockedCheck(product);
}

/**
 * Normalize one product's inventory unit. Extracted from the admin route —
 * route behavior is unchanged (same guards, same conversion, same movement
 * row). Sweep-only additions are opt-in flags:
 *   expectedCurrentUnit — refuse (outcome 'stale') if the locked row's unit
 *     changed since the caller selected it (an admin fix mid-sweep wins).
 *   alwaysRecordMovement — audit a zero-quantity 'correction' movement even
 *     when no numbers changed, so every autonomous rename leaves a trail.
 *   lockedCheck — fn(lockedProductRow); false = outcome 'stale', no write
 *     (re-checks the caller's decision against the row it now holds locked).
 *   movementReason — audit-row reason text (default: the alias/normalization
 *     strings below).
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
  lockedCheck = undefined,
  movementReason = undefined,
}) {
  // Mirrors the route's assertSupportedInventoryUnit exactly (including its
  // empty-string pass-through) so extracting this changed no route behavior.
  const targetUnit = String(nextUnit || '').trim();
  if (targetUnit && !unitDefinition(targetUnit)) {
    const err = new Error('Inventory unit is not supported');
    err.statusCode = 400;
    throw err;
  }

  const reasons = {
    conversion: movementReason || 'Inventory unit normalization',
    rename: movementReason || 'Inventory unit alias normalization (no quantity change)',
  };

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
    if (isStaleLock(product, { expectedCurrentUnit, lockedCheck })) {
      // The row changed between the caller's read and this lock (a human or
      // another sweep already acted) or the caller's own re-check failed:
      // leave the row alone.
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
      stockAfter = stockBefore != null ? convertStockAmount(stockBefore, currentUnit, targetUnit) : null;
      thresholdAfter = thresholdBefore != null ? convertStockAmount(thresholdBefore, currentUnit, targetUnit) : null;
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
      const stockBeforeInNextUnit = convertStockAmount(stockBefore, currentUnit, targetUnit);
      await trx('product_inventory_movements').insert({
        product_id: product.id,
        movement_type: 'correction',
        quantity: Number(((stockAfter || 0) - (stockBeforeInNextUnit || 0)).toFixed(4)),
        unit: targetUnit,
        stock_before: stockBeforeInNextUnit,
        stock_after: stockAfter || 0,
        metadata: {
          source: movementSource,
          reason: reasons.conversion,
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
          reason: reasons.rename,
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

  // Scan candidates in stable pages (name, id) and take the first BATCH_CAP
  // RESOLVABLE aliases — parked (unresolvable) rows are counted but never
  // occupy a batch slot, so they can't starve fixable rows sorted after
  // them. The cap still bounds the number of WRITES per run.
  const fixable = [];
  let parked = 0;
  for (let offset = 0; ; offset += CANDIDATE_PAGE_SIZE) {
    const page = await applyAutofixCandidateFilter(dbi('products_catalog'))
      .select('id', 'name', 'inventory_unit')
      .orderBy('name')
      .orderBy('id')
      .limit(CANDIDATE_PAGE_SIZE)
      .offset(offset);
    for (const candidate of page) {
      const target = resolveInventoryUnitAlias(candidate.inventory_unit);
      if (!target) {
        parked += 1;
        continue;
      }
      if (fixable.length < BATCH_CAP) fixable.push({ ...candidate, target });
    }
    if (fixable.length >= BATCH_CAP || page.length < CANDIDATE_PAGE_SIZE) break;
  }

  const results = { applied: 0, parked, stale: 0, errors: 0, fixes: [], dryOz: { applied: 0, parked: 0, stale: 0, errors: 0 } };
  for (const candidate of fixable) {
    const { target } = candidate;
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
        results.fixes.push({ kind: 'alias', productId: candidate.id, name: candidate.name, from: candidate.inventory_unit, to: target });
      } else {
        results.stale += 1;
      }
    } catch (err) {
      results.errors += 1;
      logger.warn(`[inventory-unit-autofix] fix failed for product ${candidate.id} (left parked): ${err.message}`);
    }
  }

  if (inventoryUnitAutofixDryOzLive()) {
    await runDryOzPhase({ dbi, results });
  }

  if (results.applied > 0 || results.dryOz.applied > 0) {
    await sendAutofixDigest({ dbi, results });
  }

  logger.info(`[inventory-unit-autofix] sweep: applied=${results.applied} parked=${results.parked} stale=${results.stale} errors=${results.errors} dryOz=${JSON.stringify(results.dryOz)}`);
  return results;
}

/**
 * Dry-oz phase (gate inventoryUnitAutofixDryOz, on top of the sweep gate):
 * oz-family rows with positive dry-by-weight evidence are converted to g/lb
 * with their stock and threshold. Same one-transaction-per-product posture
 * as the alias phase; the decision is re-checked under the row lock.
 */
async function runDryOzPhase({ dbi, results }) {
  const dry = results.dryOz;
  let rows;
  try {
    rows = await dbi('products_catalog')
      .whereRaw(OZ_FAMILY_SQL)
      .select('id', 'name', 'category', 'subcategory', 'formulation', 'unit_type', 'inventory_unit',
        'inventory_on_hand', 'low_stock_threshold', 'rate_unit', 'default_unit')
      .orderBy('name')
      .orderBy('id');
  } catch (err) {
    dry.errors += 1;
    logger.warn(`[inventory-unit-autofix] dry-oz scan failed (skipped): ${err.message}`);
    return;
  }

  const fixable = [];
  for (const row of rows || []) {
    const target = resolveDryOzTarget(row);
    if (!target) {
      dry.parked += 1;
    } else if (fixable.length < BATCH_CAP) {
      fixable.push({ ...row, target });
    }
  }

  for (const candidate of fixable) {
    const { target } = candidate;
    try {
      const { outcome } = await applyInventoryUnitFix({
        dbi,
        productId: candidate.id,
        nextUnit: target,
        convertExistingStock: true,
        movementSource: 'inventory_unit_review_autofix_dry_oz',
        adjustedBy: 'auto:inventory-unit-autofix',
        expectedCurrentUnit: candidate.inventory_unit,
        alwaysRecordMovement: true,
        movementReason: `Dry product: weight ounces converted to ${target}`,
        lockedCheck: (locked) => resolveDryOzTarget(locked) === target,
      });
      if (outcome === 'applied') {
        dry.applied += 1;
        results.fixes.push({ kind: 'dry_oz', productId: candidate.id, name: candidate.name, from: candidate.inventory_unit, to: target });
      } else {
        dry.stale += 1;
      }
    } catch (err) {
      dry.errors += 1;
      logger.warn(`[inventory-unit-autofix] dry-oz fix failed for product ${candidate.id} (left parked): ${err.message}`);
    }
  }
}

function digestSample(fixes) {
  const sample = fixes.slice(0, 5).map((f) => `${f.name} (${f.from} → ${f.to})`).join(', ');
  return `${sample}${fixes.length > 5 ? ` and ${fixes.length - 5} more` : ''}`;
}

// Digest text: one sentence per kind that happened, so "no quantities
// changed" is only ever said about alias renames.
function buildAutofixDigest(results, remainingCount) {
  const aliasFixes = results.fixes.filter((f) => f.kind === 'alias');
  const dryFixes = results.fixes.filter((f) => f.kind === 'dry_oz');
  const titleParts = [];
  const bodyParts = [];
  if (aliasFixes.length) {
    titleParts.push(`${aliasFixes.length} unit alias${aliasFixes.length === 1 ? '' : 'es'} auto-fixed`);
    bodyParts.push(`${digestSample(aliasFixes)}. Pure spelling/plural renames only — no quantities changed.`);
  }
  if (dryFixes.length) {
    titleParts.push(`${dryFixes.length} dry product${dryFixes.length === 1 ? '' : 's'} converted from oz`);
    bodyParts.push(`${digestSample(dryFixes)}. Dry products converted from oz to g or lb — an exact weight conversion; stock and low-stock level converted with it.`);
  }
  bodyParts.push(`Each fix left a movement audit row. ${remainingCount} product${remainingCount === 1 ? '' : 's'} still need${remainingCount === 1 ? 's' : ''} unit review.`);
  return { title: `Inventory: ${titleParts.join(', ')}`, body: bodyParts.join(' ') };
}

async function sendAutofixDigest({ dbi, results }) {
  try {
    // Remaining-for-review = the FULL unit-review predicate (missing unit,
    // ambiguous oz, still-unsupported), same shape as dashboard-alerts.
    // The SHARED queue predicate (applyUnitReviewQueueFilter) — the same
    // filter the review route and dashboard-alerts run, so this count can
    // never disagree with what the page shows.
    const remaining = await applyUnitReviewQueueFilter(dbi('products_catalog'))
      .count('* as count')
      .first();
    const remainingCount = Number.parseInt(remaining?.count || 0, 10);
    const { title, body } = buildAutofixDigest(results, remainingCount);
    await require('./notification-service').notifyAdmin('system', title, body, {
      link: '/admin/inventory?tab=unit-review',
      metadata: {
        applied: results.applied,
        parked: results.parked,
        stale: results.stale,
        errors: results.errors,
        dryOz: results.dryOz,
        remainingForReview: remainingCount,
        fixes: results.fixes,
      },
    });
  } catch (notifyErr) {
    logger.warn(`[inventory-unit-autofix] digest notify failed (non-blocking): ${notifyErr.message}`);
  }
}

module.exports = {
  applyInventoryUnitFix,
  applyUnitReviewQueueFilter,
  looksLiquidProduct,
  resolveDryOzTarget,
  resolveInventoryUnitAlias,
  runInventoryUnitAutofixSweep,
  _test: {
    buildAutofixDigest,
    applyUnitReviewQueueFilter,
    BATCH_CAP,
    CANDIDATE_PAGE_SIZE,
    CANONICAL_UNIT,
    UNSUPPORTED_UNIT_SQL,
    CANONICAL_STORAGE_UNITS,
    OZ_FAMILY_SQL,
    applyAutofixCandidateFilter,
    isAutofixCandidateUnit,
  },
};
