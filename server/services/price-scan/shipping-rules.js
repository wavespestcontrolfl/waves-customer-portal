// Pure shipping model for the weekly Price Match scan. The scan compares DELIVERED
// prices (sticker price + shipping to the Lakewood Ranch, FL shop) against the SiteOne
// baseline, so a cheaper sticker price that loses after freight is not an opportunity.
//
// Rules are keyed by vendor HOST and matched like registry.js does: against a PARSED
// hostname (exact or dot-suffix), never a raw substring, so gemplers.com.evil.com or
// gemplers.com@127.0.0.1 can't borrow Gemplers' free-over-$149 rule. A vendor given only
// as a display name (no parseable host anywhere) falls back to the name aliases below.
//
// Source of every rule: ~/lawn-program-scope-20261001/vendor-shipping-access-20261005.md
// (vendor policy pages read 2026-10-05). SiteOne, Veseris and Amazon are free per the
// owner (free for this account). No I/O — unit-tested.
//
//   shippingFor({ vendorHost?, vendor?, vendorName?, price?, quantity?, freeShipping?, hazmat?, weightLb? })
//     weightLb = an actual listing weight in pounds (variant grams); only a real weight, or a
//     quantity in lb/kg/g, lets a weight-table vendor return a firm figure.
//     hazmat = the item is flagged hazardous/DOT (vendors whose rule says hazmat costs extra
//     then return 'estimated', never a firm figure).
//     vendor = a vendor row or scanned candidate (host/url/website/source_url are read);
//     vendorName = display name, used ONLY when no host is available.
//     -> { amount, basis: 'free'|'free_over'|'flat'|'weight_table'|'estimated', note }
//
// 'estimated' means the vendor publishes no rule we can compute (checkout-only
// freight): the amount is a configurable guess and the result stays LABELLED as an
// estimate end to end (compare, email, bell) so the owner knows it is not a quote.

