/**
 * SendGrid mail/send wrapper — newsletter + transactional sender for Waves.
 *
 * Twilio-owned; chosen for billing consolidation with our existing Twilio
 * SMS/Voice infra. See docs/design/DECISIONS.md (PR 5) for the call.
 *
 * Raw fetch — no npm dep, same pattern as beehiiv.js. The official
 * `@sendgrid/mail` package is convenient but adds 200kB; not worth it for
 * the three endpoints we hit.
 *
 * File is named `sendgrid-mail.js` (not `sendgrid.js`) to leave room for
 * a separate sendgrid-marketing.js / sendgrid-events.js wrapper later
 * without colliding on a top-level module name.
 *
 * Env vars:
 *   SENDGRID_API_KEY                 — secret from sendgrid.com/settings/api_keys
 *   SENDGRID_FROM_EMAIL              — default from (newsletter@wavespestcontrol.com)
 *   SENDGRID_FROM_NAME               — default from name (Waves Pest Control)
 *   PUBLIC_PORTAL_URL                — used for unsubscribe link (e.g. https://portal.wavespestcontrol.com)
 *   SENDGRID_ASM_GROUP_NEWSLETTER    — numeric group id (sendgrid.com/suppressions/advanced_suppression_manager)
 *   SENDGRID_ASM_GROUP_SERVICE       — numeric group id for transactional/service notifications
 *
 * Unsubscribe Groups (ASM): SendGrid suppresses at the group level so a
 * newsletter opt-out does NOT kill service notifications (invoice receipts,
 * appointment reminders, review requests). Every broadcast must carry the
 * NEWSLETTER group; every transactional send SHOULD carry the SERVICE group
 * so the customer has a single place to opt out of each category without
 * losing the other.
 *
 * DNS prerequisites for the SENDGRID_FROM_EMAIL domain:
 *   - 2× DKIM CNAMEs at s1._domainkey + s2._domainkey on the root
 *   - 1× return-path CNAME (provider-named, e.g. wavesnewsletter.*)
 *   - 1× link-tracking CNAME (e.g. click.*)
 *   - SPF include is implicit via the Sender Authentication wizard
 */

const logger = require('./logger');

const API_BASE = 'https://api.sendgrid.com/v3';

function isConfigured() {
  return !!process.env.SENDGRID_API_KEY;
}

function authHeaders() {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('SENDGRID_API_KEY not configured');
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function apiCall(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    logger.error(`[sendgrid] ${method} ${path} ${res.status}: ${text}`);
    const err = new Error(`SendGrid ${res.status}: ${parsed?.errors?.[0]?.message || text}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  // SendGrid returns 202 + empty body on /mail/send. The X-Message-Id header
  // is the durable id we want, so callers should rely on that — `parsed` will
  // be {} for the happy path.
  return parsed;
}

function defaultFrom(overrideEmail, overrideName) {
  return {
    email: overrideEmail || process.env.SENDGRID_FROM_EMAIL || 'newsletter@wavespestcontrol.com',
    name: overrideName || process.env.SENDGRID_FROM_NAME || 'Waves Pest Control',
  };
}

function newsletterGroupId() {
  const v = process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
  return v ? Number(v) : null;
}

function serviceGroupId() {
  const v = process.env.SENDGRID_ASM_GROUP_SERVICE;
  return v ? Number(v) : null;
}

function asmBlockFor(groupId) {
  if (!groupId) return undefined;
  return { group_id: Number(groupId) };
}

/**
 * Send one email. Used for test sends and one-off transactional. Returns
 * { messageId } where messageId is read from the X-Message-Id response header.
 */
async function sendOne({ to, fromEmail, fromName, subject, html, text, replyTo, headers, categories, asmGroupId }) {
  if (!to || !subject) throw new Error('sendOne: to + subject required');

  const payload = {
    personalizations: [{
      to: (Array.isArray(to) ? to : [to]).map((email) => ({ email })),
      headers: headers || undefined,
    }],
    from: defaultFrom(fromEmail, fromName),
    reply_to: { email: replyTo || 'contact@wavespestcontrol.com' },
    subject,
    content: [
      ...(text ? [{ type: 'text/plain', value: text }] : []),
      ...(html ? [{ type: 'text/html', value: html }] : []),
    ],
    categories: categories || undefined,
    asm: asmBlockFor(asmGroupId),
    // Disable SendGrid's own tracking pixels by default — we use our own
    // open/click events via webhooks. Operator can re-enable via env later.
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking: { enable: true },
      subscription_tracking: { enable: false },  // we own the unsubscribe path
    },
  };

  // SendGrid 202 = accepted-for-delivery. The id arrives via X-Message-Id.
  const res = await fetch(`${API_BASE}/mail/send`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    logger.error(`[sendgrid] sendOne ${res.status}: ${text}`);
    throw new Error(`SendGrid ${res.status}: ${text}`);
  }
  return { messageId: res.headers.get('x-message-id') || null };
}

/**
 * Send a campaign blast. SendGrid's `personalizations` array supports
 * up to 1000 recipients per request, each with their own `to`, `subject`,
 * `headers`, and `substitutions`. We use it to inject a per-recipient
 * unsubscribe URL into the List-Unsubscribe header AND the body footer
 * (via {{unsubscribe_url}} substitution) in a single API call.
 *
 * Each `recipients[i]` is { email, unsubscribeUrl }.
 */
async function sendBatch({ recipients, fromEmail, fromName, subject, html, text, replyTo, categories, asmGroupId }) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('sendBatch: recipients[] required');
  }
  if (recipients.length > 1000) {
    throw new Error('sendBatch: SendGrid caps personalizations at 1000; chunk before calling');
  }

  const payload = {
    personalizations: recipients.map((r) => ({
      to: [{ email: r.email }],
      // Per-recipient unsubscribe header — RFC 8058 one-click compliant.
      headers: {
        'List-Unsubscribe': `<mailto:unsubscribe@wavespestcontrol.com?subject=unsubscribe>, <${r.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      // Substitution lets the body footer point at the right URL per recipient.
      substitutions: { '{{unsubscribe_url}}': r.unsubscribeUrl },
    })),
    from: defaultFrom(fromEmail, fromName),
    reply_to: { email: replyTo || 'contact@wavespestcontrol.com' },
    subject,
    content: [
      ...(text ? [{ type: 'text/plain', value: text }] : []),
      ...(html ? [{ type: 'text/html', value: html }] : []),
    ],
    categories: categories || undefined,
    asm: asmBlockFor(asmGroupId),
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking: { enable: true },
      subscription_tracking: { enable: false },
    },
  };

  const res = await fetch(`${API_BASE}/mail/send`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    logger.error(`[sendgrid] sendBatch ${res.status}: ${txt}`);
    throw new Error(`SendGrid ${res.status}: ${txt}`);
  }
  return { messageId: res.headers.get('x-message-id') || null, recipientCount: recipients.length };
}

