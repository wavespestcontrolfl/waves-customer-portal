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
  const key = String(window.window_key || window.key || '');
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
  // The structured plan window carries `key`; a stored row carries
  // `window_key` (Codex #4113 P2: the plan shape stored generic follow-up).
  const key = String(window.window_key || window.key || '');
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

// The completion route validates the shape ({ productId (uuid), productName,
// reason? } — unknown keys rejected) before the writer sees it, so there are
// no aliases to reconcile here.
function normalizeSkippedProducts(input) {
  if (!Array.isArray(input)) return [];
  return input.map((row) => ({
    productId: row.productId,
    productName: row.productName,
    reason: row.reason || 'Not applied',
    // Whether the technician typed a reason or the default stands in;
    // the closeout never demands a reason for a removed default.
    reasonSupplied: !!row.reason,
  }));
}

// Both actual-row kinds (applied, skipped) resolve their protocol row the
// same way: an approved substitute maps back to the protocol row of the
// product it replaced; anything else matches by product id, then name.
function resolveProtocolProduct(protocolProducts, substitution, product) {
  return substitution?.originalProductId
    ? protocolProducts.find((row) => String(row.product_id || '') === String(substitution.originalProductId)) || null
    : matchProtocolProduct(protocolProducts, product);
}

// First finite, non-zero number among the candidates; null when none. The
// completion payload is spread from the client, so a value may arrive under
// its camel or snake name.
function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// The completion payload is spread from the client: a carrier alias is only
// forwarded when it is a finite positive number the column can hold —
// carrier_gal_per_1000 is numeric(6,3), total_carrier_gal numeric(10,3). An
// out-of-range value is omitted rather than rolling the closeout back as a
// 500 or persisting a negative measurement (Codex #4113 P2).
const CARRIER_GAL_PER_1000_MAX = 999.999;
const TOTAL_CARRIER_GAL_MAX = 9999999.999;
function boundedPositive(max, ...values) {
  for (const value of values) {
    const n = firstPositiveNumber(value);
    if (n != null && n <= max) return n;
  }
  return null;
}

// A visit is attributed to a protocol only when the plan carries a structured
// protocol with a window. Without the gate, an unattributed visit leaves no
// row at all (legacy WaveGuard-only behaviour); with it, the visit is
// recorded with attribution "none" rather than an invented residential plan.
function resolveAttribution(plan, allLawn) {
  const structured = plan?.protocol?.structured || null;
  const window = structured?.window || null;
  const attributed = Boolean(structured && window);
  if (!attributed && !allLawn) return null;
  return { structured, window, attributed };
}

// The protocol rows the completion attributes to: protocol → window →
// window products. Each lookup depends on the previous one resolving; any
// read failure degrades to "no row" rather than failing the closeout.
async function loadProtocolRows(trx, { structured, window, attributed }) {
  if (!attributed) return { protocolRow: null, windowRow: null, protocolProducts: [] };
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
  return { protocolRow, windowRow, protocolProducts };
}

// The completion screen no longer submits a protocol checklist (read-only
// protocol redesign). When none was provided, record an explicitly empty
// checklist with no missing tasks — normalizeChecklist would otherwise
// backfill every required task as incomplete, and Command Center's
// missingRequired30d would count every closeout as non-compliant.
function resolveChecklist(completionInput, requiredTasks) {
  const provided = Boolean(completionInput?.checklist || completionInput?.tasks);
  const checklist = provided ? normalizeChecklist(completionInput, requiredTasks) : [];
  return { provided, checklist, missingTasks: provided ? missingRequiredTasks(checklist, requiredTasks) : [] };
}

// The visit-level treated area is the technician's actual. Under the
// all-lawn ledger an explicitly missing area stays NULL — the planned turf
// area is never substituted for it (scope 2026-09-06). Legacy keeps the
// plan fallback so the WaveGuard-only rows are unchanged while dark.
// Under the ledger gate the plan's carrier is an actual only when it belongs
// to the visit's own verified rig assignment: the planner may otherwise carry
// a globally inferred tank or the protocol window's default, which
// resolveEquipment already refuses to record as equipment used. Recording
// that number would invent gallons the estimate actuals and customer reports
// then treat as observed (Codex #4113 P2). Legacy WaveGuard rows are unchanged.
function planCarrierUsable(plan, allLawn, calibrationCleared) {
  if (!allLawn) return true;
  return !calibrationCleared && !plan?.equipmentCalibration?.inferred && Boolean(plan?.mixCalculator?.equipmentSystemId);
}

