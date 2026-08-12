// ============================================================
// estimate-membership-context.js
//
// Builds the customer-facing "WaveGuard membership" context for an estimate
// that is linked to an existing, active customer (estimates.customer_id set).
//
// computeMembershipContext() is run ONCE at estimate save/reprice time
// (admin-estimate-persistence.js) and the result is frozen onto the estimate as
// estimate_data.membershipSnapshot. buildEstimateMembershipContext() then just
// reads that snapshot at view time. This keeps the card tied to the saved
// pricing — it can never diverge from the charged total because of mutable
// scheduled_services changing between save and view, and legacy estimates with
// no snapshot render no card.
//
// The NEW-service member discount it shows is honored at the charged total
// because the same combined tier (from the same shared waveguard-existing-
// services loader) reprices the estimate at save. Existing service prices are
// context only and stay untouched; adding a service never reprices a customer's
// current plan lines.
//
// The snapshot captures:
//   1. The combined WaveGuard tier — existing qualifying services PLUS the
//      new service(s) in this estimate.
//   2. The tier-upgrade callout (e.g. Silver -> Gold).
//   3. The customer's current service/spend snapshot for staff transparency.
//   4. The member discount on the NEW service in this estimate only.
//
// Returns null for leads (no customer_id), inactive customers, or on ANY error
// so neither save nor the public estimate endpoints ever break (CLAUDE.md r6).
// ============================================================

const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { sameStreetAddress } = require('./estimator-engine/address-compare');
const {
  parseRawAddress,
  splitStreetLineUnit,
  unitLineValueKey,
} = require('../utils/address-normalizer');
const { determineWaveGuardTier } = require('./pricing-engine/discount-engine');
const {
  toQualifyingKey,
  toQualifyingKeys,
  qualifyingKeysForRow,
  loadActiveRecurringServiceRows,
  loadExistingRecurringQualifyingRows,
  filterRowsToStreet,
} = require('./waveguard-existing-services');

