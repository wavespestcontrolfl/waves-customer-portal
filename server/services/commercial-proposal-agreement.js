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
// agreement.payment_terms is the payment paragraph for the proposal's payment
// term (template version 2); empty for a term the agreement cannot carry, so the
// render reports it unresolved and nothing is issued.
function buildAgreementValues(estimate, proposal, totals) {
  const number = estimateNumber(estimate);
  return {
    customer: {
      name: proposal.preparedFor || estimate.customer_name || '',
      address: proposal.propertyAddress || estimate.address || '',
    },
    service: { name: serviceName({ number, proposal, totals }) },
    agreement: {
      start_date: START_DATE_TEXT,
      payment_terms: AGREEMENT_PAYMENT_TEXT[proposal.commercialTerms?.paymentTerms] || '',
    },
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
      // The whole quote the signature covers, frozen with the contract: the estimate stays open and editable after
      // signing, so the hash alone could not show what was signed. Builder-only keys are dropped (see canonical).
      proposal: canonical(proposal),
      totals: canonical(totals),
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

// The Commercial Pest Service Agreement template FIXES its terms: a 12-month initial term that renews automatically for
// 12-month terms unless either party gives written notice at least 30 days before the term ends, cancellation on 30 days'
// written notice, and price adjustment at renewal or with at least 30 days' notice. Its payment paragraph is one of three
// (AGREEMENT_PAYMENT_TEXT): Auto Pay, the commercial default (owner 2026-10-24, GATE_COMMERCIAL_AUTOPAY), on a proposal
// that does not bill by invoice, or Net 30 or Net 60 (owner 2026-10-29). A proposal whose structured commercialTerms say anything else would sit
// beside a contradictory signed agreement, so online signing is offered only when EVERY structured term agrees with the
// agreement. This is the one chokepoint (agreementTermsConflict, used through signEligibility by /data, the route, the
// issuing re-check and the sign-time re-check); a new term never gets its own ad-hoc check.
//
// The fields are read from the proposal normalizer's own output (normalizeCommercialTerms keeps only its known keys,
// null when empty), so a field added to the normalizer later arrives here with no rule and FAILS CLOSED until a rule
// is written. `accessRequirements` (site access) and the free-text `terms` ("Additional terms") do not block: they add
// to the agreement, they do not contradict a fixed term.
//
// These are the agreement-aligned texts the builder will prefill; a field is also fine blank (the agreement governs).
const {
  AGREEMENT_TERMS, AGREEMENT_PAYMENT_TEXT, AUTOPAY_PAYMENT_TERMS, INVOICE_PAYMENT_TERMS, INVOICE_PAYMENT_TERM_CHOICES,
  NET60_PAYMENT_TERMS, normalizeTermText,
} = require('../../shared/commercial-agreement-terms.cjs');

const commercialAutopayLive = () => require('../config/feature-gates').commercialAutopayLive();

// Case, whitespace and apostrophe style do not matter (normalizeTermText, shared with the builder's Standard choice).
const matchesDefaultText = (key) => (value) => normalizeTermText(value) === normalizeTermText(AGREEMENT_TERMS[key]);

// field -> { detail: what the builder line asks for, allowed(value): the value the agreement can sit beside }.
// A blank value never reaches allowed(): blank is always fine (the payment term is checked apart, below).
const TERM_RULES = Object.freeze({
  initialTermMonths: { detail: 'initial term 12 months (or blank)', allowed: (v) => Number(v) === AGREEMENT_TERMS.initialTermMonths },
  renewal: { detail: 'renewal blank or automatic 12-month terms with 30 days\' notice', allowed: matchesDefaultText('renewal') },
  cancellation: { detail: 'cancellation blank or 30 days\' written notice', allowed: matchesDefaultText('cancellation') },
  priceAdjustment: { detail: 'price adjustment blank or at renewal / with 30 days\' notice', allowed: matchesDefaultText('priceAdjustment') },
  accessRequirements: { detail: 'site access', allowed: () => true },
});

// The payment term is REQUIRED (a proposal silent on it has not agreed to a payment paragraph): Net 30 or Net 60, or
// Auto Pay while GATE_COMMERCIAL_AUTOPAY is on and the proposal does not bill by invoice (an invoice-mode proposal bills
// its first invoice on its terms; Auto Pay charges each completed service). The save, the Bill-by-invoice switch and the
// win enforce the same pairing; this re-check keeps a stale pairing from reaching a signature.
function paymentTermsConflict(paymentTerms, { billByInvoice = false } = {}) {
  if (INVOICE_PAYMENT_TERM_CHOICES.includes(paymentTerms)) return null;
  const autopayOn = commercialAutopayLive();
  if (paymentTerms === AUTOPAY_PAYMENT_TERMS && autopayOn && billByInvoice !== true) return null;
  return {
    field: 'paymentTerms',
    detail: autopayOn ? 'payment terms Auto Pay, or Net 30 or Net 60 with Bill by invoice' : 'payment terms Net 30 or Net 60',
  };
}

// null = every structured term except payment agrees with the agreement; else { field, detail } for the first conflict.
function fixedTermsConflict(terms = {}) {
  for (const [field, value] of Object.entries(terms || {})) {
    if (field === 'paymentTerms' || value === null || value === undefined || value === '') continue;
    const rule = TERM_RULES[field];
    if (!rule) return { field, detail: 'the terms fields (one is not covered by the agreement)' };
    if (!rule.allowed(value)) return { field, detail: rule.detail };
  }
  return null;
}

// null = the proposal's structured terms agree with the agreement; else { field, detail } for the first conflict.
// `billByInvoice`: the estimate's own bill_by_invoice (signEligibility passes it).
function agreementTermsConflict(proposal, { billByInvoice = false } = {}) {
  const terms = proposal?.commercialTerms || {};
  return paymentTermsConflict(terms.paymentTerms, { billByInvoice }) || fixedTermsConflict(terms);
}

const termsNote = (conflict) => `Online signing needs the proposal terms to match the agreement: ${conflict.detail}.`;

// Online signing needs the building use (owner 2026-11-01, audit fix 5). The builder requires the pick before it saves, but a
// proposal last saved before 2026-10-28 has none, and a win with no pick leaves the customer's building use unset, so its
// visit bills would take the account's commercial tax. It reuses the terms_conflict reason, so the customer card, the builder
// line and the generic 404 already behave (no new customer text). Mark won is NOT gated: the first visit books before the win.
const BUILDING_USE_NOTE = 'Online signing needs the building use: pick it in the builder and save.';

function signEligibility(estimate) {
  const found = signableProposal(estimate);
  if (!found) return { ok: false, reason: 'not_signable' };
  if (!found.proposal.buildingUse) {
    return { ok: false, reason: 'terms_conflict', field: 'buildingUse', note: BUILDING_USE_NOTE, ...found };
  }
  const conflict = agreementTermsConflict(found.proposal, { billByInvoice: estimate.bill_by_invoice === true });
  if (conflict) return { ok: false, reason: 'terms_conflict', field: conflict.field, note: termsNote(conflict), ...found };
  return { ok: true, ...found };
}

// Stable JSON: object keys sorted, builder-only keys dropped (row ids the editor mints, `generated*` provenance
// of narrative lines, a program's `visitMinutes`: scheduling only, it sizes the first visit and is not part of the
// quote; the proposal's `buildingUse`: the operator's tax classification, whose effect on the quote is each row's
// Taxable flag, hashed with the row), so re-saving the same quote never changes it and any customer-visible change does.
const BUILDER_ONLY_KEYS = new Set(['id', 'visitMinutes', 'buildingUse']);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort()
      .filter((key) => !BUILDER_ONLY_KEYS.has(key) && !key.startsWith('generated'))
      .reduce((acc, key) => ({ ...acc, [key]: canonical(value[key]) }), {});
  }
  return value;
}

