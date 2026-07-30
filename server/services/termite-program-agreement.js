// ============================================================
// termite-program-agreement.js — auto-prep the signable program agreement
// when a termite bait estimate is accepted.
//
// The marketing pages, comparison sheet, and service-details guide all say
// "your signed termite agreement spells out the covered structures and
// terms" — this service makes that true. On acceptance of an estimate that
// carries the bait-station program, it creates a DRAFT document request
// from the matching ownership template (purchase vs rental, seeded by
// 20260729000001) prefilled from the accepted estimate, and rings the
// admin bell. Drafts surface in the existing open document-requests queue
// and are sent for signature through the existing delivery routes.
// Invoked from BOTH acceptance paths (public customer accept and
// estimate-manual-acceptance's downstream), plus a daily reconciliation
// sweep (scheduler, 6:10am ET document-lifecycle cron) that re-preps any
// accepted termite estimate whose prep failed transiently — acceptance has
// already committed by the time this runs, so failures must be retryable,
// not best-effort.
//
// Sending is the only customer-facing step, and it stays owner-controlled:
// auto-send fires ONLY when GATE_TERMITE_PROGRAM_AGREEMENT_AUTOSEND=true
// (default OFF — owner flips). Everything else is internal bookkeeping.
//
// Fail-closed: if the accepted estimate's termite figures can't be
// resolved (no bait line, no per-application price), NO document is
// created — the admin bell says the agreement needs manual prep instead.
// A wrong-numbers legal draft is worse than no draft.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
const { formatDisplayDate } = require('../utils/date-only');

const PURCHASE_TEMPLATE_KEY = 'service_agreement.termite_bait_program_purchase';
const RENTAL_TEMPLATE_KEY = 'service_agreement.termite_bait_program_rental';
const PROGRAM_TEMPLATE_KEYS = [PURCHASE_TEMPLATE_KEY, RENTAL_TEMPLATE_KEY];

// The delivery workflow's real status vocabulary: signed/cancelled/voided
// are terminal (its TERMINAL_STATUSES), and expireDocumentRequests writes
// the literal 'expired'. Only a genuinely OPEN request (draft/sent/viewed
// with an unexpired — or not yet minted — share window) blocks a new prep;
// signed agreements are historical records and a re-accept at new pricing
// legitimately gets a fresh document.
const OPEN_STATUSES = ['draft', 'sent', 'viewed'];

// Menu is Trelona-only (owner 2026-07-28), but explicit legacy Advance
// estimates still replay and remain acceptable — the agreement must name
// the system the customer actually accepted, never silently rebrand it.
const SYSTEM_LABELS = {
  trelona: 'Trelona® ATBS annual bait stations',
  advance: 'Advance® termite bait stations',
};
const GENERIC_SYSTEM_LABEL = 'in-ground termite bait stations';
const START_DATE_FALLBACK = 'To be confirmed at installation';

// Recent-bell existence check — the single source of exactly-once bell
// semantics: every path (accept-time, superseded pass, main sweep) rings
// IFF no matching bell landed within the window. A lost bell self-heals on
// the next pass; a bell that landed while the durable marker write failed
// is never duplicated; a genuinely new park months later (window elapsed)
// re-rings.
// 30 days: strictly longer than the 21-day standard-sweep window, so a
// parked estimate cannot outlive its bell's dedupe record while still being
// selected daily (a re-park after the window legitimately re-rings).
const BELL_DEDUPE_DAYS = 30;
// Tri-state: true (bell exists), false (proven absent), 'error' (lookup
// failed — the caller must neither ring nor mark handled; the retry path
// re-evaluates when the database recovers).
async function adminBellExists(titleLike, metaKey, metaValue, conn = db) {
  if (!metaValue) return false;
  try {
    const cutoff = new Date(Date.now() - BELL_DEDUPE_DAYS * 24 * 60 * 60 * 1000);
    const row = await conn('notifications')
      .where('recipient_type', 'admin')
      .where('title', 'like', titleLike)
      .whereRaw(`metadata->>'${metaKey}' = ?`, [String(metaValue)])
      .where('created_at', '>=', cutoff)
      .first('id');
    return !!row;
  } catch (err) {
    logger.warn(`[termite-agreement] bell-history lookup failed (${titleLike}): ${err.message}`);
    return 'error';
  }
}

async function manualPrepBellAlreadySent(estimateId, conn = db) {
  return adminBellExists('Termite agreement needs manual prep%', 'estimateId', estimateId, conn);
}

