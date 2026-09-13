/**
 * Manual stock/restock operations shared by the inventory UI and Intelligence
 * Bar. These record staff actions; vendor checkout remains in order-dispatch.
 * Product locks serialize adjustments/creation. Request actions retain the
 * dispatcher's ledger -> request -> product lock order.
 */
const crypto = require('crypto');
const Joi = require('joi');
const db = require('../models/db');
const { describeInventoryConversion, normalizeInventoryUnit, unitDefinition } = require('./inventory-units');
const { findLiveRestockRequest } = require('./procurement/live-restock-request');
const { AUTO_REORDER_SOURCE } = require('./procurement/auto-reorder');
const { validCalendarDate } = require('../utils/datetime-et');
const { restockMeta } = require('./inventory-restock-queue');

const optionalText = Joi.string().allow('', null);
// The portal's receive composer sends numeric text. Joi converts that text
// while rejecting booleans, arrays, blanks and non-finite/malformed amounts.
const numeric = Joi.number().prefs({ convert: true });
const calendarDate = Joi.string().isoDate().custom((value, helpers) =>
  validCalendarDate(value, { allowTimeSuffix: true }) || helpers.error('string.isoDate')).allow(null);
const adjustmentSchema = Joi.object({
  movementType: Joi.string().valid('restock', 'correction', 'damaged_lost').required(),
  quantity: numeric.invalid(0).when('movementType', { is: 'correction', then: Joi.number(), otherwise: Joi.number().positive() }),
  setTotal: numeric.min(0).when('movementType', { is: 'correction', then: Joi.number(), otherwise: Joi.forbidden() }),
  unit: Joi.string().trim().max(50), lotNumber: optionalText.max(80), reason: optionalText, note: optionalText,
}).xor('quantity', 'setTotal');
const requestSchema = Joi.object({
  requestedQuantity: numeric.positive().required(), unit: Joi.string().trim().max(50),
  priority: Joi.string().valid('low', 'normal', 'high', 'urgent').required(),
  vendor: optionalText.max(160), neededBy: calendarDate, reason: optionalText,
  allowDuplicate: Joi.boolean(), targetStock: numeric.allow(null),
  forecastDays: numeric.allow(null), committedDemand: numeric.allow(null),
  projectedRemaining: numeric.allow(null), firstShortDate: calendarDate,
});
const actionSchema = Joi.object({
  action: Joi.string().valid('mark_ordered', 'receive', 'cancel').required(),
  quantity: numeric.positive().when('action', { is: 'receive', then: Joi.number(), otherwise: Joi.forbidden() }),
  unit: Joi.string().trim().max(50).when('action', { is: 'receive', then: Joi.string(), otherwise: Joi.forbidden() }),
  note: optionalText,
});

function inventoryError(message, statusCode = 400, code = 'invalid_input') {
  return Object.assign(new Error(message), { statusCode, code, isOperational: true });
}