// sha256 over the normalized proposal (lines, programs, corrective work, scope, terms, tax rate), its totals, the
// merge values the contract renders, the customer and the template version. agreement.payment_terms is left out: it is
// derived from the proposal's payment term (hashed with the proposal), and leaving it out keeps the fingerprint of an
// agreement issued before the payment paragraph existed, so its signing link stays valid.
function quoteFingerprint({ proposal, totals, values, customerId, templateVersionId }) {
  const { estimate: _estimate, agreement: { payment_terms: _paymentTerms, ...agreement } = {}, ...others } = values;
  const rendered = { ...others, agreement };
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
    if (!eligibility.ok) return { canSign: false, state, reason: eligibility.reason, field: eligibility.field };
    return { canSign: Boolean(estimate.customer_id), state };
  } catch (err) {
    logger.warn(`[commercial-agreement] cta skipped for estimate ${estimate?.id}: ${err.code || 'error'}`);
    return null;
  }
}

// Whether the quote as it stands is the quote the customer signed: the newest signed agreement for this estimate, for
// this customer, whose frozen fingerprint equals the fingerprint of the proposal now (the sign-time comparison in
// refuseStaleSignature, against the template version the contract was rendered from). A proposal edited after
// signing (price, cadence, lines, terms) no longer matches. false when nothing is signed.
async function signedQuoteMatches(estimate, conn = db) {
  if (!estimate?.id || !estimate.customer_id) return false;
  const contract = await estimateAgreementQuery(estimate.id, conn)
    .whereIn('status', ['signed'])
    .orderByRaw('signed_at DESC NULLS LAST, created_at DESC')
    .first('id', 'customer_id', 'document_variables_snapshot', 'document_template_version_id');
  if (!contract || String(contract.customer_id) !== String(estimate.customer_id)) return false;
  const signable = signableProposal(estimate);
  const stored = parseJson(contract.document_variables_snapshot)?.estimate?.fingerprint;
  return Boolean(signable && stored) && stored === currentFingerprint(estimate, signable, contract.document_template_version_id);
}