const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
const SERVICE_LABEL = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  tree_shrub: 'Tree & Shrub',
  mosquito: 'Mosquito',
  termite_bait: 'Termite Bait',
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Money equality in INTEGER CENTS (codex #3338 r9): a ±$0.01 tolerance
// admits values that genuinely differ by a cent — a split-remainder prepaid
// term ($16.75 ×5 + $16.76) would freeze one shared basis and the accept
// would credit the frozen figure for every application, a cent off on the
// remainder. Money columns are numeric(10,2), so exact-cents equality is
// well-defined; Math.round absorbs float parse noise.
function sameCents(a, b) { return Math.round(Number(a) * 100) === Math.round(Number(b) * 100); }

// scheduled_date is a pg DATE column arriving as a midnight Date — read the
// stored calendar day directly (repo DATE-column convention, mirrors
// waveguard-existing-services.qualifyingRowDateKey), never via ET conversion.
function visitDateKey(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.split('T')[0];
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return null;
}

// Same callback truthiness the accept-time extension uses
// (applyFrozenExistingServiceExtension) — the frozen appointment list must
// name exactly the rows accept reprices, and a free callback visit is not
// one of them (codex #3338 r7).
function isCallbackServiceRow(row = {}) {
  return row.is_callback === true || row.is_callback === 1
    || row.is_callback === '1' || row.is_callback === 'true';
}

// Precedence guards MIRRORED from waveguard-existing-services.toQualifyingKeys
// (which follows detectServiceLine / the recurring-appointment-seeder): a
// rodent-led name ("Rodent Pest Control", "Rodent Bait Stations") is the
// rodent service, never pest coverage — only a pest-primary combined label
// ("Pest & Rodent Control") keeps pest — and a palm token ("Palm Tree
// Injections") names the palm service over tree/shrub wording. \bpalms?\b
// never matches "palmetto", so palmetto-bug pest names pass through. Keep
// these in lockstep with that file; an independent token scan here mis-keys
// the component keys that feed the duplicate-service checks.
function isRodentLedName(text) {
  return /\b(rodent|rats?|mouse|mice)\b/.test(text) && !/\bpest\b.*\brodent\b/.test(text);
}

function isPalmName(text) {
  return /\bpalms?\b/.test(text);
}

function accountServiceKey(raw) {
  const qualifying = toQualifyingKey(raw);
  if (qualifying) return qualifying;
  // Canonical keys for the non-tier recurring programs. The estimate
  // converter stores DISPLAY names on scheduled_services ("Rodent Bait
  // Stations", "Commercial Turf Treatment Program"); a generic snake-case of
  // those labels never matches the requested-service template keys, so
  // duplicate checks would miss the active service. Commercial programs
  // canonicalize to commercial_ + the residential TEMPLATE key, so stripping
  // the prefix in the duplicate check yields exactly the requested key
  // (turf → lawn_care, monitoring → termite_bait, stations → rodent_bait).
  const s = String(raw || '').toLowerCase();
  if (s.includes('commercial')) {
    if (s.includes('pest') && !isRodentLedName(s)) return 'commercial_pest_control';
    if (s.includes('lawn') || s.includes('turf')) return 'commercial_lawn_care';
    if (!isPalmName(s) && (s.includes('tree') || s.includes('shrub'))) return 'commercial_tree_shrub';
    if (s.includes('mosquito')) return 'commercial_mosquito';
    if (s.includes('termite')) return 'commercial_termite_bait';
    if (s.includes('rodent')) return 'commercial_rodent_bait';
  } else {
    if (isRodentLedName(s)) return 'rodent_bait';
    if (isPalmName(s)) return 'palm_injection';
  }
  return String(raw || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function accountServiceKeys(raw) {
  const text = String(raw || '').toLowerCase();
  const commercial = text.includes('commercial');
  const keys = new Set();
  const add = (key) => keys.add(commercial ? `commercial_${key}` : key);
  const rodentService = isRodentLedName(text);
  const palmService = isPalmName(text);
  if (text.includes('pest') && !rodentService) add('pest_control');
  if (text.includes('lawn') || text.includes('turf')) add('lawn_care');
  if (!palmService && (text.includes('tree') || text.includes('shrub'))) add('tree_shrub');
  if (text.includes('mosquito')) add('mosquito');
  if (text.includes('termite')) add('termite_bait');
  if (rodentService) add('rodent_bait');
  if (palmService) add('palm_injection');
  if (!keys.size) keys.add(accountServiceKey(raw));
  return [...keys].filter(Boolean);
}

// CATALOG-AUTHORITATIVE identity for a scheduled row (codex #3353 r3).
// A row's service_type text can drift from what its service_id actually
// points at — the repo's documented case is a stale "Pest Control" label on
// a row linked to lawn_care_monthly — and the qualifying/tier path already
// treats the joined catalog identity as the truth. Without this the same
// response counts Lawn Care toward the tier while telling staff the customer
// buys Pest Control.
//
// INFORMATIVE catalog text wins; anything else defers to service_type. A
// catalog name that names no service family at all ("Premium Home Plan")
// tells us nothing, so the row's own text still speaks. Mirrors the rule
// ownershipKeysForRow applies in waveguard-existing-services.
// The catalog KEY alone, never key+name concatenated (codex #3359). Feeding
// "termite_liquid Termite Liquid Treatment" through the free-text classifier
// yields termite_liquid_termite_liquid_treatment — a noncanonical key that
// matches nothing and renders as a duplicated label. The service_key IS the
// canonical identity; the name is for display only.
function catalogIdentityText(meta) {
  return String(meta?.serviceKey || '').replace(/[_-]+/g, ' ');
}

function catalogNamesAFamily(text) {
  const s = String(text || '').toLowerCase();
  return /\b(pest|lawn|turf|tree|shrub|ornamental|mosquito|termite|palms?|rodent|rats?|mouse|mice)\b/.test(s);
}

// The text the account key/label should be derived from for this row.
//
// GATED on autoWaveguardTierEnroll, deliberately: that is the same flag
// loadExistingRecurringQualifyingRows uses to decide whether the tier path
// classifies by catalog identity or by service_type text. Reading the
// catalog here unconditionally would fix the gate-ON divergence Codex
// reported (tier counts Lawn Care, panel says Pest Control) while CREATING
// the mirror-image one with the gate off. Display follows whatever rule
// qualification is using, so the two can never disagree in either state.
function authoritativeServiceText(row = {}, meta = null) {
  if (!isEnabled('autoWaveguardTierEnroll')) return row.service_type;
  const catalogText = catalogIdentityText(meta);
  return catalogNamesAFamily(catalogText) ? catalogText : row.service_type;
}

// Display name for a row: the catalog's own name when its identity is what we
// keyed on, so the label reads "Termite Liquid Treatment" rather than a
// de-slugged key. Falls back to the row text on the same terms as the key.
function authoritativeServiceLabelText(row = {}, meta = null) {
  if (!isEnabled('autoWaveguardTierEnroll')) return row.service_type;
  return catalogNamesAFamily(catalogIdentityText(meta))
    ? (meta?.serviceName || catalogIdentityText(meta))
    : row.service_type;
}

function accountServiceLabel(key, raw) {
  if (SERVICE_LABEL[key]) return SERVICE_LABEL[key];
  return String(raw || key || 'Service')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseEstimateData(estimate) {
  try {
    return typeof estimate.estimate_data === 'string'
      ? JSON.parse(estimate.estimate_data)
      : (estimate.estimate_data || {});
  } catch { return {}; }
}

// A row from estimate_data.lineItems / .services counts as a recurring service
// only if it carries recurring pricing (annual/monthly). One-time and specialty
// lines carry .price / .total and must NOT count toward the WaveGuard tier —
// one-time services never receive the tier discount and the charged price is
// unchanged, so advertising a tier upgrade off them would be wrong.
function isRecurringLineRow(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.isOneTime === true || c.oneTime === true || c.one_time === true) return false;
  const hasAnnual = Number(c.annual ?? c.ann ?? c.annualBeforeDiscount) > 0;
  const hasMonthly = Number(c.monthly ?? c.mo ?? c.monthlyBeforeDiscount) > 0;
  if (hasAnnual || hasMonthly) return true;
  // price/total only (no recurring figure) → one-time / specialty.
  if (Number(c.price) > 0 || Number(c.total) > 0) return false;
  return c.recurring === true || c.isRecurring === true || !!c.frequency;
}

// Collect the candidate recurring-service rows across the several estimate_data
// shapes (v1 admin shape, engineResult, lineItems, services). The explicit
// recurring sections are trusted; the mixed lineItems / services arrays are
// filtered to recurring rows so one-time treatments don't inflate the tier.
function recurringCandidates(estData) {
  const out = [];
  const pushAll = (arr) => { if (Array.isArray(arr)) out.push(...arr); };
  pushAll(estData?.result?.recurring?.services);
  pushAll(estData?.engineResult?.recurring?.services);
  pushAll(estData?.recurring?.services);
  const mixed = [];
  if (Array.isArray(estData?.lineItems)) mixed.push(...estData.lineItems);
  if (Array.isArray(estData?.services)) mixed.push(...estData.services);
  for (const row of mixed) { if (isRecurringLineRow(row)) out.push(row); }
  return out;
}

function candidateName(c) {
  return c?.service || c?.key || c?.name || c?.label || c?.displayName || c?.service_type;
}

// Qualifying recurring service keys present in this estimate.
function estimateQualifyingKeys(estData) {
  const keys = new Set();
  for (const c of recurringCandidates(estData)) {
    const key = toQualifyingKey(candidateName(c));
    if (key) keys.add(key);
  }
  return [...keys];
}

// Best-effort monthly (pre-discount) price for a qualifying key from the
// estimate, if one is present. Used only to express the new-service member
// savings as a dollar figure — omitted when no price is found.
function estimateMonthlyFor(estData, key) {
  for (const c of recurringCandidates(estData)) {
    if (toQualifyingKey(candidateName(c)) !== key) continue;
    const monthly = c?.monthlyBeforeDiscount
      ?? c?.monthly
      ?? c?.mo
      ?? (Number(c?.annualBeforeDiscount) > 0 ? c.annualBeforeDiscount / 12 : null)
      ?? (Number(c?.annual) > 0 ? c.annual / 12 : null);
    if (Number(monthly) > 0) return round2(monthly);
  }
  return null;
}

// Visits/year for a qualifying key — explicit row fields first, then the
// engine's result-stats block (same precedence the public page uses for its
// per-application price cards).
function resultStatsRows(estData) {
  return estData?.result?.results || estData?.results || {};
}

function selectedStatsRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows.find((t) => t?.selected || t?.isSelected)
    || rows.find((t) => t?.recommended || t?.isRecommended)
    || rows[0];
}

function estimateVisitsFor(estData, key) {
  for (const c of recurringCandidates(estData)) {
    if (toQualifyingKey(candidateName(c)) !== key) continue;
    const explicit = Number(c?.visitsPerYear ?? c?.visits ?? c?.apps ?? c?.frequency);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
  }
  const stats = resultStatsRows(estData);
  if (key === 'pest_control') return Number(stats.pest?.apps) > 0 ? Number(stats.pest.apps) : null;
  if (key === 'lawn_care') {
    const sel = (Array.isArray(stats.lawn) && (stats.lawn.find((t) => t.recommended) || stats.lawn[0])) || null;
    return Number(sel?.v) > 0 ? Number(sel.v) : null;
  }
  if (key === 'mosquito') {
    const sel = selectedStatsRow(stats.mq);
    return Number(sel?.v) > 0 ? Number(sel.v) : null;
  }
  if (key === 'tree_shrub') {
    const sel = selectedStatsRow(stats.ts);
    return Number(sel?.v) > 0 ? Number(sel.v) : null;
  }
  if (key === 'termite_bait') return 4;
  return null;
}

// Pre-discount per-application price for a qualifying key — explicit per-app
// row fields first, else monthly*12/visits. Used to express the new-service
// member savings as a per-application dollar figure.
function estimatePerApplicationFor(estData, key) {
  for (const c of recurringCandidates(estData)) {
    if (toQualifyingKey(candidateName(c)) !== key) continue;
    const explicit = Number(c?.perTreatment ?? c?.perApp ?? c?.perVisit ?? c?.pa);
    if (Number.isFinite(explicit) && explicit > 0) return round2(explicit);
  }
  const monthly = estimateMonthlyFor(estData, key);
  const visits = estimateVisitsFor(estData, key);
  if (monthly > 0 && visits > 0) return round2((monthly * 12) / visits);
  return null;
}

// One-time membership/setup line items must not count toward the per-visit
// basis — the FIRST standard accept invoice can carry the $99 WaveGuard setup
// AND the first application on the same service-linked invoice, and reading
// its raw total would inflate the advertised per-visit savings.
// Match the membership/setup wording specifically — a bare /waveguard/ would
// also swallow tier-discount rows like "WaveGuard Silver — 10% off", which
// must stay in the net (they're part of what the customer actually paid).
function isSetupLineItem(line = {}) {
  return /membership|setup fee|waveguard setup/i.test(String(line.description || ''));
}

function invoiceLineItems(row = {}) {
  const raw = row.line_items;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

// Signed — discount/adjustment rows carry negative amounts and must reduce
// what counts as "last paid", not be dropped.
function lineItemAmount(line = {}) {
  const explicit = Number(line.amount);
  if (Number.isFinite(explicit) && explicit !== 0) return explicit;
  const qty = Number(line.quantity) || 1;
  const unit = Number(line.unit_price);
  return Number.isFinite(unit) ? unit * qty : 0;
}

// Line classification, keyed on the shapes buildScheduledServiceInvoiceLines
// actually emits (server/services/invoice.js): the primary service line and
// each add-on carry a client_id of scheduled_<id>_primary / _addon_<addonId>,
// and every discount is a negative line tagged _kind:'discount' whose
// discount_for names the line it reduces (null = appointment-wide).

// A deposit credit is the APPLICATION OF A PAYMENT, not a price reduction:
// the customer paid that money earlier on the estimate. Treating it as a
// discount reports a $117 application with a $49 deposit as $68 — the
// customer paid the full $117, just across two moments.
function isDepositCreditLine(line = {}) {
  return String(line.category || '') === 'deposit_credit';
}

// The covered base visit line. invoice.js's own invoiceHasNonBaseCharges
// keys on this same tag: add-ons carry `_addon_`, but a pre-minted
// mobile-checkout invoice adds positive extraLineItems with NO such id, so
// "is it an add-on" is the wrong question — "is it the primary line" is the
// right one. Anything else positive is an extra, however it got there.
function isPrimaryLine(line = {}) {
  return String(line.client_id || '').includes('_primary');
}

function isAddonLine(line = {}) {
  return String(line.client_id || '').includes('_addon_');
}

// A tag-aware invoice declares which line is the service; an invoice with no
// tags at all is legacy and gets the single-positive heuristic instead.
function invoiceIsTagAware(lines) {
  return lines.some((line) => isPrimaryLine(line) || isAddonLine(line));
}

function isPositiveLine(line = {}) {
  return lineItemAmount(line) > 0;
}

function isDiscountLine(line = {}) {
  return line._kind === 'discount' || Number(lineItemAmount(line)) < 0;
}

// A discount attached to a specific line, which leaves with that line.
function discountTargets(line = {}, clientIds) {
  return isDiscountLine(line) && clientIds.has(String(line.discount_for || ''));
}

// Appointment-wide discount: a discount line naming no parent.
function isAppointmentWideDiscount(line = {}) {
  return isDiscountLine(line) && !line.discount_for;
}

// What the invoice charged for THE SERVICE ITSELF, per application.
//
// Add-ons are separate line items on the same appointment invoice while
// service_type still names only the primary service, so summing every line
// reports a $100 pest visit with a $75 one-time add-on as "Pest Control ·
// $175 per application" (codex #3353 r11). Add-ons and their own discounts
// are excluded; the primary line and its discount are what the recurring
// service costs.
// Does this invoice bill for a SERVICE at all? A standalone setup/membership
// or deposit-only invoice does not, so it is not the invoice that decides what
// the customer pays per application — it is skipped entirely, and an older
// service invoice may still answer. Distinct from a service invoice whose
// basis is unattributable, which DOES decide the key (as withheld).
function invoiceCarriesServiceCharge(row = {}) {
  const lines = invoiceLineItems(row);
  if (!lines.length) return Number(row.total) > 0;
  const billable = lines.filter((line) => !isSetupLineItem(line) && !isDepositCreditLine(line));
  // A tag-aware invoice bills for the SERVICE only when its primary line is
  // itself a positive charge. An add-on-only invoice — the concrete case is a
  // prepay-covered visit whose base is $0 while a one-time add-on bills — says
  // nothing about what the recurring service costs per application, so like a
  // setup-only invoice it is skipped and an older service invoice may answer
  // (codex #3359 r2).
  if (invoiceIsTagAware(billable)) {
    return billable.some((line) => isPrimaryLine(line) && isPositiveLine(line));
  }
  return billable.some(isPositiveLine);
}

function invoiceServiceAmount(row = {}) {
  const lines = invoiceLineItems(row);
  if (!lines.length) {
    // No parseable lines: the invoice total is already net of any discount.
    const total = Number(row.total);
    return Number.isFinite(total) && total > 0 ? round2(total) : null;
  }
  const hadSetupLines = lines.some(isSetupLineItem);
  const billable = lines.filter((line) => !isSetupLineItem(line) && !isDepositCreditLine(line));
  const positives = billable.filter(isPositiveLine);
  const primaries = positives.filter(isPrimaryLine);

  let serviceLines;
  let extras;
  if (primaries.length) {
    extras = positives.filter((line) => !isPrimaryLine(line));
    const primaryIds = new Set(primaries.map((line) => String(line.client_id)));
    const primaryDiscounts = billable.filter((line) => discountTargets(line, primaryIds));
    const appointmentWide = billable.filter(isAppointmentWideDiscount);
    // An appointment-WIDE discount spans the primary line and every extra
    // together, and nothing records how it was apportioned. With extras
    // present there is no honest attribution, so the basis is withheld —
    // the same rule this module applies to every other unattributable
    // figure.
    if (extras.length && appointmentWide.length) return null;
    serviceLines = [...primaries, ...primaryDiscounts, ...(extras.length ? [] : appointmentWide)];
  } else {
    // Legacy / fallback invoices carry no client_id at all. One positive line
    // is unambiguously the service; several cannot be told apart, so they
    // withhold rather than summing unrelated charges into a per-application
    // price. A TAG-AWARE invoice never reaches this heuristic (codex #3359
    // r2): its tags already said which line is the service, and with no
    // positive primary the remaining positives are add-ons or checkout
    // extras — treating one as the service records an add-on's price as the
    // recurring per-application figure.
    if (invoiceIsTagAware(billable)) return null;
    if (positives.length !== 1) return null;
    extras = [];
    serviceLines = [...positives, ...billable.filter(isDiscountLine)];
  }

  let serviceTotal = serviceLines.reduce((sum, line) => sum + lineItemAmount(line), 0);

  // invoices.discount_amount holds the SUM of every discount on the invoice —
  // line-specific ones AND a manual discountIds selection (InvoiceService
  // .create). The line-represented part is already in serviceTotal above, so
  // only the REMAINDER is the manual portion still missing. Ignoring the
  // field whenever any discount line exists drops that remainder; subtracting
  // it whole would double-count the line part.
  const lineDiscountTotal = billable
    .filter(isDiscountLine)
    .reduce((sum, line) => sum + Math.abs(lineItemAmount(line)), 0);
  const manualPortion = round2((Number(row.discount_amount) || 0) - lineDiscountTotal);
  if (manualPortion > 0) {
    // A manual discount is computed against the whole subtotal, so with any
    // extra or setup line on the invoice it is not the service's alone.
    if (extras.length || hadSetupLines) return null;
    serviceTotal -= manualPortion;
  }

  if (serviceTotal > 0) return round2(serviceTotal);
  // Everything was setup/membership/deposit, or discounts netted it to zero —
  // not a usable per-visit price.
  return null;
}

// What the customer actually LAST PAID per visit, by qualifying key — most
// recent paid invoice whose service_type maps to the key. Visit invoices
// minted from the schedule carry service_type; standalone setup/prepay
// invoices don't, so they never pollute this. Falls back to {} on any error
// so the snapshot still renders from scheduled_services.estimated_price.
// Keyed ACCOUNT-WIDE: invoices carry no property linkage here, so this newest
// amount reflects only ONE contract. When a key spans multiple per-property
// contracts, loadCurrentServiceSpendContext must not stamp it across all of
// them — it aggregates the per-contract scheduled prices instead.
async function loadLastPaidSpendByKey(database, customerId, catalogIdentityByRowId = new Map()) {
  const spend = {};
  try {
    const rows = await database('invoices')
      .where({ customer_id: customerId })
      .whereIn('status', ['paid', 'prepaid'])
      .whereNotNull('service_type')
      .orderBy('paid_at', 'desc')
      .limit(100)
      // discount_amount carries a manual invoice-level discount that never
      // appears as a negative line (codex #3353 r11). scheduled_service_id
      // links the invoice to the visit it was minted for, which is what
      // resolves its catalog identity below.
      .select('service_type', 'total', 'line_items', 'paid_at', 'discount_amount',
        'scheduled_service_id');
    // The NEWEST invoice for a key decides that key, even when it decides
    // "withheld" (codex #3359): letting an older invoice fill in behind an
    // intentionally-unattributable newest one presents a superseded price as
    // what the customer currently pays.
    const decided = new Set();
    for (const row of rows) {
      // The SAME gated catalog-vs-text rule the scheduled rows are keyed with
      // (codex #3359 r2): an invoice minted from a visit whose service_type
      // text has drifted must file under the family the panel groups that
      // visit's contract into, or the authoritative last-paid amount lands
      // under a key nothing reads and the panel falls back to the scheduled
      // estimate. Invoices minted without a visit link keep their own text,
      // exactly as before.
      const identityText = authoritativeServiceText(
        row,
        row.scheduled_service_id ? catalogIdentityByRowId.get(row.scheduled_service_id) : null,
      );
      // A COMBINED invoice ("Quarterly Pest + Termite Bait Station") is one
      // charge covering several families — so using it as any component's
      // per-application basis presents the whole bundle as that component's
      // price (codex #3353 r3). This is the invoice-path twin of the
      // component-count guard on the customer-level stamps below, and it
      // matters more because last-paid takes precedence over every other
      // basis. Withhold rather than mis-attribute — and decide EVERY
      // component (codex #3359 r2): the customer's latest charge for each of
      // them is part of the unattributable bundle, so an older standalone
      // invoice for any component is superseded and must not fill in.
      const keys = accountServiceKeys(identityText).filter(Boolean);
      const undecidedKeys = keys.filter((key) => !decided.has(key));
      if (!undecidedKeys.length) continue;
      // Not a service invoice (setup/membership, deposit, or add-on only): it
      // says nothing about the per-application price, so an older service
      // invoice may still answer.
      if (!invoiceCarriesServiceCharge(row)) continue;
      undecidedKeys.forEach((key) => decided.add(key));
      if (keys.length > 1) continue;
      const amount = invoiceServiceAmount(row);
      if (amount != null) {
        spend[undecidedKeys[0]] = {
          amount,
          paidAt: row.paid_at || null,
        };
      }
    }
  } catch (err) {
    logger.warn(`[membership-context] last-paid lookup skipped for customer ${customerId}: ${err.message}`);
  }
  return spend;
}

// Visit cadence (frequency + visits/year) per scheduled row, from the service
// catalog. DISPLAY ONLY — the staff spend panel reads "$95 per application ·
// Quarterly (4/yr)" so the office can compare a new quote against what the
// customer actually pays today, and the monthly-rate basis below divides by
// this visit count. Degrades to an EMPTY Map on any error (CLAUDE.md r6): a
// missing cadence hides the label and skips the derived basis, it never
// breaks the panel or the membership snapshot that embeds it.
async function loadCadenceByRowId(database, customerId) {
  try {
    const rows = await database('scheduled_services as s')
      .leftJoin('services as svc', 's.service_id', 'svc.id')
      .where({ 's.customer_id': customerId })
      // recurring_interval_days is REQUIRED here, not optional detail: it is
      // what resolves a 'custom' series (codex #3353 r5 — the projection
      // missed it, so the r4 interval-days resolution silently never fired
      // against a real database and every custom series fell back to the
      // catalog cadence).
      // The catalog IDENTITY rides along with the cadence: one join already
      // resolves both, and the identity is what makes the displayed service
      // name trustworthy when service_type text has drifted.
      .select('s.id', 's.recurring_pattern', 's.recurring_interval_days',
        'svc.frequency', 'svc.visits_per_year', 'svc.service_key', 'svc.name as service_name');
    // The LIVE series wins over the catalog default (codex #3353 r3): a
    // series whose scheduled_services.recurring_pattern overrides its
    // catalog frequency really runs at the overridden cadence, and reading
    // the catalog alone would both mislabel it and divide the monthly rate
    // by the wrong visit count (a $100/mo monthly series read as quarterly
    // becomes "$300 per application"). Resolution reuses the coverage-cadence
    // helpers in annual-prepay-renewals — the repo's existing mechanism
    // (AGENTS.md: extend it, never build a parallel one) — which is also what
    // admin-invoices' coverage suggestion resolves with.
    //
    // Required at CALL time: this module sits in a require cycle with the
    // converter/prepay web, and a module-scope destructure of ._private can
    // land while that export is still undefined.
    const {
      normalizeCoverageCadence,
      cadenceFromIntervalDays,
    } = require('./annual-prepay-renewals')._private;
    // Visits per year comes from the SHARED helper (codex #3353 r9):
    // prepay-cadence exists for exactly this mapping, and it knows cadences a
    // coverage-vocabulary round-trip drops — seasonal_feb_oct resolves to 9
    // there and to nothing through normalizeCoverageCadence. Maintaining a
    // second mapping is the parallel-mechanism mistake AGENTS.md names, which
    // I made while citing that very rule.
    const { visitsPerYearForCadence } = require('./prepay-cadence');
    return new Map(rows.map((row) => {
      // Same three-step resolution admin-invoices' coverage suggestion uses,
      // in the same order (codex #3353 r4): the scheduler's
      // 'monthly_nth_weekday' IS monthly; named cadences go through
      // normalizeCoverageCadence; and everything it can't name — notably
      // 'custom' carrying recurring_interval_days = 42 — resolves from the
      // interval days.
      // The shared helper resolves the live pattern DIRECTLY when it knows it
      // (monthly_nth_weekday, seasonal_feb_oct, every_6_weeks…); the coverage
      // normalizer and interval-days mapping are the fallbacks for patterns it
      // doesn't name. Whichever produces the cadence, the visit count always
      // comes from the one shared mapping.
      const rawPattern = String(row.recurring_pattern || '').trim().toLowerCase();
      const liveCadence = (visitsPerYearForCadence(rawPattern) ? rawPattern : null)
        || normalizeCoverageCadence(row.recurring_pattern)
        || cadenceFromIntervalDays(row.recurring_interval_days);
      const liveVisitsPerYear = visitsPerYearForCadence(liveCadence);
      const identity = { serviceKey: row.service_key || null, serviceName: row.service_name || null };
      if (liveCadence && liveVisitsPerYear) {
        return [row.id, { ...identity, frequency: liveCadence, visitsPerYear: liveVisitsPerYear }];
      }
      // A series that DECLARES a live recurrence we cannot name yields NO
      // cadence — never the catalog default (codex #3353 r6). weekly and
      // biweekly are the concrete cases: the scheduler supports both,
      // normalizeCoverageCadence doesn't name them and cadenceFromIntervalDays
      // deliberately rejects their 7/14-day intervals as non-coverage
      // cadences, so the catalog fallback would show a weekly series as its
      // catalog quarterly (4/yr) and divide a monthly rate by 4.
      //
      // The RULE, not just those two patterns: an unresolvable live override
      // is known-different, not unknown, so inheriting the catalog asserts
      // something we have positive evidence against. Showing nothing is the
      // honest failure — a null cadence omits the label and suppresses the
      // monthly-rate division rather than quoting a wrong per-application
      // figure. The catalog only speaks for a series that declares no
      // recurrence of its own.
      if (rawPattern || Number(row.recurring_interval_days) > 0) {
        return [row.id, { ...identity, frequency: null, visitsPerYear: null }];
      }
      return [row.id, {
        ...identity,
        frequency: row.frequency || null,
        visitsPerYear: Number(row.visits_per_year) > 0 ? Number(row.visits_per_year) : null,
      }];
    }));
  } catch {
    return new Map();
  }
}

// Which of these rows carry add-ons. Returns NULL on failure — the caller
// then treats every row as possibly-composite and requires an explicit
// primary-line price, because assuming "no add-ons" would quote appointment
// totals as service prices.
async function loadAddonRowIds(database, rows) {
  const rowIds = rows.map((row) => row.id).filter(Boolean);
  if (!rowIds.length) return new Set();
  try {
    const addonRows = await database('scheduled_service_addons')
      .whereIn('scheduled_service_id', rowIds)
      .select('scheduled_service_id');
    return new Set(addonRows.map((row) => String(row.scheduled_service_id)));
  } catch {
    return null;
  }
}

// What the RECURRING SERVICE costs on this visit, as opposed to what the
// appointment totals (codex #3359). scheduled_services.estimated_price is the
// whole visit net — calculateVisitFinancialsForAddons sums the primary line
// and every add-on, then applies the appointment discount — so on a visit with
// add-ons it is not a per-application price for the plan. The same $100 + $75
// appointment the invoice path now separates would otherwise come back as $175
// through this fallback whenever invoice evidence is missing or withheld.
//
// A composite visit therefore decomposes: primary_line_price minus its own
// line discount. Without that column there is nothing to decompose from, so
// the row yields no basis rather than a padded one.
//
// An APPOINTMENT-level discount on a composite row withholds outright (codex
// #3359 r2): it spans the primary and every add-on with no recorded
// apportionment — the exact shape invoiceServiceAmount withholds on — so
// subtracting only the primary's own line discount would report the
// undiscounted primary as what the customer pays. A row with no add-ons keeps
// its estimated_price, which is already net of that discount and wholly the
// primary's. Any of the three discount columns counts as the signal: rows
// written before discount_dollars existed carry only discount_type/_id, and
// an unresolvable discount must withhold, not be assumed zero.
function rowServicePrice(row = {}, addonRowIds) {
  const composite = addonRowIds ? addonRowIds.has(String(row.id)) : true;
  if (!composite) {
    return Number(row.estimated_price) > 0 ? round2(row.estimated_price) : null;
  }
  if (Number(row.discount_dollars) > 0 || row.discount_type || row.discount_id) return null;
  const primary = Number(row.primary_line_price);
  if (!(primary > 0)) return null;
  const net = round2(primary - (Number(row.line_discount_dollars) || 0));
  return net > 0 ? net : null;
}

// Catalog identity per scheduled row, loaded INDEPENDENTLY of cadence (codex
// #3359). loadCadenceByRowId is deliberately fail-soft and carries a wider
// projection; if it degrades (schema lag on a cadence column, say) while the
// narrower identity query still works, folding identity into it would silently
// revert the panel to stale service_type — recreating, with the tier gate on,
// exactly the tier-vs-label divergence this is meant to remove. Two queries,
// two failure domains. Degrades to an empty Map, which simply means "no
// catalog identity" and defers to service_type.
async function loadCatalogIdentityByRowId(database, customerId) {
  try {
    const rows = await database('scheduled_services as s')
      .leftJoin('services as svc', 's.service_id', 'svc.id')
      .where({ 's.customer_id': customerId })
      .select('s.id', 'svc.service_key', 'svc.name as service_name');
    return new Map(rows.map((row) => [row.id, {
      serviceKey: row.service_key || null,
      serviceName: row.service_name || null,
    }]));
  } catch {
    return new Map();
  }
}

// The annual-prepay terms backing a customer's active rows, by id. The TERM
// is the authoritative source of a prepaid per-application figure —
// prepay_amount / coverage_visit_count is exactly what splitCoverageAmount
// divides — so reading it removes any need to infer the figure from the
// allocations still on the schedule (codex #3353 r9: completed visits are
// filtered out of the active rows, so those allocations are a partial view
// whose count and spread say nothing reliable about the term).
// Degrades to an EMPTY Map on error; a prepaid contract with no term then
// withholds rather than guessing.
async function loadPrepaidTermsById(database, rows) {
  const termIds = [...new Set(rows.map((row) => row.annual_prepay_term_id).filter(Boolean))];
  if (!termIds.length) return new Map();
  try {
    // Through coveredTermsAsOf, NOT a raw term read (codex #3353 r10/r11):
    // that query is the repo's definition of coverage whose money is still
    // live — it excludes cancelled terms and revokes coverage whose prepay
    // invoice went void, refunded, or disputed. A raw read returns the
    // original amount for a term the customer no longer holds. No date window
    // (null), matching annualPrepayCoversVisit: the stamp allocates specific
    // prepaid dollars to the visit regardless of where it sits on the
    // calendar.
    const { coveredTermsAsOf } = require('./annual-prepay-renewals');
    // customer_id and coverage_service_type come along so the caller can apply
    // annualPrepayCoversVisit's remaining two guards in memory (codex #3353
    // r12) — a batched equivalent of the canonical predicate rather than a
    // per-row async call, since this loader also runs on the estimate-save
    // path where N extra queries would be a real cost.
    const terms = await coveredTermsAsOf(database, null)
      .whereIn('t.id', termIds)
      .select('t.id', 't.prepay_amount', 't.coverage_visit_count', 't.customer_id', 't.coverage_service_type');
    return new Map(terms.map((term) => [String(term.id), term]));
  } catch {
    // NULL, not an empty Map: "this term is not in the covered set" and "the
    // coverage query failed" mean opposite things now. The first says
    // coverage lapsed, so the visit bills its scheduled price; the second
    // says we don't know, and a customer who may be prepaid must not be
    // quoted the undiscounted price on a guess.
    return null;
  }
}

// Customer-facing cadence wording. "Every other month" beats the catalog's
// "bimonthly", which reads as twice-a-month to half the people who see it.
// 'bi_monthly' is billing-cadence's normalized key; 'bimonthly' is the
// catalog's spelling of the same cadence — both land on the same wording.
const CADENCE_LABEL = {
  monthly: 'Monthly',
  monthly_nth_weekday: 'Monthly',
  bi_monthly: 'Every other month',
  bimonthly: 'Every other month',
  every_6_weeks: 'Every 6 weeks',
  quarterly: 'Quarterly',
  triannual: 'Every 4 months',
  every_4_months: 'Every 4 months',
  semiannual: 'Twice a year',
  biannual: 'Twice a year',
  annual: 'Annual',
  yearly: 'Annual',
  seasonal: 'Seasonal',
  seasonal_feb_oct: 'Seasonal (Feb–Oct)',
};

function cadenceLabelFor(frequency) {
  const key = String(frequency || '').trim().toLowerCase();
  if (!key) return null;
  return CADENCE_LABEL[key] || key.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// Explicit unit identity of a stamped address (null when none), extracted
// with the same primitives sameStreetAddress uses internally so the two can
// never disagree about what counts as a unit.
function stampedUnitKey(address) {
  const line = parseRawAddress(String(address || '')).line1 || String(address || '').split(',')[0];
  return unitLineValueKey(splitStreetLineUnit(line).unit) || null;
}

// Staff-facing account snapshot used before pricing an expansion estimate.
// It says what the customer actively buys and what they currently spend per
// application. Paid invoice history is authoritative; the scheduled-service
// estimate is an explicit fallback, never presented as an actual payment.
async function loadCurrentServiceSpendContext(database, customerId, { existingRows = null } = {}) {
  if (!customerId) return {
    existingServiceKeys: [],
    currentServices: [],
    currentSpendPerVisitTotal: 0,
    currentTier: null,
    currentTierLabel: null,
    currentDiscountPct: 0,
  };

  const rows = Array.isArray(existingRows)
    ? existingRows
    : await loadActiveRecurringServiceRows(database, customerId);
  const qualifyingRows = Array.isArray(existingRows)
    ? existingRows
    : await loadExistingRecurringQualifyingRows(database, customerId);
  // qualifyingKeysForRow, not a re-derivation from service_type text: it is
  // the SAME catalog-authoritative reducer loadExistingRecurringQualifyingRows
  // qualified these rows with, so the tier families here match the ones that
  // path selected. Re-reading service_type reported the stale family — the
  // display half of the drift Codex flagged. Gate-off rows carry no catalog
  // fields, so it falls back to service_type exactly as before.
  const existingServiceKeys = [...new Set(qualifyingRows
    .flatMap((row) => qualifyingKeysForRow(row))
    .filter(Boolean))];
  const currentTier = existingServiceKeys.length ? determineWaveGuardTier(existingServiceKeys) : null;
  const cadenceByRowId = await loadCadenceByRowId(database, customerId);
  const catalogIdentityByRowId = await loadCatalogIdentityByRowId(database, customerId);
  // AFTER the identity load: paid invoices resolve their family through the
  // visit they were minted for, under the same gated rule as the rows.
  const lastPaidByKey = await loadLastPaidSpendByKey(database, customerId, catalogIdentityByRowId);
  const addonRowIds = await loadAddonRowIds(database, rows);
  // ET calendar day — scheduled_date is a pg DATE column, read as the stored
  // day (repo convention), so the cutoff must be the ET day too.
  const { etDateString } = require('../utils/datetime-et');
  const todayEt = etDateString();
  const prepaidTermsById = await loadPrepaidTermsById(database, rows);
  // Best-effort: the customer row backs the stamped per-application /
  // monthly-rate basis of last resort below. A failed load simply leaves
  // those fallbacks unavailable, exactly as before they existed.
  const customer = await database('customers').where({ id: customerId }).first().catch(() => null);
  const byKey = new Map();
  const componentKeysByKey = new Map();
  const componentRowsByKey = new Map();
  for (const row of rows) {
    // Catalog identity decides what this row IS, not its (possibly stale)
    // service_type text — see authoritativeServiceText.
    const identityText = authoritativeServiceText(row, catalogIdentityByRowId.get(row.id));
    const key = accountServiceKey(identityText);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
    const components = componentKeysByKey.get(key) || new Set();
    const componentRows = componentRowsByKey.get(key) || new Map();
    accountServiceKeys(identityText).forEach((component) => {
      components.add(component);
      if (!componentRows.has(component)) componentRows.set(component, []);
      componentRows.get(component).push(row);
    });
    componentKeysByKey.set(key, components);
    componentRowsByKey.set(key, componentRows);
  }

  const currentServices = [...byKey.entries()].map(([key, serviceRows]) => {
    const lastPaid = lastPaidByKey[key] || null;
    // Rows that share a stamped property address are successive visits of ONE
    // contract (a single per-visit price); distinct addresses are SEPARATE
    // per-property contracts that must EACH count toward spend — a
    // multi-property customer's second pest contract is real recurring spend,
    // not a duplicate visit row. Address grouping is only trusted when every
    // row is stamped: a mixed known/unknown set could split one contract into
    // two buckets and double-count it, so it collapses to the single-contract
    // treatment.
    const propertySplit = serviceRows.length > 0
      && serviceRows.every((row) => !!row.effective_service_address);
    // Clustered with the canonical street/unit comparator, never raw string
    // equality — '123 Main Street' vs '123 Main St' (or a stamp corrected
    // between generated visits) is formatting drift on ONE contract and must
    // not add its price once per spelling, while two explicit different
    // units at the same street are separate contracts. Deterministic in two
    // phases regardless of DB row order (the source query has none): rows
    // are processed in a canonical sort and explicit-unit rows cluster FIRST
    // on exact street+unit identity, then unitless rows attach.
    // sameStreetAddress treats a missing unit as matching any unit, so a
    // unitless stamp seen first would otherwise swallow Unit 101 AND Unit
    // 102 into one group — proven-distinct units must never merge. A
    // unitless row matching explicit-unit groups folds into the first
    // (canonical-order) match: an ambiguous stamp is treated as a sloppy
    // stamp of an EXISTING unit contract, never minted as an extra contract,
    // so spend is never double-counted; the residual understatement (it
    // could be a genuine additional contract) is deterministic and
    // conservative. Each group keeps its first row's raw stamp for display.
    let contractGroups;
    if (propertySplit) {
      const orderedRows = [...serviceRows].sort((a, b) => (
        String(a.effective_service_address).localeCompare(String(b.effective_service_address))
        || String(a.id).localeCompare(String(b.id))
      ));
      const unitGroups = [];
      const unitlessRows = [];
      for (const row of orderedRows) {
        if (!stampedUnitKey(row.effective_service_address)) {
          unitlessRows.push(row);
          continue;
        }
        const group = unitGroups.find((candidate) => sameStreetAddress(candidate.address, row.effective_service_address));
        if (group) group.rows.push(row);
        else unitGroups.push({ address: row.effective_service_address, rows: [row] });
      }
      const unitlessGroups = [];
      for (const row of unitlessRows) {
        const unitMatch = unitGroups.find((candidate) => sameStreetAddress(candidate.address, row.effective_service_address));
        if (unitMatch) {
          unitMatch.rows.push(row);
          continue;
        }
        const group = unitlessGroups.find((candidate) => sameStreetAddress(candidate.address, row.effective_service_address));
        if (group) group.rows.push(row);
        else unitlessGroups.push({ address: row.effective_service_address, rows: [row] });
      }
      contractGroups = [...unitGroups, ...unitlessGroups];
    } else {
      contractGroups = [{ address: null, rows: serviceRows }];
    }
    const contracts = contractGroups.map(({ address, rows: contractRows }) => {
      // The NEXT upcoming priced appointment, not whichever row the unordered
      // query happened to return first (codex #3353 r11). Mixed-price
      // contracts are a supported shape — a newly repriced future visit sits
      // beside older ones — so "first positive row" could present either
      // price across reloads of identical data. Earliest scheduled day with a
      // row-id tiebreak, exactly how the extension path in this file picks
      // its basis: the figure the customer actually pays next.
      // PAST rows are excluded first (codex #3359): loadActiveRecurringServiceRows
      // filters status but not date, so a stale past pending visit sorts ahead
      // of every future appointment and an ascending sort would deterministically
      // quote its old price. A visit still en_route/on_site across ET midnight
      // is today's work and stays eligible — same live-in-progress exception the
      // ownership path makes.
      const LIVE_IN_PROGRESS = new Set(['en_route', 'on_site', 'in_progress']);
      const scheduled = [...contractRows]
        .filter((row) => rowServicePrice(row, addonRowIds) != null)
        .filter((row) => {
          if (LIVE_IN_PROGRESS.has(String(row.status || '').toLowerCase())) return true;
          const day = visitDateKey(row.scheduled_date);
          return !!day && day >= todayEt;
        })
        .sort((a, b) => {
          const dayA = visitDateKey(a.scheduled_date) || '';
          const dayB = visitDateKey(b.scheduled_date) || '';
          if (dayA !== dayB) return dayA.localeCompare(dayB);
          return String(a.id).localeCompare(String(b.id));
        })[0];
      const scheduledPerVisit = scheduled ? rowServicePrice(scheduled, addonRowIds) : null;
      // Annual-prepay coverage: prepaid_amount is the DISCOUNTED amount the
      // customer ACTUALLY PAID for the visit, while estimated_price stays the
      // undiscounted list price. A panel captioned "currently pays per
      // application" must not quote the list figure ($120 shown for a visit
      // prepaid at $114). Same basis rule the extension logic in this file
      // already applies: honest only when the contract is UNIFORMLY prepaid
      // at one allocation — a mixed or uneven contract keeps the scheduled
      // price rather than picking one row's allocation to stand for all.
      // A prepaid contract's per-application figure comes from the TERM, not
      // from the allocations left on the schedule (codex #3353 r9).
      // prepay_amount / coverage_visit_count is exactly the number
      // splitCoverageAmount divides, so it is right regardless of how the
      // cent remainder landed or how many visits have already completed —
      // and completed visits ARE filtered out of these rows, which is what
      // made every previous attempt to infer it from them wrong (r7's
      // exact-cents check, r8's spread bound).
      //
      // ONE term only: two terms collapsed into one address contract have no
      // single honest per-application figure. No term, no usable amount, or
      // no visit count withholds too — a paid term disproves the scheduled
      // price, so there is nothing safe to fall back to.
      const prepaidTermIds = [...new Set(contractRows.map((row) => row.annual_prepay_term_id).filter(Boolean))];
      // LIVE coverage is the per-visit prepaid_amount stamp, not the term link
      // (codex #3353 r10). When a prepay payment is voided, refunded, or
      // disputed, clearPrepaidStampsForTerm nulls the stamps on the remaining
      // visits so they bill normally again but DELIBERATELY keeps
      // annual_prepay_term_id for audit — its own comment says "billing-skip
      // keys on prepaid_amount, which is now null". Keying on the audit link
      // alone (my r9 refactor dropped this check) reports cancelled coverage
      // as still prepaid, overriding the price those visits will now bill.
      // Reading the same signal billing reads is the point.
      // The METHOD is what makes a stamp the annual term's (codex #3353 r11).
      // applyPrepaidCoverageForTerm deliberately preserves an independent
      // cash/Zelle stamp while attachScheduledServices may still link that row
      // to the term, so a positive amount + term link is NOT proof the annual
      // term paid for it — that repeats r10's audit-link mistake with a
      // positive but unrelated stamp. These are the same three conditions
      // annualPrepayCoversVisit checks before consulting the term.
      const { ANNUAL_PREPAY_PREPAID_METHOD } = require('./annual-prepay-renewals');
      const { serviceMatchesCoverage, normalizeCoverageServiceType } = require('./annual-prepay-renewals')._private;
      // The remaining two guards from annualPrepayCoversVisit (codex #3353
      // r12), applied in memory against the batched terms:
      //  - the term must belong to THIS customer, so a stale stamp pointing at
      //    another customer's live term can't claim coverage;
      //  - and when the term declares a coverage service, the stamped visit
      //    must still BE that service. Coverage-selection cleanup is
      //    best-effort, so an appointment retyped out of the term's coverage
      //    keeps its stamp — completion billing rejects that coverage, and
      //    this panel must not divide the term amount under the new service.
      // Legacy terms with no coverage_service_type never had a service to
      // match, exactly as the canonical predicate treats them.
      const rowCoveredByTerm = (row) => {
        if (!row.annual_prepay_term_id) return false;
        if (!(Number(row.prepaid_amount) > 0)) return false;
        if (row.prepaid_method !== ANNUAL_PREPAY_PREPAID_METHOD) return false;
        const term = prepaidTermsById?.get(String(row.annual_prepay_term_id));
        if (!term) return false;
        if (term.customer_id != null && String(term.customer_id) !== String(customerId)) return false;
        if (term.coverage_service_type && row.service_type
          && !serviceMatchesCoverage(row, normalizeCoverageServiceType(term.coverage_service_type))) {
          return false;
        }
        return true;
      };
      const fullyPrepaid = contractRows.length > 0 && contractRows.every(rowCoveredByTerm);
      // Rows carrying a term link that did NOT qualify above: coverage was
      // cancelled (stamps cleared, link kept for audit) or the term's money is
      // no longer live. Those visits bill their scheduled price now, so any
      // invoice predating the prepay is superseded.
      const lapsedPrepaidLink = !fullyPrepaid
        && prepaidTermsById !== null
        && contractRows.some((row) => !!row.annual_prepay_term_id);
      // Coverage lookup failed outright: any row carrying a term link is of
      // UNKNOWN status, so no basis is trustworthy for this contract.
      const prepaidStatusUnknown = prepaidTermsById === null
        && contractRows.some((row) => !!row.annual_prepay_term_id);
      const prepaidTerm = (fullyPrepaid && prepaidTermIds.length === 1)
        ? prepaidTermsById.get(String(prepaidTermIds[0]))
        : null;
      const termAmount = Number(prepaidTerm?.prepay_amount);
      const termVisits = Number(prepaidTerm?.coverage_visit_count);
      const prepaidPerVisit = (termAmount > 0 && Number.isInteger(termVisits) && termVisits > 0)
        ? round2(termAmount / termVisits)
        : null;
      const uniformlyPrepaid = prepaidPerVisit != null;
      // Cadence belongs to the CONTRACT, not the family (codex #3353 r4):
      // monthly pest at one property and quarterly at another are different
      // schedules, and picking the first resolvable row for both would be an
      // arbitrary choice out of an unordered query.
      const contractCadence = contractRows
        .map((row) => cadenceByRowId.get(row.id))
        .find((entry) => entry && (entry.frequency || entry.visitsPerYear)) || null;
      return {
        serviceAddress: address,
        scheduledPerVisit,
        // The figure this contract actually bills at — the paid allocation
        // when prepaid, else the scheduled price. A FULLY prepaid contract
        // whose allocations are too spread to average shows NOTHING rather
        // than the list price: the active term is positive evidence against
        // that price, so substituting it would be the same mistake as
        // inheriting a catalog cadence over a live one. A PARTLY prepaid
        // contract keeps the scheduled price, which is genuine for the
        // visits that aren't prepaid.
        perVisit: prepaidPerVisit ?? ((fullyPrepaid || prepaidStatusUnknown) ? null : scheduledPerVisit),
        prepaid: uniformlyPrepaid,
        // A prepaid contract whose allocations could not be averaged: no
        // figure of ANY provenance is trustworthy for it, so the family-level
        // precedence must suppress the historical-invoice fallback too, not
        // just the scheduled price (codex #3353 r8 — r7 suppressed only the
        // latter, so a superseded per-visit invoice still surfaced).
        prepaidWithoutBasis: (fullyPrepaid && prepaidPerVisit == null) || prepaidStatusUnknown,
        // Per-contract provenance: one prepaid property alongside one billing
        // at its scheduled price must not describe BOTH as a paid allocation.
        spendSource: prepaidPerVisit != null
          ? 'prepaid_allocation'
          : ((!fullyPrepaid && !prepaidStatusUnknown && scheduledPerVisit != null)
            ? 'scheduled_estimate'
            : 'unavailable'),
        cadenceLabel: cadenceLabelFor(contractCadence?.frequency),
        visitsPerYear: contractCadence?.visitsPerYear ?? null,
        lapsedPrepaidLink,
        activeScheduledVisits: contractRows.length,
      };
    });
    // The account-wide last-paid amount reflects ONE contract (no property
    // linkage on invoices), so the invoice basis only applies to a
    // single-contract key; per-property contracts each use their own
    // scheduled price rather than one contract's invoice standing in for all.
    const usableLastPaid = contracts.length === 1 ? lastPaid : null;
    const scheduledPerVisit = contracts.some((contract) => contract.scheduledPerVisit != null)
      ? round2(contracts.reduce((sum, contract) => sum + (Number(contract.scheduledPerVisit) || 0), 0))
      : null;
    // The billed basis across this key's contracts, prepaid allocations
    // included. NOTE this is a SUM over per-property contracts — it is the
    // account's recurring spend for the family, NOT one visit's charge, so a
    // multi-contract key must never be rendered as a single per-application
    // price (each contract carries its own figure above).
    const effectivePerVisit = contracts.some((contract) => contract.perVisit != null)
      ? round2(contracts.reduce((sum, contract) => sum + (Number(contract.perVisit) || 0), 0))
      : null;
    // Family-level cadence speaks ONLY when every contract agrees (codex
    // #3353 r4). Contracts on different schedules each carry their own above,
    // and the family stays silent rather than displaying one property's
    // cadence over both. Single-contract keys — the overwhelming majority,
    // and the only shape the monthly-rate division below can apply to —
    // are unaffected.
    const distinctCadences = new Set(contracts.map(
      (contract) => `${contract.cadenceLabel || ''}|${contract.visitsPerYear ?? ''}`,
    ));
    const agreedCadence = distinctCadences.size === 1 ? contracts[0] : null;
    const cadenceLabel = agreedCadence?.cadenceLabel ?? null;
    const visitsPerYear = agreedCadence?.visitsPerYear ?? null;
    // Customer-level billing stamps are a WHOLE-PLAN figure: the converter
    // only writes customers.per_application_fee for a single-recurring-unit
    // accept, and monthly_rate covers everything the customer buys.
    // Attributing either to one service on a multi-service account would
    // overstate that service, so both are gated to an account carrying
    // exactly ONE recurring service with ONE contract — the same shape the
    // converter's own stamp gate requires. Last resort, below both real
    // evidence sources: legacy and multi-unit plans previously read
    // "unavailable" here, which told the office nothing at all.
    //
    // COMPONENT count, not just key count (codex #3353 r1): accountServiceKey
    // groups a COMBINED row ("Quarterly Pest + Termite Bait Station") under
    // its FIRST component alone, so byKey.size is 1 while the account really
    // carries two recurring families. Without this the whole plan total gets
    // attributed to Pest Control's per-application line — the exact
    // overstatement this gate exists to prevent, just arriving through a
    // combined row instead of two rows.
    const componentCount = (componentKeysByKey.get(key) || new Set([key])).size;
    const singleUnitAccount = byKey.size === 1 && contracts.length === 1 && componentCount === 1;
    const stampedPerApplication = (singleUnitAccount
      && customer?.billing_mode === 'per_application'
      && Number(customer.per_application_fee) > 0)
      ? round2(customer.per_application_fee)
      : null;
    // Monthly members never pay a per-application figure — this is the
    // arithmetic equivalent for comparison against a quote, and the panel
    // labels its source so staff never reads it as a charged amount.
    const monthlyDerivedPerApplication = (singleUnitAccount
      && stampedPerApplication == null
      && Number(customer?.monthly_rate) > 0
      && visitsPerYear > 0)
      ? round2((Number(customer.monthly_rate) * 12) / visitsPerYear)
      : null;
    // An ACTIVE uniformly-prepaid contract outranks paid-invoice history
    // (codex #3353 r3): the annual-prepay invoice itself carries no
    // service_type, so a customer who paid per-visit invoices BEFORE moving
    // to prepay still has those older rows in lastPaidByKey — and they
    // describe a superseded billing arrangement. The allocation describes
    // the term the customer is on now, so it wins.
    const activePrepaidBasis = contracts.some((contract) => contract.prepaid)
      ? effectivePerVisit
      : null;
    // A prepaid contract with no averageable basis poisons EVERY fallback
    // below it: the paid term disproves the scheduled price, the customer-level
    // stamps, and any older per-visit invoice alike (codex #3353 r8).
    const prepaidWithoutBasis = contracts.some((contract) => contract.prepaidWithoutBasis);
    // After a prepay lapses, the SCHEDULED price outranks invoice history
    // (codex #3353 r11): those visits bill their scheduled price now, and any
    // per-visit invoice from before the prepay describes an arrangement two
    // changes ago. My r10 test missed this by supplying no invoice.
    const lapsedPrepaid = contracts.some((contract) => contract.lapsedPrepaidLink);
    const currentPerVisit = prepaidWithoutBasis
      ? null
      : (activePrepaidBasis
        ?? (lapsedPrepaid ? effectivePerVisit : null)
        ?? usableLastPaid?.amount
        ?? effectivePerVisit
        ?? stampedPerApplication
        ?? monthlyDerivedPerApplication);
    const scheduledDates = serviceRows.map((row) => row.scheduled_date).filter(Boolean).sort();
    const componentServiceAddresses = {};
    const componentServiceAddressesComplete = {};
    for (const [componentKey, componentRows] of componentRowsByKey.get(key) || []) {
      componentServiceAddresses[componentKey] = [...new Set(
        componentRows.map((row) => row.effective_service_address).filter(Boolean),
      )];
      componentServiceAddressesComplete[componentKey] = componentRows.length > 0
        && componentRows.every((row) => !!row.effective_service_address);
    }
    return {
      key,
      keys: [...(componentKeysByKey.get(key) || new Set([key]))],
      // Labelled from the same authoritative text the key was derived from,
      // so the name staff reads can never disagree with the family the tier
      // counted.
      label: accountServiceLabel(
        key,
        authoritativeServiceLabelText(serviceRows[0] || {}, catalogIdentityByRowId.get(serviceRows[0]?.id)),
      ),
      qualifiesForWaveGuard: existingServiceKeys.includes(key),
      // Every property this service is active at — lets duplicate checks
      // scope to the quoted property instead of blocking account-wide.
      serviceAddresses: [...new Set(serviceRows.map((row) => row.effective_service_address).filter(Boolean))],
      // False when ANY active row's property is unknown: the unknown row
      // could cover the quoted street, so the duplicate check must fall back
      // to the account-wide block rather than trust the known-address subset.
      serviceAddressesComplete: serviceRows.length > 0
        && serviceRows.every((row) => !!row.effective_service_address),
      // A combined row contributes its address only to the components it
      // actually contains. Keeping this map separate prevents a pest-only
      // row at property B from making the lawn component of a Pest + Lawn
      // row at property A appear active at both properties.
      componentServiceAddresses,
      componentServiceAddressesComplete,
      currentPerVisit: currentPerVisit ?? null,
      // Visit cadence for display — "Quarterly (4/yr)". Null on either half
      // simply omits that half; the panel never invents a cadence, and a
      // family whose contracts run different schedules stays null here.
      cadenceLabel,
      visitsPerYear,
      // Family-level provenance. With several contracts on DIFFERENT bases
      // (one prepaid, one billing its scheduled price) no single source is
      // true of all of them, so it reports mixed_basis and the per-contract
      // sources above carry the detail (codex #3353 r4).
      spendSource: (() => {
        if (prepaidWithoutBasis) return 'unavailable';
        const contractSources = new Set(contracts.map((contract) => contract.spendSource));
        if (contracts.length > 1 && contractSources.size > 1) return 'mixed_basis';
        if (activePrepaidBasis != null) return 'prepaid_allocation';
        if (lapsedPrepaid && effectivePerVisit != null) return 'scheduled_estimate';
        if (usableLastPaid) return 'last_paid_invoice';
        if (effectivePerVisit != null) return 'scheduled_estimate';
        if (stampedPerApplication != null) return 'per_application_fee';
        if (monthlyDerivedPerApplication != null) return 'monthly_rate_derived';
        return 'unavailable';
      })(),
      // Only when the invoice is what the figure came FROM (codex #3353 r6).
      // When an active prepaid allocation outranks a superseded per-visit
      // invoice, carrying that invoice's date renders as "prepaid allocation
      // · 2026-01-10" and dates the current allocation to the old payment.
      lastPaidAt: (activePrepaidBasis != null || (lapsedPrepaid && effectivePerVisit != null))
        ? null
        : (usableLastPaid?.paidAt || null),
      scheduledPerVisit,
      // One entry per active per-property contract (a single entry when the
      // rows aren't property-split) so multi-property spend stays itemized.
      contracts,
      activeScheduledVisits: serviceRows.length,
      nextScheduledDate: scheduledDates[0] || null,
      // Normalized visit calendar days, deduped and sorted — the
      // tier-upgrade existing-service display names the exact appointments
      // the extension covers, so this uses the SAME callback exclusion the
      // accept-time reprice applies (codex #3338 r7: a free callback visit
      // in the list would present an appointment the new price never
      // touches).
      scheduledVisitDates: [...new Set(serviceRows
        .filter((row) => !isCallbackServiceRow(row))
        .map((row) => visitDateKey(row.scheduled_date)).filter(Boolean))].sort(),
      // Stable row identities of those same appointments — the accept-time
      // extension applies ONLY to rows frozen here (codex #3338 r10: a
      // visit added between save and accept was never shown and must not
      // be repriced or credited; ids survive reschedules where dates
      // don't). Staff-side only — never projected to the public payload.
      // Sorted for determinism — an identity SET whose order must not
      // depend on DB row order (the source query has none).
      scheduledRowIds: serviceRows
        .filter((row) => !isCallbackServiceRow(row))
        .map((row) => row.id).filter(Boolean)
        .sort((a, b) => String(a).localeCompare(String(b))),
      // Any non-callback row funded by an annual-prepay term: the
      // accept-time extension must not reprice the paid term — it credits
      // the difference instead (owner decision 2026-08-10).
      prepaid: serviceRows.some((row) => !isCallbackServiceRow(row) && !!row.annual_prepay_term_id),
    };
  });

  return {
    existingServiceKeys,
    currentServices,
    currentSpendPerVisitTotal: round2(currentServices.reduce(
      (sum, service) => sum + (Number(service.currentPerVisit) || 0),
      0,
    )),
    currentTier: currentTier?.tier || null,
    currentTierLabel: currentTier ? (TIER_LABEL[currentTier.tier] || currentTier.tier) : null,
    currentDiscountPct: currentTier ? Math.round(currentTier.discount * 100) : 0,
  };
}

// The discount rate ACTUALLY applied to the estimate's recurring services,
// derived from the repriced aggregate (annualBeforeDiscount/After). For
// pest_control / tree_shrub the pricing engine's margin guard can cap the tier
// rate, so this can be lower than combinedTier.discount — using it keeps the
// card from advertising a larger member discount than the total includes.
// Falls back to the requested rate when the aggregate isn't available.
function appliedRecurringRate(estData, fallbackRate) {
  const rec = estData?.result?.recurring
    || estData?.engineResult?.recurring
    || estData?.recurring
    || {};
  const before = Number(rec.annualBeforeDiscount);
  const after = Number(rec.annualAfterDiscount);
  if (before > 0 && after >= 0 && after <= before) {
    return Math.max(0, Math.min(1, 1 - after / before));
  }
  const explicit = Number(rec.discount);
  if (explicit >= 0 && explicit <= 1) return explicit;
  return fallbackRate;
}

// Per-service applied rate. The aggregate rate above is a BLEND: when the
// margin guard caps one service (tree_shrub) while the others take the full
// tier rate, dividing the blended savings evenly both understates the
// full-rate services and ADVERTISES a larger discount than the guarded
// service actually received (the exact failure the aggregate fallback exists
// to prevent). The v1-legacy mapper stamps each recurring services[] row with
// its post-WaveGuard annualAfterDiscount, so prefer the row's own
// before/after pair; fall back to the blended rate for shapes that predate
// the per-line net.
function appliedRateForService(estData, key, blendedRate, tierRate) {
  for (const c of recurringCandidates(estData)) {
    if (toQualifyingKey(candidateName(c)) !== key) continue;
    const after = Number(c?.annualAfterDiscount);
    if (!Number.isFinite(after) || after < 0) continue;
    const monthly = Number(c?.monthlyBeforeDiscount ?? c?.monthly ?? c?.mo);
    const perApp = Number(c?.perTreatment ?? c?.perApp ?? c?.perVisit);
    const visits = Number(c?.visitsPerYear ?? c?.visits ?? c?.frequency);
    const before = Number(c?.annualBeforeDiscount ?? c?.annual ?? c?.ann)
      || (monthly > 0 ? monthly * 12 : 0)
      || (perApp > 0 && visits > 0 ? perApp * visits : 0);
    if (!(before > 0) || after > before) continue;
    return Math.max(0, Math.min(tierRate, 1 - after / before));
  }
  return blendedRate;
}

async function computeMembershipContext(database, {
  customerId, estData, streetScope = null, excludeExistingRows = false,
  // Existing-service extension plans freeze ONLY for callers that resolved
  // property scope (codex #3338 r7 agent-scope): admin-estimate-persistence
  // prices priors and threads the per-property street scope, so it opts in;
  // the IB / estimator-engine agent lanes pass no scope, and a
  // secondary-property agent estimate must not freeze (or later reprice)
  // another property's visits. FAIL CLOSED: a future call site that forgets
  // this flag gets tier/upgrade/new-service context but no frozen plan —
  // the review-bell fallback, never a wrong-property write.
  freezeExtensionPlan = false,
  // Street bound for the frozen PLAN alone (codex #3338 r8): the primary-
  // address lane keeps ACCOUNT-WIDE priors pricing (long-standing, ungated),
  // so the tier/upgrade context here must keep matching it — but the plan
  // must never freeze a visit outside the quoted street. Rows at another
  // property stay on the review-bell path. Grouped/secondary estimates pass
  // the global streetScope instead (their pricing scoped the same way), and
  // this bound is then redundant.
  extensionStreetScope = null,
} = {}) {
  try {
    if (!customerId) return null;

    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer || customer.active === false) return null;

    // ── Existing active recurring services on the account ──────
    // Shared loader — same source admin-estimate-persistence.js uses to reprice
    // the estimate, so the displayed tier matches the charged tier. The SAME
    // per-property scope the reprice used must bound the snapshot too (codex
    // #3338 r22): a grouped/secondary-property estimate whose pricing scoped
    // priors to the quoted street must not advertise (or later apply) an
    // extension built from another property's plans — per-property tier rule
    // (#3244). excludeExistingRows mirrors the reprice branch whose street
    // could not be parsed: priors were empty there, so the snapshot sees no
    // existing rows either.
    const existingRows = excludeExistingRows
      ? []
      : await filterRowsToStreet(
        database,
        await loadExistingRecurringQualifyingRows(database, customerId),
        streetScope,
      );

    const existingByKey = new Map();
    for (const row of existingRows) {
      // Combined scheduled-service labels represent every component for
      // membership and cross-sell purposes. A scalar toQualifyingKey call
      // keeps only the first match (for example pest from "Pest + Lawn"),
      // which makes the frozen snapshot disagree with Agent pricing.
      // Catalog-authoritative reducer (codex #3228 r5): the loader returns
      // rows ENRICHED with their catalog identity, and the converter's
      // combined-tier activation reduces through qualifyingKeysForRow — a
      // stale text label ("Pest Control" linked to lawn_care_monthly) must
      // produce the same family here, or the displayed tier disagrees with
      // the activated tier.
      const componentKeys = qualifyingKeysForRow(row);
      for (const key of componentKeys) {
        if (!existingByKey.has(key)) existingByKey.set(key, []);
        existingByKey.get(key).push(row);
      }
    }
    const existingKeys = [...existingByKey.keys()];

    // ── New qualifying services in this estimate ───────────────
    const newKeys = estimateQualifyingKeys(estData || {});
    const addedKeys = newKeys.filter((k) => !existingKeys.includes(k));

    // No membership story to tell if there are no qualifying services on
    // either side (e.g. a one-off rodent job for an existing customer).
    if (existingKeys.length === 0 && addedKeys.length === 0) return null;

    // ── Combine & recompute tier ───────────────────────────────
    const oldTier = determineWaveGuardTier(existingKeys);
    const combinedTier = determineWaveGuardTier([...existingKeys, ...addedKeys]);
    const upgraded = combinedTier.discount > oldTier.discount;
    const delta = combinedTier.discount - oldTier.discount;
    const deltaPct = Math.round(delta * 100);

    // Do NOT pass existingRows here: those are the QUALIFYING rows only, and
    // reusing them would drop non-tier recurring work (rodent bait, palm
    // injection) from the frozen snapshot and underreport
    // currentSpendPerVisitTotal.
    const currentSpend = await loadCurrentServiceSpendContext(database, customerId);
    // Existing-service tier extension (owner decision 2026-08-10, reversing
    // the 2026-08-05 review-bell-only ruling): a tier-RAISING estimate lists
    // the customer's current qualifying services at the combined tier, and
    // accept applies exactly this FROZEN plan (estimate-converter reads these
    // rows), so display and billing move together by construction. Dark
    // behind GATE_WAVEGUARD_EXTEND_EXISTING (money surface): gate off
    // freezes an empty list — nothing is advertised, accept has nothing to
    // apply.
    //
    // Two deliberate exclusions keep every displayed number exactly
    // billable (codex #3338 r3+r4):
    //  - BRONZE-ORIGIN upgrades only (current tier discount 0%). Above
    //    Bronze, delta-points math on an already-discounted contracted
    //    price does not equal the advertised tier rate off the original
    //    basis ($90 Silver-priced at Gold: −5pp gives $85.50, base math
    //    gives $85), and the original basis is unknowable for legacy
    //    contracts — those upgrades stay on the review-bell path until the
    //    owner rules on the math.
    //  - Monthly-lane members bill customers.monthly_rate, which row
    //    repricing never touches — an "applied automatically" card would
    //    diverge from the charge, so they stay on the review-bell path
    //    entirely (the accept-side monthlyLaneMember guard remains as
    //    defense for snapshots frozen before this exclusion).
    const existingServices = [];
    const monthlyLaneMember = (() => {
      // Lazy require: billing-cadence sits near the converter's import web.
      const { customerPreservesMonthlyMembership } = require('./billing-cadence');
      return customerPreservesMonthlyMembership(customer);
    })();
    if (upgraded && oldTier.discount === 0 && !monthlyLaneMember
      && freezeExtensionPlan === true && isEnabled('waveguardExtendExisting')) {
      const { etDateString } = require('../utils/datetime-et');
      const today = etDateString();
      // Quoted-street bound for the plan (codex #3338 r8): on the primary-
      // address lane existingRows are account-wide (matching the priors
      // pricing), so a multi-property customer's other-property series must
      // be filtered out HERE before any family can freeze it. Null when the
      // caller's rows were already street-scoped globally.
      let planEligibleIds = null;
      if (extensionStreetScope) {
        const planScopedRows = await filterRowsToStreet(database, existingRows, extensionStreetScope);
        planEligibleIds = new Set(planScopedRows.map((row) => String(row.id)));
      }
      // The plan is built from the CATALOG-AUTHORITATIVE enriched qualifying
      // rows — the SAME loader + classifier the accept-time apply matches
      // with (codex #3338 r18: a stale service_type label must never freeze
      // a family the apply then fails to find). Rules per family:
      //  - only upcoming, non-callback, single-family rows (a combined
      //    multi-family row cannot carry one family's extension; belt only —
      //    a combined row implies ≥2 families, which the Bronze-origin
      //    check already excludes);
      //  - one property (distinct stamped addresses are separate contracts
      //    one figure cannot honestly cover);
      //  - only appointments SHARING the displayed basis freeze (codex
      //    #3338 r19 sibling: a mixed-price contract must not list
      //    appointments the apply would then skip);
      //  - the PERSISTED price is the rounded tier rate; the savings figure
      //    derives from it (codex #3338 r20 — never an extra half-cent of
      //    discount from rounding the savings first).
      for (const [familyKey, familyRows] of existingByKey) {
        // A family this estimate re-quotes is already a priced line of the
        // estimate itself — never also listed as an existing extension.
        if (newKeys.includes(familyKey)) continue;
        const eligibleRows = familyRows.filter((row) => {
          if (planEligibleIds && !planEligibleIds.has(String(row.id))) return false;
          if (isCallbackServiceRow(row)) return false;
          const day = visitDateKey(row.scheduled_date);
          if (!day || day < today) return false;
          return qualifyingKeysForRow(row).length === 1;
        });
        if (!eligibleRows.length) continue;
        const distinctAddresses = new Set(eligibleRows.map((row) => row.effective_service_address).filter(Boolean));
        if (distinctAddresses.size > 1) continue;
        // Composite visits AND pre-minted invoices park at SNAPSHOT time
        // too (codex #3338 r24 + r7 sibling): a row with
        // scheduled_service_addons nets primary + add-ons into one
        // estimated_price — discounting that figure would discount the
        // non-qualifying add-ons — and a visit whose invoice is already
        // minted (Charge Now / pre-completion mint) keeps billing the old
        // amount after a row-only reprice, so the accept parks it. Accept
        // re-probes both as the belt; excluding here keeps the card from
        // listing an appointment the apply will park. FAIL CLOSED: probe
        // failure parks the whole family.
        let compositeIds;
        try {
          const rowIds = eligibleRows.map((row) => row.id);
          const [addonRows, mintedRows] = await Promise.all([
            database('scheduled_service_addons')
              .whereIn('scheduled_service_id', rowIds)
              .select('scheduled_service_id'),
            database('invoices')
              .whereIn('scheduled_service_id', rowIds)
              .whereNot('status', 'void')
              .select('scheduled_service_id'),
          ]);
          compositeIds = new Set([
            ...addonRows.map((row) => String(row.scheduled_service_id)),
            ...mintedRows.map((row) => String(row.scheduled_service_id)),
          ]);
        } catch (probeErr) {
          logger.warn(`[membership-context] extension addon/invoice probe failed — family ${familyKey} left to the review path: ${probeErr.message}`);
          continue;
        }
        const simpleRows = eligibleRows.filter((row) => !compositeIds.has(String(row.id)));
        if (!simpleRows.length) continue;
        const prepaidEligible = simpleRows.filter((row) => !!row.annual_prepay_term_id);
        // Prepaid families display the PAID allocation as the basis (codex
        // #3338 r23 sibling): the accept-time credit is pct × prepaid_amount,
        // so a list-price strikethrough would disclose a larger figure than
        // the ledger movement. Honest only when the family is UNIFORMLY
        // prepaid at one allocation — mixed prepaid/pay-per-visit or uneven
        // allocations stay on the review path.
        let basis;
        let basisRows;
        if (prepaidEligible.length > 0) {
          if (prepaidEligible.length !== simpleRows.length) continue;
          const firstAllocation = Number(simpleRows.find((row) => Number(row.prepaid_amount) > 0)?.prepaid_amount);
          if (!(firstAllocation > 0)) continue;
          // EXACT cents (codex #3338 r9): a split-remainder term's odd cent
          // is a different allocation — one shared frozen savings would be
          // a cent off on it. Non-uniform terms stay on the review path.
          if (!simpleRows.every((row) => sameCents(row.prepaid_amount, firstAllocation))) continue;
          basis = firstAllocation;
          basisRows = simpleRows;
        } else {
          // Deterministic basis (codex #3338 r10): the loader carries no
          // ORDER BY, so "first positive price" would follow DB row order —
          // the same unchanged estimate could freeze a different price
          // cohort per save. The basis is the price of the NEXT upcoming
          // priced appointment (earliest scheduled date, row id as the
          // tiebreak): the figure the customer would actually pay next.
          // (The prepaid branch above needs no ordering — it is
          // uniform-allocation-or-park, so every cohort choice ends the
          // same way.)
          const orderedRows = [...simpleRows].sort((a, b) => {
            const dayA = visitDateKey(a.scheduled_date) || '';
            const dayB = visitDateKey(b.scheduled_date) || '';
            if (dayA !== dayB) return dayA.localeCompare(dayB);
            return String(a.id).localeCompare(String(b.id));
          });
          const basisRow = orderedRows.find((row) => Number(row.estimated_price) > 0);
          basis = Number(basisRow?.estimated_price);
          if (!(basis > 0)) continue; // no billable basis to discount
          basisRows = simpleRows.filter((row) => sameCents(row.estimated_price, basis));
        }
        const frozenRows = basisRows;
        const newPerVisit = round2(basis * (1 - delta));
        const perVisitSavings = round2(basis - newPerVisit);
        if (!(perVisitSavings > 0)) continue;
        const upcomingVisitDates = [...new Set(frozenRows.map((row) => visitDateKey(row.scheduled_date)).filter(Boolean))].sort();
        existingServices.push({
          key: familyKey,
          keys: [familyKey],
          label: SERVICE_LABEL[familyKey] || accountServiceLabel(familyKey, frozenRows[0]?.service_type),
          currentPerVisit: round2(basis),
          extraDiscountPct: deltaPct,
          perVisitSavings,
          newPerVisit,
          remainingVisits: upcomingVisitDates.length || null,
          upcomingVisitDates,
          // Frozen appointment identities the accept-time apply is pinned
          // to (staff-side; deliberately NOT in publicMembershipView).
          // Sorted for determinism — DB row order carries no meaning.
          rowIds: frozenRows.map((row) => row.id).filter(Boolean)
            .sort((a, b) => String(a).localeCompare(String(b))),
          prepaid: frozenRows.some((row) => !!row.annual_prepay_term_id),
        });
      }
      // Deterministic family order regardless of DB row order.
      existingServices.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    }

    // ── New-service member discount ────────────────────────────
    // Use the rate actually applied to the recurring total (margin-guard caps
    // included), never more than the combined tier rate, so the advertised
    // discount can't exceed what the charged total includes.
    const appliedRate = Math.min(combinedTier.discount, appliedRecurringRate(estData, combinedTier.discount));
    const newServices = addedKeys.map((key) => {
      const rate = appliedRateForService(estData, key, appliedRate, combinedTier.discount);
      const monthly = estimateMonthlyFor(estData, key);
      const perApplication = estimatePerApplicationFor(estData, key);
      return {
        key,
        label: SERVICE_LABEL[key] || key,
        discountPct: Math.round(rate * 100),
        monthlySavings: monthly ? round2(monthly * rate) : null,
        perApplicationSavings: perApplication ? round2(perApplication * rate) : null,
      };
    });

    return {
      // "Existing customer" means the account already carries qualifying
      // recurring plan services — NOT merely that a customers row exists. A
      // brand-new lead can have a customers row (from intake/onsite) with zero
      // services; flagging it existing wrongly suppressed the annual-prepay
      // option and the WaveGuard setup fee on a fresh signup estimate. Mirror
      // the live plan-customer check in estimate-deposits.js, which keys off
      // the same loadExistingRecurringQualifyingRows rows.
      isExistingCustomer: existingKeys.length > 0,
      firstName: customer.first_name || null,
      tier: combinedTier.tier,
      tierLabel: TIER_LABEL[combinedTier.tier] || 'Bronze',
      tierDiscountPct: Math.round(combinedTier.discount * 100),
      upgrade: upgraded
        ? {
            fromLabel: TIER_LABEL[oldTier.tier] || 'Bronze',
            toLabel: TIER_LABEL[combinedTier.tier] || 'Bronze',
            deltaPct,
            addedServiceLabels: addedKeys.map((k) => SERVICE_LABEL[k] || k),
          }
        : null,
      // Raw qualifying keys already on the account — lets the public page
      // pick a cross-sell the customer doesn't already have (existingServices
      // above is only populated on a tier upgrade).
      existingServiceKeys: existingKeys,
      // Dynamic (2026-08-10): with a populated extension the legacy SSR
      // membership block switches to its "including the ones you already
      // have" copy branch and renders the existing-service rows — both
      // branches predate this feature and are already tested.
      discountAppliesTo: existingServices.length ? 'new_and_existing_services' : 'new_services_only',
      currentServices: currentSpend.currentServices,
      currentSpendPerVisitTotal: currentSpend.currentSpendPerVisitTotal,
      existingServices,
      newServices,
    };
  } catch (err) {
    logger.warn(`[membership-context] compute skipped for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// Public (unauthenticated estimate-link) projection of the membership
// snapshot. The stored snapshot keeps the full staff context — currentServices
// with per-property addresses, per-contract prices, last-payment dates,
// upcoming visit dates, currentSpendPerVisitTotal — for admin surfaces and
// accept-time logic, but anyone holding or forwarded the token link can read
// the public route's JSON, so it gets ONLY the fields the customer page
// actually renders (EstimateViewPage MembershipCard / estimateAddServiceOffer
// and the SSR membership block). WHITELIST, never blacklist: an additive
// snapshot field defaults to staff-only unless it is projected here.
function publicMembershipView(snapshot, { committed = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  // Which snapshots may project their frozen extension rows:
  //  - LIVE estimates follow the kill switch (codex #3338 r1) — a plan
  //    frozen while the gate was on must not keep displaying after the
  //    switch turns the accept-side apply off.
  //  - COMMITTED estimates (accepted/price-locked; callers pass
  //    committed=true) follow the persisted OUTCOME instead (codex #3338
  //    r19): only an extension that actually APPLIED is a permanent record
  //    the recap must keep showing regardless of the gate — an accept
  //    whose plan merely parked for review moved no money, so its recap
  //    must not read as repriced. Legacy accepted rows carry no outcome
  //    and project nothing, correctly.
  // Computed first so the discountAppliesTo discriminator below can follow
  // the PROJECTED rows.
  const showFrozenExtension = committed === true
    ? snapshot.extensionOutcome?.applied === true
    : isEnabled('waveguardExtendExisting');
  // A committed recap additionally projects ONLY the families the apply
  // honored IN FULL (codex #3338 r26): applied=true says SOME money moved,
  // not that every frozen family did — a family that parked (price drift,
  // add-on visit, minted invoice, allocation gap) or was only partially
  // repriced must not read as repriced on the read-only recap. The outcome's
  // appliedFamilies list is authoritative; FAIL CLOSED when it is absent
  // (no legacy applied outcomes exist — the gate has never shipped on).
  const committedFamilyFilter = committed === true
    ? new Set((Array.isArray(snapshot.extensionOutcome?.appliedFamilies)
      ? snapshot.extensionOutcome.appliedFamilies
      : []).map(String))
    : null;
  const projectedExistingServices = (showFrozenExtension && Array.isArray(snapshot.existingServices)
    ? snapshot.existingServices
    : [])
    .filter((service) => !committedFamilyFilter || committedFamilyFilter.has(String(service?.key)))
    .map((service) => ({
      key: service?.key ?? null,
      label: service?.label ?? null,
      currentPerVisit: service?.currentPerVisit ?? null,
      newPerVisit: service?.newPerVisit ?? null,
      extraDiscountPct: service?.extraDiscountPct ?? null,
      perVisitSavings: service?.perVisitSavings ?? null,
      remainingVisits: service?.remainingVisits ?? null,
      upcomingVisitDates: Array.isArray(service?.upcomingVisitDates)
        ? service.upcomingVisitDates.filter(Boolean)
        : [],
      prepaid: service?.prepaid ?? null,
    }));
  return {
    isExistingCustomer: snapshot.isExistingCustomer === true,
    firstName: snapshot.firstName ?? null,
    tier: snapshot.tier ?? null,
    tierLabel: snapshot.tierLabel ?? null,
    tierDiscountPct: snapshot.tierDiscountPct ?? null,
    // Follows the PROJECTED rows, not the frozen value (codex #3338 r8): a
    // 'new_and_existing_services' snapshot whose rows the gate now hides
    // must not leave the SSR upgrade blurb promising existing-service
    // coverage the accept side won't deliver.
    discountAppliesTo: projectedExistingServices.length
      ? (snapshot.discountAppliesTo ?? null)
      : (snapshot.discountAppliesTo ? 'new_services_only' : null),
    // Keys only — the cross-sell picker needs what the account already has,
    // never where or for how much.
    existingServiceKeys: Array.isArray(snapshot.existingServiceKeys)
      ? snapshot.existingServiceKeys.filter(Boolean)
      : [],
    upgrade: snapshot.upgrade
      ? {
        fromLabel: snapshot.upgrade.fromLabel ?? null,
        toLabel: snapshot.upgrade.toLabel ?? null,
        deltaPct: snapshot.upgrade.deltaPct ?? null,
        addedServiceLabels: Array.isArray(snapshot.upgrade.addedServiceLabels)
          ? snapshot.upgrade.addedServiceLabels.filter(Boolean)
          : [],
      }
      : null,
    // The customer's own current price, discounted price, and visit dates
    // are projected DELIBERATELY (owner decision 2026-08-10): the estimate
    // page renders "your Pest Control: $X → $Y / application" with the
    // appointments it covers. Addresses, payment history, per-contract
    // breakdowns, and the frozen rowIds stay staff-only as before.
    existingServices: projectedExistingServices,
    newServices: (Array.isArray(snapshot.newServices) ? snapshot.newServices : [])
      .map((service) => ({
        key: service?.key ?? null,
        label: service?.label ?? null,
        discountPct: service?.discountPct ?? null,
        monthlySavings: service?.monthlySavings ?? null,
        perApplicationSavings: service?.perApplicationSavings ?? null,
      })),
  };
}

// View-time accessor. Returns the membership snapshot that was frozen onto the
// estimate at save time (estimate_data.membershipSnapshot), so the card can
// NEVER diverge from the price saved/charged with the estimate. Estimates
// created before this snapshot existed (or that aren't customer-linked) simply
// have no snapshot and render no card — no risk of advertising an unapplied
// discount.
function buildEstimateMembershipContext(estimate) {
  try {
    const estData = parseEstimateData(estimate);
    const snapshot = estData && estData.membershipSnapshot;
    return snapshot && snapshot.isExistingCustomer ? snapshot : null;
  } catch {
    return null;
  }
}

module.exports = {
  buildEstimateMembershipContext,
  computeMembershipContext,
  loadCurrentServiceSpendContext,
  publicMembershipView,
};
