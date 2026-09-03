/**
 * supplies-consumption.js — per-completion consumables (yard-sign kit).
 *
 * Every completed visit leaves a sign card + stake + sticker in the yard.
 * The closeout hook calls consumeCompletionSupplies once per completion;
 * each product with `per_completion_usage > 0` gets ONE usage movement per
 * (product, visit) and its inventory_on_hand decremented by that usage.
 *
 * Contract:
 *   - idempotent on the closeout RESUME path: the partial unique index
 *     product_inventory_movements_completion_consumable_uniq (metadata.source
 *     = 'completion_consumable') makes the insert at-most-once; the stock
 *     decrement only runs when the insert actually happened.
 *   - skipped entirely for an incomplete visit, and for a closeout where no
 *     visit was performed (inspection_only / customer_declined) — no sign
 *     is left either way.
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

const SOURCE = 'completion_consumable';

function parseLines(raw) {
  if (raw == null) return null;
  const arr = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  return Array.isArray(arr) ? arr.map((x) => String(x)) : null;
}

// null/unparseable = every line. A scoped list needs a resolvable line.
function appliesToLine(rawLines, serviceLine) {
  const lines = parseLines(rawLines);
  if (!lines) return true;
  return !!serviceLine && lines.includes(String(serviceLine));
}

async function consumeCompletionSupplies(db, {
  scheduledServiceId,
  serviceRecordId = null,
  customerId = null,
  technicianId = null,
  isIncompleteVisit = false,
  visitPerformed = true,
  serviceLine = null,
} = {}) {
  const result = { consumed: [], skipped: [], errors: [] };
  if (!scheduledServiceId) { result.skipped.push({ reason: 'no_scheduled_service_id' }); return result; }
  if (isIncompleteVisit) { result.skipped.push({ reason: 'incomplete_visit' }); return result; }
  if (visitPerformed === false) { result.skipped.push({ reason: 'visit_not_performed' }); return result; }

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
    return result;
  }

  for (const product of products) {
    if (!appliesToLine(product.per_completion_service_lines, serviceLine)) {
      result.skipped.push({ productId: product.id, reason: 'service_line_excluded' });
      continue;
    }
    try {
      const outcome = await db.transaction(async (trx) => {
        const locked = await trx('products_catalog').where({ id: product.id }).forUpdate().first();
        if (!locked) return { skipped: 'missing' };
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
    } catch (err) {
      logger.warn(`[supplies-consumption] ${product.name} failed for visit ${scheduledServiceId} (non-blocking): ${err.message}`);
      result.errors.push({ productId: product.id, message: err.message });
      // Not retried (the closeout must never depend on a supplies write and
      // stock is advisory) — but not silent either: one deduped bell per
      // (product, visit) so the office adjusts the count instead of the miss
      // hiding in a log line (Codex r3 P2).
      try {
        await require('./notification-service').notifyAdmin(
          'system',
          `Inventory: ${product.name} was not deducted for a completed visit`,
          `Adjust the count by ${product.per_completion_usage} ${product.inventory_unit || ''} on the Inventory page. Reason: ${err.message}`,
          { bell: true, link: '/admin/inventory', dedupeKey: `supplies-consumption-failed:${product.id}:${scheduledServiceId}`, metadata: { productId: product.id, scheduledServiceId } },
        );
      } catch (bellErr) {
        logger.warn(`[supplies-consumption] failure bell not sent for ${product.name}: ${bellErr.message}`);
      }
    }
  }
  return result;
}

module.exports = { consumeCompletionSupplies, appliesToLine, COMPLETION_CONSUMABLE_SOURCE: SOURCE };
