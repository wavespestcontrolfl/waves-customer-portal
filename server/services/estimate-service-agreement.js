// ============================================================
// estimate-service-agreement.js — the residential service agreement on the
// accepted estimate page (GATE_ESTIMATE_SERVICE_AGREEMENT).
//
// A signed service agreement for every residential recurring plan. Once a
// residential estimate with a recurring line is accepted, the accepted page
// offers one agreement per lane the plan covers:
//   pest  → service_agreement.residential_pest  (pest, mosquito, rodent)
//   lawn  → service_agreement.lawn_ornamental   (lawn, tree & shrub, palms)
// Both are existing document templates, signed on the existing /contract/:token
// page. This module only decides which lanes an estimate has, reports their
// state and ISSUES the contract from the accepted page. It never touches the
// estimate, the booked visit, an invoice or a charge, and sends nothing to the
// customer. Commercial estimates have their own agreement
// (commercial-proposal-agreement.js); termite programs have theirs
// (termite-program-agreement.js); neither is issued here.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
const { newContractRow } = require('./commercial-proposal-agreement');
const { formatDisplayDate } = require('../utils/date-only');

// Marks a contract issued from the accepted estimate page: the signing page reads it to offer
// "Back to your estimate", and only a contract carrying it is reused or reported here. An
// agreement staff issued by hand never carries it.
const SNAPSHOT_SOURCE = 'estimate_service_agreement';
const OPEN_STATUSES = ['draft', 'sent', 'viewed'];
const SERVICE_NAME_MAX = 180; // customer_contracts.service_name is varchar(180)
const START_DATE_TEXT = 'Your first scheduled visit';
const CALL_US = 'We couldn’t prepare your agreement online. Please call us and we will finish it with you.';

// Lane → template key, and the recurring-line family keys (recurringServiceKey in estimate-public.js)
// each lane covers. A key in neither map (termite programs, commercial lines, one-off specialty rows)
// gets no agreement from here. pest is listed first: it is the plan's primary line when both are present.
const LANES = Object.freeze({
  pest: Object.freeze({
    templateKey: 'service_agreement.residential_pest',
    title: 'Residential Pest Service Agreement',
    keys: new Set(['pest_control', 'mosquito', 'rodent', 'rodent_bait']),
  }),
  lawn: Object.freeze({
    templateKey: 'service_agreement.lawn_ornamental',
    title: 'Lawn & Ornamental Service Agreement',
    keys: new Set(['lawn_care', 'tree_shrub', 'palm_injection']),
  }),
});
const LANE_ORDER = Object.freeze(['pest', 'lawn']);
const TEMPLATE_KEYS = Object.freeze(LANE_ORDER.map((lane) => LANES[lane].templateKey));

const FREQUENCY_LABELS = Object.freeze({
  weekly: 'weekly', biweekly: 'every two weeks', bi_weekly: 'every two weeks', monthly: 'monthly',
  bi_monthly: 'every other month', bimonthly: 'every other month', every_other_month: 'every other month',
  quarterly: 'quarterly', semi_annual: 'twice a year', semiannual: 'twice a year', annual: 'once a year',
});

const estimateRoute = () => require('../routes/estimate-public');
const refusal = (status, code, error) => ({ ok: false, status, code, error });

function laneForTemplateKey(templateKey) {
  return LANE_ORDER.find((lane) => LANES[lane].templateKey === templateKey) || null;
}

// The recurring rows of an estimate, read the same way acceptance reads them (the replayed engine rows
// for an inputs-only estimate included). A failed supplement reads the raw data, as the consumer notice does.
function recurringRows(estimate, estData) {
  const route = estimateRoute();
  let effective = estData || {};
  try {
    effective = route.withSupplementedRecurringServices(effective);
  } catch { /* raw data stands */ }
  return route.acceptanceServiceLists(effective).recurringSvcList;
}

// A commercial estimate never gets a residential agreement: an authored proposal, an auto-priced
// commercial estimate, or any commercial_* recurring line.
function isCommercialEstimate(estimate, estData, rows) {
  if (estData?.proposal?.enabled === true) return true;
  if (require('./estimate-commercial-identity').isCommercialAutoAcceptEstimate(estimate)) return true;
  const route = estimateRoute();
  return rows.some((svc) => String(route.recurringServiceKey(svc) || '').startsWith('commercial_'));
}

// The lanes an estimate's recurring plan covers, in LANE_ORDER. Empty for a one-time-only, termite-only or
// commercial estimate, and for one ACCEPTED as one-time service: a mixed estimate keeps its quoted recurring rows
// after a one-time accept, so the persisted accepted_service_mode decides (an accept that predates the column
// counts as the plan, as termite-program-agreement.js and combined-booking-check.js read it). No writes.
function estimateServiceAgreementLanes(estimate, estData = estimateRoute().parseEstimateDataSafe(estimate)) {
  if (String(estimate?.accepted_service_mode || '').trim().toLowerCase() === 'one_time') return [];
  const rows = recurringRows(estimate, estData);
  if (!rows.length || isCommercialEstimate(estimate, estData, rows)) return [];
  const route = estimateRoute();
  const keys = new Set(rows.map((svc) => route.recurringServiceKey(svc)).filter(Boolean));
  return LANE_ORDER.filter((lane) => [...keys].some((key) => LANES[lane].keys.has(key)));
}