function autosendGateOn() {
  return ['1', 'true', 'on'].includes(String(process.env.GATE_TERMITE_PROGRAM_AGREEMENT_AUTOSEND || '').toLowerCase());
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function parseEstimateData(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function systemLabelFor(system) {
  const key = String(system || '').toLowerCase();
  return SYSTEM_LABELS[key] || (key ? GENERIC_SYSTEM_LABEL : SYSTEM_LABELS.trelona);
}

// Walk the stored estimate payload for termite lines across the persisted
// shapes: raw engine lineItems ({service:'termite_bait', perApp,
// installation.price}), the v1-legacy-mapper recurring services rows
// ({name:'Termite Bait', perTreatment}), and the mapped results.tmBait node
// (monMonthly/bmo + ai/ti install + selectedSystem). Depth-capped like
// estimate-service-details' ownership walker.
function collectTermiteFacts(estData) {
  const facts = {
    hasProgram: false,
    ownership: 'own',
    perApp: null,
    // Whether perApp is the FINAL customer price. Mapper rows persist
    // PRE-discount figures by design (v1-legacy-mapper), so a gross figure
    // is only safe when no WaveGuard/manual discount applies — the builder
    // fails closed otherwise (pre-push P0: the signed agreement must never
    // state a higher price than the accepted invoice).
    perAppIsNet: false,
    installPrice: null,
    rentalPerApp: null,
    system: null,
  };
  if (!estData || typeof estData !== 'object') return facts;

  const takePerApp = (value, { net = false } = {}) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    if (facts.perApp == null || (net && !facts.perAppIsNet)) {
      facts.perApp = n;
      facts.perAppIsNet = net || facts.perAppIsNet;
    }
  };
  const takeInstall = (value) => {
    if (facts.installPrice == null && Number.isFinite(Number(value)) && Number(value) > 0) facts.installPrice = Number(value);
  };
  const takeSystem = (value) => {
    if (!facts.system && value) facts.system = String(value).toLowerCase();
  };

  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 6 || !node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const key = String(node.service || node.key || '').toLowerCase();
    const name = String(node.name || '').toLowerCase();

    // Commercial-proposal lineItems keep only description/quantity/unitPrice
    // (the normalizer drops service/key/name) — a termite line authored in
    // the proposal editor must still mark the program so the commercial
    // park runs instead of a silent no_termite_program return.
    if (!key && !name
      && typeof node.description === 'string'
      && /termite/i.test(node.description)
      // The BAIT PROGRAM specifically — 'termite trenching' and other
      // one-time termite work must not trigger the program agreement flow
      // (which would retire an existing bait agreement and ring a false
      // manual-prep bell).
      && /bait|station|monitor/i.test(node.description)
      && ('unitPrice' in node || 'unit_price' in node || 'quantity' in node)) {
      facts.hasProgram = true;
    }

    // Commercial termite lines use their own key — they mark the PROGRAM
    // present (so the commercial park runs instead of a silent
    // no_termite_program return) but contribute no residential figures.
    if (key === 'commercial_termite_bait' || key.startsWith('commercial_termite')) {
      facts.hasProgram = true;
    }
    if (key === 'termite_bait' || (!key && /termite bait/.test(name))) {
      facts.hasProgram = true;
      // Raw engine lines carry the FINAL discounted annual in
      // manualFinalAnnual / annualAfterDiscount — the authoritative NET
      // per-application sources. Plain `annual` is the GROSS figure (the
      // discount fields are absent exactly when no discount landed OR on
      // legacy lines that never carried them), so it must not bypass the
      // fail-closed discount check.
      const visits = Number(node.visitsPerYear ?? node.visits) || 4;
      const netAnnual = Number(node.manualFinalAnnual ?? node.annualAfterDiscount);
      if (Number.isFinite(netAnnual) && netAnnual > 0) {
        takePerApp(Math.round((netAnnual / visits) * 100) / 100, { net: true });
      } else {
        const grossAnnual = Number(node.annual);
        if (Number.isFinite(grossAnnual) && grossAnnual > 0) {
          takePerApp(Math.round((grossAnnual / visits) * 100) / 100);
        }
      }
      takePerApp(node.perApp);
      takePerApp(node.perTreatment);
      takeInstall(node.installation?.price);
      takeSystem(node.selectedSystem || node.system);
      if (String(node.ownership || '').toLowerCase() === 'rent') facts.ownership = 'rent';
    }
    if (key === 'termite_station_rental' || (!key && /station rental/.test(name))) {
      facts.hasProgram = true;
      facts.ownership = 'rent';
      if (facts.rentalPerApp == null) {
        const perApp = Number(node.perApp ?? node.perTreatment);
        if (Number.isFinite(perApp) && perApp > 0) facts.rentalPerApp = perApp;
      }
    }
    // Mapped results.tmBait node: no service key; carries the canonical
    // persisted figures for normal saved estimates.
    if ((node.monMonthly != null || node.bmo != null) && ('ai' in node || 'ti' in node)) {
      facts.hasProgram = true;
      // The client fallback engine stores BOTH systems' install prices on
      // tmBait — the accepted system picks which one is the sold charge
      // (v1 server saves null the unselected side, so this stays right
      // there too). Never default a legacy Advance accept to the Trelona
      // price.
      const nodeSystem = String(node.selectedSystem || node.system || '').toLowerCase();
      const soldInstall = nodeSystem === 'advance' ? node.ai
        : nodeSystem === 'trelona' ? node.ti
          : (node.ti ?? node.ai);
      takeInstall(soldInstall);
      takeSystem(node.selectedSystem || node.system);
      const monthly = Number(node.monMonthly ?? node.bmo);
      if (facts.perApp == null && Number.isFinite(monthly) && monthly > 0) {
        // Quarterly station check billed per application: monthly × 3.
        facts.perApp = Math.round(monthly * 3 * 100) / 100;
      }
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(estData, 0);

  // Engine inputs are authoritative for the selected ownership structure and
  // system (the rental line proves rent; inputs can also say so directly).
  const termiteInputs = estData?.inputs?.services?.termite
    || estData?.engineInputs?.services?.termite
    || estData?.inputs?.services?.termite_bait
    || null;
  if (termiteInputs) {
    facts.hasProgram = true;
    takeSystem(termiteInputs.system);
    if (String(termiteInputs.ownership || '').toLowerCase() === 'rent') facts.ownership = 'rent';
  }
  return facts;
}

// A discount can change the customer's real per-application price below the
// gross mapper figures: any WaveGuard tier above Bronze, or a manual
// discount recorded on the estimate.
function estimateMayDiscount(estimate = {}, estData = null) {
  const tier = String(estimate.waveguard_tier || '').toLowerCase();
  if (['silver', 'gold', 'platinum'].includes(tier)) return true;
  const data = estData || parseEstimateData(estimate.estimate_data) || {};
  return !!(data.manualDiscount || data.manual_discount || data.result?.manualDiscount);
}

// Build the template values for the matching ownership variant, or null when
// the required figures can't be resolved (fail-closed — see header).
// startDateLabel comes from the accepted/booked first visit when one exists;
// otherwise the merge field says the start is confirmed at installation.
function buildTermiteProgramAgreementValues(estimate = {}, estData = null, { startDateLabel = null } = {}) {
  const data = estData || parseEstimateData(estimate.estimate_data);
  const facts = collectTermiteFacts(data);
  if (!facts.hasProgram) return null;

  // Pre-discount figure + a discount in play = the agreement could state a
  // higher price than the accepted invoice. Fail closed to manual prep.
  if (!facts.perAppIsNet && estimateMayDiscount(estimate, data)) return null;

  const perApplication = money(facts.perApp);
  if (!perApplication) return null;

  const base = {
    program: {
      system: systemLabelFor(facts.system),
      per_application: perApplication,
    },
    service: { name: 'Termite Bait Station Program' },
    agreement: { start_date: startDateLabel || START_DATE_FALLBACK },
    estimate: { id: estimate.id || null, address: estimate.address || null },
  };

  if (facts.ownership === 'rent') {
    const rental = money(facts.rentalPerApp);
    const combined = money((facts.rentalPerApp || 0) + (facts.perApp || 0));
    if (!rental || !combined) return null;
    return {
      templateKey: RENTAL_TEMPLATE_KEY,
      ownership: 'rent',
      values: {
        ...base,
        program: { ...base.program, rental_per_application: rental, combined_per_application: combined },
      },
    };
  }

  const installPrice = money(facts.installPrice);
  if (!installPrice) return null;
  return {
    templateKey: PURCHASE_TEMPLATE_KEY,
    ownership: 'own',
    values: {
      ...base,
      program: { ...base.program, install_price: installPrice },
    },
  };
}

// Canonical-enough address comparison for same-property classification:
// lowercase, strip punctuation, and map the common USPS suffix/directional
// spellings so '123 Main Street' and '123 Main St' classify as the SAME
// property (a miss here could leave a stale-priced agreement live).
const ADDRESS_TOKEN_MAP = {
  street: 'st', avenue: 'ave', drive: 'dr', road: 'rd', boulevard: 'blvd',
  lane: 'ln', court: 'ct', circle: 'cir', place: 'pl', terrace: 'ter',
  parkway: 'pkwy', highway: 'hwy', trail: 'trl', way: 'way', loop: 'loop',
  north: 'n', south: 's', east: 'e', west: 'w',
  apartment: 'apt', suite: 'ste', unit: 'unit',
};
function normalizeAddress(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => ADDRESS_TOKEN_MAP[token] || token)
    .join(' ');
}

// Classify an existing contract row against the accepted estimate:
//  'blocks'    — open request for THIS estimate; nothing to do.
//  'supersede' — open request for the same property from a DIFFERENT
//                estimate: its figures are stale, so it is cancelled and a
//                fresh agreement drafted (pre-push P0: a revised accept must
//                never leave the old-priced legal draft as the live one).
//  'ignore'    — terminal/expired, or a different property.
function classifyExistingAgreement(row, estimate, now = new Date(), { activeVersionIds = null } = {}) {
  if (!row) return 'ignore';
  const status = String(row.status || '').toLowerCase();
  if (!OPEN_STATUSES.includes(status)) return 'ignore';
  if (row.share_token_expires_at && new Date(row.share_token_expires_at) < now) return 'ignore';

  let snapshot = row.document_variables_snapshot;
  if (typeof snapshot === 'string') {
    try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; }
  }
  const snapEstimateId = snapshot?.estimate?.id || null;
  const sameEstimate = !!(snapEstimateId && estimate?.id && String(snapEstimateId) === String(estimate.id));
  const snapAddress = normalizeAddress(snapshot?.estimate?.address || snapshot?.customer?.address);
  const acceptedAddress = normalizeAddress(estimate?.address);
  // Property scoping comes FIRST: another property's request is never this
  // accept's business — even when its template version is stale, it is
  // reconciled independently by the daily superseded pass, so it keeps its
  // signing flow instead of being cancelled without a replacement here.
  const provablyDifferentProperty = !sameEstimate
    && snapAddress && acceptedAddress && snapAddress !== acceptedAddress;
  if (provablyDifferentProperty) return 'ignore';

  // An open request rendered from a SUPERSEDED template version never
  // blocks — it must be cancelled and re-prepped from the active body,
  // even for the same estimate (this is what makes v1 retirement a durable
  // invariant rather than a one-shot migration snapshot: a request that
  // races past the migration is superseded on the next accept-time or
  // daily-sweep touch).
  const staleVersion = activeVersionIds
    && row.document_template_version_id
    && !activeVersionIds.has(row.document_template_version_id);
  if (staleVersion) return 'supersede';
  if (sameEstimate) return 'blocks';
  // Same or unprovable property, different estimate, current version: the
  // newer accept's figures supersede — one open draft max per property.
  return 'supersede';
}

