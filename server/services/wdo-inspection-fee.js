// WDO inspection auto-invoice fee. The tech-entered inspection fee wins. A
// blank/digit-free value uses the owner-approved flat default, while an
// explicit numeric zero is a deliberate no-charge inspection. The default
// lives in @waves/report-redaction so billing, the server fee scrub, and the
// client preview all share one number (codex #2817).
const { WDO_DEFAULT_INSPECTION_FEE } = require('@waves/report-redaction');

function parseWdoFee(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  const amount = match ? Number(match[1]) : 0;
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function wdoFeeIsExplicitZero(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  return match != null && Number(match[1]) === 0;
}

function resolveWdoInspectionFee(findings) {
  const enteredFee = parseWdoFee(findings?.inspection_fee);
  if (enteredFee > 0) return enteredFee;
  if (wdoFeeIsExplicitZero(findings?.inspection_fee)) return 0;
  return WDO_DEFAULT_INSPECTION_FEE;
}

// A blank (digit-free) fee that is not an explicit zero: nothing has been entered or seeded for this inspection. A blank fee keeps
// billing the flat default as before (resolveWdoInspectionFee is unchanged); the project-create seed below fills it first from the
// accepted estimate's WDO line when that line can be isolated (owner 2026-11-26, WDO quotes now vary by home size and construction).
function wdoFeeNeedsEntry(findings) {
  return !(parseWdoFee(findings?.inspection_fee) > 0) && !wdoFeeIsExplicitZero(findings?.inspection_fee);
}

const moneyOrNull = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

// The accepted estimate's own WDO line, net of its discounts: from the sent pricing bundle (what the customer accepted) or, failing
// that, the stored result. null when there is no WDO row, or more than one row with different amounts (the line cannot be isolated).
function acceptedWdoLineNet(estimateData) {
  let data = estimateData;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return null; } }
  if (!data || typeof data !== 'object') return null;
  const bundle = data.sendSnapshot?.pricingBundle;
  let container = null;
  try { container = require('./estimate-result-container').storedEstimateContainer(data); } catch { container = null; }
  const sources = [
    bundle?.oneTimeBreakdown?.items,
    container?.oneTime?.items, container?.oneTime?.specItems, container?.specItems, container?.lineItems,
  ];
  const nets = new Set();
  for (const list of sources) {
    for (const row of [].concat(list || [])) {
      if (!row || row.service !== 'wdo_inspection' || row.quoteRequired) continue;
      const net = moneyOrNull(row.priceAfterDiscount ?? row.manualFinalOneTime ?? row.amount ?? row.price);
      if (net != null) nets.add(net);
    }
    if (nets.size) break;
  }
  return nets.size === 1 ? [...nets][0] : null;
}

// The WDO fee to seed on a new inspection project from its linked visit: the accepted estimate's WDO line net (it survives billable
// add-ons on the visit), else the visit's own price when the visit has no billable add-on (then the visit total IS the inspection).
// null when the line cannot be isolated: the fee stays blank and bills the flat default exactly as before.
async function seedWdoFeeFromVisit(knex, scheduledServiceId) {
  if (!scheduledServiceId) return null;
  try {
    const visit = await knex('scheduled_services').where({ id: scheduledServiceId }).first('id', 'estimated_price', 'source_estimate_id');
    if (!visit) return null;
    if (visit.source_estimate_id) {
      const estimate = await knex('estimates').where({ id: visit.source_estimate_id }).first('estimate_data');
      const accepted = acceptedWdoLineNet(estimate?.estimate_data);
      if (accepted != null) return accepted;
    }
    const addons = await knex('scheduled_service_addons').where({ scheduled_service_id: scheduledServiceId }).select('estimated_price');
    if (addons.some((a) => Number(a?.estimated_price) > 0)) return null;
    return moneyOrNull(visit.estimated_price);
  } catch {
    return null;
  }
}

module.exports = {
  parseWdoFee,
  resolveWdoInspectionFee,
  wdoFeeIsExplicitZero,
  wdoFeeNeedsEntry,
  acceptedWdoLineNet,
  seedWdoFeeFromVisit,
};
