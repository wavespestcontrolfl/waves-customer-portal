// ============================================================
// commercial-proposal-agreement.js — "Accept & sign agreement" for an
// authored commercial proposal (GATE_COMMERCIAL_PROPOSAL_SIGN, owner
// decision 2026-10-23: a signed agreement for every commercial proposal).
//
// The recipient signs the owner-approved Commercial Pest Service Agreement
// (document library template service_agreement.commercial_pest) online, on
// the existing /contract/:token signing page. This module only ISSUES that
// agreement from the estimate, reports its state, and rings the office when
// it is signed; the signing itself is the existing contracts-public route.
//
// Signing is NOT acceptance (owner ruling 2026-09-24: never auto-book or
// auto-accept commercial; Waves staff confirm). Nothing here changes the
// estimate's status or creates a visit, invoice or charge. The estimate id
// and the proposal totals ride the contract's variables snapshot, so the
// signed copy ties to the quote and the sign hook can find the estimate.
// ============================================================

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');

const TEMPLATE_KEY = 'service_agreement.commercial_pest';
// The marker that makes a contract ours: only an agreement issued here carries
// it, so the sign hook is inert for every commercial agreement staff issued by hand.
const SNAPSHOT_SOURCE = 'commercial_proposal_sign';
const START_DATE_TEXT = 'Set when we schedule your first visit';
// Open = the customer can still sign it. A signed agreement is final; an
// expired, cancelled or voided one is replaced by a fresh agreement.
const OPEN_STATUSES = ['draft', 'sent', 'viewed'];
const SERVICE_NAME_MAX = 180; // customer_contracts.service_name is varchar(180)

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function money(value) {
  const n = Number(value) || 0;
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

// The number the proposal document prints ("Estimate <slug>"), else a short id.
function estimateNumber(estimate = {}) {
  const slug = String(estimate.estimate_slug || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  return slug || String(estimate.id || '').split('-')[0].toUpperCase();
}

const PER_YEAR_CADENCE = { 12: 'monthly', 6: 'every 2 months', 4: 'quarterly', 1: 'annual' };

// "quarterly" when every recurring line shares one cadence; otherwise the
// agreement points at the proposal's own schedule instead of guessing.
function cadencePhrase(proposal) {
  const cadences = new Set();
  for (const program of proposal.programs || []) {
    if (program.frequencyPerYear > 0) {
      cadences.add(PER_YEAR_CADENCE[program.frequencyPerYear] || `${program.frequencyPerYear} visits per year`);
    }
  }
  for (const building of proposal.buildings || []) {
    for (const item of building.lineItems || []) {
      if (item.frequency === 'one_time') continue;
      if (item.frequency === 'per_application') {
        if (item.visitsPerYear > 0) cadences.add(`${item.visitsPerYear} visits per year`);
      } else {
        cadences.add(String(item.frequencyLabel || item.frequency).toLowerCase());
      }
    }
  }
  return cadences.size === 1 ? `serviced ${[...cadences][0]}` : 'serviced on the schedules in your proposal';
}

function serviceName({ number, proposal, totals }) {
  const tax = totals.recurringTax > 0 ? `, plus ${String(proposal.taxLabel || 'sales tax').toLowerCase()}` : '';
  return `Commercial pest control — ${number} — ${money(totals.annualRecurring)} per year, ${cadencePhrase(proposal)}${tax}`
    .slice(0, SERVICE_NAME_MAX);
}

// The agreement's merge values. customer.name and customer.address are the
// business and property the proposal was written for, not the account row.
function buildAgreementValues(estimate, proposal, totals) {
  const number = estimateNumber(estimate);
  return {
    customer: {
      name: proposal.preparedFor || estimate.customer_name || '',
      address: proposal.propertyAddress || estimate.address || '',
    },
    service: { name: serviceName({ number, proposal, totals }) },
    agreement: { start_date: START_DATE_TEXT },
    estimate: {
      id: estimate.id,
      number,
      source: SNAPSHOT_SOURCE,
      title: proposal.title,
      annualRecurring: totals.annualRecurring,
      monthlyEquivalent: totals.monthlyEquivalent,
      oneTime: totals.oneTime,
      taxRate: totals.taxRate,
      recurringTax: totals.recurringTax,
      firstYearTotal: totals.firstYearTotal,
    },
  };
}

// The proposal this feature signs: authored (not the synthesized fallback)
// with a recurring service. A one-time-only proposal has no recurring
// agreement to sign.
function signableProposal(estimate) {
  const { normalizeProposal, computeProposalTotals } = require('./estimate-proposal');
  const proposal = normalizeProposal(estimate);
  if (proposal.enabled !== true) return null;
  const totals = computeProposalTotals(proposal);
  if (!(totals.annualRecurring > 0)) return null;
  return { proposal, totals };
}

// The agreement template promises Net 30 billing. A proposal can carry other terms (Net-15, due on receipt) or none, so
// online signing is offered only when the proposal's authored payment term is Net 30 (owner-approved template, not
// changed here). The ONE predicate behind /data, the route, the issuing re-check and the sign-time re-check.
const NET_30 = 'net30';
const PAYMENT_TERMS_NOTE = 'Online signing needs payment terms set to Net 30 (the agreement\u2019s terms).';
function signEligibility(estimate) {
  const found = signableProposal(estimate);
  if (!found) return { ok: false, reason: 'not_signable' };
  if (found.proposal.commercialTerms?.paymentTerms !== NET_30) return { ok: false, reason: 'payment_terms', ...found };
  return { ok: true, ...found };
}

// Stable JSON: object keys sorted, builder-only keys dropped (row ids the editor mints, `generated*` provenance
// of narrative lines), so re-saving the same quote never changes it and any customer-visible change does.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort()
      .filter((key) => key !== 'id' && !key.startsWith('generated'))
      .reduce((acc, key) => ({ ...acc, [key]: canonical(value[key]) }), {});
  }
  return value;
}

