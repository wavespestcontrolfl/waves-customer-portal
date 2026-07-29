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

    if (key === 'termite_bait' || (!key && /termite bait/.test(name))) {
      facts.hasProgram = true;
      // Raw engine lines carry the FINAL discounted annual (same ladder the
      // comparison sheet uses: manualFinalAnnual ?? annualAfterDiscount ??
      // annual) — the authoritative net per-application source.
      const finalAnnual = Number(node.manualFinalAnnual ?? node.annualAfterDiscount ?? node.annual);
      const visits = Number(node.visitsPerYear ?? node.visits) || 4;
      if (Number.isFinite(finalAnnual) && finalAnnual > 0) {
        takePerApp(Math.round((finalAnnual / visits) * 100) / 100, { net: true });
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

function normalizeAddress(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Classify an existing contract row against the accepted estimate:
//  'blocks'    — open request for THIS estimate; nothing to do.
//  'supersede' — open request for the same property from a DIFFERENT
//                estimate: its figures are stale, so it is cancelled and a
//                fresh agreement drafted (pre-push P0: a revised accept must
//                never leave the old-priced legal draft as the live one).
//  'ignore'    — terminal/expired, or a different property.
function classifyExistingAgreement(row, estimate, now = new Date()) {
  if (!row) return 'ignore';
  const status = String(row.status || '').toLowerCase();
  if (!OPEN_STATUSES.includes(status)) return 'ignore';
  if (row.share_token_expires_at && new Date(row.share_token_expires_at) < now) return 'ignore';

  let snapshot = row.document_variables_snapshot;
  if (typeof snapshot === 'string') {
    try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; }
  }
  const snapEstimateId = snapshot?.estimate?.id || null;
  if (snapEstimateId && estimate?.id && String(snapEstimateId) === String(estimate.id)) return 'blocks';

  const snapAddress = normalizeAddress(snapshot?.estimate?.address || snapshot?.customer?.address);
  const acceptedAddress = normalizeAddress(estimate?.address);
  if (!snapAddress || !acceptedAddress) return 'supersede'; // same customer, unprovable property — one open draft max
  return snapAddress === acceptedAddress ? 'supersede' : 'ignore';
}

async function openProgramAgreements(customerId, conn = db, { forUpdate = false } = {}) {
  const query = conn('customer_contracts')
    .where({ customer_id: customerId, contract_type: 'document_template' })
    .whereIn('document_template_key', PROGRAM_TEMPLATE_KEYS)
    .whereIn('status', OPEN_STATUSES)
    .select('id', 'customer_id', 'status', 'share_token_expires_at', 'document_variables_snapshot');
  return forUpdate ? query.forUpdate() : query;
}

async function existingBlockingProgramAgreement(customerId, estimate, conn = db) {
  const rows = await openProgramAgreements(customerId, conn);
  const now = new Date();
  return rows.find((row) => classifyExistingAgreement(row, estimate, now) === 'blocks') || null;
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

// Create the draft agreement for an accepted termite estimate. Never throws
// into the caller (acceptance must not fail because agreement prep did);
// failures are retryable via reconcileTermiteProgramAgreements. Returns a
// small result object for logging/tests.
async function maybeCreateTermiteProgramAgreement({ estimate, customerId, req = {}, notifyOnUnresolved = true, billingTerm = null }) {
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

    const prepay = await isAnnualPrepayAccept(estimate, billingTerm);
    if (prepay === 'error') return { ok: false, skipped: 'prepay_lookup_failed' };
    if (prepay) {
      // Fail closed: the seeded wording states per-application billing,
      // which would contradict the annual-prepay invoice. Park it for
      // manual preparation with accurate terms.
      if (notifyOnUnresolved) {
        await NotificationService.notifyAdmin(
          'estimate',
          'Termite agreement needs manual prep (annual prepay)',
          `${estimate.customer_name || 'Customer'} accepted a termite estimate on annual prepay — the standard program agreement states per-application billing, so prepare the agreement manually with the prepay terms.`,
          { icon: '\u{1F4DD}', link: `/admin/customers/${customerId}`, metadata: { estimateId: estimate.id, customerId } },
        );
      }
      return { ok: false, skipped: 'annual_prepay' };
    }

    const startDateLabel = estimate.id ? await scheduledStartDateLabel(estimate.id) : null;
    const prepared = buildTermiteProgramAgreementValues(estimate, estData, { startDateLabel });

    if (!prepared) {
      // Termite program present but figures unresolvable — park the
      // exception with the owner instead of drafting a wrong document.
      // (The reconciliation sweep passes notifyOnUnresolved=false so the
      // original accept-time bell isn't re-rung daily.)
      if (notifyOnUnresolved) {
        await NotificationService.notifyAdmin(
          'estimate',
          'Termite agreement needs manual prep',
          `${estimate.customer_name || 'Customer'} accepted a termite estimate, but the program agreement couldn't be prefilled from the estimate figures. Prepare and send it from the document library.`,
          { icon: '\u{1F4DD}', link: `/admin/customers/${customerId}`, metadata: { estimateId: estimate.id, customerId } },
        );
      }
      return { ok: false, skipped: 'figures_unresolved' };
    }

    const existing = await existingBlockingProgramAgreement(customerId, estimate);
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

    // Addressless estimates share the CUSTOMER-level key: two concurrent
    // addressless accepts must contend for the same lock (their property
    // can't be distinguished, so only one open draft may exist).
    const dedupeLockKey = `termite-agreement:${customerId}:${normalizeAddress(estimate.address) || 'customer'}`;
    const contract = await db.transaction(async (trx) => {
      // Serialize per customer+property: concurrent accept/reconciliation
      // workers (multi-pod cron) must not both observe "no row" and insert
      // duplicate drafts — the advisory xact lock + in-transaction re-check
      // make the dedupe atomic (pre-push P1).
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [dedupeLockKey]);
      // FOR UPDATE: the status re-read must be current when we cancel — a
      // customer signing the older agreement concurrently would otherwise
      // commit 'signed' between our unlocked read and an unconditional
      // update, and the completed signature would be clobbered 'cancelled'.
      const openRows = await openProgramAgreements(customerId, trx, { forUpdate: true });
      const nowTs = new Date();
      if (openRows.some((r) => classifyExistingAgreement(r, estimate, nowTs) === 'blocks')) return null;
      // A revised estimate accepted for the same property supersedes the
      // older open draft — cancel it so exactly one live agreement exists
      // and it carries the ACCEPTED figures. The cancel stays conditional
      // on the row still being open (belt + braces with the row lock).
      const stale = openRows.filter((r) => classifyExistingAgreement(r, estimate, nowTs) === 'supersede');
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
    let bell = await NotificationService.notifyAdmin(...bellArgs);
    if (!bell) bell = await NotificationService.notifyAdmin(...bellArgs);
    if (!bell) {
      logger.error(`[termite-agreement] admin bell failed twice for contract ${contract.id} (estimate ${estimate.id}) — draft is in the open document-requests queue`);
    }

    return { ok: true, contractId: contract.id, templateKey: prepared.templateKey, autosent };
  } catch (err) {
    logger.error(`[termite-agreement] agreement prep failed for estimate ${estimate?.id}: ${err.message}`);
    return { ok: false, skipped: 'error', error: err.message };
  }
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
          .whereRaw("cc.document_variables_snapshot->'estimate'->>'id' = estimates.id::text");
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
