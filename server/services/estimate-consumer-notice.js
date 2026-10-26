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
// Marks a notice issued after the office's Mark accepted (GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND). It is sent by
// email and text, so the signing page offers no way back to an estimate.
const MANUAL_ACCEPT_SOURCE = 'manual_accept_consumer_notice';
const OPEN_STATUSES = ['draft', 'sent', 'viewed'];
// Every termite treatment family the estimate classifiers return (recurringServiceKey, classifyServiceFamilyText and the
// seeder's serviceKeyFor), commercial bait monitoring included. Rodent bait and inspections are not termite treatments.
const TERMITE_FAMILY_KEYS = new Set([
  'termite_bait', 'commercial_termite_bait', 'termite_trenching', 'pre_slab_termiticide', 'termite_foam', 'foam_recurring', 'bora_care',
]);
const SERVICE_NAME = 'Florida consumer notice (FDACS-13692)';
const CALL_US = 'We couldn’t prepare the notice online. Please call us and we will finish it with you.';
const REQUIRED_MESSAGE = 'Please sign the Florida consumer notice above before you accept.';

const estimateRoute = () => require('../routes/estimate-public');
const refusal = (status, code, error) => ({ ok: false, status, code, error });

// An engineInputs-only estimate (no stored result) holds its lines only as engine inputs; the page replays the engine
// to show them (buildPricingBundle). withSupplementedRecurringServices keeps just the replay's recurring rows (and the
// misting install), so its one-time lines are read here from the same replay: a pest plan with one-time trenching
// needs the notice too. A failed replay reads nothing, as the supplement does.
function replayedOneTimeItems(estData, route) {
  if (!estData || typeof estData !== 'object' || estData.result || estData.engineResult) return [];
  const engineInputs = route.extractEngineInputs(estData);
  if (!engineInputs) return [];
  try {
    const { generateEstimate } = require('./pricing-engine');
    const { mapV1ToLegacyShape } = require('./pricing-engine/v1-legacy-mapper');
    const items = mapV1ToLegacyShape(generateEstimate(engineInputs)).oneTime?.items;
    return Array.isArray(items) ? items : [];
  } catch (err) {
    logger.warn(`[estimate-consumer-notice] engine replay failed: ${err.code || 'error'}`);
    return [];
  }
}

