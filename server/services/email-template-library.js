const crypto = require('crypto');
const db = require('../models/db');
const sendgrid = require('./sendgrid-mail');
const {
  wrapServiceEmail,
  wrapNewsletter,
  bodyIsDarkAware,
  ensureLegalTextFooter,
  ctaButton,
  ctaChip,
  blockPalette,
  stripeFooterLine,
} = require('./email-template');
const { auditNotificationTemplateIssue } = require('./audit-log');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { isInternalTestEmail } = require('./internal-test-customers');
const { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_E164 } = require('../constants/business');
const { sanitizeBillingReplayContext } = require('./billing-email-replay-context');

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

// Href allowlist for CTA/image links. escapeHtml alone does not stop a
// `javascript:`/`data:` scheme, so a payload- or template-supplied URL could
// become an executable href. Permit only safe navigation schemes plus
// relative/anchor URLs; anything else collapses to '#'. Caller still escapes.
const SAFE_URL_SCHEME = /^(https?:|mailto:|tel:)/i;
function safeUrl(url) {
  const trimmed = String(url == null ? '' : url).trim();
  if (!trimmed) return '';
  // Relative or same-page links (no scheme) are fine; a bare "//" is
  // protocol-relative http(s) and also fine.
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) return trimmed;
  return SAFE_URL_SCHEME.test(trimmed) ? trimmed : '#';
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

// Markdown links inside block prose: [label](https://…).
//
// Block content is escaped, so an authored <a> tag would render as literal
// text — until now the ONLY way to put a link in a template was a cta block,
// which renders as a full-width gold bar. That is right for the primary
// action and much too heavy for "here's the background reading". This adds
// the inline option without loosening escaping.
//
// CRITICAL ORDERING (codex #3167 P1): links are extracted from the RAW
// TEMPLATE text BEFORE {{variable}} substitution, so ONLY author-authored
// markdown can become an anchor. Payload values are customer-influenced — a
// name, a note, a service label — and if substitution ran first, a value
// containing [x](https://evil) would inject a live link into an outgoing
// email. Payload text is escaped and stays inert no matter what it contains.
//
// The href likewise comes from the template, never from a substituted value,
// and still goes through safeUrl so javascript:/data: collapse. Anchors carry
// dm-link so they stay legible on the dark card. The plain-text arm renders
// "label (url)" — a text-part reader needs the destination, not a bare label.
const MD_LINK_RE = /\[([^\]\n]+)\]\((\S+?)\)/g;
// U+0000 cannot appear in template or payload text, so it is a safe fence.
const LINK_SLOT = (i) => `\u0000L${i}\u0000`;

