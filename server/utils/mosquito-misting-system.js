/**
 * The mosquito misting SYSTEM's identity checks — the ONE place that
 * decides "is this the automatic misting system, not the barrier PROGRAM?"
 * and, separately, "should a booking of this identity get NO chemical
 * protocol?" Several call sites each grew their own copy of these checks
 * (Codex P1s on PR #4762's follow-up rounds: estimate-ai-context.js's
 * repo-context loader and estimate-assistant.js's fallback routing on one
 * side, protocol-matcher.js's matchServiceProtocol and job-card.js's
 * addonProgramKey on the other) and drifted from each other — this module
 * is the single source of truth every caller imports instead.
 *
 * Today there is exactly ONE misting-system catalog row/identity:
 * `mosquito_misting_system` (the lead-only design visit — migration
 * 20260924000020, wiki/protocols/mosquito-misting-systems.md covers
 * design, install, and monthly/quarterly maintenance as ONE program run by
 * Waves). Two predicates, deliberately different scopes:
 *
 * - `isMistingSystemService` — "is this about the misting system AT ALL"
 *   (design, install, or maintenance)? Broad on purpose: used to route a
 *   CUSTOMER's question or repo-context lookup to misting-system material
 *   instead of the barrier program's, regardless of which phase of the
 *   product the question is about.
 * - `isMistingDesignConsultation` — "should this booking get NO chemical
 *   protocol, because it is (or reads as) the free design-visit identity"?
 *   Narrower and KEY-FIRST: a present serviceKey decides it alone — only
 *   the exact `mosquito_misting_system` key qualifies, so a FUTURE distinct
 *   catalog row (e.g. `mosquito_misting_install` /
 *   `mosquito_misting_maintenance`) is never silently swept in by name
 *   matching just because it shares "misting system" in its display name.
 *   Only when NO serviceKey is present (a legacy or manually-typed row) does
 *   the name phrase apply — and even then, only when the name does NOT also
 *   read as a distinct install/maintenance/refill identity (see
 *   `isMistingSystemServiceUnconfigured` below).
 * - `isMistingSystemServiceUnconfigured` — a KEYLESS row whose name clearly
 *   names a different phase of the product ("Mosquito Misting System
 *   Install", "… Maintenance", "… Refill") rather than the plain design
 *   identity. There is no live protocols.json program or MATCH_RULES entry
 *   for install/maintenance work (pricing and the install product set are
 *   owner-pending — do not invent one here), so this is neither the design
 *   consultation NOR a barrier match: callers return their own "no
 *   protocol"/"no match" outcome for it (protocol-matcher.js's
 *   `misting_system_service_unconfigured` reason; job-card.js's normal
 *   null-program "no treatment protocol" note) rather than showing barrier
 *   steps. NOTE: bare "Service" is deliberately NOT treated as a
 *   disqualifying qualifier — it is the generic suffix this catalog uses on
 *   every service name (including the current design row's own literal
 *   name, "Mosquito Misting System Service"), not a signal of a distinct
 *   product phase.
 *
 * When a real `mosquito_misting_install` / `mosquito_misting_maintenance`
 * (or similar) catalog key is actually created, it needs its OWN
 * protocols.json program and MATCH_RULES/ADDON_PROGRAMS wiring at that
 * time — it must NOT be pointed at this module's design-consultation
 * suppression, which is specific to the free design-visit identity.
 *
 * Bare "misting" — the barrier program's own "21-day misting" cycle-length
 * copy — and the plain word "mosquito" must NEVER match any predicate here,
 * or an ordinary barrier customer's question would be routed to the
 * misting-system's copy/protocol instead of their own barrier program.
 */

const MISTING_SYSTEM_SERVICE_KEY = 'mosquito_misting_system';
// The catalog rows the converted misting system lives under (migration 20261023100000, misting PR 2a): the one-time install, the
// monthly service plan (12 applications a year) and the per-fill refill add-on. All three are `mosquito_misting_*` keys, so
// isMistingSystemService counts them; none is the free design visit, so isMistingDesignConsultation (exact key) refuses them.
const MISTING_INSTALL_CATALOG_KEY = 'mosquito_misting_install';
const MISTING_SERVICE_CATALOG_KEY = 'mosquito_misting_service';
const MISTING_REFILL_CATALOG_KEY = 'mosquito_misting_refill';

// Durable identity of the misting installation line on an acceptance invoice (stored in invoices.line_items beside description,
// quantity and unit_price; create() spreads unknown keys). The install is one-time money, not annual coverage money: readers that
// slice a prepay invoice across covered visits subtract these lines by this marker, never by a description match.
const MISTING_INSTALL_LINE_KIND = 'misting_installation';
const MISTING_INSTALL_LINE_SERVICE = 'mosquito_misting_installation';

