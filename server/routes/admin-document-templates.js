const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const {
  ESIGN_DISCLOSURE,
  documentContractExpiresAt,
  hashContractToken,
  mintContractToken,
  publicContractUrl,
  serializeContract,
  signerName,
} = require('../services/contracts');
const {
  assertTemplateSignatureMode,
  buildCustomerDocumentContext,
  jsonb,
  renderDocumentTemplate,
  serializeTemplate,
  serializeVersion,
  validateTemplatePayload,
  validateVersionPayload,
} = require('../services/document-template-library');
const {
  previewBulkDocumentSend,
  sendBulkDocument,
} = require('../services/document-template-bulk-send');

router.use(adminAuthenticate, requireAdmin);

function clampLimit(value, fallback = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(250, Math.floor(n)));
}

function templateQuery(conn = db) {
  return conn('document_templates as dt')
    .leftJoin('document_template_versions as active_version', 'dt.active_version_id', 'active_version.id')
    .select(
      'dt.*',
      'active_version.id as active_version__id',
      'active_version.template_id as active_version__template_id',
      'active_version.version_number as active_version__version_number',
      'active_version.title as active_version__title',
      'active_version.body as active_version__body',
      'active_version.signer_disclosure as active_version__signer_disclosure',
      'active_version.variables as active_version__variables',
      'active_version.required_fields as active_version__required_fields',
      'active_version.created_by as active_version__created_by',
      'active_version.published_at as active_version__published_at',
      'active_version.created_at as active_version__created_at',
    );
}

function splitTemplateRow(row = {}) {
  const activeVersion = row.active_version__id ? {
    id: row.active_version__id,
    template_id: row.active_version__template_id,
    version_number: row.active_version__version_number,
    title: row.active_version__title,
    body: row.active_version__body,
    signer_disclosure: row.active_version__signer_disclosure,
    variables: row.active_version__variables,
    required_fields: row.active_version__required_fields,
    created_by: row.active_version__created_by,
    published_at: row.active_version__published_at,
    created_at: row.active_version__created_at,
  } : null;
  return { template: row, activeVersion };
}

function contractQuery(conn = db) {
  return conn('customer_contracts as cc')
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
      conn.raw(`CASE
        WHEN pm.method_type IN ('ach', 'us_bank_account') THEN CONCAT(COALESCE(pm.bank_name, 'Bank account'), ' ending ', COALESCE(pm.bank_last_four, '----'))
        WHEN pm.id IS NOT NULL THEN CONCAT(COALESCE(pm.card_brand, 'Card'), ' ending ', COALESCE(pm.last_four, '----'))
        ELSE NULL
      END as payment_method_label`)
    );
}

async function loadTemplateByKey(key, conn = db) {
  const row = await templateQuery(conn).where('dt.template_key', key).first();
  if (!row) return null;
  const { template, activeVersion } = splitTemplateRow(row);
  return { template, activeVersion };
}

async function nextVersionNumber(templateId, conn = db) {
  const row = await conn('document_template_versions')
    .where({ template_id: templateId })
    .max('version_number as max_version')
    .first();
  return Number(row?.max_version || 0) + 1;
}

async function insertContractEvent(trx, contractId, customerId, req, metadata = {}) {
  await trx('customer_contract_events').insert({
    contract_id: contractId,
    customer_id: customerId,
    event_type: 'created_from_document_template',
    actor_type: 'admin',
    actor_id: req.technicianId || null,
    ip: req.ip || null,
    user_agent: req.get('user-agent') || null,
    metadata: jsonb(metadata, {}),
  });
}

router.get('/', async (req, res, next) => {
  try {
    let query = templateQuery();
    if (req.query.status && req.query.status !== 'all') query = query.where('dt.status', req.query.status);
    if (req.query.category && req.query.category !== 'all') query = query.where('dt.category', req.query.category);
    if (req.query.search) {
      const needle = `%${String(req.query.search).trim()}%`;
      query = query.where((builder) => {
        builder.whereILike('dt.name', needle)
          .orWhereILike('dt.template_key', needle)
          .orWhereILike('dt.description', needle);
      });
    }
    const rows = await query.orderBy('dt.category', 'asc').orderBy('dt.name', 'asc').limit(clampLimit(req.query.limit));
    const templates = rows.map((row) => {
      const { template, activeVersion } = splitTemplateRow(row);
      return serializeTemplate(template, activeVersion);
    });
    res.json({ templates });
  } catch (err) { next(err); }
});