/**
 * Build the public unsubscribe URL for a given token. Used by the route
 * to inject into the body and the per-recipient header.
 */
function unsubscribeUrl(unsubscribeToken) {
  const baseUrl = process.env.PUBLIC_PORTAL_URL || 'https://portal.wavespestcontrol.com';
  return `${baseUrl}/api/public/newsletter/unsubscribe/${unsubscribeToken}`;
}

/**
 * Inject an unsubscribe footer into HTML body. Operator's body should NOT
 * include its own unsubscribe text — this keeps it consistent.
 *
 * Uses {{unsubscribe_url}} as the placeholder so SendGrid's substitution
 * fills it in per recipient. For the test-send path (no substitution), the
 * caller passes a real URL and we just inline it.
 */
function injectUnsubscribeFooter(html, { realUrl } = {}) {
  const url = realUrl || '{{unsubscribe_url}}';
  const footer = `
    <div style="margin-top:32px; padding-top:16px; border-top:1px solid #e5e7eb; font-size:12px; color:#6b7280; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <p style="margin:0 0 4px;">Waves Pest Control &amp; Lawn Care · Bradenton, FL</p>
      <p style="margin:0;">
        <a href="${url}" style="color:#6b7280; text-decoration:underline;">Unsubscribe from this list</a>
      </p>
    </div>
  `;
  if (html && html.includes('</body>')) {
    return html.replace('</body>', `${footer}</body>`);
  }
  return (html || '') + footer;
}

/**
 * Send a transactional email via a SendGrid dynamic template. Preferred path
 * for operational emails (invoice receipts, appointment reminders, review
 * requests, post-service surveys) so copy can be edited in the SendGrid
 * dashboard without redeploying.
 *
 *   templateId      — 'd-...' id from sendgrid.com/dynamic_templates
 *   dynamicData     — { customer_name, appt_date, ... } — template variables
 *   asmGroupId      — defaults to SENDGRID_ASM_GROUP_SERVICE if not passed
 *
 * Passing `asmGroupId: 0` opts out of suppression entirely — only do that for
 * truly transactional-legal sends (password reset, security alerts) that
 * must bypass unsubscribe state.
 */
async function sendTemplated({ to, templateId, dynamicData, fromEmail, fromName, replyTo, categories, asmGroupId }) {
  if (!to || !templateId) throw new Error('sendTemplated: to + templateId required');

  const effectiveGroup = asmGroupId === 0
    ? null
    : (asmGroupId ?? serviceGroupId());

  const payload = {
    personalizations: [{
      to: (Array.isArray(to) ? to : [to]).map((email) => ({ email })),
      dynamic_template_data: dynamicData || {},
    }],
    from: defaultFrom(fromEmail, fromName),
    reply_to: { email: replyTo || 'contact@wavespestcontrol.com' },
    template_id: templateId,
    categories: categories || undefined,
    asm: asmBlockFor(effectiveGroup),
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking: { enable: true },
      subscription_tracking: { enable: false },
    },
  };

  const res = await fetch(`${API_BASE}/mail/send`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    logger.error(`[sendgrid] sendTemplated ${res.status}: ${txt}`);
    throw new Error(`SendGrid ${res.status}: ${txt}`);
  }
  return { messageId: res.headers.get('x-message-id') || null };
}

/**
 * Newsletter broadcast — thin wrapper around sendBatch that defaults the ASM
 * group to the newsletter group so an unsub here does NOT affect service
 * notifications. Use this for all marketing/monthly-issue sends.
 */
async function sendBroadcast(args) {
  return sendBatch({
    ...args,
    asmGroupId: args.asmGroupId ?? newsletterGroupId(),
  });
}

module.exports = {
  isConfigured,
  sendOne,
  sendBatch,
  sendTemplated,
  sendBroadcast,
  unsubscribeUrl,
  injectUnsubscribeFooter,
  newsletterGroupId,
  serviceGroupId,
};
