const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { logAutopay } = require('../services/autopay-log');
const {
  deliverDocumentRequest,
  documentRequestStats,
  listDocumentRequests,
} = require('../services/document-contract-delivery');
const {
  CONSENT_VERSION,
  getConsentText,
  ESIGN_DISCLOSURE,
  buildAutopayContractSnapshot,
  contractExpiresAt,
  documentContractExpiresAt,
  hashContractToken,
  mintContractToken,
  paymentMethodLabel,
  publicContractUrl,
  serializeContract,
  signerName,
} = require('../services/contracts');

router.use(adminAuthenticate, requireAdmin);

function dateOrNull(value) {
  if (!value) return null;
  const str = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : str;
}

function contractQuery() {
  return db('customer_contracts as cc')
    .leftJoin('payment_methods as pm', 'cc.payment_method_id', 'pm.id')
    .leftJoin('document_templates as dt', 'cc.document_template_id', 'dt.id')
    .select(
      'cc.*',
      'pm.method_type',
      'pm.card_brand',
      'pm.last_four',
      'pm.bank_name',
      'pm.bank_last_four',
      'dt.requires_signature as document_template_requires_signature',
      'dt.category as document_template_category',
      'dt.document_type as document_template_document_type',
      db.raw(`CASE
        WHEN pm.method_type IN ('ach', 'us_bank_account') THEN CONCAT(COALESCE(pm.bank_name, 'Bank account'), ' ending ', COALESCE(pm.bank_last_four, '----'))
        WHEN pm.id IS NOT NULL THEN CONCAT(COALESCE(pm.card_brand, 'Card'), ' ending ', COALESCE(pm.last_four, '----'))
        ELSE NULL
      END as payment_method_label`)
    );
}

async function loadContract(id) {
  return contractQuery().where('cc.id', id).first();
}

function parseEventMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function serializeContractEvent(event) {
  return {
    id: event.id,
    contractId: event.contract_id,
    customerId: event.customer_id,
    eventType: event.event_type,
    actorType: event.actor_type,
    actorId: event.actor_id,
    ip: event.ip,
    userAgent: event.user_agent,
    metadata: parseEventMetadata(event.metadata),
    createdAt: event.created_at,
  };
}

async function insertEvent(trx, contractId, customerId, eventType, req, metadata = {}) {
  await trx('customer_contract_events').insert({
    contract_id: contractId,
    customer_id: customerId,
    event_type: eventType,
    actor_type: 'admin',
    actor_id: req.technicianId || null,
    ip: req.ip || null,
    user_agent: req.get('user-agent') || null,
    metadata: JSON.stringify(metadata),
  });
}

async function defaultPaymentMethod(customerId, paymentMethodId) {
  let query = db('payment_methods').where({ customer_id: customerId });
  if (paymentMethodId) query = query.where({ id: paymentMethodId });
  else query = query.orderBy('autopay_enabled', 'desc').orderBy('is_default', 'desc').orderBy('created_at', 'desc');
  return query.first();
}

router.get('/customer/:customerId', async (req, res, next) => {
  try {
    const rows = await contractQuery()
      .where('cc.customer_id', req.params.customerId)
      .orderBy('cc.created_at', 'desc')
      .limit(50);

    res.json({ contracts: rows.map(row => serializeContract(row)) });
  } catch (err) { next(err); }
});

