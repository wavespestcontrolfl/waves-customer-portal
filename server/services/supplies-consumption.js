/**
 * supplies-consumption.js — per-completion consumables (yard-sign kit).
 *
 * Every completed visit leaves a sign card + stake + sticker in the yard.
 * The closeout hook calls consumeCompletionSupplies once per completion;
 * each product with `per_completion_usage > 0` gets ONE usage movement per
 * (product, visit) and its inventory_on_hand decremented by that usage.
 *
 * Contract:
 *   - gated on GATE_AUTO_REORDER at CALL time — the lane's one kill switch,
 *     shared with the reorder sweep: unset = { skipped: 'gated' } before any
 *     read, so PR 1 ships dark end to end (GH codex r6 P1).
 *   - idempotent on the closeout RESUME path: the partial unique index
 *     product_inventory_movements_completion_consumable_uniq (metadata.source
 *     = 'completion_consumable') makes the insert at-most-once; the stock
 *     decrement only runs when the insert actually happened.
 *   - skipped entirely for an incomplete visit, and for a closeout where no
 *     visit was performed (inspection_only / customer_declined) — no sign
 *     is left either way.
 *   - skipped for an inspection SERVICE (service type contains
 *     "inspection", e.g. "Pest Inspection Service") completed normally —
 *     the card is a pesticide-application notice and an inspection applies
 *     nothing. Owner can overrule by renaming the service or ruling
 *     otherwise; the rule lives in INSPECTION_SERVICE_RE.
 *   - retired products (active = false) are never consumed.
 *   - a kit item the technician ALSO logged in the completion product picker
 *     (an ordinary usage movement for the same product + visit already
 *     exists) is not consumed again — the picker deduction wins.
 *   - movements carry unit_cost / cost_used from products_catalog
 *     .cost_per_unit when the cost unit is the inventory unit, so job
 *     costing sees the kit's material cost.
 *   - a product with per_completion_service_lines set is consumed only when
 *     the visit's service line (detectServiceLine id) is in that list;
 *     null = every line. A visit with no resolvable line consumes nothing
 *     from a line-scoped product.
 *   - a product with no inventory_on_hand is skipped (same posture as
 *     deductProductInventory: no count → nothing to deduct).
 *   - negative stock is allowed (advisory, matches the chemical policy).
 *   - NEVER throws — the closeout must not depend on this.
 */
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');

const SOURCE = 'completion_consumable';
const GATE = 'GATE_AUTO_REORDER';
// A scheduled inspection (no application) leaves no yard sign.
const INSPECTION_SERVICE_RE = /\binspection\b/i;

// Reasons to do nothing at all, in order, decided before any read.
const SKIP_WHEN = [
  [() => !gateEnvValue(GATE), 'gated'],
  [(a) => !a.scheduledServiceId, 'no_scheduled_service_id'],
  [(a) => a.isIncompleteVisit, 'incomplete_visit'],
  [(a) => a.visitPerformed === false, 'visit_not_performed'],
  // An internal-only completion profile (Waves Assessment: a consultation
  // where treatment products are refused) is not an inspection by name and
  // detectServiceLine reads it as pest — the completion's own posture is the
  // authority (Codex r9 P2).
  [(a) => a.isInternalOnlyCompletion === true, 'internal_only_completion'],
  [(a) => !!a.serviceType && INSPECTION_SERVICE_RE.test(String(a.serviceType)), 'inspection_service'],
];

// SQL NULL = every line. Anything else must be an array of line keys —
// a malformed value is INVALID, never "every line": a bad row must not
// deduct a pest-scoped kit on a termite or rodent visit (pre-push P1).
const INVALID_LINES = Symbol('invalid_service_lines');
function parseLines(raw) {
  if (raw == null) return null;
  const arr = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return INVALID_LINES; } })() : raw;
  return Array.isArray(arr) ? arr.map((x) => String(x)) : INVALID_LINES;
}

// null = every line; invalid = none; a scoped list needs a resolvable line.
function appliesToLine(rawLines, serviceLine) {
  const lines = parseLines(rawLines);
  if (lines === null) return true;
  if (lines === INVALID_LINES) return false;
  return !!serviceLine && lines.includes(String(serviceLine));
}

