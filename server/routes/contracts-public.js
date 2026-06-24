const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const { logAutopay } = require('../services/autopay-log');
const { documentRequiresSignature, hashContractToken, serializeContract } = require('../services/contracts');
const logger = require('../services/logger');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(publicLimiter);

function contractQuery(conn = db) {
  return conn('customer_contracts as cc')
    .leftJoin('payment_methods as pm', function joinContractPaymentMethod() {
      this.on('cc.payment_method_id', 'pm.id').andOn('cc.customer_id', 'pm.customer_id');
    })
    .leftJoin('document_templates as dt', 'cc.document_template_id', 'dt.id')
    .select(
      'cc.*',
      'pm.method_type',
      'pm.card_brand',
      'pm.last_four',
      'pm.bank_name',
      'pm.bank_last_four',
      'pm.stripe_payment_method_id',
      'dt.requires_signature as document_template_requires_signature',
      'dt.category as document_template_category',
      'dt.document_type as document_template_document_type',
      conn.raw(`CASE
        WHEN pm.method_type IN ('ach', 'us_bank_account') THEN CONCAT(COALESCE(pm.bank_name, 'Bank account'), ' ending ', COALESCE(pm.bank_last_four, '----'))
        WHEN pm.id IS NOT NULL THEN CONCAT(COALESCE(pm.card_brand, 'Card'), ' ending ', COALESCE(pm.last_four, '----'))
        ELSE NULL
      END as payment_method_label`)
    );
}

function publicTokenHash(token) {
  const value = String(token || '').trim();
  if (value.length < 32 || value.length > 160) return null;
  return hashContractToken(value);
}

async function loadByToken(token, conn = db) {
  const hash = publicTokenHash(token);
  if (!hash) return null;
  return contractQuery(conn).where('cc.share_token_hash', hash).first();
}

async function insertEvent(trx, contract, eventType, req, metadata = {}) {
  await trx('customer_contract_events').insert({
    contract_id: contract.id,
    customer_id: contract.customer_id,
    event_type: eventType,
    actor_type: 'customer',
    ip: req.ip || null,
    user_agent: req.get('user-agent') || null,
    metadata: JSON.stringify(metadata),
  });
}

function isExpired(contract) {
  return !!(contract?.share_token_expires_at && new Date(contract.share_token_expires_at) < new Date());
}

router.get('/:token', async (req, res, next) => {
  try {
    const contract = await loadByToken(req.params.token);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    if (isExpired(contract)) {
      return res.status(410).json({ error: 'Contract link expired' });
    }
    if (contract.status === 'signed') {
      return res.status(410).json({ error: 'Contract has already been signed', status: contract.status });
    }
    if (['cancelled', 'voided'].includes(contract.status)) {
      return res.status(410).json({ error: 'Contract is no longer available', status: contract.status });
    }

    if (contract.status === 'sent') {
      await db.transaction(async (trx) => {
        const updated = await trx('customer_contracts').where({ id: contract.id, status: 'sent' }).update({
          status: 'viewed',
          viewed_at: contract.viewed_at || new Date(),
          updated_at: new Date(),
        });
        if (updated) await insertEvent(trx, contract, 'viewed', req);
      });
    }

    const latest = await loadByToken(req.params.token);

    // Branded PDF "review copy" served from this already-approved public
    // surface (/api/contracts/:token) via ?format=pdf — not a new route.
    // Signing nulls the single-use token, so signed contracts hit the 410
    // guard above; the executed copy is delivered by the post-sign email.
    if (req.query.format === 'pdf') {
      const customer = await db('customers')
        .where({ id: latest.customer_id })
        .first('first_name', 'last_name', 'company_name');
      const { generateContractPDF } = require('../services/pdf/contract-pdf');
      return generateContractPDF(latest, customer || {}, res, { signed: latest.status === 'signed' });
    }

    res.json({ contract: serializeContract(latest, { includeAudit: false }) });
  } catch (err) { next(err); }
});