function renderInline(text, payload, { html = true } = {}) {
  const raw = String(text || '');

  // 1. Lift author-authored links out of the raw template, leaving fences.
  const links = [];
  const fenced = raw.replace(MD_LINK_RE, (whole, label, href) => {
    const safe = safeUrl(href);
    if (!safe || safe === '#') return whole; // unusable scheme → inert text
    links.push({ label, href: safe });
    return LINK_SLOT(links.length - 1);
  });

  // 2. Substitute variables and escape. Anything a payload contributes is
  //    escaped here and can no longer be re-read as link syntax.
  const substituted = fenced.replace(VARIABLE_RE, (_, key) => textFor(payload, key));
  if (!html) {
    return substituted.replace(/\u0000L(\d+)\u0000/g, (_m, i) => {
      const l = links[Number(i)];
      if (!l) return '';
      const label = String(l.label).replace(VARIABLE_RE, (_x, key) => textFor(payload, key));
      return `${label} (${l.href})`;
    });
  }
  const escaped = escapeHtml(substituted);

  // 3. Put the anchors back. The LABEL still needs {{variable}} substitution —
  //    it was lifted out before step 2, so an authored `[Hi {{first_name}}](…)`
  //    would otherwise ship the literal token to a customer (codex #3167 P1).
  //    Substituting here is safe: the result is escaped and inserted as anchor
  //    TEXT, so a payload value cannot introduce markup and cannot open a new
  //    link — the href is still template-derived and already validated.
  return escaped.replace(/\u0000L(\d+)\u0000/g, (_m, i) => {
    const l = links[Number(i)];
    if (!l) return '';
    const label = escapeHtml(String(l.label).replace(VARIABLE_RE, (_x, key) => textFor(payload, key)));
    return `<a class="dm-link" href="${escapeHtml(l.href)}" target="_blank" rel="noopener" style="color:#0A7EC2;text-decoration:underline;">${label}</a>`;
  });
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
        // variant survives admin edits: the prep page renders
        // variant:'faq' details single-column (question over answer) —
        // dropping it here would silently regress the FAQ layout after
        // the next editor save.
        ...(block.variant ? { variant: String(block.variant) } : {}),
        rows: Array.isArray(block.rows)
          ? block.rows.map((r) => ({ label: String(r.label || ''), value: String(r.value || '') }))
          : [],
      };
    }
    if (type === 'cta') {
      return {
        type,
        label: String(block.label || 'Open'),
        ...(block.variant === 'link' ? { variant: 'link' } : {}),
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
    if (type === 'list') {
      // items survives admin edits for the same reason details.variant
      // does — the default branch below would collapse the block to
      // {type, content} and silently drop every row.
      return {
        type,
        items: Array.isArray(block.items) ? block.items.map((item) => String(item || '')) : [],
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
        htmlParts.push(`<h2 class="dm-ink" style="margin:0 0 12px 0;font-family:${B.font};font-size:18px;line-height:1.3;color:${B.heading};font-weight:700;">${content}</h2>`);
        textParts.push(renderInline(block.content, payload, { html: false }).toUpperCase());
      }
    } else if (block.type === 'callout') {
      const content = renderInline(block.content, payload);
      if (content) {
        htmlParts.push(`<div class="dm-box" style="margin:18px 0;padding:14px 16px;border-left:4px solid ${B.calloutBorder};background:${B.calloutBg};color:${B.calloutText};font-family:${B.font};font-size:14px;line-height:1.55;">${content}</div>`);
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
      if (rows.length && block.variant === 'faq') {
        // Question-over-answer, single column (variant preserved by
        // normalizeBlocks for exactly this): the two-column money-table
        // layout below right-aligns values in bold, which mangles
        // sentence-length answers. Empty answers already dropped above —
        // that's how truth-scoped FAQ rows (contract/callback claims)
        // disappear for the categories that can't make the claim.
        htmlParts.push(`
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;">
            ${rows.map((row) => `
              <tr><td class="dm-ink" style="padding:7px 0 1px 0;font-family:${B.font};font-size:14px;color:${B.heading};font-weight:700;">${row.labelHtml}</td></tr>
              <tr><td class="dm-text" style="padding:0 0 7px 0;font-family:${B.font};font-size:14px;line-height:1.55;color:${B.text};">${row.valueHtml}</td></tr>
            `).join('')}
          </table>
        `);
        textParts.push(rows.map((row) => `${row.labelText}\n${row.valueText}`).join('\n\n'));
      } else if (rows.length) {
        htmlParts.push(`
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="dm-rule" style="margin:18px 0;border-top:1px solid ${B.rule};border-bottom:1px solid ${B.rule};">
            ${rows.map((row) => `
              <tr>
                <td class="dm-muted" style="padding:8px 0;font-family:${B.font};font-size:14px;color:${B.mutedText};">${row.labelHtml}</td>
                <td align="right" class="dm-ink" style="padding:8px 0;font-family:${B.font};font-size:14px;color:${B.heading};font-weight:700;">${row.valueHtml}</td>
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
        if (block.variant === 'link') {
          htmlParts.push(`<p style="margin:0 0 10px;font-family:${B.font};font-size:13px;line-height:1.58;"><a class="dm-link" href="${escapeHtml(safeUrl(href))}" style="color:#0A7EC2;text-decoration:underline;">${escapeHtml(label)}</a></p>`);
        } else {
          const render = renderedCtaCount === 0 ? ctaButton : ctaChip;
          renderedCtaCount += 1;
          htmlParts.push(`<div style="margin:${renderedCtaCount === 1 ? '24px 0 9px 0' : '9px 0 24px 0'};text-align:center;">${render(escapeHtml(safeUrl(href)), escapeHtml(label))}</div>`);
        }
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
          ? `<a href="${escapeHtml(safeUrl(href))}" target="_blank" rel="noopener" style="display:inline-block;border:0;text-decoration:none;">${img}</a>`
          : img;
        htmlParts.push(`<div style="margin:18px 0;text-align:${align};">${wrapped}</div>`);
        if (href && altText) textParts.push(`${altText}: ${href}`);
        else if (altText) textParts.push(altText);
        else if (href) textParts.push(href);
      }
    } else if (block.type === 'list') {
      // Check-list rows (single column, navy check) — resolved {{variables}}
      // like every other block; an item that resolves to blank drops, so
      // truth-scoped claims can be payload-driven the same way FAQ rows are.
      const items = (block.items || [])
        .map((item) => ({
          html: renderInline(item, payload),
          text: renderInline(item, payload, { html: false }),
        }))
        .filter((item) => String(item.text || '').trim() !== '');
      if (items.length) {
        htmlParts.push(`
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:14px 0;">
            ${items.map((item) => `
              <tr>
                <td valign="top" width="22" class="dm-ink" style="padding:5px 8px 5px 0;font-family:${B.font};font-size:14px;line-height:1.55;color:${B.heading};font-weight:700;">&#10003;</td>
                <td class="dm-text" style="padding:5px 0;font-family:${B.font};font-size:14px;line-height:1.55;color:${B.text};">${item.html}</td>
              </tr>
            `).join('')}
          </table>
        `);
        textParts.push(items.map((item) => `- ${item.text}`).join('\n'));
      }
    } else if (block.type === 'divider') {
      htmlParts.push(`<hr class="dm-rule" style="border:none;border-top:1px solid ${B.rule};margin:22px 0;" />`);
      textParts.push('---');
    } else if (block.type === 'signature') {
      // Default sign-off is "— The Waves Team" (owner call 2026-07-21) —
      // company-name signatures were retired across every template by
      // migration 20260721100020.
      const content = renderInline(block.content || '— The Waves Team', payload);
      // white-space:pre-line lets authored signatures split onto two lines
      // ("We look forward to servicing your home.\n— The Waves Team")
      // without HTML in block content; single-line signatures render
      // exactly as before.
      htmlParts.push(`<p class="dm-text" style="margin:18px 0 0 0;font-family:${B.font};font-size:15px;line-height:1.58;color:${B.text};white-space:pre-line;">${content}</p>`);
      textParts.push(renderInline(block.content || '— The Waves Team', payload, { html: false }));
    } else {
      const content = renderInline(block.content, payload);
      if (content) {
        const small = block.type === 'small_note';
        htmlParts.push(`<p class="${small ? 'dm-muted' : 'dm-text'}" style="margin:0 0 ${small ? '10' : '16'}px 0;font-family:${B.font};font-size:${small ? '13' : '15'}px;line-height:1.58;color:${small ? B.mutedText : B.text};">${content}</p>`);
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
    bodyHtml: `<div style="margin:24px 0;text-align:center;">${ctaButton(escapeHtml(safeUrl(href)), escapeHtml(label))}</div>`,
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

const BILLING_REPLAY_CONTEXT_KEY = '__billing_replay_context';
const BILLING_REPLAY_TEMPLATES = new Set(['billing.notice', 'billing.receipt_notice']);

function parsedObject(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parsedStringArray(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
}

function billingReplayContextForSnapshot(context, facts = {}) {
  const out = sanitizeBillingReplayContext(context);
  if (!out) return null;
  const expectedTemplate = out.category === 'payment_receipt' ? 'billing.receipt_notice' : 'billing.notice';
  const expectedKey = `billing_channel_email:${out.notificationEventKey}:email`;
  if (facts.templateKey !== expectedTemplate || facts.recipientType !== 'customer'
    || String(facts.recipientId) !== out.customer_id || facts.triggerEventId !== out.notificationEventKey
    || facts.idempotencyKey !== expectedKey || !(facts.categories || []).includes(out.category)) return null;
  return out;
}

function readStoredBillingReplayContext(message) {
  const templateKey = String(message?.template_key || '').trim();
  if (!BILLING_REPLAY_TEMPLATES.has(templateKey)) return null;
  const payload = parsedObject(message.payload_snapshot);
  const categories = parsedStringArray(message.categories);
  const recipientEmail = String(message.recipient_email_snapshot || '').trim().toLowerCase();
  if (!payload || !categories || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) return null;
  return billingReplayContextForSnapshot(payload[BILLING_REPLAY_CONTEXT_KEY], {
    templateKey,
    recipientType: message.recipient_type,
    recipientId: message.recipient_id,
    triggerEventId: message.trigger_event_id,
    idempotencyKey: message.idempotency_key,
    categories,
  });
}

function payloadSnapshotForSend(payload, billingReplayContext, facts) {
  const snapshot = redactedPayloadSnapshot(payload || {});
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  delete snapshot[BILLING_REPLAY_CONTEXT_KEY];
  const safeContext = billingReplayContextForSnapshot(billingReplayContext, facts);
  if (safeContext) snapshot[BILLING_REPLAY_CONTEXT_KEY] = safeContext;
  return snapshot;
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

// ALL suppressions that would block this send. The schema permits several
// active rows per address (a bounce AND a do_not_email), and which one
// "the" suppression is depends on the caller: the send path only needs any
// one (activeSuppressionFor), but a caller classifying WHY an address is
// blocked (the lawn-email gap check) must see every applicable row —
// picking an arbitrary first match there let a bounce mask a coexisting
// opt-out (codex #3341 r3 P2).
async function activeSuppressionsFor(template, email, suppressionGroupKey, database = db) {
  if (!email) return [];
  const groupKey = effectiveSuppressionGroupKeyFor(template, suppressionGroupKey);
  const rows = await database('email_suppressions')
    .whereRaw('LOWER(email) = ?', [String(email).trim().toLowerCase()])
    .where({ status: 'active' });
  const globalTypes = new Set(['bounce', 'spam_complaint', 'do_not_email']);
  if (isTransactionalRequiredGroupKey(groupKey) && templateCanBypassSuppressions(template)) {
    return rows.filter((row) => globalTypes.has(String(row.suppression_type || '').toLowerCase()));
  }
  return rows.filter((row) => (
    !row.group_key ||
    (groupKey && row.group_key === groupKey) ||
    globalTypes.has(String(row.suppression_type || '').toLowerCase())
  ));
}

// `database` lets a caller already holding a transaction read on that
// connection instead of acquiring a second one from the pool.
async function activeSuppressionFor(template, email, suppressionGroupKey, database = db) {
  const rows = await activeSuppressionsFor(template, email, suppressionGroupKey, database);
  return rows[0] || null;
}

// A suppressed recipient blocks the send BEFORE SendGrid (correct — never
// bypass bounce management), but until now the blocked email_messages row was
// the only trace: an invoice, payment-failure, or appointment email for a
// bounce-suppressed customer silently went nowhere. Surface every blocked
// operational send to the admin notification feed, deduped per address so a
// dunning series doesn't stack alerts. Marketing-stream blocks stay silent —
// an unsubscribe doing its job is not an incident.
// Best-effort: an alert failure must never fail (or retry-loop) the send path.
async function alertBlockedOperationalSend({ template, suppressionGroupKey, to, suppression }) {
  try {
    if (isMarketingSend(template, suppressionGroupKey)) return;
    const email = String(to || '').trim().toLowerCase();
    if (!email) return;
    // Demo/App-review account: this path has no customer id for the central
    // notification gate to check, so gate on the address itself.
    if (isInternalTestEmail(email)) return;
    const dedupeKey = `email-send-blocked:${email}`;
    const existing = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
      .where('created_at', '>=', db.raw("now() - interval '168 hours'"))
      .first('id');
    if (existing) return;
    const suppressionType = String(suppression?.suppression_type || 'unknown');
    await NotificationService.notifyAdmin(
      'alert',
      'Email blocked by suppression',
      `${template.template_key} to ${email} was not sent — address is suppressed (${suppressionType}). The customer is not receiving operational email; collect a working address.`,
      { link: '/admin/communications', metadata: { dedupeKey, template_key: template.template_key, suppression_type: suppressionType } },
    );
  } catch (err) {
    logger.warn(`[email-template-library] blocked-send alert failed: ${err.message}`);
  }
}

// Content identity for an explicitly reviewed send. Version status and
// publication timestamps can change while the offer waits; content cannot.
function templateContentHash(template, version) {
  return crypto.createHash('sha256').update(JSON.stringify([
    template.name, template.template_key, template.mode, template.layout_wrapper_id,
    template.default_cta_label, template.default_cta_url_variable,
    template.from_name, template.from_email, template.reply_to,
    version.subject, version.preview_text, normalizeBlocks(version.blocks), version.text_body,
  ])).digest('hex');
}

async function loadTemplateByKey(templateKey, database = db) {
  const template = await database('email_templates').where({ template_key: templateKey }).first();
  if (!template) return null;
  const activeVersion = template.active_version_id
    ? await database('email_template_versions').where({ id: template.active_version_id }).first()
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

// A NULL/blank first_name (phone-captured leads, business accounts) would
// render the greeting as "Hi ," — first_name is not a validated-required
// variable, and ~20 send sites pass it through bare. Defaulting here covers
// every template at once. Applied AFTER requiredPayloadMissing so templates
// that DO declare first_name as required still fail closed on a missing value.
function payloadWithNameFallback(payload = {}) {
  if (String(payload.first_name ?? '').trim()) return payload;
  return { ...payload, first_name: 'there' };
}

function renderTemplate({ template, version, payload: rawPayload = {}, unsubscribeUrl = null, modeOverride = null } = {}) {
  if (!template || !version) throw new Error('template and version required');
  const missingPayload = requiredPayloadMissing(template, rawPayload);
  const payload = payloadWithNameFallback(rawPayload);
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
  // renderBlocks now tags every block with the dm-* hooks the dark sheet keys
  // off, so both wrappers can put the content on the designed dark card
  // instead of pinning it to an opaque white slab on a dark page. Decided by
  // SNIFFING the assembled body rather than by a constant: bodyIsDarkAware is
  // the same guard the newsletter path uses, so a body assembled elsewhere —
  // or a persisted one written before the hooks existed — still falls back to
  // the light card and keeps its contrast.
  const darkAwareBody = bodyIsDarkAware(bodyHtml);
  const html = mode === 'marketing'
    ? wrapNewsletter({ body: bodyHtml, unsubscribeUrl, preheader: previewText || undefined, darkAwareBody })
    : wrapServiceEmail({ body: bodyHtml, preheader: previewText || undefined, footerNote, darkAwareBody });
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

const PROVIDER_HANDOFF_PENDING = 'pending';
const PROVIDER_HANDOFF_STARTED = 'started';
const PROVIDER_HANDOFF_REJECTED = 'rejected';
const PROVIDER_RETRY_DEFINITELY_UNSENT_PHASES = new Set([
  PROVIDER_HANDOFF_PENDING,
  PROVIDER_HANDOFF_REJECTED,
]);

function providerHandoffPhaseMatchesAttempt(message) {
  const sendAttemptToken = String(message?.send_attempt_token || '');
  const handoffAttemptToken = String(message?.provider_handoff_attempt_token || '');
  return !!sendAttemptToken && !!handoffAttemptToken && sendAttemptToken === handoffAttemptToken;
}

function providerRetryDefinitelyUnsent(message) {
  const phase = String(message?.provider_handoff_phase || '').toLowerCase();
  if (PROVIDER_RETRY_DEFINITELY_UNSENT_PHASES.has(phase)) {
    return providerHandoffPhaseMatchesAttempt(message);
  }
  if (phase || message?.provider_handoff_attempt_token) return false;
  const legacyMarker = String(message?.error_message || '');
  return legacyMarker === 'provider_handoff_pending'
    || legacyMarker.startsWith('Provider request not started: ');
}

// The provider retry worker owns every scheduled row and queued claim. A
// direct idempotent send may reclaim an exhausted row only when its durable
// phase positively proves that no ambiguous provider handoff survived.
function providerRetryHoldErrorForExistingMessage(message) {
  if (!message) return null;
  const status = String(message.status || '').toLowerCase();
  const phase = String(message.provider_handoff_phase || '').toLowerCase();
  const retryCount = Number(message.provider_retry_count || 0);
  const definitelyUnsent = providerRetryDefinitelyUnsent(message);
  const hasPhaseEvidence = !!phase || !!message.provider_handoff_attempt_token;

  if (status === 'queued') {
    const providerWorkerOwned = retryCount > 0
      || message.provider_retry_next_at || message.provider_retry_exhausted_at;
    if (!providerWorkerOwned && phase !== PROVIDER_HANDOFF_STARTED
        && (!hasPhaseEvidence || definitelyUnsent)) return null;
    return providerRetryHoldError(message, 'provider_retry_in_progress');
  }
  if (status !== 'failed') return null;
  if (message.provider_retry_next_at) {
    return providerRetryHoldError(message, 'provider_retry_scheduled', true);
  }
  const ambiguous = !definitelyUnsent
    && (hasPhaseEvidence || message.provider_retry_exhausted_at || retryCount > 0);
  if (!ambiguous) return null;
  const reason = message.provider_retry_exhausted_at
    ? 'provider_retry_exhausted'
    : 'provider_retry_ambiguous';
  return providerRetryHoldError(message, reason);
}

function providerRetryHoldError(message, reason, retryable = false) {
  const providerOutcome = {
    sent: false,
    held: true,
    retryable,
    providerAttempted: false,
    deliveryOutcome: 'uncertain',
    reason,
    emailMessageId: message.id,
  };
  return Object.assign(new Error(`email send held by ${reason}`), {
    code: 'EMAIL_PROVIDER_RETRY_HELD',
    status: 409,
    held: true,
    retryable,
    deliveryOutcome: 'uncertain',
    reason,
    providerOutcome,
  });
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

// error_message of a queued attempt the caller aborted at the queue
// transition (onQueued → false): a pre-provider failure that is IMMEDIATELY
// retryable — never a delivery, never ambiguous.
const ABORTED_BEFORE_DISPATCH = 'aborted_by_caller_before_dispatch';

// A dispatchToProvider result that means "the annual-offer guard withheld
// this send" rather than "sendgrid ran" — kept as a module-private sentinel
// (never serialized) so the caller-composition branches below can tell it
// apart from both a real provider result and a thrown error.
const ANNUAL_OFFER_WITHHELD = Symbol('annual_offer_withheld');

// Property key on a dispatchToProvider result meaning "the guard's own row
// lookup threw" (pre-push audit P1). Caught INSIDE the guarded
// dispatchToProvider below so the failure resolves as an ordinary
// (non-throwing) result instead of reaching the provider-error catch block
// — that catch computes retryable/uncertain from provider evidence
// (providerAccepted, a thrown SDK error's shape) that was never gathered
// here, since SendGrid was never called. The wrapper carries the error so
// abortGuardFailedBeforeDispatch (below) can report it verbatim.
const ANNUAL_OFFER_GUARD_FAILED = Symbol('annual_offer_guard_failed');

// The caller's locked handoff around one provider request, as a state
// machine of its own: the request either ran (its result, or its error to
// classify), was refused before it ran (abort before dispatch), or the
// caller's guard failed after acceptance (the acceptance is kept). A throw
// from the request itself propagates for the sender's provider-error path.
async function runProviderHandoff({ withProviderHandoff, dispatchToProvider, templateKey }) {
  let dispatchStarted = false;
  let result;
  let verdict;
  try {
    verdict = await withProviderHandoff(async (database) => {
      dispatchStarted = true;
      result = await dispatchToProvider(database);
    });
  } catch (err) {
    if (dispatchStarted && result === undefined) throw err;
    if (!dispatchStarted) verdict = { ok: false, reason: err.message };
    else logger.warn(`[email-template-library] provider handoff guard failed after acceptance for ${templateKey}: ${err.message}`);
  }
  if (result !== undefined) return { result };
  if (verdict?.ok !== true || !dispatchStarted) return { abortedBeforeDispatch: true };
  throw new Error('provider handoff returned without a provider result');
}

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

// Claim a direct retry only while the row still matches the exact attempt and
// provider-rail evidence observed by the preflight read. This protects both
// the normal queued transition and the suppression-block transition.
function retryClaimQuery(message) {
  const query = db('email_messages')
    .where({ id: message.id, status: message.status })
    .whereNull('provider_retry_next_at');

  if (message.provider_retry_exhausted_at == null) {
    query.whereNull('provider_retry_exhausted_at');
  } else {
    query.where({ provider_retry_exhausted_at: message.provider_retry_exhausted_at });
    if (message.error_message == null) query.whereNull('error_message');
    else query.where({ error_message: message.error_message });
  }
  if (message.send_attempt_token == null) query.whereNull('send_attempt_token');
  else query.where({ send_attempt_token: message.send_attempt_token });
  if (message.provider_handoff_phase == null) query.whereNull('provider_handoff_phase');
  else query.where({ provider_handoff_phase: message.provider_handoff_phase });
  if (message.provider_handoff_attempt_token == null) query.whereNull('provider_handoff_attempt_token');
  else query.where({ provider_handoff_attempt_token: message.provider_handoff_attempt_token });
  return query;
}

async function resolveRetryClaimLoss(retryMessage, idempotencyKey) {
  const current = await db('email_messages').where({ id: retryMessage.id }).first();
  if (current && !shouldRetryExistingMessage(current)) {
    return dedupedResultForExistingMessage(current);
  }
  throw inFlightCollisionError(idempotencyKey);
}

function clearedProviderRetryState(message) {
  if (!message || (!message.provider_retry_exhausted_at && !message.provider_handoff_phase
      && !message.provider_handoff_attempt_token && Number(message.provider_retry_count || 0) === 0)) return {};
  return {
    provider_retry_count: 0,
    provider_retry_next_at: null,
    provider_retry_exhausted_at: null,
    provider_handoff_phase: null,
    provider_handoff_attempt_token: null,
  };
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
  expectedContentHash = null,
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
  billingReplayContext = null,
  // PII-sensitive bulk callers (e.g. the weekly irrigation sweep) set this so
  // sendOne does NOT log the raw SendGrid response body — provider rejections
  // can echo the recipient address, and email addresses in logs are a P1. The
  // caller is responsible for logging a sanitized reason itself; the thrown
  // error (status/body) still propagates for classification.
  suppressProviderErrorLog = false,
  // Called with the durable email row the moment it is QUEUED (the point the
  // library's own in-flight lease starts) — lets a caller holding a sibling
  // lease (the weekly watering-plan snapshot claim) renew it on the same
  // transition instead of a lease that began before template resolution
  // and suppression checks (codex #3565 gh-r19). Resolving `false` ABORTS
  // the send before dispatch (the row is marked failed, pre-provider); a
  // throw is logged and the send proceeds.
  onQueued = null,
  // The email twin of the SMS sender's locked handoff: called with a
  // `dispatch` that performs the actual provider request. The caller holds
  // whatever authority rows it needs and awaits `dispatch()` while they are
  // held. A refusal without dispatching aborts the queued attempt
  // pre-provider (ABORTED_BEFORE_DISPATCH), a throw after dispatch began is
  // the provider outcome, and a caller failure after acceptance keeps the
  // acceptance.
  withProviderHandoff = null,
  // Delivery-guards slice (re-cut of #4569): the estimate(s) this send is
  // about. When present, passed through to sendgrid.sendOne as an explicit
  // addition to its own content derivation. Codex round 3 on #4608
  // (structural move): the annual-offer guard's AUTHORITATIVE check now
  // runs inside sendOne itself, the true provider boundary — not here. This
  // library stays the bookkeeping layer: it turns sendOne's refusal into
  // the failed queued row (abortWithheldBeforeDispatch below). No sender
  // rechecks the guard itself; it just passes the id(s) through.
  estimateId = null,
  estimateIds = null,
  // Round 9 structural fix (P1): the rewrite-vs-refuse choice is resolved
  // by sendOne itself from `templateKey` (estimate-annual-guard.js's
  // withheldLinkPolicyForTemplate — 'rewrite' for receipt/payment-class
  // templates like deposit.receipt, 'refuse' for everything else) — NOT
  // defaulted here any more, so an explicit caller override (rare) is the
  // only thing this param carries; leaving it unset lets the template-keyed
  // default govern. When a withheld link is rewritten (long or short, in
  // the RENDERED html/text), the send proceeds and the result carries
  // withheldLinksRewritten: [ids]. Precedent: estimate-deposits.js's own
  // pricing-authority CTA swap for the same reason (the deposit is owed
  // regardless of the offer's own state).
  withheldLinkPolicy = null,
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
      throw Object.assign(new Error('template version not found'), { code: 'EMAIL_TEMPLATE_UNAVAILABLE' });
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
      throw Object.assign(new Error('template not found'), { code: 'EMAIL_TEMPLATE_UNAVAILABLE' });
    }
    template = loaded.template;
    version = loaded.activeVersion;
  }
  if (expectedContentHash && templateContentHash(template, version) !== expectedContentHash) {
    throw new Error('The reviewed email content changed. Review the message again before sending.');
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
    throw Object.assign(new Error('active template not found'), { code: 'EMAIL_TEMPLATE_UNAVAILABLE' });
  }

  let retryMessage = null;
  if (idempotencyKey) {
    const existing = await db('email_messages').where({ idempotency_key: idempotencyKey }).first();
    if (existing && !shouldRetryExistingMessage(existing)) {
      return dedupedResultForExistingMessage(existing);
    }
    const providerRetryHold = providerRetryHoldErrorForExistingMessage(existing);
    if (providerRetryHold) throw providerRetryHold;
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
    payload_snapshot: JSON.stringify(payloadSnapshotForSend(payload, billingReplayContext, {
      templateKey: template.template_key,
      recipientType: test ? 'test' : (recipientType || null),
      recipientId: recipientId || null,
      triggerEventId: triggerEventId || null,
      idempotencyKey: idempotencyKey || null,
      categories: allCategories,
    })),
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
        ...clearedProviderRetryState(retryMessage),
      };
      let blocked;
      if (retryMessage) {
        [blocked] = await retryClaimQuery(retryMessage).update(blockedPayload).returning('*');
        if (!blocked) return await resolveRetryClaimLoss(retryMessage, idempotencyKey);
      } else {
        try {
          [blocked] = await db('email_messages').insert(blockedPayload).returning('*');
        } catch (err) {
          return await resolveIdempotencyCollision(err, idempotencyKey);
        }
      }
      await alertBlockedOperationalSend({
        template,
        suppressionGroupKey: effectiveSuppressionGroupKey,
        to,
        suppression,
      });
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
    ...clearedProviderRetryState(retryMessage),
    provider_handoff_phase: PROVIDER_HANDOFF_PENDING,
    provider_handoff_attempt_token: sendAttemptToken,
  };
  let message;
  if (retryMessage) {
    [message] = await retryClaimQuery(retryMessage).update(queuedPayload).returning('*');
    if (!message) return await resolveRetryClaimLoss(retryMessage, idempotencyKey);
  } else {
    try {
      [message] = await db('email_messages').insert(queuedPayload).returning('*');
    } catch (err) {
      return await resolveIdempotencyCollision(err, idempotencyKey);
    }
  }
  // The caller's sibling lease is LOST (an overlapping worker owns the
  // decision now), or its locked handoff refused: never dispatch this
  // attempt. The queued row becomes a pre-provider failure — no provider id
  // — so the customer-week reconciliation reads it as retryable, not as a
  // delivery (codex #3565 gh-r20).
  const abortBeforeDispatch = async () => {
    const reason = ABORTED_BEFORE_DISPATCH;
    let aborted;
    try {
      // Scoped to THIS queued attempt (id + queued + send_attempt_token),
      // exactly like the provider-error path: a newer worker that has
      // reclaimed the row owns a new token and must never be marked
      // failed by this one (0 rows → leave it alone; still no dispatch).
      [aborted] = await db('email_messages')
        .where({ id: message.id, status: 'queued', send_attempt_token: sendAttemptToken,
          provider_handoff_phase: PROVIDER_HANDOFF_PENDING,
          provider_handoff_attempt_token: sendAttemptToken })
        .update({ status: 'failed', error_message: reason,
          provider_handoff_phase: PROVIDER_HANDOFF_PENDING,
          provider_handoff_attempt_token: sendAttemptToken, updated_at: new Date() }).returning('*');
    } catch (err) {
      logger.warn(`[email-template-library] abort bookkeeping failed for ${templateKey}: ${err.message}`);
    }
    return { sent: false, aborted: true, reason, message: aborted || { ...message, status: 'failed', error_message: reason }, rendered };
  };
  // Delivery-guards slice: the annual-offer guard's own pre-dispatch abort.
  // Same bookkeeping shape as abortBeforeDispatch (no provider id, the
  // queued row becomes a retryable pre-provider failure) but its own reason
  // and an explicit providerAttempted: false so callers can tell "the offer
  // was withheld" apart from a lost sibling lease.
  const ANNUAL_OFFER_WITHHELD_REASON = 'annual_offer_withheld';
  const abortWithheldBeforeDispatch = async () => {
    let blocked;
    try {
      [blocked] = await db('email_messages')
        .where({ id: message.id, status: 'queued', send_attempt_token: sendAttemptToken,
          provider_handoff_phase: PROVIDER_HANDOFF_STARTED,
          provider_handoff_attempt_token: sendAttemptToken })
        .update({ status: 'failed', error_message: ANNUAL_OFFER_WITHHELD_REASON,
          provider_handoff_phase: PROVIDER_HANDOFF_REJECTED,
          provider_handoff_attempt_token: sendAttemptToken, updated_at: new Date() }).returning('*');
    } catch (err) {
      logger.warn(`[email-template-library] annual offer guard bookkeeping failed for ${templateKey}: ${err.message}`);
    }
    return {
      sent: false, blocked: true, reason: ANNUAL_OFFER_WITHHELD_REASON, providerAttempted: false,
      message: blocked || { ...message, status: 'failed', error_message: ANNUAL_OFFER_WITHHELD_REASON }, rendered,
    };
  };
  // Pre-push audit P1: a guard INFRASTRUCTURE error (the row lookup threw —
  // DB unavailable, etc.) is a definite pre-dispatch failure, never an
  // uncertain or handled/deduped send. Same bookkeeping shape as
  // abortWithheldBeforeDispatch — the queued row becomes a retryable
  // pre-provider failure scoped to THIS attempt — but its own reason
  // (carrying the underlying error message) and an explicit `aborted` +
  // `guardError` pair so callers can distinguish "the guard said no" from
  // "the guard itself broke": the second must never be read as a possible
  // provider attempt.
  const abortGuardFailedBeforeDispatch = async (err) => {
    const reason = `annual_offer_guard_failed: ${err.message}`;
    let failed;
    try {
      [failed] = await db('email_messages')
        .where({ id: message.id, status: 'queued', send_attempt_token: sendAttemptToken,
          provider_handoff_phase: PROVIDER_HANDOFF_STARTED,
          provider_handoff_attempt_token: sendAttemptToken })
        .update({ status: 'failed', error_message: reason,
          provider_handoff_phase: PROVIDER_HANDOFF_REJECTED,
          provider_handoff_attempt_token: sendAttemptToken, updated_at: new Date() }).returning('*');
    } catch (bookkeepingErr) {
      logger.warn(`[email-template-library] annual offer guard failure bookkeeping failed for ${templateKey}: ${bookkeepingErr.message}`);
    }
    return {
      sent: false, aborted: true, guardError: true, reason: 'annual_offer_guard_failed', providerAttempted: false,
      error: err.message, message: failed || { ...message, status: 'failed', error_message: reason }, rendered,
    };
  };
  if (typeof onQueued === 'function') {
    let keep = true;
    try {
      keep = (await onQueued(message)) !== false;
    } catch (err) {
      logger.warn(`[email-template-library] onQueued hook failed for ${templateKey}: ${err.message}`);
    }
    if (!keep) return abortBeforeDispatch();
  }

  let providerAccepted = false;
  let providerHandoffStarted = false;
  let result;
  const recordAcceptance = () => db('email_messages')
    .where({ id: message.id, send_attempt_token: sendAttemptToken,
      provider_handoff_phase: PROVIDER_HANDOFF_STARTED,
      provider_handoff_attempt_token: sendAttemptToken })
    .update({
      provider_message_id: result.messageId,
      sent_at: new Date(),
      updated_at: new Date(),
      status: db.raw("CASE WHEN status = 'queued' THEN 'sent' ELSE status END"),
    }).returning('*');
  try {
    // Codex round 3 on #4608 (structural move): the annual-offer guard's
    // AUTHORITATIVE check now runs inside sendgrid.sendOne itself, the true
    // provider boundary — not here. `estimateIds` is passed straight
    // through as sendOne's explicit addition to its own content derivation
    // over the FINAL html/text; this library's job is only to turn sendOne's
    // refusal into the bookkeeping below.
    //
    // Round 9 structural fix (P1): the rewrite-vs-refuse decision itself
    // also moved into sendOne, keyed on `templateKey` (estimate-annual-
    // guard.js's withheldLinkPolicyForTemplate) — the SAME resolution the
    // retry sweep and bounce recovery now share, since they call sendOne
    // directly with no caller opinion of their own. This library forwards
    // `withheldLinkPolicy` only when a caller explicitly passed one (an
    // override); otherwise sendOne's template-keyed default governs.
    const sendToProvider = (html, text, guardIds, database) => sendgrid.sendOne({
        to,
        fromEmail,
        fromName,
        replyTo,
        subject: message.subject_snapshot,
        html,
        text,
        categories: allCategories,
        asmGroupId,
        attachments,
        // Echoed on every webhook event so bounce recovery can resolve this row
        // even if a hard bounce arrives before provider_message_id is written (or
        // SendGrid returns no X-Message-Id). The attempt token lets the webhook
        // reject a stale prior-attempt event. See email-bounce-recovery.js.
        customArgs: { email_message_id: message.id, send_attempt_token: sendAttemptToken },
        suppressErrorLog: suppressProviderErrorLog,
        estimateIds: guardIds,
        templateKey,
        ...(database ? { database } : {}),
        ...(withheldLinkPolicy ? { withheldLinkPolicy } : {}),
      });
    // Codex round 1 on #4608 (P1): keying this ONLY on estimateId/estimateIds
    // made the guard opt-in — the estimate-public.js service-details email
    // (and any future sender) can carry an estimate link without ever
    // passing an id. sendOne's own content derivation covers that; this is
    // only the explicit addition.
    const guardEstimateIds = Array.isArray(estimateIds) && estimateIds.length
      ? estimateIds : (estimateId ? [estimateId] : []);
    // dispatchToProvider is composed so a caller's own withProviderHandoff
    // (outermost) has already acquired its lock by the time sendOne's guard
    // reads a fresh row, whether or not a caller handoff is present at all
    // (both branches below call this same function). Neither guard outcome
    // is allowed to throw out of this function: a withheld verdict and a
    // guard LOOKUP error (pre-push audit P1 — must never fall into the
    // ordinary provider-error catch below, which infers retryable/uncertain
    // from provider evidence that a never-attempted SendGrid call cannot
    // have produced) both resolve to their own sentinel instead, so
    // dispatchToProvider always either sends or reports a real,
    // non-throwing outcome.
    const dispatchToProvider = async (database) => {
      // Durable immediately before entering sendOne. A dedicated connection
      // keeps the marker visible even when the caller is holding authority
      // locks on its own transaction through the provider request.
      const marked = await require('../models/marker-db')()('email_messages')
        .where({ id: message.id, status: 'queued', send_attempt_token: sendAttemptToken,
          provider_handoff_phase: PROVIDER_HANDOFF_PENDING,
          provider_handoff_attempt_token: sendAttemptToken })
        .update({ provider_handoff_phase: PROVIDER_HANDOFF_STARTED,
          provider_handoff_attempt_token: sendAttemptToken, updated_at: new Date() });
      if (Number(marked) !== 1) {
        throw inFlightCollisionError(idempotencyKey || message.id);
      }
      providerHandoffStarted = true;
      try {
        const providerResult = await sendToProvider(rendered.html, rendered.text, guardEstimateIds, database);
        if (providerResult?.withheldLinksRewritten?.length) {
          // Pre-push audit P1 (b49be57b12 round 4), still true under the
          // round 9 structural move: the STORED row should match what
          // actually went out. sendOne already rewrote the content it sent
          // to SendGrid (providerResult.html/text carry the rewritten
          // bytes) — persist them here so the stored snapshot reflects the
          // portal-home CTA the customer actually received, not the
          // withheld link. Not required for correctness of a LATER retry or
          // bounce recovery any more (both now pass templateKey through to
          // sendOne themselves and would independently re-derive the same
          // rewrite from the original snapshot), only for audit fidelity of
          // this row. Same scoped pre-dispatch bookkeeping shape as
          // abortWithheldBeforeDispatch below (id + still-queued + THIS
          // attempt's token), so a superseded/reclaimed row is never
          // touched. Best-effort: a write failure here must not block a
          // send that already succeeded.
          try {
            await (database || db)('email_messages')
              .where({ id: message.id, status: 'queued', send_attempt_token: sendAttemptToken })
              .update({
                html_snapshot: providerResult.html,
                text_snapshot: providerResult.text,
                updated_at: new Date(),
              });
          } catch (persistErr) {
            logger.warn(`[email-template-library] rewritten-content persist failed for ${templateKey} (${message.id}): ${persistErr.message}`);
          }
          logger.warn(`[email-template-library] rewrote ${providerResult.withheldLinksRewritten.length} withheld estimate link(s) to the portal home for ${templateKey} (${message.id})`);
        }
        return providerResult;
      } catch (err) {
        if (err?.annualOfferWithheld) return ANNUAL_OFFER_WITHHELD;
        if (err?.annualOfferGuardFailed) return { [ANNUAL_OFFER_GUARD_FAILED]: true, error: err };
        throw err;
      }
    };
    if (typeof withProviderHandoff === 'function') {
      const handoff = await runProviderHandoff({ withProviderHandoff, dispatchToProvider, templateKey });
      if (handoff.abortedBeforeDispatch) return abortBeforeDispatch();
      result = handoff.result;
    } else {
      result = await dispatchToProvider();
    }
    if (result === ANNUAL_OFFER_WITHHELD) return abortWithheldBeforeDispatch();
    // Pre-push audit P1: both the withProviderHandoff branch and the direct
    // branch above assign `result` from the SAME dispatchToProvider, so this
    // one check covers either caller shape.
    if (result && result[ANNUAL_OFFER_GUARD_FAILED]) return abortGuardFailedBeforeDispatch(result.error);
    providerAccepted = true;
    // Record provider id + send time, and advance status to 'sent' ONLY while
    // still 'queued' — a fast delivery/bounce webhook (resolvable via
    // custom_args.email_message_id before this commit) may have already moved the
    // row to a terminal status, and we must not regress it. Scope the write to
    // THIS attempt's send_attempt_token: a stale queued row reclaimed for a retry
    // (queuedRowInFlight) means this attempt was superseded, so a late-resolving
    // sendOne must not clobber the live retry's provider id / status.
    const [updated] = await recordAcceptance();
    if (!updated) {
      // Superseded by a newer attempt (token changed). This attempt's send still
      // reached SendGrid, but the row belongs to the live attempt — leave it.
      const current = await db('email_messages').where({ id: message.id }).first().catch(() => null);
      return { sent: true, deduped: true, superseded: true, providerAttempted: true, providerAccepted, message: current || message, rendered };
    }
    // providerAttempted distinguishes a real SendGrid call THIS invocation from
    // the pre-send idempotency/suppression short-circuits (which return without
    // it) — callers that budget provider attempts key off this, not `sent`,
    // because a pre-send dedupe of a previously-sent message also reports
    // sent: true.
    return {
      sent: true, providerAttempted: true, providerAccepted, message: updated, rendered,
      ...(result?.withheldLinksRewritten ? { withheldLinksRewritten: result.withheldLinksRewritten } : {}),
    };
  } catch (err) {
    // PII-sensitive callers suppress the transport log — the persisted error
    // and the audit reason must honor the same flag, or the raw provider body
    // (which can echo the recipient address) leaks anyway.
    const persistedErrorMessage = suppressProviderErrorLog
      ? redactEmailAddresses(err.message)
      : String(err.message || '');
    if (providerAccepted) {
      // A ledger error cannot turn the SDK's acceptance into a retryable send.
      // Retry only the token-scoped stamp, never the provider operation.
      let recorded = null;
      let bookkeepingFailed = false;
      try { [recorded] = await recordAcceptance(); } catch { bookkeepingFailed = true; }
      logger.warn(`[email-template-library] accepted send bookkeeping failed for ${templateKey}: ${persistedErrorMessage}`);
      return { sent: true, providerAttempted: true, providerAccepted: true,
        bookkeepingFailed, message: recorded || { ...message, provider_message_id: result.messageId }, rendered };
    }
    const definiteRejection = providerHandoffStarted && (
      err?.code === 'SENDGRID_NOT_CONFIGURED' || sendgrid.isDefiniteRejection(err)
    );
    const expectedFailurePhase = providerHandoffStarted
      ? PROVIDER_HANDOFF_STARTED
      : PROVIDER_HANDOFF_PENDING;
    const recordedFailurePhase = definiteRejection
      ? PROVIDER_HANDOFF_REJECTED
      : expectedFailurePhase;
    let webhookAcceptance = null;
    const recovered = await db.transaction(async (trx) => {
      const current = await trx('email_messages').where({ id: message.id }).first();
      const currentStatus = String(current?.status || '').toLowerCase();
      // Superseded: a newer attempt reclaimed the row (token changed), so this stale
      // caller no longer owns it — don't audit/throw (which would make upstream jobs
      // report failure or schedule another retry while the live attempt is in flight).
      if (current && current.send_attempt_token && String(current.send_attempt_token) !== String(sendAttemptToken)) {
        return { sent: true, deduped: true, superseded: true, providerAttempted: true, providerAccepted, message: current, rendered };
      }
      // Hold the row through failure classification so retries cannot claim an
      // intermediate failure; read events AFTER stamping to include late evidence.
      const [failed] = await trx('email_messages')
        .where({ id: message.id, status: 'queued', send_attempt_token: sendAttemptToken,
          provider_handoff_phase: expectedFailurePhase,
          provider_handoff_attempt_token: sendAttemptToken })
        .update({
          status: 'failed',
          error_message: persistedErrorMessage.slice(0, 1000),
          provider_handoff_phase: recordedFailurePhase,
          provider_handoff_attempt_token: sendAttemptToken,
          updated_at: new Date(),
        }).returning('id');
      // If a webhook already moved the row to a terminal status, the send actually
      // reached SendGrid — report success (deduped) so callers don't retry a send
      // that landed (and may already have triggered bounce recovery).
      const matchingAttempt = current && String(current.send_attempt_token || '') === String(sendAttemptToken);
      // Row timestamps/status can be written by a delayed older webhook. The
      // immutable event carries the actual attempt token, including open/click
      // events that do not change queued status.
      const matchingProviderEvidence = matchingAttempt && await trx('email_message_events')
        .where({ email_message_id: message.id, provider: 'sendgrid' })
        .whereIn('event_type', ['processed', 'deferred', 'delivered', 'open', 'click', 'bounce', 'blocked', 'dropped', 'spamreport', 'unsubscribe', 'group_unsubscribe'])
        .whereRaw("raw_event->>'send_attempt_token' = ?", [sendAttemptToken])
        .first('event_type');
      if (matchingProviderEvidence) webhookAcceptance = { sent: true, deduped: true,
        providerAttempted: true, providerAccepted: true, message: current, rendered };
      if (matchingProviderEvidence && ['processed', 'deferred', 'open', 'click'].includes(matchingProviderEvidence.event_type)
        && currentStatus === 'queued') {
        // Repair only our own failure while holding its row lock; pre-existing
        // provider-block failures keep their retry state.
        const [recorded] = await trx('email_messages').where({ id: message.id, send_attempt_token: sendAttemptToken })
          .where({ status: failed ? 'failed' : 'queued' })
          .update({ status: 'sent', sent_at: new Date(), error_message: null, updated_at: new Date() }).returning('*');
        return { ...webhookAcceptance, message: recorded || current, bookkeepingFailed: false };
      }
      if (matchingProviderEvidence || (current && currentStatus !== 'queued' && currentStatus !== 'failed')) {
        return { sent: true, deduped: true, providerAttempted: true,
          providerAccepted: Boolean(matchingProviderEvidence), message: current, rendered };
      }
      return null;
    }).catch((recoveryError) => {
      if (!webhookAcceptance) throw recoveryError;
      // Roll back our temporary failure as well as the failed recovery stamp.
      logger.warn(`[email-template-library] webhook acceptance bookkeeping failed for ${templateKey}: ${recoveryError.message}`);
      return { ...webhookAcceptance, bookkeepingFailed: true };
    });
    if (recovered) return recovered;
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
  payloadSnapshotForSend,
  readStoredBillingReplayContext,
  redactEmailAddresses,
  safeUrl,
  productionPlaceholderPayloadValues,
  productionPlaceholderRenderedValues,
  activeSuppressionFor,
  activeSuppressionsFor,
  renderTemplate,
  renderVersion,
  loadTemplateByKey,
  templateContentHash,
  loadVersion,
  dedupedResultForExistingMessage,
  shouldRetryExistingMessage,
  queuedRowInFlight,
  ABORTED_BEFORE_DISPATCH,
  QUEUED_IN_FLIGHT_MS,
  createDraftVersion,
  publishVersion,
  sendTemplate,
};