function mistingInstallLine({ description, amount }) {
  return {
    description,
    quantity: 1,
    unit_price: amount,
    kind: MISTING_INSTALL_LINE_KIND,
    service: MISTING_INSTALL_LINE_SERVICE,
  };
}

function isMistingInstallLine(line) {
  return !!line && typeof line === 'object' && line.kind === MISTING_INSTALL_LINE_KIND;
}

// Sum of unit_price x quantity over the install-marked lines of an invoice's line_items (array or JSON string). Cents-rounded.
function mistingInstallLinesTotal(lineItems) {
  let lines = lineItems;
  if (typeof lines === 'string') {
    try { lines = JSON.parse(lines); } catch { return 0; }
  }
  if (!Array.isArray(lines)) return 0;
  const total = lines
    .filter(isMistingInstallLine)
    .reduce((sum, li) => sum + (Number(li.unit_price) || 0) * (Number(li.quantity) || 1), 0);
  return Math.round(total * 100) / 100;
}
// The pricing engine's recurring plan line (GATE_MOSQUITO_MISTING). It is the
// misting SYSTEM's install + plan + refills, so isMistingSystemService counts
// it, but isMistingDesignConsultation does NOT: it is not the free design visit.
const MISTING_ENGINE_SERVICE_KEY = 'mosquito_misting';
// Separator-tolerant: "misting system", "misting-system", "misting_system".
const MISTING_SYSTEM_NAME_PATTERN = /\bmisting[\s_-]+systems?\b/i;
// Words that mark a keyless name as a DIFFERENT phase of the product
// (install/maintenance/refill), not the plain design-visit identity. Bare
// "service" is excluded on purpose — see the module comment above.
const MISTING_SYSTEM_SUBTYPE_QUALIFIER_PATTERN = /\b(install(?:ation|ed|s)?|maint(?:ain\w*|enance)|refill\w*|repair\w*)\b/i;

// ONE predicate for "is this row the misting SYSTEM (the engine's install + plan line and the design-visit family), not the
// barrier mosquito program?". The barrier program's own copy says "misting" ("21-day misting", "mosquito misting"), so a bare
// "misting" is NEVER the system. A row is the system when its KEY is `mosquito_misting` or any `mosquito_misting_*` key, or
// (a name, no key) when it contains the phrase "misting system" or "misting service plan". Every resolver that classifies by
// key or name uses this instead of its own includes('misting').
const MISTING_SYSTEM_KEY_PATTERN = /^mosquito_misting(?:_[a-z0-9_]+)?$/;
const MISTING_SYSTEM_PLAN_NAME_PATTERN = /\bmisting[\s_-]+(?:systems?|service[\s_-]+plans?)\b/i;
function isMistingSystemIdentity(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return false;
  return MISTING_SYSTEM_KEY_PATTERN.test(raw) || MISTING_SYSTEM_PLAN_NAME_PATTERN.test(raw);
}

// The misting SYSTEM identity of a proposal line or program (estimate-proposal.js keeps it through normalization, so the gate and
// the acceptance-pending refusals can still see a priced misting row once staff authors a proposal). Key fields are matched by
// key shape (`mosquito_misting`, `mosquito_misting_installation`, ...) EXCEPT the free design visit `mosquito_misting_system`,
// which is a different identity; text fields only by the engine's own plan phrase or the commercial manual-quote label.
const MISTING_PROPOSAL_KEY_PATTERN = /^mosquito_misting(?!_system$)(?:_[a-z0-9_]+)?$/;
// Work labels: the engine's plan phrase, the commercial manual-quote label, and the canonical hand-booked work labels the
// service normalizer emits ("Mosquito Misting System Installation / Refill / Maintenance"). "Mosquito Misting System Service"
// (the free design visit) is deliberately NOT here.
const MISTING_PROPOSAL_TEXT_PATTERN = /misting\s+service\s+plan|misting\s+system\s*\(commercial\)|misting\s+system\s+(?:refill|maintenance)\b/i;
const MISTING_PROPOSAL_INSTALL_TEXT_PATTERN = /misting\s+system\s+installation\b/i;
function mistingProposalIdentity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const keys = [raw.service, raw.serviceKey, raw.service_key, raw.originalRequestedService, raw.identity, raw.family]
    .map((v) => String(v == null ? '' : v).trim().toLowerCase()).filter(Boolean);
  const hit = keys.find((k) => MISTING_PROPOSAL_KEY_PATTERN.test(k));
  if (hit) return hit.includes('installation') ? 'mosquito_misting_installation' : 'mosquito_misting';
  const text = [raw.label, raw.name, raw.description].map((v) => String(v == null ? '' : v)).join(' ');
  if (MISTING_PROPOSAL_INSTALL_TEXT_PATTERN.test(text)) return 'mosquito_misting_installation';
  if (MISTING_PROPOSAL_TEXT_PATTERN.test(text)) return 'mosquito_misting';
  // The install item the mapper emits is named "<tier label> Installation" (derived from the tier table, never hard-coded), so a
  // fully rebuilt line is still recognized by its text.
  const lowered = text.toLowerCase();
  const { MOSQUITO_MISTING } = require('../services/pricing-engine/constants');
  const installLabels = Object.values(MOSQUITO_MISTING.tiers).map((tier) => `${tier.label} Installation`.toLowerCase());
  return installLabels.some((label) => lowered.includes(label)) ? 'mosquito_misting_installation' : null;
}

