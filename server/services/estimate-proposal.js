// ============================================================
// estimate-proposal.js — Commercial proposal model + totals
//
// A "proposal" is the structured, multi-building line-item view of an
// estimate used to render a formal commercial bid PDF (two towers + N
// lake houses, each its own service profile). It lives in
// `estimates.estimate_data.proposal` (JSONB — no schema migration) and is
// authored by the operator in the Commercial Proposal panel.
//
// This module is the single place that:
//   1. normalizes whatever is stored into a stable shape (normalizeProposal)
//   2. computes recurring / one-time / tax totals (computeProposalTotals)
//
// Tax is intentionally NOT a business-rule engine here. Taxability is a
// CPA-signed judgement that the tax module owns; this module only sums the
// per-line `taxable` flags the operator set and applies the proposal's
// `taxRate`. With no rate set (the default for a residential HOA, where
// common-area pest is non-taxable and lawn is never taxable in FL) tax is
// $0 and every line renders as non-taxable.
// ============================================================

// per_application is internal to the synthesized fallback (residential
// recurring plans bill per completed application, never a flat monthly) —
// the Commercial Proposal editor keeps its own hardcoded option list and
// never offers it. A per_application line annualizes by its own
// visitsPerYear, not a fixed occurrence count.
const FREQUENCIES = ['monthly', 'quarterly', 'bimonthly', 'annual', 'one_time', 'per_application'];

// Occurrences per year for each recurring cadence. one_time is handled
// separately (it never contributes to the recurring/annualized totals).
const OCCURRENCES_PER_YEAR = {
  monthly: 12,
  bimonthly: 6,
  quarterly: 4,
  annual: 1,
};

const FREQUENCY_LABELS = {
  monthly: 'Monthly',
  bimonthly: 'Every 2 months',
  quarterly: 'Quarterly',
  annual: 'Annual',
  one_time: 'One-time',
  per_application: 'Per application',
};

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeFrequency(value) {
  const v = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (FREQUENCIES.includes(v)) return v;
  if (v === 'bi_monthly' || v === 'every_other_month') return 'bimonthly';
  if (v === 'yearly') return 'annual';
  if (v === 'onetime' || v === 'one_off' || v === 'once') return 'one_time';
  return 'monthly';
}

function normalizeLineItem(raw = {}) {
  const quantity = Math.max(1, Math.round(num(raw.quantity, 1)));
  // Proposal lines are commercial quote amounts — never negative. Clamp at the
  // authoritative normalizer (the PDF and computeProposalTotals both read this)
  // so a bad/hostile client can't drive the persisted estimate totals negative,
  // regardless of entry path. The PUT route additionally rejects negatives so an
  // operator authoring in the modal gets feedback instead of a silent zero.
  const unitPrice = Math.max(0, roundMoney(num(raw.unitPrice ?? raw.unit_price ?? raw.price, 0)));
  const frequency = normalizeFrequency(raw.frequency);
  // amount is the price per occurrence (qty × unit price). Annualization is
  // derived from the frequency in computeProposalTotals.
  const amount = roundMoney(quantity * unitPrice);
  // per_application lines carry their own occurrence count; without one the
  // line annualizes to $0 (same as any unknown cadence would).
  const visitsPerYear = frequency === 'per_application'
    ? Math.max(0, Math.round(num(raw.visitsPerYear ?? raw.visits_per_year, 0)))
    : 0;
  return {
    description: String(raw.description || raw.name || '').slice(0, 300),
    quantity,
    unitPrice,
    frequency,
    frequencyLabel: FREQUENCY_LABELS[frequency],
    taxable: raw.taxable === true,
    amount,
    ...(visitsPerYear > 0 ? { visitsPerYear } : {}),
  };
}

// ── Structured proposal sections (2026-08-08, slice 1A-i) ───────────────────
// Optional, operator-authored sections that turn the proposal into a real
// commercial service agreement (property scope, one-time corrective work,
// customer responsibilities, structured terms). ALL optional and null when
// absent — a legacy proposal (buildings + free-text terms) normalizes and
// renders exactly as before. Every section here MUST be returned by
// normalizeProposal in the same PR that writes it: PUT /:id/proposal persists
// the normalizer's output, so an unreturned field is silently dropped on save.

function cleanString(value, max) {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
}