async function openProgramAgreements(customerId, conn = db, { forUpdate = false } = {}) {
  const query = conn('customer_contracts')
    .where({ customer_id: customerId, contract_type: 'document_template' })
    .whereIn('document_template_key', PROGRAM_TEMPLATE_KEYS)
    .whereIn('status', OPEN_STATUSES)
    .select('id', 'customer_id', 'status', 'share_token_expires_at', 'document_variables_snapshot', 'document_template_version_id', 'created_at');
  return forUpdate ? query.forUpdate() : query;
}

// Active version ids for the two program templates — rows rendered from any
// other version are stale and get superseded on sight.
async function activeProgramVersionIds(conn = db) {
  const rows = await conn('document_templates')
    .whereIn('template_key', PROGRAM_TEMPLATE_KEYS)
    .whereNotNull('active_version_id')
    .select('active_version_id');
  return new Set(rows.map((r) => r.active_version_id));
}

// Per-template rollout moments: template_key → its ACTIVE version's
// published_at. Requests that expired before THEIR OWN template's rollout
// are ordinary historical expiries (deliberately blockers in the main
// sweep), not rollout casualties — a single global minimum would let an
// agreement that deliberately expired between two templates' staggered
// upgrades slip back in.
async function activeVersionRolloutStarts(conn = db) {
  const rows = await conn('document_templates as dt')
    .join('document_template_versions as dtv', 'dtv.id', 'dt.active_version_id')
    .whereIn('dt.template_key', PROGRAM_TEMPLATE_KEYS)
    .select('dt.template_key', 'dtv.published_at');
  const map = new Map();
  for (const row of rows) {
    if (row.published_at) map.set(row.template_key, new Date(row.published_at));
  }
  return map;
}

async function existingBlockingProgramAgreement(customerId, estimate, conn = db, activeVersionIds = null) {
  const rows = await openProgramAgreements(customerId, conn);
  const now = new Date();
  return rows.find((row) => classifyExistingAgreement(row, estimate, now, { activeVersionIds }) === 'blocks') || null;
}

// First upcoming non-cancelled visit booked from this estimate — the honest
// program start date when acceptance also booked the installation.
async function scheduledStartDateLabel(estimateId, conn = db) {
  try {
    const row = await conn('scheduled_services')
      .where({ source_estimate_id: estimateId })
      .whereNotIn('status', ['cancelled', 'skipped'])
      // Multi-service accepts book pest/lawn visits from the same estimate —
      // only the termite installation/service anchors the PROGRAM start.
      .whereRaw("LOWER(service_type) LIKE '%termite%'")
      .orderBy('scheduled_date', 'asc')
      .first('scheduled_date');
    if (!row?.scheduled_date) return null;
    // scheduled_date is a pg DATE (hydrates as UTC midnight) — the repo's
    // date-only formatter renders the stored calendar day, never the prior
    // ET day.
    return formatDisplayDate(row.scheduled_date, { fallback: '' }) || null;
  } catch {
    return null;
  }
}

// Annual-prepay accepts are billed as one annual invoice, but the seeded
// templates state per-application billing — a signable contract must not
// contradict the invoice the customer just received (pre-push P0). Detected
// from the accepting flow's explicit billingTerm when passed, plus the
// durable annual_prepay_terms record for reconciliation and missed paths.
// Returns true / false / 'error'. 'error' means the durable prepay lookup
// failed — the caller must fail CLOSED (skip prep, retry later via
// reconciliation) rather than risk drafting per-application wording for an
// annual-prepay customer.
async function isAnnualPrepayAccept(estimate, billingTerm, conn = db) {
  if (String(billingTerm || '').toLowerCase() === 'prepay_annual') return true;
  if (!estimate?.id) return false;
  try {
    const term = await conn('annual_prepay_terms').where({ source_estimate_id: estimate.id }).first('id');
    return !!term;
  } catch (err) {
    logger.warn(`[termite-agreement] annual-prepay lookup failed for estimate ${estimate.id}: ${err.message}`);
    return 'error';
  }
}

