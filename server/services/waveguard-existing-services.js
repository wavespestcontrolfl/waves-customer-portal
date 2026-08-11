// ============================================================
// waveguard-existing-services.js
//
// Single source of truth for "what WaveGuard-qualifying recurring services
// does this customer already have?" — shared by:
//   - admin-estimate-persistence.js, to reprice a linked customer's estimate
//     at the COMBINED tier (so the charged total honors membership), and
//   - estimate-membership-context.js, to render the membership card.
//
// Keeping the query + key-mapping here guarantees the displayed tier and the
// charged tier are derived from the same rows and can never disagree.
// ============================================================

// Statuses that mean a scheduled visit is not live, active coverage.
// 'rescheduled' is a phantom row the customer-portal reschedule flow leaves in
// place until SmartRebooker actions it (see admin-schedule.js), so it must not
// count toward coverage/tier.
const TERMINAL_STATUSES = ['cancelled', 'completed', 'no_show', 'skipped', 'rescheduled'];

// Tier values that do NOT represent an active WaveGuard plan membership.
// Mirrors hasMembership() in routes/admin-customers.js (the same logic the
// admin "No Plan" badge reads) so the estimate flow and the admin UI agree on
// who counts as a member.
const NON_MEMBERSHIP_TIER_KEYS = new Set(['none', 'onetime', 'na', 'no', 'notset', 'commercial']);

function membershipTierKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// A customer is an actual WaveGuard plan member only when their record carries
// a membership tier (Bronze/Silver/Gold/Platinum) — NOT merely because they
// have a scheduled visit. Note (owner directive 2026-07-28): customers with
// UPCOMING recurring qualifying services now get a tier stamped automatically
// (self-booking-plan-sync enrollment path + nightly reconcile, behind
// GATE_AUTO_WAVEGUARD_TIER), so "recurring but tierless" is a transient state
// rather than a policy. Until that stamp lands, such a customer is still
// "No Plan" here and is treated as a new customer for the WaveGuard setup fee
// + annual-prepay decisions.
function isMembershipCustomerRow(customer = {}) {
  const tierKey = membershipTierKey(customer.waveguard_tier ?? customer.tier);
  if (tierKey && NON_MEMBERSHIP_TIER_KEYS.has(tierKey)) return false;
  if (tierKey) return true;
  // No tier set: fall back to a positive recurring monthly rate (legacy members
  // whose tier column was never populated).
  return Number(customer.monthly_rate ?? customer.monthlyRate ?? 0) > 0;
}

// Live "does this customer hold a WaveGuard plan today?" check. Fail-closed to
// false (treat as a non-member / new customer) on a missing customer or any
// lookup error — the safe default is to charge the setup fee and offer annual
// prepay, never to silently waive them for a non-member.
async function isActivePlanCustomer(database, customerId) {
  if (!database || !customerId) return false;
  try {
    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer || customer.active === false) return false;
    return isMembershipCustomerRow(customer);
  } catch {
    return false;
  }
}

// Map a free-text service name (scheduled_services.service_type or an estimate
// line label) to a WaveGuard qualifying service key. Scoped to the five
// qualifiers — palm_injection and rodent_bait are explicitly NOT qualifiers,
// and one-time treatments (one_time_pest etc.) never count toward the tier.
// One rodent-token regex for qualification AND ownership — a second copy
// would drift (the qualifying classifier additionally requires the row to be
// rodent-LED; ownership below must not).
const RODENT_TOKEN_RE = /\b(rodent|rats?|mouse|mice)\b/;

// Rodent-LED text: a rodent token that is not the rodent half of an explicit
// pest-primary combined name ("Pest & Rodent Control"). Single definition —
// toQualifyingKeys and ownershipKeysForRow both read it.
function isRodentLedText(s) {
  return RODENT_TOKEN_RE.test(s) && !/\bpest\b.*\brodent\b/.test(s);
}