// The miss is never silent: one deduped bell so the office adjusts the
// count by hand — per (product, visit), or per visit when the product
// lookup itself failed (Codex r3 P2, r14 P2). notifyAdmin resolves NULL
// when it could not persist the notification, so the resolved row is
// checked like a throw: a lost bell is an error-level log and an errors
// entry, never a silent success (Codex r11 P2).
async function ringMissedDeductionBell(result, { scheduledServiceId, product = null, reason }) {
  const title = product ? `Inventory: ${product.name} was not deducted for a completed visit` : 'Inventory: yard-sign supplies were not deducted for a completed visit';
  // The lookup bell names no product: which kit items this visit should
  // have consumed is decided only after the lookup (service-line scope), so
  // it must not prescribe a deduction (Codex r15 P2).
  const body = product
    ? `Adjust the count by ${product.per_completion_usage} ${product.inventory_unit || ''} on the Inventory page. Reason: ${reason}`
    : `The consumables lookup failed, so nothing was deducted for this visit — check on the Inventory page which per-visit supplies apply to this service line and adjust those counts by hand. Reason: ${reason}`;
  const dedupeKey = product ? `supplies-consumption-failed:${product.id}:${scheduledServiceId}` : `supplies-consumption-failed:lookup:${scheduledServiceId}`;
  try {
    const bell = await require('./notification-service').notifyAdmin('system', title, body, { bell: true, link: '/admin/inventory', dedupeKey, metadata: { productId: product?.id || null, scheduledServiceId } });
    if (!bell) throw new Error('notification not persisted');
  } catch (bellErr) {
    logger.error(`[supplies-consumption] failure bell NOT sent for ${product ? product.name : 'the visit'} on visit ${scheduledServiceId}: ${bellErr.message}`);
    result.errors.push({ productId: product?.id || null, reason: 'failure_bell_not_sent', message: bellErr.message });
  }
}

// A deduction that SUCCEEDS on a retried completion (the resume path runs
// this hook again) retires the failure bell an earlier attempt rang for
// the same (product, visit) — and the visit-scoped lookup bell — so staff
// do not follow a stale "adjust by hand" on top of the real deduction
// (Codex r15 P2). Best effort, never throws.
async function clearMissedDeductionBells(db, { scheduledServiceId, productId }) {
  const keys = [`supplies-consumption-failed:${productId}:${scheduledServiceId}`, `supplies-consumption-failed:lookup:${scheduledServiceId}`];
  try {
    await db('notifications').whereRaw("metadata->>'dedupeKey' = ANY(?)", [keys]).whereNull('read_at').update({ read_at: new Date() });
  } catch (err) {
    logger.warn(`[supplies-consumption] could not retire the failure bell for ${productId} on visit ${scheduledServiceId}: ${err.message}`);
  }
}

