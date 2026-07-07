const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const sendgrid = require('../services/sendgrid-mail');
const EmailTemplates = require('../services/email-template-library');
const AutomationExecutor = require('../services/email-template-automation-executor');
const { isEnabled } = require('../config/feature-gates');
const { publicPortalUrl } = require('../utils/portal-url');
const { assertInternalEmailRecipient } = require('../utils/internal-email-recipients');

router.use(adminAuthenticate, requireAdmin);

const MODES = new Set(['service', 'marketing']);
const LEGAL_CLASSIFICATIONS = new Set(['transactional_relationship', 'commercial_marketing', 'mixed']);
const AUDIENCES = new Set(['customer', 'lead', 'subscriber', 'internal_user']);
const PRIORITIES = new Set(['critical', 'normal', 'bulk']);
const SENSITIVITIES = new Set(['normal', 'financial', 'account', 'health_safety', 'property_sensitive']);
const SUPPRESSION_TYPES = new Set(['unsubscribe', 'bounce', 'spam_complaint', 'manual', 'do_not_email']);
const AUTOMATION_STATUSES = new Set(['draft', 'active', 'paused', 'archived']);
const TEMPLATE_STATUSES = new Set(['draft', 'active', 'paused', 'archived']);
const HARD_DELETE_AUTOMATION_STATUSES = new Set(['draft', 'archived']);
const HARD_DELETE_TEMPLATE_STATUSES = new Set(['draft', 'archived']);
const OPEN_AUTOMATION_RUN_STATUSES = ['queued', 'scheduled', 'retry_scheduled'];
const STREAMS = new Set([
  'transactional_required',
  'service_operational',
  'marketing_newsletter',
  'marketing_referral',
  'marketing_nurture',
  'internal',
]);
const PROTECTED_EMAIL_TEMPLATE_KEYS = new Set([
  'account.request_received',
  'account.request_updated',
  'account.updated',
  'billing_late_payment_14_day',
  'billing_late_payment_30_day',
  'billing_late_payment_60_day',
  'billing_late_payment_7_day',
  'billing_late_payment_90_day',
  'estimate.delivery',
  'estimate.expiring_notice',
  'estimate.extension_notice',
  'estimate.followup_final',
  'estimate.unviewed_followup',
  'estimate.viewed_followup',
  'invoice.receipt',
  'invoice.followup_14_day',
  'invoice.followup_30_day',
  'invoice.followup_3_day',
  'invoice.followup_7_day',
  'invoice.sent',
  'marketing.newsletter_issue',
  'membership.canceled',
  'membership.paused',
  'membership.reactivated',
  'membership.renewal_reminder',
  'membership.started',
  'membership.updated',
  'new_lead',
  'payment.autopay_enabled',
  'payment.ach_processing',
  'payment.failed',
  'payment.method_expiring',
  'payment.method_updated',
  'payment.plan_confirmed',
  'payment.refund_issued',
  'payment.retry_notice',
  'portal.invite',
  'prep.bed_bug',
  'prep.cockroach',
  'prep.flea',
  'prep.interior_pest',
  'prep.lawn',
  'prep.mosquito',
  'prep.rodent',
  'prep.termite',
  'project.report_ready',
  'service.report_ready',
  'welcome.new_recurring',
]);
const PROTECTED_EMAIL_AUTOMATION_KEYS = new Set([
  'estimate.delivery',
  'estimate.expiring_notice',
  'estimate.extension_notice',
  'estimate.unviewed_followup',
  'estimate.viewed_followup',
  'invoice.receipt',
  'invoice.sent',
  'payment.failed',
  'prep.bed_bug',
  'prep.cockroach',
  'prep.flea',
  'project.report_ready',
  'service.report_ready',
  'welcome.new_recurring',
]);

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function cleanString(value, fallback = '') {
  if (value == null) return fallback;
  return String(value).trim();
}

function hasBodyField(body, ...keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(body || {}, key));
}

function bodyField(body, ...keys) {
  const source = body || {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function cleanArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return cleanArray(parsed);
    } catch {
      return value.split(',').map((v) => v.trim()).filter(Boolean);
    }
  }
  return [];
}

function assertOneOf(value, allowed, field, fallback) {
  const v = cleanString(value, fallback);
  if (!allowed.has(v)) throw badRequest(`${field} must be one of: ${[...allowed].join(', ')}`);
  return v;
}

