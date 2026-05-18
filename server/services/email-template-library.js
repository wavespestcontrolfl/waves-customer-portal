const db = require('../models/db');
const sendgrid = require('./sendgrid-mail');
const {
  wrapServiceEmail,
  wrapNewsletter,
  ensureLegalTextFooter,
  ctaButton,
} = require('./email-template');

const VARIABLE_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const ASM_UNSUBSCRIBE_URL = '<%asm_group_unsubscribe_raw_url%>';
const DEDUPE_STATUSES = new Set([
  'sent',
  'delivered',
  'opened',
  'clicked',
  'blocked',
  'dropped',
  'bounced',
  'bounce',
  'spam_report',
  'spamreport',
  'unsubscribed',
  'complained',
]);

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textFor(payload, key) {
  const value = payload?.[key];
  if (value == null) return '';
  return String(value);
}

function renderInline(text, payload, { html = true } = {}) {
  const rendered = String(text || '').replace(VARIABLE_RE, (_, key) => textFor(payload, key));
  return html ? escapeHtml(rendered) : rendered;
}

function extractVariables(input, out = new Set()) {
  const text = typeof input === 'string' ? input : JSON.stringify(input || '');
  let match;
  VARIABLE_RE.lastIndex = 0;
  while ((match = VARIABLE_RE.exec(text))) out.add(match[1]);
  return out;
}

function blockVariables(blocks) {
  const set = new Set();
  for (const block of asArray(blocks)) {
    extractVariables(block, set);
    if (block?.url_variable) set.add(block.url_variable);
  }
  return [...set].sort();
}

function validationFor(template, version) {
  const allowed = new Set(asArray(template.allowed_variables));
  const required = new Set(asArray(template.required_variables));
  const referencedSet = new Set();
  extractVariables(version.subject, referencedSet);
  extractVariables(version.preview_text, referencedSet);
  extractVariables(version.text_body, referencedSet);
  for (const v of blockVariables(version.blocks)) referencedSet.add(v);

  const referenced = [...referencedSet].sort();
  const disallowed = referenced.filter((v) => allowed.size && !allowed.has(v));
  const missingRequiredInTemplate = [...required].filter((v) => !referencedSet.has(v));

  return {
    ok: disallowed.length === 0 && missingRequiredInTemplate.length === 0,
    referenced_variables: referenced,
    disallowed_variables: disallowed,
    missing_required_in_template: missingRequiredInTemplate,
  };
}

function requiredPayloadMissing(template, payload) {
  return asArray(template.required_variables).filter((key) => {
    const value = payload?.[key];
    return value == null || String(value).trim() === '';
  });
}

function normalizeBlocks(blocks) {
  return asArray(blocks).map((block) => {
    const type = String(block?.type || 'paragraph').trim();
    if (type === 'details') {
      return {
        type,
        rows: Array.isArray(block.rows)
          ? block.rows.map((r) => ({ label: String(r.label || ''), value: String(r.value || '') }))
          : [],
      };
    }
    if (type === 'cta') {
      return {
        type,
        label: String(block.label || 'Open'),
        url_variable: String(block.url_variable || ''),
        url: block.url ? String(block.url) : '',
      };
    }
    return { type, content: String(block?.content || '') };
  });
}