// The admin builder's read: the agreement state, plus why online signing is not offered (signingBlocked + a
// ready-to-show note), so the builder's Readiness card can say what to change (owner 2026-11-01, proposal readiness):
// terms that conflict with the agreement (with the field), no recurring service (agreementCtaFor serves no card), or no
// linked customer account (the customer page asks the customer to call); `closed` (the route's estimateClosedOnline
// verdict: won, declined, expired, archived) comes first, since the customer page then offers no signing at all. A
// signed agreement shows no block.
const CLOSED_NOTE = 'Online signing is closed: the proposal is won, declined, expired or archived.';
const NOT_SIGNABLE_NOTE = 'Online signing needs a recurring service. One-time work is signed with the office.';
const NO_ACCOUNT_NOTE = 'Online signing needs a linked customer account. Until then the page asks the customer to call.';
async function agreementAdminStatus(estimate, conn = db, { closed = false } = {}) {
  const state = await agreementStateForEstimate(estimate.id, conn);
  if (state.state === 'signed') return state;
  if (closed) return { ...state, signingBlocked: 'closed', note: CLOSED_NOTE };
  const eligibility = signEligibility(estimate);
  if (eligibility.reason === 'terms_conflict') {
    return { ...state, signingBlocked: 'terms_conflict', field: eligibility.field, note: eligibility.note };
  }
  if (eligibility.reason === 'not_signable') return { ...state, signingBlocked: 'not_signable', note: NOT_SIGNABLE_NOTE };
  if (!estimate.customer_id) return { ...state, signingBlocked: 'no_account', note: NO_ACCOUNT_NOTE };
  return state;
}

function refusal(status, code, error) {
  return { ok: false, status, code, error };
}