// sha256 over the normalized proposal (lines, programs, corrective work, scope, terms, tax rate), its totals, the
// merge values the contract renders, the customer and the template version.
function quoteFingerprint({ proposal, totals, values, customerId, templateVersionId }) {
  const { estimate: _estimate, ...rendered } = values;
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonical({ proposal, totals, rendered, customerId: String(customerId), templateVersionId: String(templateVersionId) })))
    .digest('hex');
}

// The fingerprint of the quote as it stands now, for one customer and one template version (the issuer passes the
// active version; the sign-time check passes the version the customer's contract was rendered from).
function currentFingerprint(estimate, { proposal, totals }, templateVersionId) {
  const values = buildAgreementValues(estimate, proposal, totals);
  return quoteFingerprint({ proposal, totals, values, customerId: estimate.customer_id, templateVersionId });
}

function estimateAgreementQuery(estimateId, conn) {
  return conn('customer_contracts')
    .where({ document_template_key: TEMPLATE_KEY })
    .whereRaw("document_variables_snapshot -> 'estimate' ->> 'id' = ?", [String(estimateId)]);
}

// none | awaiting | signed, for one estimate. Signed wins over awaiting.
async function agreementStateForEstimate(estimateId, conn = db) {
  const row = await estimateAgreementQuery(estimateId, conn)
    .whereNotIn('status', ['cancelled', 'voided', 'expired'])
    .orderByRaw("(status = 'signed') DESC, created_at DESC")
    .first('id', 'status', 'created_at', 'shared_at', 'signed_at');
  if (!row) return { state: 'none' };
  if (row.status === 'signed') return { state: 'signed', contractId: row.id, signedAt: row.signed_at };
  return { state: 'awaiting', contractId: row.id, since: row.shared_at || row.created_at };
}

// /data's cta.commercialAgreement: null (nothing new on the payload) unless the
// estimate carries a signable authored proposal. canSign is false without an
// account to hang the agreement on (the page then says to call) or once signed.
async function agreementCtaFor(estimate, conn = db) {
  try {
    const eligibility = signEligibility(estimate);
    if (eligibility.reason === 'not_signable') return null;
    const { state } = await agreementStateForEstimate(estimate.id, conn);
    if (state === 'signed') return { canSign: false, state };
    if (!eligibility.ok) return { canSign: false, state, reason: eligibility.reason };
    return { canSign: Boolean(estimate.customer_id), state };
  } catch (err) {
    logger.warn(`[commercial-agreement] cta skipped for estimate ${estimate?.id}: ${err.code || 'error'}`);
    return null;
  }
}

// The admin builder's read: the agreement state, plus why online signing is not offered when the proposal's payment
// terms are not Net 30 (signingBlocked), so the line can say what to change.
async function agreementAdminStatus(estimate, conn = db) {
  const state = await agreementStateForEstimate(estimate.id, conn);
  const eligibility = signEligibility(estimate);
  return state.state !== 'signed' && eligibility.reason === 'payment_terms'
    ? { ...state, signingBlocked: 'payment_terms', note: PAYMENT_TERMS_NOTE }
    : state;
}

