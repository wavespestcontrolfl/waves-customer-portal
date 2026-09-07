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
 *     nothing. The one exception is the WDO inspection PROJECT
 *     (projectType 'wdo_inspection'): it posts the termite protection
 *     notice (owner ruling 2026-09-06), so termite-scoped kit consumes
 *     there. A visual "Termite Inspection Service" completed on the normal
 *     path posts nothing and stays skipped (GH codex #3996 P2). Owner can
 *     overrule by renaming the service or ruling otherwise; the rule lives
 *     in INSPECTION_SERVICE_RE + NOTICE_PROJECT_TYPE.
 *   - called from BOTH completion flows: the normal closeout
 *     (complete-scheduled-service.js) and the project-backed completion
 *     (project-completion.js — every termite service Adam named completes
 *     there, GH codex #3996 P1). Both call it after their own commit.
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
// A scheduled inspection (no application) leaves no yard sign — except the
// WDO inspection project: it posts the termite protection notice (owner
// ruling 2026-09-06), so termite-scoped kit still consumes there. Keyed on
// the completion profile's projectType, not the service line: a visual
// Termite Inspection Service posts nothing.
const INSPECTION_SERVICE_RE = /\binspection\b/i;
const NOTICE_PROJECT_TYPE = 'wdo_inspection';

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
  [(a) => !!a.serviceType && INSPECTION_SERVICE_RE.test(String(a.serviceType)) && a.projectType !== NOTICE_PROJECT_TYPE, 'inspection_service'],
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

// Every active kit product with a per-completion count — the consumption's
// candidate list, re-read by lookupSettled.
function kitProducts(db) {
  return db('products_catalog')
    .where('active', true)
    .whereNotNull('per_completion_usage')
    .where('per_completion_usage', '>', 0)
    .select('id', 'name', 'per_completion_usage', 'per_completion_service_lines', 'inventory_on_hand', 'inventory_unit');
}

// Why the LOCKED row is not deductible now, or null. Eligibility is
// re-derived from the locked row: a retire or a service-line edit between
// the scan and the lock must not deduct (pre-push codex P1).
function lockedSkipReason(locked, serviceLine) {
  if (locked.active === false) return 'retired';
  if (!appliesToLine(locked.per_completion_service_lines, serviceLine)) return 'service_line_excluded';
  const usage = Number(locked.per_completion_usage);
  if (!Number.isFinite(usage) || usage <= 0) return 'no_usage';
  if (locked.inventory_on_hand == null || locked.inventory_on_hand === '') return 'no_on_hand';
  if (!Number.isFinite(Number(locked.inventory_on_hand))) return 'non_numeric_on_hand';
  return null;
}

// Settlement of (product, visit), read under the product lock and living in
// the rows themselves: a usage movement the tech logged in the picker, an
// existing kit movement (this product is done — the clear after the
// transaction retires any stale bell), or a hand-off bell that LANDED for
// this product or the visit-wide lookup (the office was told to adjust this
// count by hand; a retry must not deduct on top of that correction — a
// partial delivery retries only the lost-bell product, Codex r17 P1).
// Returns the skip reason, or null when the kit is still owed.
async function settledReason(trx, { productId, scheduledServiceId }) {
  const usageRows = () => trx('product_inventory_movements').where({ product_id: productId, scheduled_service_id: scheduledServiceId, movement_type: 'usage' });
  if (await usageRows().whereRaw("coalesce(metadata->>'source', '') <> ?", [SOURCE]).first('id')) return 'already_logged_by_tech';
  if (await usageRows().whereRaw("metadata->>'source' = ?", [SOURCE]).first('id')) return 'already_consumed';
  const keys = [`supplies-consumption-failed:${productId}:${scheduledServiceId}`, `supplies-consumption-failed:lookup:${scheduledServiceId}`];
  // A bell this module retired itself (metadata.autoRetired — a real
  // deduction superseded it) was never a hand-off: it must not skip the
  // next kit product of the same visit (Codex r26 P1).
  if (await trx('notifications').whereRaw("metadata->>'dedupeKey' = ANY(?)", [keys]).whereRaw("coalesce(metadata->>'autoRetired', '') <> 'true'").first('id')) return 'handed_off';
  return null;
}

// The miss is never silent: one deduped bell so the office adjusts the
// count by hand — per (product, visit), or per visit when the product
// lookup itself failed (Codex r3 P2, r14 P2). notifyAdmin resolves NULL
// when it could not persist the notification, so the resolved row is
// checked like a throw: a lost bell is an error-level log and an errors
// entry, never a silent success (Codex r11 P2).
// The visit-wide lookup bell is retired only when the lookup can be re-run
// now AND every kit product that applies to this visit's line already has a
// usage movement — one movement proves one product, not the visit (Codex
// r27 P1, owner ruling). Any product still owed: false. Unreadable again
// (the catalog or a movement read failed): NULL — indeterminate is not
// "not settled": the caller keeps the bell AND records the retirement as
// failed so the owed marker survives for a later retry (Codex r31 P1).
async function lookupSettled(db, { scheduledServiceId, serviceLine }) {
  try {
    const products = await kitProducts(db);
    // A corrupt scope is owed too (its hand-off is a product bell the retry
    // may never have reached): fail closed, keep the visit bell.
    const owed = products.filter((p) => parseLines(p.per_completion_service_lines) === INVALID_LINES || appliesToLine(p.per_completion_service_lines, serviceLine));
    for (const p of owed) {
      if (!await db('product_inventory_movements').where({ product_id: p.id, scheduled_service_id: scheduledServiceId, movement_type: 'usage' }).first('id')) return false;
    }
    return true;
  } catch (err) {
    logger.warn(`[supplies-consumption] lookup-bell settlement is indeterminate for visit ${scheduledServiceId}: ${err.message}`);
    return null;
  }
}

async function ringMissedDeductionBell(db, result, { scheduledServiceId, product = null, reason, serviceLine = null }) {
  const title = product ? `Inventory: ${product.name} was not deducted for a completed visit` : 'Inventory: yard-sign supplies were not deducted for a completed visit';
  // The lookup bell names no product: which kit items this visit should
  // have consumed is decided only after the lookup (service-line scope), so
  // it must not prescribe a deduction (Codex r15 P2).
  const body = product
    ? `Adjust the count by ${product.per_completion_usage} ${product.inventory_unit || ''} on the Inventory page. Reason: ${reason}`
    : `The consumables lookup failed for this visit — check on the Inventory page which per-visit supplies apply to this service line, then adjust by hand ONLY the ones with no usage movement for this visit yet (a concurrent retry may have deducted some already; those show a movement). Reason: ${reason}`;
  const dedupeKey = product ? `supplies-consumption-failed:${product.id}:${scheduledServiceId}` : `supplies-consumption-failed:lookup:${scheduledServiceId}`;
  try {
    const bell = await require('./notification-service').notifyAdmin('system', title, body, { bell: true, link: '/admin/inventory', dedupeKey, metadata: { productId: product?.id || null, scheduledServiceId } });
    if (!bell) throw new Error('notification not persisted');
    // Race (Codex r18 P1, r24 P1): a concurrent retry may have deducted
    // this product — or, for the visit-wide lookup bell, any of the visit's
    // kit — between our failed attempt and this insert; its bell clear ran
    // before our bell existed. Re-check the settled movement AFTER the bell
    // persisted and retire our own bell when the kit is in fact deducted.
    // ANY usage movement settles the product — a tech-logged one included,
    // the same predicate settledReason applies (Codex r29 P2).
    const settled = product
      ? await db('product_inventory_movements').where({ product_id: product.id, scheduled_service_id: scheduledServiceId, movement_type: 'usage' }).first('id')
      : await lookupSettled(db, { scheduledServiceId, serviceLine });
    if (settled && !(await clearMissedDeductionBells(db, { scheduledServiceId, productId: product?.id || null }))) {
      // The superseded bell stands: the marker must stay for a retry to retire it (hook P1).
      result.errors.push({ productId: product?.id || null, reason: 'bell_retire_failed', message: 'the superseded adjust-by-hand bell could not be retired' });
    }
  } catch (bellErr) {
    logger.error(`[supplies-consumption] failure bell NOT sent for ${product ? product.name : 'the visit'} on visit ${scheduledServiceId}: ${bellErr.message}`);
    result.errors.push({ productId: product?.id || null, reason: 'failure_bell_not_sent', message: bellErr.message });
  }
}

// A deduction that SUCCEEDS on a retried completion (the resume path runs
// this hook again) retires the failure bell an earlier attempt rang for
// the same (product, visit), so staff do not follow a stale "adjust by
// hand" on top of the real deduction (Codex r15 P2). The visit-scoped
// lookup bell (productId null) is retired ONLY once lookupSettled proved
// every applicable product deducted — one product's deduction must not
// strip the hand-off protection of the others (hook r27 P1). The row is
// stamped metadata.autoRetired so settledReason never mistakes it for a
// staff hand-off (Codex r26 P1). Best effort, never throws.
// Returns false when the retire did not land: the caller records
// bell_retire_failed so the owed marker stays and a later retry retires the
// obsolete bell after observing the movement (Codex r30 P1).
async function clearMissedDeductionBells(db, { scheduledServiceId, productId = null }) {
  const key = productId ? `supplies-consumption-failed:${productId}:${scheduledServiceId}` : `supplies-consumption-failed:lookup:${scheduledServiceId}`;
  try {
    await db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key]).whereNull('read_at').update({ read_at: new Date(), metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || '{\"autoRetired\": true}'::jsonb") });
    return true;
  } catch (err) {
    logger.warn(`[supplies-consumption] could not retire the failure bell for ${productId} on visit ${scheduledServiceId}: ${err.message}`);
    return false;
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
  // completion profile projectType for a project-backed completion; null on
  // the normal closeout path.
  projectType = null,
} = {}) {
  const result = { consumed: [], skipped: [], errors: [] };
  const skip = SKIP_WHEN.find(([applies]) => applies({ scheduledServiceId, isIncompleteVisit, visitPerformed, isInternalOnlyCompletion, serviceType, serviceLine, projectType }));
  if (skip) { result.skipped.push({ reason: skip[1] }); return result; }

  let products;
  try {
    products = await kitProducts(db);
  } catch (err) {
    logger.warn(`[supplies-consumption] product lookup failed (non-blocking): ${err.message}`);
    result.errors.push({ reason: 'lookup_failed', message: err.message });
    await ringMissedDeductionBell(db, result, { scheduledServiceId, reason: err.message, serviceLine });
    return result;
  }

  for (const product of products) {
    if (parseLines(product.per_completion_service_lines) === INVALID_LINES) {
      // A corrupt scope is a hand-off like any other miss: the deduction
      // is not retried (the config would fail again), so staff must hear
      // about it (Codex #3832 hook P1).
      logger.warn(`[supplies-consumption] ${product.name}: per_completion_service_lines is not a list — nothing consumed (fix it on the Inventory page)`);
      result.errors.push({ productId: product.id, reason: 'invalid_service_lines' });
      await ringMissedDeductionBell(db, result, { scheduledServiceId, product, reason: 'per_completion_service_lines is not a list — fix the product, then adjust the count' });
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
        const ineligible = lockedSkipReason(locked, serviceLine);
        if (ineligible) return { skipped: ineligible };
        const settled = await settledReason(trx, { productId: locked.id, scheduledServiceId });
        if (settled) return { skipped: settled };
        const usage = Number(locked.per_completion_usage);
        const before = Number(locked.inventory_on_hand);
        const after = Number((before - usage).toFixed(4));
        const unit = locked.inventory_unit || 'each';

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
      if ((outcome.consumed || outcome.skipped === 'already_consumed') && !(await clearMissedDeductionBells(db, { scheduledServiceId, productId: product.id }))) {
        result.errors.push({ productId: product.id, reason: 'bell_retire_failed', message: 'the obsolete adjust-by-hand bell could not be retired' });
      }
    } catch (err) {
      logger.warn(`[supplies-consumption] ${product.name} failed for visit ${scheduledServiceId} (non-blocking): ${err.message}`);
      result.errors.push({ productId: product.id, message: err.message });
      // Not retried (the closeout must never depend on a supplies write and
      // stock is advisory) — but not silent either (ringMissedDeductionBell).
      await ringMissedDeductionBell(db, result, { scheduledServiceId, product, reason: err.message });
    }
  }
  // An open visit-wide lookup bell (an earlier attempt could not read the
  // catalog) is retired only when every applicable product is now proven
  // deducted — never on one product's movement (hook r27 P1).
  await retireLookupBellIfSettled(db, result, { scheduledServiceId, serviceLine });
  return result;
}

// Indeterminate at any step (the open-bell probe, the re-run lookup, the
// retire itself) is a retirement FAILURE, never a quiet skip: the owed
// marker must outlive a bell the office could still act on (Codex r31 P1).
async function retireLookupBellIfSettled(db, result, { scheduledServiceId, serviceLine }) {
  const failed = (message) => result.errors.push({ reason: 'bell_retire_failed', message });
  let open;
  try {
    open = await db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`supplies-consumption-failed:lookup:${scheduledServiceId}`]).whereNull('read_at').first('id');
  } catch (err) {
    logger.warn(`[supplies-consumption] lookup-bell probe failed for visit ${scheduledServiceId}: ${err.message}`);
    return failed(`the visit lookup bell could not be checked: ${err.message}`);
  }
  if (!open) return;
  const settled = await lookupSettled(db, { scheduledServiceId, serviceLine });
  if (settled === false) return;
  if (settled === null) return failed('the obsolete visit lookup bell could not be re-checked');
  if (!(await clearMissedDeductionBells(db, { scheduledServiceId }))) failed('the obsolete visit lookup bell could not be retired');
}