// Commercial / multi-unit accepts never auto-draft: Florida gives them
// different retreat windows (180 vs 90 days, Rule 5E-14.105), tenants add
// business-interruption exposure, and the seeded residential wording
// doesn't fit — they park for a manually tailored agreement, same posture
// as annual prepay. Detection is deliberately broad (park = safe).
function isCommercialEstimate(estimate = {}, estData = null) {
  const data = estData || parseEstimateData(estimate.estimate_data) || {};
  // Canonical commercial-proposal marker (estimate-proposal.js): an
  // authored or scaffolded proposal is commercial by definition.
  if (data?.proposal?.enabled === true || data?.proposal?.scaffold === true) return true;
  // The estimator forms persist isCommercial as the strings "YES"/"NO",
  // not booleans — normalize the same affirmative values the estimator
  // uses so an explicitly commercial accept always parks.
  const commercialFlag = (value) => value === true
    || ['true', 'yes', 'y', '1', 'commercial'].includes(String(value ?? '').trim().toLowerCase());
  if (commercialFlag(data?.inputs?.isCommercial) || commercialFlag(data?.engineInputs?.isCommercial)) return true;
  const propertyType = String(data?.inputs?.propertyType || data?.propertyType || '').toLowerCase();
  // Persisted estimator values include the concrete multi-unit types, not
  // just the 'Multifamily' label — every multi-unit structure parks.
  if (/commercial|multi[- ]?family|multifamily|duplex|triplex|quadplex|condo|town\s?home|townhouse|apartment/.test(propertyType)) return true;
  if (String(estimate.waveguard_tier || '').toLowerCase() === 'commercial') return true;
  try {
    const txt = typeof estimate.estimate_data === 'string' ? estimate.estimate_data : JSON.stringify(data);
    if (/"commercial_/.test(txt) || /commercial proposal/i.test(txt)) return true;
  } catch { /* fall through */ }
  return false;
}

// A PARKED accept (commercial/multi-unit, annual prepay, unresolved
// figures) creates no replacement draft — the operator does — but any open
// agreement for the same property now carries obsolete figures/terms and
// must not stay signable. Retires them under the same advisory lock +
// FOR UPDATE + conditional-cancel discipline as the creation path. Uses
// the ordinary supersession reason (NOT the compliance reason) so the
// sweeps don't try to auto-replace what the operator now owns.
async function retireSamePropertyOpenAgreements(customerId, estimate, activeVersionIds) {
  const lockKey = `termite-agreement:${customerId}`;
  let keptReplacement = false;
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [lockKey]);
    const openRows = await openProgramAgreements(customerId, trx, { forUpdate: true });
    const nowTs = new Date();
    const acceptedAt = estimate.accepted_at ? new Date(estimate.accepted_at) : null;
    for (const row of openRows) {
      // Everything that isn't provably another property's request retires —
      // including same-estimate current-version rows (their figures predate
      // this revised accept).
      if (classifyExistingAgreement(row, estimate, nowTs, { activeVersionIds }) === 'ignore') continue;
      // A CURRENT-version request created AFTER this acceptance is staff's
      // tailored response to it (checked under the same advisory lock the
      // creation path uses) — keep it; the handoff is already complete.
      const isCurrentVersion = row.document_template_version_id
        && activeVersionIds && activeVersionIds.has(row.document_template_version_id);
      const createdAt = row.created_at ? new Date(row.created_at) : null;
      if (isCurrentVersion && acceptedAt && createdAt && createdAt >= acceptedAt) {
        keptReplacement = true;
        continue;
      }
      const cancelled = await trx('customer_contracts')
        .where({ id: row.id })
        .whereIn('status', OPEN_STATUSES)
        .update({
          status: 'cancelled',
          cancelled_at: nowTs,
          cancelled_reason: 'Superseded by a newer accepted termite estimate',
          updated_at: nowTs,
        });
      if (!cancelled) continue;
      await trx('customer_contract_events').insert({
        contract_id: row.id,
        customer_id: customerId,
        event_type: 'cancelled',
        actor_type: 'system',
        actor_id: null,
        metadata: JSON.stringify({ reason: 'superseded', supersededByEstimateId: estimate.id, parkedAccept: true }),
      });
    }
  });
  return { keptReplacement };
}

// Create the draft agreement for an accepted termite estimate. Never throws
// into the caller (acceptance must not fail because agreement prep did);
// failures are retryable via reconcileTermiteProgramAgreements. Returns a
// small result object for logging/tests.
// notifyAdmin returns null (not a throw) when its insert fails; every bell
// in this flow is a required handoff, so ring twice before conceding and
// leave an error-level trail when both attempts miss.
async function ringAdminBell(NotificationService, args, context) {
  let bell = await NotificationService.notifyAdmin(...args);
  if (!bell) bell = await NotificationService.notifyAdmin(...args);
  if (!bell) logger.error(`[termite-agreement] admin bell failed twice — ${context}`);
  return !!bell;
}