// The customer_contracts row for a newly issued agreement: a pure mapping from the rendered template and the locked
// customer (the same columns the document-template issuer writes).
function newContractRow({ customer, template, version, rendered, context, tokenHash, expiresAt, now }) {
  const { ESIGN_DISCLOSURE, signerName } = require('./contracts');
  const { jsonb } = require('./document-template-library');
  return {
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
    share_token_hash: tokenHash,
    share_token_expires_at: expiresAt,
    shared_at: now,
    document_template_id: template.id,
    document_template_version_id: version.id,
    document_template_key: template.template_key,
    requires_signature_snapshot: template.requires_signature !== false,
    document_variables_snapshot: jsonb(context, {}),
    document_render_summary: jsonb(rendered.renderSummary, {}),
  };
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
  const { documentContractExpiresAt, hashContractToken, mintContractToken, publicContractUrl } = require('./contracts');
  const { lockCustomerComms } = require('../utils/customer-comms-lock');

  const template = await database('document_templates').where({ template_key: TEMPLATE_KEY, status: 'active' }).first();
  const version = template?.active_version_id
    ? await database('document_template_versions').where({ id: template.active_version_id }).first()
    : null;
  if (!template || !version) return refusal(409, 'template_unavailable', 'Online signing is not available right now. Please call us.');

  const token = mintContractToken();
  const actor = { actor_type: 'customer', actor_id: null, ip: req.ip || null, user_agent: req.get ? (req.get('user-agent') || null) : null };
  // Every contract event this issuer writes has the same shape.
  const addEvent = (trx, contractId, customerId, eventType, metadata) => trx('customer_contract_events').insert({
    contract_id: contractId, customer_id: customerId, event_type: eventType, ...actor, metadata: jsonb(metadata, {}),
  });

  const outcome = await database.transaction(async (trx) => {
    // CUSTOMER FIRST, like every customer contact write (applyOperatorCustomerEmail locks the customer, then its
    // fanout updates open estimates): comms fence → customers → estimates → leads → call_log (blockedFor) → template →
    // contracts. The customer comes from the unlocked read the route made; the locked estimate must still belong to
    // that customer, or the pair is stale and nothing proceeds (never lock-and-write on a mismatched pair).
    await lockCustomerComms(trx, estimate.customer_id);
    const customer = await trx('customers').where({ id: estimate.customer_id }).whereNull('deleted_at').forUpdate().first();
    if (!customer || customer.active === false) {
      return refusal(409, 'customer_unavailable', 'Online signing is not available right now. Please call us.');
    }
    const locked = await trx('estimates').where({ id: estimate.id }).forUpdate().first();
    if (!locked || String(locked.customer_id) !== String(customer.id)) return refusal(404, 'not_signable', 'Estimate not found');
    if (await blockedFor(trx, locked)) return refusal(404, 'not_signable', 'Estimate not found');
    const lockedFound = signEligibility(locked);
    if (!lockedFound.ok) return refusal(404, 'not_signable', 'Estimate not found');
    await lockActiveVersionForIssue(trx, { template, activeVersion: version });

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
    // The gate is read again here, after the LAST lock (the contract row) and before any write: a request that
    // waited on those locks while the kill switch was thrown must not create, re-open or re-link an agreement
    // (live gate re-read at the commit boundary).
    if (!require('../config/feature-gates').commercialProposalSignLive()) return refusal(404, 'not_signable', 'Estimate not found');
    // The payment term is judged again here for the same reason: GATE_COMMERCIAL_AUTOPAY (and Bill by invoice on the
    // locked row) may have changed while this request waited. lockedFound is eligible, so it carries a payment term.
    if (paymentTermsConflict(lockedFound.proposal.commercialTerms.paymentTerms, { billByInvoice: locked.bill_by_invoice === true })) {
      return refusal(404, 'not_signable', 'Estimate not found');
    }
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
        await addEvent(trx, existing.id, customer.id, 'share_link_created', { source: SNAPSHOT_SOURCE, estimateId: locked.id, expiresAt: expiresAt.toISOString() });
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
      if (cancelled) await addEvent(trx, existing.id, existing.customer_id, 'cancelled', { reason: 'superseded', estimateId: locked.id });
    }

    const context = buildCustomerDocumentContext(customer, values);
    context.customer = { ...context.customer, name: values.customer.name || context.customer.name, address: values.customer.address || context.customer.address };
    const rendered = renderDocumentTemplate({ template, version, context });
    // The signed text must also carry the payment paragraph its term promises: version 1 fixes Net 30, so an Auto Pay
    // agreement cannot print from it (version 2 fills the paragraph from agreement.payment_terms).
    if (rendered.unresolvedVariables.length || !rendered.body.includes(values.agreement.payment_terms)) {
      logger.warn(`[commercial-agreement] agreement for estimate ${locked.id} lacks its payment paragraph or has unresolved variables [${rendered.unresolvedVariables.join(', ')}]`);
      return refusal(409, 'template_unavailable', 'Online signing is not available right now. Please call us.');
    }
    const [row] = await trx('customer_contracts')
      .insert(newContractRow({ customer, template, version, rendered, context, tokenHash: hashContractToken(token), expiresAt, now }))
      .returning('*');
    await addEvent(trx, row.id, customer.id, 'created_from_document_template', { source: SNAPSHOT_SOURCE, estimateId: locked.id, templateKey: template.template_key, templateVersionId: version.id });
    await addEvent(trx, row.id, customer.id, 'share_link_created', { source: SNAPSHOT_SOURCE, estimateId: locked.id, expiresAt: expiresAt.toISOString() });
    return { ok: true, status: 201, created: true, contractId: row.id };
  });

  if (!outcome.ok) return outcome;
  return { ...outcome, signingUrl: publicContractUrl(token) };
}

const STALE_PROPOSAL_MESSAGE = 'This proposal was updated. Please open the latest proposal to sign.';

