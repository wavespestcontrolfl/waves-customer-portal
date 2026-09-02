// Owner-facing ops digests: one delivery seam for the FIX:/ACT:/FIRST:
// watcher and digest emails that go to contact@.
//
// GATE_OPS_DIGESTS_IN_APP off (default): the sender's own mailer call runs
// exactly as before — recipient guard, dedupe marker and error handling all
// stay in the sender. On: the digest is recorded as an admin bell row
// (category ops_digest, which the Agents → Activity feed lists) and the
// email is skipped. If the row cannot be written the email still goes out,
// so a digest is never lost to a DB hiccup.
//
// Senders keep their email preflight (mailer configured, internal
// recipient) in front of this call in BOTH modes: the email path is the
// fallback when the bell row cannot be written, so a mis-set recipient env
// must fail closed before anything can be sent (pre-push P0). In-app mode
// therefore inherits the same prerequisites as email — no digest is
// delivered anywhere while the mailer or recipient is misconfigured, which
// is exactly today's behavior.
//
// Deliberately NOT routed here (they keep emailing regardless of the gate):
// the two reply-to-approve flows (newsletter proof, content email approvals)
// and the two "something is broken" FIX alerts (stripe-webhook-health,
// llm-dispatch-metrics). Customer-facing mail never touches this module.

const logger = require('./logger');

// Resolved at CALL time, not load time: this module is required by fifteen
// senders, several of which are loaded before their suites set gate env
// vars — a load-time require of feature-gates would freeze every gate
// early (bit google-business-sync.test.js). Same for the bell service.
function featureGates() {
  return require('../config/feature-gates');
}
function notificationService() {
  return require('./notification-service');
}

const CATEGORY = 'ops_digest';
const MAX_TITLE_CHARS = 200; // notifications.title is varchar(200); body is text (uncapped)

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// sendOne resolves void on success and throws on failure; email.js send
// resolves { ok, error? }. Normalize so callers keep reading .ok / .error.
function emailOutcome(result) {
  const failed = !!result && result.ok === false;
  return { ok: !failed, channel: 'email', result, ...(failed ? { error: result.error || 'send failed' } : {}) };
}

// gateEnvValue at CALL time (techTips idiom): the gates object is evaluated
// once at boot, so isEnabled() would freeze the kill switch until a redeploy.
// Guarded like admin-dispatch's techTips read: several sender suites mock
// feature-gates with a partial object, and a missing gateEnvValue must read
// as "off" (email path), never throw inside a digest send.
function inAppEnabled() {
  const gates = featureGates();
  return typeof gates.gateEnvValue === 'function' && gates.gateEnvValue('GATE_OPS_DIGESTS_IN_APP') === true;
}

/**
 * @param {object} p
 * @param {string} p.key        stable sender key, e.g. 'unworked-comms'
 * @param {string} p.subject    the email subject (becomes the bell title)
 * @param {string} [p.text]     plain-text body; derived from html when absent
 * @param {string} [p.html]
 * @param {string} [p.link]     admin route the digest points at
 * @param {object} [p.metadata]
 * @param {() => Promise<any>} p.sendEmail  the sender's existing mailer call
 * @returns {{ ok: boolean, channel: 'email'|'in_app', result?: any, error?: string, id?: string|null, fallback?: boolean }}
 *
 * Senders that already write their own bell (GBP sync health, call-extraction
 * eval) still get an ops_digest row here: that row is what the Activity feed
 * lists, and it is created only on the email's cadence.
 */
async function deliverOpsDigest({ key, subject, text, html, link = null, metadata = {}, sendEmail }) {
  if (typeof sendEmail !== 'function') throw new Error('deliverOpsDigest: sendEmail is required');
  if (!inAppEnabled()) {
    const result = await sendEmail();
    return emailOutcome(result);
  }
  // Whole body: with the email skipped this row is the only copy.
  const body = String(text || htmlToText(html) || '');
  // Subjects carry aggregated text (customer names, bucket lists); the row
  // keeps the full subject in metadata while the title fits the column.
  const title = String(subject || '').slice(0, MAX_TITLE_CHARS);
  let row = null;
  try {
    row = await notificationService().notifyAdmin(CATEGORY, title, body, {
      link,
      bell: true,
      metadata: { opsKey: key, subject, ...metadata },
    });
  } catch (err) {
    logger.error(`[ops-digest] ${key}: bell write threw: ${err.message}`);
  }
  if (!row) {
    // Never lose a digest to a DB hiccup — fall back to the email path.
    logger.warn(`[ops-digest] ${key}: bell row not written — falling back to email`);
    const result = await sendEmail();
    return { ...emailOutcome(result), fallback: true };
  }
  logger.info(`[ops-digest] ${key}: recorded in-app (${row.id || 'suppressed'}) — email skipped`);
  return { ok: true, channel: 'in_app', id: row.id || null };
}

module.exports = { deliverOpsDigest, inAppEnabled, htmlToText, CATEGORY };
