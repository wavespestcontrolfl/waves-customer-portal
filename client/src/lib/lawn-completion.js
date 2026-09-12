import lawnLibrary from '../../../shared/lawn-condition-findings.json';
import { isTankCalculation } from './product-rate-prefill';

// Existing plan and assessment records remain authoritative; these helpers only
// prepare editable closeout fields and select a previous confirmed visit.
export const LAWN_DEFAULT_AREAS = ['Front yard', 'Back yard', 'Side yards'];

export function previousLawnAssessment(history, service) {
  const day = String(service.scheduledDate || service.scheduled_date || service.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const visitDay = (row) => String(row.service_id ? row.appointment_date || '' : row.service_date || '').slice(0, 10);
  return (history || [])
    .filter((row) => row.confirmed_by_tech === true
      && (!row.service_id || String(row.service_id) !== String(service.id))
      && /^\d{4}-\d{2}-\d{2}$/.test(visitDay(row)) && visitDay(row) < day)
    .sort((a, b) => visitDay(b).localeCompare(visitDay(a))
      || (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))[0] || null;
}

const PLAN_FIELDS = ['rate', 'rateUnit', 'amountUnit', 'areaValue', 'areaUnit', 'totalAmount', 'applicationMethod'];
// A chosen amount unit is not a calculation input: the derived total is
// withdrawn while that unit differs from the plan's (below), but an untouched
// rate or treated area must still follow a visit-area refresh — a stale
// product area would be the nutrient ledger's denominator (Codex r9 P1).
// Neither is a chosen rate unit: the plan's rate is a quantity in the plan's
// unit, so while the units differ the still-derived rate and total stay
// withdrawn rather than relabeled, and they return when the units agree
// again or the tech enters the actual (Codex r12 P1).
const CALCULATION_INPUTS = ['rate', 'areaValue', 'areaUnit', 'applicationMethod'];

export function lawnPlanSelections(items, buildProduct, catalog, { areas = LAWN_DEFAULT_AREAS, governed = false } = {}) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const id = item?.product?.id;
    if (!id || item.selected === false || seen.has(String(id))
      || !catalog.some((product) => String(product.id) === String(id))) return false;
    seen.add(String(id));
    return true;
  }).map((item) => {
    const row = buildProduct(catalog.find((product) => String(product.id) === String(item.product.id)));
    const mix = item.mix || {};
    // Only the generated per-visit mix supplies defaults; static optional
    // protocol rows and inferred label rates never become actual quantities.
    const selection = {
      ...row,
      rate: mix.ratePer1000 ?? '',
      rateUnit: mix.rateUnit || row.rateUnit,
      amountUnit: mix.amountUnit || row.amountUnit,
      areaValue: mix.treatedSqft ?? row.areaValue,
      areaUnit: mix.treatedSqft != null ? 'sqft' : row.areaUnit,
      totalAmount: mix.amount ?? '',
      totalAmountManual: false,
      applicationArea: areas.join(', '),
      applicationAreaDefault: true,
    };
    if (governed) {
      selection.applicationMethod = item.applicationMethod || row.applicationMethod;
      selection.areaValue = mix.treatedSqft ?? '';
      selection.areaUnit = 'sqft';
      selection.lawnAmountReason = item.amountReason;
      selection.lawnPlanDefaults = Object.fromEntries(PLAN_FIELDS.map(key => [key, selection[key]]));
      selection.lawnPlanManualFields = [];
    }
    return selection;
  });
}

// The plan request failed: every still-derived suggestion is withdrawn (an
// entered value keeps its number and unit) and the row asks for the actual.
// Applied by the failed request itself and again by a draft restored while
// that failure stands — the reconcile effect is off during a plan error, so a
// restored row would otherwise keep the suggestions saved under an earlier
// plan and pass the actuals gate with them.
export const LAWN_PLAN_UNAVAILABLE_REASON = 'Plan unavailable. Confirm the treated area and actual amount or retry.';
// `planUnverified`: the rows were saved under a plan this session never
// resolved (a draft restored while the initial request failed), so the
// plan's application mode is withdrawn with its quantities — a recipe the
// failed request cannot verify must not carry a prior broadcast/spot
// classification into the completion; the tech confirms the method, as
// reconciliation requires when a default disappears (Codex r12 P1). A refresh
// that fails after a successful load keeps the mode that load verified.
export function withdrawLawnPlanSuggestions(rows, { planUnverified = false } = {}) {
  return rows.map((row) => row.lawnPlanDefaults ? {
    ...row,
    // A measured tank dose is an actual, not a suggestion to withdraw.
    totalAmount: row.totalAmountManual || isTankCalculation(row) ? row.totalAmount : '',
    rate: row.lawnPlanManualFields?.includes('rate') || isTankCalculation(row) ? row.rate : '',
    areaValue: row.lawnPlanManualFields?.includes('areaValue') ? row.areaValue : '',
    // A unit the plan chose is withdrawn with the value it labeled: the
    // recipe or catalog unit may have changed while the draft waited, and an
    // amount entered under a preselected stale unit would be recorded and
    // deducted in the wrong dimension (Codex r13 P1). A unit attached to an
    // entered value or chosen by the tech stays.
    ...(planUnverified ? Object.fromEntries([
      ['applicationMethod', ['applicationMethod']], ['rateUnit', ['rate', 'rateUnit']],
      ['amountUnit', ['totalAmount', 'amountUnit']], ['areaUnit', ['areaValue', 'areaUnit']],
    ].filter(([unit, owners]) => !(unit === 'amountUnit' && row.totalAmountManual)
      // A retained tank calculation keeps the units that label it: 20 without
      // fl_oz is not a record (Codex r1 P1).
      && !(isTankCalculation(row) && ['rateUnit', 'amountUnit'].includes(unit))
      && !owners.some(owner => row.lawnPlanManualFields?.includes(owner))).map(([unit]) => [unit, ''])) : {}),
    lawnAmountReason: LAWN_PLAN_UNAVAILABLE_REASON,
  } : row);
}