function toQualifyingKeys(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return [];
  if (/one[\s_-]?time|onetime/.test(s)) return [];
  // Commercial auto-priced plans are FLAT and never count toward a WaveGuard
  // tier — otherwise an accepted "Commercial Turf Treatment Program" would feed
  // priorQualifyingServices and unlock WaveGuard discounts on future estimates.
  if (s.includes('commercial')) return [];
  const keys = new Set();
  // Rodent-led names ("Rodent Pest Control" — rodent_general_one_time's
  // canonical label) are rodent service rows, not pest coverage. Mirror
  // detectServiceLine / recurring-appointment-seeder's serviceKeyFor: only a
  // "pest ... rodent" combined name ("Pest & Rodent Control") is pest-primary.
  const rodentService = isRodentLedText(s);
  if (s.includes('pest') && !rodentService) keys.add('pest_control');
  if (s.includes('lawn') || s.includes('turf')) keys.add('lawn_care');
  // A palm token ("Palm Tree Injections") names the non-qualifying palm
  // service and beats tree/shrub wording, same as detectServiceLine.
  // (\bpalms?\b never matches "palmetto", so palmetto-bug pest names pass.)
  const palmService = /\bpalms?\b/.test(s);
  if (!palmService && (s.includes('tree') || s.includes('shrub') || s.includes('ornamental'))) keys.add('tree_shrub');
  if (s.includes('mosquito')) keys.add('mosquito');
  if (s.includes('termite') && s.includes('bait')) keys.add('termite_bait');
  return [...keys];
}

function toQualifyingKey(raw) {
  return toQualifyingKeys(raw)[0] || null;
}

