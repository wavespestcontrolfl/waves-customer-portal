/**
 * email-approvals.js — email-reply approval loop for parked autonomous
 * content runs (owner directive 2026-07-28).
 *
 * Flow:
 *  1. The autonomous runner parks a run as completed_pending_review with an
 *     APPROVABLE kind (named_competitor_review or trust_build_*). The runner
 *     calls sendApprovalRequest() fire-and-forget — the owner gets an email
 *     at APPROVAL_EMAIL_TO with a draft preview and a subject token.
 *  2. The owner replies to that email with exactly "approved" or
 *     "not approved" (first non-quoted line of the reply).
 *  3. pollReplies() (cron, every 10 min, gated) reads the inbox via IMAP
 *     (read-only), matches subject tokens against awaiting rows, verifies
 *     the sender allowlist, and executes the decision through the SAME
 *     entrypoints the operator script uses. Everything else — unknown
 *     sender, ambiguous wording, already-decided token — is ignored
 *     fail-closed and surfaced as an admin notification.
 *
 * Only the two kinds with a scripted approve path get emails; other parked
 * kinds (gate_fail, publisher_adapter_unavailable, …) keep their existing
 * admin-bell + manual flow.
 *
 * Trust boundary: the token proves the reply is about a specific run; the
 * sender allowlist (APPROVAL_ALLOWED_SENDERS) proves who decided. Both must
 * pass. A decision is executed at most once (status flip is the guard).
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

const DEFAULT_TO = 'contact@wavespestcontrol.com';
const DEFAULT_ALLOWED = 'contact@wavespestcontrol.com,lakewoodranchpestcontrol1@gmail.com';
const APPROVABLE_KIND_RE = /^(named_competitor_review|trust_build_\d+_of_\d+)$/;
const TOKEN_RE = /\bEA-[0-9a-f]{8}\b/i;

function emailApprovalsEnabled() {
  const { isEnabled } = require('../../config/feature-gates');
  return isEnabled('contentEmailApprovals');
}

function approvalRecipient() {
  return String(process.env.APPROVAL_EMAIL_TO || DEFAULT_TO).trim();
}

function allowedSenders() {
  return String(process.env.APPROVAL_ALLOWED_SENDERS || DEFAULT_ALLOWED)
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isApprovableKind(kind) {
  return APPROVABLE_KIND_RE.test(String(kind || ''));
}

function newToken() {
  return `EA-${crypto.randomBytes(4).toString('hex')}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Parse the owner's decision from reply text. Only the FIRST non-empty,
 * non-quoted line counts — quoted trails ("> approved?") and signatures
 * never decide. Returns 'approved' | 'rejected' | null (ambiguous).
 */
function parseDecision(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) continue; // quoted reply trail
    if (/^On .{0,120}wrote:$/.test(line)) break; // start of quoted original
    if (/^not[\s-]+approved\b/i.test(line)) return 'rejected';
    if (/^approved\b/i.test(line)) return 'approved';
    return null; // first substantive line says something else — fail closed
  }
  return null;
}

/**
 * Extract readable text from a raw RFC822 message. Prefers the text/plain
 * MIME part (decoding quoted-printable / base64); falls back to a
 * tag-stripped whole-source read. Conservative by design — an unparseable
 * body simply yields no decision.
 */