// The ONE selection rule for a `services.mosquitoMisting` / `services.mosquito_misting` input, shared by the pricing engine and
// the stored-estimate guards (v1-legacy-mapper), so what the engine prices and what the guard carries can never disagree:
// `true` or a plain object selects the system; anything else (false, 0, '', 'yes', 1, a list, null) does not.
function isMistingSelection(value) {
  return value === true || (value !== null && typeof value === 'object' && !Array.isArray(value));
}

function normalizeServiceKey(serviceKey) {
  return serviceKey ? String(serviceKey).trim().toLowerCase() : '';
}

function matchesMistingSystemName(...values) {
  return values.some((value) => value != null && MISTING_SYSTEM_NAME_PATTERN.test(String(value)));
}

/**
 * Is this about the misting SYSTEM at all (any phase — design, install, or
 * maintenance)? Broad: used for customer-facing routing (AI repo context,
 * the estimate assistant's fallback), never for suppressing a chemical
 * protocol — use `isMistingDesignConsultation` for that.
 *
 * @param {object} input
 * @param {string} [input.serviceKey] - a catalog service_key to check verbatim.
 * @param {string} [input.name] - a service/display name to check for the phrase.
 * @param {string} [input.text] - any other free text (a question, a snippet,
 *   a search term) to check for the phrase.
 * @returns {boolean}
 */
function isMistingSystemService({ serviceKey, name, text } = {}) {
  const key = normalizeServiceKey(serviceKey);
  if (key === MISTING_SYSTEM_SERVICE_KEY || key === MISTING_ENGINE_SERVICE_KEY || MISTING_SYSTEM_KEY_PATTERN.test(key)) return true;
  return matchesMistingSystemName(name, text);
}

/**
 * Should this booking get NO chemical protocol because it is the free
 * design-visit identity? Key-first: a present serviceKey decides it alone
 * (only the exact `mosquito_misting_system` key qualifies — a different,
 * future key never does, regardless of its name). Only a KEYLESS row falls
 * back to the name phrase, and only when the name doesn't also read as a
 * distinct install/maintenance/refill identity (see
 * `isMistingSystemServiceUnconfigured`).
 *
 * @param {object} input
 * @param {string} [input.serviceKey]
 * @param {string} [input.name]
 * @returns {boolean}
 */
function isMistingDesignConsultation({ serviceKey, name } = {}) {
  const key = normalizeServiceKey(serviceKey);
  if (key) return key === MISTING_SYSTEM_SERVICE_KEY;
  return matchesMistingSystemName(name) && !MISTING_SYSTEM_SUBTYPE_QUALIFIER_PATTERN.test(String(name || ''));
}

/**
 * A KEYLESS row whose name reads as a different, not-yet-built phase of the
 * misting system (install/maintenance/refill) — neither the design
 * consultation nor a barrier match. Callers should treat this as "no
 * protocol" through their own normal no-match path (never barrier steps),
 * since there is no live program for it yet.
 *
 * @param {object} input
 * @param {string} [input.serviceKey]
 * @param {string} [input.name]
 * @returns {boolean}
 */
function isMistingSystemServiceUnconfigured({ serviceKey, name } = {}) {
  if (normalizeServiceKey(serviceKey)) return false;
  return matchesMistingSystemName(name) && MISTING_SYSTEM_SUBTYPE_QUALIFIER_PATTERN.test(String(name || ''));
}

module.exports = {
  MISTING_SYSTEM_SERVICE_KEY,
  MISTING_ENGINE_SERVICE_KEY,
  MISTING_INSTALL_CATALOG_KEY,
  MISTING_SERVICE_CATALOG_KEY,
  MISTING_REFILL_CATALOG_KEY,
  MISTING_INSTALL_LINE_KIND,
  MISTING_INSTALL_LINE_SERVICE,
  mistingInstallLine,
  isMistingInstallLine,
  mistingInstallLinesTotal,
  isMistingSystemIdentity,
  isMistingSelection,
  mistingProposalIdentity,
  MISTING_SYSTEM_NAME_PATTERN,
  isMistingSystemService,
  isMistingDesignConsultation,
  isMistingSystemServiceUnconfigured,
};