// Load every active recurring service row for account recognition/spend. This
// is intentionally broader than WaveGuard qualification: staff still need to
// see a customer's palm/rodent/non-tier recurring work even though those rows
// must never raise a membership tier.
async function loadActiveRecurringServiceRows(database, customerId) {
  if (!database || !customerId) return [];
  const customer = await database('customers').where({ id: customerId }).first();
  if (!customer || customer.active === false) return [];
  const cols = await database('scheduled_services').columnInfo();
  const hasIsRecurring = !!cols.is_recurring;
  let query = database('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotIn('status', TERMINAL_STATUSES);
  if (hasIsRecurring) {
    query = query.where({ is_recurring: true });
  }
  // status: filtered in SQL (whereNotIn TERMINAL) but also read row-side by
  // the ownership lifecycle filter (live en_route/on_site rows bypass the
  // date cutoff — codex #3253 r7).
  const selectCols = ['id', 'service_type', 'scheduled_date', 'status'];
  if (cols.estimated_price) selectCols.push('estimated_price');
  if (cols.annual_prepay_term_id) selectCols.push('annual_prepay_term_id');
  // The DISCOUNTED per-visit allocation of an annual-prepaid term
  // (splitCoverageAmount slice) — the tier-extension credit derives from
  // what was PAID, never the undiscounted estimated_price.
  if (cols.prepaid_amount) selectCols.push('prepaid_amount');
  // Which mechanism paid for the visit. A cash/Zelle prepayment keeps its own
  // method even when attachScheduledServices links the row to an annual term,
  // so the method is what distinguishes annual-prepay coverage from an
  // unrelated out-of-band payment (annual-prepay-renewals' own
  // annualPrepayCoversVisit keys on it first).
  if (cols.prepaid_method) selectCols.push('prepaid_method');
  // Appointment decomposition: estimated_price is the whole visit NET
  // (primary + add-ons − appointment discount), so the primary line's own
  // price and discount are what a per-application figure for the recurring
  // service must be built from.
  if (cols.primary_line_price) selectCols.push('primary_line_price');
  if (cols.line_discount_dollars) selectCols.push('line_discount_dollars');
  // Carried for the gated qualifying-row filter below — additive for every
  // other consumer of these rows.
  if (cols.is_callback) selectCols.push('is_callback');
  if (cols.source) selectCols.push('source');
  // For per-property tier scoping: an unstamped row resolves its property via
  // the estimate that created it (codex #3244 r6).
  if (cols.source_estimate_id) selectCols.push('source_estimate_id');
  const hasStampedAddress = !!cols.service_address_line1;
  if (hasStampedAddress) {
    selectCols.push('service_address_line1');
    if (cols.service_address_line2) selectCols.push('service_address_line2');
    if (cols.service_address_city) selectCols.push('service_address_city');
    if (cols.service_address_zip) selectCols.push('service_address_zip');
  }
  const rows = await query.select(selectCols);
  // Carry each row's STAMPED service address so duplicate checks can scope an
  // active service to its property — a multi-property customer's pest plan at
  // one address must not block a quote for another address. An unstamped row
  // stays null (UNKNOWN): substituting the customer's current primary address
  // would let a legacy row that actually covers a secondary property look
  // street-different and slip past the duplicate guard, so unknown rows keep
  // the conservative account-wide block downstream.
  return rows.map((row) => ({
    ...row,
    effective_service_address: (hasStampedAddress && row.service_address_line1)
      ? [
        [row.service_address_line1, row.service_address_line2].filter(Boolean).join(' '),
        row.service_address_city,
        row.service_address_zip,
      ].filter(Boolean).join(', ')
      : null,
  }));
}

// With the auto-tier gate on, membership pricing evidence uses the SAME
// authoritative predicate as tier derivation: upcoming (scheduled_date >=
// today), not a callback, not a one-time booking source (Codex #3011 r4 P1
// — a stale past nonterminal row in a second family must not grant a Silver
// discount to a customer the reconciler stamped Bronze). Gate off keeps the
// legacy all-nonterminal evidence byte-identical. scheduled_date is a pg
// DATE column arriving as a midnight Date — read the stored calendar day
// directly (repo DATE-column convention), never via ET conversion.
function qualifyingRowDateKey(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.split('T')[0];
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return null;
}

// One callback-truthiness predicate — the gated pricing evidence AND the
// ownership lifecycle filter both read it; a second copy would drift.
function isCallbackRow(row) {
  return row.is_callback === true || row.is_callback === 1 || row.is_callback === '1' || row.is_callback === 'true';
}

function rowPassesGatedPricingEvidence(row, today) {
  const rowDate = qualifyingRowDateKey(row.scheduled_date);
  if (!rowDate || rowDate < today) return false;
  if (isCallbackRow(row)) return false;
  // Lazy require: self-booking-plan-sync requires this module at load time,
  // so a top-level require back at it would be a cycle.
  const { isOneTimeBookingSource } = require('./self-booking-plan-sync');
  if (isOneTimeBookingSource(row.source)) return false;
  return true;
}

// Gated: the commercial predicate must see the same JOINED text as the
// tier-evidence path (Codex #3011 r5 P1) — an imported row can carry a
// generic service_type ("Lawn Care") while its catalog name is "Commercial
// Turf Treatment Program"; classifying service_type alone would count it as
// a qualifying family here after tier derivation rejected it, and price a
// Bronze-stamped customer at Silver. Best-effort: where the catalog is
// absent (older environments) the filter degrades to service_type-only,
// exactly the legacy behavior.
// Returns null on failure — NOT an empty Map — so callers can distinguish
// "no catalog rows" from "the join failed" (codex #3253 r4: a hidden join
// failure misclassifies generic service rows). The qualifying caller keeps
// its legacy degrade-to-empty behavior; the ownership caller fails closed.
async function loadCatalogFieldsByRowId(database, customerId) {
  try {
    const catalogRows = await database('scheduled_services as s')
      .leftJoin('services as svc', 's.service_id', 'svc.id')
      .where({ 's.customer_id': customerId })
      .select('s.id', 'svc.service_key', 'svc.name as service_name');
    return new Map(catalogRows.map((row) => [row.id, row]));
  } catch {
    return null;
  }
}

// Load the customer's active, recurring, WaveGuard-qualifying rows. The plan
// gate prevents a lead/one-time buyer with a stray recurring visit from
// receiving membership pricing.
async function loadExistingRecurringQualifyingRows(database, customerId) {
  if (!(await isActivePlanCustomer(database, customerId))) return [];
  const rows = await loadActiveRecurringServiceRows(database, customerId);
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('autoWaveguardTierEnroll')) {
    return rows.filter((r) => toQualifyingKeys(r.service_type).length > 0);
  }
  const { etDateString } = require('../utils/datetime-et');
  // Lazy require — self-booking-plan-sync requires this module at load time.
  // The commercial AND rodent-led classifiers both run against the JOINED
  // row (Codex #3011 r8: a generic service_type 'Pest Control' whose catalog
  // fields say rodent_general_one_time / "Rodent Pest Control" must be
  // excluded from pricing evidence exactly as tier derivation excludes it —
  // otherwise pricing counts a family the tier does not).
  const { isCommercialServiceRow, isRodentLedServiceRow } = require('./self-booking-plan-sync');
  // Legacy degrade: a failed join classifies on service_type alone here,
  // exactly the pre-null-return behavior (ownership fails closed instead).
  const catalogById = (await loadCatalogFieldsByRowId(database, customerId)) || new Map();
  const today = etDateString();
  // The kept rows are returned ENRICHED with their catalog identity (Codex
  // #3011 r11 P1): downstream reducers (qualifyingKeysFromRows and the
  // repricing paths built on it) must derive families from the same joined
  // identity this filter qualified on, or a generic 'Lawn Care' row linked
  // to lawn_care_monthly contributes no family and a stale different-family
  // label contributes the wrong one.
  const kept = [];
  for (const r of rows) {
    if (!rowPassesGatedPricingEvidence(r, today)) continue;
    const joined = { ...r, ...(catalogById.get(r.id) || {}) };
    if (isCommercialServiceRow(joined) || isRodentLedServiceRow(joined)) continue;
    // Qualify from the same catalog-authoritative classifier the downstream
    // reducer uses (Codex #3011 r10-r12): a stale 'Tree & Shrub Care'
    // service_type linked to palm_injection resolves no family, and a
    // 'Pest Control' service_type linked to lawn_care_monthly resolves only
    // lawn_care.
    if (qualifyingKeysForRow(joined).length === 0) continue;
    kept.push(joined);
  }
  return kept;
}

