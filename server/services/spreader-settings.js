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

// The lb per 1,000 sq ft a line states, from its first lb rate: { rate } for one rate ("3.1 lb per 1,000 sq ft"; a bed rate
// per 100 sq ft is x 10: the 13-0-13 bed line's "0.75 lb per 100 sq ft" is 7.5, read before its later nitrogen cap of
// "1 lb per 1,000 sq ft"), { range: true } for a range ("1 to 2 lb", "1-2 lb", "1–2 lb": no one rate, so no number), else null.
const LINE_LB = /(\d+(?:\.\d+)?)(\s*(?:to|-|\u2013)\s*\d+(?:\.\d+)?)?\s*lbs?\s*(?:per|\/)\s*(1,?000|100)\s*sq\.?\s*ft/i;
function lineLbRate(raw) {
  const found = LINE_LB.exec(String(raw || ''));
  if (!found) return null;
  if (found[2]) return { range: true };
  return { rate: Math.round(Number(found[1]) * (found[3] === '100' ? 10 : 1) * 1e6) / 1e6 };
}
const lineLbPer1000 = (raw) => lineLbRate(raw)?.rate ?? null;

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
      // Inclusive, with room for float rounding: 2.06 on a 2 lb row is exactly 3%.
      .filter(({ off }) => off <= config.rateTolerance + 1e-9)
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
 * product on the no-number list). `rate`/`rateUnit`: the rate the plan puts down; else the line's own lb rate. A
 * `substituted` line (an approved swap: the recipe text names the original bag) matches only the bag applied, at the rate
 * passed, never the recipe's name or rate.
 */
function spreaderForLine({ productName, raw, rate, rateUnit, substituted = false }) {
  const names = substituted ? [productName] : [productName, lineProductName(raw)];
  if (handShaker(raw) || rowsFor(names, config.noNumber).length) return null;
  const planned = isLb(rateUnit) && Number(rate) > 0 ? Number(rate) : null;
  return spreaderSetting({ names, lbPer1000: planned ?? (substituted ? null : lineLbPer1000(raw)) });
}

module.exports = { spreaderSetting, spreaderForLine, lineLbRate, lineLbPer1000, rowsFor, settingText, NO_RATE_NUMBER, NO_PRODUCT_NUMBER, config };
