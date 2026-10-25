// ============================================================
// estimate-consumer-notice.js — the Florida consumer notice on the estimate page
// (GATE_ESTIMATE_CONSUMER_NOTICE, owner decision 2026-10-25).
//
// Rule 5E-14.105(1), F.A.C. (eff. 4-29-2025): before a treatment for a wood-
// destroying organism the licensee must obtain the property owner's signed
// Consumer Notice Form, FDACS-13692 Rev. 07/21. An estimate with a termite line
// therefore cannot be accepted until the customer has the notice on file.
//
// The notice is the existing document template consumer_notice.fdacs_13692,
// signed on the existing /contract/:token page. This module only decides whether
// an estimate needs it, reports the customer's state, and ISSUES the contract from
// the estimate page. It never touches the estimate, sends nothing to the customer
// and creates no visit, invoice or charge. The notice belongs to the customer, not
// the estimate: one on file covers every later termite estimate.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
const { CONSUMER_NOTICE_TEMPLATE_KEY, findConsumerNotice } = require('./consumer-notices');
const { newContractRow } = require('./commercial-proposal-agreement');
const { etDateString } = require('../utils/datetime-et');

// Marks a contract issued from the estimate page: the signing page reads it to offer
// "Back to your estimate". A notice staff issued by hand never carries it.
const SNAPSHOT_SOURCE = 'estimate_consumer_notice';
const OPEN_STATUSES = ['draft', 'sent', 'viewed'];
const TERMITE_FAMILY_KEYS = new Set([
  'termite_bait', 'termite_trenching', 'pre_slab_termiticide', 'termite_foam', 'foam_recurring', 'bora_care',
]);
const SERVICE_NAME = 'Florida consumer notice (FDACS-13692)';
const CALL_US = 'We couldn’t prepare the notice online. Please call us and we will finish it with you.';
const REQUIRED_MESSAGE = 'Please sign the Florida consumer notice above before you accept.';

const estimateRoute = () => require('../routes/estimate-public');
const refusal = (status, code, error) => ({ ok: false, status, code, error });

// True when ANY recurring or one-time line is a termite or wood-destroying-organism treatment. Not the
// primary line only: a pest plan with a Bora-Care add-on needs the notice too. Pure.
function estimateNeedsConsumerNotice(estimate, estData = estimateRoute().parseEstimateDataSafe(estimate)) {
  const route = estimateRoute();
  let effective = estData || {};
  try {
    effective = route.withSupplementedRecurringServices(effective);
  } catch { /* raw data stands, as in estimateFamilyKeysForAdoption */ }
  const { recurringSvcList, oneTimeList } = route.acceptanceServiceLists(effective);
  return recurringSvcList.some((svc) => TERMITE_FAMILY_KEYS.has(route.serviceFamilyKeyForAdoption(svc)))
    || oneTimeList.some((item) => route.oneTimeItemFamilyKeys(item).some((key) => TERMITE_FAMILY_KEYS.has(key)));
}

// signed: a notice dated on or before today (e-signed or an office-filed scan). awaiting: an open
// Document Request exists. none: neither.
async function consumerNoticeState(customerId, conn = db) {
  if (await findConsumerNotice(conn, customerId, { onOrBefore: etDateString() })) return 'signed';
  const open = await conn('customer_contracts')
    .where({ customer_id: customerId, contract_type: 'document_template', document_template_key: CONSUMER_NOTICE_TEMPLATE_KEY })
    .whereIn('status', OPEN_STATUSES)
    .first('id');
  return open ? 'awaiting' : 'none';
}

// /data's cta.consumerNotice: null (nothing new on the payload) unless the estimate needs the notice.
// No token, id or contract detail. A customer-less estimate cannot hold a notice: the page says to call.
async function consumerNoticeCtaFor(estimate, conn = db) {
  try {
    if (!estimateNeedsConsumerNotice(estimate)) return null;
    if (!estimate.customer_id) return { state: 'none', canSign: false, reason: 'no_account' };
    const state = await consumerNoticeState(estimate.customer_id, conn);
    return { state, canSign: state !== 'signed' };
  } catch (err) {
    logger.warn(`[estimate-consumer-notice] cta skipped for estimate ${estimate?.id}: ${err.code || 'error'}`);
    return null;
  }
}