function renderBlocks(blocks, payload) {
  const htmlParts = [];
  const textParts = [];

  for (const block of normalizeBlocks(blocks)) {
    if (block.type === 'heading') {
      const content = renderInline(block.content, payload);
      if (content) {
        htmlParts.push(`<h2 style="margin:0 0 12px 0;font-family:Inter,Arial,sans-serif;font-size:18px;line-height:1.3;color:#0F172A;font-weight:700;">${content}</h2>`);
        textParts.push(renderInline(block.content, payload, { html: false }).toUpperCase());
      }
    } else if (block.type === 'callout') {
      const content = renderInline(block.content, payload);
      if (content) {
        htmlParts.push(`<div style="margin:18px 0;padding:14px 16px;border-left:4px solid #FFD700;background:#FDF6EC;color:#334155;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.55;">${content}</div>`);
        textParts.push(renderInline(block.content, payload, { html: false }));
      }
    } else if (block.type === 'details') {
      const rows = (block.rows || []).map((row) => {
        const labelHtml = renderInline(row.label, payload);
        const valueHtml = renderInline(row.value, payload);
        const labelText = renderInline(row.label, payload, { html: false });
        const valueText = renderInline(row.value, payload, { html: false });
        return { labelHtml, valueHtml, labelText, valueText };
      }).filter((row) => String(row.valueText || '').trim() !== '');
      if (rows.length) {
        htmlParts.push(`
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
            ${rows.map((row) => `
              <tr>
                <td style="padding:8px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#64748B;">${row.labelHtml}</td>
                <td align="right" style="padding:8px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#0F172A;font-weight:700;">${row.valueHtml}</td>
              </tr>
            `).join('')}
          </table>
        `);
        textParts.push(rows.map((row) => `${row.labelText}: ${row.valueText}`).join('\n'));
      }
    } else if (block.type === 'cta') {
      const href = block.url_variable ? textFor(payload, block.url_variable) : block.url;
      if (href) {
        const label = renderInline(block.label || 'Open', payload, { html: false });
        htmlParts.push(`<div style="margin:24px 0;text-align:center;">${ctaButton(escapeHtml(href), escapeHtml(label))}</div>`);
        textParts.push(`${label}: ${href}`);
      }
    } else if (block.type === 'divider') {
      htmlParts.push('<hr style="border:none;border-top:1px solid #E2E8F0;margin:22px 0;" />');
      textParts.push('---');
    } else if (block.type === 'signature') {
      const content = renderInline(block.content || 'The Waves Pest Control team', payload);
      htmlParts.push(`<p style="margin:18px 0 0 0;font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.58;color:#334155;">${content}</p>`);
      textParts.push(renderInline(block.content || 'The Waves Pest Control team', payload, { html: false }));
    } else {
      const content = renderInline(block.content, payload);
      if (content) {
        const small = block.type === 'small_note';
        htmlParts.push(`<p style="margin:0 0 ${small ? '10' : '16'}px 0;font-family:Inter,Arial,sans-serif;font-size:${small ? '13' : '15'}px;line-height:1.58;color:${small ? '#64748B' : '#334155'};">${content}</p>`);
        textParts.push(renderInline(block.content, payload, { html: false }));
      }
    }
  }

  return { bodyHtml: htmlParts.join('\n'), bodyText: textParts.filter(Boolean).join('\n\n') };
}

function sendStreamFor(template, suppressionGroupKey) {
  return String(suppressionGroupKey || template.send_stream || '').toLowerCase();
}

function asmGroupIdFor(template, suppressionGroupKey) {
  const stream = sendStreamFor(template, suppressionGroupKey);
  if (stream === 'transactional_required') return 0;
  if (stream.startsWith('marketing_')) return sendgrid.newsletterGroupId();
  return sendgrid.serviceGroupId();
}

function isMarketingSend(template, suppressionGroupKey) {
  return String(template.mode || '').toLowerCase() === 'marketing'
    || sendStreamFor(template, suppressionGroupKey).startsWith('marketing_');
}

function unsubscribeUrlForRender({ template, unsubscribeUrl, asmGroupId, suppressionGroupKey } = {}) {
  if (unsubscribeUrl) return unsubscribeUrl;
  if (isMarketingSend(template, suppressionGroupKey) && asmGroupId) return ASM_UNSUBSCRIBE_URL;
  return null;
}

