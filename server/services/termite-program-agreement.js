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

const PURCHASE_TEMPLATE_KEY = 'service_agreement.termite_bait_program_purchase';
const RENTAL_TEMPLATE_KEY = 'service_agreement.termite_bait_program_rental';
const PROGRAM_TEMPLATE_KEYS = [PURCHASE_TEMPLATE_KEY, RENTAL_TEMPLATE_KEY];
// Matches the delivery layer's TERMINAL_STATUSES — a cancelled/declined
// agreement doesn't block prepping a fresh one.
const TERMINAL_STATUSES = ['cancelled', 'declined', 'expired_final'];

const SYSTEM_LABEL = 'Trelona® ATBS annual bait stations';

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

// Walk the stored estimate payload for termite lines. Estimate saves carry
// engine lineItems at estimate_data.result.lineItems (modular saves) and/or
// estimate_data.lineItems; V1 client saves carry results.tmBait. Depth-capped
// like estimate-service-details' ownership walker.
function collectTermiteFacts(estData) {
  const facts = { hasProgram: false, ownership: 'own', perApp: null, installPrice: null, rentalPerApp: null };
  if (!estData || typeof estData !== 'object') return facts;

  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 6 || !node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const key = String(node.service || node.key || '').toLowerCase();
    if (key === 'termite_bait') {
      facts.hasProgram = true;
      if (facts.perApp == null && Number.isFinite(Number(node.perApp)) && Number(node.perApp) > 0) {
        facts.perApp = Number(node.perApp);
      }
      const installPrice = Number(node.installation?.price);
      if (facts.installPrice == null && Number.isFinite(installPrice) && installPrice > 0) {
        facts.installPrice = installPrice;
      }
      if (String(node.ownership || '').toLowerCase() === 'rent') facts.ownership = 'rent';
    }
    if (key === 'termite_station_rental') {
      facts.hasProgram = true;
      facts.ownership = 'rent';
      if (facts.rentalPerApp == null && Number.isFinite(Number(node.perApp)) && Number(node.perApp) > 0) {
        facts.rentalPerApp = Number(node.perApp);
      }
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(estData, 0);

  // Engine inputs are authoritative for the selected ownership structure
  // (the rental line proves rent; inputs can also say so directly).
  const termiteInputs = estData?.inputs?.services?.termite
    || estData?.engineInputs?.services?.termite
    || estData?.inputs?.services?.termite_bait
    || null;
  if (termiteInputs) {
    facts.hasProgram = true;
    if (String(termiteInputs.ownership || '').toLowerCase() === 'rent') facts.ownership = 'rent';
  }
  return facts;
}

// Build the template values for the matching ownership variant, or null when
// the required figures can't be resolved (fail-closed — see header).
function buildTermiteProgramAgreementValues(estimate = {}, estData = null) {
  const facts = collectTermiteFacts(estData || parseEstimateData(estimate.estimate_data));
  if (!facts.hasProgram) return null;

  const perApplication = money(facts.perApp);
  if (!perApplication) return null;

  const startDate = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });
  const base = {
    program: {
      system: SYSTEM_LABEL,
      per_application: perApplication,
    },
    service: { name: 'Termite Bait Station Program' },
    agreement: { start_date: startDate },
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

async function existingOpenProgramAgreement(customerId, conn = db) {
  return conn('customer_contracts')
    .where({ customer_id: customerId, contract_type: 'document_template' })
    .whereIn('document_template_key', PROGRAM_TEMPLATE_KEYS)
    .whereNotIn('status', TERMINAL_STATUSES)
    .first('id', 'status', 'document_template_key');
}

// Create the draft agreement for an accepted termite estimate. Never throws:
// acceptance must not fail because agreement prep did. Returns a small result
// object for logging/tests.
async function maybeCreateTermiteProgramAgreement({ estimate, customerId, req = {} }) {
  try {
    if (!estimate || !customerId) return { ok: false, skipped: 'missing_inputs' };
    const estData = parseEstimateData(estimate.estimate_data);
    const prepared = buildTermiteProgramAgreementValues(estimate, estData);

    const facts = collectTermiteFacts(estData);
    if (!facts.hasProgram) return { ok: true, skipped: 'no_termite_program' };

    const NotificationService = require('./notification-service');

    if (!prepared) {
      // Termite program present but figures unresolvable — park the
      // exception with the owner instead of drafting a wrong document.
      await NotificationService.notifyAdmin(
        'estimate',
        'Termite agreement needs manual prep',
        `${estimate.customer_name || 'Customer'} accepted a termite estimate, but the program agreement couldn't be prefilled from the estimate figures. Prepare and send it from the document library.`,
        { icon: '\u{1F4DD}', link: `/admin/customers/${customerId}`, metadata: { estimateId: estimate.id, customerId } },
      );
      return { ok: false, skipped: 'figures_unresolved' };
    }

    const existing = await existingOpenProgramAgreement(customerId);
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
    const rendered = renderDocumentTemplate({ template, version, context });
    if (rendered.unresolvedVariables.length) {
      logger.warn(`[termite-agreement] unresolved variables for estimate ${estimate.id}: ${rendered.unresolvedVariables.join(', ')}`);
      return { ok: false, skipped: 'unresolved_variables' };
    }

    const contract = await db.transaction(async (trx) => {
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

    let autosent = false;
    if (autosendGateOn()) {
      try {
        const { deliverDocumentRequestChannels } = require('./document-contract-delivery');
        await deliverDocumentRequestChannels(contract.id, req, { channels: ['email'] });
        autosent = true;
      } catch (err) {
        logger.warn(`[termite-agreement] autosend failed for contract ${contract.id}: ${err.message}`);
      }
    }

    await NotificationService.notifyAdmin(
      'estimate',
      autosent ? 'Termite agreement sent for signature' : 'Termite agreement drafted',
      `${estimate.customer_name || 'Customer'} accepted the ${prepared.ownership === 'rent' ? 'rented-stations' : 'purchased-stations'} termite program — the agreement is ${autosent ? 'on its way for e-signature' : 'prefilled and ready to send from the document library'}.`,
      { icon: '\u{1F4DD}', link: `/admin/customers/${customerId}`, metadata: { estimateId: estimate.id, customerId, contractId: contract.id } },
    );

    return { ok: true, contractId: contract.id, templateKey: prepared.templateKey, autosent };
  } catch (err) {
    logger.error(`[termite-agreement] agreement prep failed for estimate ${estimate?.id}: ${err.message}`);
    return { ok: false, skipped: 'error', error: err.message };
  }
}

module.exports = {
  PURCHASE_TEMPLATE_KEY,
  RENTAL_TEMPLATE_KEY,
  PROGRAM_TEMPLATE_KEYS,
  buildTermiteProgramAgreementValues,
  collectTermiteFacts,
  maybeCreateTermiteProgramAgreement,
};