// PUT /:token/accept: true = refuse the accept. Throws on a read error, so the accept fails closed.
async function consumerNoticeBlocksAccept(estimate, conn = db) {
  if (!estimateNeedsConsumerNotice(estimate)) return false;
  if (!estimate.customer_id) return true;
  return (await consumerNoticeState(estimate.customer_id, conn)) !== 'signed';
}

// The name printed as the Waves representative: the estimate's creator while still active, else the one
// active admin. Null when neither resolves (the page then says to call).
async function representativeName(trx, estimate) {
  const active = { active: true, employment_status: 'active' };
  if (estimate.created_by_technician_id) {
    const creator = await trx('technicians').where({ id: estimate.created_by_technician_id, ...active }).first('name');
    if (creator?.name) return creator.name;
  }
  const admins = await trx('technicians').where({ role: 'admin', ...active }).limit(2).select('name');
  return admins.length === 1 && admins[0].name ? admins[0].name : null;
}

function todayUs() {
  const [year, month, day] = etDateString().split('-');
  return `${month}/${day}/${year}`;
}

// Issue the notice for this estimate's customer, or return the open one with a fresh signing link (only a hash
// of the link is stored, so every call rotates it). An open notice is reused only when it reads exactly as the
// one issued now (same form version, name, representative and date); otherwise it is cancelled and replaced.
// `blockedFor(trx, lockedEstimate)` is the route's eligibility re-run on the estimate row locked here (the same
// check the commercial agreement issuer runs): true = the estimate is no longer open for online signing.
async function ensureEstimateConsumerNotice({ estimate, req = {}, conn = db, blockedFor = async () => false }) {
  if (!estimate.customer_id) return refusal(409, 'no_account', CALL_US);
  const { renderDocumentTemplate, buildCustomerDocumentContext, lockActiveVersionForIssue, jsonb } = require('./document-template-library');
  const { documentContractExpiresAt, hashContractToken, mintContractToken, publicContractUrl } = require('./contracts');
  const { lockCustomerComms } = require('../utils/customer-comms-lock');

  const template = await conn('document_templates').where({ template_key: CONSUMER_NOTICE_TEMPLATE_KEY, status: 'active' }).first();
  const version = template?.active_version_id
    ? await conn('document_template_versions').where({ id: template.active_version_id }).first()
    : null;
  if (!template || !version) return refusal(409, 'template_unavailable', CALL_US);

  const token = mintContractToken();
  const actor = { actor_type: 'customer', actor_id: null, ip: req.ip || null, user_agent: req.get ? (req.get('user-agent') || null) : null };
  const addEvent = (trx, row, eventType, metadata, actorType = 'customer') => trx('customer_contract_events').insert({
    contract_id: row.id, customer_id: row.customer_id, event_type: eventType, ...actor, actor_type: actorType, metadata: jsonb(metadata, {}),
  });

  const outcome = await conn.transaction(async (trx) => {
    // Customer first, like every customer contact write: comms fence, customers, estimates (then leads and call_log in
    // blockedFor), template, contracts.
    await lockCustomerComms(trx, estimate.customer_id);
    const customer = await trx('customers').where({ id: estimate.customer_id }).whereNull('deleted_at').forUpdate().first();
    if (!customer || customer.active === false) return refusal(409, 'customer_unavailable', CALL_US);
    // The estimate under lock decides, not the route's earlier read: a decline, archive, reassignment, call-linkage
    // correction or revision that removed the termite line, landing in between, wins and nothing is issued.
    const locked = await trx('estimates').where({ id: estimate.id }).forUpdate().first();
    if (!locked || String(locked.customer_id) !== String(customer.id)) return refusal(404, 'not_available', 'Estimate not found');
    if (await blockedFor(trx, locked) || !estimateNeedsConsumerNotice(locked)) return refusal(404, 'not_available', 'Estimate not found');
    if (await findConsumerNotice(trx, customer.id, { onOrBefore: etDateString() })) {
      return refusal(409, 'already_signed', 'Your consumer notice is already signed. Please reload the page.');
    }
    const representative = await representativeName(trx, locked);
    if (!representative) return refusal(409, 'no_representative', CALL_US);
    await lockActiveVersionForIssue(trx, { template, activeVersion: version });

    const context = buildCustomerDocumentContext(customer, {
      service: { name: SERVICE_NAME },
      issuer: { name: representative, date: todayUs() },
      estimate: { id: locked.id, source: SNAPSHOT_SOURCE },
    });
    const rendered = renderDocumentTemplate({ template, version, context });
    if (rendered.unresolvedVariables.length) {
      logger.warn(`[estimate-consumer-notice] unresolved variables for estimate ${locked.id}: ${rendered.unresolvedVariables.join(', ')}`);
      return refusal(409, 'template_unavailable', CALL_US);
    }
    const now = new Date();
    const expiresAt = documentContractExpiresAt(now, template.expire_after_days, template);
    const existing = await trx('customer_contracts')
      .where({ customer_id: customer.id, contract_type: 'document_template', document_template_key: CONSUMER_NOTICE_TEMPLATE_KEY })
      .whereIn('status', OPEN_STATUSES)
      .whereRaw("document_variables_snapshot -> 'estimate' ->> 'source' = ?", [SNAPSHOT_SOURCE])
      .orderByRaw('created_at DESC')
      .forUpdate()
      .first();
    // The gate is read again after the last lock and before any write: a request that waited on the locks while
    // the kill switch was thrown must create nothing.
    if (!require('../config/feature-gates').estimateConsumerNoticeLive()) return refusal(404, 'not_available', 'Estimate not found');
    const meta = { source: SNAPSHOT_SOURCE, estimateId: locked.id };
    if (existing?.contract_text_snapshot === rendered.body) {
      await trx('customer_contracts').where({ id: existing.id }).update({
        status: 'sent', share_token_hash: hashContractToken(token), share_token_expires_at: expiresAt, shared_at: now, updated_at: now,
      });
      await addEvent(trx, existing, 'share_link_created', { ...meta, expiresAt: expiresAt.toISOString() });
      return { ok: true, status: 200 };
    }
    if (existing) {
      await trx('customer_contracts').where({ id: existing.id }).whereIn('status', OPEN_STATUSES).update({
        status: 'cancelled', cancelled_at: now, cancelled_reason: 'Superseded: the notice was issued again with new details',
        share_token_hash: null, share_token_expires_at: null, updated_at: now,
      });
      await addEvent(trx, existing, 'cancelled', { ...meta, reason: 'superseded' }, 'system');
    }
    const [row] = await trx('customer_contracts')
      .insert(newContractRow({ customer, template, version, rendered, context, tokenHash: hashContractToken(token), expiresAt, now }))
      .returning('*');
    await addEvent(trx, row, 'created_from_document_template', { ...meta, templateKey: template.template_key, templateVersionId: version.id });
    await addEvent(trx, row, 'share_link_created', { ...meta, expiresAt: expiresAt.toISOString() });
    return { ok: true, status: 201 };
  });

  return outcome.ok ? { ...outcome, signingUrl: publicContractUrl(token) } : outcome;
}

module.exports = {
  SNAPSHOT_SOURCE,
  REQUIRED_MESSAGE,
  estimateNeedsConsumerNotice,
  consumerNoticeState,
  consumerNoticeCtaFor,
  consumerNoticeBlocksAccept,
  ensureEstimateConsumerNotice,
};