// ---- Durable "this completion still owes the kit" marker -------------------
// service_records.field_flags.completion_supplies_owed. The completing
// TRANSACTION writes it (pest-recap.js recap, project-completion.js close) so
// a process death between that commit and the post-commit hook is retried by
// the next recap / close of the same record instead of lost; an edit or
// re-close of a completion that never owed (no marker) never consumes — a
// historical completion has no movement for the at-most-once index to match.
// One lifecycle for both paths (GH codex #3996 r3 P1).
const OWED_FLAG = 'completion_supplies_owed';

// jsonb merge of the marker onto the current field_flags value.
function completionSuppliesOwedMarker(db) {
  return db.raw("COALESCE(field_flags, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ [OWED_FLAG]: true })]);
}

// Marker read off a service_records row. Malformed flags establish nothing.
function completionSuppliesOwed(record = null) {
  if (!record) return false;
  try {
    const flags = typeof record.field_flags === 'string' ? JSON.parse(record.field_flags) : (record.field_flags || {});
    return flags[OWED_FLAG] === true;
  } catch { return false; }
}

// Consume, then clear the marker — unless the hand-off bell was LOST (Codex
// #3832 r14 P1): a landed bell means staff adjust by hand, so a retry must
// not deduct the same kit again on top of their correction; only a miss
// nobody was told about (or an obsolete bell that could not be retired,
// Codex r30 P1) keeps the marker for the next retry. Never throws past
// consumeCompletionSupplies' own contract: the clear is a plain update.
async function settleOwedCompletionSupplies(db, args = {}) {
  const consumption = await consumeCompletionSupplies(db, args);
  const handoffLost = (consumption?.errors || []).some((e) => e.reason === 'failure_bell_not_sent' || e.reason === 'bell_retire_failed');
  if (args.serviceRecordId && !handoffLost) {
    await db('service_records').where({ id: args.serviceRecordId }).update({ field_flags: db.raw(`COALESCE(field_flags, '{}'::jsonb) - '${OWED_FLAG}'`) });
  }
  return consumption;
}

module.exports = {
  consumeCompletionSupplies,
  settleOwedCompletionSupplies,
  completionSuppliesOwed,
  completionSuppliesOwedMarker,
  appliesToLine,
  COMPLETION_CONSUMABLE_SOURCE: SOURCE,
  INSPECTION_SERVICE_RE,
};
