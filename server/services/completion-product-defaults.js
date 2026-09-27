/**
 * completion-product-defaults
 *
 * Owner ruling 2026-09-26: the "Complete Service" drawer's product list
 * should start PREFILLED with the visit's default products (label-default
 * rates, tech adjusts) for any non-lawn service that uses sprays, granules,
 * or baits — "the default products used are Alpine WSG, Gentrol IGR, and
 * the Advion cockroach gel — these need to be defaults", extended the same
 * day to the general recurring/one-time pest visit (Taurus SC + Atticus
 * Talak 7.9 F + LESCO 90/10 Nonionic Surfactant).
 *
 * Design pivot (owner, same day): do NOT prefill from every
 * `treatmentApplied` protocol lineMeta hint — a visit can carry several
 * hints (some conditional, some for an inactive product) that were never
 * meant to all land on the form at once. Instead, an explicit,
 * owner-curated `completionDefaultProducts` list lives on the protocol
 * VISIT itself (server/config/protocols.json) and is the first source
 * here. The lineMeta hints stay exactly what they already were — the
 * job-card / protocol-actions tap-to-apply reference — untouched by this
 * module.
 *
 * Owner ruling 2026-09-27 (rotation): a visit's completionDefaultProducts
 * can be either
 *   - a plain array of entries (back-compat — cockroach and pest visit 2
 *     stay this shape: not seasonal), or
 *   - an array of SEASONAL WINDOWS: [{ months: [1,2,3], products: [...] }, …]
 *     — `months` are 1-12 in America/New_York, matched against the
 *     scheduled visit's own month.
 * Either way, each product entry is a plain name string OR an object
 * `{ name, ratePerGal, rateUnit, typicalGallons, zone }` — the protocol
 * (not the catalog) then owns the mix rate/volume. zone is a display hint
 * only ('foundation' | 'band' | 'eaves' | 'spots'), never enforced.
 * Everything here is a DEFAULT, never a validation error — "don't block
 * anything yet" (owner, 2026-09-27).
 *
 * Precedence (per visit):
 *   1. protocols.json visit.completionDefaultProducts (curated, ordered;
 *      seasonal-window-resolved when the visit uses that shape)
 *   2. services.default_products (legacy JSONB name list) — a fallback
 *      for services the owner hasn't curated yet; frequently stale (the
 *      pest_general_* rows still say "Demand CS" / "Advion Gel"), so a
 *      curated list always wins when one exists.
 *   3. empty — no default products, tech starts from a blank list (today's
 *      behavior everywhere else).
 *
 * Taurus SC yearly rotation (owner 2026-09-27, label: 0.06% max 2x per
 * customer per calendar year for perimeter pest): whenever the resolved
 * program is 'pest', this customer's Taurus SC application count for the
 * current calendar year is always computed and returned as
 * `taurusYearCount` (so the drawer can show "Taurus this year: N of 2" as
 * plain info — never a block). At 2 or more, a Taurus SC entry in the
 * resolved product list is swapped for Alpine WSG (10 g/gal x 1 gal,
 * foundation) and a plain-English note is added to `notes`.
 *
 * Lawn is never touched: it already has its own governed protocol-defaults
 * mechanism (lawn-completion-defaults.js / GATE_LAWN_COMPLETION_DEFAULTS)
 * and must not get a second, conflicting one here.
 *
 * A product NAME resolves to an active products_catalog row by: exact
 * name, exact product_aliases alias, then a token-subset match (a legacy
 * shorthand like "Advion Gel" is a token subset of the catalog's current
 * "Advion Cockroach Gel Bait" — see the 2026-07-12 catalog dedupe). A name
 * that resolves to nothing is skipped and reported in `unresolved` — never
 * substituted with a guess.
 *
 * Pure with respect to its resolution logic (resolveCompletionDefaultProductNames,
 * resolveSeasonalProductEntries, applyTaurusYearlySwap, resolveCatalogProductForName):
 * same inputs, same output, no I/O — so the precedence, seasonal, and swap
 * rules are unit-testable without a database. resolveCompletionProductDefaults
 * is the DB-backed orchestrator the route calls; it is fail-soft end to
 * end — any failure (missing row, DB error, malformed default_products)
 * resolves to an empty product list, and a completion can always proceed
 * with no products prefilled.
 */