// Sign boundary, step 1 (contracts-public POST /:token/sign, AFTER it has locked the contract's customer row and
// BEFORE it locks the contract row): for a contract this feature issued, lock the estimate row and run the issuer's own
// locked re-check. Lock order is the issuer's, customer first (customers → estimates → leads → call_log → contracts),
// so the two paths cannot deadlock with each other or with a customer contact update. An estimate that no longer
// belongs to the locked customer is never checked further: customerMoved, and the signature is refused. null = not ours.
async function lockEstimateForSign(trx, contractPeek) {
  if (contractPeek?.document_template_key !== TEMPLATE_KEY) return null;
  const snapEstimate = parseJson(contractPeek.document_variables_snapshot)?.estimate;
  if (snapEstimate?.source !== SNAPSHOT_SOURCE || !snapEstimate.id) return null;
  const estimate = await trx('estimates').where({ id: snapEstimate.id }).forUpdate().first();
  if (estimate && String(estimate.customer_id) !== String(contractPeek.customer_id)) return { estimate, blocked: true, customerMoved: true };
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
  else if (estimateLock.customerMoved) reason = 'customer_changed';
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

// The alert's payment sentence (with a trailing space), or '' for an agreement issued before the payment paragraph.
// `snapshotEstimate` is the signed contract's frozen estimate block. Auto Pay reads the customer's live Auto Pay state;
// an unreadable state says "not confirmed", never "on".
async function paymentSentence(snapshotEstimate, customerId, database) {
  const paymentTerms = snapshotEstimate.proposal?.commercialTerms?.paymentTerms;
  if (paymentTerms === INVOICE_PAYMENT_TERMS) return 'Payment: Net 30 by invoice. ';
  if (paymentTerms === NET60_PAYMENT_TERMS) return 'Payment: Net 60 by invoice. ';
  if (paymentTerms !== AUTOPAY_PAYMENT_TERMS) return '';
  let on = false;
  let chargesEachService = false;
  try {
    const customer = customerId ? await database('customers').where({ id: customerId }).first() : null;
    on = await require('./autopay-eligibility').customerOnAutopay(customer, { db: database, failClosed: true });
    chargesEachService = on && chargesEachCompletedService(customer);
  } catch (err) {
    logger.warn(`[commercial-agreement] Auto Pay state unreadable for customer ${customerId}: ${err.code || 'error'}`);
  }
  if (on && chargesEachService) return 'Payment: Auto Pay, and a card or bank account is saved. ';
  if (on) {
    return 'Payment: Auto Pay, and a card or bank account is saved, but this account\'s billing type does not charge each completed service: check it on the customer page before the first visit. ';
  }
  return 'Payment: Auto Pay, but no card or bank account is saved yet. The signing page offered the Auto Pay setup step; if none is saved before the first visit, send an Auto Pay setup link from the customer page. ';
}

// The Auto Pay setup link's own rule for "each completed service is charged to the saved method" (the per-visit lane
// while GATE_COMPLETION_AUTOPAY_CHARGE is on, or per application): an Auto Pay agreement is only "on" where it is true.
function chargesEachCompletedService(customer) {
  return Boolean(customer) && require('./autopay-setup-link').billingLaneSupported(customer);
}

// The variables snapshot of a SIGNED agreement this module issued (its estimate marker), else null: every other
// template, a commercial agreement staff issued by hand, and a contract not yet signed.
function issuedSignedSnapshot(contract) {
  if (!contract || contract.document_template_key !== TEMPLATE_KEY || contract.status !== 'signed') return null;
  const snapshot = parseJson(contract.document_variables_snapshot);
  return snapshot?.estimate?.source === SNAPSHOT_SOURCE && snapshot.estimate.id ? snapshot : null;
}

// After a customer signs (contracts-public, after commit): tell the office the
// agreement is in, and leave an activity row on the estimate. Never throws.
// Inert for any contract this module did not issue. The estimate is NOT touched.
async function handleAgreementSigned({ contractId, database = db }) {
  try {
    const contract = await database('customer_contracts').where({ id: contractId }).first();
    const snapshot = issuedSignedSnapshot(contract);
    if (!snapshot) return { skipped: 'not_ours' };
    const est = snapshot.estimate;

    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction, tidyName } = require('./admin-alert-names');
    const name = tidyName(snapshot.customer?.name || contract.recipient_name || 'Customer');
    const number = String(est.number || '').replace(/[^A-Za-z0-9-]/g, '') || 'the proposal';
    const signedOn = contract.signed_at
      ? new Date(contract.signed_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
      : '';
    const payment = await paymentSentence(est, contract.customer_id, database);
    // GATE_COMMERCIAL_FIRST_VISIT: when the signer can book the first visit online, the office waits for that booking
    // (its own alert) instead of booking by phone beside it.
    const bookOnline = await require('./commercial-first-visit').firstVisitOnlineFor(est.id, database);

    await raiseAdminAlert('customer', {
      area: 'Estimates',
      action: fitAction('Estimates', name, bookOnline ? [
        (who) => `watch for ${who}'s first visit booking`,
        (who) => `watch for ${who}'s booking`,
      ] : [
        (who) => `mark ${who} won and book the first visit`,
        (who) => `mark ${who} won`,
      ]),
      why: bookOnline
        ? `Signed the commercial agreement for ${number}; they can book the first visit online now.`
        : `Signed the commercial agreement for ${number}; the estimate is still open and nothing is booked.`,
      severity: 'needs-you',
      link: `/admin/estimates/${est.id}/proposal`,
      subject: { type: 'estimate', id: String(est.id) },
      doneWhen: bookOnline ? 'visit_booked' : 'estimate_marked_won',
      who: 'person',
    }, {
      // A customer signing is a customer acting: the bell policy never silences it.
      bell: true,
      dedupeKey: `commercial-agreement-signed:${contract.id}`,
      detail: `${name} signed the Commercial Pest Service Agreement for ${number}${signedOn ? ` on ${signedOn}` : ''}. The estimate was not accepted, and no visit, invoice or charge was created. ${payment}${bookOnline
        ? 'They can now pick their first visit online, and you get a second alert when they book. If they do not book, mark the estimate won, then schedule the first visit.'
        : 'Mark the estimate won, then schedule the first visit.'} The signed copy goes to the customer by email.`,
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

// After a customer signs an Auto Pay agreement (contracts-public, after commit and BEFORE the signed hook, so its alert
// reads the result): the signing page's next step. It reuses the standalone Auto Pay setup link
// (services/autopay-setup-link.js, the one card-or-bank save that enrolls Auto Pay, GATE_AUTOPAY_SETUP_LINK) minted
// INLINE: nothing is sent, the page shows the button. A customer already on Auto Pay, or whose consented saved card the
// link service enrolls, needs no link. Nothing is charged. Never throws. null = no next step (not an agreement issued
// here, not Auto Pay, the gate is off, or the link service declined: the office alert then says no method is saved).
async function autopayNextStep({ contractId, database = db }) {
  try {
    if (!commercialAutopayLive()) return null;
    const contract = await database('customer_contracts').where({ id: contractId })
      .first('id', 'customer_id', 'status', 'document_template_key', 'document_variables_snapshot');
    const snapshot = issuedSignedSnapshot(contract);
    if (snapshot?.estimate.proposal?.commercialTerms?.paymentTerms !== AUTOPAY_PAYMENT_TERMS) return null;
    const { requestAutopaySetupLink } = require('./autopay-setup-link');
    const result = await requestAutopaySetupLink({ customerId: contract.customer_id, delivery: 'inline', trigger: SNAPSHOT_SOURCE });
    if (result?.action === 'link_created' && result.secureUrl) return { state: 'setup', url: result.secureUrl };
    // The link service enrolls a saved card only on a lane that charges each completed service, but it reports an
    // account already on Auto Pay BEFORE that lane check: judged here, or the page would promise a charge after each
    // completed service that never runs (a membership lane, or per visit with the completion charge off).
    if (result?.action === 'auto_secured') return { state: 'on' };
    if (result?.reason === 'autopay_already_active') {
      const customer = await database('customers').where({ id: contract.customer_id }).first();
      if (chargesEachCompletedService(customer)) return { state: 'on' };
    }
    logger.info(`[commercial-agreement] no Auto Pay next step for contract ${contract.id}: ${result?.reason || 'unknown'}`);
    return null;
  } catch (err) {
    logger.warn(`[commercial-agreement] Auto Pay next step failed for contract ${contractId}: ${err.code || 'error'}`);
    return null;
  }
}

module.exports = {
  TEMPLATE_KEY,
  SNAPSHOT_SOURCE,
  START_DATE_TEXT,
  buildAgreementValues,
  signableProposal,
  signEligibility,
  AGREEMENT_TERMS,
  AGREEMENT_PAYMENT_TEXT,
  agreementTermsConflict,
  fixedTermsConflict,
  STALE_PROPOSAL_MESSAGE,
  agreementAdminStatus,
  lockEstimateForSign,
  refuseStaleSignature,
  agreementStateForEstimate,
  signedQuoteMatches,
  agreementCtaFor,
  newContractRow,
  ensureAgreement,
  handleAgreementSigned,
  autopayNextStep,
  quoteFingerprint,
};
