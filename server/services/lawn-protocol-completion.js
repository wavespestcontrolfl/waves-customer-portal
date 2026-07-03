const { addETDays, etDateString } = require('../utils/datetime-et');

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function taskKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeChecklist(input, requiredTasks = []) {
  const raw = input?.checklist || input?.tasks || {};
  const rows = Array.isArray(raw)
    ? raw
    : Object.entries(raw || {}).map(([key, value]) => ({
      key,
      completed: value === true || value === 'completed',
      note: typeof value === 'object' ? value.note : null,
    }));

  const byKey = new Map(rows.map((row) => [taskKey(row.key || row.task || row.label), {
    key: taskKey(row.key || row.task || row.label),
    label: row.label || row.task || row.key,
    completed: row.completed === true || row.status === 'completed' || row.value === true,
    note: row.note || null,
    value: row.value == null || typeof row.value === 'boolean' ? null : row.value,
  }]));

  for (const required of requiredTasks || []) {
    const key = taskKey(required);
    if (!byKey.has(key)) {
      byKey.set(key, { key, label: String(required).replace(/_/g, ' '), completed: false, note: null, value: null });
    }
  }

  return Array.from(byKey.values());
}

function missingRequiredTasks(checklist, requiredTasks = []) {
  const completed = new Set((checklist || []).filter((row) => row.completed).map((row) => taskKey(row.key)));
  return (requiredTasks || [])
    .map((task) => ({ key: taskKey(task), label: String(task).replace(/_/g, ' ') }))
    .filter((task) => !completed.has(task.key));
}

function summarizeExpectedResponse(window = {}, completionInput = {}) {
  if (completionInput.expectedResponse && typeof completionInput.expectedResponse === 'object') {
    return completionInput.expectedResponse;
  }
  const key = String(window.window_key || '');
  if (key.includes('pre_m')) {
    return { window: 'Preventive barrier; water-in required within label window.', metric: 'weed_breakthrough' };
  }
  if (key.includes('insect') || key.includes('chinch')) {
    return { window: 'Scout response in 3-7 days when active insect pressure was present.', metric: 'active_insects_and_spreading_damage' };
  }
  if (key.includes('blackout')) {
    return { window: 'Stress support; color response depends on irrigation and heat load.', metric: 'stress_and_irrigation' };
  }
  if (key.includes('recovery')) {
    return { window: 'Visible recovery typically reviewed over the next 10-21 days.', metric: 'color_density_and_disease_pressure' };
  }
  return { window: 'Review response at the next scheduled lawn visit.', metric: 'overall_lawn_response' };
}

function defaultRecheckDueDate(window = {}, completionInput = {}, serviceDate = new Date()) {
  if (completionInput.recheckDueDate) return String(completionInput.recheckDueDate).slice(0, 10);
  const key = String(window.window_key || '');
  const needsFastRecheck = key.includes('chinch') || key.includes('insect') || key.includes('blackout');
  return needsFastRecheck ? etDateString(addETDays(serviceDate, 7)) : null;
}

function matchProtocolProduct(protocolProducts = [], product = {}) {
  const productId = product.product_id || product.productId || product.id;
  if (productId) {
    const direct = protocolProducts.find((row) => String(row.product_id || '') === String(productId));
    if (direct) return direct;
  }
  const name = normalizeText(product.product_name || product.productName || product.name);
  return protocolProducts.find((row) => {
    const rowName = normalizeText(row.catalog_product_name || row.product_name);
    return rowName && name && (rowName.includes(name) || name.includes(rowName));
  }) || null;
}

function normalizeSkippedProducts(input = []) {
  if (!Array.isArray(input)) return [];
  return input
    .map((row) => ({
      protocolProductId: row.protocolProductId || row.protocol_product_id || null,
      productId: row.productId || row.product_id || null,
      productName: row.productName || row.product_name || row.name || 'Skipped protocol product',
      role: row.role || null,
      reason: row.reason || row.skipReason || row.skip_reason || 'Not applied',
    }))
    .filter((row) => row.productName);
}