const { matchServiceProtocol } = require('./protocol-matcher');
const { etParts } = require('../utils/datetime-et');

// -- name parsing / dedupe (pure) --------------------------------------

// services.default_products is a JSONB array of product name strings, but
// can arrive as a JSON string, a comma-separated string, or already an
// array — mirrors admin-projects.js's parseDefaultProductNames.
function parseDefaultProductNames(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = parsed.split(','); }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => String(item || '').trim()).filter(Boolean);
}

// A raw completionDefaultProducts entry is a name string OR an object
// naming the protocol's own mix rate/volume — normalize to one shape so
// every downstream step (dedupe, swap, catalog resolution, line shaping)
// only has one representation to handle.
function normalizeProductEntry(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { name } : null;
  }
  if (typeof raw === 'object') {
    const name = String(raw.name || '').trim();
    if (!name) return null;
    const entry = { name };
    if (Number.isFinite(Number(raw.ratePerGal))) entry.ratePerGal = Number(raw.ratePerGal);
    if (raw.rateUnit) entry.rateUnit = String(raw.rateUnit);
    if (Number.isFinite(Number(raw.typicalGallons))) entry.typicalGallons = Number(raw.typicalGallons);
    if (raw.zone) entry.zone = String(raw.zone);
    return entry;
  }
  return null;
}

// Case-insensitive dedupe by NAME that preserves first-seen order — order
// matters (it is display order on the completion form). Keeps the first
// occurrence's full entry (rate/volume/zone), not just its name.
function dedupeEntries(rawEntries) {
  const seen = new Set();
  const out = [];
  for (const raw of rawEntries || []) {
    const entry = normalizeProductEntry(raw);
    if (!entry) continue;
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// -- seasonal window resolution (pure) ----------------------------------

// True when every element of the list is a seasonal window ({ months,
// products }), the NEW shape a visit's completionDefaultProducts can take
// (owner ruling 2026-09-27) — as opposed to a plain, non-seasonal entry
// list (the shape cockroach and pest visit 2 keep).
function isSeasonalWindowList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => (
    entry && typeof entry === 'object' && Array.isArray(entry.months) && Array.isArray(entry.products)
  ));
}

// Picks the window whose `months` (1-12) includes the visit's own month.
// No match (an unusable month, or a gap in the owner's window coverage)
// returns null — the caller falls through to the services.default_products
// fallback exactly as an empty completionDefaultProducts would.
function resolveSeasonalWindow(windows, month) {
  const m = Number(month);
  if (!Number.isFinite(m)) return null;
  return windows.find((window) => window.months.map(Number).includes(m)) || null;
}

// Resolves a visit's raw completionDefaultProducts (plain list OR seasonal
// windows) down to the entry list that applies for this visit's month.
function resolveRawCompletionDefaultProducts(visit, month) {
  const raw = visit?.completionDefaultProducts;
  if (!Array.isArray(raw) || !raw.length) return [];
  if (isSeasonalWindowList(raw)) {
    const window = resolveSeasonalWindow(raw, month);
    return window ? window.products : [];
  }
  return raw;
}

// -- Taurus SC yearly rotation (pure swap; DB count lives below) --------

const TAURUS_NAME_RE = /^taurus\s*sc$/i;
// Label: 0.06% max 2x per customer per calendar year for perimeter pest.
const TAURUS_LABEL_MAX_PER_YEAR = 2;
// The swap-in entry (owner 2026-09-27) — same shape as any other product
// entry, so it flows through catalog resolution and line shaping unchanged.
const TAURUS_SWAP_ENTRY = { name: 'Alpine WSG', ratePerGal: 10, rateUnit: 'g/gal', typicalGallons: 1, zone: 'foundation' };

// Swaps a Taurus SC entry for Alpine WSG once this customer has hit the
// label's yearly max — pure (the count is passed in, not queried here) so
// the swap rule itself is unit-testable without a database. Never removes
// Taurus if it isn't actually in the list; never blocks — this only ever
// changes what's PREFILLED, per the owner's "don't block anything" ruling.
function applyTaurusYearlySwap(entries, taurusYearCount) {
  if (!Number.isFinite(taurusYearCount) || taurusYearCount < TAURUS_LABEL_MAX_PER_YEAR) {
    return { entries, notes: [] };
  }
  const hasTaurus = (entries || []).some((entry) => TAURUS_NAME_RE.test(entry.name));
  if (!hasTaurus) return { entries, notes: [] };
  const swapped = entries.map((entry) => (TAURUS_NAME_RE.test(entry.name) ? { ...TAURUS_SWAP_ENTRY } : entry));
  return {
    entries: swapped,
    notes: [`Taurus SC used ${taurusYearCount}× this year (label max ${TAURUS_LABEL_MAX_PER_YEAR}× at 0.06%) — Alpine WSG prefilled instead`],
  };
}

