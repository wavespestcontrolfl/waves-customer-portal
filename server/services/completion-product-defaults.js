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
 * module, except for one addition (below): a lineMeta line whose
 * catalogProductHints names a curated default can also carry
 * `completionApplicationMethod`, which this resolver hands back per
 * product so the seed can override the catalog's own inferred method.
 *
 * `completionDefaultProducts` contains catalog names. T&S entries also
 * carry a treeShrubKey for due-history and dose-selection rules; they
 * never prescribe a quantity. Other services use the catalog's defaults
 * exactly like a manual "add product" tap. PEST is NOT curated here (owner ruling
 * 2026-09-27): the general recurring/one-time pest visit keeps its
 * existing house mix on the client — lib/pest-default-mix.js (Taurus SC +
 * Atticus Talak 7.9 F + LESCO 90/10 Nonionic Surfactant, fixed totals). A
 * seasonal pest rotation is a possible LATER PR, built when a visit
 * actually needs it, not ahead of time.
 *
 * Application method (Codex r2, PR #5049): Alpine WSG and Gentrol IGR
 * carry no products_catalog.application_method, so the client's own
 * defaultApplicationMethodForLine infers 'perimeter_spray' for them by
 * default — wrong for the German-roach protocol, which applies both
 * INSIDE (crack-and-crevice / IGR point-source), and 'perimeter_spray'
 * demands linear footage the tech never measured for an interior
 * placement. The visit's own lineMeta already carries scope: 'interior'
 * for these lines; `completionApplicationMethod` on that same lineMeta
 * entry (one of the drawer's own method dropdown values — see the
 * `<select>` in SchedulePage.jsx's Products Applied section) is the fix:
 * exercised protocol data, not a new free-form schema. Advion Cockroach
 * Gel Bait already resolves correctly (category 'Bait' -> bait_placement
 * via the catalog's own category match) but carries the key too, for
 * consistency and in case a future catalog edit blanks its category.
 *
 * Precedence (per visit):
 *   1. protocols.json visit.completionDefaultProducts (curated, ordered)
 *      — today only the cockroach program's visit 1 (German roach
 *      cleanout), a flat roach list. The pest program has none: it is
 *      prefilled by pest-default-mix.js (owner ruling 2026-09-27).
 *   2. empty — no curated list, tech starts from a blank list (today's
 *      behavior everywhere else; also lawn, which is always excluded).
 *      There is deliberately no services.default_products fallback here
 *      (Codex r2 P2): the client only ever seeds source 'protocol_visit'
 *      (lib/protocol-completion-defaults.js), so a second, unreachable
 *      source was dead code — removed rather than kept "just in case".
 *
 * Lawn is never touched: it already has its own governed protocol-defaults
 * mechanism (lawn-completion-defaults.js / GATE_LAWN_COMPLETION_DEFAULTS)
 * and must not get a second, conflicting one here.
 *
 * Follow-up visits (Codex r3 P1, PR #5049): POST /:serviceId/schedule-
 * followup books a follow-up child by copying its source visit's
 * service_type verbatim and marking it ONLY with scheduled_services.
 * followup_source_service_id — the usual text/service-key matching alone
 * would resolve it back to the SOURCE visit (a cockroach follow-up matches
 * "cockroach"/"roach" just like the initial cleanout). When a scheduled
 * service carries that column, resolveCompletionDefaultProductNames is
 * called with isFollowup: true, which overrides the resolved visit to the
 * matched program's own follow-up visit (found from protocol-matcher's
 * rule table, never a hard-coded visit number) — today that is only
 * cockroach visit 3, which carries no completionDefaultProducts and so
 * resolves to source 'none', never the visit-1 cleanout mix.
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
 * calls; it is fail-soft end to end — any failure (missing row, DB error)
 * resolves to an empty product list, and a completion can always proceed
 * with no products prefilled.
 */

const { matchServiceProtocol, MATCH_RULES } = require('./protocol-matcher');
const { gateEnvValue } = require('../config/feature-gates');
const { filterTreeShrubDefaults } = require('./tree-shrub-completion-defaults');

// -- name parsing / dedupe (pure) --------------------------------------

// Preserve order and the T&S identity needed by history/dose checks.
function dedupeEntries(rawEntries) {
  const seen = new Set();
  const out = [];
  for (const raw of rawEntries || []) {
    const name = String(typeof raw === 'string' ? raw : raw?.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, ...(raw?.treeShrubKey ? { treeShrubKey: String(raw.treeShrubKey) } : {}) });
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
function resolveCatalogProductForName(name, catalogRows = [], { exactOnly = false } = {}) {
  const target = normalizeName(name);
  if (!target || !Array.isArray(catalogRows) || !catalogRows.length) return null;

  if (exactOnly) {
    const matches = catalogRows.filter(row => normalizeName(row.name) === target ||
      (row.aliases || []).some(alias => normalizeName(alias) === target));
    return matches.length === 1 ? matches[0] : null;
  }

  const exact = catalogRows.filter((row) => normalizeName(row.name) === target);
  if (exact.length) return exact.length === 1 ? exact[0] : null;

  const aliasHits = catalogRows.filter((row) => (row.aliases || [])
    .some((alias) => normalizeName(alias) === target));
  if (aliasHits.length) return aliasHits.length === 1 ? aliasHits[0] : null;

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
  if (candidates[1]?.tokens.size === candidates[0].tokens.size) return null;
  return candidates[0].row;
}

// -- lineMeta application-method lookup (pure) --------------------------

// The lineMeta entry whose catalogProductHints names this product is the
// visit's own record of how it's actually applied there (scope +
// completionApplicationMethod) — a name can appear in more than one
// line's hints (rare), so the FIRST line naming it wins, matching
// dedupeEntries' own first-seen rule.
function completionApplicationMethodForName(visit, name) {
  const lineMeta = visit?.lineMeta;
  if (!lineMeta || typeof lineMeta !== 'object') return null;
  const target = normalizeName(name);
  if (!target) return null;
  for (const meta of Object.values(lineMeta)) {
    if (!meta || !Array.isArray(meta.catalogProductHints)) continue;
    if (!meta.catalogProductHints.some((hint) => normalizeName(hint) === target)) continue;
    return typeof meta.completionApplicationMethod === 'string' && meta.completionApplicationMethod
      ? meta.completionApplicationMethod
      : null;
  }
  return null;
}

// -- visit resolution + precedence (pure) ------------------------------

// The program's own follow-up rule, resolved from protocol-matcher's rule
// table rather than a hard-coded visit number (Codex r3 P1, PR #5049):
// MATCH_RULES carries exactly one `_followup`-reasoned rule for a program
// that has a follow-up stage today (bed_bug_followup, cockroach_followup,
// rodent_followup, palm_followup) — a program with none (pest, mosquito,
// termite, tree & shrub) returns null and the caller's normal text-matched
// visit stands. Tracks protocols.json/protocol-matcher.js as programs and
// visit numbers change, instead of hard-coding "cockroach visit 3".
function followupRuleForProgram(programKey) {
  if (!programKey) return null;
  return MATCH_RULES.find((rule) => rule.programKey === programKey && /_followup$/.test(rule.reason || '')) || null;
}

function findVisitByNumber(program, visitNumber) {
  return (program?.visits || []).find((visit) => Number(visit.visit) === Number(visitNumber)) || null;
}

// Applies the isFollowup override (see resolveCompletionDefaultProductNames'
// own doc above) to a raw matchServiceProtocol result, isolated from the
// precedence logic below so each stays independently readable.
function resolveEffectiveVisit(match, programKey, isFollowup) {
  const visit = match?.matchedVisit || null;
  const matchReason = match?.reason || null;
  const matched = !!match?.matched;
  if (!isFollowup || !programKey || !match?.program) return { visit, matchReason, matched };
  const rule = followupRuleForProgram(programKey);
  const followupVisit = rule ? findVisitByNumber(match.program, rule.visit) : null;
  if (!followupVisit) return { visit, matchReason, matched };
  return { visit: followupVisit, matchReason: rule.reason, matched: true };
}

// Resolves which protocol visit a service maps to and, from it, the
// ordered product NAMES to prefill (before any catalog lookup), plus each
// name's protocol-specified application method (methodsByName, keyed
// lower-case). Pure: given the same protocols.json + inputs, always the
// same output.
//
// isFollowup (Codex r3 P1, PR #5049): a follow-up visit booked through
// POST /:serviceId/schedule-followup copies its source visit's
// service_type verbatim and is marked ONLY by scheduled_services.
// followup_source_service_id — text matching alone resolves it back to the
// SOURCE visit (a booked follow-up to "Cockroach Control Service" matches
// visit 1's own terms, never visit 3's "roach follow"/"roach recheck"
// wording, since its service_type carries neither). When true, and the
// matched program has its own follow-up visit (followupRuleForProgram),
// this overrides the resolved visit to THAT visit instead — today that is
// cockroach visit 3, which carries no completionDefaultProducts, so it
// resolves to source 'none' (a deliberate "nothing curated for a
// follow-up yet", never the cleanout mix a fresh initial visit gets).
function resolveCompletionDefaultProductNames({
  protocols, serviceType, serviceKey = null, month = null, isFollowup = false,
} = {}) {
  let match = null;
  try {
    match = matchServiceProtocol(protocols, serviceType, { serviceKey, month });
  } catch {
    match = null;
  }
  const programKey = match?.programKey || null;
  const { visit, matchReason, matched } = resolveEffectiveVisit(match, programKey, isFollowup);
  const matchedVisit = { visit: visit?.visit ?? null, reason: matchReason, matched };

  // Lawn already has its own governed completion-defaults mechanism
  // (lawn-completion-defaults.js) — this resolver must never seed a
  // second, conflicting product list for it.
  if (programKey === 'lawn') {
    return { programKey, matchedVisit, source: 'excluded_lawn', entries: [], names: [], methodsByName: {} };
  }

  const entries = dedupeEntries(visit?.completionDefaultProducts);
  const protocolNames = entries.map(entry => entry.name);
  if (protocolNames.length) {
    const methodsByName = {};
    for (const name of protocolNames) {
      const method = completionApplicationMethodForName(visit, name);
      if (method) methodsByName[name.toLowerCase()] = method;
    }
    return { programKey, matchedVisit, source: 'protocol_visit', entries, names: protocolNames, methodsByName };
  }

  return { programKey, matchedVisit, source: 'none', entries: [], names: [], methodsByName: {} };
}

// -- line shaping --------------------------------------------------------

function shapeCompletionProductLine(row, resolved, name) {
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
    // The protocol visit's own method for this line (e.g. Alpine WSG's
    // crack-and-crevice work -> 'spot_treatment') — overrides the client's
    // catalog-inferred default, which otherwise falls to 'perimeter_spray'
    // for a product with no catalog application_method and wrongly
    // demands linear footage for an interior placement. null when the
    // lineMeta names none (the catalog's own default_application_method
    // — or the client's own inference — applies unchanged).
    completionApplicationMethod: resolved.methodsByName?.[String(name || '').toLowerCase()] || null,
    epaRegNumber: row.epa_reg_number || null,
    // Where the name came from — always the curated protocol list today
    // (source: 'protocol_visit') — for client display/telemetry.
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
// (missing row, DB error) resolves to an empty product list rather than
// throwing.
async function resolveCompletionProductDefaults({ db, serviceId, protocols } = {}) {
  const empty = emptyResult(serviceId);
  if (!db || !serviceId) return empty;
  try {
    const scheduled = await db('scheduled_services')
      .where({ id: serviceId })
      .first(
        'id', 'customer_id', 'property_id', 'service_id', 'service_type', 'service_key_snapshot',
        'scheduled_date', 'followup_source_service_id',
      );
    if (!scheduled) return empty;

    // Month selects the visit in month-keyed programs such as T&S.
    const month = monthFromDateColumn(scheduled.scheduled_date);

    const resolved = resolveCompletionDefaultProductNames({
      // Lazy require keeps this module free of a hard load-time dependency
      // on the config file for callers that pass their own (e.g. tests
      // with synthetic protocols).
      protocols: protocols || require('../config/protocols.json'),
      serviceType: scheduled.service_type,
      serviceKey: scheduled.service_key_snapshot || null,
      month,
      // A row this IS a follow-up child of (Codex r3 P1, PR #5049) — see
      // resolveCompletionDefaultProductNames' own isFollowup doc above.
      isFollowup: !!scheduled.followup_source_service_id,
    });

    let holds = [];
    if (resolved.programKey === 'tree_shrub') {
      if (!gateEnvValue('GATE_TREE_SHRUB_FIELD_GUIDE')) return { ...empty, programKey: 'tree_shrub' };
      // Legacy service defaults are not reviewed T&S treatment choices.
      if (resolved.source !== 'protocol_visit') return { ...empty, programKey: 'tree_shrub' };
      const applicable = await filterTreeShrubDefaults({ db, scheduled, entries: resolved.entries });
      resolved.entries = applicable.entries;
      holds = applicable.holds;
    }

    if (!resolved.entries.length) {
      return {
        serviceId, programKey: resolved.programKey, matchedVisit: resolved.matchedVisit,
        source: resolved.source, products: [], unresolved: [], holds,
      };
    }

    const catalogRows = await loadActiveCatalogWithAliases(db);
    const products = [];
    const unresolved = [];
    const seenProductIds = new Set();
    for (const entry of resolved.entries) {
      const row = resolveCatalogProductForName(entry.name, catalogRows, { exactOnly: Boolean(entry.treeShrubKey) });
      if (!row) { unresolved.push(entry.name); continue; }
      // Two entries resolving to the SAME catalog row show one line on the
      // drawer, not two — first occurrence wins.
      if (seenProductIds.has(row.id)) continue;
      seenProductIds.add(row.id);
      products.push({ ...shapeCompletionProductLine(row, resolved, entry.name),
        ...(entry.treeShrubKey ? { treeShrubKey: entry.treeShrubKey, requiresDoseSelection: true } : {}),
      });
    }

    return {
      serviceId, programKey: resolved.programKey, matchedVisit: resolved.matchedVisit,
      source: resolved.source, products, unresolved, holds,
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
};
