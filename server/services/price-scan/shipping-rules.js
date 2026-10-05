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
//   shippingFor({ vendorHost?, vendor?, vendorName?, price?, quantity?, specialFreight?, weightLb? })
//     weightLb = an actual listing weight in pounds (variant grams); only a real weight, or a
//     quantity in lb/kg/g, lets a weight-table vendor return a firm figure.
//     specialFreight = the listing carries a hazardous / oversize / truck (or similar) freight
//     tag: the vendor charges extra it does not publish, so the result is 'estimated'.
//     vendor = a vendor row or scanned candidate (host/url/website/source_url are read);
//     vendorName = display name, used ONLY when no host is available.
//     -> { amount, basis: 'free'|'free_over'|'flat'|'weight_table'|'estimated', note }
//
// 'estimated' means the vendor publishes no rule we can compute (checkout-only freight): the
// amount is a configurable guess and the result stays LABELLED as an estimate end to end
// (compare, email, bell) so the owner knows it is not a quote.
//
// FIRM ONLY ON TWO PATHS, nothing else (no page-copy or markup detection of "free shipping"):
//   1. a vendor that ships free on everything (rule type 'free');
//   2. Gemplers' published free-over threshold, or an exact band of its published weight table
//      with a real listing weight and no special-freight tag.

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

// Gemplers' COMPLETE published weight table, transcribed from
// https://gemplers.com/pages/orders-shipping-returns (read 2026-10-05): 17 contiguous bands,
// 0.00-5.00 lb up to 350.01-400.00 lb. Each row is the parcel price for a weight in
// (previous upToLb, upToLb]. The page prints the 200-250 band's lower bound as "200.00" (a typo
// for 200.01); the bands are contiguous, so it is read as 200.01-250.00. No folding, no
// interpolation: a weight above the top band (400 lb) has no published price -> 'estimated'.
// The site banner (same page): "FREE SHIPPING on $149+ orders. Use code FS149 at checkout.
// See Terms & Conditions for exclusions".
const GEMPLERS_FREE_OVER_USD = 149;
const GEMPLERS_WEIGHT_TABLE = [
  { upToLb: 5, usd: 10.99 },
  { upToLb: 10, usd: 11.99 },
  { upToLb: 20, usd: 14.99 },
  { upToLb: 30, usd: 16.99 },
  { upToLb: 40, usd: 21.99 },
  { upToLb: 50, usd: 26.99 },
  { upToLb: 60, usd: 29.99 },
  { upToLb: 70, usd: 32.99 },
  { upToLb: 80, usd: 39.99 },
  { upToLb: 90, usd: 49.99 },
  { upToLb: 100, usd: 59.99 },
  { upToLb: 150, usd: 79.99 },
  { upToLb: 200, usd: 99.99 },
  { upToLb: 250, usd: 125.99 },
  { upToLb: 300, usd: 149.99 },
  { upToLb: 350, usd: 175.99 },
  { upToLb: 400, usd: 199.99 },
];