function frequencyLabel(estimate) {
  const key = String(estimate.accepted_frequency_key || '').trim().toLowerCase();
  if (!key) return '';
  return FREQUENCY_LABELS[key] || key.replace(/[_-]+/g, ' ');
}

// "Pest Control + Mosquito, quarterly" — the plan lines this lane's agreement covers, as the estimate names them.
function laneServiceName(estimate, lane, estData = estimateRoute().parseEstimateDataSafe(estimate)) {
  const route = estimateRoute();
  const names = [];
  for (const svc of recurringRows(estimate, estData)) {
    if (!LANES[lane].keys.has(route.recurringServiceKey(svc))) continue;
    const name = String(svc.name || svc.label || svc.displayName || svc.service || '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  const base = names.join(' + ') || LANES[lane].title.replace(/ Agreement$/, '');
  const freq = frequencyLabel(estimate);
  return `${base}${freq ? `, ${freq}` : ''}`.slice(0, SERVICE_NAME_MAX);
}

function contractsForEstimate(estimateId, templateKey, conn) {
  return conn('customer_contracts')
    .where({ contract_type: 'document_template', document_template_key: templateKey })
    .whereRaw("document_variables_snapshot -> 'estimate' ->> 'id' = ?", [String(estimateId)])
    .whereRaw("document_variables_snapshot -> 'estimate' ->> 'source' = ?", [SNAPSHOT_SOURCE]);
}

// none | awaiting | signed for one estimate and lane. Signed wins over awaiting.
async function laneState(estimateId, lane, conn = db) {
  const row = await contractsForEstimate(estimateId, LANES[lane].templateKey, conn)
    .whereNotIn('status', ['cancelled', 'voided', 'expired'])
    .orderByRaw("(status = 'signed') DESC, created_at DESC")
    .first('id', 'status', 'signed_at');
  if (!row) return { state: 'none' };
  if (row.status === 'signed') return { state: 'signed', contractId: row.id, signedAt: row.signed_at };
  return { state: 'awaiting', contractId: row.id };
}

// /data's cta.serviceAgreements: null (nothing new on the payload) unless the accepted estimate has a
// lane. One entry per lane: { lane, title, state, canSign, reason? }. No token, id or contract detail.
// An estimate with no customer account cannot hold an agreement: the page says to call.
async function serviceAgreementCtaFor(estimate, conn = db) {
  try {
    const lanes = estimateServiceAgreementLanes(estimate);
    if (!lanes.length) return null;
    const entries = [];
    for (const lane of lanes) {
      const { state } = estimate.customer_id ? await laneState(estimate.id, lane, conn) : { state: 'none' };
      entries.push({
        lane,
        title: LANES[lane].title,
        state,
        canSign: Boolean(estimate.customer_id) && state !== 'signed',
        ...(estimate.customer_id ? {} : { reason: 'no_account' }),
      });
    }
    return entries;
  } catch (err) {
    logger.warn(`[estimate-service-agreement] cta skipped for estimate ${estimate?.id}: ${err.code || 'error'}`);
    return null;
  }
}

// The first visit booked from this estimate, as the agreement's start date; the standing text when none is.
async function startDateText(trx, estimateId) {
  const row = await trx('scheduled_services')
    .where({ source_estimate_id: estimateId })
    .whereNotIn('status', ['cancelled', 'canceled', 'rescheduled'])
    // A booked visit, not a slot hold (holds carry no customer yet).
    .whereNotNull('customer_id')
    .orderBy('scheduled_date', 'asc')
    .first('scheduled_date');
  const label = row?.scheduled_date ? formatDisplayDate(row.scheduled_date, { fallback: '' }) : '';
  return label || START_DATE_TEXT;
}

// Issue the lane's agreement for this estimate's customer, or return the open one with a fresh signing
// link (only a hash of the link is stored, so every call rotates it). An open agreement is reused only
// when it reads exactly as the one issued now (same template version and text); otherwise it is
// cancelled and replaced. `blockedFor(trx, lockedEstimate)` is the route's eligibility re-run on the
// estimate row locked here: true = the estimate is no longer open for online signing.
async function ensureEstimateServiceAgreement({ estimate, lane, req = {}, conn = db, blockedFor = async () => false }) {
  if (!LANES[lane]) return refusal(404, 'not_available', 'Estimate not found');
  if (!estimate.customer_id) return refusal(409, 'no_account', CALL_US);
  const { renderDocumentTemplate, buildCustomerDocumentContext, lockActiveVersionForIssue, jsonb } = require('./document-template-library');
  const { documentContractExpiresAt, hashContractToken, mintContractToken, publicContractUrl } = require('./contracts');
  const { lockCustomerComms } = require('../utils/customer-comms-lock');
  const { templateKey } = LANES[lane];

  const template = await conn('document_templates').where({ template_key: templateKey, status: 'active' }).first();
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
    // Customer first, like every customer contact write: comms fence, customers, estimates (then leads and
    // call_log in blockedFor), scheduled_services (read), template, contracts.
    await lockCustomerComms(trx, estimate.customer_id);
    const customer = await trx('customers').where({ id: estimate.customer_id }).whereNull('deleted_at').forUpdate().first();
    if (!customer || customer.active === false) return refusal(409, 'customer_unavailable', CALL_US);
    // The estimate under lock decides, not the route's earlier read: an archive, a reassignment or a
    // revision that removed the lane, landing in between, wins and nothing is issued.
    const locked = await trx('estimates').where({ id: estimate.id }).forUpdate().first();
    if (!locked || String(locked.customer_id) !== String(customer.id)) return refusal(404, 'not_available', 'Estimate not found');
    if (await blockedFor(trx, locked) || !estimateServiceAgreementLanes(locked).includes(lane)) return refusal(404, 'not_available', 'Estimate not found');
    const current = await laneState(locked.id, lane, trx);
    if (current.state === 'signed') return refusal(409, 'already_signed', 'Your service agreement is already signed. Please reload the page.');
    await lockActiveVersionForIssue(trx, { template, activeVersion: version });

    // The estimate's service address is the agreement's address when the account row has none yet.
    const addressed = { ...customer, address_line1: customer.address_line1 || locked.address || '' };
    const context = buildCustomerDocumentContext(addressed, {
      service: { name: laneServiceName(locked, lane) },
      agreement: { start_date: await startDateText(trx, locked.id) },
      estimate: { id: locked.id, source: SNAPSHOT_SOURCE, lane },
    });
    const rendered = renderDocumentTemplate({ template, version, context });
    if (rendered.unresolvedVariables.length) {
      logger.warn(`[estimate-service-agreement] unresolved variables for estimate ${locked.id}: ${rendered.unresolvedVariables.join(', ')}`);
      return refusal(409, 'template_unavailable', CALL_US);
    }
    const now = new Date();
    const expiresAt = documentContractExpiresAt(now, template.expire_after_days, template);
    const existing = await contractsForEstimate(locked.id, templateKey, trx)
      .where({ customer_id: customer.id })
      .whereIn('status', OPEN_STATUSES)
      .orderByRaw('created_at DESC')
      .forUpdate()
      .first();
    // The gate is read again after the last lock and before any write: a request that waited on the locks
    // while the kill switch was thrown must create nothing.
    if (!require('../config/feature-gates').estimateServiceAgreementLive()) return refusal(404, 'not_available', 'Estimate not found');
    const meta = { source: SNAPSHOT_SOURCE, estimateId: locked.id, lane };
    if (existing && existing.document_template_version_id === version.id && existing.contract_text_snapshot === rendered.body) {
      await trx('customer_contracts').where({ id: existing.id }).update({
        status: 'sent', share_token_hash: hashContractToken(token), share_token_expires_at: expiresAt, shared_at: now, updated_at: now,
      });
      await addEvent(trx, existing, 'share_link_created', { ...meta, expiresAt: expiresAt.toISOString() });
      return { ok: true, status: 200 };
    }
    if (existing) {
      await trx('customer_contracts').where({ id: existing.id }).whereIn('status', OPEN_STATUSES).update({
        status: 'cancelled', cancelled_at: now, cancelled_reason: 'Superseded: the agreement was issued again with new details',
        share_token_hash: null, share_token_expires_at: null, updated_at: now,
      });
      await addEvent(trx, existing, 'cancelled', { ...meta, reason: 'superseded' }, 'system');
    }
    const [row] = await trx('customer_contracts')
      .insert(newContractRow({ customer: addressed, template, version, rendered, context, tokenHash: hashContractToken(token), expiresAt, now }))
      .returning('*');
    await addEvent(trx, row, 'created_from_document_template', { ...meta, templateKey: template.template_key, templateVersionId: version.id });
    await addEvent(trx, row, 'share_link_created', { ...meta, expiresAt: expiresAt.toISOString() });
    return { ok: true, status: 201 };
  });

  return outcome.ok ? { ...outcome, signingUrl: publicContractUrl(token) } : outcome;
}

module.exports = {
  SNAPSHOT_SOURCE,
  LANES,
  LANE_ORDER,
  TEMPLATE_KEYS,
  START_DATE_TEXT,
  laneForTemplateKey,
  estimateServiceAgreementLanes,
  laneServiceName,
  laneState,
  serviceAgreementCtaFor,
  ensureEstimateServiceAgreement,
};