function resolveTreatedArea(completionInput, plan, allLawn, calibrationCleared = false) {
  // Legacy payloads carried the snake-case alias; the writer keeps accepting
  // it while dark. Under the gate the handler passes the validated camelCase
  // field only, so a raw alias cannot bypass that validation (pre-push audit P1).
  const enteredSqft = firstPositiveNumber(completionInput.treatedSqft, allLawn ? undefined : completionInput.treated_sqft);
  const treatedSqft = enteredSqft || (allLawn ? null : firstPositiveNumber(plan?.mixCalculator?.lawnSqft));
  const source = enteredSqft ? 'visit' : (treatedSqft ? 'plan' : 'missing');
  const carrier = boundedPositive(
    CARRIER_GAL_PER_1000_MAX,
    completionInput.carrierGalPer1000,
    completionInput.carrier_gal_per_1000,
    planCarrierUsable(plan, allLawn, calibrationCleared) ? plan?.mixCalculator?.carrierGalPer1000 : null,
  );
  const totalCarrier = boundedPositive(TOTAL_CARRIER_GAL_MAX, completionInput.totalCarrierGal, completionInput.total_carrier_gal)
    || (treatedSqft && carrier ? boundedPositive(TOTAL_CARRIER_GAL_MAX, Number(((treatedSqft / 1000) * carrier).toFixed(3))) : null);
  return { treatedSqft, source, carrier, totalCarrier };
}

// calibrationCleared means the tech completed without field-verified
// equipment (calibration advisory bypass) — record "none" rather than
// falling back to the stale assigned system carried on the plan. An
// inferred rig (the engine's pick, not the visit's) is mix math only:
// it is never recorded as equipment used (Codex #4124 r2 P1).
function resolveEquipment({ plan, equipmentSystemId, calibrationId, calibrationCleared }) {
  const planUsable = !calibrationCleared && !plan?.equipmentCalibration?.inferred;
  return {
    equipmentSystemId: equipmentSystemId || (planUsable ? plan?.mixCalculator?.equipmentSystemId : null) || null,
    calibrationId: calibrationId || (planUsable ? plan?.equipmentCalibration?.selected?.id : null) || null,
  };
}

// Approved substitutions on the plan, keyed by the substitute's catalog id
// so an applied or skipped substitute maps back to the protocol row of the
// product it replaced.
function resolveSubstitutions(plan) {
  const substitutions = (plan?.mixCalculator?.items || [])
    .map((item) => item?.substitution)
    .filter(Boolean);
  const bySubstituteProductId = new Map(
    substitutions
      .filter((sub) => sub.substituteProductId)
      .map((sub) => [String(sub.substituteProductId), sub]),
  );
  return { substitutions, bySubstituteProductId };
}

// Skipped rows are part of the all-lawn ledger: with the gate off the
// legacy WaveGuard writer must stay byte-identical even though Complete
// Service (defaults gates on) now submits removed defaults. A skipped row
// is only ever a default THIS visit's plan selected — the same rows the
// closeout prefilled (selected `defaultInPlan` items, an approved
// substitute standing in for one included) — never a premium, optional or
// unselected conditional product of the window. A default the form showed
// from a plan that changed before submit, an id retired meanwhile, or a
// crafted id stays on the completion's metadata (`unlisted`) and never
// becomes a `skipped` actual that Command Center would count.
function partitionSkippedProducts(completionInput, plan, structured, allLawn) {
  if (!allLawn) return { skipped: [], unlisted: [] };
  const structuredProducts = structured?.products || [];
  const isVisitDefault = (item) => item?.selected === true
    && structuredProducts.find((row) => row.productId === (item.substitution?.originalProductId || item.product?.id))?.defaultInPlan;
  const visitDefaultIds = new Set((plan?.mixCalculator?.items || [])
    .filter(isVisitDefault)
    .map((item) => String(item.product?.id || ''))
    .filter(Boolean));
  const submitted = normalizeSkippedProducts(completionInput.skippedProducts);
  return {
    skipped: submitted.filter((row) => visitDefaultIds.has(String(row.productId))),
    unlisted: submitted
      .filter((row) => !visitDefaultIds.has(String(row.productId)))
      .map(({ productId, productName }) => ({ productId, productName })),
  };
}