function categoriesFor(template, extra = []) {
  return [
    'email_template',
    `template_${String(template.template_key || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    `stream_${String(template.send_stream || 'service').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    ...extra,
  ].filter(Boolean);
}

function redactedPayloadSnapshot(value) {
  const sensitiveKeyRe = /(password|secret|token|authorization|card|cvc|cvv|ssn|social_security|bank_account|routing_number)/i;
  if (Array.isArray(value)) return value.map(redactedPayloadSnapshot);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    sensitiveKeyRe.test(key) ? '[redacted]' : redactedPayloadSnapshot(entry),
  ]));
}

function effectiveSuppressionGroupKeyFor(template, suppressionGroupKey) {
  if (suppressionGroupKey !== undefined && suppressionGroupKey !== null) {
    const override = String(suppressionGroupKey).trim();
    return override || null;
  }
  return template.suppression_group_key || template.send_stream || null;
}

async function activeSuppressionFor(template, email, suppressionGroupKey) {
  if (!email) return null;
  const groupKey = effectiveSuppressionGroupKeyFor(template, suppressionGroupKey);
  if (String(groupKey || '').toLowerCase() === 'transactional_required') return null;
  const rows = await db('email_suppressions')
    .whereRaw('LOWER(email) = ?', [String(email).trim().toLowerCase()])
    .where({ status: 'active' });
  const globalTypes = new Set(['bounce', 'spam_complaint', 'do_not_email']);
  return rows.find((row) => (
    !row.group_key ||
    (groupKey && row.group_key === groupKey) ||
    globalTypes.has(String(row.suppression_type || '').toLowerCase())
  )) || null;
}