router.get('/requests', async (req, res, next) => {
  try {
    const result = await listDocumentRequests({
      status: req.query.status || 'open',
      search: req.query.search || '',
      limit: req.query.limit,
      page: req.query.page,
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/requests/stats', async (req, res, next) => {
  try {
    const stats = await documentRequestStats();
    res.json({ stats });
  } catch (err) { next(err); }
});

router.get('/:id/events', async (req, res, next) => {
  try {
    const contract = await loadContract(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    const events = await db('customer_contract_events')
      .where({ contract_id: contract.id })
      .orderBy('created_at', 'asc')
      .limit(100);
    const serializedEvents = events.map(serializeContractEvent);
    res.json({
      contract: serializeContract(contract, {
        events: serializedEvents,
      }),
      events: serializedEvents,
    });
  } catch (err) { next(err); }
});

router.post('/:id/send-email', async (req, res, next) => {
  try {
    const result = await deliverDocumentRequest(req.params.id, req, {
      channel: 'email',
      action: 'send',
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.post('/:id/send-sms', async (req, res, next) => {
  try {
    const result = await deliverDocumentRequest(req.params.id, req, {
      channel: 'sms',
      action: 'send',
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.post('/:id/remind', async (req, res, next) => {
  try {
    const channel = req.body?.channel || 'email';
    const result = await deliverDocumentRequest(req.params.id, req, {
      channel,
      action: 'reminder',
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.post('/customer/:customerId/autopay-authorization', async (req, res, next) => {
  try {
    const customer = await db('customers')
      .where({ id: req.params.customerId })
      .whereNull('deleted_at')
      .first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const paymentMethod = await defaultPaymentMethod(customer.id, req.body?.paymentMethodId);
    if (!paymentMethod) {
      return res.status(400).json({ error: 'A saved payment method is required before creating an autopay authorization contract.' });
    }
    if (!paymentMethod.stripe_payment_method_id) {
      return res.status(400).json({ error: 'A Stripe saved payment method is required before creating an AutoPay authorization contract.' });
    }

    const serviceName = String(req.body?.serviceName || customer.waveguard_tier || 'Waves service agreement').trim();
    const renewalDate = dateOrNull(req.body?.renewalDate);
    const cancellationDeadline = dateOrNull(req.body?.cancellationDeadline);
    const token = mintContractToken();
    const tokenHash = hashContractToken(token);
    const expiresAt = contractExpiresAt();
    const recipientName = signerName(customer);
    const contractText = buildAutopayContractSnapshot({
      customer,
      paymentMethod,
      serviceName,
      renewalDate,
      cancellationDeadline,
    });

    const [contract] = await db.transaction(async (trx) => {
      // Comms fence + post-lock re-read (Codex #3109 r29): the contract is
      // an email-bound bearer surface — minting it with the pre-transaction
      // customer snapshot while a merge-undo holds the row lets the insert
      // commit a winner-owned contract whose recipient_email the undo just
      // restored to another account. Lock, re-read, mint from live state.
      await lockCustomerComms(trx, customer.id);
      // FULL row (r37): signerName/buildAutopayContractSnapshot read
      // company_name and friends — a column-listed read rendered business
      // customers as "Customer" in the signed snapshot.
      const freshContractCustomer = await trx('customers')
        .where({ id: customer.id })
        .first();
      if (!freshContractCustomer || freshContractCustomer.deleted_at || freshContractCustomer.active === false) {
        const err = new Error('This customer changed while creating the contract — reload and try again.');
        err.statusCode = 409;
        err.isOperational = true;
        throw err;
      }
      // The METHOD re-resolves under the fence too (r31): a merge-undo can
      // return the selected card to the restored customer while this
      // request waits — minting against it would issue a signing link the
      // public page can never satisfy (it joins methods by the contract's
      // customer). Moved/gone → retryable 409; the snapshot rebuilds from
      // the LOCKED customer + method so the rendered identity is live.
      const freshMethod = await trx('payment_methods')
        .where({ id: paymentMethod.id })
        .first();
      if (!freshMethod || String(freshMethod.customer_id) !== String(customer.id)) {
        const movedErr = new Error('The selected payment method changed while creating the contract (a merge was undone) — reload and pick again.');
        movedErr.statusCode = 409;
        movedErr.isOperational = true;
        movedErr.code = 'METHOD_OWNER_CHANGED';
        throw movedErr;
      }
      const liveRecipientName = signerName(freshContractCustomer);
      const liveContractText = buildAutopayContractSnapshot({
        customer: freshContractCustomer,
        paymentMethod: freshMethod,
        serviceName,
        renewalDate,
        cancellationDeadline,
      });
      const [row] = await trx('customer_contracts').insert({
        customer_id: customer.id,
        payment_method_id: paymentMethod.id,
        created_by: req.technicianId || null,
        contract_type: 'autopay_authorization',
        title: 'AutoPay Authorization',
        status: 'sent',
        recipient_name: liveRecipientName,
        recipient_email: freshContractCustomer.email || null,
        recipient_phone: freshContractCustomer.phone || null,
        service_name: serviceName,
        renewal_date: renewalDate,
        cancellation_deadline: cancellationDeadline,
        auto_renewal_notice_required: !!(renewalDate && cancellationDeadline),
        consent_text_version: CONSENT_VERSION,
        consent_text_snapshot: getConsentText(freshMethod?.method_type),
        contract_text_snapshot: liveContractText,
        esign_disclosure_snapshot: ESIGN_DISCLOSURE,
        share_token_hash: tokenHash,
        share_token_expires_at: expiresAt,
        shared_at: new Date(),
      }).returning('*');

      await insertEvent(trx, row.id, customer.id, 'created', req, {
        paymentMethodId: paymentMethod.id,
        paymentMethodLabel: paymentMethodLabel(paymentMethod),
      });
      await insertEvent(trx, row.id, customer.id, 'share_link_created', req, {
        expiresAt: expiresAt.toISOString(),
      });
      return [row];
    });

    const hydrated = await loadContract(contract.id);
    const signingUrl = publicContractUrl(token);
    res.status(201).json({ contract: serializeContract(hydrated, { signingUrl }), signingUrl });
  } catch (err) { next(err); }
});

// Expiry window for a fresh signing link — a document request follows its
// template's window; every other contract the default TTL.
async function shareLinkExpiresAt(trx, contract) {
  if (contract.contract_type === 'document_template' && contract.document_template_id) {
    const template = await trx('document_templates')
      .where({ id: contract.document_template_id })
      .first('expire_after_days', 'requires_signature');
    return documentContractExpiresAt(new Date(), template?.expire_after_days || 14, {
      requires_signature_snapshot: contract.requires_signature_snapshot,
      requires_signature: template?.requires_signature,
    });
  }
  return contractExpiresAt();
}

// A signing link the customer may hold: hashed, windowed, window still open.
function deliveredLiveShareLink(contract) {
  return !!contract?.share_token_hash
    && !!contract.share_token_expires_at
    && new Date(contract.share_token_expires_at).getTime() > Date.now();
}

const SHARE_LINK_TERMINAL_STATUSES = ['signed', 'cancelled', 'voided'];
// Statuses a fresh signing link may be written over — an expired document
// request re-opens on a fresh window; every other contract type does not.
const shareLinkWritableStatuses = (contract) => (contract.contract_type === 'document_template'
  ? ['draft', 'sent', 'viewed', 'expired']
  : ['draft', 'sent', 'viewed']);

// Mint a fresh signing link for a live contract — the Contracts page's
// deliberate action (the route below). The raw token is never stored (hash
// only), so every mint ROTATES the previous link. Returns { signingUrl,
// expiresAt, contract } or { error: { status, message } }.
async function createShareLink(contractId, req) {
  const token = mintContractToken();
  let expiresAt = null;
  let error = null;
  await db.transaction(async (trx) => {
    const contract = await trx('customer_contracts')
      .where({ id: contractId })
      .forUpdate()
      .first();
    if (!contract) {
      error = { status: 404, message: 'Contract not found' };
      return;
    }
    if (SHARE_LINK_TERMINAL_STATUSES.includes(contract.status)) {
      error = { status: 400, message: `Cannot create a signing link for a ${contract.status} contract.` };
      return;
    }
    expiresAt = await shareLinkExpiresAt(trx, contract);
    const now = new Date();
    const updated = await trx('customer_contracts')
      .where({ id: contract.id })
      .whereIn('status', shareLinkWritableStatuses(contract))
      .update({
        status: 'sent',
        share_token_hash: hashContractToken(token),
        share_token_expires_at: expiresAt,
        shared_at: now,
        updated_at: now,
      });
    if (updated !== 1) {
      error = { status: 409, message: 'Contract status changed. Refresh and try again.' };
      return;
    }
    await insertEvent(trx, contract.id, contract.customer_id, 'share_link_created', req, {
      expiresAt: expiresAt.toISOString(),
    });
  });
  if (error) return { error };
  const contract = await loadContract(contractId);
  return { signingUrl: publicContractUrl(token), expiresAt, contract };
}

const NOT_LIVE = 'This contract signing link is no longer live — remove it and insert a fresh one.';

/**
 * The composer's contract signing link, second half (GH Codex #3844 r3 P1):
 * the Insert Link sheet mints the token IN MEMORY and writes nothing — a
 * prepared link is nobody's until the /sms send activates it here, BEFORE
 * the provider call, the way the document delivery activates its prepared
 * token before it sends. Under the row lock: a link the customer may
 * already hold (delivered, window open) refuses — two composers racing on
 * one contract serialize here and the second loses, nothing is ever
 * rotated; otherwise the hash lands with status sent, shared_at now and a
 * window opened from the send. A link the customer already holds (one
 * pasted from the Contracts page, `delivered`) is re-verified and needs
 * no write. Returns { ok: true, activations } for restorePreparedShareLinks
 * (a send that never left) or recordPreparedShareLinkSends (a real one),
 * else { ok: false, error } with every activation this call made undone —
 * and a throw part-way (a later link's lock, template read or event write
 * failing) undoes them too before it surfaces, so no signing credential
 * this call committed outlives a send that never happened (pre-push P0).
 */
async function activatePreparedShareLinks(links, req) {
  const activations = [];
  try {
    return await activateEachPreparedShareLink(links, req, activations);
  } catch (err) {
    await restorePreparedShareLinks(activations, req, { reason: `Activation failed: ${err.message}` }).catch((restoreErr) => {
      logger.error(`[contracts] prepared link restore after an activation throw failed (contracts ${activations.map((a) => a.id).join(', ')} keep their activated link until it expires): ${restoreErr.message}`);
    });
    throw err;
  }
}

async function activateEachPreparedShareLink(links, req, activations) {
  for (const link of links) {
    let refusal = null;
    await db.transaction(async (trx) => {
      const locked = await trx('customer_contracts').where({ id: link.id }).forUpdate().first();
      if (!locked) { refusal = NOT_LIVE; return; }
      if (SHARE_LINK_TERMINAL_STATUSES.includes(locked.status)) {
        refusal = 'This contract is no longer awaiting a signature — remove the signing link before sending.';
        return;
      }
      if (link.delivered) {
        if (locked.share_token_hash !== link.tokenHash || !deliveredLiveShareLink(locked)) { refusal = NOT_LIVE; return; }
        activations.push({ id: locked.id, customerId: locked.customer_id, tokenHash: link.tokenHash, expiresAt: locked.share_token_expires_at, previous: null });
        return;
      }
      if (deliveredLiveShareLink(locked)) {
        refusal = `A signing link for ${String(locked.title || '').trim() || 'this contract'} was already sent and is still live — remove this one; the customer can use theirs, or resend it from the Contracts page.`;
        return;
      }
      if (!shareLinkWritableStatuses(locked).includes(locked.status)) {
        refusal = 'Contract status changed. Refresh and try again.';
        return;
      }
      const expiresAt = await shareLinkExpiresAt(trx, locked);
      const now = new Date();
      await trx('customer_contracts')
        .where({ id: locked.id })
        .update({ status: 'sent', share_token_hash: link.tokenHash, share_token_expires_at: expiresAt, shared_at: now, updated_at: now });
      await insertEvent(trx, locked.id, locked.customer_id, 'share_link_created', req, { expiresAt: expiresAt.toISOString(), source: 'composer' });
      activations.push({
        id: locked.id,
        customerId: locked.customer_id,
        tokenHash: link.tokenHash,
        expiresAt,
        previous: {
          status: locked.status,
          share_token_hash: locked.share_token_hash,
          share_token_expires_at: locked.share_token_expires_at,
          shared_at: locked.shared_at,
        },
      });
    });
    if (refusal) {
      await restorePreparedShareLinks(activations, req, { reason: 'A later link in the same message refused' });
      return { ok: false, error: refusal };
    }
  }
  return { ok: true, activations };
}

// A send that never left puts the contract back exactly as it was —
// conditional on the hash, so a link rotated meanwhile belongs to its new
// owner and is left alone. Records the document delivery's own
// delivery_failed event; a link the customer already held needs nothing.
async function restorePreparedShareLinks(activations, req, { reason = null } = {}) {
  for (const a of activations) {
    if (!a.previous) continue;
    const restored = await db('customer_contracts')
      .where({ id: a.id, share_token_hash: a.tokenHash })
      .update({ ...a.previous, updated_at: new Date() });
    if (restored === 1) {
      await insertEvent(db, a.id, a.customerId, 'delivery_failed', req, { channel: 'sms', action: 'composer', reason });
    }
  }
}

// A REAL provider send is the delivery — the event the document delivery
// records for its own SMS sends (recordDeliverySuccess), so the contract's
// timeline shows it. The row was activated before the call.
async function recordPreparedShareLinkSends(activations, req, result = {}) {
  for (const a of activations) {
    await insertEvent(db, a.id, a.customerId, 'sms_sent', req, {
      channel: 'sms',
      action: 'composer',
      provider: result.provider || null,
      providerMessageId: result.providerMessageId || null,
      expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
    });
  }
}

router.post('/:id/share-link', async (req, res, next) => {
  try {
    const result = await createShareLink(req.params.id, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });
    const { contract, signingUrl } = result;
    res.json({ contract: serializeContract(contract, { signingUrl }), signingUrl });
  } catch (err) { next(err); }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim() || 'Cancelled by admin';
    const requestedRevokeAutopay = req.body?.revokeAutopay === true;
    const now = new Date();
    let autopayRevoked = false;
    let response;
    let cancelledContract = null;
    let alreadyCancelledContractId = null;

    await db.transaction(async (trx) => {
      // Shared Auto Pay lock protocol (#3556): CUSTOMER row FOR UPDATE
      // first, then the contract. Locking the contract first cycled with a
      // portal removal — DELETE holds customer + method, the method delete
      // fires this contract's payment_method_id ON DELETE SET NULL and
      // waits on the contract lock, while this route waits on the customer
      // row. Same peek → customer lock → re-verify shape as /:token/sign.
      const peek = await trx('customer_contracts')
        .where({ id: req.params.id })
        .first('id', 'customer_id');
      if (!peek) {
        response = { status: 404, body: { error: 'Contract not found' } };
        return;
      }
      if (peek.customer_id) {
        await trx('customers').where({ id: peek.customer_id }).forUpdate().first('id');
      }
      const contract = await trx('customer_contracts')
        .where({ id: req.params.id })
        .forUpdate()
        .first();
      if (!contract) {
        response = { status: 404, body: { error: 'Contract not found' } };
        return;
      }
      if (String(contract.customer_id || '') !== String(peek.customer_id || '')) {
        // Repointed while we waited (a merge-undo) — retry under the right lock.
        response = { status: 409, body: { error: 'This contract was just updated — reload and try again.' } };
        return;
      }
      if (contract.status === 'cancelled') {
        alreadyCancelledContractId = contract.id;
        return;
      }

      const customer = await trx('customers')
        .where({ id: contract.customer_id })
        .first('autopay_enabled', 'autopay_payment_method_id');
      const latestSigned = await trx('customer_contracts')
        .where({
          customer_id: contract.customer_id,
          status: 'signed',
          contract_type: 'autopay_authorization',
        })
        .whereNotNull('payment_method_id')
        .orderBy('signed_at', 'desc')
        .orderBy('created_at', 'desc')
        .first('id');
      const canRevokeCurrentAutopay = requestedRevokeAutopay
        && contract.status === 'signed'
        && latestSigned?.id === contract.id
        && customer?.autopay_enabled !== false
        && !!contract.payment_method_id
        && customer?.autopay_payment_method_id === contract.payment_method_id;

      const cancelled = await trx('customer_contracts')
        .where({ id: contract.id, status: contract.status })
        .whereNotIn('status', ['cancelled', 'voided'])
        .update({
          status: 'cancelled',
          cancelled_at: now,
          cancelled_reason: reason,
          share_token_hash: null,
          share_token_expires_at: null,
          updated_at: now,
        });
      if (cancelled !== 1) {
        response = { status: 409, body: { error: 'Contract status changed. Refresh and try again.' } };
        return;
      }
      cancelledContract = contract;
      await insertEvent(trx, contract.id, contract.customer_id, 'cancelled', req, {
        reason,
        requestedRevokeAutopay,
        revokeAutopay: canRevokeCurrentAutopay,
      });

      if (canRevokeCurrentAutopay) {
        await trx('customers').where({ id: contract.customer_id }).update({
          autopay_enabled: false,
          autopay_payment_method_id: null,
          autopay_paused_until: null,
          autopay_pause_reason: null,
        });
        await trx('payment_methods').where({ customer_id: contract.customer_id }).update({ autopay_enabled: false });
        autopayRevoked = true;
      }
    });

    if (response) return res.status(response.status).json(response.body);
    if (alreadyCancelledContractId) {
      const contract = await loadContract(alreadyCancelledContractId);
      return res.json({ contract: serializeContract(contract), updated: false });
    }

    if (autopayRevoked && cancelledContract) {
      await logAutopay(cancelledContract.customer_id, 'autopay_disabled', {
        paymentMethodId: cancelledContract.payment_method_id,
        details: { reason: 'contract_cancelled', contract_id: cancelledContract.id },
      });
    }

    const updated = await loadContract(req.params.id);
    res.json({ contract: serializeContract(updated), updated: true, autopayRevoked });
  } catch (err) { next(err); }
});

router.post('/:id/renewal-notice', async (req, res, next) => {
  try {
    const contract = await loadContract(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    const sentAt = new Date();

    await db.transaction(async (trx) => {
      await trx('customer_contracts').where({ id: contract.id }).update({
        auto_renewal_notice_sent_at: sentAt,
        updated_at: sentAt,
      });
      await insertEvent(trx, contract.id, contract.customer_id, 'auto_renewal_notice_marked_sent', req, {
        sentAt: sentAt.toISOString(),
      });
    });

    const updated = await loadContract(contract.id);
    res.json({ contract: serializeContract(updated) });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.createShareLink = createShareLink;
module.exports.deliveredLiveShareLink = deliveredLiveShareLink;
module.exports.shareLinkWritableStatuses = shareLinkWritableStatuses;
module.exports.activatePreparedShareLinks = activatePreparedShareLinks;
module.exports.restorePreparedShareLinks = restorePreparedShareLinks;
module.exports.recordPreparedShareLinkSends = recordPreparedShareLinkSends;