function cleanStringList(raw, { maxItems, maxLen }) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((line) => cleanString(line, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

// §3 Property scope — label/value facts about the property (buildings, units,
// turf sqft, device counts). Items render only when authored.
function normalizePropertyScope(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
  const cleaned = items
    .map((item) => ({
      label: cleanString(item?.label, 80),
      value: cleanString(item?.value, 160),
    }))
    .filter((item) => item.label && item.value)
    .slice(0, 24);
  return cleaned.length ? { items: cleaned } : null;
}

// §5 Corrective work — one-time remediation lines, separated from the
// recurring programs. Amounts are real charges: computeProposalTotals folds
// them into the one-time totals, so every renderer (React document, on-page
// card, SSR card, pdfkit fallback) must print these rows beside the totals.
function normalizeCorrectiveWorkItem(raw = {}) {
  return {
    label: cleanString(raw.label ?? raw.description, 160),
    // Same clamp rationale as normalizeLineItem: commercial quote amounts are
    // never negative, and this normalizer is what totals + persistence read.
    amount: Math.max(0, roundMoney(num(raw.amount ?? raw.price, 0))),
    taxable: raw.taxable === true,
    includes: cleanStringList(raw.includes, { maxItems: 12, maxLen: 200 }),
  };
}

function normalizeCorrectiveWork(raw) {
  if (!Array.isArray(raw)) return null;
  const cleaned = raw
    .map(normalizeCorrectiveWorkItem)
    .filter((item) => item.label)
    .slice(0, 24);
  return cleaned.length ? cleaned : null;
}

// §6 Customer responsibilities — plain bullet list.
function normalizeCustomerResponsibilities(raw) {
  const cleaned = cleanStringList(raw, { maxItems: 16, maxLen: 200 });
  return cleaned.length ? cleaned : null;
}

// Canonical payment-terms vocabulary — the SAME tokens the payer system
// stores and the payer statements render (payer.js PAYMENT_TERMS). Proposals
// speak this vocabulary so acceptance invoicing and any later payer wiring
// read one term language, never a parsed display string (codex #3297 r2:
// free text driving billing = a parallel mechanism). Common human spellings
// canonicalize; anything else is null (and the PUT route 400s it).
const PROPOSAL_PAYMENT_TERMS = ['due_on_receipt', 'net15', 'net30'];

function normalizePaymentTerms(value) {
  const t = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!t) return null;
  if (t === 'dueonreceipt') return 'due_on_receipt';
  if (t === 'net15') return 'net15';
  if (t === 'net30') return 'net30';
  return null;
}

function cleanBoundedInt(value, { min, max }) {
  // Number(null) and Number('') are 0 — a blank editor field must stay
  // "unset", never coerce to the 0-means-month-to-month claim the operator
  // didn't select (pre-push codex P1).
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= min && rounded <= max ? rounded : null;
}

// §10 Commercial terms — the structured agreement block. Free-text `terms`
// demotes to an "Additional terms" override rendered beneath these.
// validDays is normalized and stored but rendered NOWHERE and offered by no
// editor yet: the send flow stamps the enforced expiry (expires_at) from the
// fixed ESTIMATE_SEND_EXPIRY_DAYS, and printing an authored validity period
// beside it would contradict the date acceptance actually enforces (codex
// 1A-i r1). Reserved for the adjustable-expiry lane, which wires enforcement
// and rendering together.
function normalizeCommercialTerms(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const terms = {
    validDays: cleanBoundedInt(raw.validDays, { min: 1, max: 365 }),
    paymentTerms: normalizePaymentTerms(raw.paymentTerms),
    initialTermMonths: cleanBoundedInt(raw.initialTermMonths, { min: 0, max: 60 }),
    renewal: cleanString(raw.renewal, 120),
    priceAdjustment: cleanString(raw.priceAdjustment, 160),
    cancellation: cleanString(raw.cancellation, 160),
    accessRequirements: cleanString(raw.accessRequirements, 200),
  };
  return Object.values(terms).some((v) => v !== null) ? terms : null;
}

function normalizeBuilding(raw = {}, index = 0) {
  const lineItems = Array.isArray(raw.lineItems || raw.line_items)
    ? (raw.lineItems || raw.line_items).map(normalizeLineItem)
    : [];
  return {
    name: String(raw.name || raw.label || `Building ${index + 1}`).slice(0, 120),
    note: String(raw.note || '').slice(0, 300) || null,
    lineItems,
  };
}

function parseEstimateData(estimateData) {
  if (!estimateData) return {};
  if (typeof estimateData === 'string') {
    try { return JSON.parse(estimateData) || {}; } catch { return {}; }
  }
  return typeof estimateData === 'object' ? estimateData : {};
}

// Sections whose per-visit price and visit count do NOT prove per-application
// billing: legacy flat-monthly termite rows carry both yet genuinely bill the
// flat monthly (the #2965 carve-out that also keeps them out of
// TIER_BILLED_PER_APP_SECTION_KEYS in estimate-public.js). Only an explicit
// billedPerApplication flag can speak for these.
const AMBIGUOUS_CADENCE_SECTION_KEYS = new Set(['termite_bait', 'termite_bond']);

function sectionKeyForRow(row = {}, candidate = {}) {
  return String(row.service ?? row.serviceCategory ?? candidate.serviceCategory ?? '').toLowerCase();
}

// Recurring lines quoted the way residential plans actually bill — per
// completed application (owner rule 2026-07-23 / 2026-07-31: billing is per
// application or annual prepay, never a flat monthly).
//
// The BILLING LANE is the caller's to establish (estimate-proposal-billing.js
// resolves it live, the way the estimate page does) — this function only
// describes the plan once that lane says per-application. It reads the send
// snapshot's pricing bundle and considers BOTH top-level frequencies and
// serviceCadenceCombos, because an accept that picked independent per-service
// cadences is priced by the matching combo while accepted_frequency_key
// records only the top-level key. Candidates are tried in confidence order
// and the first one that reconciles to the stored annual total wins, so a
// mis-picked cadence can never reach the document.
//
// ── PRICING AUTHORITY ───────────────────────────────────────────────────────
// Which numbers this document may quote depends on where the estimate sits
// between send and acceptance. Enumerated once, here, because fixing these one
// at a time is what produced four rounds of review findings on #3120:
//
//   OUTSTANDING (caller passes livePricing)
//     snapshot served   live bundle == the snapshot   anchor: stored totals
//     lapsed member     reconciled, then live bundle  anchor: reconciled totals
//     snapshot REBUILT  live bundle                   anchor: the default
//                                                     candidate's OWN annual;
//                                                     stored-total matching is
//                                                     SKIPPED, because the
//                                                     route's fast path
//                                                     requires those columns to
//                                                     match, so a rejected
//                                                     snapshot's columns are
//                                                     stale and any "match"
//                                                     against them is a
//                                                     coincidence (#3120 r8)
//     rebuild failed    none — legacy document        (livePricing.unresolved:
//                                                     never silently fall back
//                                                     to the snapshot the route
//                                                     just refused to serve)
//
//   FROZEN (caller passes no livePricing — accepted, price-locked, declined)
//     snapshot matches  frozen send snapshot          anchor: frozen totals
//     snapshot stale    NONE — see below
//
// The frozen-stale case has no authority anywhere and deliberately prints no
// recurring pricing. Acceptance prices from a rebuilt bundle and discards it
// (buildEstimateSendSnapshot, at SEND time, is the only writer of
// sendSnapshot.pricingBundle), so the frozen snapshot can describe a plan the
// accepted totals never matched. customerSelection looks like it should fill
// the gap and does NOT: for lawn / tree&shrub / mosquito TIER plans the accept
// path resolves billingFrequencyKey 'monthly' with visits != 12, so
// billingAmount is the monthly DISPLAY rate, not a per-application charge
// (estimate-public.js, T&S audit 2026-07-18 P1). Deriving 12 applications from
// it prints $45 x 12 for a plan that charges $90 x 6 — and reconciling that
// back to the annual total still passes, because an arithmetic identity cannot
// validate billing semantics (#3120 r8). Closing this row needs acceptance to
// persist a per-application cadence; until then, no line beats a wrong one.
//
// Returns null — legacy monthly synthesis, i.e. today's rendering — whenever
// the plan can't be described this way with confidence: no bundle, a row with
// an unprovable cadence, or lines that don't reconcile. Failing to the old
// document beats asserting a billing cadence the customer isn't on.
function perApplicationRecurringLines(estimate = {}, estimateData = {}, livePricing = null) {
  // An UNLOCKED estimate whose rebuild failed must not silently fall back to
  // the send snapshot — that snapshot may be exactly the retired / below-floor
  // / stale-membership bundle buildPricingBundle exists to reject. Absence of
  // live pricing means "frozen"; unresolved means "unknown", and unknown
  // renders the legacy document (#3120 r8).
  if (livePricing?.unresolved === true) return null;
  const bundle = livePricing?.bundle || estimateData?.sendSnapshot?.pricingBundle;
  if (!bundle || typeof bundle !== 'object') return null;

  const frequencies = (Array.isArray(bundle.frequencies) ? bundle.frequencies : [])
    .filter((entry) => entry && entry.quoteRequired !== true);
  const combos = (Array.isArray(bundle.serviceCadenceCombos) ? bundle.serviceCadenceCombos : [])
    .filter((combo) => combo && combo.quoteRequired !== true
      && Array.isArray(combo.perServiceTreatments) && combo.perServiceTreatments.length > 0);
  if (frequencies.length === 0 && combos.length === 0) return null;

  const acceptedKey = String(estimate.accepted_frequency_key || '').trim();
  const annualTotal = num(estimate.annual_total);
  const monthlyTotal = num(estimate.monthly_total);
  const matchesAnnual = (c) => annualTotal > 0 && Math.abs(num(c.annual) - annualTotal) < 0.01;
  const matchesMonthly = (c) => monthlyTotal > 0 && Math.abs(num(c.monthly) - monthlyTotal) < 0.01;
  const matchesKey = (c) => !!acceptedKey && (c.key === acceptedKey || c.billingFrequencyKey === acceptedKey);
  // Combos first within each tier: when a combo and a top-level frequency
  // both match the stored totals, the combo carries the per-service rows the
  // accept path actually priced.
  const all = [...combos, ...frequencies];
  const ordered = [
    ...all.filter((c) => matchesAnnual(c) && matchesKey(c)),
    ...all.filter((c) => matchesAnnual(c) && !matchesKey(c)),
    ...all.filter((c) => !matchesAnnual(c) && matchesMonthly(c)),
    ...all.filter((c) => !matchesAnnual(c) && !matchesMonthly(c) && matchesKey(c)),
  ];
  // The plan-level manual credit lives on the BUNDLE (withManualDiscount)
  // and on top-level frequencies; buildServiceCadenceCombos omits it from
  // combo entries, whose annual is nonetheless net of it (codex #3120 r2).
  const bundleCredit = num(bundle.manualDiscount?.recurringAmount ?? bundle.manualDiscount?.amount);
  // A REBUILT bundle (the route refused to fast-path the snapshot) leaves the
  // stored columns describing the rejected plan, so any candidate "matching"
  // them matches a stale number by coincidence — two lawn tiers pinned to the
  // same floor is enough. Acceptance with no selectedFrequency takes the
  // default cadence, so that is the only defensible pick here (#3120 r8).
  const orderedForBundle = livePricing && livePricing.snapshotHit !== true ? [] : ordered;
  for (const candidate of orderedForBundle) {
    const lines = perApplicationLinesForCandidate(candidate, estimate, { annualTotal, bundleCredit });
    if (lines) return lines;
  }
  // OUTSTANDING + rebuilt snapshot: nothing matched the stored columns because
  // they are stale by construction (see the authority table above). Quote the
  // cadence the page defaults to, anchored on its own annual — the guard is
  // re-anchored, not dropped, so a candidate whose rows do not add up to its
  // own annual is still rejected.
  const fallback = livePricing?.defaultCandidate;
  if (fallback && num(fallback.annual) > 0) {
    const lines = perApplicationLinesForCandidate(fallback, estimate, {
      annualTotal: num(fallback.annual),
      bundleCredit,
    });
    if (lines) return lines;
  }
  return null;
}


// One candidate cadence (a top-level frequency or a serviceCadenceCombo) →
// its per-application lines, or null if it can't be described or priced.
function perApplicationLinesForCandidate(candidate, estimate, { annualTotal, bundleCredit = 0 }) {
  // Split entries carry per-service treatment rows; rowless single-service
  // entries carry perTreatment/visitsPerYear on the frequency itself — but
  // their label is the CADENCE name ("Bi-monthly"), so the service name comes
  // from the estimate instead.
  const hasRows = Array.isArray(candidate.perServiceTreatments) && candidate.perServiceTreatments.length > 0;
  const rows = hasRows ? candidate.perServiceTreatments : [candidate];
  const rowlessName = String(estimate.service_interest || '').trim() || 'Recurring service plan';
  const drafts = [];
  for (const row of rows) {
    const visits = Math.round(num(row.visitsPerYear ?? candidate.visitsPerYear));
    const perApplication = num(row.displayPrice ?? row.perTreatment);
    const monthly = num(row.monthly);
    const name = hasRows ? (row.label || row.service || 'Recurring service') : rowlessName;
    const section = sectionKeyForRow(row, candidate);
    // A per-visit price and a visit count describe per-application billing
    // once the caller's lane says so — EXCEPT on the sections where legacy
    // flat-monthly payloads look identical, which need THIS ROW's own flag
    // (an entry-level flag describes the entry, not its termite rider).
    // Combo rows never carry the flag (the backfill walks only frequencies)
    // and every real combo carries a mandatory pest row, so inferring from
    // the row alone is what makes combos describable at all (codex #3120 r2).
    const cadenceIsProvable = AMBIGUOUS_CADENCE_SECTION_KEYS.has(section)
      ? row.billedPerApplication === true
      : true;
    if (perApplication > 0 && visits > 0 && cadenceIsProvable) {
      drafts.push({ name, visits, perApplication, annual: roundMoney(perApplication * visits) });
    } else if (monthly > 0) {
      // Flat-monthly rows (termite bait monitoring) genuinely charge a
      // monthly amount on accept — keep the honest label.
      drafts.push({ name, monthly, annual: roundMoney(monthly * 12) });
    } else if (perApplication > 0 && visits > 0) {
      // Priced, but on a section whose cadence we cannot prove.
      return null;
    }
    // Rows with neither price are display-only (the estimate page filters
    // them the same way); dropping one that DID carry dollars fails the
    // reconcile below.
  }
  if (drafts.length === 0) return null;

  // Reconcile against the stored annual total, which is authoritative (accept
  // stamps it, and it is what the plan bills) — this picks the right CADENCE,
  // it does not reprice one. A plan-level manual credit is priced into the
  // cadence total but NOT into the per-service treatment rows
  // (estimate-public.js treatmentDisplayPrice applies only the tier discount),
  // so a gap of exactly the declared credit still identifies this candidate.
  //
  // The rows are then quoted UNSCALED, because that is what the customer is
  // actually charged: the accepted first-application amount comes from the
  // unscaled treatment rows and multi-service plans stay pre-credit with no
  // discount itemization, so allocating the credit into the per-application
  // prices would print figures the invoice never charges (codex #3120 r4).
  // Nothing on this document contradicts that — a per-application plan prints
  // no recurring roll-up for the unscaled rows to disagree with.
  const gross = roundMoney(drafts.reduce((acc, d) => acc + d.annual, 0));
  if (annualTotal > 0 && Math.abs(gross - annualTotal) > 0.05) {
    const creditAnnual = num(candidate.manualDiscount?.recurringAmount ?? candidate.manualDiscount?.amount)
      || num(bundleCredit);
    if (!(creditAnnual > 0) || Math.abs(gross - creditAnnual - annualTotal) > 0.05 || !(gross > 0)) return null;
  }

  return drafts.map((draft) => (draft.visits
    ? normalizeLineItem({
      description: `${draft.name} — ${draft.visits} applications/yr`,
      unitPrice: draft.perApplication,
      frequency: 'per_application',
      visitsPerYear: draft.visits,
      taxable: false,
    })
    : normalizeLineItem({
      description: draft.name,
      unitPrice: draft.monthly,
      frequency: 'monthly',
      taxable: false,
    })));
}

// Build a single-building fallback proposal from the engine line items /
// estimate fields so ANY estimate can still produce a PDF even before the
// operator has authored an explicit multi-building proposal.
function synthesizeFallbackProposal(estimate = {}, estimateData = {}, { recurringMode = 'legacy', livePricing = null } = {}) {
  const perApplicationMode = recurringMode === 'per_application';
  const lineItems = perApplicationMode
    ? [...(perApplicationRecurringLines(estimate, estimateData, livePricing) || [])]
    : [];
  const havePerApplicationRecurring = lineItems.length > 0;
  // A per-application plan whose lines could not be derived (no snapshot, or a
  // reconcile failure) prints NO recurring pricing rather than reverting to
  // the monthly copy the rule forbids for this lane (pre-push r5). One-time
  // work and the rest of the document are unaffected; the customer's price is
  // on the estimate page and in the plan's own paperwork.
  const suppressRecurringPricing = perApplicationMode && !havePerApplicationRecurring;
  const engineLines = Array.isArray(estimateData?.sendSnapshot?.pricingBundle?.lineItems)
    ? estimateData.sendSnapshot.pricingBundle.lineItems
    : Array.isArray(estimateData?.lineItems)
    ? estimateData.lineItems
    : [];

  for (const line of engineLines) {
    const monthly = num(line.monthlyPrice ?? line.monthly_price);
    const oneTime = num(line.oneTimePrice ?? line.onetime_price ?? line.oneTime);
    if (monthly > 0) {
      // The per-application lines already cover the recurring side.
      if (havePerApplicationRecurring || suppressRecurringPricing) continue;
      lineItems.push(normalizeLineItem({
        description: line.displayName || line.name || line.service || 'Recurring service',
        unitPrice: monthly,
        frequency: 'monthly',
        taxable: false,
      }));
    } else if (oneTime > 0) {
      lineItems.push(normalizeLineItem({
        description: line.displayName || line.name || line.service || 'One-time service',
        unitPrice: oneTime,
        frequency: 'one_time',
        taxable: false,
      }));
    }
  }

  // Last-ditch: fill whichever side is still missing from the stored totals
  // so the PDF still shows a number rather than an empty table.
  if (!suppressRecurringPricing && !lineItems.some((item) => item.frequency !== 'one_time')) {
    const monthly = num(estimate.monthly_total);
    if (monthly > 0) {
      lineItems.push(normalizeLineItem({ description: 'Recurring service plan', unitPrice: monthly, frequency: 'monthly' }));
    }
  }
  if (!lineItems.some((item) => item.frequency === 'one_time')) {
    const oneTime = num(estimate.onetime_total);
    if (oneTime > 0) {
      lineItems.push(normalizeLineItem({ description: 'One-time service', unitPrice: oneTime, frequency: 'one_time' }));
    }
  }

  return {
    enabled: false,
    synthesized: true,
    // Synthesized fallbacks serve ANY estimate (incl. the customer-facing
    // /api/estimates/:token/pdf download) — a residential quote must not be
    // headed "Commercial Service Proposal". Authored proposals keep their
    // stored title (the commercial modal's default).
    title: 'Service Proposal',
    buildings: [{ name: estimate.address || 'Service location', note: null, lineItems }],
  };
}

/**
 * A row belongs to the Commercial Proposal editor when a proposal is
 * authored (enabled) OR machine-scaffolded by the estimator engine's
 * commercial lane (scaffold, enabled:false). A disabled scaffold must not
 * enter the normal edit flow: the list would offer "Edit estimate" and
 * edit-source would report it editable, but the revise write rejects
 * COMMERCIAL rows — the operator would lose their edits at save time.
 */
function isCommercialProposalData(estimateData) {
  const proposal = parseEstimateData(estimateData)?.proposal;
  return proposal?.enabled === true || proposal?.scaffold === true;
}

/**
 * Normalize whatever is stored in estimate_data.proposal into a stable shape.
 * Falls back to a synthesized single-building proposal when none is authored.
 *
 * @param {object} estimate
 * @param {{ recurringMode?: 'legacy'|'per_application' }} [options]
 *   How a SYNTHESIZED proposal quotes its recurring lines. Defaults to
 *   'legacy' (the flat-monthly engine lines this has always produced).
 *   **Rendering-only**: the richer modes are opt-in from the PDF path and
 *   never from the Commercial Proposal editor's read — the editor's
 *   FREQUENCY_OPTIONS/PER_YEAR map has no per_application cadence and its
 *   payload round-trip drops visitsPerYear, so a promoted line would save back
 *   with no occurrence count and annualize to $0, overwriting the estimate's
 *   authoritative annual_total on PUT.
 *
 * @returns {{ enabled, synthesized, title, preparedFor, propertyAddress,
 *   taxRate, taxLabel, terms, buildings: Array }}
 */
function normalizeProposal(estimate = {}, { recurringMode = 'legacy', livePricing = null } = {}) {
  const estimateData = parseEstimateData(estimate.estimate_data ?? estimate.estimateData);
  const stored = estimateData.proposal;

  const base = stored && Array.isArray(stored.buildings) && stored.buildings.length
    ? stored
    : synthesizeFallbackProposal(estimate, estimateData, { recurringMode, livePricing });

  const buildings = (Array.isArray(base.buildings) ? base.buildings : []).map(normalizeBuilding);

  return {
    enabled: base.enabled === true,
    synthesized: base.synthesized === true,
    title: String(base.title || 'Commercial Service Proposal').slice(0, 160),
    preparedFor: String(base.preparedFor || estimate.customer_name || '').slice(0, 160),
    propertyAddress: String(base.propertyAddress || estimate.address || '').slice(0, 200),
    taxRate: Math.min(1, Math.max(0, num(base.taxRate, 0))),
    taxLabel: String(base.taxLabel || 'Sales tax').slice(0, 60),
    terms: base.terms ? String(base.terms).slice(0, 2000) : null,
    buildings,
    // Structured sections (slice 1A-i) — null when absent, so legacy
    // proposals round-trip and render exactly as before. Read from the
    // STORED proposal only: the synthesized fallback never authors these.
    propertyScope: normalizePropertyScope(base.propertyScope),
    correctiveWork: normalizeCorrectiveWork(base.correctiveWork),
    customerResponsibilities: normalizeCustomerResponsibilities(base.customerResponsibilities),
    commercialTerms: normalizeCommercialTerms(base.commercialTerms),
    accountManager: cleanString(base.accountManager, 80),
  };
}

function annualizedAmount(item) {
  if (item.frequency === 'one_time') return 0;
  const occ = item.frequency === 'per_application'
    ? (Number(item.visitsPerYear) || 0)
    : (OCCURRENCES_PER_YEAR[item.frequency] || 0);
  return roundMoney(item.amount * occ);
}

/**
 * Compute recurring / one-time / tax totals for a normalized proposal.
 * Tax is applied only to lines flagged `taxable`, at the proposal taxRate.
 */
function computeProposalTotals(proposal) {
  const taxRate = num(proposal?.taxRate, 0);
  let annualRecurring = 0;
  let oneTime = 0;
  let taxableAnnualRecurring = 0;
  let taxableOneTime = 0;

  for (const building of proposal.buildings || []) {
    for (const item of building.lineItems || []) {
      if (item.frequency === 'one_time') {
        oneTime += item.amount;
        if (item.taxable) taxableOneTime += item.amount;
      } else {
        const annual = annualizedAmount(item);
        annualRecurring += annual;
        if (item.taxable) taxableAnnualRecurring += annual;
      }
    }
  }

  // Structured corrective-work lines (slice 1A-i) are real one-time charges —
  // they fold into the one-time totals exactly like a one_time line item, so
  // the operator authors remediation once, in its own section, without a
  // shadow line item to keep in sync.
  for (const work of proposal.correctiveWork || []) {
    oneTime += work.amount;
    if (work.taxable) taxableOneTime += work.amount;
  }

  annualRecurring = roundMoney(annualRecurring);
  oneTime = roundMoney(oneTime);
  const monthlyEquivalent = roundMoney(annualRecurring / 12);
  const recurringTax = roundMoney(taxableAnnualRecurring * taxRate);
  const oneTimeTax = roundMoney(taxableOneTime * taxRate);
  const totalTax = roundMoney(recurringTax + oneTimeTax);

  return {
    annualRecurring,
    monthlyEquivalent,
    oneTime,
    taxRate,
    taxableAnnualRecurring: roundMoney(taxableAnnualRecurring),
    taxableOneTime: roundMoney(taxableOneTime),
    recurringTax,
    oneTimeTax,
    totalTax,
    // Grand total = full first-year cost (annual recurring + one-time) + tax.
    firstYearTotal: roundMoney(annualRecurring + oneTime + totalTax),
    hasTax: totalTax > 0,
    isMultiBuilding: (proposal.buildings || []).length > 1,
  };
}

module.exports = {
  FREQUENCIES,
  FREQUENCY_LABELS,
  OCCURRENCES_PER_YEAR,
  normalizeFrequency,
  normalizeLineItem,
  normalizeBuilding,
  normalizePropertyScope,
  normalizeCorrectiveWork,
  normalizeCustomerResponsibilities,
  normalizeCommercialTerms,
  normalizePaymentTerms,
  PROPOSAL_PAYMENT_TERMS,
  normalizeProposal,
  perApplicationRecurringLines,
  annualizedAmount,
  computeProposalTotals,
  isCommercialProposalData,
};