router.post('/:token/sign', async (req, res, next) => {
  try {
    const signedName = String(req.body?.signedName || '').trim();
    const initials = String(req.body?.initials || '').trim().slice(0, 20);
    const agreeElectronic = req.body?.agreeElectronic === true;
    const agreeAuthorization = req.body?.agreeAuthorization === true;
    const agreeDocumentTerms = req.body?.agreeDocumentTerms === true;

    if (signedName.length < 2) return res.status(400).json({ error: 'Typed signature is required.' });
    if (signedName.length > 180) return res.status(400).json({ error: 'Typed signature must be 180 characters or fewer.' });
    if (initials.length < 1) return res.status(400).json({ error: 'Initials are required.' });
    if (!agreeElectronic) return res.status(400).json({ error: 'Electronic signature consent is required.' });

    const now = new Date();
    const tokenHash = publicTokenHash(req.params.token);
    if (!tokenHash) return res.status(404).json({ error: 'Contract not found' });

    let response;
    await db.transaction(async (trx) => {
      const locked = await trx('customer_contracts')
        .where({ share_token_hash: tokenHash })
        .forUpdate()
        .first();

      if (!locked) {
        response = { status: 404, body: { error: 'Contract not found' } };
        return;
      }
      if (isExpired(locked)) {
        response = { status: 410, body: { error: 'Contract link expired' } };
        return;
      }
      if (locked.status === 'signed') {
        response = { status: 410, body: { error: 'Contract has already been signed', status: locked.status, alreadySigned: true } };
        return;
      }
      if (['cancelled', 'voided'].includes(locked.status)) {
        response = { status: 410, body: { error: 'Contract is no longer available', status: locked.status } };
        return;
      }

      const contract = await contractQuery(trx).where('cc.id', locked.id).first();
      const isAutopayAuthorization = contract.contract_type === 'autopay_authorization';
      if (isAutopayAuthorization && !agreeAuthorization) {
        response = { status: 400, body: { error: 'Payment authorization agreement is required.' } };
        return;
      }
      if (!isAutopayAuthorization && !agreeDocumentTerms) {
        response = { status: 400, body: { error: 'Document agreement is required.' } };
        return;
      }
      if (!isAutopayAuthorization && !documentRequiresSignature(contract)) {
        response = { status: 400, body: { error: 'This document does not require a signature.' } };
        return;
      }
      if (isAutopayAuthorization && (!contract.payment_method_id || !contract.stripe_payment_method_id)) {
        response = { status: 409, body: { error: 'The selected payment method is no longer available for AutoPay.' } };
        return;
      }
      const customer = await trx('customers')
        .where({ id: contract.customer_id })
        .forUpdate()
        .first('id', 'active', 'deleted_at');
      if (!customer || customer.active === false || customer.deleted_at) {
        response = { status: 410, body: { error: 'Contract is no longer available for this customer.' } };
        return;
      }

      const signed = await trx('customer_contracts')
        .where({ id: contract.id, share_token_hash: tokenHash })
        .whereIn('status', ['sent', 'viewed'])
        .where((builder) => {
          builder.whereNull('share_token_expires_at').orWhere('share_token_expires_at', '>', now);
        })
        .update({
          status: 'signed',
          signed_at: now,
          signed_name: signedName,
          recipient_initials: initials,
          signer_ip: req.ip || null,
          signer_user_agent: req.get('user-agent') || null,
          share_token_hash: null,
          share_token_expires_at: null,
          updated_at: now,
        });
      if (signed !== 1) {
        response = { status: 409, body: { error: 'Contract could not be signed. Refresh and try again.' } };
        return;
      }

      await insertEvent(trx, contract, 'signed', req, {
        signedName,
        initials,
        agreeElectronic,
        agreementType: isAutopayAuthorization ? 'autopay_authorization' : 'document_terms',
        ...(isAutopayAuthorization ? { agreeAuthorization } : { agreeDocumentTerms }),
      });

      if (isAutopayAuthorization && contract.payment_method_id) {
        await trx('customers').where({ id: contract.customer_id }).update({
          autopay_enabled: true,
          autopay_payment_method_id: contract.payment_method_id,
          autopay_paused_until: null,
          autopay_pause_reason: null,
        });
        await trx('payment_methods').where({ customer_id: contract.customer_id }).update({ autopay_enabled: false, is_default: false });
        await trx('payment_methods').where({ id: contract.payment_method_id, customer_id: contract.customer_id }).update({ autopay_enabled: true, is_default: true });
      }

      if (isAutopayAuthorization && contract.stripe_payment_method_id) {
        await trx('payment_method_consents').insert({
          customer_id: contract.customer_id,
          payment_method_id: contract.payment_method_id,
          stripe_payment_method_id: contract.stripe_payment_method_id,
          source: 'contract_signing',
          consent_text_version: contract.consent_text_version,
          consent_text_snapshot: contract.consent_text_snapshot,
          ip: req.ip || null,
          user_agent: req.get('user-agent') || null,
        });
      }

      const updated = await contractQuery(trx).where('cc.id', contract.id).first();
      response = { status: 200, body: { contract: serializeContract(updated, { includeAudit: false }), signed: true } };
    });

    if (!response) {
      return res.status(500).json({ error: 'Contract could not be signed.' });
    }
    if (response.status !== 200) {
      return res.status(response.status).json(response.body);
    }

    if (response.body.contract?.paymentMethodId) {
      await logAutopay(response.body.contract.customerId, 'autopay_enabled', {
        paymentMethodId: response.body.contract.paymentMethodId,
        details: { reason: 'contract_signed', contract_id: response.body.contract.id },
      });
      await logAutopay(response.body.contract.customerId, 'payment_method_changed', {
        paymentMethodId: response.body.contract.paymentMethodId,
        details: { reason: 'contract_signed', contract_id: response.body.contract.id },
      });
      PaymentLifecycleEmail.sendAutopayEnabled({
        customerId: response.body.contract.customerId,
        paymentMethodId: response.body.contract.paymentMethodId,
        enabledDate: new Date(),
        idempotencyKey: `payment.autopay_enabled:${response.body.contract.customerId}:${response.body.contract.paymentMethodId}:contract:${response.body.contract.id}`,
      }).catch((emailErr) => {
        logger.warn(`[contracts-public] autopay enabled email failed for contract ${response.body.contract.id}: ${emailErr.message}`);
      });
    }

    // Email the customer their signed branded PDF as a record. Signing
    // consumes the single-use token, so this email is their copy. Document-
    // library contracts only — autopay has its own confirmation email above.
    // Fire-and-forget: never block or fail the sign response on email.
    if (response.body.contract?.id && response.body.contract.contractType === 'document_template') {
      const { sendSignedContractCopy } = require('../services/contract-signed-email');
      // Send failures are handled (sanitized) inside the service; this catch
      // is a backstop for unexpected errors. Log only the contract id — never
      // the error body, which could echo the recipient email.
      sendSignedContractCopy(response.body.contract.id).catch(() => {
        logger.warn(`[contracts-public] signed-copy email errored for contract ${response.body.contract.id}`);
      });
    }

    res.json(response.body);
  } catch (err) { next(err); }
});

module.exports = router;