// Qualifying keys for a row, with CATALOG FAMILY AUTHORITY (Codex #3011
// r12): when the catalog identity (service_key / catalog name) resolves to a
// family, stale service_type text must not contribute ANOTHER — a
// 'Pest Control' service_type linked to lawn_care_monthly is one lawn
// service, never pest + lawn. When the catalog resolves no family
// (palm/rodent/uninformative), classification falls to the joined text so
// catalog exclusion tokens (palm) still veto service_type families while an
// uninformative catalog leaves service_type classification intact. Plain
// rows (no catalog fields) classify on service_type alone — byte-identical
// to the legacy behavior.
function qualifyingKeysForRow(row = {}) {
  const catalogText = [row.service_key, row.service_name]
    .filter(Boolean).join(' ').replace(/[_-]+/g, ' ');
  if (!catalogText) return toQualifyingKeys(row.service_type);
  const catalogKeys = toQualifyingKeys(catalogText);
  if (catalogKeys.length) return catalogKeys;
  return toQualifyingKeys(`${String(row.service_type || '')} ${catalogText}`.trim());
}

// Distinct qualifying service keys from a set of rows.
function qualifyingKeysFromRows(rows = []) {
  const keys = new Set();
  for (const r of rows) {
    qualifyingKeysForRow(r).forEach((key) => keys.add(key));
  }
  return [...keys];
}

// Convenience: just the distinct qualifying keys for a customer.
//
// streetScope ({ estimateStreet, customerPrimaryStreet }, both from
// normalizedEstimateStreet) scopes the keys to ONE property (codex #3244 r6):
// a grouped/secondary-property estimate must count qualifying services already
// active at THAT property (same-property add-ons keep their real tier) while
// excluding the other properties' plans. Stamped rows compare by
// service_address_line1; unstamped rows resolve via their creating estimate's
// address, then the customer's primary street; a row that still can't be
// located is EXCLUDED (counting an unlocatable plan toward another property's
// tier would hand out an unearned discount).
async function loadExistingQualifyingServiceKeys(database, customerId, { streetScope = null } = {}) {
  const rows = await loadExistingRecurringQualifyingRows(database, customerId);
  return qualifyingKeysFromRows(await filterRowsToStreet(database, rows, streetScope));
}

// One street filter for every per-property consumer (qualifying keys AND the
// pricing-AI ownership set below) — a second copy of the stamped → creating
// estimate → primary-street resolution would drift from this one. Matching
// carries main's #3248 locality-qualified scope-key semantics (city/zip
// segments, sameScopeKey wildcard-on-empty, locality-less stamped keys
// re-resolved via the creating estimate).
async function filterRowsToStreet(database, rows, streetScope) {
  if (!streetScope || !streetScope.estimateStreet) return rows;
  const { normalizedEstimateStreet, normalizedStampedStreet, sameScopeKey, scopeKeyLacksLocality } = require('./estimate-property-linkage');
  const kept = [];
  for (const row of rows) {
    let street = normalizedStampedStreet(row.service_address_line1, row.service_address_line2, row.service_address_city, row.service_address_zip);
    if ((!street || scopeKeyLacksLocality(street)) && row.source_estimate_id) {
      try {
        const src = await database('estimates').where({ id: row.source_estimate_id }).first('address');
        street = normalizedEstimateStreet(src?.address);
      } catch { /* fall through to the primary-street default */ }
    }
    street = street || String(streetScope.customerPrimaryStreet || '');
    if (street && sameScopeKey(street, streetScope.estimateStreet)) kept.push(row);
  }
  return kept;
}