// True when ANY recurring or one-time line is a termite or wood-destroying-organism treatment. Not the
// primary line only: a pest plan with a Bora-Care add-on needs the notice too. No writes.
function estimateNeedsConsumerNotice(estimate, estData = estimateRoute().parseEstimateDataSafe(estimate)) {
  const route = estimateRoute();
  let effective = estData || {};
  try {
    effective = route.withSupplementedRecurringServices(effective);
  } catch { /* raw data stands, as in estimateFamilyKeysForAdoption */ }
  const { recurringSvcList, oneTimeList } = route.acceptanceServiceLists(effective);
  const oneTimeItems = [...oneTimeList, ...replayedOneTimeItems(estData, route)];
  return recurringSvcList.some((svc) => TERMITE_FAMILY_KEYS.has(route.serviceFamilyKeyForAdoption(svc)))
    || oneTimeItems.some((item) => route.oneTimeItemFamilyKeys(item).some((key) => TERMITE_FAMILY_KEYS.has(key)));
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
// `source`, `actorType` and `gateLive` default to the estimate page; the Mark accepted send passes its own.
async function ensureEstimateConsumerNotice({
  estimate, req = {}, conn = db, blockedFor = async () => false,
  source = SNAPSHOT_SOURCE, actorType = 'customer', gateLive = () => require('../config/feature-gates').estimateConsumerNoticeLive(),
}) {
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
  const actor = { actor_type: actorType, actor_id: null, ip: req.ip || null, user_agent: req.get ? (req.get('user-agent') || null) : null };
  const addEvent = (trx, row, eventType, metadata, eventActor = actorType) => trx('customer_contract_events').insert({
    contract_id: row.id, customer_id: row.customer_id, event_type: eventType, ...actor, actor_type: eventActor, metadata: jsonb(metadata, {}),
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
      estimate: { id: locked.id, source },
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
      .whereRaw("document_variables_snapshot -> 'estimate' ->> 'source' = ?", [source])
      .orderByRaw('created_at DESC')
      .forUpdate()
      .first();
    // The gate is read again after the last lock and before any write: a request that waited on the locks while
    // the kill switch was thrown must create nothing.
    if (!gateLive()) return refusal(404, 'not_available', 'Estimate not found');
    const meta = { source, estimateId: locked.id };
    // Reused only when it is the same form version (its title and signer disclosure too) and reads exactly the same.
    if (existing && existing.document_template_version_id === version.id && existing.contract_text_snapshot === rendered.body) {
      await trx('customer_contracts').where({ id: existing.id }).update({
        status: 'sent', share_token_hash: hashContractToken(token), share_token_expires_at: expiresAt, shared_at: now, updated_at: now,
      });
      await addEvent(trx, existing, 'share_link_created', { ...meta, expiresAt: expiresAt.toISOString() });
      return { ok: true, status: 200, contractId: existing.id };
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
    return { ok: true, status: 201, contractId: row.id };
  });

  return outcome.ok ? { ...outcome, signingUrl: publicContractUrl(token) } : outcome;
}

// Where a send would go, read the way Document Requests delivery reads it (document-contract-delivery.js
// recipientFor/validatePreparedChannel): the newest open notice's recipient, else the customer's; no email when the
// customer turned email off; a text only to the phone on file. '' = that channel does not go out.
async function consumerNoticeRecipients(conn, customerId) {
  const customer = await conn('customers').where({ id: customerId }).first('email', 'phone');
  const open = await conn('customer_contracts')
    .where({ customer_id: customerId, contract_type: 'document_template', document_template_key: CONSUMER_NOTICE_TEMPLATE_KEY })
    .whereIn('status', OPEN_STATUSES)
    .orderBy('created_at', 'desc')
    .first('id', 'recipient_email', 'recipient_phone');
  const prefs = await conn('notification_prefs').where({ customer_id: customerId }).first('email_enabled');
  const email = String(open?.recipient_email || customer?.email || '').trim().toLowerCase();
  const phone = String(open?.recipient_phone || customer?.phone || '').trim();
  const lastTen = (value) => String(value || '').replace(/\D/g, '').slice(-10);
  const phoneOnFile = lastTen(phone).length === 10 && lastTen(phone) === lastTen(customer?.phone);
  return { contractId: open?.id || null, email: prefs?.email_enabled === false ? '' : email, phone: phoneOnFile ? phone : '' };
}

// The pinned form of those recipients (the Intelligence Bar card binds them): ids and hashed addresses only.
async function consumerNoticeTarget(conn, estimateId, customerId) {
  const { recipientKey } = require('./estimate-accept-effects');
  const r = await consumerNoticeRecipients(conn, customerId);
  return {
    estimate_id: String(estimateId), customer_id: String(customerId), contract_id: r.contractId ? String(r.contractId) : null,
    email_key: r.email ? recipientKey(r.email) : null, phone_key: r.phone ? recipientKey(r.phone) : null,
  };
}

// What the Intelligence Bar card says about the notice, read inside the accept: `sends` (a termite line and no
// signed notice) and, when it sends, the recipients. Savepoints, so a failed read never aborts the accept; an
// unreadable state reads as "sends" with no recipients, which the card refuses rather than hide a text.
async function consumerNoticeCardFacts(trx, estimate, customerId) {
  const read = (fn) => (trx.isTransaction ? trx.transaction((sp) => fn(sp)) : fn(trx));
  try {
    const sends = estimateNeedsConsumerNotice(estimate) && (await read((c) => consumerNoticeState(customerId, c))) !== 'signed';
    return { sends, recipients: sends ? await read((c) => consumerNoticeRecipients(c, customerId)) : null };
  } catch {
    return { sends: true, recipients: null };
  }
}

// What the office reads on the bell when the notice did not go out, by refusal or delivery code.
const SEND_FAILURE_WHY = {
  no_representative: 'No active office name to print on the form, so it was not sent.',
  template_unavailable: 'The notice form is not available, so it was not sent.',
  customer_unavailable: 'The customer record could not be used, so the notice was not sent.',
  not_delivered: 'Neither the email nor the text went out.',
  recipient_changed: 'The email or phone changed after the accept card was confirmed, so nothing was sent.',
};

async function alertNoticeNotSent(estimate, reason, conn = db) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const { fitAction, lookupCustomerName } = require('./admin-alert-names');
  const name = (await lookupCustomerName(conn, estimate.customer_id)) || 'the customer';
  await raiseAdminAlert('estimate', {
    area: 'Estimates',
    action: fitAction('Estimates', name, [
      (who) => `send ${who} the Florida consumer notice`,
      (who) => `send ${who} the consumer notice`,
    ]),
    why: SEND_FAILURE_WHY[reason] || 'The notice could not be sent after the accept.',
    severity: 'needs-you',
    link: `/admin/estimates?estimateId=${encodeURIComponent(estimate.id)}`,
    subject: { type: 'estimate', id: String(estimate.id) },
    doneWhen: 'consumer_notice_signed',
    who: 'person',
  }, {
    // A treatment for a wood-destroying organism cannot start without the signed form: this must ring.
    bell: true,
    dedupeKey: `manual-accept-consumer-notice:${estimate.id}`,
    detail: 'The office marked a termite estimate accepted and the customer has no signed Florida consumer notice (FDACS-13692) on file. Send it from Document Requests or upload the signed paper form before the first treatment.',
    metadata: { estimateId: estimate.id, customerId: estimate.customer_id, reason },
  });
}

// After the office's Mark accepted commits (GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND, owner 2026-10-26): a termite
// estimate whose customer has no signed notice gets one by email and text. An open, unsigned notice from any source is
// resent with a fresh link; otherwise one is issued. Nothing is sent when the gate is off, the estimate is not an
// accepted termite estimate or a notice is already signed. A refusal or a delivery that reached no channel rings
// the office bell. Never throws. `customerId` is the accept's committed customer: a failed first read can still
// name them on the bell. `expected` is the Intelligence Bar card's pinned target (consumerNoticeTarget): the notice
// and the recipients it was approved for, checked again right before delivery.
async function sendManualAcceptConsumerNotice({ estimateId, customerId = null, expected = null, conn = db }) {
  const { manualAcceptConsumerNoticeSendLive } = require('../config/feature-gates');
  if (!manualAcceptConsumerNoticeSendLive()) return { skipped: 'gate_off' };
  let estimate = null;
  try {
    estimate = await conn('estimates').where({ id: estimateId }).first();
    const skipped = await manualAcceptSkip(estimate, conn);
    if (skipped) return { skipped };
    const notice = await manualAcceptNoticeContract(estimate, conn, manualAcceptConsumerNoticeSendLive);
    if (!notice.contractId) return notice;
    // The kill switch is read once more right before anything goes out: a send that waited on reads while the gate
    // was turned off sends nothing (a notice issued in between stays open, unsent, as one issued from the page).
    if (!manualAcceptConsumerNoticeSendLive()) return { skipped: 'gate_off', contractId: notice.contractId };
    const result = await deliverManualAcceptNotice(notice.contractId, expected);
    if (result.reason) await alertNoticeNotSent(estimate, result.reason, conn);
    return result;
  } catch (err) {
    logger.warn(`[estimate-consumer-notice] manual-accept send failed for estimate ${estimateId}: ${err.code || err.message}`);
    const subject = estimate || { id: estimateId, customer_id: customerId };
    await alertNoticeNotSent(subject, 'error', conn).catch(() => {});
    return { sent: false, reason: 'error' };
  }
}

// Why the send does not apply, or null: not an accepted estimate with a customer, no termite line, or signed already.
async function manualAcceptSkip(estimate, conn) {
  if (!estimate || estimate.status !== 'accepted' || !estimate.customer_id) return 'not_applicable';
  if (!estimateNeedsConsumerNotice(estimate)) return 'no_termite_line';
  if (await findConsumerNotice(conn, estimate.customer_id, { onOrBefore: etDateString() })) return 'already_signed';
  return null;
}

// The notice to send: the customer's newest open one (any source), else one issued now. { contractId } or the
// issuer's answer: a refusal the office must finish rings the bell here; signed or gone in between is a quiet skip.
async function manualAcceptNoticeContract(estimate, conn, gateLive) {
  const open = await conn('customer_contracts')
    .where({ customer_id: estimate.customer_id, contract_type: 'document_template', document_template_key: CONSUMER_NOTICE_TEMPLATE_KEY })
    .whereIn('status', OPEN_STATUSES)
    .orderBy('created_at', 'desc')
    .first('id');
  if (open?.id) return { contractId: open.id, reused: true };
  const issued = await ensureEstimateConsumerNotice({
    estimate,
    conn,
    source: MANUAL_ACCEPT_SOURCE,
    actorType: 'system',
    gateLive,
    // The locked row must still be the accepted estimate.
    blockedFor: async (_trx, locked) => locked.status !== 'accepted',
  });
  if (issued.ok) return { contractId: issued.contractId, reused: false };
  if (issued.code === 'already_signed' || issued.code === 'not_available') return { skipped: issued.code };
  await alertNoticeNotSent(estimate, issued.code, conn);
  return { sent: false, reason: issued.code };
}

// Email and text the notice. `expected` (a carded accept) binds the notice it saw and the recipients it showed: a
// different open notice sends nothing, only the channels it named go out, and delivery itself refuses a recipient
// that changed. `reason` is set whenever the office must finish it.
async function deliverManualAcceptNotice(contractId, expected) {
  if (expected && expected.contract_id !== null && expected.contract_id !== String(contractId)) {
    return { sent: false, reason: 'recipient_changed', contractId };
  }
  const channels = expected ? ['email', 'sms'].filter((c) => (c === 'email' ? expected.email_key : expected.phone_key)) : ['email', 'sms'];
  if (!channels.length) return { sent: false, reason: 'not_delivered', contractId };
  const { deliverDocumentRequestChannels } = require('./document-contract-delivery');
  // 'system': the send window holds a late text until 8 AM instead of sending it at night.
  const delivery = await deliverDocumentRequestChannels(contractId, { actorType: 'system' }, {
    channels,
    smsEntryPoint: 'manual_accept_consumer_notice',
    ...(expected ? { expectedRecipientKeys: { email: expected.email_key, sms: expected.phone_key } } : {}),
  });
  // A changed recipient is said even when the other channel went out: the office confirms who has the link.
  if ((delivery.deliveries || []).some((d) => d.code === 'RECIPIENT_CHANGED')) return { sent: delivery.ok, reason: 'recipient_changed', contractId };
  if (!delivery.ok) return { sent: false, reason: 'not_delivered', contractId };
  return { sent: true, contractId, channels: delivery.deliveries.filter((d) => d.ok).map((d) => d.channel) };
}

// The Intelligence Bar accept skipped the send because its pinned target changed after the commit (runPostCommit):
// nothing goes out, and the office is told to finish it. Never throws.
async function alertManualAcceptConsumerNoticeSkipped({ estimateId, customerId, conn = db }) {
  try {
    await alertNoticeNotSent({ id: estimateId, customer_id: customerId }, 'recipient_changed', conn);
  } catch (err) {
    logger.warn(`[estimate-consumer-notice] skip alert failed for estimate ${estimateId}: ${err.code || err.message}`);
  }
}

module.exports = {
  SNAPSHOT_SOURCE,
  MANUAL_ACCEPT_SOURCE,
  REQUIRED_MESSAGE,
  estimateNeedsConsumerNotice,
  consumerNoticeState,
  consumerNoticeCtaFor,
  consumerNoticeBlocksAccept,
  ensureEstimateConsumerNotice,
  consumerNoticeRecipients,
  consumerNoticeTarget,
  consumerNoticeCardFacts,
  sendManualAcceptConsumerNotice,
  alertManualAcceptConsumerNoticeSkipped,
};