async function maybeCreateTermiteProgramAgreement({ estimate, customerId, req = {}, notifyOnUnresolved = true, billingTerm = null, startDateLabel: startDateLabelOverride = null, signedBlockScope = 'estimate' }) {
  try {
    if (!estimate || !customerId) return { ok: false, skipped: 'missing_inputs' };
    // One-time acceptances keep their termite snapshots but did NOT accept
    // the recurring program — no program agreement exists to sign.
    if (String(estimate.accepted_service_mode || '').toLowerCase() === 'one_time') {
      return { ok: true, skipped: 'one_time_accept' };
    }
    const estData = parseEstimateData(estimate.estimate_data);

    const facts = collectTermiteFacts(estData);
    if (!facts.hasProgram) return { ok: true, skipped: 'no_termite_program' };

    const NotificationService = require('./notification-service');

    if (isCommercialEstimate(estimate, estData)) {
      // Retirement failures must not swallow the operator handoff — the
      // bell still rings and the retirement retries on the next sweep.
      let commercialReplacementKept = false;
      try {
        ({ keptReplacement: commercialReplacementKept } = await retireSamePropertyOpenAgreements(customerId, estimate, await activeProgramVersionIds()));
      } catch (err) {
        logger.warn(`[termite-agreement] parked retirement failed for estimate ${estimate.id}: ${err.message}`);
      }
      if (commercialReplacementKept) return { ok: false, skipped: 'commercial', belled: true };
      let belled = null;
      const commercialBellState = await manualPrepBellAlreadySent(estimate.id);
      if (commercialBellState === true) belled = true;
      else if (commercialBellState === 'error') belled = false;
      else {
        belled = await ringAdminBell(NotificationService, [
          'estimate',
          'Termite agreement needs manual prep (commercial)',
          `${estimate.customer_name || 'Customer'} accepted a commercial termite estimate — commercial and multi-unit structures need a tailored agreement (different statutory retreat windows, tenant considerations), so prepare it manually from the document library.`,
          { icon: '\u{1F4DD}', link: `/admin/customers/${customerId}`, metadata: { estimateId: estimate.id, customerId } },
        ], `manual-prep (commercial) for estimate ${estimate.id}`);
      }
      return { ok: false, skipped: 'commercial', belled };
    }

    const prepay = await isAnnualPrepayAccept(estimate, billingTerm);
    if (prepay === 'error') return { ok: false, skipped: 'prepay_lookup_failed' };
    if (prepay) {
      // Fail closed: the seeded wording states per-application billing,
      // which would contradict the annual-prepay invoice. Park it for
      // manual preparation with accurate terms.
      let prepayReplacementKept = false;
      try {
        ({ keptReplacement: prepayReplacementKept } = await retireSamePropertyOpenAgreements(customerId, estimate, await activeProgramVersionIds()));
      } catch (err) {
        logger.warn(`[termite-agreement] parked retirement failed for estimate ${estimate.id}: ${err.message}`);
      }
      if (prepayReplacementKept) return { ok: false, skipped: 'annual_prepay', belled: true };
      let prepayBelled = null;
      const prepayBellState = await manualPrepBellAlreadySent(estimate.id);
      if (prepayBellState === true) prepayBelled = true;
      else if (prepayBellState === 'error') prepayBelled = false;
      else {
        prepayBelled = await ringAdminBell(NotificationService, [
          'estimate',
          'Termite agreement needs manual prep (annual prepay)',
          `${estimate.customer_name || 'Customer'} accepted a termite estimate on annual prepay — the standard program agreement states per-application billing, so prepare the agreement manually with the prepay terms.`,
          { icon: '\u{1F4DD}', link: `/admin/customers/${customerId}`, metadata: { estimateId: estimate.id, customerId } },
        ], `manual-prep (annual prepay) for estimate ${estimate.id}`);
      }
      return { ok: false, skipped: 'annual_prepay', belled: prepayBelled };
    }

    // The admin scheduling flow books the visit BEFORE the rows are linked
    // to the estimate (linkCreatedRowsToEstimate runs after acceptance), so
    // it passes the booked termite date explicitly — the DB lookup would
    // race the linking and permanently snapshot the fallback label.
    const startDateLabel = startDateLabelOverride
      || (estimate.id ? await scheduledStartDateLabel(estimate.id) : null);
    const prepared = buildTermiteProgramAgreementValues(estimate, estData, { startDateLabel });

    if (!prepared) {
      // Termite program present but figures unresolvable — park the
      // exception with the owner instead of drafting a wrong document.
      // (The reconciliation sweep passes notifyOnUnresolved=false so the
      // original accept-time bell isn't re-rung daily.)
      let figuresReplacementKept = false;
      try {
        ({ keptReplacement: figuresReplacementKept } = await retireSamePropertyOpenAgreements(customerId, estimate, await activeProgramVersionIds()));
      } catch (err) {
        logger.warn(`[termite-agreement] parked retirement failed for estimate ${estimate.id}: ${err.message}`);
      }
      if (figuresReplacementKept) return { ok: false, skipped: 'figures_unresolved', belled: true };
      let figuresBelled = null;
      const figuresBellState = await manualPrepBellAlreadySent(estimate.id);
      if (figuresBellState === true) figuresBelled = true;
      else if (figuresBellState === 'error') figuresBelled = false;
      else {
        figuresBelled = await ringAdminBell(NotificationService, [
          'estimate',
          'Termite agreement needs manual prep',
          `${estimate.customer_name || 'Customer'} accepted a termite estimate, but the program agreement couldn't be prefilled from the estimate figures. Prepare and send it from the document library.`,
          { icon: '\u{1F4DD}', link: `/admin/customers/${customerId}`, metadata: { estimateId: estimate.id, customerId } },
        ], `manual-prep (figures unresolved) for estimate ${estimate.id}`);
      }
      return { ok: false, skipped: 'figures_unresolved', belled: figuresBelled };
    }

    const activeVersionIds = await activeProgramVersionIds();
    const existing = await existingBlockingProgramAgreement(customerId, estimate, db, activeVersionIds);
    if (existing) return { ok: true, skipped: 'already_exists', contractId: existing.id };

    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
    if (!customer) return { ok: false, skipped: 'customer_not_found' };

    const {
      buildCustomerDocumentContext,
      renderDocumentTemplate,
      ESIGN_DISCLOSURE,
      jsonb,
    } = require('./document-template-library');

    const template = await db('document_templates')
      .where({ template_key: prepared.templateKey, status: 'active' })
      .first();
    const version = template?.active_version_id
      ? await db('document_template_versions').where({ id: template.active_version_id }).first()
      : null;
    if (!template || !version) return { ok: false, skipped: 'template_missing' };

    const context = buildCustomerDocumentContext(customer, prepared.values);
    // The agreement covers the ACCEPTED property, which may legitimately
    // differ from the customer's primary address (rental/second property —
    // see customer-address-fanout). The estimate address wins.
    if (estimate.address) {
      context.customer = { ...context.customer, address: estimate.address };
    }
    const rendered = renderDocumentTemplate({ template, version, context });
    if (rendered.unresolvedVariables.length) {
      logger.warn(`[termite-agreement] unresolved variables for estimate ${estimate.id}: ${rendered.unresolvedVariables.join(', ')}`);
      return { ok: false, skipped: 'unresolved_variables' };
    }

    // CUSTOMER-level lock: address text can vary in form between two
    // estimates for the same property, so per-address keys could let
    // concurrent preps for one customer proceed in parallel. Volume is a
    // handful of accepts a day — the coarser key costs nothing and makes
    // the one-open-draft-per-property invariant race-free.
    const dedupeLockKey = `termite-agreement:${customerId}`;
    const contract = await db.transaction(async (trx) => {
      // Serialize per customer+property: concurrent accept/reconciliation
      // workers (multi-pod cron) must not both observe "no row" and insert
      // duplicate drafts — the advisory xact lock + in-transaction re-check
      // make the dedupe atomic (pre-push P1).
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [dedupeLockKey]);
      // Revalidate the template's active version under the lock: an admin
      // publish/reactivation between the pre-transaction reads and here
      // must not let us insert (and autosend) an agreement rendered from a
      // no-longer-active version.
      // Lock BOTH program templates and rebuild the active-id set from the
      // locked truth: the pre-transaction snapshot could brand a freshly
      // published-and-issued v3 request 'stale' and cancel a delivered link.
      const lockedTemplates = await trx('document_templates')
        .whereIn('template_key', PROGRAM_TEMPLATE_KEYS)
        .forUpdate()
        .select('template_key', 'active_version_id');
      const lockedActiveIds = new Set(lockedTemplates.map((t) => t.active_version_id).filter(Boolean));
      const liveTemplate = lockedTemplates.find((t) => t.template_key === prepared.templateKey);
      if (!liveTemplate || liveTemplate.active_version_id !== version.id) return 'version_changed';
      // FOR UPDATE: the status re-read must be current when we cancel — a
      // customer signing the older agreement concurrently would otherwise
      // commit 'signed' between our unlocked read and an unconditional
      // update, and the completed signature would be clobbered 'cancelled'.
      const openRows = await openProgramAgreements(customerId, trx, { forUpdate: true });
      const nowTs = new Date();
      if (openRows.some((r) => classifyExistingAgreement(r, estimate, nowTs, { activeVersionIds: lockedActiveIds }) === 'blocks')) return null;
      // Signed re-check INSIDE the lock: a customer signing a (stale) request
      // for THIS estimate between an unlocked pre-check and this transaction
      // commits 'signed' — the row drops out of the open set above, and
      // without this check a second agreement would be created (and
      // autosent) on top of the executed one. Same-estimate only: a fresh
      // accept at the same property after an older signed agreement
      // legitimately gets a new document at the new figures.
      if (estimate.id) {
        const signedRows = await trx('customer_contracts')
          .where({ customer_id: customerId, contract_type: 'document_template' })
          .whereIn('document_template_key', PROGRAM_TEMPLATE_KEYS)
          .where('status', 'signed')
          .select('document_variables_snapshot');
        const acceptedAddress = normalizeAddress(estimate.address);
        const signedBlocks = signedRows.some((sr) => {
          let ss = sr.document_variables_snapshot;
          if (typeof ss === 'string') { try { ss = JSON.parse(ss); } catch { ss = null; } }
          if (ss?.estimate?.id && String(ss.estimate.id) === String(estimate.id)) return true;
          // Reconciliation callers block on same-PROPERTY signatures too (a
          // manually issued or different-estimate replacement signed mid-
          // sweep must not be stacked); accept-time callers keep the same-
          // estimate scope so a genuinely new accept still gets its new
          // document.
          if (signedBlockScope !== 'property') return false;
          const signedAddress = normalizeAddress(ss?.estimate?.address || ss?.customer?.address);
          if (!signedAddress || !acceptedAddress) return true;
          return signedAddress === acceptedAddress;
        });
        if (signedBlocks) return 'signed_exists';
      }
      // A revised estimate accepted for the same property supersedes the
      // older open draft — cancel it so exactly one live agreement exists
      // and it carries the ACCEPTED figures. The cancel stays conditional
      // on the row still being open (belt + braces with the row lock).
      const stale = openRows.filter((r) => classifyExistingAgreement(r, estimate, nowTs, { activeVersionIds: lockedActiveIds }) === 'supersede');
      for (const staleRow of stale) {
        const cancelled = await trx('customer_contracts')
          .where({ id: staleRow.id })
          .whereIn('status', OPEN_STATUSES)
          .update({
            status: 'cancelled',
            cancelled_at: nowTs,
            cancelled_reason: 'Superseded by a newer accepted termite estimate',
            updated_at: nowTs,
          });
        if (!cancelled) continue;
        await trx('customer_contract_events').insert({
          contract_id: staleRow.id,
          customer_id: customerId,
          event_type: 'cancelled',
          actor_type: 'system',
          actor_id: null,
          metadata: JSON.stringify({ reason: 'superseded', supersededByEstimateId: estimate.id }),
        });
      }
      const [row] = await trx('customer_contracts').insert({
        customer_id: customer.id,
        created_by: null,
        contract_type: 'document_template',
        title: rendered.title || version.title || template.name,
        status: 'draft',
        recipient_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || estimate.customer_name || null,
        recipient_email: customer.email || null,
        recipient_phone: customer.phone || null,
        service_name: 'Termite Bait Station Program',
        esign_disclosure_snapshot: version.signer_disclosure || ESIGN_DISCLOSURE,
        contract_text_snapshot: rendered.body,
        document_template_id: template.id,
        document_template_version_id: version.id,
        document_template_key: template.template_key,
        requires_signature_snapshot: template.requires_signature !== false,
        document_variables_snapshot: jsonb(context, {}),
        document_render_summary: jsonb(rendered.renderSummary, {}),
      }).returning('*');
      await trx('customer_contract_events').insert({
        contract_id: row.id,
        customer_id: customer.id,
        event_type: 'created',
        actor_type: 'system',
        actor_id: null,
        ip: req.ip || null,
        user_agent: req.get ? (req.get('user-agent') || null) : null,
        metadata: jsonb({ source: 'estimate_accept', estimateId: estimate.id, ownership: prepared.ownership }, {}),
      });
      return row;
    });
    if (contract === 'signed_exists') {
      return { ok: true, skipped: 'signed_exists' };
    }
    if (contract === 'version_changed') {
      // Retryable: the next sweep re-reads the fresh active version.
      return { ok: false, skipped: 'version_changed' };
    }
    if (!contract) {
      const winner = await existingBlockingProgramAgreement(customerId, estimate);
      return { ok: true, skipped: 'already_exists', contractId: winner?.id || null };
    }

    let autosent = false;
    if (autosendGateOn()) {
      try {
        const { deliverDocumentRequestChannels } = require('./document-contract-delivery');
        const delivery = await deliverDocumentRequestChannels(contract.id, req, { channels: ['email'] });
        // A resolved-but-failed delivery ({ok:false} — no email, opted out,
        // provider bounce) leaves the request in draft; the bell must say
        // "drafted", not "sent", so the owner knows it still needs sending.
        autosent = delivery?.ok === true;
      } catch (err) {
        logger.warn(`[termite-agreement] autosend failed for contract ${contract.id}: ${err.message}`);
      }
    }

    // The bell is the primary alert but not the only surface — the draft
    // also sits in the admin open document-requests queue. notifyAdmin
    // returns null (not a throw) on insert failure, so check and retry
    // once; on a double miss, log at error level with the contract id.
    const bellArgs = [
      'estimate',
      autosent ? 'Termite agreement sent for signature' : 'Termite agreement drafted',
      `${estimate.customer_name || 'Customer'} accepted the ${prepared.ownership === 'rent' ? 'rented-stations' : 'purchased-stations'} termite program — the agreement is ${autosent ? 'on its way for e-signature' : 'prefilled and ready to send from the document library'}.`,
      { icon: '\u{1F4DD}', link: `/admin/customers/${customerId}`, metadata: { estimateId: estimate.id, customerId, contractId: contract.id } },
    ];
    await ringAdminBell(NotificationService, bellArgs, `drafted bell for contract ${contract.id} (estimate ${estimate.id}) — draft remains in the open document-requests queue`);

    return { ok: true, contractId: contract.id, templateKey: prepared.templateKey, autosent };
  } catch (err) {
    logger.error(`[termite-agreement] agreement prep failed for estimate ${estimate?.id}: ${err.message}`);
    return { ok: false, skipped: 'error', error: err.message };
  }
}