// Reconcile each row, not the whole list: an edited total or a removed default
// must not freeze every other product when the plan or visit area changes.
// A legacy/manual row has no provenance and stays entirely technician-owned.
export function reconcileLawnPlanSelections(current, defaults, removedIds = []) {
  const byId = new Map(defaults.map(row => [String(row.productId), row]));
  const removed = new Set(removedIds.map(String));
  const rows = current.flatMap((row) => {
    const fresh = byId.get(String(row.productId));
    byId.delete(String(row.productId));
    if (!row.lawnPlanDefaults) return [row];
    const manual = new Set(row.lawnPlanManualFields || []);
    const ownCalculation = CALCULATION_INPUTS.some(key => manual.has(key));
    // Preserve each entered value with its unit on both refresh and withdrawal.
    if (row.totalAmountManual) manual.add('totalAmount');
    // A tank calculation is an actual: the technician measured the gallons, so
    // the rate, its units and the dose they produce belong to this row, and a
    // refresh must not blank a quantity the plan cannot express (Codex r1 P1).
    // Marked after `ownCalculation` above so the treated area still follows
    // the visit.
    if (isTankCalculation(row)) for (const key of ['rate', 'rateUnit', 'amountUnit', 'totalAmount']) manual.add(key);
    for (const [field, unit] of [['totalAmount', 'amountUnit'], ['rate', 'rateUnit'], ['areaValue', 'areaUnit']]) {
      if (manual.has(field)) manual.add(unit);
    }
    if (!fresh) {
      if (!manual.size && row.applicationAreaDefault !== false) return [];
      return [{
        ...row,
        ...Object.fromEntries(PLAN_FIELDS.map(key => [key, manual.has(key) ? row[key] : ''])),
        lawnAmountReason: 'This product is no longer a plan default. Confirm the actual work.',
      }];
    }
    const next = { ...row, lawnPlanDefaults: fresh.lawnPlanDefaults, lawnAmountReason: fresh.lawnAmountReason };
    // Once a rate, method or treated area is edited, this row's calculation
    // belongs to that actual application. A visit-wide refresh cannot scale it.
    for (const key of PLAN_FIELDS) {
      if (manual.has(key) || ownCalculation) continue;
      next[key] = fresh[key];
    }
    // The plan's amount is in the plan's unit and is never scaled into the
    // unit the tech chose: a still-derived total stays withdrawn until the
    // units agree again or the tech enters the actual.
    if (manual.has('amountUnit') && !manual.has('totalAmount') && next.amountUnit !== fresh.amountUnit) next.totalAmount = '';
    // Likewise a chosen rate unit: the plan's 3 fl oz per 1,000 sq ft is
    // never restated as 3 lb. The untouched rate and its derived total stay
    // withdrawn until the tech enters the actual or the unit matches again.
    if (manual.has('rateUnit') && !manual.has('rate') && next.rateUnit !== fresh.rateUnit) {
      next.rate = '';
      if (!row.totalAmountManual) next.totalAmount = '';
    }
    if (fresh.totalAmount === '' && !manual.has('totalAmount')) next.totalAmount = '';
    if (fresh.rate === '' && !manual.has('rate')) next.rate = '';
    if (row.applicationAreaDefault !== false) next.applicationArea = fresh.applicationArea;
    return [next];
  });
  for (const [id, row] of byId) if (!removed.has(id)) rows.push(row);
  return rows;
}

// The option's product keeps the protocol row's application mode (server
// `completionDefaults.options`): addProduct builds an added optional product
// from that mode, not from the catalog category's default.
export function lawnPlanActionOptions(items = []) {
  return items.filter(item => item.product?.id).map(item => ({
    id: `lawn-plan-${item.product.id}`,
    label: item.product.name, note: item.product.name,
    product: { id: item.product.id, name: item.product.name, ...(item.applicationMethod ? { applicationMethod: item.applicationMethod } : {}) },
    scope: 'exterior', treatmentApplied: true,
  }));
}

export const LAWN_FIELD_ACTIONS = lawnLibrary.actions.map((label, index) => ({ id: `lawn-field-${index}`, label, note: label, scope: 'exterior', treatmentApplied: false }));

export function isLawnFindingSelection(value) {
  return lawnLibrary.groups.some((group) => group.findings.some(({ statement }) =>
    lawnLibrary.locations.some((location) => ['', ...lawnLibrary.extents].some((extent) =>
      value === `${statement} Location: ${location}.${extent ? ` Extent: ${extent}.` : ''}`))));
}