// A skipped default lands in the foreign-keyed product_id column. The plan
// was built before this transaction: a catalog row deleted in between still
// sits in the plan's defaults, and inserting its id would roll the whole
// closeout back as a 500. Ids the catalog no longer resolves stay on the
// completion's metadata as unlisted (Codex #4113 P2).
async function revalidateSkippedProducts(trx, skips) {
  if (!skips.skipped.length) return skips;
  const ids = skips.skipped.map((row) => String(row.productId));
  // FOR SHARE: the accepted rows stay locked through the skipped-actual
  // inserts, so a catalog delete racing this transaction blocks instead of
  // winning the FK race after the check (Codex #4113 P2).
  // The locked row also supplies the name: a skipped actual's product_name
  // is the catalog's, never the request's, so an older or crafted client
  // cannot label a real product_id as an unrelated product (Codex #4113 P2).
  // The submitted name is kept for the audit metadata when it differs.
  const known = new Map((await trx('products_catalog').whereIn('id', ids).forShare().select('id', 'name')).map((row) => [String(row.id), String(row.name || '').trim()]));
  const retired = skips.skipped.filter((row) => !known.has(String(row.productId)));
  return {
    skipped: skips.skipped.filter((row) => known.has(String(row.productId))).map((row) => {
      const catalogName = known.get(String(row.productId));
      if (!catalogName || catalogName === row.productName) return row;
      return { ...row, productName: catalogName, submittedProductName: row.productName };
    }),
    unlisted: [...skips.unlisted, ...retired.map(({ productId, productName }) => ({ productId, productName }))],
  };
}

// actual_rate_per_1000 is a per-1,000 sq ft number — a per-basis recorded
// rate must not land in it verbatim (codex P2/P1, PR #3419): an /acre rate
// converts EXACTLY (1 acre = 43.56 k sq ft) with its unit rebased; any
// other per-basis unit (g/spot, fl_oz/gal, …) has no honest per-1,000
// representation and stores NULL here. The technician-recorded value+unit
// stay authoritative on the service_products row and are preserved in
// metadata.
function rebaseRatePer1000(serviceProduct) {
  const recordedRate = Number(serviceProduct.application_rate);
  const recordedRateUnit = String(serviceProduct.rate_unit || '').trim();
  if (Number.isFinite(recordedRate) && /\/acre$/i.test(recordedRateUnit)) {
    return { rate: Number((recordedRate / 43.56).toFixed(4)), unit: recordedRateUnit.slice(0, recordedRateUnit.indexOf('/')) };
  }
  if (recordedRateUnit.includes('/') && !/\/1000sf$/i.test(recordedRateUnit)) {
    return { rate: null, unit: null };
  }
  return { rate: serviceProduct.application_rate || null, unit: serviceProduct.rate_unit || null };
}

// Every actual / completion column that is absent, empty or zero is stored
// as NULL (never undefined, which knex would bind as DEFAULT).
function nullDefaults(row) {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, value || null]));
}

function appliedActualMetadata(serviceProduct, substitution) {
  return {
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
  };
}

