'use strict';

/**
 * LESCO 13-0-13 bed and tree fertilizer, judged at Tree & Shrub closeout (labels read 2026-10-22).
 *
 * The Waves rule for this bag is stricter than its label, because the county fertilizer code allows at most 1 lb of nitrogen
 * per 1,000 sq ft per application: 0.75 lb per 100 sq ft = 7.5 lb per 1,000 sq ft = 0.98 lb N (the bag's 1 lb per 100 sq ft
 * would be 1.3 lb N). Two more program rules: at most 2 applications in 12 months, at least 5 calendar months apart (the
 * f13013 rule in tree-shrub-completion-defaults.js, the same one that picks the suggestion on a card).
 *
 * How it holds. The June 1 to Sept. 30 N/P blackout stays a hard block in validateTreeShrubTypedCompliance (a legal
 * rule; it also covers a 13-0-13 added by hand, because the product is N/P fertilizer). The rate cap and the history rules
 * are COUNT and RATE limits, and the closeout never refuses for those: the product was physically applied and must stay
 * in the application ledger and the FDACS export (complete-scheduled-service.js, hard count limits). So, like those limits and
 * the area add-on governed rate, a finding is FLAGGED on the completion (applicationLimitAdvisory, the tech sees it in the
 * closeout) and sent to the office as an admin notification. It runs after the record is saved, on the rows the closeout
 * recorded, so it covers a 13-0-13 the tech added by hand as well as the one the card suggested. It never throws and never
 * blocks; a failed read is logged and flags nothing, except an unreadable history, which is flagged as unchecked.
 */
const logger = require('./logger');
const { inferTreeShrubOrdinanceZone } = require('./tree-shrub-closeout');
const {
  ORNAMENTAL_13_0_13, treeShrubDueReason, loadTreeShrubApplicationHistory, hasUnidentifiedApplication, UNIDENTIFIED_PRODUCT_REASON,
} = require('./tree-shrub-completion-defaults');

const CAP_LB_PER_1000 = 7.5;
const RATE_LIMIT_TYPE = 'ornamental_fertilizer_rate';
const HISTORY_LIMIT_TYPE = 'ornamental_fertilizer_history';
const UNCHECKED_LIMIT_TYPE = 'ornamental_fertilizer_rate_unchecked';

const LB_PER_1000_UNITS = new Set(['lb', 'lbs', 'lb/1000sf', 'lb/1000sqft', 'lb/1000ft2']);
// The sheet's weight units for a dry product are g, oz and lb; the total is judged in pounds.
const LB_PER_UNIT = { lb: 1, lbs: 1, oz: 1 / 16, g: 1 / 453.592 };
function totalLb(row) {
  const factor = LB_PER_UNIT[squash(row.amount_unit)];
  return positive(row.total_amount) && factor ? Number(row.total_amount) * factor : null;
}
const SQFT_UNITS = new Set(['sqft', 'sf', 'ft2']);
const squash = (value) => String(value || '').toLowerCase().replace(/[\s,.]/g, '');
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0 && value !== '' && value !== null;

/**
 * lb per 1,000 sq ft of one recorded row. The form lets a tech override the total without touching the rate, so BOTH readings
 * are taken and the higher one is judged: the total over the treated area (what was actually spread) and the entered rate when
 * it is a lb-per-1,000 rate. null when neither can be read (no rate, or a total with no area), so the cap cannot be judged.
 */
function ratePer1000(row) {
  const readings = [];
  if (positive(row.application_rate) && LB_PER_1000_UNITS.has(squash(row.rate_unit))) readings.push(Number(row.application_rate));
  const lb = totalLb(row);
  if (lb !== null && positive(row.area_value) && SQFT_UNITS.has(squash(row.area_unit))) readings.push((lb / Number(row.area_value)) * 1000);
  return readings.length ? Math.max(...readings) : null;
}

const round2 = (value) => Math.round(value * 100) / 100;

/** Why the cap could not be read for a row: 'area_missing' (an amount but no treated sq ft) or 'rate_missing' (no usable amount or rate). */
const uncheckedReason = (row) => (totalLb(row) !== null ? 'area_missing' : 'rate_missing');
/** The one sentence the tech and the office read for a 13-0-13 row whose county cap could not be checked (no leading name). */
const uncheckedClause = (reason) => (reason === 'area_missing'
  ? 'recorded with no treated sq ft; county cap not checked'
  : 'recorded with no usable amount or rate; county cap not checked');

