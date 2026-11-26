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

// The accepted estimate's own WDO line, net of its discounts and manual price changes. This is the estimate's accepted-work reader
// (deriveCorrectiveWork, the extractor the accept card and the proposal draft use): it walks every stored shape, merges a mapped row
// with its raw twin and lets the operator-accepted net (manualFinalOneTime) outrank the list price, so a $175 line the office set to
// $150 reads $150. Never a second parallel reader. An explicit $0 (a comped line) reads 0. null when there is no WDO line, two WDO
// lines, or the estimate cannot be read as accepted work (a review-gated or conflicting row).
function acceptedWdoLineNet(estimateData) {
  let data = estimateData;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return null; } }
  if (!data || typeof data !== 'object') return null;
  const { deriveCorrectiveWork } = require('./estimate-proposal-generate');
  const bundleItems = data.sendSnapshot?.pricingBundle?.oneTimeBreakdown?.items;
  // The sent pricing bundle is what the customer accepted; a snapshot-only estimate holds its rows nowhere else.
  const docs = [data, ...(Array.isArray(bundleItems) ? [{ result: { oneTime: { items: bundleItems } } }] : [])];
  for (const doc of docs) {
    const { correctiveWork } = deriveCorrectiveWork(doc, { onetime_total: null });
    const wdo = (correctiveWork || []).filter((line) => line.service === 'wdo_inspection');
    if (wdo.length === 1) return moneyOrNull(wdo[0].amount);
    if (wdo.length > 1) return null;
  }
  return explicitZeroWdoLine(data);
}

// A comped WDO line is held back by the extractor (it asks staff to author the work), so an explicit $0 is read the way the accept
// card reads each row: the first number among its net fields decides (estimate-accept-effects lineAmount). Only when every WDO row
// is $0 does the fee seed 0 (a deliberate no-charge inspection).
function explicitZeroWdoLine(data) {
  const { estimateOneTimeItemsFromData } = require('./estimate-converter');
  const { lineAmount } = require('./estimate-accept-effects');
  const rows = estimateOneTimeItemsFromData(data).filter((row) => row?.service === 'wdo_inspection' && !row.quoteRequired);
  return rows.length && rows.every((row) => lineAmount(row) === 0) ? 0 : null;
}

// The WDO fee to seed on a new inspection project from its linked visit: the accepted estimate's WDO line net (it survives billable
// add-ons on the visit), else the visit's own price when the visit has no billable add-on (then the visit total IS the inspection).
// null only for a SUCCESSFUL read with no isolable amount: the fee stays blank and bills the flat default exactly as before. A read
// error is never swallowed into a blank fee: it propagates so the caller can fail the create and the office retries.
async function seedWdoFeeFromVisit(knex, scheduledServiceId) {
  if (!scheduledServiceId) return null;
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
}

module.exports = {
  parseWdoFee,
  resolveWdoInspectionFee,
  wdoFeeIsExplicitZero,
  wdoFeeNeedsEntry,
  acceptedWdoLineNet,
  seedWdoFeeFromVisit,
};