async function loadTemplateByKey(templateKey) {
  const template = await db('email_templates').where({ template_key: templateKey }).first();
  if (!template) return null;
  const activeVersion = template.active_version_id
    ? await db('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  return { template, activeVersion };
}

async function loadVersion(versionId) {
  const version = await db('email_template_versions as v')
    .join('email_templates as t', 'v.template_id', 't.id')
    .where('v.id', versionId)
    .select('v.*', db.raw('to_jsonb(t) as template'))
    .first();
  if (!version) return null;
  version.template = asObject(version.template);
  return version;
}

function renderTemplate({ template, version, payload = {}, unsubscribeUrl = null, modeOverride = null } = {}) {
  if (!template || !version) throw new Error('template and version required');
  const missingPayload = requiredPayloadMissing(template, payload);
  const subject = renderInline(version.subject || template.name, payload, { html: false }).trim();
  const previewText = renderInline(version.preview_text || '', payload, { html: false }).trim();
  const { bodyHtml, bodyText } = renderBlocks(version.blocks, payload);
  const mode = String(modeOverride || template.mode || 'service').toLowerCase();
  const footerNote = mode === 'marketing'
    ? null
    : 'Questions? Reply to this email or call <a href="tel:+19412975749" style="color:#009CDE;text-decoration:none;">(941) 297-5749</a>.';
  const html = mode === 'marketing'
    ? wrapNewsletter({ body: bodyHtml, unsubscribeUrl, preheader: previewText || undefined })
    : wrapServiceEmail({ body: bodyHtml, preheader: previewText || undefined, footerNote });
  const textBody = version.text_body
    ? renderInline(version.text_body, payload, { html: false })
    : bodyText;
  const text = mode === 'marketing'
    ? ensureLegalTextFooter(textBody, { unsubscribeUrl: unsubscribeUrl || null }) || bodyText
    : textBody;

  return {
    subject,
    previewText,
    html,
    text,
    missingPayload,
    validation: validationFor(template, version),
  };
}

async function renderVersion(versionId, payload = {}, opts = {}) {
  const row = await loadVersion(versionId);
  if (!row) throw new Error('template version not found');
  return renderTemplate({
    template: row.template,
    version: row,
    payload,
    unsubscribeUrl: opts.unsubscribeUrl,
  });
}

async function createDraftVersion(templateKey, technicianId) {
  const template = await db('email_templates').where({ template_key: templateKey }).first();
  if (!template) throw new Error('template not found');
  const latest = await db('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const source = template.active_version_id
    ? await db('email_template_versions').where({ id: template.active_version_id }).first()
    : latest;
  const [draft] = await db('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'draft',
    subject: source?.subject || template.name,
    preview_text: source?.preview_text || null,
    blocks: JSON.stringify(normalizeBlocks(source?.blocks || [])),
    text_body: source?.text_body || null,
    created_by: technicianId || null,
  }).returning('*');
  return draft;
}

async function publishVersion(versionId, technicianId) {
  const row = await loadVersion(versionId);
  if (!row) throw new Error('template version not found');
  const validation = validationFor(row.template, row);
  if (validation.disallowed_variables.length) {
    const err = new Error(`Disallowed variables: ${validation.disallowed_variables.join(', ')}`);
    err.status = 400;
    throw err;
  }
  if (validation.missing_required_in_template.length) {
    const err = new Error(`Missing required template variables: ${validation.missing_required_in_template.join(', ')}`);
    err.status = 400;
    throw err;
  }
  await db.transaction(async (trx) => {
    await trx('email_template_versions')
      .where({ template_id: row.template_id, status: 'active' })
      .update({ status: 'archived', updated_at: new Date() });
    await trx('email_template_versions').where({ id: versionId }).update({
      status: 'active',
      validation_snapshot: JSON.stringify(validation),
      published_by: technicianId || null,
      published_at: new Date(),
      updated_at: new Date(),
    });
    await trx('email_templates').where({ id: row.template_id }).update({
      active_version_id: versionId,
      status: 'active',
      last_published_by: technicianId || null,
      last_published_at: new Date(),
      updated_at: new Date(),
    });
  });
  return { published: true, validation };
}

function dedupedResultForExistingMessage(message) {
  const status = String(message?.status || '').toLowerCase();
  if (status === 'blocked') {
    return {
      sent: false,
      blocked: true,
      deduped: true,
      reason: message.error_message || 'Email suppressed',
      message,
    };
  }
  return {
    sent: ['sent', 'delivered', 'opened', 'clicked'].includes(status),
    deduped: true,
    message,
  };
}

function shouldRetryExistingMessage(message) {
  return !DEDUPE_STATUSES.has(String(message?.status || '').toLowerCase());
}

async function sendTemplate({
  templateKey,
  versionId,
  to,
  payload,
  recipientType,
  recipientId,
  triggerEventId,
  automationRunId,
  idempotencyKey,
  test = false,
  unsubscribeUrl = null,
  categories = [],
  attachments = [],
  suppressionGroupKey,
} = {}) {
  if (!to) throw new Error('recipient email required');
  let template;
  let version;
  if (versionId) {
    const row = await loadVersion(versionId);
    if (!row) throw new Error('template version not found');
    template = row.template;
    version = row;
  } else {
    const loaded = await loadTemplateByKey(templateKey);
    if (!loaded?.template || !loaded?.activeVersion) throw new Error('active template not found');
    template = loaded.template;
    version = loaded.activeVersion;
  }

  let retryMessage = null;
  if (idempotencyKey) {
    const existing = await db('email_messages').where({ idempotency_key: idempotencyKey }).first();
    if (existing && !shouldRetryExistingMessage(existing)) {
      return dedupedResultForExistingMessage(existing);
    }
    retryMessage = existing || null;
  }

  const effectiveSuppressionGroupKey = effectiveSuppressionGroupKeyFor(template, suppressionGroupKey);
  const asmGroupId = asmGroupIdFor(template, effectiveSuppressionGroupKey);
  const effectiveUnsubscribeUrl = unsubscribeUrlForRender({
    template,
    unsubscribeUrl,
    asmGroupId,
    suppressionGroupKey: effectiveSuppressionGroupKey,
  });
  if (isMarketingSend(template, effectiveSuppressionGroupKey) && !test && !effectiveUnsubscribeUrl) {
    const err = new Error('marketing template sends require an unsubscribe URL or SendGrid ASM group');
    err.status = 400;
    throw err;
  }

  const rendered = renderTemplate({
    template,
    version,
    payload,
    unsubscribeUrl: effectiveUnsubscribeUrl,
    modeOverride: isMarketingSend(template, effectiveSuppressionGroupKey) ? 'marketing' : null,
  });
  if (rendered.missingPayload.length) {
    const err = new Error(`Missing required variables: ${rendered.missingPayload.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const fromName = template.from_name || 'Waves Pest Control';
  const fromEmail = template.from_email || 'contact@wavespestcontrol.com';
  const replyTo = template.reply_to || 'contact@wavespestcontrol.com';
  const allCategories = categoriesFor(template, test ? ['test', ...categories] : categories);
  const messageSnapshot = {
    provider: 'sendgrid',
    template_id: template.id,
    template_version_id: version.id,
    template_key: template.template_key,
    suppression_group_key_snapshot: effectiveSuppressionGroupKey || '',
    automation_run_id: automationRunId || null,
    trigger_event_id: triggerEventId || null,
    recipient_type: test ? 'test' : (recipientType || null),
    recipient_id: recipientId || null,
    recipient_email_snapshot: to,
    from_name_snapshot: fromName,
    from_email_snapshot: fromEmail,
    reply_to_snapshot: replyTo,
    subject_snapshot: test ? `[TEST] ${rendered.subject}` : rendered.subject,
    html_snapshot: rendered.html,
    text_snapshot: rendered.text,
    payload_snapshot: JSON.stringify(redactedPayloadSnapshot(payload || {})),
    categories: JSON.stringify(allCategories),
    idempotency_key: idempotencyKey || null,
  };

  if (!test) {
    const suppression = await activeSuppressionFor(template, to, suppressionGroupKey);
    if (suppression) {
      const reason = `Suppressed: ${suppression.suppression_type}${suppression.group_key ? ` (${suppression.group_key})` : ''}`;
      const blockedPayload = {
        ...messageSnapshot,
        status: 'blocked',
        error_message: reason,
        updated_at: new Date(),
      };
      const [blocked] = retryMessage
        ? await db('email_messages').where({ id: retryMessage.id }).update(blockedPayload).returning('*')
        : await db('email_messages').insert(blockedPayload).returning('*');
      return { sent: false, blocked: true, reason, message: blocked, rendered };
    }
  }

  const queuedPayload = {
    ...messageSnapshot,
    status: 'queued',
    provider_message_id: null,
    sent_at: null,
    error_message: null,
    queued_at: new Date(),
    updated_at: new Date(),
  };
  const [message] = retryMessage
    ? await db('email_messages').where({ id: retryMessage.id }).update(queuedPayload).returning('*')
    : await db('email_messages').insert(queuedPayload).returning('*');

  try {
    const result = await sendgrid.sendOne({
      to,
      fromEmail,
      fromName,
      replyTo,
      subject: message.subject_snapshot,
      html: rendered.html,
      text: rendered.text,
      categories: allCategories,
      asmGroupId,
      attachments,
    });
    const [updated] = await db('email_messages').where({ id: message.id }).update({
      status: 'sent',
      provider_message_id: result.messageId,
      sent_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
    return { sent: true, message: updated, rendered };
  } catch (err) {
    await db('email_messages').where({ id: message.id }).update({
      status: 'failed',
      error_message: err.message.slice(0, 1000),
      updated_at: new Date(),
    });
    throw err;
  }
}

module.exports = {
  asArray,
  asObject,
  normalizeBlocks,
  validationFor,
  redactedPayloadSnapshot,
  activeSuppressionFor,
  renderTemplate,
  renderVersion,
  loadTemplateByKey,
  loadVersion,
  dedupedResultForExistingMessage,
  shouldRetryExistingMessage,
  createDraftVersion,
  publishVersion,
  sendTemplate,
};