function normalizeTemplateInput(body, existing = {}) {
  const mode = assertOneOf(body.mode ?? existing.mode, MODES, 'mode', existing.mode || 'service');
  const sendStream = assertOneOf(
    body.sendStream ?? body.send_stream ?? existing.send_stream,
    STREAMS,
    'sendStream',
    existing.send_stream || (mode === 'marketing' ? 'marketing_newsletter' : 'service_operational'),
  );
  const suppressionGroupProvided = hasBodyField(body, 'suppressionGroupKey', 'suppression_group_key');
  const suppressionGroupValue = bodyField(body, 'suppressionGroupKey', 'suppression_group_key');
  const suppressionGroupKey = suppressionGroupProvided
    ? (cleanString(suppressionGroupValue, '') || null)
    : (existing.suppression_group_key !== undefined ? existing.suppression_group_key : sendStream);
  return {
    name: cleanString(body.name, existing.name),
    description: body.description !== undefined ? cleanString(body.description, '') : existing.description,
    mode,
    purpose: cleanString(body.purpose, existing.purpose || 'general'),
    legal_classification: assertOneOf(
      body.legalClassification ?? body.legal_classification ?? existing.legal_classification,
      LEGAL_CLASSIFICATIONS,
      'legalClassification',
      mode === 'marketing' ? 'commercial_marketing' : 'transactional_relationship',
    ),
    audience: assertOneOf(body.audience ?? existing.audience, AUDIENCES, 'audience', mode === 'marketing' ? 'subscriber' : 'customer'),
    message_priority: assertOneOf(body.messagePriority ?? body.message_priority ?? existing.message_priority, PRIORITIES, 'messagePriority', 'normal'),
    content_sensitivity: assertOneOf(body.contentSensitivity ?? body.content_sensitivity ?? existing.content_sensitivity, SENSITIVITIES, 'contentSensitivity', 'normal'),
    send_stream: sendStream,
    suppression_group_key: suppressionGroupKey,
    layout_wrapper_id: cleanString(body.layoutWrapperId ?? body.layout_wrapper_id, existing.layout_wrapper_id || (mode === 'marketing' ? 'newsletter_default_v1' : 'service_default_v1')),
    from_name: cleanString(body.fromName ?? body.from_name, existing.from_name || 'Waves Pest Control'),
    from_email: cleanString(body.fromEmail ?? body.from_email, existing.from_email || (mode === 'marketing' ? 'newsletter@wavespestcontrol.com' : 'contact@wavespestcontrol.com')).toLowerCase(),
    reply_to: cleanString(body.replyTo ?? body.reply_to, existing.reply_to || 'contact@wavespestcontrol.com').toLowerCase(),
    default_cta_label: body.defaultCtaLabel !== undefined ? cleanString(body.defaultCtaLabel, '') : existing.default_cta_label,
    default_cta_url_variable: body.defaultCtaUrlVariable !== undefined ? cleanString(body.defaultCtaUrlVariable, '') : existing.default_cta_url_variable,
    allowed_variables: JSON.stringify(cleanArray(body.allowedVariables ?? body.allowed_variables ?? existing.allowed_variables)),
    required_variables: JSON.stringify(cleanArray(body.requiredVariables ?? body.required_variables ?? existing.required_variables)),
    optional_variables: JSON.stringify(cleanArray(body.optionalVariables ?? body.optional_variables ?? existing.optional_variables)),
    status: assertOneOf(body.status ?? existing.status, TEMPLATE_STATUSES, 'status', existing.status || 'draft'),
  };
}

async function loadTemplateByParam(key) {
  return db('email_templates').where({ template_key: key }).first();
}

function templateHardDeleteBlocker(template) {
  if (!template) return null;
  if (PROTECTED_EMAIL_TEMPLATE_KEYS.has(template.template_key)) {
    return 'template is protected from hard delete';
  }
  const status = cleanString(template.status, 'draft').toLowerCase();
  if (!HARD_DELETE_TEMPLATE_STATUSES.has(status)) {
    return 'template must be draft or archived before hard delete';
  }
  return null;
}

function canHardDeleteTemplate(template) {
  return !templateHardDeleteBlocker(template);
}

function automationHardDeleteBlocker(automation) {
  if (!automation) return null;
  if (PROTECTED_EMAIL_AUTOMATION_KEYS.has(automation.automation_key)) {
    return 'automation is protected from hard delete';
  }
  const status = cleanString(automation.status, 'draft').toLowerCase();
  if (!HARD_DELETE_AUTOMATION_STATUSES.has(status)) {
    return 'automation must be draft or archived before hard delete';
  }
  return null;
}

function canHardDeleteAutomation(automation) {
  return !automationHardDeleteBlocker(automation);
}

async function loadFixtureById(id) {
  return db('email_template_fixtures as f')
    .join('email_templates as t', 't.id', 'f.template_id')
    .where('f.id', id)
    .select('f.*', 't.template_key', 't.name as template_name')
    .first();
}

function cleanEmail(value) {
  const email = cleanString(value).toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('valid email is required');
  return email;
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function requireJsonObject(value, field = 'payload') {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to the standard validation error.
    }
  }
  throw badRequest(`${field} must be a JSON object`);
}

function automationJsonInput(body, camelKey, snakeKey, existingValue, fallback, field) {
  if (hasBodyField(body, camelKey, snakeKey)) {
    return requireJsonObject(bodyField(body, camelKey, snakeKey), field);
  }
  return parseJsonObject(existingValue, fallback);
}

function percent(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((Number(numerator || 0) / Number(denominator || 1)) * 1000) / 10;
}

function cleanNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeAutomationInput(body, existing = {}) {
  const suppressionGroupProvided = hasBodyField(body, 'suppressionGroupKey', 'suppression_group_key');
  const suppressionGroupValue = bodyField(body, 'suppressionGroupKey', 'suppression_group_key');
  const suppressionGroupKey = suppressionGroupProvided
    ? (cleanString(suppressionGroupValue, '') || null)
    : (existing.suppression_group_key || null);
  return {
    name: cleanString(body.name, existing.name),
    description: body.description !== undefined ? cleanString(body.description, '') : existing.description,
    trigger_event_key: cleanString(body.triggerEventKey ?? body.trigger_event_key, existing.trigger_event_key),
    trigger_description: body.triggerDescription !== undefined || body.trigger_description !== undefined
      ? cleanString(body.triggerDescription ?? body.trigger_description, '')
      : existing.trigger_description,
    template_key: cleanString(body.templateKey ?? body.template_key, existing.template_key),
    delay_minutes: Math.max(0, Math.round(cleanNumber(body.delayMinutes ?? body.delay_minutes, existing.delay_minutes || 0))),
    audience: assertOneOf(body.audience ?? existing.audience, AUDIENCES, 'audience', existing.audience || 'customer'),
    status: assertOneOf(body.status ?? existing.status, AUTOMATION_STATUSES, 'status', existing.status || 'draft'),
    suppression_group_key: suppressionGroupKey,
    legal_classification: assertOneOf(
      body.legalClassification ?? body.legal_classification ?? existing.legal_classification,
      LEGAL_CLASSIFICATIONS,
      'legalClassification',
      existing.legal_classification || 'transactional_relationship',
    ),
    frequency_cap: cleanString(body.frequencyCap ?? body.frequency_cap, existing.frequency_cap || 'once_per_entity'),
    idempotency_key_template: cleanString(body.idempotencyKeyTemplate ?? body.idempotency_key_template, existing.idempotency_key_template || ''),
    conditions: JSON.stringify(automationJsonInput(body, 'conditions', 'conditions', existing.conditions, {}, 'conditions')),
    exit_conditions: JSON.stringify(automationJsonInput(body, 'exitConditions', 'exit_conditions', existing.exit_conditions, {}, 'exitConditions')),
    retry_policy: JSON.stringify(automationJsonInput(body, 'retryPolicy', 'retry_policy', existing.retry_policy, { max_attempts: 2, backoff_minutes: [15, 60] }, 'retryPolicy')),
    quiet_hours: JSON.stringify(automationJsonInput(body, 'quietHours', 'quiet_hours', existing.quiet_hours, { enabled: false }, 'quietHours')),
    timezone: cleanString(body.timezone, existing.timezone || 'America/New_York'),
    owner: cleanString(body.owner, existing.owner || 'operations'),
    dry_run_notes: body.dryRunNotes !== undefined || body.dry_run_notes !== undefined
      ? cleanString(body.dryRunNotes ?? body.dry_run_notes, '')
      : existing.dry_run_notes,
  };
}

function asJson(value, fallback = {}) {
  return parseJsonObject(value, fallback);
}

async function tableInfo(table) {
  const exists = await db.schema.hasTable(table);
  if (!exists) return null;
  return db(table).columnInfo();
}

async function countRows(query) {
  const row = await query.count('* as count').first();
  return Number(row?.count || 0);
}

async function dryRunAutomation(row) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const templateKey = row.template_key;
  const result = {
    window_days: 30,
    since,
    candidate_count: 0,
    source: 'email_messages',
    notes: row.dry_run_notes || 'Uses recent send history when no source table can be evaluated safely.',
  };

  const countsFromHistory = async () => {
    result.source = 'email_messages';
    result.candidate_count = await countRows(db('email_messages').where({ template_key: templateKey }).where('created_at', '>=', since));
    return result;
  };

  if (templateKey.startsWith('estimate.')) {
    const cols = await tableInfo('estimates');
    if (!cols) return countsFromHistory();
    let q = db('estimates');
    if (cols.created_at) q = q.where('created_at', '>=', since);
    if (cols.status) q = q.whereNotIn('status', ['accepted', 'expired', 'archived', 'declined', 'cancelled']);
    if (templateKey === 'estimate.unviewed_followup' && cols.viewed_at) q = q.whereNull('viewed_at');
    if (templateKey === 'estimate.viewed_followup' && cols.viewed_at) q = q.whereNotNull('viewed_at');
    if (templateKey === 'estimate.expiring_notice' && cols.expires_at) {
      q = q.where('expires_at', '<=', new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)).where('expires_at', '>=', new Date());
    }
    if (templateKey === 'estimate.extension_notice' && cols.renewal_count) q = q.where('renewal_count', '>', 0);
    result.source = 'estimates';
    result.candidate_count = await countRows(q);
    return result;
  }

  if (templateKey.startsWith('invoice.')) {
    const cols = await tableInfo('invoices');
    if (!cols) return countsFromHistory();
    let q = db('invoices');
    if (cols.created_at) q = q.where('created_at', '>=', since);
    if (cols.status && templateKey === 'invoice.sent') q = q.whereIn('status', ['open', 'sent', 'unpaid']);
    if (cols.status && templateKey === 'invoice.receipt') q = q.where('status', 'paid');
    result.source = 'invoices';
    result.candidate_count = await countRows(q);
    return result;
  }

  if (templateKey === 'payment.failed') {
    const cols = await tableInfo('payments');
    if (!cols) return countsFromHistory();
    let q = db('payments');
    if (cols.created_at) q = q.where('created_at', '>=', since);
    if (cols.status) q = q.where('status', 'failed');
    result.source = 'payments';
    result.candidate_count = await countRows(q);
    return result;
  }

  if (templateKey === 'service.report_ready') {
    const cols = await tableInfo('service_records');
    if (!cols) return countsFromHistory();
    let q = db('service_records');
    if (cols.created_at) q = q.where('created_at', '>=', since);
    if (cols.status) q = q.where('status', 'completed');
    result.source = 'service_records';
    result.candidate_count = await countRows(q);
    return result;
  }

  if (templateKey === 'prep.bed_bug' || templateKey === 'prep.cockroach' || templateKey === 'prep.flea') {
    const cols = await tableInfo('scheduled_services');
    if (!cols) return countsFromHistory();
    let q = db('scheduled_services');
    if (cols.scheduled_date) q = q.where('scheduled_date', '>=', new Date());
    if (cols.status) q = q.whereNotIn('status', ['cancelled', 'completed']);
    if (cols.service_type) {
      q = templateKey === 'prep.bed_bug'
        ? q.where('service_type', 'ilike', '%bed bug%')
        : templateKey === 'prep.flea'
          ? q.where('service_type', 'ilike', '%flea%')
          : q.where((builder) => builder.where('service_type', 'ilike', '%cockroach%').orWhere('service_type', 'ilike', '%roach%'));
    }
    result.source = 'scheduled_services';
    result.candidate_count = await countRows(q);
    return result;
  }

  if (templateKey === 'welcome.new_recurring') {
    const cols = await tableInfo('customers');
    if (!cols) return countsFromHistory();
    let q = db('customers');
    if (cols.created_at) q = q.where('created_at', '>=', since);
    if (cols.active) q = q.where({ active: true });
    result.source = 'customers';
    result.candidate_count = await countRows(q);
    return result;
  }

  return countsFromHistory();
}

