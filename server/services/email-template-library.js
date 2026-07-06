const crypto = require('crypto');
const db = require('../models/db');
const sendgrid = require('./sendgrid-mail');
const {
  wrapServiceEmail,
  wrapNewsletter,
  ensureLegalTextFooter,
  ctaButton,
  ctaChip,
  blockPalette,
  stripeFooterLine,
} = require('./email-template');
const { auditNotificationTemplateIssue } = require('./audit-log');
const { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_E164 } = require('../constants/business');

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

// For suppressProviderErrorLog callers: strip anything address-shaped from a
// provider error before it is persisted or audited (SendGrid 4xx bodies can
// echo the recipient address).
function redactEmailAddresses(text) {
  return String(text || '').replace(/[^\s@:<>()"']+@[^\s@:<>()"']+\.[^\s@:<>()"']+/g, '[redacted-email]');
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
  if (!hasCtaBlock(version.blocks)) {
    const defaultCtaUrlVariable = String(template.default_cta_url_variable || '').trim();
    if (defaultCtaUrlVariable) referencedSet.add(defaultCtaUrlVariable);
    extractVariables(template.default_cta_label, referencedSet);
  }

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

// Operator-/AI-authored free-form customer copy where wording that resembles a
// fixture placeholder ("Sample collected from the lawn…") is legitimate prose,
// not an unfilled template value. These keys are exempt from the production
// placeholder guard so a real note can't make a customer email send fail.
const FREE_FORM_PAYLOAD_KEYS = new Set([
  'invoice_summary',
  'invoice_message',
]);

function productionPlaceholderPayloadValues(payload = {}) {
  const reviewFixtureValues = new Set([
    'review request type',
    'review submitted at',
    'review billing cadence',
    'review paused until',
    'review pause reason',
    'review monthly rate',
    'review setup steps',
    'review next step summary',
  ]);
  const findings = [];
  for (const [key, rawValue] of Object.entries(payload || {})) {
    if (FREE_FORM_PAYLOAD_KEYS.has(key)) continue;
    if (rawValue == null) continue;
    if (typeof rawValue === 'object') continue;
    const value = String(rawValue).trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    const isPlaceholder =
      /^sample(?:\s|$)/i.test(value) ||
      reviewFixtureValues.has(lower) ||
      lower === 'customer@example.com' ||
      value === '.00' ||
      /^https:\/\/portal\.wavespestcontrol\.com\/[^?#]*(?:sample|review-demo|demo)[^?#]*(?:$|[/?#])/i.test(value) ||
      /^\(941\)\s*555-\d{4}$/.test(value);
    if (isPlaceholder) findings.push(key);
  }
  return findings.sort();
}

function productionPlaceholderRenderedValues(rendered = {}) {
  const text = [
    rendered.subject || '',
    rendered.previewText || '',
    rendered.text || '',
    rendered.html || '',
  ].join('\n');
  const findings = [];
  if (/https:\/\/portal\.wavespestcontrol\.com\/[^"'<\s]*(?:sample|review-demo|demo)[^"'<\s]*/i.test(text)) {
    findings.push('rendered_url');
  }
  if (/(?:^|[\n:>])\s*Review\s+(?:request type|submitted at|billing cadence|paused until|pause reason|monthly rate|setup steps|next step summary)(?=\s*(?:$|[\n<]))/i.test(text)) {
    findings.push('rendered_placeholder_copy');
  }
  return findings.sort();
}

async function auditEmailTemplateIssue({
  templateKey,
  versionId = null,
  eventType,
  reason,
  recipientType = null,
  recipientId = null,
  triggerEventId = null,
  automationRunId = null,
  idempotencyKey = null,
  missingVariables = null,
}) {
  try {
    await auditNotificationTemplateIssue({
      channel: 'email',
      template_key: templateKey || (versionId ? `version:${versionId}` : 'unknown'),
      event_type: eventType,
      workflow: triggerEventId || automationRunId || idempotencyKey || null,
      entity_type: recipientType,
      entity_id: recipientId,
      reason,
      unresolved_placeholders: missingVariables,
    });
  } catch {
    // Rendering/sending must not fail because audit_log is unavailable.
  }
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
    if (type === 'image') {
      return {
        type,
        src: String(block.src || ''),
        alt: String(block.alt || ''),
        width: block.width != null ? Number(block.width) : undefined,
        radius: block.radius != null ? Number(block.radius) : undefined,
        align: block.align ? String(block.align) : undefined,
        url_variable: String(block.url_variable || ''),
        href: block.href ? String(block.href) : '',
      };
    }
    return { type, content: String(block?.content || '') };
  });
}

function renderBlocks(blocks, payload) {
  const htmlParts = [];
  const textParts = [];
  const B = blockPalette();
  // Only the FIRST rendered CTA gets the primary button; later CTA
  // blocks render as quiet chips (owner ask 2026-07-05 — templates like
  // appointment.confirmation carry reschedule + view, and two stacked
  // primary buttons read as competing asks).
  let renderedCtaCount = 0;

  for (const block of normalizeBlocks(blocks)) {
    if (block.type === 'heading') {
      const content = renderInline(block.content, payload);
      if (content) {
        htmlParts.push(`<h2 style="margin:0 0 12px 0;font-family:${B.font};font-size:18px;line-height:1.3;color:${B.heading};font-weight:700;">${content}</h2>`);
        textParts.push(renderInline(block.content, payload, { html: false }).toUpperCase());
      }
    } else if (block.type === 'callout') {
      const content = renderInline(block.content, payload);
      if (content) {
        htmlParts.push(`<div style="margin:18px 0;padding:14px 16px;border-left:4px solid ${B.calloutBorder};background:${B.calloutBg};color:${B.calloutText};font-family:${B.font};font-size:14px;line-height:1.55;">${content}</div>`);
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
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;border-top:1px solid ${B.rule};border-bottom:1px solid ${B.rule};">
            ${rows.map((row) => `
              <tr>
                <td style="padding:8px 0;font-family:${B.font};font-size:14px;color:${B.mutedText};">${row.labelHtml}</td>
                <td align="right" style="padding:8px 0;font-family:${B.font};font-size:14px;color:${B.heading};font-weight:700;">${row.valueHtml}</td>
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
        const render = renderedCtaCount === 0 ? ctaButton : ctaChip;
        renderedCtaCount += 1;
        htmlParts.push(`<div style="margin:${renderedCtaCount === 1 ? '24px 0 9px 0' : '9px 0 24px 0'};text-align:center;">${render(escapeHtml(href), escapeHtml(label))}</div>`);
        textParts.push(`${label}: ${href}`);
      }
    } else if (block.type === 'image') {
      // Hosted image, optionally a clickable link (e.g. app-store badges).
      // src/href resolve {{variables}} so URLs can come from payload; a static
      // portal-hosted asset URL with no variable is fine too. Width is in CSS
      // px (capped to 100% on narrow screens); radius rounds screenshots
      // (badges pass radius 0). A missing/blank src renders nothing.
      const src = renderInline(block.src, payload, { html: false }).trim();
      if (src) {
        const width = Number(block.width) > 0 ? Math.round(Number(block.width)) : 240;
        const align = block.align === 'left' ? 'left' : block.align === 'right' ? 'right' : 'center';
        const radius = Number(block.radius) > 0 ? Math.round(Number(block.radius)) : 0;
        const altText = renderInline(block.alt || '', payload, { html: false });
        const href = block.url_variable
          ? textFor(payload, block.url_variable)
          : (block.href ? renderInline(block.href, payload, { html: false }).trim() : '');
        const img = `<img src="${escapeHtml(src)}" width="${width}" alt="${escapeHtml(altText)}" style="width:${width}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;display:block;margin:0 auto;${radius ? `border-radius:${radius}px;` : ''}" />`;
        const wrapped = href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display:inline-block;border:0;text-decoration:none;">${img}</a>`
          : img;
        htmlParts.push(`<div style="margin:18px 0;text-align:${align};">${wrapped}</div>`);
        if (href && altText) textParts.push(`${altText}: ${href}`);
        else if (altText) textParts.push(altText);
        else if (href) textParts.push(href);
      }
    } else if (block.type === 'divider') {
      htmlParts.push(`<hr style="border:none;border-top:1px solid ${B.rule};margin:22px 0;" />`);
      textParts.push('---');
    } else if (block.type === 'signature') {
      const content = renderInline(block.content || 'The Waves Pest Control team', payload);
      // white-space:pre-line lets authored signatures split onto two lines
      // ("We look forward to servicing your home.\n— The Waves Team")
      // without HTML in block content; single-line signatures render
      // exactly as before.
      htmlParts.push(`<p style="margin:18px 0 0 0;font-family:${B.font};font-size:15px;line-height:1.58;color:${B.text};white-space:pre-line;">${content}</p>`);
      textParts.push(renderInline(block.content || 'The Waves Pest Control team', payload, { html: false }));
    } else {
      const content = renderInline(block.content, payload);
      if (content) {
        const small = block.type === 'small_note';
        htmlParts.push(`<p style="margin:0 0 ${small ? '10' : '16'}px 0;font-family:${B.font};font-size:${small ? '13' : '15'}px;line-height:1.58;color:${small ? B.mutedText : B.text};">${content}</p>`);
        textParts.push(renderInline(block.content, payload, { html: false }));
      }
    }
  }

  return { bodyHtml: htmlParts.join('\n'), bodyText: textParts.filter(Boolean).join('\n\n') };
}

function hasCtaBlock(blocks) {
  return normalizeBlocks(blocks).some((block) => block.type === 'cta');
}

function renderDefaultCta(template, payload) {
  const labelTemplate = String(template?.default_cta_label || '').trim();
  const urlVariable = String(template?.default_cta_url_variable || '').trim();
  if (!labelTemplate || !urlVariable) return { bodyHtml: '', bodyText: '' };
  const href = textFor(payload, urlVariable);
  if (!href) return { bodyHtml: '', bodyText: '' };
  const label = renderInline(labelTemplate, payload, { html: false }) || 'Open';
  return {
    bodyHtml: `<div style="margin:24px 0;text-align:center;">${ctaButton(escapeHtml(href), escapeHtml(label))}</div>`,
    bodyText: `${label}: ${href}`,
  };
}

function sendStreamFor(template, suppressionGroupKey) {
  return String(suppressionGroupKey || template.send_stream || '').toLowerCase();
}

function isTransactionalRequiredGroupKey(value) {
  return String(value || '').toLowerCase() === 'transactional_required';
}

function templateCanBypassSuppressions(template) {
  return isTransactionalRequiredGroupKey(template?.send_stream)
    || isTransactionalRequiredGroupKey(template?.suppression_group_key);
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

function uniqueCategories(values = []) {
  const seen = new Set();
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function categoriesFor(template, extra = []) {
  const extraCategories = Array.isArray(extra) ? extra : [extra];
  return uniqueCategories([
    'email_template',
    `template_${String(template.template_key || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    `stream_${String(template.send_stream || 'service').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    ...extraCategories,
  ]);
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
    if (isTransactionalRequiredGroupKey(override) && !templateCanBypassSuppressions(template)) {
      return template.suppression_group_key || template.send_stream || null;
    }
    return override || null;
  }
  return template.suppression_group_key || template.send_stream || null;
}

async function activeSuppressionFor(template, email, suppressionGroupKey) {
  if (!email) return null;
  const groupKey = effectiveSuppressionGroupKeyFor(template, suppressionGroupKey);
  const rows = await db('email_suppressions')
    .whereRaw('LOWER(email) = ?', [String(email).trim().toLowerCase()])
    .where({ status: 'active' });
  const globalTypes = new Set(['bounce', 'spam_complaint', 'do_not_email']);
  if (isTransactionalRequiredGroupKey(groupKey) && templateCanBypassSuppressions(template)) {
    return rows.find((row) => globalTypes.has(String(row.suppression_type || '').toLowerCase())) || null;
  }
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
  let { bodyHtml, bodyText } = renderBlocks(version.blocks, payload);
  let defaultCta = { bodyHtml: '', bodyText: '' };
  if (!hasCtaBlock(version.blocks)) {
    defaultCta = renderDefaultCta(template, payload);
    bodyHtml = [bodyHtml, defaultCta.bodyHtml].filter(Boolean).join('\n');
    bodyText = [bodyText, defaultCta.bodyText].filter(Boolean).join('\n\n');
  }
  const mode = String(modeOverride || template.mode || 'service').toLowerCase();
  // Billing-family templates carry the Stripe trust line (owner scope
  // 2026-07-05): invoice.sent / invoice.receipt / invoice.followup_*,
  // deposit.* payment receipts, the billing_late_payment_* dunning series,
  // and payer.statement.* NET statements. This renderer is the path
  // production sends actually take, so the line must live here, not only
  // in invoice-email.js's SMTP fallback.
  const templateKey = String(template.template_key || '');
  const isInvoiceTemplate = templateKey.startsWith('invoice.')
    || templateKey.startsWith('deposit.')
    || templateKey.startsWith('billing_late_payment')
    || templateKey.startsWith('payer.statement');
  // Under glass (now the only email theme) the default "Questions?" line is
  // dropped (owner call 07-06 — the pill header and fine print already carry
  // the phone); billing templates keep the Stripe trust line.
  const serviceFooter = isInvoiceTemplate ? stripeFooterLine() : null;
  // A marketing-stream template pinned to service chrome (referral.invite)
  // is still a commercial email — the visible unsubscribe link must survive
  // the wrapper swap. unsubscribeUrl is only resolved for marketing-stream
  // sends, so plain service emails are unaffected.
  const unsubFooterHtml = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:${blockPalette().footerLink};text-decoration:underline;">Unsubscribe</a> from referral emails.`
    : null;
  const footerNote = mode === 'marketing'
    ? null
    : [serviceFooter, unsubFooterHtml].filter(Boolean).join(' ') || null;
  const html = mode === 'marketing'
    ? wrapNewsletter({ body: bodyHtml, unsubscribeUrl, preheader: previewText || undefined })
    : wrapServiceEmail({ body: bodyHtml, preheader: previewText || undefined, footerNote });
  const textBody = version.text_body
    ? [renderInline(version.text_body, payload, { html: false }), defaultCta.bodyText].filter(Boolean).join('\n\n')
    : bodyText;
  const text = (mode === 'marketing' || unsubscribeUrl)
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

// Postgres unique_violation (email_messages.idempotency_key). Two overlapping
// callers (e.g. retried Stripe webhooks) can both pass the pre-insert dedupe
// check, then race on the unique index. The loser should resolve against the
// winner's row rather than surfacing a raw driver error — the duplicate never
// reaches SendGrid either way.
function isUniqueViolation(err) {
  return !!err && (err.code === '23505' || /duplicate key value/i.test(err.message || ''));
}

// A `queued` row is ambiguous: it is either a concurrent send that is still
// in-flight (its insert precedes the SendGrid call + the later status update)
// or a stale row abandoned by a crashed attempt. Within this window we treat a
// queued row as in-flight and must NOT re-send (that would duplicate); past it
// the row is considered abandoned and may be reclaimed/retried. Mirrors the
// automation executor's stale-running cutoff.
const QUEUED_IN_FLIGHT_MS = 2 * 60 * 1000;

function queuedRowInFlight(message, now = Date.now()) {
  if (String(message?.status || '').toLowerCase() !== 'queued') return false;
  const queuedAt = message.queued_at ? new Date(message.queued_at).getTime() : null;
  if (!queuedAt || Number.isNaN(queuedAt)) return false;
  return now - queuedAt < QUEUED_IN_FLIGHT_MS;
}

function inFlightCollisionError(idempotencyKey) {
  const collision = new Error(`email send already in progress for idempotency key ${idempotencyKey}`);
  collision.code = 'EMAIL_SEND_IN_PROGRESS';
  collision.status = 409;
  collision.retryable = true;
  return collision;
}

// Resolve a collision on the idempotency-key insert. The collision only fires
// when our own pre-insert check saw no row, so the winner's row was created
// concurrently: a terminal status means the winner already finished (return a
// clean dedupe), but a still-`queued`/`failed` row is in-flight — returning
// `dedupedResultForExistingMessage` would report a false non-send (callers
// treat sent===false as blocked). For that case raise a retryable collision
// instead; on retry the row is terminal and dedupes cleanly. Re-throws
// non-collision errors untouched.
async function resolveIdempotencyCollision(err, idempotencyKey) {
  if (!isUniqueViolation(err) || !idempotencyKey) throw err;
  const existing = await db('email_messages').where({ idempotency_key: idempotencyKey }).first();
  if (existing && !shouldRetryExistingMessage(existing)) {
    return dedupedResultForExistingMessage(existing);
  }
  throw inFlightCollisionError(idempotencyKey);
}

function assertTemplateSendable(template, { test = false } = {}) {
  if (test) return;
  const status = String(template?.status || 'active').toLowerCase();
  if (status === 'active') return;
  const err = new Error(`email template ${template?.template_key || 'unknown'} is ${status || 'disabled'}`);
  err.status = 409;
  err.code = 'EMAIL_TEMPLATE_DISABLED';
  throw err;
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
  // PII-sensitive bulk callers (e.g. the weekly irrigation sweep) set this so
  // sendOne does NOT log the raw SendGrid response body — provider rejections
  // can echo the recipient address, and email addresses in logs are a P1. The
  // caller is responsible for logging a sanitized reason itself; the thrown
  // error (status/body) still propagates for classification.
  suppressProviderErrorLog = false,
} = {}) {
  if (!to) throw new Error('recipient email required');
  let template;
  let version;
  if (versionId) {
    const row = await loadVersion(versionId);
    if (!row) {
      await auditEmailTemplateIssue({
        templateKey,
        versionId,
        eventType: 'missing_version',
        reason: 'template version not found',
        recipientType,
        recipientId,
        triggerEventId,
        automationRunId,
        idempotencyKey,
      });
      throw new Error('template version not found');
    }
    template = row.template;
    version = row;
  } else {
    const loaded = await loadTemplateByKey(templateKey);
    if (!loaded?.template) {
      await auditEmailTemplateIssue({
        templateKey,
        eventType: 'missing_template',
        reason: 'template not found',
        recipientType,
        recipientId,
        triggerEventId,
        automationRunId,
        idempotencyKey,
      });
      throw new Error('template not found');
    }
    template = loaded.template;
    version = loaded.activeVersion;
  }
  try {
    assertTemplateSendable(template, { test });
  } catch (err) {
    await auditEmailTemplateIssue({
      templateKey: template?.template_key || templateKey,
      versionId,
      eventType: 'disabled_template',
      reason: err.message,
      recipientType,
      recipientId,
      triggerEventId,
      automationRunId,
      idempotencyKey,
    });
    throw err;
  }
  if (!version) {
    await auditEmailTemplateIssue({
      templateKey: template?.template_key || templateKey,
      versionId,
      eventType: 'missing_active_version',
      reason: 'active template not found',
      recipientType,
      recipientId,
      triggerEventId,
      automationRunId,
      idempotencyKey,
    });
    throw new Error('active template not found');
  }

  let retryMessage = null;
  if (idempotencyKey) {
    const existing = await db('email_messages').where({ idempotency_key: idempotencyKey }).first();
    if (existing && !shouldRetryExistingMessage(existing)) {
      return dedupedResultForExistingMessage(existing);
    }
    // A concurrent caller may have committed a `queued` row that is still
    // mid-flight (queued, not yet dispatched to SendGrid). Reclaiming it as a
    // retry here would re-send and duplicate, so surface a retryable collision;
    // the caller retries once the row reaches terminal (or goes stale). Only a
    // stale/abandoned queued row — or a `failed`/never-sent row — is retried.
    if (queuedRowInFlight(existing)) {
      throw inFlightCollisionError(idempotencyKey);
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

  // A template may pin service chrome while riding a marketing_* suppression
  // stream (referral.invite — owner directive 2026-07-06: user-unsubscribable
  // via marketing_referral, rendered like the service emails). The pin is
  // layout_wrapper_id === 'service_pinned_v1'; every other template keeps the
  // stream-driven newsletter wrapper, and the unsubscribe/ASM requirements
  // above are untouched (they key on isMarketingSend, not the wrapper).
  const pinsServiceChrome = String(template.layout_wrapper_id || '').toLowerCase() === 'service_pinned_v1';
  // A pin must FORCE 'service' (not just skip the marketing override):
  // renderTemplate falls back to template.mode, and a pinned template may
  // carry mode 'marketing' from its seed (referral.invite does).
  const rendered = renderTemplate({
    template,
    version,
    payload,
    unsubscribeUrl: effectiveUnsubscribeUrl,
    modeOverride: pinsServiceChrome
      ? 'service'
      : (isMarketingSend(template, effectiveSuppressionGroupKey) ? 'marketing' : null),
  });
  if (rendered.missingPayload.length) {
    const err = new Error(`Missing required variables: ${rendered.missingPayload.join(', ')}`);
    err.status = 400;
    await auditEmailTemplateIssue({
      templateKey: template.template_key,
      versionId: version.id,
      eventType: 'missing_payload',
      reason: err.message,
      recipientType,
      recipientId,
      triggerEventId,
      automationRunId,
      idempotencyKey,
      missingVariables: rendered.missingPayload,
    });
    throw err;
  }
  if (!test && String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    const placeholderFields = productionPlaceholderPayloadValues(payload || {});
    if (placeholderFields.length) {
      const err = new Error(`Placeholder values are not allowed in production email payloads: ${placeholderFields.join(', ')}`);
      err.status = 400;
      err.code = 'EMAIL_TEMPLATE_PLACEHOLDER_PAYLOAD';
      await auditEmailTemplateIssue({
        templateKey: template.template_key,
        versionId: version.id,
        eventType: 'placeholder_payload',
        reason: err.message,
        recipientType,
        recipientId,
        triggerEventId,
        automationRunId,
        idempotencyKey,
        missingVariables: placeholderFields,
      });
      throw err;
    }
    const renderedPlaceholderFields = productionPlaceholderRenderedValues(rendered);
    if (renderedPlaceholderFields.length) {
      const err = new Error(`Placeholder values are not allowed in production rendered emails: ${renderedPlaceholderFields.join(', ')}`);
      err.status = 400;
      err.code = 'EMAIL_TEMPLATE_PLACEHOLDER_RENDERED';
      await auditEmailTemplateIssue({
        templateKey: template.template_key,
        versionId: version.id,
        eventType: 'placeholder_rendered',
        reason: err.message,
        recipientType,
        recipientId,
        triggerEventId,
        automationRunId,
        idempotencyKey,
        missingVariables: renderedPlaceholderFields,
      });
      throw err;
    }
  }

  const fromName = template.from_name || 'Waves Pest Control';
  const fromEmail = template.from_email || 'contact@wavespestcontrol.com';
  const replyTo = template.reply_to || 'contact@wavespestcontrol.com';
  const allCategories = categoriesFor(template, test ? ['test', ...categories] : categories);
  // Fresh per send attempt; echoed in custom_args so the webhook fallback can tell
  // this attempt's events from a prior (retried) attempt's. See webhooks-sendgrid.js.
  const sendAttemptToken = crypto.randomUUID();
  const messageSnapshot = {
    provider: 'sendgrid',
    send_attempt_token: sendAttemptToken,
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
    // Attachments aren't persisted in the snapshot; flag their presence so the
    // bounce-recovery replay can route attachment-bearing sends to manual recovery.
    has_attachments: Array.isArray(attachments) && attachments.length > 0,
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
      let blocked;
      if (retryMessage) {
        [blocked] = await db('email_messages').where({ id: retryMessage.id }).update(blockedPayload).returning('*');
      } else {
        try {
          [blocked] = await db('email_messages').insert(blockedPayload).returning('*');
        } catch (err) {
          return await resolveIdempotencyCollision(err, idempotencyKey);
        }
      }
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
  let message;
  if (retryMessage) {
    [message] = await db('email_messages').where({ id: retryMessage.id }).update(queuedPayload).returning('*');
  } else {
    try {
      [message] = await db('email_messages').insert(queuedPayload).returning('*');
    } catch (err) {
      return await resolveIdempotencyCollision(err, idempotencyKey);
    }
  }

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
      // Echoed on every webhook event so bounce recovery can resolve this row
      // even if a hard bounce arrives before provider_message_id is written (or
      // SendGrid returns no X-Message-Id). The attempt token lets the webhook
      // reject a stale prior-attempt event. See email-bounce-recovery.js.
      customArgs: { email_message_id: message.id, send_attempt_token: sendAttemptToken },
      suppressErrorLog: suppressProviderErrorLog,
    });
    // Record provider id + send time, and advance status to 'sent' ONLY while
    // still 'queued' — a fast delivery/bounce webhook (resolvable via
    // custom_args.email_message_id before this commit) may have already moved the
    // row to a terminal status, and we must not regress it. Scope the write to
    // THIS attempt's send_attempt_token: a stale queued row reclaimed for a retry
    // (queuedRowInFlight) means this attempt was superseded, so a late-resolving
    // sendOne must not clobber the live retry's provider id / status.
    const [updated] = await db('email_messages')
      .where({ id: message.id, send_attempt_token: sendAttemptToken })
      .update({
        provider_message_id: result.messageId,
        sent_at: new Date(),
        updated_at: new Date(),
        status: db.raw("CASE WHEN status = 'queued' THEN 'sent' ELSE status END"),
      })
      .returning('*');
    if (!updated) {
      // Superseded by a newer attempt (token changed). This attempt's send still
      // reached SendGrid, but the row belongs to the live attempt — leave it.
      const current = await db('email_messages').where({ id: message.id }).first().catch(() => null);
      return { sent: true, deduped: true, superseded: true, providerAttempted: true, message: current || message, rendered };
    }
    // providerAttempted distinguishes a real SendGrid call THIS invocation from
    // the pre-send idempotency/suppression short-circuits (which return without
    // it) — callers that budget provider attempts key off this, not `sent`,
    // because a pre-send dedupe of a previously-sent message also reports
    // sent: true.
    return { sent: true, providerAttempted: true, message: updated, rendered };
  } catch (err) {
    // PII-sensitive callers suppress the transport log — the persisted error
    // and the audit reason must honor the same flag, or the raw provider body
    // (which can echo the recipient address) leaks anyway.
    const persistedErrorMessage = suppressProviderErrorLog
      ? redactEmailAddresses(err.message)
      : String(err.message || '');
    // SendGrid may have accepted the send and a webhook already terminalized the
    // row (lost-response race) — only mark failed while still queued AND only for
    // THIS attempt (a superseded attempt must not fail the live retry's row).
    await db('email_messages').where({ id: message.id, status: 'queued', send_attempt_token: sendAttemptToken }).update({
      status: 'failed',
      error_message: persistedErrorMessage.slice(0, 1000),
      updated_at: new Date(),
    });
    const current = await db('email_messages').where({ id: message.id }).first().catch(() => null);
    const currentStatus = String(current?.status || '').toLowerCase();
    // Superseded: a newer attempt reclaimed the row (token changed), so this stale
    // caller no longer owns it — don't audit/throw (which would make upstream jobs
    // report failure or schedule another retry while the live attempt is in flight).
    if (current && current.send_attempt_token && String(current.send_attempt_token) !== String(sendAttemptToken)) {
      return { sent: true, deduped: true, superseded: true, providerAttempted: true, message: current, rendered };
    }
    // If a webhook already moved the row to a terminal status, the send actually
    // reached SendGrid — report success (deduped) so callers don't retry a send
    // that landed (and may already have triggered bounce recovery).
    if (current && currentStatus !== 'queued' && currentStatus !== 'failed') {
      return { sent: true, deduped: true, providerAttempted: true, message: current, rendered };
    }
    await auditEmailTemplateIssue({
      templateKey: template.template_key,
      versionId: version.id,
      eventType: 'provider_send_error',
      reason: persistedErrorMessage,
      recipientType,
      recipientId,
      triggerEventId,
      automationRunId,
      idempotencyKey,
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
  redactEmailAddresses,
  productionPlaceholderPayloadValues,
  productionPlaceholderRenderedValues,
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