// Superseded-request reconciliation: replaces requests retired by a
// template-version upgrade regardless of estimate age. Covers (a) rows the
// compliance migration cancelled — including estimates older than the main
// sweep's window — and (b) open rows still carrying a stale version (e.g. a
// request that raced past the migration during deploy; superseded in-txn by
// maybeCreate's version-aware classify). Runs with bells ON so re-preps
// that park (commercial/multi-unit, annual prepay, unresolved figures)
// hand off to the operator instead of vanishing silently. A SIGNED program
// row for the customer always blocks re-papering — executed contracts are
// historical records.
const REPROCESSED_EVENT = 'superseded_reprocessed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Conditionally retire a stale-open source row (no-op for rows already
// cancelled, e.g. by the compliance migration): the superseded wording's
// public signing link must die whenever the row is deemed handled.
async function cancelStaleSource(row, conn = db) {
  // Reactivation-safe AND atomic: the staleness condition rides the UPDATE
  // itself (NOT EXISTS an active pointer at this row's version), so an
  // admin reactivating the version between any pre-read and the write
  // cannot get a current request cancelled. The pre-read only provides the
  // fast-path 'reactivated' signal for callers.
  if (row.document_template_version_id && row.document_template_key) {
    const template = await conn('document_templates')
      .where({ template_key: row.document_template_key })
      .first('active_version_id');
    if (template?.active_version_id === row.document_template_version_id) return 'reactivated';
  }
  const cancelled = await conn('customer_contracts')
    .where({ id: row.id })
    .whereIn('status', OPEN_STATUSES)
    .modify((q) => {
      if (row.document_template_version_id && row.document_template_key) {
        q.whereNotExists(function stillStale() {
          this.select(conn.raw('1'))
            .from('document_templates as dt')
            .where('dt.template_key', row.document_template_key)
            .where('dt.active_version_id', row.document_template_version_id);
        });
      }
    })
    .update({
      status: 'cancelled',
      cancelled_at: new Date(),
      cancelled_reason: 'Superseded by updated compliance wording (v2 templates)',
      updated_at: new Date(),
    });
  if (cancelled) {
    await conn('customer_contract_events').insert({
      contract_id: row.id,
      customer_id: row.customer_id,
      event_type: 'cancelled',
      actor_type: 'system',
      actor_id: null,
      metadata: JSON.stringify({ reason: 'superseded_stale_version' }),
    });
    return true;
  }
  // Zero rows: either not open anymore (fine) or the atomic condition hit a
  // mid-flight reactivation — distinguish so the caller skips the marker.
  if (row.document_template_version_id && row.document_template_key) {
    const template = await conn('document_templates')
      .where({ template_key: row.document_template_key })
      .first('active_version_id');
    if (template?.active_version_id === row.document_template_version_id) return 'reactivated';
  }
  return false;
}

async function markSupersededHandled(row, outcome, conn = db) {
  await conn('customer_contract_events').insert({
    contract_id: row.id,
    customer_id: row.customer_id,
    event_type: REPROCESSED_EVENT,
    actor_type: 'system',
    actor_id: null,
    metadata: JSON.stringify({ outcome }),
  });
}