// Ownership classification for the portal pricing AI (codex #3253 r2): a
// customer "has" a service for never-re-price purposes even when the row can
// never raise a WaveGuard tier — recurring Rodent Monitoring is the canonical
// case. Reuses the catalog-authoritative row classifier and adds ONLY the
// rodent family that toQualifyingKeys deliberately excludes; qualification
// itself stays untouched.
// Ownership families in one text: the qualifying families PLUS the recurring
// families qualification deliberately excludes. Over-recognition of an OWNED
// family is the safe direction (routes to a Waves conversation instead of a
// self-serve re-quote) — but only for products that ARE the same obligation:
//  - commercial recurring rows never qualify (flat pricing, no tier) yet the
//    customer owns the family — Commercial Pest Control must block a fresh
//    residential pest quote (codex #3253 r3). Tokens mirror
//    recurringServiceKey's commercial block (estimate-converter.js), mapped
//    to residential families. Direct reuse is not possible: that classifier
//    returns ONE primary key (cannot express combined pest+rodent
//    ownership), requires the literal 'bait' token for residential termite
//    (would drop "Termite Monitoring Service"), and estimate-converter
//    already requires this module at load.
//  - the rodent COMPONENT counts whether the row is rodent-led or a
//    pest-primary combined plan.
//  - termite counts ONLY for bait/station/monitoring products — a recurring
//    termite BOND (termite_bond_1yr) is a distinct warranty product and must
//    not block a bait-monitoring quote (codex #3253 r3).
function ownershipFamiliesFromText(raw) {
  // Key-shaped text ('rodent_bait', 'pest_rodent_quarterly' in an unlinked
  // row's service_type) must match the token regexes — underscores are word
  // characters, so without this normalization \brodent\b never fires and a
  // key-shaped owned row goes unrecognized (codex #3253 r5). Catalog text
  // arrives pre-normalized; doing it again is harmless.
  const s = String(raw || '').toLowerCase().replace(/[_-]+/g, ' ');
  // One-time identities are never an owned recurring obligation — mirrors
  // toQualifyingKeys' own first check, which only guards the qualifying
  // families; without this, rodent_general_one_time's repeated joined text
  // defeats the pest-before-rodent ordering heuristic and reads as the
  // combined plan (codex #3253 r4).
  if (/one[\s_-]?time|onetime/.test(s)) return [];
  const keys = toQualifyingKeys(s);
  const add = (key) => { if (!keys.includes(key)) keys.push(key); };
  if (s.includes('commercial')) {
    const rodentLed = isRodentLedText(s);
    if (s.includes('pest') && !rodentLed) add('pest_control');
    if (s.includes('lawn') || s.includes('turf')) add('lawn_care');
    if (!/\bpalms?\b/.test(s) && (s.includes('tree') || s.includes('shrub') || s.includes('ornamental'))) add('tree_shrub');
    if (s.includes('mosquito')) add('mosquito');
  }
  // Rodent ownership means the BAIT-MONITORING product (codex #3253 r4):
  // trapping / exclusion / rodent_general_one_time are distinct specialties
  // (estimate-converter maps only bait|station|monitor identities to
  // rodent_bait) and must not suppress a bait-station quote. The explicit
  // pest-primary combined plan ("Pest & Rodent Control") is the one carrier
  // of rodent coverage without those tokens.
  if (RODENT_TOKEN_RE.test(s)) {
    const combinedPestRodent = /\bpest\b/.test(s) && !isRodentLedText(s);
    if (/\b(bait|station|monitor)/.test(s) || combinedPestRodent) add('rodent_bait');
  }
  if (/\btermite\b/.test(s) && /\b(bait|station|monitor)/.test(s)) add('termite_bait');
  return keys;
}