function buildAppliedActual({ completionId, serviceProduct, substitution, protocolProduct, attributed }) {
  const actual = rebaseRatePer1000(serviceProduct);
  const protocol = protocolProduct || {};
  // off_protocol means the visit HAD a protocol and this product was not on
  // it; a visit with no protocol at all records a plain application.
  let status = 'applied';
  if (substitution) status = 'substituted_applied';
  else if (attributed && !protocolProduct) status = 'off_protocol_applied';
  return nullDefaults({
    lawn_protocol_service_completion_id: completionId,
    service_product_id: serviceProduct.id,
    protocol_product_id: protocol.id,
    product_id: serviceProduct.product_id || protocol.product_id,
    product_name: serviceProduct.product_name || protocol.catalog_product_name || protocol.product_name || 'Applied product',
    role: protocol.role,
    status,
    planned_rate_per_1000: protocol.rate_per_1000,
    planned_rate_unit: protocol.rate_unit,
    actual_rate_per_1000: actual.rate,
    actual_rate_unit: actual.unit,
    actual_amount: serviceProduct.total_amount,
    actual_amount_unit: serviceProduct.amount_unit,
    metadata: JSON.stringify(appliedActualMetadata(serviceProduct, substitution)),
  });
}

// A removed default may be an approved substitute: the closeout knows the
// substitute catalog id, the protocol row holds the original. Resolving
// through the plan's substitution map keeps the skipped row's protocol
// identity, role, planned rate and substitution relationship.
function buildSkippedActual({ completionId, skipped, substitution, protocolProduct }) {
  const protocol = protocolProduct || {};
  return nullDefaults({
    lawn_protocol_service_completion_id: completionId,
    protocol_product_id: protocol.id,
    product_id: skipped.productId,
    product_name: skipped.productName,
    role: protocol.role,
    status: 'skipped',
    planned_rate_per_1000: protocol.rate_per_1000,
    planned_rate_unit: protocol.rate_unit,
    skip_reason: skipped.reason,
    metadata: JSON.stringify({
      source: 'tech_closeout', reasonSupplied: skipped.reasonSupplied, substitution: substitution || null,
      ...(skipped.submittedProductName ? { submittedProductName: skipped.submittedProductName } : {}),
    }),
  });
}

function completionMetadata({ window, attributed, completionInput, area, checklistProvided, substitutions, skips }) {
  return {
    source: 'dispatch_completion',
    // 'protocol' = a structured window attributed the visit; 'none' = the
    // visit was recorded without a lawn plan (one-time / commercial / no
    // assignment). Never a guessed residential protocol.
    attribution: attributed ? 'protocol' : 'none',
    treatedSqftSource: area.source,
    incompleteVisit: completionInput.incompleteVisit === true,
    // Distinguishes "no checklist collected" (read-only protocol flow)
    // from "checklist collected with nothing missing" for audits.
    checklistCollected: checklistProvided,
    customerNoteTemplates: window.customerNoteTemplates || [],
    serviceReportContext: window.serviceReportContext || {},
    assessmentBridge: window.assessmentBridge || {},
    substitutions,
    unlistedSkippedProducts: skips.unlisted,
    inventoryDeductions: Array.isArray(completionInput.inventoryDeductions)
      ? completionInput.inventoryDeductions
      : [],
  };
}