async function reconcileSupersededProgramAgreements({ limit = 50 } = {}) {
  const activeVersionIds = await activeProgramVersionIds();
  const results = { checked: 0, created: 0, skipped: 0, failed: 0 };
  if (!activeVersionIds.size) return results;

  // Handled rows carry a durable REPROCESSED_EVENT marker so the daily pass
  // ADVANCES: every terminal outcome (replaced, parked-with-bell, signed
  // elsewhere, estimate gone) is marked and excluded next run — the same 50
  // rows can't be re-selected forever and parked rows can't re-ring their
  // manual-prep bells every day. Only transient errors stay unmarked for a
  // retry.
  const notReprocessed = (query) => query.whereNotExists(function handled() {
    this.select(db.raw('1'))
      .from('customer_contract_events as cce')
      .whereRaw('cce.contract_id = customer_contracts.id')
      .where('cce.event_type', REPROCESSED_EVENT);
  });

  const staleOpen = await notReprocessed(db('customer_contracts')
    .whereIn('document_template_key', PROGRAM_TEMPLATE_KEYS)
    .whereIn('status', OPEN_STATUSES)
    .whereNotIn('document_template_version_id', [...activeVersionIds]))
    .select('id', 'customer_id', 'status', 'recipient_name', 'document_variables_snapshot', 'document_template_key', 'document_template_version_id')
    .limit(limit);
  const migrationCancelled = await notReprocessed(db('customer_contracts')
    .whereIn('document_template_key', PROGRAM_TEMPLATE_KEYS)
    .where('status', 'cancelled')
    .where('cancelled_reason', 'like', 'Superseded by updated compliance wording%'))
    .select('id', 'customer_id', 'status', 'recipient_name', 'document_variables_snapshot', 'document_template_key', 'document_template_version_id')
    .limit(limit);
  // A stale-version request whose token expired (processDocumentWorkflow
  // runs earlier in this same cron and stamps 'expired') is out of
  // OPEN_STATUSES and blocked by the ordinary sweep's anti-join — without
  // this leg it would never receive its compliant replacement. Its token is
  // already dead, so it only needs the re-prep, not a cancel.
  // Bounded to expiries at-or-after the OWN template's rollout: a request
  // that expired historically (or deliberately between two templates'
  // staggered upgrades) was already a deliberate blocker in the ordinary
  // sweep and must not be revived and autosent just because a newer
  // template version exists. The cutoff is applied IN SQL per template so
  // ineligible rows never occupy the limit window (limit-before-filter
  // would let a staggered-upgrade band starve genuine rollout casualties).
  const rolloutStarts = await activeVersionRolloutStarts();
  const expiredStale = [];
  for (const [templateKey, cutoff] of rolloutStarts) {
    const rows = await notReprocessed(db('customer_contracts')
      .where('document_template_key', templateKey)
      .where('status', 'expired')
      .whereNotIn('document_template_version_id', [...activeVersionIds])
      .where('share_token_expires_at', '>=', cutoff))
      .select('id', 'customer_id', 'status', 'recipient_name', 'document_variables_snapshot', 'document_template_key', 'document_template_version_id')
      .limit(limit);
    expiredStale.push(...rows);
  }

  const NotificationService = require('./notification-service');
  const seenEstimates = new Set();
  for (const row of [...staleOpen, ...migrationCancelled, ...expiredStale]) {
    if (results.checked >= limit) break;
    results.checked += 1;
    let snapshot = row.document_variables_snapshot;
    if (typeof snapshot === 'string') {
      try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; }
    }
    // The generic document route accepts arbitrary snapshot values, so a
    // manually issued request can carry an untrusted estimate.id — a
    // malformed one must not throw the whole pass, and any value that
    // doesn't survive validation routes to the manual-handoff branch.
    const estimateIdRaw = snapshot?.estimate?.id;
    const estimateId = UUID_RE.test(String(estimateIdRaw || '')) ? String(estimateIdRaw) : null;

    if (!estimateId) {
      // MANUALLY issued stale row (no estimate linkage — e.g. one that raced
      // past the migration): it is still openly signable on superseded
      // wording. Cancel it (conditional on still being open) and hand the
      // re-issue to the operator — never assume the migration covered it.
      // A version reactivated mid-sweep makes this row current again —
      // skip entirely with no marker (and no misleading cancelled bell).
      if ((await cancelStaleSource(row)) === 'reactivated') continue;
      // The bell IS the handoff — the row is only marked handled when it
      // actually landed; a double notify failure leaves the row eligible
      // for tomorrow's retry (the cancel above is conditional, so the
      // retry just re-rings the bell). A bell that already landed (e.g. the
      // durable marker write failed after a successful insert) counts as
      // landed — never duplicated.
      const reissueBellState = await adminBellExists('Re-issue termite agreement%', 'contractId', row.id);
      const belled = reissueBellState === true
        || (reissueBellState === false && await ringAdminBell(NotificationService, [
          'estimate',
          'Re-issue termite agreement (wording updated)',
          `The open termite program agreement for ${row.recipient_name || 'a customer'} was cancelled because its wording was superseded by the v2 compliance templates. It was issued manually, so re-issue it from the document library on the updated template.`,
          { icon: '\u{1F4DD}', link: `/admin/customers/${row.customer_id}`, metadata: { contractId: row.id, customerId: row.customer_id } },
        ], `manual stale-version re-issue for contract ${row.id}`));
      if (belled) await markSupersededHandled(row, 'manual_reissue_belled');
      else results.failed += 1;
      if (belled) results.skipped += 1;
      continue;
    }

    // Dedupe by customer+estimate: a manually issued row carrying ANOTHER
    // customer's (valid) estimate UUID must not poison the batch and route
    // the legitimate row into the duplicate branch.
    const dedupeKey = `${row.customer_id}:${estimateId}`;
    if (seenEstimates.has(dedupeKey)) {
      if ((await cancelStaleSource(row)) === 'reactivated') continue;
      await markSupersededHandled(row, 'duplicate_estimate');
      continue;
    }
    seenEstimates.add(dedupeKey);
    // Retire the stale source UP FRONT — every downstream outcome (signed
    // skip, replacement exists, estimate unavailable, parked, replaced, or
    // a concurrent reissue racing maybeCreate's already_exists) must leave
    // the superseded public signing link dead. Conditional + idempotent:
    // migration-cancelled and expired rows are no-ops, and the bell-retry
    // path stays bell-only. A version REACTIVATED mid-sweep makes the row
    // current again: skip it entirely with NO marker, so a later rollout
    // can reconsider it.
    if ((await cancelStaleSource(row)) === 'reactivated') continue;

    // Executed agreements stay executed — but only for THIS property/estimate:
    // a signed agreement at another of the customer's properties must not
    // block this one's replacement.
    const rowAddress = normalizeAddress(snapshot?.estimate?.address || snapshot?.customer?.address);
    const signedRows = await db('customer_contracts')
      .where({ customer_id: row.customer_id })
      .whereIn('document_template_key', PROGRAM_TEMPLATE_KEYS)
      .where('status', 'signed')
      .select('document_variables_snapshot');
    const signedSameProperty = signedRows.some((sr) => {
      let ss = sr.document_variables_snapshot;
      if (typeof ss === 'string') { try { ss = JSON.parse(ss); } catch { ss = null; } }
      if (ss?.estimate?.id && String(ss.estimate.id) === String(estimateId)) return true;
      const signedAddress = normalizeAddress(ss?.estimate?.address || ss?.customer?.address);
      if (!signedAddress || !rowAddress) return true; // unprovable — don't re-paper
      return signedAddress === rowAddress;
    });
    if (signedSameProperty) { await markSupersededHandled(row, 'signed_same_property'); results.skipped += 1; continue; }

    // Staff may have re-issued a replacement before this sweep (manually or
    // via a fresh accept): an OPEN request on the CURRENT template version
    // for the same estimate/property means the source row is fully handled —
    // processing it anyway would ring false manual-prep bells for parked
    // categories before maybeCreate's own dedupe runs.
    const openNow = await openProgramAgreements(row.customer_id);
    const nowForReplacement = new Date();
    const replacementExists = openNow.some((openRow) => {
      if (openRow.id === row.id) return false;
      if (!openRow.document_template_version_id || !activeVersionIds.has(openRow.document_template_version_id)) return false;
      // An expired-token row is no coverage: the customer's link 410s and
      // the row leaves OPEN_STATUSES on the next lifecycle pass.
      if (openRow.share_token_expires_at && new Date(openRow.share_token_expires_at) < nowForReplacement) return false;
      let os = openRow.document_variables_snapshot;
      if (typeof os === 'string') { try { os = JSON.parse(os); } catch { os = null; } }
      if (os?.estimate?.id && String(os.estimate.id) === String(estimateId)) return true;
      const openAddress = normalizeAddress(os?.estimate?.address || os?.customer?.address);
      if (!openAddress || !rowAddress) return true; // unprovable — treat as covering
      return openAddress === rowAddress;
    });
    if (replacementExists) {
      await markSupersededHandled(row, 'replacement_exists');
      results.skipped += 1;
      continue;
    }

    const estimate = await db('estimates').where({ id: estimateId }).first();
    if (!estimate || estimate.status !== 'accepted') {
      await markSupersededHandled(row, 'estimate_unavailable');
      results.skipped += 1;
      continue;
    }
    // The snapshot's estimate must belong to THIS contract's customer — an
    // untrusted id pointing at another customer's estimate must never feed
    // figures into (or autosend) an agreement. Park it with the operator.
    if (estimate.customer_id && String(estimate.customer_id) !== String(row.customer_id)) {
      const mismatchBellState = await adminBellExists('Re-issue termite agreement%', 'contractId', row.id);
      const mismatchBelled = mismatchBellState === true
        || (mismatchBellState === false && await ringAdminBell(NotificationService, [
          'estimate',
          'Re-issue termite agreement (wording updated)',
          `The cancelled termite program agreement for ${row.recipient_name || 'a customer'} referenced an estimate that does not belong to that customer, so it could not be replaced automatically. Re-issue it from the document library.`,
          { icon: '\u{1F4DD}', link: `/admin/customers/${row.customer_id}`, metadata: { contractId: row.id, customerId: row.customer_id } },
        ], `estimate-customer mismatch for contract ${row.id}`));
      if (mismatchBelled) {
        await markSupersededHandled(row, 'estimate_customer_mismatch');
        results.skipped += 1;
      } else {
        results.failed += 1;
      }
      continue;
    }

    const result = await maybeCreateTermiteProgramAgreement({
      estimate,
      customerId: row.customer_id,
      notifyOnUnresolved: true,
      signedBlockScope: 'property',
    });
    const parked = ['commercial', 'annual_prepay', 'figures_unresolved'].includes(result.skipped);
    if (result.ok && result.contractId && !result.skipped) {
      await markSupersededHandled(row, 'replaced');
      results.created += 1;
    } else if (result.ok) {
      await markSupersededHandled(row, result.skipped || 'skipped');
      results.skipped += 1;
    } else if (parked) {
      // Parked — but the bell IS the handoff: only terminal when it landed.
      // A failed bell leaves the source unmarked (cancelled above, so the
      // retry is bell-only) and counts as failed for tomorrow's run.
      if (result.belled === false) {
        results.failed += 1;
      } else {
        await markSupersededHandled(row, result.skipped);
        results.skipped += 1;
      }
    } else {
      results.failed += 1; // transient — stays unmarked for tomorrow's retry
    }
  }
  return results;
}