async function consumeCompletionSupplies(db, {
  scheduledServiceId,
  serviceRecordId = null,
  customerId = null,
  technicianId = null,
  isIncompleteVisit = false,
  visitPerformed = true,
  isInternalOnlyCompletion = false,
  serviceLine = null,
  serviceType = null,
} = {}) {
  const result = { consumed: [], skipped: [], errors: [] };
  const skip = SKIP_WHEN.find(([applies]) => applies({ scheduledServiceId, isIncompleteVisit, visitPerformed, isInternalOnlyCompletion, serviceType }));
  if (skip) { result.skipped.push({ reason: skip[1] }); return result; }

  let products;
  try {
    products = await db('products_catalog')
      .where('active', true)
      .whereNotNull('per_completion_usage')
      .where('per_completion_usage', '>', 0)
      .select('id', 'name', 'per_completion_usage', 'per_completion_service_lines', 'inventory_on_hand', 'inventory_unit');
  } catch (err) {
    logger.warn(`[supplies-consumption] product lookup failed (non-blocking): ${err.message}`);
    result.errors.push({ reason: 'lookup_failed', message: err.message });
    await ringMissedDeductionBell(result, { scheduledServiceId, reason: err.message });
    return result;
  }

  for (const product of products) {
    if (parseLines(product.per_completion_service_lines) === INVALID_LINES) {
      // A corrupt scope is a hand-off like any other miss: the deduction
      // is not retried (the config would fail again), so staff must hear
      // about it (Codex #3832 hook P1).
      logger.warn(`[supplies-consumption] ${product.name}: per_completion_service_lines is not a list — nothing consumed (fix it on the Inventory page)`);
      result.errors.push({ productId: product.id, reason: 'invalid_service_lines' });
      await ringMissedDeductionBell(result, { scheduledServiceId, product, reason: 'per_completion_service_lines is not a list — fix the product, then adjust the count' });
      continue;
    }
    if (!appliesToLine(product.per_completion_service_lines, serviceLine)) {
      result.skipped.push({ productId: product.id, reason: 'service_line_excluded' });
      continue;
    }
    try {
      const outcome = await db.transaction(async (trx) => {
        const locked = await trx('products_catalog').where({ id: product.id }).forUpdate().first();
        if (!locked) return { skipped: 'missing' };
        // Eligibility is re-derived from the LOCKED row: a retire or a
        // service-line edit between the scan and the lock must not deduct
        // (pre-push codex P1).
        if (locked.active === false) return { skipped: 'retired' };
        if (!appliesToLine(locked.per_completion_service_lines, serviceLine)) return { skipped: 'service_line_excluded' };
        const usage = Number(locked.per_completion_usage);
        if (!Number.isFinite(usage) || usage <= 0) return { skipped: 'no_usage' };
        if (locked.inventory_on_hand == null || locked.inventory_on_hand === '') return { skipped: 'no_on_hand' };
        const before = Number(locked.inventory_on_hand);
        if (!Number.isFinite(before)) return { skipped: 'non_numeric_on_hand' };
        const after = Number((before - usage).toFixed(4));
        const unit = locked.inventory_unit || 'each';

        const alreadyLogged = await trx('product_inventory_movements')
          .where({ product_id: locked.id, scheduled_service_id: scheduledServiceId, movement_type: 'usage' })
          .whereRaw("coalesce(metadata->>'source', '') <> ?", [SOURCE])
          .first('id');
        if (alreadyLogged) return { skipped: 'already_logged_by_tech' };
        // Settlement is PER PRODUCT and lives in the rows themselves: an
        // existing kit movement means this product is done (the r17 clear
        // below then retires any stale bell); a hand-off bell that LANDED
        // for this product — or the visit-wide lookup bell — means the
        // office was told to adjust this count by hand, so a retry must not
        // deduct on top of that correction. A partial delivery (A's bell
        // landed, B's was lost) therefore retries only B (Codex r17 P1).
        const alreadyConsumed = await trx('product_inventory_movements')
          .where({ product_id: locked.id, scheduled_service_id: scheduledServiceId, movement_type: 'usage' })
          .whereRaw("metadata->>'source' = ?", [SOURCE])
          .first('id');
        if (alreadyConsumed) return { skipped: 'already_consumed' };
        const handedOff = await trx('notifications')
          .whereRaw("metadata->>'dedupeKey' = ANY(?)", [[`supplies-consumption-failed:${locked.id}:${scheduledServiceId}`, `supplies-consumption-failed:lookup:${scheduledServiceId}`]])
          .first('id');
        if (handedOff) return { skipped: 'handed_off' };

        const costPerUnit = locked.cost_per_unit != null ? Number(locked.cost_per_unit) : null;
        const costUnitMatches = !locked.cost_unit || String(locked.cost_unit).toLowerCase() === String(unit).toLowerCase();
        const unitCost = Number.isFinite(costPerUnit) && costPerUnit >= 0 && costUnitMatches ? costPerUnit : null;
        const costUsed = unitCost != null ? Number((usage * unitCost).toFixed(4)) : null;

        const inserted = await trx('product_inventory_movements')
          .insert({
            product_id: locked.id,
            scheduled_service_id: scheduledServiceId,
            service_record_id: serviceRecordId,
            customer_id: customerId,
            technician_id: technicianId,
            movement_type: 'usage',
            quantity: usage,
            unit,
            stock_before: before,
            stock_after: after,
            unit_cost: unitCost,
            cost_used: costUsed,
            metadata: { source: SOURCE, reason: 'Completed visit consumable' },
          })
          .onConflict(trx.raw("(product_id, scheduled_service_id) WHERE (metadata->>'source') = 'completion_consumable'"))
          .ignore()
          .returning('id');
        if (!inserted || inserted.length === 0) return { skipped: 'already_consumed' };

        await trx('products_catalog').where({ id: locked.id }).update({ inventory_on_hand: after, updated_at: new Date() });
        return { consumed: { productId: locked.id, name: locked.name, usage, unit, before, after, costUsed } };
      });
      if (outcome.consumed) result.consumed.push(outcome.consumed);
      else result.skipped.push({ productId: product.id, reason: outcome.skipped });
      // The kit IS deducted (now, or by an earlier attempt whose bell clear
      // failed transiently): retire the stale hand-off bells either way
      // (Codex r17 P2).
      if (outcome.consumed || outcome.skipped === 'already_consumed') await clearMissedDeductionBells(db, { scheduledServiceId, productId: product.id });
    } catch (err) {
      logger.warn(`[supplies-consumption] ${product.name} failed for visit ${scheduledServiceId} (non-blocking): ${err.message}`);
      result.errors.push({ productId: product.id, message: err.message });
      // Not retried (the closeout must never depend on a supplies write and
      // stock is advisory) — but not silent either (ringMissedDeductionBell).
      await ringMissedDeductionBell(result, { scheduledServiceId, product, reason: err.message });
    }
  }
  return result;
}

module.exports = { consumeCompletionSupplies, appliesToLine, COMPLETION_CONSUMABLE_SOURCE: SOURCE, INSPECTION_SERVICE_RE };