// GET /api/admin/email-templates
router.get('/', async (req, res, next) => {
  try {
    const { mode, purpose, status, q } = req.query;
    let query = db('email_templates').orderBy('mode').orderBy('purpose').orderBy('name');
    if (mode) query = query.where({ mode });
    if (purpose) query = query.where({ purpose });
    if (status) query = query.where({ status });
    if (q) {
      query = query.where((builder) => {
        builder.where('name', 'ilike', `%${q}%`)
          .orWhere('template_key', 'ilike', `%${q}%`)
          .orWhere('description', 'ilike', `%${q}%`);
      });
    }
    const templates = await query;
    const versionCounts = await db('email_template_versions')
      .select('template_id')
      .count('* as count')
      .groupBy('template_id');
    const draftCounts = await db('email_template_versions')
      .select('template_id')
      .where({ status: 'draft' })
      .count('* as count')
      .groupBy('template_id');
    const automationCounts = await db('email_template_automations')
      .select('template_key')
      .count('* as count')
      .groupBy('template_key');
    const countMap = Object.fromEntries(versionCounts.map((r) => [r.template_id, Number(r.count)]));
    const draftMap = Object.fromEntries(draftCounts.map((r) => [r.template_id, Number(r.count)]));
    const automationMap = Object.fromEntries(automationCounts.map((r) => [r.template_key, Number(r.count)]));
    res.json({
      templates: templates.map((t) => ({
        ...t,
        version_count: countMap[t.id] || 0,
        draft_count: draftMap[t.id] || 0,
        automation_count: automationMap[t.template_key] || 0,
        can_delete: canHardDeleteTemplate(t) && !automationMap[t.template_key],
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/email-templates/preference-groups
router.get('/preference-groups', async (req, res, next) => {
  try {
    const groups = await db('email_preference_groups').orderBy('sort_order').orderBy('name');
    res.json({ groups });
  } catch (err) { next(err); }
});

// GET /api/admin/email-templates/send-history
router.get('/send-history', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await db('email_messages')
      .orderBy('created_at', 'desc')
      .limit(limit);
    res.json({ messages: rows });
  } catch (err) { next(err); }
});

// GET /api/admin/email-templates/issues
router.get('/issues', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const rows = await db('audit_log')
      .where({ action: 'notification_template.email.render_issue' })
      .orderBy('created_at', 'desc')
      .limit(limit);
    const issues = rows.map((row) => {
      const metadata = EmailTemplates.asObject(row.metadata);
      return {
        id: row.id,
        created_at: row.created_at,
        template_key: metadata.template_key || null,
        event_type: metadata.event_type || null,
        workflow: metadata.workflow || null,
        entity_type: metadata.entity_type || null,
        entity_id: metadata.entity_id || null,
        reason: metadata.reason || null,
        unresolved_placeholders: metadata.unresolved_placeholders || null,
      };
    });
    res.json({ issues });
  } catch (err) { next(err); }
});

// GET /api/admin/email-templates/suppressions
router.get('/suppressions', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const status = cleanString(req.query.status, 'active');
    const groupKey = cleanString(req.query.groupKey || req.query.group_key, '');
    const email = cleanString(req.query.email, '').toLowerCase();
    let query = db('email_suppressions as s')
      .leftJoin('email_preference_groups as g', 'g.key', 's.group_key')
      .select('s.*', 'g.name as group_name', 'g.send_stream as group_send_stream')
      .orderBy('s.suppressed_at', 'desc')
      .limit(limit);
    if (status && status !== 'all') query = query.where('s.status', status);
    if (groupKey) query = groupKey === '__global'
      ? query.whereNull('s.group_key')
      : query.where('s.group_key', groupKey);
    if (email) query = query.whereRaw('LOWER(s.email) LIKE ?', [`%${email}%`]);

    const suppressions = await query;

    // Enrich with the matching customer record and blocked-send tallies so the
    // panel is workable as a call list (who is this, how do I reach them, how
    // much mail have they missed). Suppressions are keyed by email string only.
    const emails = [...new Set(
      suppressions.map((s) => String(s.email || '').trim().toLowerCase()).filter(Boolean),
    )];
    const customersByEmail = new Map();
    const blockedByEmail = new Map();
    if (emails.length) {
      // Any of the four sendable columns can hold the suppressed address
      // (mirrors CUSTOMER_EMAIL_FIELDS in email-bounce-recovery.js); a
      // primary-email match wins over a service-contact match.
      const emailFields = ['email', 'service_contact_email', 'service_contact2_email', 'service_contact3_email'];
      const customerRows = await db('customers')
        .select('id', 'first_name', 'last_name', 'phone', 'pipeline_stage', ...emailFields)
        .whereNull('deleted_at')
        .where(function matchAnyEmailField() {
          for (const field of emailFields) {
            this.orWhereIn(db.raw(`LOWER(${field})`), emails);
          }
        });
      for (const row of customerRows) {
        for (const field of emailFields) {
          const lc = String(row[field] || '').trim().toLowerCase();
          if (!lc || !emails.includes(lc)) continue;
          const existing = customersByEmail.get(lc);
          if (existing && existing.matched_field === 'email') continue;
          if (existing && field !== 'email') continue;
          customersByEmail.set(lc, {
            id: row.id,
            first_name: row.first_name,
            last_name: row.last_name,
            phone: row.phone,
            pipeline_stage: row.pipeline_stage,
            matched_field: field,
          });
        }
      }
      // Invoice/payment sends can also target notification_prefs.billing_email
      // (getBillingContact), and bounce recovery treats it as sendable — so a
      // billing-address bounce has a real customer behind it even when no
      // customers column matches. Lowest precedence: only fills emails the
      // customers pass left unmatched.
      const unmatchedEmails = emails.filter((e) => !customersByEmail.has(e));
      if (unmatchedEmails.length) {
        const billingRows = await db('notification_prefs as np')
          .join('customers as c', 'c.id', 'np.customer_id')
          .select(
            'c.id', 'c.first_name', 'c.last_name', 'c.phone', 'c.pipeline_stage',
            db.raw('LOWER(np.billing_email) as billing_email_lc'),
          )
          .whereNull('c.deleted_at')
          .whereIn(db.raw('LOWER(np.billing_email)'), unmatchedEmails);
        for (const row of billingRows) {
          if (customersByEmail.has(row.billing_email_lc)) continue;
          customersByEmail.set(row.billing_email_lc, {
            id: row.id,
            first_name: row.first_name,
            last_name: row.last_name,
            phone: row.phone,
            pipeline_stage: row.pipeline_stage,
            matched_field: 'billing_email',
          });
        }
      }
      const blockedRows = await db('email_messages')
        .select(db.raw('LOWER(recipient_email_snapshot) as email_lc'))
        .where({ status: 'blocked' })
        .whereIn(db.raw('LOWER(recipient_email_snapshot)'), emails)
        .count('* as blocked_count')
        .max('created_at as last_blocked_at')
        .groupBy(db.raw('LOWER(recipient_email_snapshot)'));
      for (const row of blockedRows) {
        blockedByEmail.set(row.email_lc, {
          blocked_count: Number(row.blocked_count || 0),
          last_blocked_at: row.last_blocked_at,
        });
      }
    }
    const enriched = suppressions.map((s) => {
      const lc = String(s.email || '').trim().toLowerCase();
      const blocked = blockedByEmail.get(lc);
      return {
        ...s,
        customer: customersByEmail.get(lc) || null,
        blocked_count: blocked ? blocked.blocked_count : 0,
        last_blocked_at: blocked ? blocked.last_blocked_at : null,
      };
    });

    const statsRows = await db('email_suppressions')
      .select('group_key', 'suppression_type')
      .where({ status: 'active' })
      .count('* as count')
      .groupBy('group_key', 'suppression_type');
    res.json({
      suppressions: enriched,
      stats: statsRows.map((r) => ({ ...r, count: Number(r.count || 0) })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/email-templates/suppressions
router.post('/suppressions', async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    const groupKey = cleanString(req.body.groupKey ?? req.body.group_key, '') || null;
    const suppressionType = assertOneOf(
      req.body.suppressionType ?? req.body.suppression_type,
      SUPPRESSION_TYPES,
      'suppressionType',
      'manual',
    );
    if (groupKey) {
      const group = await db('email_preference_groups').where({ key: groupKey }).first();
      if (!group) return res.status(400).json({ error: 'unknown preference group' });
    }
    const metadata = {
      ...parseJsonObject(req.body.metadata),
      reason: cleanString(req.body.reason, ''),
      created_by: req.technicianId || null,
    };

    const existingQuery = db('email_suppressions')
      .whereRaw('LOWER(email) = ?', [email])
      .where({ status: 'active', suppression_type: suppressionType });
    if (groupKey) existingQuery.where({ group_key: groupKey });
    else existingQuery.whereNull('group_key');
    const existing = await existingQuery.first();

    if (existing) {
      const [updated] = await db('email_suppressions').where({ id: existing.id }).update({
        source: cleanString(req.body.source, existing.source || 'admin_manual'),
        metadata: JSON.stringify({ ...parseJsonObject(existing.metadata), ...metadata }),
        updated_at: new Date(),
      }).returning('*');
      return res.json({ suppression: updated, existing: true });
    }

    const [suppression] = await db('email_suppressions').insert({
      email,
      group_key: groupKey,
      suppression_type: suppressionType,
      status: 'active',
      source: cleanString(req.body.source, 'admin_manual'),
      consent_source: cleanString(req.body.consentSource ?? req.body.consent_source, '') || null,
      consent_timestamp: req.body.consentTimestamp || req.body.consent_timestamp || null,
      metadata: JSON.stringify(metadata),
    }).returning('*');
    res.status(201).json({ suppression, existing: false });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/email-templates/suppressions/:id/release
router.post('/suppressions/:id/release', async (req, res, next) => {
  try {
    const existing = await db('email_suppressions').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'suppression not found' });
    const metadata = {
      ...parseJsonObject(existing.metadata),
      release_reason: cleanString(req.body.reason, ''),
      released_by: req.technicianId || null,
    };
    const [suppression] = await db('email_suppressions').where({ id: req.params.id }).update({
      status: 'released',
      released_at: new Date(),
      metadata: JSON.stringify(metadata),
      updated_at: new Date(),
    }).returning('*');
    res.json({ suppression });
  } catch (err) { next(err); }
});

// GET /api/admin/email-templates/deliverability
router.get('/deliverability', async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const statusRows = await db('email_messages')
      .select('status')
      .where('created_at', '>=', since)
      .count('* as count')
      .groupBy('status');
    const statusCounts = Object.fromEntries(statusRows.map((r) => [r.status || 'queued', Number(r.count || 0)]));
    const totalMessages = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
    const blocked = statusCounts.blocked || 0;
    const failed = statusCounts.failed || 0;
    const bounced = statusCounts.bounced || 0;
    const spamReports = statusCounts.spam_report || 0;
    const delivered = statusCounts.delivered || 0;
    const attempted = Math.max(totalMessages - blocked, 0);

    const eventRow = await db('email_message_events').max('created_at as last_email_message_event').first();
    let webhookRow = {};
    try {
      webhookRow = await db('sendgrid_webhook_events').max('created_at as last_provider_event').first();
    } catch {
      webhookRow = {};
    }
    const activeSuppressions = await db('email_suppressions')
      .where({ status: 'active' })
      .count('* as count')
      .first();
    const suppressionRows = await db('email_suppressions')
      .select('group_key')
      .where({ status: 'active' })
      .count('* as count')
      .groupBy('group_key');

    const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'newsletter@wavespestcontrol.com';
    const serviceFromEmail = process.env.SENDGRID_SERVICE_FROM_EMAIL || 'contact@wavespestcontrol.com';
    const portalOrigin = publicPortalUrl();
    res.json({
      provider: {
        name: 'sendgrid',
        configured: sendgrid.isConfigured(),
        from_email: fromEmail,
        service_from_email: serviceFromEmail,
        from_domain: fromEmail.includes('@') ? fromEmail.split('@')[1] : null,
        service_from_domain: serviceFromEmail.includes('@') ? serviceFromEmail.split('@')[1] : null,
        public_portal_url: portalOrigin,
        newsletter_asm_group_id: sendgrid.newsletterGroupId(),
        service_asm_group_id: sendgrid.serviceGroupId(),
        webhook_public_key_configured: !!process.env.SENDGRID_WEBHOOK_PUBLIC_KEY,
      },
      window: { days: 30, since },
      status_counts: statusCounts,
      rates: {
        delivery_rate: percent(delivered, attempted),
        bounce_rate: percent(bounced, attempted),
        complaint_rate: percent(spamReports, attempted),
        failure_rate: percent(failed, attempted),
        blocked_rate: percent(blocked, totalMessages),
      },
      health: {
        total_messages: totalMessages,
        attempted_messages: attempted,
        active_suppressions: Number(activeSuppressions?.count || 0),
        last_email_message_event: eventRow?.last_email_message_event || null,
        last_provider_event: webhookRow?.last_provider_event || null,
      },
      suppressions_by_group: suppressionRows.map((r) => ({
        group_key: r.group_key || null,
        count: Number(r.count || 0),
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/email-templates/automations
router.get('/automations', async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await db('email_template_automations as a')
      .leftJoin('email_templates as t', 't.template_key', 'a.template_key')
      .leftJoin('email_template_versions as v', 'v.id', 't.active_version_id')
      .select(
        'a.*',
        't.name as template_name',
        't.mode as template_mode',
        't.status as template_status',
        't.active_version_id as active_version_id',
        'v.version_number as active_version_number',
      )
      .orderBy('a.status', 'asc')
      .orderBy('a.trigger_event_key', 'asc')
      .orderBy('a.name', 'asc');
    const sendRows = await db('email_messages')
      .select('template_key')
      .where('created_at', '>=', since)
      .count('* as count')
      .groupBy('template_key');
    const sendMap = Object.fromEntries(sendRows.map((r) => [r.template_key, Number(r.count || 0)]));
    res.json({
      automations: rows.map((row) => ({
        ...row,
        conditions: asJson(row.conditions),
        exit_conditions: asJson(row.exit_conditions),
        retry_policy: asJson(row.retry_policy),
        quiet_hours: asJson(row.quiet_hours),
        send_count_30d: sendMap[row.template_key] || 0,
        can_delete: canHardDeleteAutomation(row),
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/email-templates/automations/trigger
router.post('/automations/trigger', async (req, res, next) => {
  try {
    const triggerEventKey = cleanString(req.body.triggerEventKey ?? req.body.trigger_event_key);
    if (!triggerEventKey) return res.status(400).json({ error: 'triggerEventKey is required' });
    if (!isEnabled('emailTemplateAutomations')) {
      return res.status(403).json({ error: 'Email template automations are disabled' });
    }
    const result = await AutomationExecutor.processTrigger({
      triggerEventKey,
      triggerEventId: req.body.triggerEventId ?? req.body.trigger_event_id,
      automationKey: req.body.automationKey ?? req.body.automation_key,
      entityType: req.body.entityType ?? req.body.entity_type,
      entityId: req.body.entityId ?? req.body.entity_id,
      payload: parseJsonObject(req.body.payload),
      recipient: parseJsonObject(req.body.recipient),
      executeImmediately: req.body.executeImmediately !== false && req.body.execute_immediately !== false,
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/email-templates/automations/runs/process-due
router.post('/automations/runs/process-due', async (req, res, next) => {
  try {
    if (!isEnabled('emailTemplateAutomations')) {
      return res.status(403).json({ error: 'Email template automations are disabled' });
    }
    const result = await AutomationExecutor.processDueRuns({ limit: req.body.limit });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/email-templates/automations/:key/runs
router.get('/automations/:key/runs', async (req, res, next) => {
  try {
    const runs = await AutomationExecutor.listRuns({
      automationKey: req.params.key,
      limit: req.query.limit,
    });
    res.json({ runs });
  } catch (err) { next(err); }
});

// GET /api/admin/email-templates/automations/:key
router.get('/automations/:key', async (req, res, next) => {
  try {
    const row = await db('email_template_automations').where({ automation_key: req.params.key }).first();
    if (!row) return res.status(404).json({ error: 'automation not found' });
    res.json({
      automation: {
        ...row,
        conditions: asJson(row.conditions),
        exit_conditions: asJson(row.exit_conditions),
        retry_policy: asJson(row.retry_policy),
        quiet_hours: asJson(row.quiet_hours),
      },
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/email-templates/automations/:key
router.put('/automations/:key', async (req, res, next) => {
  try {
    const existing = await db('email_template_automations').where({ automation_key: req.params.key }).first();
    if (!existing) return res.status(404).json({ error: 'automation not found' });
    const input = normalizeAutomationInput(req.body, existing);
    const template = await db('email_templates').where({ template_key: input.template_key }).first();
    if (!template) return res.status(400).json({ error: 'templateKey must reference an existing email template' });
    if (input.suppression_group_key) {
      const group = await db('email_preference_groups').where({ key: input.suppression_group_key }).first();
      if (!group) return res.status(400).json({ error: 'unknown suppression group' });
    }
    const [automation] = await db('email_template_automations').where({ id: existing.id }).update({
      ...input,
      last_published_by: req.technicianId || null,
      last_published_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
    res.json({ automation });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/admin/email-templates/automations/:key
router.delete('/automations/:key', async (req, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const existing = await trx('email_template_automations')
        .where({ automation_key: req.params.key })
        .first();
      if (!existing) return null;
      const hardDeleteBlocker = automationHardDeleteBlocker(existing);
      if (hardDeleteBlocker) return { error: hardDeleteBlocker };

      const now = new Date();
      const skippedRuns = await trx('email_template_automation_runs')
        .where({ automation_id: existing.id })
        .whereIn('status', OPEN_AUTOMATION_RUN_STATUSES)
        .update({
          status: 'skipped',
          exit_reason: 'automation deleted by admin',
          completed_at: now,
          updated_at: now,
        });
      await trx('email_template_automations').where({ id: existing.id }).del();
      return { skipped_runs: Number(skippedRuns || 0) };
    });
    if (!result) return res.status(404).json({ error: 'automation not found' });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ deleted: true, skipped_runs: result.skipped_runs });
  } catch (err) { next(err); }
});

// POST /api/admin/email-templates/automations/:key/dry-run
router.post('/automations/:key/dry-run', async (req, res, next) => {
  try {
    const row = await db('email_template_automations').where({ automation_key: req.params.key }).first();
    if (!row) return res.status(404).json({ error: 'automation not found' });
    const dryRun = await dryRunAutomation(row);
    res.json({ dryRun });
  } catch (err) { next(err); }
});

// POST /api/admin/email-templates
router.post('/', async (req, res, next) => {
  try {
    const templateKey = cleanString(req.body.templateKey || req.body.template_key).toLowerCase();
    if (!templateKey || !/^[a-z0-9][a-z0-9._-]{2,119}$/.test(templateKey)) {
      return res.status(400).json({ error: 'templateKey must be a stable key like estimate.expiring_notice' });
    }
    const input = normalizeTemplateInput(req.body);
    if (!input.name) return res.status(400).json({ error: 'name is required' });
    const [template] = await db('email_templates').insert({
      ...input,
      template_key: templateKey,
      created_by: req.technicianId || null,
    }).returning('*');
    const [version] = await db('email_template_versions').insert({
      template_id: template.id,
      version_number: 1,
      status: 'draft',
      subject: cleanString(req.body.subject, template.name),
      preview_text: cleanString(req.body.previewText || req.body.preview_text, ''),
      blocks: JSON.stringify(EmailTemplates.normalizeBlocks(req.body.blocks || [
        { type: 'paragraph', content: 'Hi {{first_name}},' },
        { type: 'paragraph', content: 'Add the email body here.' },
      ])),
      created_by: req.technicianId || null,
    }).returning('*');
    res.status(201).json({ template, version });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/email-templates/:key/fixtures
router.post('/:key/fixtures', async (req, res, next) => {
  try {
    const template = await loadTemplateByParam(req.params.key);
    if (!template) return res.status(404).json({ error: 'template not found' });
    const name = cleanString(req.body.name, 'Preview data');
    const payload = requireJsonObject(req.body.payload, 'payload');
    const isDefault = !!req.body.isDefault || !!req.body.is_default;
    const [fixture] = await db.transaction(async (trx) => {
      if (isDefault) {
        await trx('email_template_fixtures').where({ template_id: template.id }).update({ is_default: false, updated_at: new Date() });
      }
      return trx('email_template_fixtures').insert({
        template_id: template.id,
        name,
        payload: JSON.stringify(payload),
        is_default: isDefault,
      }).returning('*');
    });
    res.status(201).json({ fixture });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PUT /api/admin/email-templates/fixtures/:id
router.put('/fixtures/:id', async (req, res, next) => {
  try {
    const existing = await loadFixtureById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'fixture not found' });
    const updates = { updated_at: new Date() };
    if (req.body.name !== undefined) updates.name = cleanString(req.body.name, existing.name || 'Preview data');
    if (req.body.payload !== undefined) updates.payload = JSON.stringify(requireJsonObject(req.body.payload, 'payload'));
    if (req.body.isDefault !== undefined || req.body.is_default !== undefined) {
      updates.is_default = !!(req.body.isDefault ?? req.body.is_default);
    }
    const [fixture] = await db.transaction(async (trx) => {
      if (updates.is_default) {
        await trx('email_template_fixtures').where({ template_id: existing.template_id }).update({ is_default: false, updated_at: new Date() });
      }
      return trx('email_template_fixtures').where({ id: existing.id }).update(updates).returning('*');
    });
    res.json({ fixture });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/email-templates/fixtures/:id/default
router.post('/fixtures/:id/default', async (req, res, next) => {
  try {
    const existing = await loadFixtureById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'fixture not found' });
    const [fixture] = await db.transaction(async (trx) => {
      await trx('email_template_fixtures').where({ template_id: existing.template_id }).update({ is_default: false, updated_at: new Date() });
      return trx('email_template_fixtures').where({ id: existing.id }).update({
        is_default: true,
        updated_at: new Date(),
      }).returning('*');
    });
    res.json({ fixture });
  } catch (err) { next(err); }
});

// DELETE /api/admin/email-templates/fixtures/:id
router.delete('/fixtures/:id', async (req, res, next) => {
  try {
    const existing = await loadFixtureById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'fixture not found' });
    await db.transaction(async (trx) => {
      await trx('email_template_fixtures').where({ id: existing.id }).del();
      if (existing.is_default) {
        const fallback = await trx('email_template_fixtures')
          .where({ template_id: existing.template_id })
          .orderBy('created_at', 'asc')
          .first();
        if (fallback) {
          await trx('email_template_fixtures').where({ id: fallback.id }).update({ is_default: true, updated_at: new Date() });
        }
      }
    });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// GET /api/admin/email-templates/:key
router.get('/:key', async (req, res, next) => {
  try {
    const template = await loadTemplateByParam(req.params.key);
    if (!template) return res.status(404).json({ error: 'template not found' });
    const versions = await db('email_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'desc');
    const fixtures = await db('email_template_fixtures')
      .where({ template_id: template.id })
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'asc');
    res.json({ template, versions, fixtures });
  } catch (err) { next(err); }
});

// PUT /api/admin/email-templates/:key
router.put('/:key', async (req, res, next) => {
  try {
    const template = await loadTemplateByParam(req.params.key);
    if (!template) return res.status(404).json({ error: 'template not found' });
    const input = normalizeTemplateInput(req.body, template);
    await db('email_templates').where({ id: template.id }).update({
      ...input,
      updated_at: new Date(),
    });
    const updated = await db('email_templates').where({ id: template.id }).first();
    res.json({ template: updated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/admin/email-templates/:key
router.delete('/:key', async (req, res, next) => {
  try {
    const template = await loadTemplateByParam(req.params.key);
    if (!template) return res.status(404).json({ error: 'template not found' });
    const hardDeleteBlocker = templateHardDeleteBlocker(template);
    if (hardDeleteBlocker) return res.status(409).json({ error: hardDeleteBlocker });
    const dependents = await db('email_template_automations')
      .where({ template_key: template.template_key })
      .select('automation_key');
    if (dependents.length) {
      return res.status(409).json({
        error: 'template is referenced by automations',
        automations: dependents.map((d) => d.automation_key),
      });
    }
    await db.transaction(async (trx) => {
      await trx('email_templates').where({ id: template.id }).del();
    });
    res.json({ deleted: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/email-templates/:key/versions
router.post('/:key/versions', async (req, res, next) => {
  try {
    const draft = await EmailTemplates.createDraftVersion(req.params.key, req.technicianId);
    res.status(201).json({ version: draft });
  } catch (err) { next(err); }
});

// PUT /api/admin/email-templates/versions/:id
router.put('/versions/:id', async (req, res, next) => {
  try {
    const row = await EmailTemplates.loadVersion(req.params.id);
    if (!row) return res.status(404).json({ error: 'version not found' });
    if (row.status === 'active') return res.status(400).json({ error: 'Create a draft before editing an active version' });
    const updates = { updated_at: new Date() };
    if (req.body.subject !== undefined) updates.subject = cleanString(req.body.subject);
    if (req.body.previewText !== undefined || req.body.preview_text !== undefined) {
      updates.preview_text = cleanString(req.body.previewText ?? req.body.preview_text);
    }
    if (req.body.blocks !== undefined) updates.blocks = JSON.stringify(EmailTemplates.normalizeBlocks(req.body.blocks));
    if (req.body.textBody !== undefined || req.body.text_body !== undefined) {
      updates.text_body = cleanString(req.body.textBody ?? req.body.text_body, '');
    }
    await db('email_template_versions').where({ id: req.params.id }).update(updates);
    const version = await db('email_template_versions').where({ id: req.params.id }).first();
    const validation = EmailTemplates.validationFor(row.template, version);
    res.json({ version, validation });
  } catch (err) { next(err); }
});

// POST /api/admin/email-templates/versions/:id/preview
router.post('/versions/:id/preview', async (req, res) => {
  try {
    const payload = req.body.payload || {};
    const rendered = await EmailTemplates.renderVersion(req.params.id, payload, {
      unsubscribeUrl: sendgrid.unsubscribeUrl('preview-demo-token'),
    });
    res.json(rendered);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/admin/email-templates/versions/:id/test
router.post('/versions/:id/test', async (req, res) => {
  try {
    if (!sendgrid.isConfigured()) return res.status(400).json({ error: 'SendGrid not configured' });
    const to = assertInternalEmailRecipient(
      req.body.toEmail || req.body.email || req.technician?.email || 'contact@wavespestcontrol.com',
      { adminEmail: req.technician?.email },
    );
    const result = await EmailTemplates.sendTemplate({
      versionId: req.params.id,
      to,
      payload: req.body.payload || {},
      test: true,
      unsubscribeUrl: sendgrid.unsubscribeUrl('test-' + req.params.id),
      categories: ['email_template_test'],
    });
    res.json({ success: true, message: result.message });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/admin/email-templates/versions/:id/publish
router.post('/versions/:id/publish', async (req, res) => {
  try {
    const result = await EmailTemplates.publishVersion(req.params.id, req.technicianId);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