// -- catalog name resolution (pure) ------------------------------------

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function nameTokens(value) {
  return normalizeName(value).split(' ').filter((token) => token.length >= 2);
}

// Resolves a protocol/default-products NAME to one active catalog row.
// Exact name → exact alias → token-subset (every token of the requested
// name is a token of the candidate's own name), tightest candidate wins.
// Never returns a guess: an anchor-less or ambiguous name returns null and
// the caller reports it unresolved.
function resolveCatalogProductForName(name, catalogRows = []) {
  const target = normalizeName(name);
  if (!target || !Array.isArray(catalogRows) || !catalogRows.length) return null;

  const exact = catalogRows.find((row) => normalizeName(row.name) === target);
  if (exact) return exact;

  const aliasHit = catalogRows.find((row) => (row.aliases || [])
    .some((alias) => normalizeName(alias) === target));
  if (aliasHit) return aliasHit;

  const targetTokens = nameTokens(name);
  if (!targetTokens.length) return null;
  // Require at least one distinctive (4+ char) token so a bare short word
  // ("Gel", "CS") can't token-subset-match half the catalog.
  const anchored = targetTokens.some((token) => token.length >= 4);
  if (!anchored) return null;

  const candidates = catalogRows
    .map((row) => ({ row, tokens: new Set(nameTokens(row.name)) }))
    .filter(({ tokens }) => targetTokens.every((token) => tokens.has(token)));
  if (!candidates.length) return null;
  // Prefer the tightest superset (fewest extra tokens) so a short legacy
  // name doesn't grab an unrelated longer product sharing one word.
  candidates.sort((a, b) => a.tokens.size - b.tokens.size);
  return candidates[0].row;
}

// -- visit resolution + precedence (pure) ------------------------------

// Resolves which protocol visit a service maps to and, from it, the
// ordered product ENTRIES to prefill (before any catalog lookup or the
// Taurus swap, which needs a DB count and runs in the orchestrator below).
// Pure: given the same protocols.json + inputs, always the same output.
function resolveCompletionDefaultProductNames({
  protocols, serviceType, serviceKey = null, month = null, fallbackDefaultProducts = null,
} = {}) {
  let match = null;
  try {
    match = matchServiceProtocol(protocols, serviceType, { serviceKey, month });
  } catch {
    match = null;
  }
  const programKey = match?.programKey || null;
  const visit = match?.matchedVisit || null;
  const matchedVisit = { visit: visit?.visit ?? null, reason: match?.reason || null, matched: !!match?.matched };

  // Lawn already has its own governed completion-defaults mechanism
  // (lawn-completion-defaults.js) — this resolver must never seed a
  // second, conflicting product list for it.
  if (programKey === 'lawn') {
    return { programKey, matchedVisit, source: 'excluded_lawn', entries: [], names: [] };
  }

  let entries;
  try {
    entries = dedupeEntries(resolveRawCompletionDefaultProducts(visit, month));
  } catch {
    entries = [];
  }
  if (entries.length) {
    return { programKey, matchedVisit, source: 'protocol_visit', entries, names: entries.map((e) => e.name) };
  }

  const fallbackEntries = dedupeEntries(parseDefaultProductNames(fallbackDefaultProducts));
  if (fallbackEntries.length) {
    return {
      programKey, matchedVisit, source: 'service_default_products',
      entries: fallbackEntries, names: fallbackEntries.map((e) => e.name),
    };
  }

  return { programKey, matchedVisit, source: 'none', entries: [], names: [] };
}

// -- line shaping --------------------------------------------------------

// A "/gal" rate is a per-gallon mix concentration (matches
// client/src/lib/product-rate-prefill.js's isPerGallonUnit convention) —
// the base unit for a recorded amount is whatever precedes the "/".
function baseUnitFromRateUnit(rateUnit) {
  const unit = String(rateUnit || '');
  return unit.includes('/') ? unit.split('/')[0] : unit || null;
}