function refusal(status, code, error) {
  return { ok: false, status, code, error };
}

// Issue the agreement for this estimate, or return the open one with a fresh
// signing link (only a hash of the link is stored, so every call rotates it).
// `blockedFor(trx, lockedEstimate)` re-runs the route's eligibility checks on
// the estimate row locked here; true = the estimate stopped being signable.
async function ensureAgreement({ estimate, req = {}, blockedFor = async () => false, database = db }) {
  if (!signEligibility(estimate).ok) return refusal(404, 'not_signable', 'Estimate not found');
  if (!estimate.customer_id) {
    return refusal(409, 'no_customer', 'We need to set up your account before you can sign online. Please call us and we will get you started.');
  }
  const { renderDocumentTemplate, buildCustomerDocumentContext, lockActiveVersionForIssue, jsonb } = require('./document-template-library');
  const {
    ESIGN_DISCLOSURE, documentContractExpiresAt, hashContractToken, mintContractToken, publicContractUrl, signerName,
  } = require('./contracts');
  const { lockCustomerComms } = require('../utils/customer-comms-lock');

  const template = await database('document_templates').where({ template_key: TEMPLATE_KEY, status: 'active' }).first();
  const version = template?.active_version_id
    ? await database('document_template_versions').where({ id: template.active_version_id }).first()
    : null;
  if (!template || !version) return refusal(409, 'template_unavailable', 'Online signing is not available right now. Please call us.');

  const token = mintContractToken();
  const eventContext = (metadata) => ({
    actor_type: 'customer',
    actor_id: null,
    ip: req.ip || null,
    user_agent: req.get ? (req.get('user-agent') || null) : null,
    metadata: jsonb(metadata, {}),
  });

  const outcome = await database.transaction(async (trx) => {
    // estimates → leads → call_log (blockedFor) → comms fence → customers → template → contracts:
    // the order the accept path and the contract sign route already hold.
    const locked = await trx('estimates').where({ id: estimate.id }).forUpdate().first();
    if (!locked || await blockedFor(trx, locked)) return refusal(404, 'not_signable', 'Estimate not found');
    const lockedFound = signEligibility(locked);
    if (!lockedFound.ok) return refusal(404, 'not_signable', 'Estimate not found');
    if (!locked.customer_id) return refusal(409, 'no_customer', 'We need to set up your account before you can sign online. Please call us and we will get you started.');

    await lockCustomerComms(trx, locked.customer_id);
    const customer = await trx('customers').where({ id: locked.customer_id }).whereNull('deleted_at').forUpdate().first();
    if (!customer || customer.active === false) {
      return refusal(409, 'customer_unavailable', 'Online signing is not available right now. Please call us.');
    }
    await lockActiveVersionForIssue(trx, { template, activeVersion: version });
    // The gate is read again here, after the last lock and before any write: a request that waited on those locks
    // while the kill switch was thrown must not create or re-open an agreement (live gate re-read at the commit boundary).
    if (!require('../config/feature-gates').commercialProposalSignLive()) return refusal(404, 'not_signable', 'Estimate not found');

    const values = buildAgreementValues(locked, lockedFound.proposal, lockedFound.totals);
    // The whole quote this agreement is for. An open agreement is reused only when the quote is identical.
    values.estimate.fingerprint = currentFingerprint(locked, lockedFound, version.id);
    const now = new Date();
    const expiresAt = documentContractExpiresAt(now, template.expire_after_days, template);

    const existing = await estimateAgreementQuery(locked.id, trx)
      .whereIn('status', ['signed', ...OPEN_STATUSES])
      .orderByRaw("(status = 'signed') DESC, created_at DESC")
      .forUpdate()
      .first();
    if (existing?.status === 'signed') return refusal(409, 'already_signed', 'This agreement has already been signed.');
    if (existing) {
      const snap = parseJson(existing.document_variables_snapshot);
      if (snap?.estimate?.fingerprint === values.estimate.fingerprint) {
        // Idempotent: the same open agreement, with a fresh link for this visit.
        await trx('customer_contracts').where({ id: existing.id }).update({
          status: 'sent',
          share_token_hash: hashContractToken(token),
          share_token_expires_at: expiresAt,
          shared_at: now,
          updated_at: now,
        });
        await trx('customer_contract_events').insert({
          contract_id: existing.id,
          customer_id: customer.id,
          event_type: 'share_link_created',
          ...eventContext({ source: SNAPSHOT_SOURCE, estimateId: locked.id, expiresAt: expiresAt.toISOString() }),
        });
        return { ok: true, status: 200, created: false, contractId: existing.id };
      }
      // The proposal (or the template) changed since it was issued: retire the
      // stale agreement so only the current terms can be signed.
      const cancelled = await trx('customer_contracts').where({ id: existing.id }).whereIn('status', OPEN_STATUSES).update({
        status: 'cancelled',
        cancelled_at: now,
        cancelled_reason: 'Superseded: the proposal changed before it was signed',
        share_token_hash: null,
        share_token_expires_at: null,
        updated_at: now,
      });
      if (cancelled) {
        await trx('customer_contract_events').insert({
          contract_id: existing.id,
          customer_id: existing.customer_id,
          event_type: 'cancelled',
          ...eventContext({ reason: 'superseded', estimateId: locked.id }),
        });
      }
    }

    const context = buildCustomerDocumentContext(customer, values);
    context.customer = { ...context.customer, name: values.customer.name || context.customer.name, address: values.customer.address || context.customer.address };
    const rendered = renderDocumentTemplate({ template, version, context });
    if (rendered.unresolvedVariables.length) {
      logger.warn(`[commercial-agreement] unresolved variables for estimate ${locked.id}: ${rendered.unresolvedVariables.join(', ')}`);
      return refusal(409, 'template_unavailable', 'Online signing is not available right now. Please call us.');
    }
    const [row] = await trx('customer_contracts').insert({
      customer_id: customer.id,
      created_by: null,
      contract_type: 'document_template',
      title: rendered.title || version.title || template.name,
      status: 'sent',
      recipient_name: signerName(customer),
      recipient_email: customer.email || null,
      recipient_phone: customer.phone || null,
      service_name: context.service?.name || null,
      esign_disclosure_snapshot: version.signer_disclosure || ESIGN_DISCLOSURE,
      contract_text_snapshot: rendered.body,
      share_token_hash: hashContractToken(token),
      share_token_expires_at: expiresAt,
      shared_at: now,
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
      event_type: 'created_from_document_template',
      ...eventContext({ source: SNAPSHOT_SOURCE, estimateId: locked.id, templateKey: template.template_key, templateVersionId: version.id }),
    });
    await trx('customer_contract_events').insert({
      contract_id: row.id,
      customer_id: customer.id,
      event_type: 'share_link_created',
      ...eventContext({ source: SNAPSHOT_SOURCE, estimateId: locked.id, expiresAt: expiresAt.toISOString() }),
    });
    return { ok: true, status: 201, created: true, contractId: row.id };
  });

  if (!outcome.ok) return outcome;
  return { ...outcome, signingUrl: publicContractUrl(token) };
}