router.get('/:key', async (req, res, next) => {
  try {
    const loaded = await loadTemplateByKey(req.params.key);
    if (!loaded) return res.status(404).json({ error: 'Document template not found' });
    const versions = await db('document_template_versions')
      .where({ template_id: loaded.template.id })
      .orderBy('version_number', 'desc')
      .limit(50);
    res.json({
      template: serializeTemplate(loaded.template, loaded.activeVersion),
      versions: versions.map(serializeVersion),
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const templatePayload = validateTemplatePayload(req.body || {});
    const versionPayload = validateVersionPayload({
      title: req.body?.title || req.body?.name,
      body: req.body?.body,
      signerDisclosure: req.body?.signerDisclosure,
      variables: req.body?.versionVariables || req.body?.variables,
      requiredFields: req.body?.requiredFields,
    });

    const result = await db.transaction(async (trx) => {
      const existing = await trx('document_templates').where({ template_key: templatePayload.template_key }).first();
      if (existing) {
        const err = new Error('A document template with that key already exists.');
        err.status = 409;
        throw err;
      }
      const [template] = await trx('document_templates').insert({
        ...templatePayload,
        variables: jsonb(templatePayload.variables, []),
        tags: jsonb(templatePayload.tags, []),
        reminder_schedule_days: jsonb(templatePayload.reminder_schedule_days, [1, 3, -1]),
        created_by: req.technicianId || null,
        updated_by: req.technicianId || null,
      }).returning('*');
      const [version] = await trx('document_template_versions').insert({
        template_id: template.id,
        version_number: 1,
        title: versionPayload.title,
        body: versionPayload.body,
        signer_disclosure: versionPayload.signer_disclosure || ESIGN_DISCLOSURE,
        variables: jsonb(versionPayload.variables, []),
        required_fields: jsonb(versionPayload.required_fields, ['initials', 'signedName']),
        created_by: req.technicianId || null,
        published_at: templatePayload.status === 'active' ? trx.fn.now() : null,
      }).returning('*');
      await trx('document_templates').where({ id: template.id }).update({
        active_version_id: version.id,
        updated_at: trx.fn.now(),
      });
      return { template: { ...template, active_version_id: version.id }, version };
    });

    res.status(201).json({
      template: serializeTemplate(result.template, result.version),
      version: serializeVersion(result.version),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/:key', async (req, res, next) => {
  try {
    const existing = await db('document_templates')
      .where({ template_key: req.params.key })
      .first('id', 'category', 'document_type', 'requires_signature');
    if (!existing) return res.status(404).json({ error: 'Document template not found' });

    const payload = validateTemplatePayload(req.body || {}, { partial: true });
    delete payload.template_key;
    assertTemplateSignatureMode({
      category: payload.category || existing.category,
      document_type: payload.document_type || existing.document_type,
      requires_signature: Object.prototype.hasOwnProperty.call(payload, 'requires_signature')
        ? payload.requires_signature
        : existing.requires_signature !== false,
    });
    if (payload.variables) payload.variables = jsonb(payload.variables, []);
    if (payload.tags) payload.tags = jsonb(payload.tags, []);
    if (payload.reminder_schedule_days) payload.reminder_schedule_days = jsonb(payload.reminder_schedule_days, [1, 3, -1]);
    payload.updated_by = req.technicianId || null;
    payload.updated_at = new Date();

    const [updated] = await db('document_templates')
      .where({ template_key: req.params.key })
      .update(payload)
      .returning('*');
    if (!updated) return res.status(404).json({ error: 'Document template not found' });
    const loaded = await loadTemplateByKey(req.params.key);
    res.json({ template: serializeTemplate(loaded.template, loaded.activeVersion) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/:key/versions', async (req, res, next) => {
  try {
    const loaded = await loadTemplateByKey(req.params.key);
    if (!loaded) return res.status(404).json({ error: 'Document template not found' });
    const payload = validateVersionPayload(req.body || {});
    const publish = req.body?.publish !== false;
    const version = await db.transaction(async (trx) => {
      const versionNumber = await nextVersionNumber(loaded.template.id, trx);
      const [row] = await trx('document_template_versions').insert({
        template_id: loaded.template.id,
        version_number: versionNumber,
        title: payload.title,
        body: payload.body,
        signer_disclosure: payload.signer_disclosure || ESIGN_DISCLOSURE,
        variables: jsonb(payload.variables, []),
        required_fields: jsonb(payload.required_fields, ['initials', 'signedName']),
        created_by: req.technicianId || null,
        published_at: publish ? trx.fn.now() : null,
      }).returning('*');
      if (publish) {
        await trx('document_templates').where({ id: loaded.template.id }).update({
          active_version_id: row.id,
          status: 'active',
          updated_by: req.technicianId || null,
          updated_at: trx.fn.now(),
        });
      }
      return row;
    });
    const refreshed = await loadTemplateByKey(req.params.key);
    res.status(201).json({
      template: serializeTemplate(refreshed.template, refreshed.activeVersion),
      version: serializeVersion(version),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/versions/:id/publish', async (req, res, next) => {
  try {
    const version = await db('document_template_versions').where({ id: req.params.id }).first();
    if (!version) return res.status(404).json({ error: 'Document template version not found' });
    await db.transaction(async (trx) => {
      await trx('document_template_versions').where({ id: version.id }).update({
        published_at: version.published_at || trx.fn.now(),
      });
      await trx('document_templates').where({ id: version.template_id }).update({
        active_version_id: version.id,
        status: 'active',
        updated_by: req.technicianId || null,
        updated_at: trx.fn.now(),
      });
    });
    const template = await db('document_templates').where({ id: version.template_id }).first();
    const loaded = await loadTemplateByKey(template.template_key);
    res.json({ template: serializeTemplate(loaded.template, loaded.activeVersion), version: serializeVersion(version) });
  } catch (err) { next(err); }
});

router.post('/:key/preview', async (req, res, next) => {
  try {
    const loaded = await loadTemplateByKey(req.params.key);
    if (!loaded) return res.status(404).json({ error: 'Document template not found' });
    if (!loaded.activeVersion) return res.status(409).json({ error: 'Document template has no active version' });
    const context = req.body?.context || req.body?.values || {};
    const rendered = renderDocumentTemplate({
      template: loaded.template,
      version: loaded.activeVersion,
      context,
    });
    res.json({ rendered });
  } catch (err) { next(err); }
});

router.post('/:key/bulk-preview', async (req, res, next) => {
  try {
    const result = await previewBulkDocumentSend(req.params.key, req.body || {});
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.post('/:key/bulk-send', async (req, res, next) => {
  try {
    const result = await sendBulkDocument(req.params.key, req.body || {}, req);
    res.status(202).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

router.post('/:key/contracts', async (req, res, next) => {
  try {
    const loaded = await loadTemplateByKey(req.params.key);
    if (!loaded) return res.status(404).json({ error: 'Document template not found' });
    if (loaded.template.status !== 'active') return res.status(409).json({ error: 'Document template is not active' });
    if (!loaded.activeVersion) return res.status(409).json({ error: 'Document template has no active version' });

    const customerId = req.body?.customerId || req.body?.customer_id;
    const customer = await db('customers')
      .where({ id: customerId })
      .whereNull('deleted_at')
      .first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const values = req.body?.values || {};
    const context = buildCustomerDocumentContext(customer, values);
    const rendered = renderDocumentTemplate({
      template: loaded.template,
      version: loaded.activeVersion,
      context,
    });
    if (rendered.unresolvedVariables.length && req.body?.allowUnresolved !== true) {
      return res.status(400).json({
        error: 'Document has unresolved merge fields.',
        unresolvedVariables: rendered.unresolvedVariables,
      });
    }

    const token = mintContractToken();
    const expiresAt = documentContractExpiresAt(new Date(), loaded.template.expire_after_days, loaded.template);
    const recipientName = cleanRecipientName(req.body?.recipientName) || signerName(customer);
    const recipientEmail = cleanRecipientName(req.body?.recipientEmail) || customer.email || null;
    const recipientPhone = cleanRecipientName(req.body?.recipientPhone) || customer.phone || null;

    const contract = await db.transaction(async (trx) => {
      const [row] = await trx('customer_contracts').insert({
        customer_id: customer.id,
        created_by: req.technicianId || null,
        contract_type: 'document_template',
        title: rendered.title || loaded.activeVersion.title || loaded.template.name,
        status: loaded.template.requires_signature === false ? 'sent' : 'sent',
        recipient_name: recipientName,
        recipient_email: recipientEmail,
        recipient_phone: recipientPhone,
        service_name: context.service?.name || null,
        esign_disclosure_snapshot: loaded.activeVersion.signer_disclosure || ESIGN_DISCLOSURE,
        contract_text_snapshot: rendered.body,
        share_token_hash: hashContractToken(token),
        share_token_expires_at: expiresAt,
        shared_at: new Date(),
        document_template_id: loaded.template.id,
        document_template_version_id: loaded.activeVersion.id,
        document_template_key: loaded.template.template_key,
        requires_signature_snapshot: loaded.template.requires_signature !== false,
        document_variables_snapshot: jsonb(context, {}),
        document_render_summary: jsonb(rendered.renderSummary, {}),
      }).returning('*');
      await insertContractEvent(trx, row.id, customer.id, req, {
        templateKey: loaded.template.template_key,
        templateVersionId: loaded.activeVersion.id,
        unresolvedVariables: rendered.unresolvedVariables,
      });
      await trx('customer_contract_events').insert({
        contract_id: row.id,
        customer_id: customer.id,
        event_type: 'share_link_created',
        actor_type: 'admin',
        actor_id: req.technicianId || null,
        ip: req.ip || null,
        user_agent: req.get('user-agent') || null,
        metadata: jsonb({ expiresAt: expiresAt.toISOString() }, {}),
      });
      return row;
    });

    const hydrated = await contractQuery().where('cc.id', contract.id).first();
    const signingUrl = publicContractUrl(token);
    res.status(201).json({
      contract: serializeContract(hydrated, { signingUrl }),
      signingUrl,
      rendered,
    });
  } catch (err) { next(err); }
});

function cleanRecipientName(value) {
  const str = String(value || '').trim();
  return str || null;
}

module.exports = router;