function shapeCompletionProductLine(entry, row, resolved) {
  // The protocol's own rate/volume (owner 2026-09-27) overrides the
  // catalog's label default when the entry supplies one — the protocol,
  // not the catalog, owns our mix. Round to 4 decimals, matching the
  // client's own derivedTankTotal precision.
  const hasExplicitRate = Number.isFinite(entry.ratePerGal);
  const amount = hasExplicitRate && Number.isFinite(entry.typicalGallons)
    ? Math.round(entry.ratePerGal * entry.typicalGallons * 10000) / 10000
    : null;
  return {
    id: row.id,
    name: row.name,
    category: row.category || null,
    formulation: row.formulation || null,
    defaultRatePer1000: row.default_rate_per_1000 ?? null,
    rateUnit: row.rate_unit || null,
    defaultRate: row.default_rate ?? null,
    defaultUnit: row.default_unit || null,
    applicationMethod: row.application_method || null,
    epaRegNumber: row.epa_reg_number || null,
    // Protocol-specified mix (owner 2026-09-27) — the protocol, not the
    // catalog, owns the rate/volume when it names one; all null when the
    // entry is a plain name (cockroach, pest visit 2), so the client falls
    // back to the catalog's own label-default prefill exactly as before.
    protocolRate: hasExplicitRate ? entry.ratePerGal : null,
    protocolRateUnit: hasExplicitRate ? (entry.rateUnit || null) : null,
    protocolAmount: amount,
    protocolAmountUnit: amount != null ? baseUnitFromRateUnit(entry.rateUnit) : null,
    // Display hint only ('foundation' | 'band' | 'eaves' | 'spots' | null)
    // — never validated or enforced.
    zone: entry.zone || null,
    // Where the name came from — the curated protocol list or the legacy
    // service default_products fallback — for client display/telemetry.
    source: {
      programKey: resolved.programKey,
      visit: resolved.matchedVisit?.visit ?? null,
      origin: resolved.source,
    },
  };
}

// Active catalog rows + their product_aliases, shaped for
// resolveCatalogProductForName. Mirrors admin-protocols.js's
// getProtocolProducts (aliases are what let shorthand protocol names
// resolve), trimmed to the columns this resolver's output needs.
async function loadActiveCatalogWithAliases(db) {
  const rows = await db('products_catalog')
    .where(function activeProducts() {
      this.where({ active: true }).orWhereNull('active');
    })
    .select(
      'id', 'name', 'category', 'formulation', 'application_method',
      'default_rate_per_1000', 'rate_unit', 'default_rate', 'default_unit', 'epa_reg_number',
    )
    .catch(() => []);
  if (!rows.length) return rows;

  const productIds = rows.map((row) => row.id).filter(Boolean);
  const aliasRows = productIds.length
    ? await db('product_aliases').whereIn('product_id', productIds).select('product_id', 'alias_name').catch(() => [])
    : [];
  const aliasesByProduct = aliasRows.reduce((acc, row) => {
    if (!acc[row.product_id]) acc[row.product_id] = [];
    acc[row.product_id].push(row.alias_name);
    return acc;
  }, {});

  return rows.map((row) => ({ ...row, aliases: aliasesByProduct[row.id] || [] }));
}

// This customer's Taurus SC application count for the current calendar
// year (ET), excluding termite/pre-slab/trench services (Taurus's OWN
// perimeter-pest label rotation is a separate count from whatever a
// termite tech applies) — service_products has no product_id column
// (verified against every migration that touches the table), so the match
// is by name, matching how every completion writes it (product_name is
// always the catalog row's exact name at the time of completion).
// Fail-soft: any DB error resolves to 0, never blocks or throws.
async function countTaurusApplicationsThisYear(db, customerId, { asOfDate = new Date() } = {}) {
  if (!db || !customerId) return 0;
  try {
    const { year } = etParts(asOfDate);
    const result = await db('service_products as sp')
      .join('service_records as sr', 'sr.id', 'sp.service_record_id')
      .where('sr.customer_id', customerId)
      .whereRaw('lower(sp.product_name) = ?', ['taurus sc'])
      .whereRaw('extract(year from sr.service_date) = ?', [year])
      .whereRaw("sr.service_type !~* ?", ['termite|pre-?slab|trench'])
      .count('* as count')
      .first()
      .catch(() => ({ count: 0 }));
    return Number(result?.count || 0);
  } catch {
    return 0;
  }
}

