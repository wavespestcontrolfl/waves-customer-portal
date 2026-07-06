const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { formatSmsTemplateVars } = require('../utils/sms-time-format');
const { TEMPLATES: CLEAN_DEFAULT_SMS_TEMPLATES } = require('../models/migrations/20260514000002_tighten_sms_template_copy');
const SmsTemplateVariants = require('../services/sms-template-variants');
const { auditNotificationTemplateIssue } = require('../services/audit-log');

router.use(adminAuthenticate, requireTechOrAdmin);

const PROTECTED_SMS_TEMPLATE_KEYS = new Set(CLEAN_DEFAULT_SMS_TEMPLATES.map((template) => template.template_key));

function canDeleteSmsTemplate(template) {
  return !!template
    && template.category === 'custom'
    && !PROTECTED_SMS_TEMPLATE_KEYS.has(template.template_key);
}

function decorateTemplate(template) {
  return template ? { ...template, can_delete: canDeleteSmsTemplate(template) } : template;
}

function parseTemplateVariables(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function extractTemplatePlaceholders(body) {
  const placeholders = new Set();
  const re = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
  let match;
  while ((match = re.exec(String(body || '')))) {
    placeholders.add(match[1]);
  }
  return [...placeholders];
}

function validateTemplateBody(body, variables) {
  const allowed = new Set(parseTemplateVariables(variables));
  const unknown = extractTemplatePlaceholders(body).filter((key) => !allowed.has(key));
  if (!unknown.length) return null;
  return {
    error: 'Template body contains unknown placeholders',
    unknown_placeholders: unknown,
    allowed_placeholders: [...allowed],
  };
}

function auditSmsTemplateIssue(templateKey, eventType, reason, details = {}) {
  auditNotificationTemplateIssue({
    channel: 'sms',
    template_key: templateKey,
    event_type: eventType,
    workflow: details.workflow || null,
    entity_type: details.entity_type || null,
    entity_id: details.entity_id || null,
    reason,
    unresolved_placeholders: details.unresolved_placeholders || null,
  }).catch(() => {});
}

// Auto-create table if missing + seed any new default templates that don't exist yet
let _seededThisProcess = false;
async function ensureTable() {
  if (!(await db.schema.hasTable('sms_templates'))) {
    await db.schema.createTable('sms_templates', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('template_key', 80).unique().notNullable();
      t.string('name', 200).notNullable();
      t.string('category', 30).notNullable();
      t.text('body').notNullable();
      t.text('description');
      t.jsonb('variables');
      t.string('trigger_event_key', 120).nullable();
      t.boolean('is_active').defaultTo(true);
      t.boolean('is_internal').defaultTo(false);
      t.integer('sort_order').defaultTo(100);
      t.timestamps(true, true);
      t.index(['trigger_event_key']);
    });
  }
  if (!(await db.schema.hasColumn('sms_templates', 'trigger_event_key'))) {
    await db.schema.alterTable('sms_templates', t => {
      t.string('trigger_event_key', 120).nullable();
      t.index(['trigger_event_key']);
    });
  }
  if (_seededThisProcess) return;
  _seededThisProcess = true;
  // Upsert default templates — onConflict.ignore means existing rows are untouched,
  // new template_keys (like newly-added seeds) get inserted on deploy.
  const templates = CLEAN_DEFAULT_SMS_TEMPLATES.map(template => ({
    ...template,
    variables: JSON.stringify(template.variables),
  }));
  for (const t of templates) {
    try { await db('sms_templates').insert(t).onConflict('template_key').ignore(); }
    catch (_) { /* best-effort */ }
  }
}

// GET / — list all templates
router.get('/', async (req, res, next) => {
  try {
    await ensureTable();
    const { category } = req.query;
    let query = db('sms_templates').orderBy('category').orderBy('sort_order');
    if (category) query = query.where({ category });
    const templates = await query;
    res.json({ templates: templates.map(decorateTemplate) });
  } catch (err) { next(err); }
});

// GET /issues — recent SMS template render issues from audit_log.
router.get('/issues', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    if (!(await db.schema.hasTable('audit_log'))) return res.json({ issues: [] });
    const rows = await db('audit_log')
      .where({ action: 'notification_template.sms.render_issue' })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('id', 'metadata', 'created_at');
    res.json({ issues: rows });
  } catch (err) { next(err); }
});

// GET /:id — single template
router.get('/:id', async (req, res, next) => {
  try {
    const template = await db('sms_templates').where({ id: req.params.id }).first();
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(decorateTemplate(template));
  } catch (err) { next(err); }
});

