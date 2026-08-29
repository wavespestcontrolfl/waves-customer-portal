/**
 * Public services menu — the ONE product list every customer-facing surface
 * renders from (quote-to-estimate alignment C2). Built from the catalog:
 * active, non-archived rows with public_quote_selectable = true.
 *
 * Contract (stable, consumed by the astro site): service_key, name (the
 * catalog name verbatim), family, mode, cadence (recurring rows only),
 * public_instant_quote. Engine keys are NEVER exposed — the portal
 * translates service_key → engine path internally. The admin-maintained
 * services.description is NOT exposed either: it is internal copy that has
 * never passed the customer-facing copy rules (AGENTS.md) — the site keeps
 * its own reviewed product copy keyed by service_key (pre-push codex P1).
 */
const db = require('../models/db');

const FAMILY_LABELS = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  mosquito: 'Mosquito Control',
  tree_shrub: 'Tree & Shrub',
  termite: 'Termite',
  rodent: 'Rodent',
  inspection: 'Inspections',
  specialty: 'Specialty',
};

const CADENCE_LABELS = {
  semiannual: 'Semiannual',
  quarterly: 'Quarterly',
  bimonthly: 'Bi-Monthly',
  every_6_weeks: 'Every 6 Weeks',
  monthly: 'Monthly',
  seasonal_feb_oct: 'Seasonal',
  annual: 'Annual',
};

// Lossless service_key → /api/public/quote/calculate request. A product is
// public_instant_quote ONLY when this map carries the COMPLETE engine
// options that select exactly that product (cadence / tier), so a consumer
// can never pick one catalog product and receive another's price (pre-push
// codex P1). Keys use the vocabularies the engine actually prices:
//   pest.frequency  quarterly | bimonthly | monthly     (no semiannual)
//   lawn.tier       standard | enhanced | premium      (no 4-app basic)
//   mosquito.tier   seasonal9 | monthly12
//   treeShrub.tier  light | standard | enhanced
//   sanitation.tier light | standard | heavy
// Everything absent here is quote-on-request (a keyed lead the office
// estimates). This is a pricing-engine capability, kept in code, and MUST
// stay in step with routes/public-quote.js PUBLIC_QUOTE_SERVICE_KEYS
// (asserted by public-services-menu.test.js). Rodent Inspection is a flat
// $75 (owner ruling 2026-08-29).
const PUBLIC_QUOTE_REQUESTS = Object.freeze({
  pest_general_quarterly: { pest: { frequency: 'quarterly' } },
  pest_general_bimonthly: { pest: { frequency: 'bimonthly' } },
  pest_general_monthly: { pest: { frequency: 'monthly' } },
  one_time_pest_control: { oneTimePest: {} },
  pest_initial_cleanout: { oneTimePest: {} },
  lawn_care_recurring: { lawn: { tier: 'standard' } },
  lawn_care_6week: { lawn: { tier: 'enhanced' } },
  lawn_care_monthly: { lawn: { tier: 'premium' } },
  mosquito_seasonal: { mosquito: { tier: 'seasonal9' } },
  mosquito_monthly: { mosquito: { tier: 'monthly12' } },
  tree_shrub_quarterly: { treeShrub: { tier: 'light' } },
  tree_shrub_program: { treeShrub: { tier: 'standard' } },
  tree_shrub_6week: { treeShrub: { tier: 'enhanced' } },
  rodent_bait_quarterly: { rodentBait: {} },
  rodent_trapping: { rodentTrapping: {} },
  rodent_exclusion_only: { exclusion: {} },
  // Catalog flea_tick is the SINGLE-visit treatment (engine key
  // flea_knockdown_single); the engine's default flea offer is the two-visit
  // package, so the offer is pinned here (pre-push codex P0).
  flea_tick: { flea: { offerKey: 'flea_knockdown_single' } },
  termite_bait: { termite: {} },
  rodent_inspection: { rodentInspection: {} },
});
// Selectable but NOT instant (quote-on-request), because the public engine
// needs inputs the website does not collect or returns a manual line:
//   palm_injection (palm count) · bed_bug_treatment (method) ·
//   dethatching / termite_trenching / termite_slab_pretreat (quote-required
//   lines) · pest_general_semiannual · lawn_care_quarterly · mosquito_one_time ·
//   lawn_care_one_time (manually scoped: fert / weed / insect — the keyed
//   request carries no treatment type) · rodent_sanitation_light/standard/heavy
//   (one engine key covers three rows, so acceptance could stamp no service_id).
//   bee_wasp_removal (species / tier / removal inputs decide $75–$450 of
//   removal the site does not collect) · plugging / top_dressing (spacing /
//   depth options move the price ~4× and the site does not collect them) —
//   both pre-push codex P0.
// The contract test runs every instant key through the engine and requires
// a positive, non-manual line.
const PUBLIC_INSTANT_QUOTE_KEYS = new Set(Object.keys(PUBLIC_QUOTE_REQUESTS));

// Deep copy so a caller can never mutate the canonical request.
function quoteServicesForKey(serviceKey) {
  const req = PUBLIC_QUOTE_REQUESTS[serviceKey];
  return req ? JSON.parse(JSON.stringify(req)) : null;
}