function emptyResult(serviceId) {
  return {
    serviceId, programKey: null, matchedVisit: null, source: 'none', products: [], unresolved: [],
  };
}

// The route-facing orchestrator: loads the scheduled service + its
// service_key/service_type/month, resolves the default product ENTRIES
// (pure, above; seasonal-window-resolved for this visit's month), applies
// the Taurus SC yearly rotation for pest visits (needs a DB count, so it
// can't live in the pure resolver), then resolves each entry to an active
// catalog row. Fail-soft throughout — this must never block a completion:
// any error (missing row, DB error, malformed default_products) resolves
// to an empty product list rather than throwing.
async function resolveCompletionProductDefaults({ db, serviceId, protocols } = {}) {
  const empty = emptyResult(serviceId);
  if (!db || !serviceId) return empty;
  try {
    const scheduled = await db('scheduled_services')
      .where({ id: serviceId })
      .first('id', 'customer_id', 'service_id', 'service_type', 'service_key_snapshot', 'scheduled_date');
    if (!scheduled) return empty;

    const serviceRow = scheduled.service_id
      ? await db('services').where({ id: scheduled.service_id }).first('id', 'default_products').catch(() => null)
      : null;

    // The visit's OWN month (ET) — both for month-keyed programs (lawn,
    // tree & shrub — neither carries completionDefaultProducts today) and
    // for a seasonal completionDefaultProducts window (pest visit 1).
    const month = scheduled.scheduled_date ? etParts(new Date(scheduled.scheduled_date)).month : null;

    const resolved = resolveCompletionDefaultProductNames({
      // Lazy require keeps this module free of a hard load-time dependency
      // on the config file for callers that pass their own (e.g. tests
      // with synthetic protocols).
      protocols: protocols || require('../config/protocols.json'),
      serviceType: scheduled.service_type,
      serviceKey: scheduled.service_key_snapshot || null,
      month,
      fallbackDefaultProducts: serviceRow?.default_products,
    });

    // Always surfaced for a pest-program visit (owner 2026-09-27), whether
    // Taurus is even in this window or not — the drawer shows "Taurus this
    // year: N of 2" as plain info regardless.
    let taurusYearCount = null;
    let entries = resolved.entries;
    let notes = [];
    if (resolved.programKey === 'pest') {
      taurusYearCount = await countTaurusApplicationsThisYear(db, scheduled.customer_id);
      ({ entries, notes } = applyTaurusYearlySwap(entries, taurusYearCount));
    }

    if (!entries.length) {
      return {
        serviceId, programKey: resolved.programKey, matchedVisit: resolved.matchedVisit,
        source: resolved.source, products: [], unresolved: [], taurusYearCount, notes,
      };
    }

    const catalogRows = await loadActiveCatalogWithAliases(db);
    const products = [];
    const unresolved = [];
    const seenProductIds = new Set();
    for (const entry of entries) {
      const row = resolveCatalogProductForName(entry.name, catalogRows);
      if (!row) { unresolved.push(entry.name); continue; }
      // Two entries (e.g. the Taurus-swap Alpine WSG and the window's own
      // Alpine WSG line) can resolve to the SAME catalog row — one line on
      // the drawer, not two. First occurrence wins (the swap replaces
      // Taurus's position, so it's already ahead of any later duplicate).
      if (seenProductIds.has(row.id)) continue;
      seenProductIds.add(row.id);
      products.push(shapeCompletionProductLine(entry, row, { ...resolved, entries }));
    }

    return {
      serviceId, programKey: resolved.programKey, matchedVisit: resolved.matchedVisit,
      source: resolved.source, products, unresolved, taurusYearCount, notes,
    };
  } catch (err) {
    return { ...empty, error: err?.message || 'completion_product_defaults_failed' };
  }
}

module.exports = {
  resolveCompletionDefaultProductNames,
  resolveCatalogProductForName,
  resolveCompletionProductDefaults,
  resolveSeasonalWindow,
  isSeasonalWindowList,
  applyTaurusYearlySwap,
  countTaurusApplicationsThisYear,
  parseDefaultProductNames,
};