function extractReplyText(source) {
  const raw = String(source || '');
  const boundaryMatch = raw.match(/boundary="?([^";\r\n]+)"?/i);
  if (boundaryMatch) {
    const parts = raw.split(`--${boundaryMatch[1]}`);
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') + 4
        : part.indexOf('\n\n') !== -1 ? part.indexOf('\n\n') + 2 : -1;
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd);
      if (!/content-type:\s*text\/plain/i.test(headers)) continue;
      let body = part.slice(headerEnd);
      if (/content-transfer-encoding:\s*base64/i.test(headers)) {
        try { body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { /* keep raw */ }
      } else if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
        body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      }
      return body;
    }
  }
  // Single-part or unrecognized structure: take everything after the headers,
  // strip tags so an HTML-only reply still yields its text.
  const headerEnd = raw.indexOf('\r\n\r\n') !== -1 ? raw.indexOf('\r\n\r\n') + 4
    : raw.indexOf('\n\n') !== -1 ? raw.indexOf('\n\n') + 2 : 0;
  let body = raw.slice(headerEnd);
  if (/content-transfer-encoding:\s*quoted-printable/i.test(raw.slice(0, headerEnd))) {
    body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function draftPreview(run) {
  let payload = run.draft_payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
  const title = payload?.title || payload?.frontmatter?.title || '(untitled draft)';
  const body = String(payload?.body || payload?.content || '').slice(0, 1200);
  return { title, excerpt: body };
}

/**
 * Send (or re-send after a send failure) the approval email for a parked
 * run. Idempotent per run — a second call returns the existing row and only
 * re-sends when the first send never went out.
 */
async function sendApprovalRequest(run, opportunity = null) {
  if (!emailApprovalsEnabled()) return { skipped: 'gate_off' };
  if (!isApprovableKind(run?.skip_reason)) return { skipped: 'kind_not_approvable' };

  let row = await db('content_email_approvals').where({ run_id: run.id }).first();
  if (!row) {
    [row] = await db('content_email_approvals')
      .insert({
        token: newToken(),
        run_id: run.id,
        opportunity_id: run.opportunity_id || opportunity?.id || null,
        kind: run.skip_reason,
      })
      .onConflict('run_id').ignore()
      .returning('*');
    if (!row) row = await db('content_email_approvals').where({ run_id: run.id }).first();
  }
  if (!row || row.email_sent_at) return { row, skipped: row ? 'already_sent' : 'insert_failed' };

  const email = require('../email');
  const { title, excerpt } = draftPreview(run);
  const isCompetitor = row.kind === 'named_competitor_review';
  const subject = `[${row.token}] Approve? ${title}`;
  const bodyHtml = [
    `<p><strong>${isCompetitor ? 'Named-competitor draft' : 'Trust-build draft'}</strong> is parked for your decision.</p>`,
    `<p><strong>Title:</strong> ${escapeHtml(title)}<br/>`,
    `<strong>Target:</strong> ${escapeHtml(opportunity?.query || run.action_type || '')}<br/>`,
    `<strong>Parked as:</strong> ${escapeHtml(row.kind)}</p>`,
    run.reviewer_notes ? `<p><strong>Reviewer notes:</strong> ${escapeHtml(String(run.reviewer_notes).slice(0, 600))}</p>` : '',
    excerpt ? `<p><strong>Draft opening:</strong></p><blockquote style="border-left:3px solid #ccc;padding-left:10px;color:#444;">${escapeHtml(excerpt)}…</blockquote>` : '',
    '<p><strong>Reply to this email</strong> (keep the subject) with exactly one of:</p>',
    '<p style="font-size:18px;"><strong>approved</strong> &nbsp;—or—&nbsp; <strong>not approved</strong></p>',
    isCompetitor ? '<p>approved → the post publishes through the normal pipeline; not approved → the draft is discarded and the topic is closed.</p>'
      : '<p>approved → the draft earns trust-build credit toward auto-publish; not approved → no credit.</p>',
  ].join('\n');

  const result = await email.send({ to: approvalRecipient(), subject, heading: 'Content approval needed', body: bodyHtml });
  if (result?.ok === false) {
    await db('content_email_approvals').where({ id: row.id }).update({ last_error: String(result.error || 'send failed').slice(0, 500), updated_at: new Date() });
    return { row, sent: false, error: result.error };
  }
  await db('content_email_approvals').where({ id: row.id }).update({ email_sent_at: new Date(), last_error: null, updated_at: new Date() });
  logger.info(`[email-approvals] sent ${row.token} (${row.kind}) for run ${run.id}`);
  return { row, sent: true };
}

async function executeDecision(row, decision, sender) {
  // Claim the row first — the status flip is the at-most-once guard.
  const claimed = await db('content_email_approvals')
    .where({ id: row.id, status: 'awaiting_reply' })
    .update({ status: decision, decided_by: `email:${sender}`, decided_at: new Date(), updated_at: new Date() });
  if (!claimed) return { skipped: 'already_decided' };

  try {
    if (decision === 'approved') {
      if (row.kind === 'named_competitor_review') {
        const runner = require('./autonomous-runner');
        const result = await runner.approveAndPublishNamedCompetitor(row.opportunity_id, { runId: row.run_id, approvedBy: `email:${sender}` });
        return { executed: 'publish', result };
      }
      await db('autonomous_runs').where({ id: row.run_id }).update({
        trust_build_approved_at: new Date(),
        trust_build_approved_by: `email:${sender}`,
        updated_at: new Date(),
      });
      return { executed: 'trust_build_credit' };
    }
    // rejected — close the run + opportunity out of the review queue.
    await db('autonomous_runs')
      .where({ id: row.run_id, outcome: 'completed_pending_review' })
      .update({
        skip_reason: `${row.kind === 'named_competitor_review' ? 'named_competitor' : 'trust_build'}_rejected`,
        reviewer_notes: db.raw(`COALESCE(reviewer_notes, '') || ' | REJECTED via email by ' || ?`, [sender]),
        updated_at: new Date(),
      });
    if (row.opportunity_id) {
      await db('opportunity_queue')
        .where({ id: row.opportunity_id, status: 'pending_review' })
        .update({ status: 'skipped', skip_reason: 'rejected_by_owner_email', updated_at: new Date() });
    }
    return { executed: 'rejected' };
  } catch (err) {
    // Execution failed AFTER the claim: record it and surface loudly — the
    // decision is not silently lost, and the row never re-executes.
    await db('content_email_approvals').where({ id: row.id }).update({ status: 'failed', last_error: String(err.message).slice(0, 500), updated_at: new Date() });
    throw err;
  }
}

async function notifyAdmin(title, body) {
  try {
    const NotificationService = require('../notification-service');
    await NotificationService.create({ recipientType: 'admin', recipientId: null, category: 'content', title, body, link: '/admin/seo' });
  } catch (err) {
    logger.warn(`[email-approvals] admin notification failed: ${err.message}`);
  }
}

/**
 * Cron entrypoint: read the inbox (read-only), match replies to awaiting
 * tokens, execute decisions. Also retries approval emails whose first send
 * failed. Skips the IMAP connection entirely when nothing is awaiting.
 */
async function pollReplies() {
  if (!emailApprovalsEnabled()) return { skipped: 'gate_off' };
  const awaiting = await db('content_email_approvals').where({ status: 'awaiting_reply' });
  if (!awaiting.length) return { checked: 0, decided: 0 };

  // Retry unsent approval emails (first send failed) before polling.
  for (const row of awaiting.filter((r) => !r.email_sent_at)) {
    const run = await db('autonomous_runs').where({ id: row.run_id }).first();
    if (run) await sendApprovalRequest(run).catch((err) => logger.warn(`[email-approvals] resend ${row.token} failed: ${err.message}`));
  }

  const password = process.env.GOOGLE_SMTP_PASSWORD;
  if (!password) return { skipped: 'imap_not_configured' };
  const byToken = new Map(awaiting.filter((r) => r.email_sent_at).map((r) => [r.token.toLowerCase(), r]));
  if (!byToken.size) return { checked: 0, decided: 0 };

  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: process.env.APPROVAL_IMAP_HOST || 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: approvalRecipient(), pass: password },
    logger: false,
  });

  let checked = 0; let decided = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const oldest = awaiting.reduce((min, r) => (r.email_sent_at && (!min || r.email_sent_at < min) ? r.email_sent_at : min), null);
      const since = new Date((oldest ? new Date(oldest).getTime() : Date.now()) - 86400_000);
      for await (const msg of client.fetch({ since }, { envelope: true, source: true })) {
        const subject = msg.envelope?.subject || '';
        const tokenMatch = subject.match(TOKEN_RE);
        if (!tokenMatch) continue;
        const row = byToken.get(tokenMatch[0].toLowerCase());
        if (!row) continue;
        checked++;
        const sender = String(msg.envelope?.from?.[0]?.address || '').toLowerCase();
        if (!sender || sender === approvalRecipient().toLowerCase() && msg.envelope?.inReplyTo == null && !msg.envelope?.subject?.match(/^re:/i)) {
          // Our own outbound approval email (Gmail files sent mail into
          // All Mail; INBOX normally excludes it, but guard anyway): the
          // original has our token and no Re:/In-Reply-To — never a decision.
          continue;
        }
        if (!allowedSenders().includes(sender)) {
          logger.warn(`[email-approvals] reply for ${row.token} from unauthorized sender ${sender} — ignored`);
          await notifyAdmin('Approval reply from unknown sender ignored', `${row.token}: reply from ${sender} was ignored. Only ${allowedSenders().join(', ')} may decide.`);
          continue;
        }
        const decision = parseDecision(extractReplyText(msg.source));
        if (!decision) {
          logger.info(`[email-approvals] ambiguous reply for ${row.token} from ${sender} — ignored (reply must start with "approved" or "not approved")`);
          await notifyAdmin('Approval reply was ambiguous', `${row.token}: your reply didn't start with "approved" or "not approved" — nothing was done. Reply again with one of those exact words first.`);
          continue;
        }
        const outcome = await executeDecision(row, decision, sender);
        if (!outcome.skipped) {
          decided++;
          byToken.delete(row.token.toLowerCase());
          logger.info(`[email-approvals] ${row.token} ${decision} by ${sender} → ${outcome.executed}`);
          await notifyAdmin(`Draft ${decision} via email`, `${row.token} (${row.kind}) ${decision} by ${sender}.`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { checked, decided };
}

/**
 * Runner hook: fetch the freshly-parked run and send the approval email.
 * Fire-and-forget from the runner — a notification failure never affects
 * the run outcome (pollReplies retries unsent emails each cycle).
 */
async function notifyParkedRun(runId) {
  if (!emailApprovalsEnabled()) return { skipped: 'gate_off' };
  const run = await db('autonomous_runs').where({ id: runId }).first();
  if (!run || run.outcome !== 'completed_pending_review' || !isApprovableKind(run.skip_reason)) {
    return { skipped: 'not_approvable' };
  }
  const opp = run.opportunity_id
    ? await db('opportunity_queue').where({ id: run.opportunity_id }).first()
    : null;
  return sendApprovalRequest(run, opp);
}

module.exports = {
  sendApprovalRequest,
  notifyParkedRun,
  pollReplies,
  _internals: {
    parseDecision,
    extractReplyText,
    isApprovableKind,
    newToken,
    allowedSenders,
    approvalRecipient,
    executeDecision,
    draftPreview,
    TOKEN_RE,
  },
};