const STALE_PROPOSAL_MESSAGE = 'This proposal was updated. Please open the latest proposal to sign.';

// Sign boundary, step 1 (contracts-public POST /:token/sign, BEFORE it locks the customer row): for a contract this
// feature issued, lock the estimate row and run the issuer's own locked re-check. Lock order is the issuer's:
// estimates → leads → call_log → customers → contracts, so the two paths cannot deadlock. null = not ours.
async function lockEstimateForSign(trx, contractPeek) {
  if (contractPeek?.document_template_key !== TEMPLATE_KEY) return null;
  const snapEstimate = parseJson(contractPeek.document_variables_snapshot)?.estimate;
  if (snapEstimate?.source !== SNAPSHOT_SOURCE || !snapEstimate.id) return null;
  const estimate = await trx('estimates').where({ id: snapEstimate.id }).forUpdate().first();
  const { commercialAgreementBlockedFor } = require('../routes/estimate-public');
  return { estimate, blocked: !estimate || await commercialAgreementBlockedFor(trx, estimate) };
}

// Sign boundary, step 2 (inside the sign transaction, with the contract locked, before it writes 'signed'): the
// contract may be signed only while the quote it shows is still the quote: gate on, estimate still open, Net 30 still
// authored, same customer, same fingerprint. Otherwise the stale open contract is cancelled in the same transaction
// (the caller commits it) and the caller answers 409 with the returned message. null = fine to sign.
async function refuseStaleSignature({ trx, contract, estimateLock, req = {} }) {
  let reason = null;
  const { estimate } = estimateLock;
  if (!require('../config/feature-gates').commercialProposalSignLive()) reason = 'gate_off';
  else if (estimateLock.blocked) reason = 'estimate_closed';
  else {
    const eligibility = signEligibility(estimate);
    if (!eligibility.ok) reason = eligibility.reason;
    else if (String(estimate.customer_id) !== String(contract.customer_id)) reason = 'customer_changed';
    else if (parseJson(contract.document_variables_snapshot)?.estimate?.fingerprint
      !== currentFingerprint(estimate, eligibility, contract.document_template_version_id)) reason = 'proposal_changed';
  }
  if (!reason) return null;
  const now = new Date();
  const cancelled = await trx('customer_contracts').where({ id: contract.id }).whereIn('status', OPEN_STATUSES).update({
    status: 'cancelled',
    cancelled_at: now,
    cancelled_reason: 'Superseded: the proposal changed before it was signed',
    share_token_hash: null,
    share_token_expires_at: null,
    updated_at: now,
  });
  if (cancelled) {
    await trx('customer_contract_events').insert({
      contract_id: contract.id,
      customer_id: contract.customer_id,
      event_type: 'cancelled',
      actor_type: 'system',
      actor_id: null,
      ip: req.ip || null,
      user_agent: req.get ? (req.get('user-agent') || null) : null,
      metadata: JSON.stringify({ reason: 'stale_at_signature', cause: reason, estimateId: estimate?.id || null }),
    });
  }
  return STALE_PROPOSAL_MESSAGE;
}