/** The findings for the 13-0-13 rows of one closeout. Pure. `rows` are the record's service_products rows. */
function rateFindings(rows) {
  const out = [];
  for (const row of rows) {
    const rate = ratePer1000(row);
    if (rate === null) {
      // Not advisoryOnly: a 13-0-13 row the cap cannot be read for (an old cached client, a direct API call) was physically applied
      // with no way to hold it to the county limit, so the office is rung, once per record and product, like an over-cap row.
      const reason = uncheckedReason(row);
      out.push({ code: 'application_limit_exceeded', limitType: UNCHECKED_LIMIT_TYPE, productId: row.product_id, productName: row.product_name,
        reason, current: null, max: CAP_LB_PER_1000,
        message: `Recorded. The office will review: ${row.product_name || '13-0-13'} ${uncheckedClause(reason)}. Enter the amount in lb and the treated sq ft.` });
    } else if (round2(rate) > CAP_LB_PER_1000) {
      out.push({ code: 'application_limit_exceeded', limitType: RATE_LIMIT_TYPE, productId: row.product_id, productName: row.product_name,
        current: round2(rate), max: CAP_LB_PER_1000,
        message: `Recorded. The office will review: ${row.product_name || '13-0-13'} was applied at ${round2(rate)} lb per 1,000 sq ft, over the ${CAP_LB_PER_1000} lb per 1,000 sq ft (0.75 lb per 100 sq ft) county limit.` });
    }
  }
  return out;
}

/** The history finding for one 13-0-13 row, or null: the f13013 due rule over the other records of this customer. Pure. */
function historyFinding({ row, history, scheduled, serviceDate, zone }) {
  const reason = hasUnidentifiedApplication(history, scheduled, serviceDate)
    ? UNIDENTIFIED_PRODUCT_REASON
    : treeShrubDueReason('f13013', history, serviceDate, scheduled.property_id, zone);
  if (!reason) return null;
  return { code: 'application_limit_exceeded', limitType: HISTORY_LIMIT_TYPE, productId: row.product_id, productName: row.product_name, current: null, max: null,
    reason, message: `Recorded. The office will review: ${row.product_name || '13-0-13'}: ${reason}` };
}

const isOrnamental = (row) => ORNAMENTAL_13_0_13.test(String(row.product_name || ''));

async function recordedOrnamentalRows(database, recordId) {
  const rows = await database('service_products as sp')
    .leftJoin('products_catalog as pc', 'pc.id', 'sp.product_id')
    .where('sp.service_record_id', recordId)
    .select('sp.product_id', 'sp.application_rate', 'sp.rate_unit', 'sp.total_amount', 'sp.amount_unit', 'sp.area_value', 'sp.area_unit',
      database.raw('COALESCE(pc.name, sp.product_name) as product_name'));
  return rows.filter(isOrnamental);
}

/**
 * The completion check: reads the 13-0-13 rows this record saved and flags a rate over the county cap and a breach of the
 * 2-in-12-months, 5-months-apart or June-September history rules. `advisory` is the completion's applicationLimitAdvisory; the
 * merged advisory comes back (the same object when nothing is flagged). `notify` sends the findings to the office
 * (notifyOfficeOfLimitFindings). Never throws, never blocks.
 */
async function flagOrnamentalFertilizer({ svc, record, database, advisory, notify }) {
  try {
    if (!record?.id) return advisory;
    const rows = await recordedOrnamentalRows(database, record.id);
    if (!rows.length) return advisory;
    const findings = rateFindings(rows);
    const serviceDate = record.service_date || svc.scheduled_date;
    try {
      const history = await loadTreeShrubApplicationHistory({ db: database, scheduled: svc, excludeRecordId: record.id });
      const found = historyFinding({ row: rows[0], history, scheduled: svc, serviceDate, zone: inferTreeShrubOrdinanceZone(svc) });
      if (found) findings.push(found);
    } catch (err) {
      logger.warn(`[ts-ornamental-fertilizer] history read failed for record ${record.id}: ${err?.message}`);
      findings.push({ code: 'application_limit_check_unavailable', productId: rows[0].product_id, advisoryOnly: true,
        message: 'Recorded. The office will review: 13-0-13 history could not be checked for this visit.' });
    }
    if (!findings.length) return advisory;
    const toOffice = findings.filter((finding) => !finding.advisoryOnly);
    if (toOffice.length) await notify({ svc, record, findings: toOffice });
    return { advisory: true, blocks: [...(advisory?.blocks || []), ...findings.map((f) => ({ code: f.code, message: f.message, productId: f.productId }))] };
  } catch (err) {
    logger.warn(`[ts-ornamental-fertilizer] check failed for record ${record?.id}: ${err?.message}`);
    return advisory;
  }
}

module.exports = {
  CAP_LB_PER_1000, RATE_LIMIT_TYPE, HISTORY_LIMIT_TYPE, UNCHECKED_LIMIT_TYPE, uncheckedClause, ratePer1000, rateFindings, historyFinding, recordedOrnamentalRows, flagOrnamentalFertilizer,
};
