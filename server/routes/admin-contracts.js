const express = require('express');
const router = express.Router();
const db = require('../models/db');
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
      const [row] = await trx('customer_contracts').insert({
        customer_id: customer.id,
        payment_method_id: paymentMethod.id,
        created_by: req.technicianId || null,
        contract_type: 'autopay_authorization',
        title: 'AutoPay Authorization',
        status: 'sent',
        recipient_name: recipientName,
        recipient_email: customer.email || null,
        recipient_phone: customer.phone || null,
        service_name: serviceName,
        renewal_date: renewalDate,
        cancellation_deadline: cancellationDeadline,
        auto_renewal_notice_required: !!(renewalDate && cancellationDeadline),
        consent_text_version: CONSENT_VERSION,
        consent_text_snapshot: getConsentText(paymentMethod?.method_type),
        contract_text_snapshot: contractText,
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

router.post('/:id/share-link', async (req, res, next) => {
  try {
    const token = mintContractToken();
    let expiresAt = contractExpiresAt();
    let response;
    await db.transaction(async (trx) => {
      const contract = await trx('customer_contracts')
        .where({ id: req.params.id })
        .forUpdate()
        .first();
      if (!contract) {
        response = { status: 404, body: { error: 'Contract not found' } };
        return;
      }
      if (['signed', 'cancelled', 'voided'].includes(contract.status)) {
        response = { status: 400, body: { error: `Cannot create a signing link for a ${contract.status} contract.` } };
        return;
      }
      const isDocumentRequest = contract.contract_type === 'document_template';
      if (isDocumentRequest && contract.document_template_id) {
        const template = await trx('document_templates')
          .where({ id: contract.document_template_id })
          .first('expire_after_days', 'requires_signature');
        expiresAt = documentContractExpiresAt(new Date(), template?.expire_after_days || 14, {
          requires_signature_snapshot: contract.requires_signature_snapshot,
          requires_signature: template?.requires_signature,
        });
      }

      const updated = await trx('customer_contracts')
        .where({ id: contract.id })
        .whereIn('status', isDocumentRequest ? ['draft', 'sent', 'viewed', 'expired'] : ['draft', 'sent', 'viewed'])
        .update({
          status: 'sent',
          share_token_hash: hashContractToken(token),
          share_token_expires_at: expiresAt,
          shared_at: new Date(),
          updated_at: new Date(),
        });
      if (updated !== 1) {
        response = { status: 409, body: { error: 'Contract status changed. Refresh and try again.' } };
        return;
      }
      await insertEvent(trx, contract.id, contract.customer_id, 'share_link_created', req, {
        expiresAt: expiresAt.toISOString(),
      });
    });

    if (response) return res.status(response.status).json(response.body);

    const updated = await loadContract(req.params.id);
    const signingUrl = publicContractUrl(token);
    res.json({ contract: serializeContract(updated, { signingUrl }), signingUrl });
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
      const contract = await trx('customer_contracts')
        .where({ id: req.params.id })
        .forUpdate()
        .first();
      if (!contract) {
        response = { status: 404, body: { error: 'Contract not found' } };
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
