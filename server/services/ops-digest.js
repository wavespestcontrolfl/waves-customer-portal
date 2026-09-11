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
// Requires BOTH gates: the digest only has a surface when the Activity feed
// is on, so with GATE_AGENT_ACTIVITY off this fails closed to email.
function inAppEnabled() {
  const gates = featureGates();
  if (typeof gates.gateEnvValue !== 'function') return false;
  return gates.gateEnvValue('GATE_OPS_DIGESTS_IN_APP') === true && gates.gateEnvValue('GATE_AGENT_ACTIVITY') === true;
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

/**
 * Fall-off rule (owner 2026-09-11): an exception bell must not sit unread
 * forever once the condition behind it has cleared. When the check that
 * raised a finding has run clean N times in a row (the runner counts), it
 * asks for the finding's standing rows to be retired: every admin
 * ops_digest row carrying that opsKey (and source, when given) that is not
 * yet resolved is stamped resolved in metadata and, if still unread, marked
 * read. Keyed off the resolved marker, NOT read_at: the owner opening a
 * FIX/ACT bell before the check runs clean must not leave it "needs a fix"
 * forever (pre-push P1). The row stays in the feed as history ("cleared");
 * nothing is deleted. Returns the number of rows retired. Never throws — a
 * failed retire is logged and reported as 0 so the caller can retry on its
 * next clean run.
 */
// `lockKey`: the dedupeKey the matching ingest uses. When given, the retire
// runs in its own transaction under the SAME advisory lock notifyAdmin's
// dedupe takes (`admin:${dedupeKey}`), so an overlapping recurrence and a
// clean-run resolve for one key serialize — never "deduped onto a row that
// is being resolved" nor "fresh failure resolved by the clean run" (codex
// P1 r6 on #4392). Without it the update runs on the shared connection.
// `notAfter`: the clean observation's timestamp. Only rows whose own
// observation is not newer than it retire — the advisory lock serializes
// requests, not observations, so a later failure whose ingest won the lock
// first must survive an earlier clean run's resolve (codex P1 r7 on #4392).
// The row's observation is GREATEST(metadata.observedAt, created_at), not
// observedAt alone: notifyAdmin's refreshOnDedupe merge takes the INCOMING
// metadata verbatim (services/notification-service.js ~line 222 treats a
// dedupeVersion as changed, not as newer), so a slow older run re-posting
// the same key can lower observedAt. created_at is stamped once at insert
// and never moves, so it is the monotonic floor on "when this finding was
// last known live" — the comparison then fails safe (a bell stays up)
// instead of clearing a live failure (pre-push P1).
async function resolveOpsDigest({ key, source = null, resolvedBy = 'ops-crons', lockKey = null, notAfter = null } = {}) {
  const opsKey = String(key || '').trim();
  if (!opsKey) return 0;
  const db = require('../models/db');
  const retire = async (conn) => {
    const stamp = new Date().toISOString();
    let q = conn('notifications')
      .where({ recipient_type: 'admin', category: CATEGORY })
      .whereRaw("COALESCE(metadata->>'resolved', '') <> 'true'")
      .whereRaw("metadata->>'opsKey' = ?", [opsKey]);
    if (source) q = q.whereRaw("metadata->>'source' = ?", [String(source)]);
    if (notAfter) q = q.whereRaw("GREATEST(COALESCE(NULLIF(metadata->>'observedAt', '')::timestamptz, created_at), created_at) <= ?::timestamptz", [notAfter]);
    return q.update({
      read_at: conn.raw('COALESCE(read_at, NOW())'),
      // Drop the dedupeKey with the resolve stamp: a resolved row must never
      // be the "standing" row notifyAdmin's rolling-window dedupe finds, or a
      // finding that clears and recurs inside the window would be swallowed
      // as deduped with no live bell (codex P1 on #4392). opsKey stays for
      // history and the Activity feed.
      metadata: conn.raw("(COALESCE(metadata, '{}'::jsonb) - 'dedupeKey') || ?::jsonb", [JSON.stringify({ resolved: true, resolvedAt: stamp, resolvedBy: String(resolvedBy) })]),
    });
  };
  try {
    const count = lockKey
      ? await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${lockKey}`]);
        return retire(trx);
      })
      : await retire(db);
    logger.info(`[ops-digest] ${opsKey}: retired ${count} standing row(s) (${resolvedBy})`);
    return Number(count) || 0;
  } catch (err) {
    logger.warn(`[ops-digest] ${opsKey}: retire failed: ${err.message}`);
    return 0;
  }
}

module.exports = { deliverOpsDigest, resolveOpsDigest, inAppEnabled, htmlToText, CATEGORY };