function validated(schema, input) {
  const { value, error } = schema.validate(input, { convert: false, abortEarly: true });
  if (error) throw inventoryError(error.details[0].message);
  return value;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
const round4 = value => Number(value.toFixed(4));

function supportedUnit(unit) {
  if (!unitDefinition(unit)) throw inventoryError(`Unsupported inventory unit "${unit || ''}"`);
  return unit;
}

function convertedQuantity(amount, from, to) {
  supportedUnit(from); supportedUnit(to);
  // Validate the dimension even for an absolute zero count. Count/weight/volume
  // remain separate; an unknown equal-unit label cannot initialize tracking.
  const converted = describeInventoryConversion(amount === 0 ? 1 : amount, from, to);
  if (!converted.convertible || converted.amount == null) throw inventoryError(`Cannot convert ${from} to inventory unit ${to}`);
  return { ...converted, amount: amount === 0 ? 0 : converted.amount };
}

async function loadProduct(productId, conn = db, lock = false) {
  let query = conn('products_catalog').where({ id: productId }).select('*', conn.raw('updated_at::text as row_version'));
  if (lock) query = query.forUpdate();
  const product = await query.first();
  if (!product) throw inventoryError('Product not found', 404, 'product_not_found');
  return product;
}

function productIdentity(product) {
  return { id: product.id, name: product.name, category: product.category,
    formulation: product.formulation || null, sku: product.sku || product.siteone_sku || null,
    container_size: product.container_size || null };
}

function versionFor(product, details, request = null) {
  return crypto.createHash('sha256').update(JSON.stringify([
    productIdentity(product), product.row_version, product.inventory_on_hand,
    product.inventory_unit, product.best_vendor, request, details,
  ])).digest('base64url');
}

function assertVersion(actual, expected) {
  if (expected && expected !== actual) throw inventoryError('The product or request changed after the preview. Request a fresh confirmation.', 409, 'preview_changed');
}

function adjustmentPlan(product, input, { allowConversion = true } = {}) {
  const enteredUnit = supportedUnit(input.unit || product.inventory_unit);
  const inventoryUnit = supportedUnit(product.inventory_unit || enteredUnit);
  if (!allowConversion && normalizeInventoryUnit(enteredUnit) !== normalizeInventoryUnit(inventoryUnit)) {
    throw inventoryError(`Adjustment unit must match current inventory unit (${inventoryUnit})`);
  }
  const stockBefore = numberOrNull(product.inventory_on_hand) ?? 0;
  const isCount = input.setTotal !== undefined;
  const amount = isCount ? input.setTotal : Math.abs(input.quantity);
  const converted = convertedQuantity(amount, enteredUnit, inventoryUnit);
  const signedDelta = input.movementType === 'damaged_lost' || input.quantity < 0 ? -converted.amount : converted.amount;
  const delta = round4(isCount ? converted.amount - stockBefore : signedDelta);
  if (isCount && delta === 0 && product.inventory_on_hand != null) throw inventoryError('The stock count is unchanged; nothing to adjust');
  return { stockBefore, stockAfter: round4(stockBefore + delta), delta, enteredUnit, inventoryUnit,
    conversionConfidence: converted.confidence, enteredQuantity: isCount ? input.setTotal : input.quantity };
}

function adjustmentPreview(product, input, options) {
  const plan = adjustmentPlan(product, input, options);
  const preview = { preview: true, tool: 'adjust_stock', product: productIdentity(product),
    movement_type: input.movementType, was_untracked: product.inventory_on_hand == null,
    stock_before: plan.stockBefore, change: plan.delta, stock_after: plan.stockAfter, unit: plan.inventoryUnit,
    entered_quantity: plan.enteredQuantity, entered_unit: plan.enteredUnit,
    conversion_confidence: plan.conversionConfidence,
    lot_number: input.lotNumber || null, reason: input.reason || null, note: input.note || null,
    effects: 'Records physical stock and its movement ledger. A first count enables stock tracking. Does not place an order.',
    ...(product.low_stock_threshold != null && plan.stockAfter <= Number(product.low_stock_threshold)
      ? { low_stock_after: true, warning: 'Stock will be at or below the low-stock threshold.' } : {}),
    ...(plan.stockAfter < 0 ? { warning: 'This takes stock negative. Verify the physical count.' } : {}),
  };
  return { ...preview, _version: versionFor(product, preview) };
}

async function previewStockAdjustment(productId, raw, options = {}) {
  const input = validated(adjustmentSchema, raw);
  return adjustmentPreview(await loadProduct(productId), input, options);
}

async function adjustStock(productId, raw, options = {}) {
  const input = validated(adjustmentSchema, raw);
  return db.transaction(async trx => {
    const product = await loadProduct(productId, trx, true);
    const preview = adjustmentPreview(product, input, options);
    assertVersion(preview._version, options.expectedVersion);
    const plan = adjustmentPlan(product, input, options);
    const [updated] = await trx('products_catalog').where({ id: productId }).update({
      inventory_on_hand: plan.stockAfter, inventory_unit: plan.inventoryUnit, updated_at: new Date(),
    }).returning('*');
    const [movement] = await trx('product_inventory_movements').insert({
      product_id: productId, movement_type: input.movementType,
      quantity: input.movementType === 'correction' ? plan.delta : Math.abs(plan.delta),
      unit: plan.inventoryUnit, stock_before: plan.stockBefore, stock_after: plan.stockAfter,
      lot_number: input.lotNumber || null,
      metadata: { source: options.source || 'admin_manual_adjustment', adjustedBy: options.actorId || null,
        reason: input.reason || null, note: input.note || null, delta: plan.delta, setTotal: input.setTotal ?? null,
        enteredQuantity: plan.enteredQuantity, enteredUnit: plan.enteredUnit, conversionConfidence: plan.conversionConfidence },
    }).returning('*');
    const saved = await trx('products_catalog').where({ id: productId }).first();
    if (!movement?.id || numberOrNull(saved?.inventory_on_hand) !== plan.stockAfter || saved.inventory_unit !== plan.inventoryUnit) {
      throw inventoryError('Saved stock did not match the adjustment', 409, 'verification_failed');
    }
    return { success: true, product: updated, movement,
      verification: { persisted: true, product_id: productId, movement_id: movement.id, stock_match: true }, href: `/admin/inventory?tab=products&search=${encodeURIComponent(product.name)}&productId=${productId}` };
  });
}

function restockPlan(product, input, { source = 'intelligence_bar' } = {}) {
  const unit = supportedUnit(input.unit || product.inventory_unit || (source === 'waveguard_inventory_forecast' ? product.rate_unit : null));
  const vendor = input.vendor || product.best_vendor || null;
  return { product_id: product.id, status: 'open', priority: input.priority, requested_quantity: input.requestedQuantity,
    unit, vendor, current_stock: numberOrNull(product.inventory_on_hand), target_stock: input.targetStock ?? null,
    needed_by: input.neededBy || null, reason: input.reason || (source === 'waveguard_inventory_forecast' ? `Forecasted WaveGuard inventory demand for ${product.name}` : null), source,
    metadata: { forecastDays: input.forecastDays ?? null, committedDemand: input.committedDemand ?? null,
      projectedRemaining: input.projectedRemaining ?? null, firstShortDate: input.firstShortDate || null },
  };
}

function requestPreview(product, input, options) {
  const plan = restockPlan(product, input, options);
  const preview = { preview: true, tool: 'create_restock_request', product: productIdentity(product),
    requested_quantity: plan.requested_quantity, unit: plan.unit, priority: plan.priority, vendor: plan.vendor,
    needed_by: plan.needed_by, current_stock: plan.current_stock, reason: plan.reason,
    allow_duplicate: input.allowDuplicate === true,
    effects: 'Saves an open restock request. Does not submit a vendor order or increase stock.',
  };
  return { ...preview, _version: versionFor(product, [preview, plan]) };
}

async function previewRestockRequest(productId, raw, options = {}) {
  const input = validated(requestSchema, raw);
  return requestPreview(await loadProduct(productId), input, options);
}

async function createRestockRequest(productId, raw, options = {}) {
  const input = validated(requestSchema, raw);
  return db.transaction(async trx => {
    const product = await loadProduct(productId, trx, true);
    assertVersion(requestPreview(product, input, options)._version, options.expectedVersion);
    await require('./procurement/order-dispatch').assertNoLiveAutoOrder(trx, productId);
    const existing = await findLiveRestockRequest(trx, productId);
    if (existing && (input.allowDuplicate !== true || existing.source === AUTO_REORDER_SOURCE)) {
      return { success: true, existing: true, restockRequest: existing,
        verification: { persisted: true, request_id: existing.id, product_id: productId, existing: true }, href: `/admin/inventory?tab=restock&requestId=${existing.id}` };
    }
    const plan = restockPlan(product, input, options);
    const [request] = await trx('product_restock_requests').insert({ ...plan,
      created_by: options.actorId || null, created_by_name: options.actorName || null,
      created_at: new Date(), updated_at: new Date(),
    }).returning('*');
    const saved = request?.id && await trx('product_restock_requests').where({ id: request.id })
      .select('*', trx.raw('needed_by::text as needed_by')).first();
    if (!saved || saved.product_id !== productId || saved.status !== 'open'
      || numberOrNull(saved.requested_quantity) !== plan.requested_quantity || saved.unit !== plan.unit) {
      throw inventoryError('Saved restock request did not match the request', 409, 'verification_failed');
    }
    return { success: true, existing: false, restockRequest: saved,
      verification: { persisted: true, request_id: saved.id, product_id: productId, fields_match: true }, href: `/admin/inventory?tab=restock&requestId=${saved.id}` };
  });
}

async function loadRequest(requestId, conn = db, lock = false) {
  let query = conn('product_restock_requests').where({ id: requestId }).select('*', conn.raw('updated_at::text as row_version'));
  if (lock) query = query.forUpdate();
  const request = await query.first();
  if (!request) throw inventoryError('Restock request not found', 404, 'request_not_found');
  return request;
}

function validateTransition(request, action, guard) {
  const status = String(request.status || '').toLowerCase();
  const secondReceive = action === 'receive' && status === 'received' && !!guard.landedAfterReceive;
  if (!['open', 'ordered'].includes(status) && !secondReceive) throw inventoryError(`Restock request is already ${status}; refresh the list`, 409, 'request_closed');
  if (action === 'mark_ordered' && status !== 'open') throw inventoryError(`Only an open request can be marked ordered (this one is ${status})`, 409, 'request_not_open');
  return secondReceive;
}

async function restockActionPlan(conn, request, product, input, guard) {
  const secondReceive = validateTransition(request, input.action, guard);
  if (input.action !== 'receive') return { secondReceive };
  const quantity = input.quantity ?? await require('./procurement/order-dispatch').orderedQuantityFor(conn, request.id)
    ?? numberOrNull(request.requested_quantity);
  if (!(quantity > 0)) throw inventoryError('Receive quantity is required');
  const enteredUnit = supportedUnit(input.unit || request.unit || product.inventory_unit);
  const inventoryUnit = supportedUnit(product.inventory_unit || enteredUnit);
  const conversion = convertedQuantity(quantity, enteredUnit, inventoryUnit);
  const stockBefore = numberOrNull(product.inventory_on_hand) ?? 0;
  return { secondReceive, quantity, enteredUnit, inventoryUnit, conversionConfidence: conversion.confidence,
    adds: conversion.amount, stockBefore, stockAfter: round4(stockBefore + conversion.amount) };
}

function actionPreview(request, product, input, plan) {
  const preview = { preview: true, tool: 'update_restock_request',
    request: { id: request.id, product_id: product.id, product: product.name, status: request.status,
      requested_quantity: numberOrNull(request.requested_quantity), unit: request.unit },
    product: productIdentity(product), action: input.action, note: input.note || null,
    new_status: { mark_ordered: 'ordered', receive: 'received', cancel: 'cancelled' }[input.action],
    effects: { mark_ordered: 'Records that staff already placed an order. Does not submit an order or increase stock.',
      receive: 'Records physically received stock, a movement and the request receipt.',
      cancel: 'Closes this restock request. Does not cancel a vendor order.' }[input.action],
    ...(input.action === 'receive' ? { stock_before: plan.stockBefore, adds: plan.adds, stock_after: plan.stockAfter,
      unit: plan.inventoryUnit, entered_quantity: plan.quantity, entered_unit: plan.enteredUnit,
      conversion_confidence: plan.conversionConfidence, second_receive: plan.secondReceive } : {}),
  };
  return { ...preview, _version: versionFor(product, preview, [request.id, request.row_version, request.product_id, request.status, request.unit, request.requested_quantity]) };
}

async function previewRestockAction(requestId, raw) {
  const input = validated(actionSchema, raw);
  const request = await loadRequest(requestId);
  const product = await loadProduct(request.product_id);
  const guard = await require('./procurement/order-dispatch').assertManualActionAllowed(db, requestId, input.action);
  const plan = await restockActionPlan(db, request, product, input, guard);
  return actionPreview(request, product, input, plan);
}

async function updateRestockRequest(requestId, raw, options = {}) {
  const input = validated(actionSchema, raw);
  return db.transaction(async trx => {
    await trx('vendor_orders').where({ restock_request_id: requestId }).forUpdate().first('id');
    const request = await loadRequest(requestId, trx, true);
    const dispatch = require('./procurement/order-dispatch');
    const guard = await dispatch.assertManualActionAllowed(trx, requestId, input.action);
    const product = await loadProduct(request.product_id, trx, true);
    const plan = await restockActionPlan(trx, request, product, input, guard);
    const preview = actionPreview(request, product, input, plan);
    assertVersion(preview._version, options.expectedVersion);
    let movement;
    if (input.action === 'receive') {
      await trx('products_catalog').where({ id: product.id }).update({ inventory_on_hand: plan.stockAfter, inventory_unit: plan.inventoryUnit, updated_at: new Date() });
      [movement] = await trx('product_inventory_movements').insert({ product_id: product.id, movement_type: 'restock',
        quantity: plan.adds, unit: plan.inventoryUnit, stock_before: plan.stockBefore, stock_after: plan.stockAfter,
        metadata: { source: options.source || 'restock_request_receive', restockRequestId: requestId,
          adjustedBy: options.actorId || null, note: input.note || null, enteredQuantity: plan.quantity,
          enteredUnit: plan.enteredUnit, conversionConfidence: plan.conversionConfidence,
          ...(plan.secondReceive ? { secondReceive: true } : {}) },
      }).returning('*');
      const saved = await trx('products_catalog').where({ id: product.id }).first();
      if (!movement?.id || numberOrNull(saved?.inventory_on_hand) !== plan.stockAfter || saved.inventory_unit !== plan.inventoryUnit) {
        throw inventoryError('Saved stock did not match the receipt', 409, 'verification_failed');
      }
      if (plan.secondReceive) await dispatch.settleLandedAfterReceive(trx, requestId);
    }
    const [updated] = await trx('product_restock_requests').where({ id: requestId }).update({
      status: preview.new_status, updated_at: new Date(),
      metadata: { ...restockMeta(request.metadata), lastManualAction: {
        action: input.action, note: input.note || null, actorId: options.actorId || null, recordedAt: new Date().toISOString(),
      } },
      ...(input.action !== 'mark_ordered' ? { closed_by: options.actorId || null, closed_at: new Date() } : {}),
    }).returning('*');
    if (updated?.status !== preview.new_status) throw inventoryError('Restock status did not persist', 409, 'verification_failed');
    await dispatch.settleRequestLedgerBells(trx, requestId);
    return { success: true, request: updated, ...(movement ? { movement } : {}),
      verification: { persisted: true, request_id: requestId, product_id: product.id, status_match: true,
        ...(movement ? { movement_id: movement.id, stock_match: true } : {}) }, href: `/admin/inventory?tab=restock&requestId=${requestId}` };
  });
}

module.exports = { previewStockAdjustment, adjustStock, previewRestockRequest, createRestockRequest,
  previewRestockAction, updateRestockRequest, productIdentity };
