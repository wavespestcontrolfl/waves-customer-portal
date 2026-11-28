// WDO inspection auto-invoice fee. The tech-entered inspection fee wins (an
// explicit numeric zero is a deliberate no-charge inspection). When the entry
// is blank or unparseable prose, fall back to the linked visit's booked WDO
// price (size/construction table $150-$275, using primary_line_price when
// billable add-ons exist so add-on dollars are never folded into the WDO line)
// before falling back to the flat $250 default in @waves/report-redaction.
const {
  WDO_DEFAULT_INSPECTION_FEE,
  parseWdoFeeAmount,
  parseWdoFee,
  wdoFeeIsExplicitZero,
} = require('@waves/report-redaction');

function positiveFee(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function bookedWdoVisitFee(visit) {
  if (!visit || typeof visit !== 'object') return null;
  const rawEstimated = visit.estimated_price ?? visit.estimatedPrice;
  if (rawEstimated !== null && rawEstimated !== undefined && rawEstimated !== '' && Number(rawEstimated) === 0) {
    return null;
  }
  const primary = positiveFee(visit.primary_line_price ?? visit.primaryLinePrice);
  const estimated = positiveFee(rawEstimated);
  const hasExplicitDiscount = Number(visit.discount_amount ?? visit.discountAmount ?? 0) > 0
    || Number(visit.primary_line_discount ?? visit.primaryLineDiscount ?? 0) > 0;
  const addons = visit.service_addons ?? visit.serviceAddons;
  const addonCents = Array.isArray(addons)
    ? addons.reduce((sum, a) => {
      const p = positiveFee(a?.estimated_price ?? a?.estimatedPrice ?? a?.base_price ?? a?.basePrice ?? a?.price);
      return sum + (p !== null ? Math.round(p * 100) : 0);
    }, 0)
    : 0;
  const hasBillableAddons = visit.has_billable_addons === true
    || visit.hasBillableAddons === true
    || addonCents > 0;
  if (hasBillableAddons) {
    if (primary === null || hasExplicitDiscount) return null;
    if (estimated !== null) {
      if (addonCents === 0) return null;
      if (Math.round(primary * 100) + addonCents !== Math.round(estimated * 100)) return null;
    }
    return primary;
  }
  if (hasExplicitDiscount && estimated === null) return null;
  if (primary !== null && estimated !== null) return Math.min(primary, estimated);
  return estimated ?? primary ?? null;
}

async function loadLinkedWdoVisit(project, database) {
  if (!project || !database) return null;
  try {
    let scheduledServiceId = project.scheduled_service_id || null;
    if (!scheduledServiceId && project.service_record_id) {
      const sr = await database('service_records')
        .where({ id: project.service_record_id })
        .first('scheduled_service_id')
        .catch(() => null);
      scheduledServiceId = sr?.scheduled_service_id || null;
    }
    if (!scheduledServiceId) return null;
    const visit = await database('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('id', 'estimated_price', 'primary_line_price')
      .catch(() => null);
    if (!visit) return null;
    const addons = await database('scheduled_service_addons')
      .where({ scheduled_service_id: scheduledServiceId })
      .select('estimated_price', 'base_price')
      .catch(() => []);
    return { ...visit, service_addons: Array.isArray(addons) ? addons : [] };
  } catch {
    return null;
  }
}

function resolveWdoInspectionFee(findings, { scheduledService = null, fallbackFee = null } = {}) {
  const entered = parseWdoFeeAmount(findings?.inspection_fee);
  if (entered !== null) return entered;
  const booked = bookedWdoVisitFee(scheduledService);
  if (booked !== null) return booked;
  const fallback = positiveFee(fallbackFee);
  if (fallback !== null) return fallback;
  return WDO_DEFAULT_INSPECTION_FEE;
}

module.exports = {
  parseWdoFeeAmount,
  parseWdoFee,
  bookedWdoVisitFee,
  loadLinkedWdoVisit,
  resolveWdoInspectionFee,
  wdoFeeIsExplicitZero,
};
