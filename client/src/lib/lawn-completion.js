import lawnLibrary from '../../../shared/lawn-condition-findings.json';

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

export function lawnPlanSelections(items, buildProduct, catalog) {
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
    return {
      ...row,
      rate: mix.ratePer1000 ?? '',
      rateUnit: mix.rateUnit || row.rateUnit,
      amountUnit: mix.amountUnit || row.amountUnit,
      areaValue: mix.treatedSqft ?? row.areaValue,
      areaUnit: mix.treatedSqft != null ? 'sqft' : row.areaUnit,
      totalAmount: mix.amount ?? '',
      totalAmountManual: false,
      applicationArea: LAWN_DEFAULT_AREAS.join(', '),
      applicationAreaDefault: true,
    };
  });
}

export const LAWN_FIELD_ACTIONS = lawnLibrary.actions.map((label, index) => ({ id: `lawn-field-${index}`, label, note: label, scope: 'exterior', treatmentApplied: false }));

export function isLawnFindingSelection(value) {
  return lawnLibrary.groups.some((group) => group.findings.some(({ statement }) =>
    lawnLibrary.locations.some((location) => ['', ...lawnLibrary.extents].some((extent) =>
      value === `${statement} Location: ${location}.${extent ? ` Extent: ${extent}.` : ''}`))));
}