// Daily reconciliation (scheduler, document-lifecycle cron): re-prep any
// recently accepted termite estimate that has no program agreement —
// acceptance already committed, so a transient prep failure must not
// permanently strand the customer without the promised document. Idempotent
// via the same per-property dedupe as the accept-time path; unresolved
// figures don't re-ring the accept-time bell.
async function reconcileTermiteProgramAgreements({ sinceDays = 21, limit = 25 } = {}) {
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  // Keyset pagination past PERMANENT skips (annual_prepay,
  // figures_unresolved): those rows create no contract, so a plain
  // newest-N window would re-select them daily and starve older transient
  // failures. `limit` caps agreements CREATED per run; scanning is bounded
  // separately.
  const MAX_SCANNED = 200;
  const PAGE_SIZE = 50;
  const results = { checked: 0, created: 0, skipped: 0, failed: 0 };
  let beforeAcceptedAt = null;

  while (results.checked < MAX_SCANNED && results.created < limit) {
    const page = await db('estimates')
      .where({ status: 'accepted' })
      .whereNotNull('customer_id')
      .where('accepted_at', '>=', cutoff)
      .modify((q) => { if (beforeAcceptedAt) q.where('accepted_at', '<', beforeAcceptedAt); })
      .where((builder) => {
        builder.whereNull('accepted_service_mode').orWhereNot('accepted_service_mode', 'one_time');
      })
      .whereRaw("estimate_data::text ILIKE '%termite%'")
      // Estimates whose agreement already exists never occupy the window.
      // Snapshot estimate.id is stamped by every prep this service performs.
      .whereNotExists(function alreadyPrepped() {
        this.select(db.raw('1'))
          .from('customer_contracts as cc')
          .whereRaw('cc.customer_id = estimates.customer_id')
          .whereIn('cc.document_template_key', PROGRAM_TEMPLATE_KEYS)
          .whereRaw("cc.document_variables_snapshot->'estimate'->>'id' = estimates.id::text")
          // ONLY compliance-superseded cancels that the superseded pass has
          // NOT yet handled bypass the exists-check (the estimate still
          // needs a live agreement after a template-version retirement).
          // Once handled (superseded_reprocessed stamped — replaced or
          // parked with its bell), the row blocks again: without this, a
          // permanently parked commercial/prepay estimate would be retried
          // and counted failed by this sweep every day and eat the scan
          // window. Every other row blocks — a customer-declined or
          // admin-cancelled request reflects an intentional decision, and
          // COALESCE keeps NULL cancelled_reason rows as blockers.
          .whereRaw("NOT (cc.status = 'cancelled' AND COALESCE(cc.cancelled_reason, '') LIKE 'Superseded by updated compliance wording%' AND NOT EXISTS (SELECT 1 FROM customer_contract_events cce2 WHERE cce2.contract_id = cc.id AND cce2.event_type = 'superseded_reprocessed'))");
      })
      .orderBy('accepted_at', 'desc')
      .limit(PAGE_SIZE)
      .select('*');
    if (!page.length) break;

    for (const estimate of page) {
      if (results.checked >= MAX_SCANNED || results.created >= limit) break;
      results.checked += 1;
      const result = await maybeCreateTermiteProgramAgreement({
        estimate,
        customerId: estimate.customer_id,
        notifyOnUnresolved: false,
      });
      if (result.ok && result.contractId && !result.skipped) results.created += 1;
      else if (result.ok) results.skipped += 1;
      else results.failed += 1;
    }
    beforeAcceptedAt = page[page.length - 1].accepted_at;
  }
  return results;
}

module.exports = {
  isCommercialEstimate,
  reconcileSupersededProgramAgreements,
  PURCHASE_TEMPLATE_KEY,
  RENTAL_TEMPLATE_KEY,
  PROGRAM_TEMPLATE_KEYS,
  START_DATE_FALLBACK,
  buildTermiteProgramAgreementValues,
  classifyExistingAgreement,
  collectTermiteFacts,
  estimateMayDiscount,
  maybeCreateTermiteProgramAgreement,
  reconcileTermiteProgramAgreements,
  systemLabelFor,
};