function buildCompletionRow({
  calibrationCleared = false,
  service, serviceRecord, plan, completionInput, serviceDate, allLawn,
  attribution: { attributed }, structured, window, rows, equipment, substitutions, skips,
}) {
  const requiredTasks = window.requiredTasks || [];
  const { provided: checklistProvided, checklist, missingTasks } = resolveChecklist(completionInput, requiredTasks);
  const area = resolveTreatedArea(completionInput, plan, allLawn, calibrationCleared);
  const watchItems = Array.isArray(completionInput.watchItems)
    ? completionInput.watchItems
    : requiredTasks.map((task) => String(task).replace(/_/g, ' '));
  return nullDefaults({
    service_record_id: serviceRecord.id,
    scheduled_service_id: service.id || serviceRecord.scheduled_service_id,
    customer_id: service.customer_id || serviceRecord.customer_id,
    // Frozen service property (migration 20260907000110 ships in this PR).
    property_id: service.property_id,
    lawn_protocol_id: rows.protocolRow?.id,
    lawn_protocol_window_id: rows.windowRow?.id,
    protocol_key: structured.protocolKey,
    protocol_version: structured.version,
    window_key: window.key,
    window_title: window.title,
    equipment_system_id: equipment.equipmentSystemId,
    calibration_id: equipment.calibrationId,
    treated_sqft: area.treatedSqft,
    carrier_gal_per_1000: area.carrier,
    total_carrier_gal: area.totalCarrier,
    checklist: JSON.stringify(checklist),
    required_tasks: JSON.stringify(requiredTasks),
    missing_required_tasks: JSON.stringify(missingTasks),
    // No protocol window → no protocol-derived response window or watch
    // items; the columns stay at their empty defaults instead of a generic
    // promise.
    expected_response: JSON.stringify(attributed ? summarizeExpectedResponse(window, completionInput) : {}),
    watch_items: JSON.stringify(watchItems),
    recheck_due_date: defaultRecheckDueDate(window, completionInput, serviceDate),
    metadata: JSON.stringify(completionMetadata({
      window, attributed, completionInput, area, checklistProvided, substitutions, skips,
    })),
  });
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
  if (!serviceRecord?.id) return null;
  const allLawn = lawnActualsLedgerEnabled();
  const attribution = resolveAttribution(plan, allLawn);
  if (!attribution) return null;

  const rows = await loadProtocolRows(trx, attribution);
  const equipment = resolveEquipment({ plan, equipmentSystemId, calibrationId, calibrationCleared });
  // A plan whose protocol attribution is withheld contributes no
  // substitution labels either: an applied product that happens to be the
  // calendar plan's substitute is a plain application on a visit with no
  // applicable protocol, never an approved protocol substitution (Codex #4113).
  const { substitutions, bySubstituteProductId } = resolveSubstitutions(attribution.attributed ? plan : null);
  // A product the visit applied is not a skipped default, whatever the client
  // submitted: an applied and a skipped row for one product would inflate
  // Command Center's skip counts (pre-push audit P1).
  // Compared by protocol identity, not catalog id: default A applied while its
  // approved substitute B is submitted as skipped (or the reverse) is one
  // protocol product, and both rows would resolve to A's protocol row
  // (Codex #4113 P2).
  const protocolIdentity = (productId) => String(bySubstituteProductId.get(String(productId || ''))?.originalProductId || productId || '');
  const appliedIdentities = new Set(serviceProducts.map((row) => protocolIdentity(row.product_id)));
  const partitioned = partitionSkippedProducts(completionInput, plan, attribution.structured, allLawn);
  const skips = await revalidateSkippedProducts(trx, {
    skipped: partitioned.skipped.filter((row) => !appliedIdentities.has(protocolIdentity(row.productId))),
    unlisted: partitioned.unlisted.filter((row) => !appliedIdentities.has(protocolIdentity(row.productId))),
  });

  const [completion] = await trx('lawn_protocol_service_completions')
    .insert(buildCompletionRow({
      service: service || {}, serviceRecord, plan, completionInput, serviceDate, allLawn, calibrationCleared,
      attribution, structured: attribution.structured || {}, window: attribution.window || {},
      rows, equipment, substitutions, skips,
    }))
    .onConflict('service_record_id')
    .merge()
    .returning('*');

  // The completion row upserts on service_record_id; its actual rows must be
  // just as idempotent, or a durable-completion resume / retry doubles every
  // applied and skipped product. Same trx as the completion, so a failure
  // after the delete rolls the old rows back with it.
  await trx('lawn_protocol_product_actuals').where({ lawn_protocol_service_completion_id: completion.id }).del();

  for (const serviceProduct of serviceProducts) {
    const substitution = bySubstituteProductId.get(String(serviceProduct.product_id)) || null;
    const protocolProduct = resolveProtocolProduct(rows.protocolProducts, substitution, serviceProduct);
    await trx('lawn_protocol_product_actuals').insert(buildAppliedActual({
      completionId: completion.id, serviceProduct, substitution, protocolProduct, attributed: attribution.attributed,
    }));
  }

  for (const skipped of skips.skipped) {
    const substitution = bySubstituteProductId.get(String(skipped.productId)) || null;
    const protocolProduct = resolveProtocolProduct(rows.protocolProducts, substitution, skipped);
    await trx('lawn_protocol_product_actuals').insert(buildSkippedActual({
      completionId: completion.id, skipped, substitution, protocolProduct,
    }));
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