function ownershipKeysForRow(row = {}) {
  // Same catalog-authority shape as qualifyingKeysForRow (pre-push P1 #2): a
  // catalog identity that resolves ownership families on its own is the
  // truth — a rodent_monitoring or termite_monitoring catalog row under a
  // stale generic 'Pest Control' service_type must not inherit pest from
  // that stale text and falsely block a valid pest quote. Only an
  // uninformative catalog falls back to the joined text.
  const catalogText = [row.service_key, row.service_name]
    .filter(Boolean).join(' ').replace(/[_-]+/g, ' ');
  if (catalogText) {
    // An INFORMATIVE catalog identity — one naming any service family — is
    // authoritative even when it resolves to NO owned family (pre-push P1
    // ×2): termite bonds, rodent trapping/exclusion, palm and other
    // recognized specialties must stay unowned rather than fall through and
    // inherit a stale service_type family (a rodent_trapping row under a
    // stale 'Pest Control' must own NOTHING, not pest). Only a catalog with
    // no family tokens at all ("Premium Home Plan") defers to service_type.
    const s = catalogText.toLowerCase();
    const informative = /\b(pest|lawn|turf|tree|shrub|ornamental|mosquito|termite|palms?)\b/.test(s)
      || RODENT_TOKEN_RE.test(s);
    if (informative) return ownershipFamiliesFromText(catalogText);
  }
  return ownershipFamiliesFromText(`${String(row.service_type || '')} ${catalogText}`.trim());
}

// Distinct owned recurring service keys — BROADER than qualification (all
// active recurring rows, rodent included; no membership gate, because a
// non-member with recurring rodent still owns rodent service). streetScope
// behaves exactly as in loadExistingQualifyingServiceKeys.
async function loadOwnedRecurringServiceKeys(database, customerId, { streetScope = null } = {}) {
  const rows = await loadActiveRecurringServiceRows(database, customerId);
  // Same catalog join as the qualifying loader: a generic service_type
  // ("Pest Control") whose catalog identity is rodent must classify as
  // rodent here too, not as owned pest coverage. FAIL CLOSED on a join
  // failure (codex #3253 r4) — classifying on service_type alone could
  // misread what the customer owns, so the caller must not price at all.
  const catalogById = await loadCatalogFieldsByRowId(database, customerId);
  if (!catalogById) throw new Error('ownership catalog join failed');
  let joined = rows.map((r) => ({ ...r, ...(catalogById.get(r.id) || {}) }));
  // Same lifecycle evidence as the qualifying loader, applied
  // UNCONDITIONALLY (pre-push P1 ×2): a past phantom row, a callback, or a
  // one-time booking source is not a live recurring obligation and must not
  // suppress a legitimate quote. Ownership is a NEW rule with no legacy
  // behavior to preserve, so the autoWaveguardTierEnroll gate — which exists
  // to keep the QUALIFYING path byte-identical when off — does not apply.
  // Only the lifecycle predicate is shared; the qualifying loader's
  // commercial/rodent exclusions are qualification-only.
  // EXCEPT live in-progress rows (codex #3253 r7, same precedent as the
  // billed-plan logic per #3241 r5): a visit still en_route/on_site across
  // ET midnight is the customer's plan all the same — those bypass the date
  // cutoff but never the callback/one-time exclusions.
  const { etDateString } = require('../utils/datetime-et');
  const { isOneTimeBookingSource } = require('./self-booking-plan-sync');
  const LIVE_IN_PROGRESS_STATUSES = new Set(['en_route', 'on_site', 'in_progress']);
  const today = etDateString();
  joined = joined.filter((r) => (
    LIVE_IN_PROGRESS_STATUSES.has(String(r.status || '').toLowerCase())
      ? (!isCallbackRow(r) && !isOneTimeBookingSource(r.source))
      : rowPassesGatedPricingEvidence(r, today)
  ));
  const scoped = await filterRowsToStreet(database, joined, streetScope);
  const keys = new Set();
  for (const row of scoped) ownershipKeysForRow(row).forEach((key) => keys.add(key));
  return [...keys];
}

module.exports = {
  TERMINAL_STATUSES,
  toQualifyingKey,
  toQualifyingKeys,
  filterRowsToStreet,
  loadActiveRecurringServiceRows,
  loadExistingRecurringQualifyingRows,
  qualifyingKeysForRow,
  qualifyingKeysFromRows,
  loadExistingQualifyingServiceKeys,
  loadOwnedRecurringServiceKeys,
  ownershipKeysForRow,
  isMembershipCustomerRow,
  isActivePlanCustomer,
};