// Visits/year the mapped request selects, for recurring products — the
// catalog row's visits_per_year is admin-editable, so a row whose cadence
// no longer matches its request is NOT advertised or priced as instant
// (pre-push codex P1: the menu and the request must agree).
// [visits/year, catalog frequency] the mapped request selects. Both are
// admin-editable on the row, so both must still agree.
const REQUEST_CADENCE = {
  pest: { quarterly: [4, 'quarterly'], bimonthly: [6, 'bimonthly'], monthly: [12, 'monthly'] },
  lawn: { standard: [6, 'bimonthly'], enhanced: [9, 'every_6_weeks'], premium: [12, 'monthly'] },
  mosquito: { seasonal9: [9, 'seasonal_feb_oct'], monthly12: [12, 'monthly'] },
  treeShrub: { light: [4, 'quarterly'], standard: [6, 'bimonthly'], enhanced: [9, 'every_6_weeks'] },
  rodentBait: [4, 'quarterly'],
  termite: [4, 'quarterly'],
};
function expectedCadenceForRequest(request) {
  if (!request) return null;
  if (request.pest) return REQUEST_CADENCE.pest[request.pest.frequency] ?? null;
  if (request.lawn) return REQUEST_CADENCE.lawn[request.lawn.tier] ?? null;
  if (request.mosquito) return REQUEST_CADENCE.mosquito[request.mosquito.tier] ?? null;
  if (request.treeShrub) return REQUEST_CADENCE.treeShrub[request.treeShrub.tier] ?? null;
  if (request.rodentBait) return REQUEST_CADENCE.rodentBait;
  if (request.termite) return REQUEST_CADENCE.termite;
  return null; // one-time products carry no cadence
}
// True when the catalog row (as it is NOW) still describes the product the
// mapped request prices: recurring rows must match visits/year AND
// frequency; one-time rows must not have become recurring.
function requestMatchesCatalogRow(serviceKey, row) {
  const request = PUBLIC_QUOTE_REQUESTS[serviceKey];
  if (!request || !row) return false;
  const expected = expectedCadenceForRequest(request);
  if (expected == null) return row.billing_type !== 'recurring';
  return Number(row.visits_per_year) === expected[0] && String(row.frequency || '') === expected[1];
}

// Site-supplied options a keyed request may carry — ONLY those the engine
// needs and the website actually collects (grass type for lawn). Everything
// else is fixed by the canonical request.
const LAWN_TRACKS = new Set(['st_augustine', 'bahia', 'bermuda', 'zoysia']);
function mergeKeyedRequestOptions(request, bodyServices) {
  if (!request) return null;
  const out = JSON.parse(JSON.stringify(request));
  const track = String(bodyServices?.lawn?.track || '').toLowerCase();
  if (out.lawn && LAWN_TRACKS.has(track)) out.lawn.track = track;
  return out;
}
function instantForRow(row) {
  return PUBLIC_INSTANT_QUOTE_KEYS.has(row.service_key) && requestMatchesCatalogRow(row.service_key, row);
}

function modeFor(row) {
  if (row.category === 'inspection') return 'inspection';
  return row.billing_type === 'recurring' ? 'recurring' : 'one_time';
}

function menuItem(row) {
  const mode = modeFor(row);
  const item = {
    service_key: row.service_key,
    name: row.name,
    family: FAMILY_LABELS[row.category] || row.category,
    family_key: row.category,
    mode,
    public_instant_quote: instantForRow(row),
  };
  if (mode === 'recurring') {
    item.cadence = {
      key: row.frequency || null,
      label: CADENCE_LABELS[row.frequency] || null,
      visits_per_year: row.visits_per_year == null ? null : Number(row.visits_per_year),
    };
  }
  return item;
}

async function loadPublicServicesMenu(conn = db) {
  if (!(await conn.schema.hasColumn('services', 'public_quote_selectable'))) return [];
  const rows = await conn('services')
    .where({ is_active: true, is_archived: false, public_quote_selectable: true })
    .orderBy([{ column: 'category' }, { column: 'sort_order' }, { column: 'name' }])
    .select('service_key', 'name', 'category', 'billing_type', 'frequency', 'visits_per_year');
  return rows.map(menuItem);
}

// The catalog row a lead-supplied key names — ONLY when it is a product a
// NEW customer may choose; null otherwise. Callers derive the lead's display
// label from `name` so key and label can never disagree (pre-push codex P1:
// serviceKey and serviceInterest are independently attacker-controlled).
async function publicSelectableService(serviceKey, conn = db) {
  if (!serviceKey) return null;
  try {
    if (!(await conn.schema.hasColumn('services', 'public_quote_selectable'))) return null;
    const row = await conn('services')
      .where({ service_key: serviceKey, is_active: true, is_archived: false, public_quote_selectable: true })
      .first('id', 'service_key', 'name', 'billing_type', 'visits_per_year', 'frequency');
    return row ? { service_key: row.service_key, name: row.name, instant: instantForRow(row) } : null;
  } catch {
    // Fail closed to a prose-only lead: a keyed lead must never be created
    // from an unverified key, and a catalog read failure must not fail intake.
    return null;
  }
}

async function isPublicSelectableServiceKey(serviceKey, conn = db) {
  return !!(await publicSelectableService(serviceKey, conn));
}

module.exports = { loadPublicServicesMenu, publicSelectableService, isPublicSelectableServiceKey, quoteServicesForKey, mergeKeyedRequestOptions, requestMatchesCatalogRow, menuItem, PUBLIC_QUOTE_REQUESTS, PUBLIC_INSTANT_QUOTE_KEYS, FAMILY_LABELS };