// PUT /:id — update template body
router.put('/:id', async (req, res, next) => {
  try {
    const { body, name, is_active, trigger_event_key } = req.body;
    const updates = { updated_at: new Date() };
    let existing = null;
    if (body !== undefined) {
      existing = await db('sms_templates').where({ id: req.params.id }).first();
      if (!existing) return res.status(404).json({ error: 'Template not found' });
      const validation = validateTemplateBody(body, existing.variables);
      if (validation) return res.status(400).json(validation);
      updates.body = body;
    }
    if (name !== undefined) updates.name = name;
    if (is_active !== undefined) updates.is_active = is_active;
    if (trigger_event_key !== undefined) {
      updates.trigger_event_key = trigger_event_key ? String(trigger_event_key).trim() || null : null;
    }
    await db('sms_templates').where({ id: req.params.id }).update(updates);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST / — create new template
router.post('/', async (req, res, next) => {
  try {
    const { template_key, name, category, body, description, variables, is_internal } = req.body;
    if (!template_key || !name || !body) return res.status(400).json({ error: 'template_key, name, and body required' });
    const validation = validateTemplateBody(body, variables || []);
    if (validation) return res.status(400).json(validation);
    const [template] = await db('sms_templates').insert({
      template_key, name, category: category || 'custom', body,
      description, variables: variables ? JSON.stringify(variables) : null,
      is_internal: is_internal || false,
    }).returning('*');
    res.status(201).json(decorateTemplate(template));
  } catch (err) { next(err); }
});

// DELETE /:id — delete template
router.delete('/:id', async (req, res, next) => {
  try {
    const template = await db('sms_templates').where({ id: req.params.id }).first();
    if (!template) return res.status(404).json({ error: 'Template not found' });
    if (!canDeleteSmsTemplate(template)) {
      return res.status(409).json({ error: 'template is protected from hard delete' });
    }
    await db('sms_templates').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /preview — preview a template with sample data
router.post('/preview', async (req, res) => {
  try {
    const { templateId, sampleData } = req.body;
    const template = await db('sms_templates').where({ id: templateId }).first();
    if (!template) return res.status(404).json({ error: 'Template not found' });
    let preview = template.body;
    for (const [key, val] of Object.entries(formatSmsTemplateVars(sampleData || {}))) {
      preview = preview.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
    }
    res.json({ preview, originalLength: template.body.length, previewLength: preview.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /:templateKey/variants — lightweight SMS creative variants for lifecycle flows.
router.get('/:templateKey/variants', async (req, res, next) => {
  try {
    const variants = await db('sms_template_variants')
      .where({ template_key: req.params.templateKey })
      .orderBy('created_at', 'asc');
    res.json({ variants });
  } catch (err) { next(err); }
});

// POST /:templateKey/variants
router.post('/:templateKey/variants', async (req, res, next) => {
  try {
    const { variantKey, variant_key, name, body, weight, status, isControl, is_control, metadata } = req.body || {};
    const cleanVariantKey = String(variantKey || variant_key || '').trim();
    if (!cleanVariantKey || !body) return res.status(400).json({ error: 'variantKey and body required' });
    const template = await db('sms_templates').where({ template_key: req.params.templateKey }).first();
    if (!template) return res.status(404).json({ error: 'Template not found' });
    const validation = validateTemplateBody(body, template.variables);
    if (validation) return res.status(400).json(validation);
    const [variant] = await db('sms_template_variants')
      .insert({
        template_key: req.params.templateKey,
        variant_key: cleanVariantKey,
        name: name || cleanVariantKey,
        body,
        weight: Number.isFinite(Number(weight)) ? Number(weight) : 1,
        status: status || 'active',
        is_control: !!(isControl ?? is_control),
        metadata: metadata || {},
      })
      .onConflict(['template_key', 'variant_key'])
      .merge({
        name: name || cleanVariantKey,
        body,
        weight: Number.isFinite(Number(weight)) ? Number(weight) : 1,
        status: status || 'active',
        is_control: !!(isControl ?? is_control),
        metadata: metadata || {},
        updated_at: new Date(),
      })
      .returning('*');
    res.status(201).json({ variant });
  } catch (err) { next(err); }
});

// PUT /:templateKey/variants/:variantKey
router.put('/:templateKey/variants/:variantKey', async (req, res, next) => {
  try {
    const updates = { updated_at: new Date() };
    if (req.body.body !== undefined) {
      const template = await db('sms_templates').where({ template_key: req.params.templateKey }).first();
      if (!template) return res.status(404).json({ error: 'Template not found' });
      const validation = validateTemplateBody(req.body.body, template.variables);
      if (validation) return res.status(400).json(validation);
    }
    for (const [inputKey, dbKey] of [
      ['name', 'name'],
      ['body', 'body'],
      ['weight', 'weight'],
      ['status', 'status'],
      ['metadata', 'metadata'],
    ]) {
      if (req.body[inputKey] !== undefined) updates[dbKey] = req.body[inputKey];
    }
    if (req.body.isControl !== undefined) updates.is_control = !!req.body.isControl;
    if (req.body.is_control !== undefined) updates.is_control = !!req.body.is_control;
    const [variant] = await db('sms_template_variants')
      .where({ template_key: req.params.templateKey, variant_key: req.params.variantKey })
      .update(updates)
      .returning('*');
    if (!variant) return res.status(404).json({ error: 'variant not found' });
    res.json({ variant });
  } catch (err) { next(err); }
});

// DELETE /:templateKey/variants/:variantKey
router.delete('/:templateKey/variants/:variantKey', async (req, res, next) => {
  try {
    await db('sms_template_variants')
      .where({ template_key: req.params.templateKey, variant_key: req.params.variantKey })
      .del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Map messageType values to template_key values
const MSG_TYPE_TO_TEMPLATE = {
  confirmation: 'appointment_confirmation',
  booking_confirmation: 'appointment_confirmation',
  appointment_reminder: 'reminder_24h',
  appointment_series_cancelled: 'appointment_series_cancelled',
  en_route: 'tech_en_route',
  service_complete: 'service_complete',
  service_complete_prepaid: 'service_complete_prepaid',
  service_complete_with_invoice: 'service_complete_with_invoice',
  missed_call_followup: 'missed_call',
  invoice: 'invoice_sent',
  receipt: 'invoice_receipt',
  invoice_receipt: 'invoice_receipt',
  payment_expiry: 'payment_method_expiry',
  review_request: 'review_request',
  review_followup: 'review_request_followup',
  referral_nudge: 'referral_nudge',
  referral_invite: 'referral_nudge',
  renewal: 'renewal_reminder',
  autopay_pre_charge: 'autopay_pre_charge',
  payment_method_expiry: 'payment_method_expiry',
  lead_response: 'lead_auto_reply_biz',
  auto_reply: 'lead_auto_reply_biz',
  estimate_sent: 'estimate_sent',
  estimate_accepted_onetime: 'estimate_accepted_onetime',
  estimate_followup: 'estimate_followup_unviewed',
  reactivation: 'seasonal_reactivation',
  // Kill-switch mappings — the sending WORKFLOWS behind these rows are
  // retired, but the message types are still emitted by live paths
  // (campaign upsell drafts, customer-intel/retention-agent outreach) and
  // isTemplateActive treats a MISSING key as active. The rows stay, disabled,
  // as the operator pause switch (see 20260706000010_sms_template_cleanup).
  retention: 'health_retention_offer',
  retention_outreach: 'health_retention_offer',
  upsell: 'waveguard_upsell',
};

// ── Template helper for services — check if a template is enabled before sending ──
router.isTemplateActive = async function(messageType) {
  try {
    if (!(await db.schema.hasTable('sms_templates'))) return true;
    const templateKey = MSG_TYPE_TO_TEMPLATE[messageType] || messageType;
    const t = await db('sms_templates').where({ template_key: templateKey }).first();
    if (!t) return true; // template not in DB = active by default
    return t.is_active !== false;
  } catch { return true; }
};

// Get template body by key (returns null if disabled)
router.getTemplate = async function(templateKey, vars = {}, context = {}) {
  try {
    if (!(await db.schema.hasTable('sms_templates'))) {
      auditSmsTemplateIssue(templateKey, 'missing_table', 'sms_templates table missing', context);
      return null;
    }
    const t = await db('sms_templates').where({ template_key: templateKey }).first();
    if (!t) {
      auditSmsTemplateIssue(templateKey, 'missing_template', 'template row missing', context);
      return null;
    }
    if (t.is_active === false) {
      // An inactive template is a deliberate admin toggle, not a defect —
      // skip the send silently instead of flooding the template-issues feed
      // (owner directive 2026-07-06). missing/unresolved/render errors below
      // still audit because those ARE defects.
      return null;
    }
    const variant = await SmsTemplateVariants.selectVariant(templateKey).catch(() => null);
    let body = variant?.body || t.body;
    for (const [key, val] of Object.entries(formatSmsTemplateVars(vars))) {
      body = body.replace(new RegExp(`\\{${key}\\}`, 'g'), val == null ? '' : String(val));
    }
    const unresolved = extractTemplatePlaceholders(body);
    if (unresolved.length) {
      auditSmsTemplateIssue(templateKey, 'unresolved_placeholders', 'template rendered with unresolved placeholders', {
        ...context,
        unresolved_placeholders: unresolved,
      });
      return null;
    }
    return body;
  } catch (err) {
    auditSmsTemplateIssue(templateKey, 'render_error', err.message || 'template render failed', context);
    return null;
  }
};

module.exports = router;
