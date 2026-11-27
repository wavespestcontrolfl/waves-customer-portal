/**
 * The LESCO rotary spreader number for a granular line (owner 2026-11-27; server/config/spreader-settings.json).
 * A row is a product and the rate it was set for. A line gets the number of its product's row nearest its rate, only when
 * that rate is within 3% of the row's; otherwise no number and a weigh-test note. A warning only: it never hides a product
 * or an amount. Pure functions, no database.
 */
const config = require('../config/spreader-settings.json');

const norm = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
const NO_RATE_NUMBER = 'No spreader number for this rate: weigh test.';
const NO_PRODUCT_NUMBER = 'No spreader number for this product: weigh test.';

// The rows for a product, by its catalog name or the line's own product name (the text before " — ").
function rowsFor(names, list = config.rows) {
  const keys = names.map(norm).filter(Boolean);
  return list.filter((row) => keys.some((key) => key.includes(norm(row.productMatch))));
}

// The one rate a line states in lb per 1,000 sq ft ("3.1 lb per 1,000 sq ft"); a range states none.
const LINE_LB = /(\d+(?:\.\d+)?)(\s*to\s*\d+(?:\.\d+)?)?\s*lbs?\s+per\s+1,?000\s*sq\.?\s*ft/i;
function lineLbPer1000(raw) {
  const found = LINE_LB.exec(String(raw || ''));
  return found && !found[2] ? Number(found[1]) : null;
}

// 9.5 reads 9½ on the sheet.
function settingText(setting) {
  const whole = Math.floor(setting);
  return Math.abs(setting - whole - 0.5) < 1e-9 ? `${whole}½` : String(setting);
}

function numberText(row) {
  const brand = config.spreader.split(' ')[0];
  return row.basis === 'tested'
    ? `Spreader: ${brand} #${settingText(row.setting)} (field tested)`
    : `Spreader: ${brand} #${settingText(row.setting)}, start number. Weigh test at first use.`;
}

/**
 * `names`: the catalog name and the line's product name; `lbPer1000`: the rate the line puts down. Returns
 * { spreader, setting, basis, rowLbPer1000, text }, with setting null when no row fits (text says why).
 */
function spreaderSetting({ names, lbPer1000 }) {
  const rows = rowsFor(names);
  const base = { spreader: config.spreader, setting: null, basis: null, rowLbPer1000: null };
  if (!rows.length) return { ...base, text: NO_PRODUCT_NUMBER };
  const rate = Number(lbPer1000);
  const near = rate > 0
    ? rows.map((row) => ({ row, off: Math.abs(row.lbPer1000 - rate) / row.lbPer1000 }))
      .filter(({ off }) => off <= config.rateTolerance)
      .sort((a, b) => a.off - b.off)[0]
    : null;
  if (!near) return { ...base, text: NO_RATE_NUMBER };
  return { ...base, setting: near.row.setting, basis: near.row.basis, rowLbPer1000: near.row.lbPer1000, text: numberText(near.row) };
}

const lineProductName = (raw) => String(raw || '').split(' — ')[0].trim();
const handShaker = (raw) => /hand\s*shaker/i.test(String(raw || ''));
const isLb = (unit) => /^lbs?$/i.test(String(unit || '').trim());

/**
 * The spreader field for one granular line, or null when it does not go on with the spreader (a hand-shaker bait, a
 * product on the no-number list). `rate`/`rateUnit`: the rate the plan puts down; else the line's own lb rate.
 */
function spreaderForLine({ productName, raw, rate, rateUnit }) {
  const names = [productName, lineProductName(raw)];
  if (handShaker(raw) || rowsFor(names, config.noNumber).length) return null;
  const lbPer1000 = isLb(rateUnit) && Number(rate) > 0 ? Number(rate) : lineLbPer1000(raw);
  return spreaderSetting({ names, lbPer1000 });
}

module.exports = { spreaderSetting, spreaderForLine, lineLbPer1000, rowsFor, settingText, NO_RATE_NUMBER, NO_PRODUCT_NUMBER, config };