async function recordLawnProtocolCompletion(trx, {
  service,
  serviceRecord,
  plan,
  serviceProducts = [],
  completionInput = {},
  equipmentSystemId = null,
  calibrationId = null,
  calibrationCleared = false,
  serviceDate = new Date(),
} = {}) {
  const structured = plan?.protocol?.structured;
  const window = structured?.window;
  if (!serviceRecord?.id || !structured || !window) return null;

  const protocolRow = await trx('lawn_protocols')
    .where({ protocol_key: structured.protocolKey, version: structured.version })
    .first('id')
    .catch(() => null);
  const windowRow = protocolRow?.id
    ? await trx('lawn_protocol_windows')
      .where({ lawn_protocol_id: protocolRow.id, window_key: window.key })
      .first('id')
      .catch(() => null)
    : null;
  const protocolProducts = windowRow?.id
    ? await trx('lawn_protocol_products as lpp')
      .leftJoin('products_catalog as pc', 'lpp.product_id', 'pc.id')
      .where({ lawn_protocol_window_id: windowRow.id })
      .select('lpp.*', 'pc.name as catalog_product_name')
      .catch(() => [])
    : [];

  const requiredTasks = window.requiredTasks || [];
  // The completion screen no longer submits a protocol checklist (read-only
  // protocol redesign). When none was provided, record an explicitly empty
  // checklist with no missing tasks — normalizeChecklist would otherwise
  // backfill every required task as incomplete, and Command Center's
  // missingRequired30d would count every closeout as non-compliant.
  const checklistProvided = Boolean(completionInput?.checklist || completionInput?.tasks);
  const checklist = checklistProvided ? normalizeChecklist(completionInput, requiredTasks) : [];
  const missingTasks = checklistProvided ? missingRequiredTasks(checklist, requiredTasks) : [];
  const treatedSqft = Number(completionInput.treatedSqft || completionInput.treated_sqft || plan?.mixCalculator?.lawnSqft || 0) || null;
  const carrier = Number(completionInput.carrierGalPer1000 || completionInput.carrier_gal_per_1000 || plan?.mixCalculator?.carrierGalPer1000 || 0) || null;
  const totalCarrier = Number(completionInput.totalCarrierGal || completionInput.total_carrier_gal || 0)
    || (treatedSqft && carrier ? Number(((treatedSqft / 1000) * carrier).toFixed(3)) : null);
  const expectedResponse = summarizeExpectedResponse(window, completionInput);
  const watchItems = Array.isArray(completionInput.watchItems)
    ? completionInput.watchItems
    : (window.requiredTasks || []).map((task) => String(task).replace(/_/g, ' '));
  const substitutions = (plan?.mixCalculator?.items || [])
    .map((item) => item?.substitution)
    .filter(Boolean);
  const substitutionBySubstituteProductId = new Map(
    substitutions
      .filter((sub) => sub.substituteProductId)
      .map((sub) => [String(sub.substituteProductId), sub]),
  );

  const [completion] = await trx('lawn_protocol_service_completions')
    .insert({
      service_record_id: serviceRecord.id,
      scheduled_service_id: service?.id || serviceRecord.scheduled_service_id || null,
      customer_id: service?.customer_id || serviceRecord.customer_id || null,
      lawn_protocol_id: protocolRow?.id || null,
      lawn_protocol_window_id: windowRow?.id || null,
      protocol_key: structured.protocolKey,
      protocol_version: structured.version,
      window_key: window.key,
      window_title: window.title,
      // calibrationCleared means the tech completed without field-verified
      // equipment (calibration advisory bypass) — record "none" rather than
      // falling back to the stale assigned system carried on the plan.
      equipment_system_id: equipmentSystemId || (calibrationCleared ? null : plan?.mixCalculator?.equipmentSystemId) || null,
      calibration_id: calibrationId || (calibrationCleared ? null : plan?.equipmentCalibration?.selected?.id) || null,
      treated_sqft: treatedSqft,
      carrier_gal_per_1000: carrier,
      total_carrier_gal: totalCarrier,
      checklist: JSON.stringify(checklist),
      required_tasks: JSON.stringify(requiredTasks),
      missing_required_tasks: JSON.stringify(missingTasks),
      expected_response: JSON.stringify(expectedResponse),
      watch_items: JSON.stringify(watchItems),
      recheck_due_date: defaultRecheckDueDate(window, completionInput, serviceDate),
      metadata: JSON.stringify({
        source: 'dispatch_completion',
        // Distinguishes "no checklist collected" (read-only protocol flow)
        // from "checklist collected with nothing missing" for audits.
        checklistCollected: checklistProvided,
        customerNoteTemplates: window.customerNoteTemplates || [],
        serviceReportContext: window.serviceReportContext || {},
        assessmentBridge: window.assessmentBridge || {},
        substitutions,
        inventoryDeductions: Array.isArray(completionInput.inventoryDeductions)
          ? completionInput.inventoryDeductions
          : [],
      }),
    })
    .onConflict('service_record_id')
    .merge()
    .returning('*');

  for (const serviceProduct of serviceProducts || []) {
    const substitution = serviceProduct.product_id
      ? substitutionBySubstituteProductId.get(String(serviceProduct.product_id))
      : null;
    const protocolProduct = substitution?.originalProductId
      ? protocolProducts.find((row) => String(row.product_id || '') === String(substitution.originalProductId))
      : matchProtocolProduct(protocolProducts, serviceProduct);
    await trx('lawn_protocol_product_actuals').insert({
      lawn_protocol_service_completion_id: completion.id,
      service_product_id: serviceProduct.id || null,
      protocol_product_id: protocolProduct?.id || null,
      product_id: serviceProduct.product_id || protocolProduct?.product_id || null,
      product_name: serviceProduct.product_name || protocolProduct?.catalog_product_name || protocolProduct?.product_name || 'Applied product',
      role: protocolProduct?.role || null,
      status: substitution ? 'substituted_applied' : (protocolProduct ? 'applied' : 'off_protocol_applied'),
      planned_rate_per_1000: protocolProduct?.rate_per_1000 || null,
      planned_rate_unit: protocolProduct?.rate_unit || null,
      actual_rate_per_1000: serviceProduct.application_rate || null,
      actual_rate_unit: serviceProduct.rate_unit || null,
      actual_amount: serviceProduct.total_amount || null,
      actual_amount_unit: serviceProduct.amount_unit || null,
      metadata: JSON.stringify({
        applicationMethod: serviceProduct.application_method || null,
        substitution: substitution || null,
      }),
    });
  }

  for (const skipped of normalizeSkippedProducts(completionInput.skippedProducts || completionInput.skipped_products)) {
    const protocolProduct = skipped.protocolProductId
      ? protocolProducts.find((row) => String(row.id) === String(skipped.protocolProductId))
      : matchProtocolProduct(protocolProducts, skipped);
    await trx('lawn_protocol_product_actuals').insert({
      lawn_protocol_service_completion_id: completion.id,
      protocol_product_id: protocolProduct?.id || null,
      product_id: skipped.productId || protocolProduct?.product_id || null,
      product_name: skipped.productName || protocolProduct?.catalog_product_name || protocolProduct?.product_name || 'Skipped protocol product',
      role: skipped.role || protocolProduct?.role || null,
      status: 'skipped',
      planned_rate_per_1000: protocolProduct?.rate_per_1000 || null,
      planned_rate_unit: protocolProduct?.rate_unit || null,
      skip_reason: skipped.reason,
      metadata: JSON.stringify({ source: 'tech_closeout' }),
    });
  }

  return completion;
}

function normalizeCompletionForStructuredNotes(completion) {
  if (!completion) return null;
  return {
    id: completion.id,
    protocolKey: completion.protocol_key,
    protocolVersion: completion.protocol_version,
    windowKey: completion.window_key,
    windowTitle: completion.window_title,
    missingRequiredTasks: parseJson(completion.missing_required_tasks, []),
    recheckDueDate: completion.recheck_due_date || null,
  };
}

module.exports = {
  recordLawnProtocolCompletion,
  normalizeChecklist,
  missingRequiredTasks,
  normalizeCompletionForStructuredNotes,
};