// After a customer signs (contracts-public, after commit): tell the office the
// agreement is in, and leave an activity row on the estimate. Never throws.
// Inert for any contract this module did not issue. The estimate is NOT touched.
async function handleAgreementSigned({ contractId, database = db }) {
  try {
    const contract = await database('customer_contracts').where({ id: contractId }).first();
    if (!contract || contract.document_template_key !== TEMPLATE_KEY || contract.status !== 'signed') return { skipped: 'not_commercial_agreement' };
    const snapshot = parseJson(contract.document_variables_snapshot);
    const est = snapshot?.estimate;
    if (est?.source !== SNAPSHOT_SOURCE || !est.id) return { skipped: 'no_estimate' };

    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction, tidyName } = require('./admin-alert-names');
    const name = tidyName(snapshot.customer?.name || contract.recipient_name || 'Customer');
    const number = String(est.number || '').replace(/[^A-Za-z0-9-]/g, '') || 'the proposal';
    const signedOn = contract.signed_at
      ? new Date(contract.signed_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
      : '';

    await raiseAdminAlert('customer', {
      area: 'Estimates',
      action: fitAction('Estimates', name, [
        (who) => `mark ${who} won and book the first visit`,
        (who) => `mark ${who} won`,
      ]),
      why: `Signed the commercial agreement for ${number}; the estimate is still open and nothing is booked.`,
      severity: 'needs-you',
      link: `/admin/estimates/${est.id}/proposal`,
      subject: { type: 'estimate', id: String(est.id) },
      doneWhen: 'estimate_marked_won',
      who: 'person',
    }, {
      // A customer signing is a customer acting: the bell policy never silences it.
      bell: true,
      dedupeKey: `commercial-agreement-signed:${contract.id}`,
      detail: `${name} signed the Commercial Pest Service Agreement for ${number}${signedOn ? ` on ${signedOn}` : ''}. The estimate was not accepted, and no visit, invoice or charge was created. Mark the estimate won, then schedule the first visit. The signed copy goes to the customer by email.`,
      metadata: { estimateId: est.id, customerId: contract.customer_id, contractId: contract.id },
    });

    try {
      await database('activity_log').insert({
        customer_id: contract.customer_id || null,
        estimate_id: est.id,
        action: 'commercial_agreement_signed',
        description: `${name} signed the commercial agreement for ${number}.`,
        metadata: JSON.stringify({ contractId: contract.id, templateKey: TEMPLATE_KEY }),
      });
    } catch (err) {
      logger.warn(`[commercial-agreement] activity row skipped for contract ${contract.id}: ${err.code || 'error'}`);
    }
    return { alerted: true };
  } catch (err) {
    logger.error(`[commercial-agreement] signed hook failed for contract ${contractId}: ${err.message}`);
    return { skipped: 'error' };
  }
}

module.exports = {
  TEMPLATE_KEY,
  SNAPSHOT_SOURCE,
  START_DATE_TEXT,
  buildAgreementValues,
  signableProposal,
  signEligibility,
  PAYMENT_TERMS_NOTE,
  STALE_PROPOSAL_MESSAGE,
  agreementAdminStatus,
  lockEstimateForSign,
  refuseStaleSignature,
  agreementStateForEstimate,
  agreementCtaFor,
  ensureAgreement,
  handleAgreementSigned,
};