// Vendor rules. `hosts` anchor on the parsed hostname; `names` are display-name aliases
// used ONLY when no host is available (see resolveRule). `type` picks the shipping model.
//   free         -> $0, always (the vendor ships free on everything)
//   free_over    -> Gemplers: $0 at/over the threshold, else the weight table
//   flat         -> a fixed amount
//   estimated    -> no rule we can compute; configurable default (+ bulk surcharge)
const RULES = [
  { id: 'siteone', type: 'free', hosts: ['siteone.com'], names: [/site\s*one/i], note: 'free shipping' },
  { id: 'veseris', type: 'free', hosts: ['veseris.com'], names: [/veseris/i], note: 'free shipping' },
  { id: 'amazon', type: 'free', hosts: ['amazon.com'], names: [/amazon/i], note: 'free shipping (account)' },
  { id: 'domyown', type: 'free', hosts: ['domyown.com'], names: [/do\s*my\s*own/i], note: 'free shipping' },
  { id: 'chemicalwarehouse', type: 'free', hosts: ['chemicalwarehouse.com'], names: [/chemical\s*warehouse/i], note: 'free shipping' },
  { id: 'diypestcontrol', type: 'free', hosts: ['diypestcontrol.com'], names: [/diy\s*pest/i], note: 'free shipping' },
  // SeedBarn's store-wide free shipping is a time-limited promo with no end date and is not
  // read from the page: plain estimate, with a note to recheck the promo by hand.
  { id: 'seedbarn', type: 'estimated', hosts: ['seedbarn.com'], names: [/seed\s*barn/i], note: 'time-limited promo, recheck' },
  { id: 'gemplers', type: 'free_over', hosts: ['gemplers.com'], names: [/gemplers/i], threshold: GEMPLERS_FREE_OVER_USD },
  { id: 'solutions', type: 'estimated', hosts: ['solutionsstores.com'], names: [/solutions\s*(pest|stores)/i] },
  { id: 'golfcourselawn', type: 'estimated', hosts: ['golfcourselawn.store'], names: [/golf\s*course\s*lawn/i] },
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

// The published band price for a weight, or null above the top band (no published price).
// The table is published to 0.01 lb, so round first: Shopify stores whole grams, and 2268 g
// (a 5 lb bag) converts to 5.000088 lb, which must stay in the 5 lb band.
function gemplersTableAmount(weightLb) {
  const lb = Math.round(weightLb * 100) / 100;
  const band = GEMPLERS_WEIGHT_TABLE.find((b) => lb <= b.upToLb);
  return band ? band.usd : null;
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

// Gemplers-style rule: free at/over the threshold, else the published weight table. FIRM only
// for a clean threshold hit or an exact table band with a real listing weight, and never for an
// item carrying a special-freight tag (hazardous / oversize / truck ...: extra charges the
// vendor does not publish). Everything else keeps the best published figure as the floor, adds
// the default allowance when the figure is incomplete, and is labelled 'estimated'.
function freeOverRule(rule, input, w) {
  const special = input.specialFreight === true;
  const over = Number(input.price) >= rule.threshold;
  if (over && !special) return { amount: 0, basis: 'free_over', note: `free shipping over ${usd(rule.threshold)}` };
  const topUsd = GEMPLERS_WEIGHT_TABLE[GEMPLERS_WEIGHT_TABLE.length - 1].usd;
  const table = w.lb == null ? null : gemplersTableAmount(w.lb);
  if (!over && !special && table != null && w.firm) {
    return { amount: table, basis: 'weight_table', note: `${usd(table)} by weight (~${Math.round(w.lb)} lb)` };
  }
  const floor = over || w.lb == null ? 0 : (table == null ? topUsd : table);
  const notes = [];
  if (over) notes.push(`free over ${usd(rule.threshold)}`);
  else if (w.lb == null) notes.push('weight unknown');
  else if (table == null) notes.push(`${usd(topUsd)} top band; weight over ${GEMPLERS_WEIGHT_TABLE[GEMPLERS_WEIGHT_TABLE.length - 1].upToLb} lb`);
  else notes.push(`${usd(floor)} by weight (~${Math.round(w.lb)} lb${w.firm ? '' : ', weight estimated'})`);
  if (special) notes.push('special freight (hazardous/oversize/truck): extra charge not published');
  const allowance = special || w.lb == null || table == null ? defaultShippingUsd() : 0;
  if (allowance) notes.push(`+ ~${usd(allowance)} est. allowance`);
  return { amount: round2(floor + allowance), basis: 'estimated', note: notes.join('; ') };
}

// Rule type -> how the shipping for one item is worked out. An unknown type is 'estimated'.
const RULE_TYPES = {
  free: (rule) => ({ amount: 0, basis: 'free', note: rule.note || 'free shipping' }),
  flat: (rule) => ({ amount: round2(rule.amount), basis: 'flat', note: rule.note || `flat ${usd(rule.amount)} shipping` }),
  free_over: freeOverRule,
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
  if (amt === 0) return 'free shipping (firm)';
  return `${usd(amt)} shipping by published rule (firm)`;
}

// A shipping object a caller attached ({ amount, basis, ... }) -> the same object with a rounded
// amount and a string note, or null when it is not usable. Copies EVERY field, so
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
