const { addETDays, etDateString } = require('../utils/datetime-et');

// GATE_LAWN_ACTUALS_LEDGER (dark): the ledger records EVERY lawn visit —
// member, one-time, commercial, and incomplete visits that applied product —
// with protocol attribution left absent when the visit has none. Read at call
// time so unsetting the var is a live kill; strict `=== 'true'` so an
// inherited '1' / 'on' cannot open a new write path. Off = the WaveGuard-only
// writer.
function lawnActualsLedgerEnabled() {
  return process.env.GATE_LAWN_ACTUALS_LEDGER === 'true';
}

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
      // Whether the technician typed a reason or the default stands in;
      // the closeout never demands a reason for a removed default.
      reasonSupplied: !!(row.reason || row.skipReason || row.skip_reason),
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
  const allLawn = lawnActualsLedgerEnabled();
  const structured = plan?.protocol?.structured || null;
  const window = structured?.window || null;
  if (!serviceRecord?.id) return null;
  // Without the gate, a visit with no structured protocol window leaves no
  // row (legacy WaveGuard-only behaviour). With it, the visit is recorded
  // with attribution "none" rather than an invented residential plan.
  if (!allLawn && (!structured || !window)) return null;
  const attributed = !!(structured && window);

  const protocolRow = attributed
    ? await trx('lawn_protocols')
      .where({ protocol_key: structured.protocolKey, version: structured.version })
      .first('id')
      .catch(() => null)
    : null;
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

  const requiredTasks = window?.requiredTasks || [];
  // The completion screen no longer submits a protocol checklist (read-only
  // protocol redesign). When none was provided, record an explicitly empty
  // checklist with no missing tasks — normalizeChecklist would otherwise
  // backfill every required task as incomplete, and Command Center's
  // missingRequired30d would count every closeout as non-compliant.
  const checklistProvided = Boolean(completionInput?.checklist || completionInput?.tasks);
  const checklist = checklistProvided ? normalizeChecklist(completionInput, requiredTasks) : [];
  const missingTasks = checklistProvided ? missingRequiredTasks(checklist, requiredTasks) : [];
  // The visit-level treated area is the technician's actual. Under the
  // all-lawn ledger an explicitly missing area stays NULL — the planned turf
  // area is never substituted for it (scope 2026-09-06). Legacy keeps the
  // plan fallback so the WaveGuard-only rows are unchanged while dark.
  const enteredSqft = Number(completionInput.treatedSqft || completionInput.treated_sqft || 0) || null;
  const treatedSqft = enteredSqft || (allLawn ? null : (Number(plan?.mixCalculator?.lawnSqft || 0) || null));
  const treatedSqftSource = enteredSqft ? 'visit' : (treatedSqft ? 'plan' : 'missing');
  const carrier = Number(completionInput.carrierGalPer1000 || completionInput.carrier_gal_per_1000 || plan?.mixCalculator?.carrierGalPer1000 || 0) || null;
  const totalCarrier = Number(completionInput.totalCarrierGal || completionInput.total_carrier_gal || 0)
    || (treatedSqft && carrier ? Number(((treatedSqft / 1000) * carrier).toFixed(3)) : null);
  // No protocol window → no protocol-derived response window or watch items;
  // the columns stay at their empty defaults instead of a generic promise.
  const expectedResponse = attributed ? summarizeExpectedResponse(window, completionInput) : {};
  const watchItems = Array.isArray(completionInput.watchItems)
    ? completionInput.watchItems
    : (window?.requiredTasks || []).map((task) => String(task).replace(/_/g, ' '));
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
      // Frozen service property (migration 20260907000110 ships in this PR).
      property_id: service?.property_id || null,
      lawn_protocol_id: protocolRow?.id || null,
      lawn_protocol_window_id: windowRow?.id || null,
      protocol_key: structured?.protocolKey || null,
      protocol_version: structured?.version || null,
      window_key: window?.key || null,
      window_title: window?.title || null,
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
      recheck_due_date: defaultRecheckDueDate(window || {}, completionInput, serviceDate),
      metadata: JSON.stringify({
        source: 'dispatch_completion',
        // 'protocol' = a structured window attributed the visit; 'none' = the
        // visit was recorded without a lawn plan (one-time / commercial / no
        // assignment). Never a guessed residential protocol.
        attribution: attributed ? 'protocol' : 'none',
        treatedSqftSource,
        incompleteVisit: completionInput.incompleteVisit === true,
        // Distinguishes "no checklist collected" (read-only protocol flow)
        // from "checklist collected with nothing missing" for audits.
        checklistCollected: checklistProvided,
        customerNoteTemplates: window?.customerNoteTemplates || [],
        serviceReportContext: window?.serviceReportContext || {},
        assessmentBridge: window?.assessmentBridge || {},
        substitutions,
        inventoryDeductions: Array.isArray(completionInput.inventoryDeductions)
          ? completionInput.inventoryDeductions
          : [],
      }),
    })
    .onConflict('service_record_id')
    .merge()
    .returning('*');

  // The completion row upserts on service_record_id; its actual rows must be
  // just as idempotent, or a durable-completion resume / retry doubles every
  // applied and skipped product. Same trx as the completion, so a failure
  // after the delete rolls the old rows back with it.
  await trx('lawn_protocol_product_actuals').where({ lawn_protocol_service_completion_id: completion.id }).del();

  for (const serviceProduct of serviceProducts || []) {
    const substitution = serviceProduct.product_id
      ? substitutionBySubstituteProductId.get(String(serviceProduct.product_id))
      : null;
    const protocolProduct = substitution?.originalProductId
      ? protocolProducts.find((row) => String(row.product_id || '') === String(substitution.originalProductId))
      : matchProtocolProduct(protocolProducts, serviceProduct);
    // actual_rate_per_1000 is a per-1,000 sq ft number — a per-basis
    // recorded rate must not land in it verbatim (codex P2/P1, PR #3419):
    // an /acre rate converts EXACTLY (1 acre = 43.56 k sq ft) with its
    // unit rebased; any other per-basis unit (g/spot, fl_oz/gal, …) has
    // no honest per-1,000 representation and stores NULL here. The
    // technician-recorded value+unit stay authoritative on the
    // service_products row and are preserved in metadata.
    const recordedRate = Number(serviceProduct.application_rate);
    const recordedRateUnit = String(serviceProduct.rate_unit || '').trim();
    let actualRatePer1000 = serviceProduct.application_rate || null;
    let actualRateUnit = serviceProduct.rate_unit || null;
    if (Number.isFinite(recordedRate) && /\/acre$/i.test(recordedRateUnit)) {
      actualRatePer1000 = Number((recordedRate / 43.56).toFixed(4));
      actualRateUnit = recordedRateUnit.slice(0, recordedRateUnit.indexOf('/'));
    } else if (recordedRateUnit.includes('/') && !/\/1000sf$/i.test(recordedRateUnit)) {
      actualRatePer1000 = null;
      actualRateUnit = null;
    }
    await trx('lawn_protocol_product_actuals').insert({
      lawn_protocol_service_completion_id: completion.id,
      service_product_id: serviceProduct.id || null,
      protocol_product_id: protocolProduct?.id || null,
      product_id: serviceProduct.product_id || protocolProduct?.product_id || null,
      product_name: serviceProduct.product_name || protocolProduct?.catalog_product_name || protocolProduct?.product_name || 'Applied product',
      role: protocolProduct?.role || null,
      // off_protocol means the visit HAD a protocol and this product was not
      // on it; a visit with no protocol at all records a plain application.
      status: substitution ? 'substituted_applied' : (protocolProduct || !attributed ? 'applied' : 'off_protocol_applied'),
      planned_rate_per_1000: protocolProduct?.rate_per_1000 || null,
      planned_rate_unit: protocolProduct?.rate_unit || null,
      actual_rate_per_1000: actualRatePer1000,
      actual_rate_unit: actualRateUnit,
      actual_amount: serviceProduct.total_amount || null,
      actual_amount_unit: serviceProduct.amount_unit || null,
      metadata: JSON.stringify({
        applicationMethod: serviceProduct.application_method || null,
        substitution: substitution || null,
        recordedRate: serviceProduct.application_rate || null,
        recordedRateUnit: serviceProduct.rate_unit || null,
        // The product's OWN treated area and zones (spot treatment across
        // three zones must not read as a whole-lawn broadcast). Copied from
        // the service_products row so the ledger stands alone.
        areaValue: serviceProduct.area_value == null ? null : Number(serviceProduct.area_value),
        areaUnit: serviceProduct.area_unit || null,
        applicationArea: serviceProduct.application_area || null,
        zoneIds: Array.isArray(serviceProduct.zone_ids) ? serviceProduct.zone_ids : [],
      }),
    });
  }

  // A skipped product id must resolve before it lands in the uuid FK column —
  // a product retired while the form was open would otherwise fail the whole
  // closeout. Known = catalog row, an approved substitute on this plan, or a
  // protocol product; anything else keeps its name with product_id NULL.
  // Skipped rows are part of the all-lawn ledger: with the gate off the
  // legacy WaveGuard writer must stay byte-identical even though Complete
  // Service (defaults gates on) now submits removed defaults.
  const skippedProducts = allLawn ? normalizeSkippedProducts(completionInput.skippedProducts) : [];
  const skippedIds = [...new Set(skippedProducts.map((row) => row.productId).filter(Boolean).map(String))];
  const catalogIds = skippedIds.length
    ? await trx('products_catalog').whereIn('id', skippedIds).select('id').then((rows) => rows.map((row) => String(row.id))).catch(() => [])
    : [];
  const knownProductIds = new Set([
    ...catalogIds,
    ...substitutionBySubstituteProductId.keys(),
    ...protocolProducts.map((row) => String(row.product_id || '')).filter(Boolean),
  ]);
  for (const skipped of skippedProducts) {
    // A removed default may be an approved substitute: the closeout knows the
    // substitute catalog id, the protocol row holds the original. Resolve
    // through the plan's substitution map so the skipped row keeps its
    // protocol identity, role, planned rate and substitution relationship.
    const substitution = skipped.productId ? substitutionBySubstituteProductId.get(String(skipped.productId)) : null;
    const protocolProduct = skipped.protocolProductId
      ? protocolProducts.find((row) => String(row.id) === String(skipped.protocolProductId))
      : substitution?.originalProductId
        ? protocolProducts.find((row) => String(row.product_id || '') === String(substitution.originalProductId))
        : matchProtocolProduct(protocolProducts, skipped);
    await trx('lawn_protocol_product_actuals').insert({
      lawn_protocol_service_completion_id: completion.id,
      protocol_product_id: protocolProduct?.id || null,
      product_id: (skipped.productId && knownProductIds.has(String(skipped.productId)) ? skipped.productId : null) || protocolProduct?.product_id || null,
      product_name: skipped.productName || protocolProduct?.catalog_product_name || protocolProduct?.product_name || 'Skipped protocol product',
      role: skipped.role || protocolProduct?.role || null,
      status: 'skipped',
      planned_rate_per_1000: protocolProduct?.rate_per_1000 || null,
      planned_rate_unit: protocolProduct?.rate_unit || null,
      skip_reason: skipped.reason,
      metadata: JSON.stringify({
        source: 'tech_closeout', reasonSupplied: skipped.reasonSupplied, substitution: substitution || null,
        unresolvedProductId: skipped.productId && !knownProductIds.has(String(skipped.productId)) ? skipped.productId : null,
      }),
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
  lawnActualsLedgerEnabled,
  recordLawnProtocolCompletion,
  normalizeChecklist,
  missingRequiredTasks,
  normalizeCompletionForStructuredNotes,
};