const { parsePackSize, convertToOz } = require('../product-costing');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Env knobs. Read at CALL time (not module load) so a Railway variable change or a test
// override takes effect without a restart/re-require. An unparseable or negative value
// falls back to the default rather than silently zeroing shipping.
const DEFAULT_SHIPPING_USD = 15;
const DEFAULT_BULK_FREIGHT_USD = 25;
function envUsd(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const defaultShippingUsd = () => envUsd('PRICE_SCAN_DEFAULT_SHIPPING_USD', DEFAULT_SHIPPING_USD);
const bulkFreightUsd = () => envUsd('PRICE_SCAN_BULK_FREIGHT_USD', DEFAULT_BULK_FREIGHT_USD);

// A single item at/over this weight (lb) on an 'estimated' host gets the bulk freight
// surcharge — bags that heavy usually ship by freight/LTL, not parcel.
const BULK_FREIGHT_MIN_LB = 40;

// Liquids have no stated weight; treat ~9 lb per gallon (water is 8.3, concentrates ~9+).
const LIQUID_LB_PER_GAL = 9;

// Gemplers' published weight table (gemplers.com/pages/orders-shipping-returns). Each row
// is { upToLb, usd }: the price for a parcel weighing up to that many pounds. The vendor
// publishes bands (0-5, 10-20, 30-40, 40-50, 50-60, 70-80, 90-100) with gaps between
// them; a weight that falls in a gap is charged the NEXT band up, so the gaps are folded
// into the band above (5-10 -> 10-20 price, 20-30 -> 30-40 price, 60-70 -> 70-80, 80-90 -> 90-100).
const GEMPLERS_FREE_OVER_USD = 149;
const GEMPLERS_WEIGHT_TABLE = [
  { upToLb: 5, usd: 10.99 },
  { upToLb: 20, usd: 14.99 },
  { upToLb: 40, usd: 21.99 },
  { upToLb: 50, usd: 26.99 },
  { upToLb: 60, usd: 29.99 },
  { upToLb: 80, usd: 39.99 },
  { upToLb: 100, usd: 49.99 },
];
// Published ceiling for heavy freight ($199.99 at 350-400 lb). Past the table (>100 lb)
// we interpolate linearly up to it and call the result 'estimated'.
const GEMPLERS_TABLE_TOP_LB = 100;
const GEMPLERS_MAX_LB = 400;
const GEMPLERS_MAX_USD = 199.99;

// Vendor rules. `hosts` anchor on the parsed hostname; `names` are display-name aliases
// used ONLY when no host is available (see resolveRule). `type` picks the shipping model.
//   free         -> $0, always
//   free_over    -> Gemplers: $0 at/over the threshold, else the weight table
//   flagged_free -> free only on items the vendor flags; otherwise 'estimated'
//   estimated    -> checkout-only freight; configurable default (+ bulk surcharge)
const RULES = [
  { id: 'siteone', type: 'free', hosts: ['siteone.com'], names: [/site\s*one/i], note: 'free shipping' },
  { id: 'veseris', type: 'free', hosts: ['veseris.com'], names: [/veseris/i], note: 'free shipping' },
  { id: 'amazon', type: 'free', hosts: ['amazon.com'], names: [/amazon/i], note: 'free shipping (account)' },
  { id: 'domyown', type: 'free', hosts: ['domyown.com'], names: [/do\s*my\s*own/i], note: 'free shipping' },
  { id: 'chemicalwarehouse', type: 'free', hosts: ['chemicalwarehouse.com'], names: [/chemical\s*warehouse/i], note: 'free shipping' },
  { id: 'diypestcontrol', type: 'free', hosts: ['diypestcontrol.com'], names: [/diy\s*pest/i], note: 'free shipping' },
  // SeedBarn's store-wide free shipping is a time-limited promo with no end date: never a
  // permanent 'free'. Estimated unless the scanned offer carries a free-shipping flag.
  { id: 'seedbarn', type: 'flagged_free', hosts: ['seedbarn.com'], names: [/seed\s*barn/i], note: 'time-limited promo, recheck', promo: true },
  { id: 'gemplers', type: 'free_over', hosts: ['gemplers.com'], names: [/gemplers/i], threshold: GEMPLERS_FREE_OVER_USD, hazmatExtra: true },
  { id: 'solutions', type: 'flagged_free', hosts: ['solutionsstores.com'], names: [/solutions\s*(pest|stores)/i], note: 'free only on flagged items' },
  { id: 'golfcourselawn', type: 'flagged_free', hosts: ['golfcourselawn.store'], names: [/golf\s*course\s*lawn/i], note: 'free only on flagged items' },
  { id: 'gciturfacademy', type: 'estimated', hosts: ['gciturfacademy.com'], names: [/gci\s*turf/i] },
  { id: 'intermountainturf', type: 'estimated', hosts: ['intermountainturf.com'], names: [/intermountain/i] },
  { id: 'seedworldusa', type: 'estimated', hosts: ['seedworldusa.com'], names: [/seed\s*world/i] },
  { id: 'forestrydistributing', type: 'estimated', hosts: ['forestrydistributing.com'], names: [/forestry\s*distributing/i] },
  { id: 'keystone', type: 'estimated', hosts: ['keystonepestsolutions.com'], names: [/keystone/i] },
];

// The parsed, lowercased hostname of a location string (full URL or scheme-less host), or
// '' when unparseable. Mirrors registry.js hostOf.
function hostOf(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  try { return new URL(s).hostname.toLowerCase(); } catch (e) { /* maybe scheme-less */ }
  try { return new URL(`https://${s}`).hostname.toLowerCase(); } catch (e) { return ''; }
}

const onHost = (h, base) => h === base || h.endsWith(`.${base}`);

// Every location string a caller may have: an explicit vendorHost, then the vendor / scanned
// candidate row's host, url, website and proof link (source_url).
function locationHosts(input) {
  const v = input.vendor || {};
  return [input.vendorHost, v.host, v.vendor_host, v.url, v.website, v.source_url]
    .map(hostOf)
    .filter(Boolean);
}

// The rule for this vendor, or null (-> unknown vendor, 'estimated'). Anchored host match
// first. Name aliases are consulted only when there is NO parseable host at all — a vendor
// that HAS a host which matches nothing must not be rescued by a lookalike display name.
function resolveRule(input, rules) {
  const hosts = locationHosts(input);
  for (const h of hosts) {
    const rule = rules.find((r) => r.hosts.some((base) => onHost(h, base)));
    if (rule) return rule;
  }
  if (hosts.length) return null;
  // Only an explicit vendorName: a candidate's own `name` is the PRODUCT name, never a vendor.
  const name = String(input.vendorName || '');
  if (!name.trim()) return null;
  return rules.find((r) => (r.names || []).some((re) => re.test(name))) || null;
}

// Pack weight in pounds from a quantity string, or null when it isn't a weight/volume we
// can read. Weight units convert directly; volume converts via ~9 lb/gal.
const WEIGHT_UNIT_LB = { lb: 1, pound: 1, oz: 1 / 16, ounce: 1 / 16, g: 0.00220462, gram: 0.00220462, gm: 0.00220462, kg: 2.20462 };
function weightLbFromQuantity(quantity) {
  const pack = parsePackSize(quantity);
  if (!pack || !(pack.amount > 0)) return null;
  if (WEIGHT_UNIT_LB[pack.unit] != null) return pack.amount * WEIGHT_UNIT_LB[pack.unit];
  const oz = convertToOz(pack.amount, pack.unit); // volume -> fl oz
  if (oz == null) return null;
  return (oz / 128) * LIQUID_LB_PER_GAL;
}

// Units that are an actual WEIGHT in the listing text. Plain "oz"/"ounce" is ambiguous (fluid
// or weight ounce) and a volume is converted through a density guess, so neither is firm.
const FIRM_WEIGHT_UNITS = new Set(['lb', 'pound', 'g', 'gram', 'gm', 'kg']);

// { lb, firm } for this item. firm = the weight is a real listing weight: an explicit
// input.weightLb (e.g. the variant's grams) or a quantity stated in lb / kg / g.
function weightInfo(input) {
  const given = Number(input.weightLb);
  if (Number.isFinite(given) && given > 0) return { lb: given, firm: true };
  const lb = weightLbFromQuantity(input.quantity);
  const pack = parsePackSize(input.quantity);
  return { lb, firm: lb != null && !!pack && FIRM_WEIGHT_UNITS.has(pack.unit) };
}

const usd = (n) => `$${round2(n).toFixed(2)}`;

function gemplersTableAmount(weightLb) {
  for (const band of GEMPLERS_WEIGHT_TABLE) if (weightLb <= band.upToLb) return { amount: band.usd, interpolated: false };
  // Past the published bands: straight line from the top band to the published ceiling.
  const span = GEMPLERS_MAX_LB - GEMPLERS_TABLE_TOP_LB;
  const frac = Math.min(1, (weightLb - GEMPLERS_TABLE_TOP_LB) / span);
  const topUsd = GEMPLERS_WEIGHT_TABLE[GEMPLERS_WEIGHT_TABLE.length - 1].usd;
  return { amount: round2(topUsd + frac * (GEMPLERS_MAX_USD - topUsd)), interpolated: true };
}

function estimated(weightLb, baseNote) {
  const base = defaultShippingUsd();
  let amount = base;
  const parts = [`~${usd(base)} est. shipping`];
  if (weightLb != null && weightLb >= BULK_FREIGHT_MIN_LB) {
    const bulk = bulkFreightUsd();
    amount += bulk;
    parts.push(`~${usd(bulk)} est. freight for ${BULK_FREIGHT_MIN_LB} lb+`);
  }
  const note = baseNote ? `${parts.join(' + ')} (${baseNote})` : parts.join(' + ');
  return { amount: round2(amount), basis: 'estimated', note };
}

// Gemplers-style rule: free at/over the threshold, else the published weight table. Hazardous
// (DOT) items carry an extra charge the vendor does not publish ("call"), so neither the
// free-over threshold nor the table is a firm number for them: keep the best published figure
// as the floor, add the default estimate as an allowance for the unpublished hazmat fee, and
// label the whole thing 'estimated' so the email never calls it firm.
function freeOverRule(rule, input, w) {
  const over = Number(input.price) >= rule.threshold;
  const noWeight = w.lb == null;
  const table = noWeight ? null : gemplersTableAmount(w.lb);
  const floor = over || noWeight ? 0 : table.amount;
  if (rule.hazmatExtra && input.hazmat === true) {
    const allowance = defaultShippingUsd();
    const base = over ? `free over ${usd(rule.threshold)}` : (noWeight ? 'weight unknown' : `${usd(floor)} by weight`);
    return { amount: round2(floor + allowance), basis: 'estimated', note: `${base} + ~${usd(allowance)} est. hazmat fee (hazardous item; fee not published)` };
  }
  if (over) return { amount: 0, basis: 'free_over', note: `free shipping over ${usd(rule.threshold)}` };
  if (noWeight) return estimated(null, `weight unknown; under ${usd(rule.threshold)} pays by weight`);
  // Only a real listing weight yields a firm table price; a weight derived from a volume
  // (9 lb/gal) or an ambiguous "oz" keeps the table amount but stays an estimate.
  return {
    amount: table.amount,
    basis: w.firm && !table.interpolated ? 'weight_table' : 'estimated',
    note: `${usd(table.amount)} by weight (~${Math.round(w.lb)} lb${w.firm ? '' : ', weight estimated'}), under ${usd(rule.threshold)}`,
  };
}

function flaggedFreeRule(rule, input, w) {
  if (input.freeShipping !== true) return estimated(w.lb, rule.note);
  return rule.promo
    ? { amount: 0, basis: 'free', promo: true, note: `free shipping (${rule.note})` }
    : { amount: 0, basis: 'free', note: 'free shipping (item flagged free)' };
}

// Rule type -> how the shipping for one item is worked out. An unknown type is 'estimated'.
const RULE_TYPES = {
  free: (rule) => ({ amount: 0, basis: 'free', note: rule.note || 'free shipping' }),
  flat: (rule) => ({ amount: round2(rule.amount), basis: 'flat', note: rule.note || `flat ${usd(rule.amount)} shipping` }),
  free_over: freeOverRule,
  flagged_free: flaggedFreeRule,
  estimated: (rule, input, w) => estimated(w.lb, rule.note),
};

function applyRule(rule, input) {
  return (RULE_TYPES[rule.type] || RULE_TYPES.estimated)(rule, input, weightInfo(input));
}

// opts.rules lets a test (or a future per-vendor override) swap the rule table.
function shippingFor(input = {}, opts = {}) {
  const rules = opts.rules || RULES;
  const rule = resolveRule(input, rules);
  if (!rule) return estimated(weightLbFromQuantity(input.quantity), 'unknown vendor');
  return applyRule(rule, input);
}

// Short human label for an email line / bell: "free shipping", "incl. ~$15.00 est. shipping",
// "incl. $10.99 shipping". Blank when there is nothing to say (no shipping object).
function shippingLabel(shipping) {
  if (!shipping || !Number.isFinite(Number(shipping.amount))) return '';
  const amt = Number(shipping.amount);
  // An estimate stays labelled an estimate even when the configured allowance is $0.
  if (shipping.basis === 'estimated') return `incl. ~${usd(amt)} est. shipping`;
  if (amt === 0) return 'free shipping';
  return `incl. ${usd(amt)} shipping`;
}

// Proof wording for the vendor-facing email: a firm basis (free / published rule) is stated as
// fact; an 'estimated' basis is flagged "shipping estimated" so the rep is never quoted a guess
// as a fact.  "free shipping (firm)", "$10.99 shipping by published rule (firm)",
// "shipping estimated ~$15.00 (not a quote)".
function shippingProofText(shipping) {
  if (!shipping || !Number.isFinite(Number(shipping.amount))) return '';
  const amt = Number(shipping.amount);
  if (shipping.basis === 'estimated') return `shipping estimated ~${usd(amt)} (not a quote)`;
  if (amt === 0) return shipping.promo ? 'free shipping (current promo, recheck)' : 'free shipping (firm)';
  return `${usd(amt)} shipping by published rule (firm)`;
}

// A shipping object a caller attached ({ amount, basis, ... }) -> the same object with a rounded
// amount and a string note, or null when it is not usable. Copies EVERY field (promo, ...), so
// nothing shippingLabel / shippingProofText reads is dropped on the way through.
function normalizeShipping(sh) {
  if (!sh || !Number.isFinite(Number(sh.amount)) || !sh.basis) return null;
  return { ...sh, amount: round2(sh.amount), note: sh.note || '' };
}

module.exports = {
  normalizeShipping,
  shippingFor,
  shippingLabel,
  shippingProofText,
  weightLbFromQuantity,
  resolveRule,
  hostOf,
  RULES,
  GEMPLERS_WEIGHT_TABLE,
  GEMPLERS_FREE_OVER_USD,
  BULK_FREIGHT_MIN_LB,
  LIQUID_LB_PER_GAL,
  DEFAULT_SHIPPING_USD,
  DEFAULT_BULK_FREIGHT_USD,
};
