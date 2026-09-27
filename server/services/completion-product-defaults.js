/**
 * completion-product-defaults
 *
 * Owner ruling 2026-09-26: the "Complete Service" drawer's product list
 * should start PREFILLED with the visit's default products for any
 * non-lawn service that uses sprays, granules, or baits — "the default
 * products used are Alpine WSG, Gentrol IGR, and the Advion cockroach gel
 * — these need to be defaults".
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
 * `completionDefaultProducts` is a PLAIN ARRAY OF CATALOG NAME STRINGS,
 * nothing else (pre-push audit P2, PR #5049 r1: a seasonal-window shape
 * with per-entry rate/typicalGallons/zone objects was built ahead of any
 * visit using it — an unexercised config contract, which AGENTS.md rules
 * out — and was removed; the rate the completion form prefills always
 * comes from the catalog row's own label default, exactly like a manual
 * "add product" tap). PEST is NOT curated here either (owner ruling
 * 2026-09-27): the general recurring/one-time pest visit keeps its
 * existing house mix on the client — lib/pest-default-mix.js (Taurus SC +
 * Atticus Talak 7.9 F + LESCO 90/10 Nonionic Surfactant, fixed totals). A
 * seasonal pest rotation is a possible LATER PR, built when a visit
 * actually needs it, not ahead of time.
 *
 * Precedence (per visit):
 *   1. protocols.json visit.completionDefaultProducts (curated, ordered)
 *      — today that's pest visit 2 (German roach cleanout) and the
 *      cockroach program's visit 1, both flat roach lists.
 *   2. services.default_products (legacy JSONB name list) — a fallback
 *      for services the owner hasn't curated yet; frequently stale (the
 *      pest_general_* rows still say "Demand CS" / "Advion Gel"), so a
 *      curated list always wins when one exists.
 *   3. empty — no default products, tech starts from a blank list (today's
 *      behavior everywhere else).
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
 * resolveCatalogProductForName): same inputs, same output, no I/O — so the
 * precedence rules are unit-testable without a database.
 * resolveCompletionProductDefaults is the DB-backed orchestrator the route
 * calls; it is fail-soft end to end — any failure (missing row, DB error,
 * malformed default_products) resolves to an empty product list, and a
 * completion can always proceed with no products prefilled.
 */

const { matchServiceProtocol } = require('./protocol-matcher');

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

// Case-insensitive dedupe that preserves first-seen order and casing —
// order matters (it is display order on the completion form).
function dedupeNames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
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
// ordered product NAMES to prefill (before any catalog lookup). Pure:
// given the same protocols.json + inputs, always the same output.
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
    return { programKey, matchedVisit, source: 'excluded_lawn', names: [] };
  }

  const protocolNames = dedupeNames(visit?.completionDefaultProducts);
  if (protocolNames.length) {
    return { programKey, matchedVisit, source: 'protocol_visit', names: protocolNames };
  }

  const fallbackNames = dedupeNames(parseDefaultProductNames(fallbackDefaultProducts));
  if (fallbackNames.length) {
    return { programKey, matchedVisit, source: 'service_default_products', names: fallbackNames };
  }

  return { programKey, matchedVisit, source: 'none', names: [] };
}

// -- line shaping --------------------------------------------------------

function shapeCompletionProductLine(row, resolved) {
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

// The visit's calendar month (1-12) from scheduled_services.scheduled_date
// — a DATE column, no time-of-day. Still used to resolve which VISIT a
// month-keyed program (lawn, tree & shrub) matches — pre-push audit P1:
// building `new Date(value)` and reading it back through an
// America/New_York formatter shifts the month back a day at every
// month/year boundary, because a bare 'YYYY-MM-DD' (or a driver-built Date
// at UTC midnight) reads as UTC midnight, which is still the PREVIOUS day
// in ET. A DATE column has no timezone of its own; read its calendar
// parts directly (string prefix, or getUTCMonth() on the Date the pg
// driver built at UTC midnight) exactly as
// server/services/service-report/recap-payload.js's formatServiceDate
// does, never through an ET conversion.
function monthFromDateColumn(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.getUTCMonth() + 1;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (match) return Number(match[2]);
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCMonth() + 1;
}

function emptyResult(serviceId) {
  return {
    serviceId, programKey: null, matchedVisit: null, source: 'none', products: [], unresolved: [],
  };
}

// The route-facing orchestrator: loads the scheduled service + its
// service_key/service_type/month, resolves the default product NAMES
// (pure, above), then resolves each name to an active catalog row.
// Fail-soft throughout — this must never block a completion: any error
// (missing row, DB error, malformed default_products) resolves to an
// empty product list rather than throwing.
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

    // Month only matters for month-keyed programs (lawn, tree & shrub) —
    // neither carries completionDefaultProducts today, but resolve it
    // correctly anyway so this stays generically right as the owner adds
    // more visits.
    const month = monthFromDateColumn(scheduled.scheduled_date);

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

    if (!resolved.names.length) {
      return {
        serviceId, programKey: resolved.programKey, matchedVisit: resolved.matchedVisit,
        source: resolved.source, products: [], unresolved: [],
      };
    }

    const catalogRows = await loadActiveCatalogWithAliases(db);
    const products = [];
    const unresolved = [];
    for (const name of resolved.names) {
      const row = resolveCatalogProductForName(name, catalogRows);
      if (!row) { unresolved.push(name); continue; }
      products.push(shapeCompletionProductLine(row, resolved));
    }

    return {
      serviceId, programKey: resolved.programKey, matchedVisit: resolved.matchedVisit,
      source: resolved.source, products, unresolved,
    };
  } catch (err) {
    return { ...empty, error: err?.message || 'completion_product_defaults_failed' };
  }
}

module.exports = {
  resolveCompletionDefaultProductNames,
  resolveCatalogProductForName,
  resolveCompletionProductDefaults,
  monthFromDateColumn,
  parseDefaultProductNames,
};
