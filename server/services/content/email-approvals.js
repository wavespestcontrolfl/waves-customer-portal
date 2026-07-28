/**
 * email-approvals.js — email-reply approval loop for parked autonomous
 * content runs (owner directive 2026-07-28).
 *
 * Flow:
 *  1. A run parks as completed_pending_review with an APPROVABLE kind
 *     (named_competitor_review or trust_build_*). The runner fires
 *     notifyParkedRun() (fast path); every poll also SWEEPS for approvable
 *     parked runs with no approval row (crash-safe path — also covers lanes
 *     that park outside the generic hook, e.g. GBP trust-build).
 *  2. The owner replies to the approval email with exactly "approved" or
 *     "not approved" (first non-quoted line).
 *  3. pollReplies() (cron, every 10 min, advisory-locked, gated) reads the
 *     reply mailbox via IMAP (read-only), matches subject tokens, verifies
 *     the FAIL-CLOSED sender allowlist, and executes decisions through
 *     autonomous-review-queue.decideReviewItem — the SAME decision engine
 *     as the admin portal, so run/opportunity transitions and stale-run
 *     binding stay single-sourced.
 *
 * Trust boundary (all three must pass): subject token proves WHICH run;
 * APPROVAL_ALLOWED_SENDERS proves WHO (fail closed — no default: contact@
 * is a shared staff inbox, per the same rule newsletter-proof encodes);
 * an unambiguous first-line decision proves WHAT. Everything else is
 * ignored fail-closed. Sender addresses are masked in logs (AGENTS.md PII
 * rule); the full address lives only in the decision audit record.
 *
 * Execution is claim-first via an 'executing' state: a crash mid-execution
 * is recovered by the next poll (stale-executing sweep); transient failures
 * (engine lock, timeouts) release the claim so the still-present inbox
 * reply retries. decideReviewItem's run-state assertions make re-execution
 * safe (at-least-once with idempotent transitions).
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { maskEmail } = require('../newsletter-proof');

const APPROVABLE_KIND_RE = /^(named_competitor_review|trust_build_\d+_of_\d+)$/;
const TOKEN_RE = /\bEA-[0-9a-f]{8}\b/i;
const SWEEP_WINDOW_DAYS = 14;
const EXECUTING_RECOVERY_MINUTES = 15;
// Transient execution failures (engine advisory lock contention, timeouts,
// connection blips) release the claim so the inbox reply retries next poll.
const TRANSIENT_ERROR_RE = /engine[\s_-]*lock|another (?:run|publish) is in progress|timeout|timed out|ECONN|EAI_AGAIN|deadlock|too many connections|temporar/i;

function emailApprovalsEnabled() {
  const { isEnabled } = require('../../config/feature-gates');
  return isEnabled('contentEmailApprovals');
}

function approvalRecipient() {
  return String(process.env.APPROVAL_EMAIL_TO || 'contact@wavespestcontrol.com').trim();
}

/**
 * FAIL CLOSED: no default approver. contact@ is the shared inbox non-owner
 * staff work from (see newsletter-proof.approvalSenders for the same rule),
 * so the owner must explicitly name approver address(es) via
 * APPROVAL_ALLOWED_SENDERS before any reply can execute a decision.
 */
function allowedSenders() {
  return String(process.env.APPROVAL_ALLOWED_SENDERS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * The mailbox replies actually land in — email.js always sends FROM
 * contact@ (no Reply-To), so this is the contact account regardless of any
 * APPROVAL_EMAIL_TO override. Overridable separately for testing.
 */
function imapMailbox() {
  return {
    user: String(process.env.APPROVAL_IMAP_USER || process.env.GMAIL_USER_EMAIL || 'contact@wavespestcontrol.com').trim(),
    password: process.env.APPROVAL_IMAP_PASSWORD || process.env.GOOGLE_SMTP_PASSWORD || null,
    host: process.env.APPROVAL_IMAP_HOST || 'imap.gmail.com',
  };
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
 * non-quoted line counts — quoted trails ("> approved") and signatures
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

function decodePartBody(headers, body) {
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return body; }
  }
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    return body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

function splitHeadersBody(part) {
  const idxCrlf = part.indexOf('\r\n\r\n');
  const idxLf = part.indexOf('\n\n');
  const headerEnd = idxCrlf !== -1 ? idxCrlf + 4 : idxLf !== -1 ? idxLf + 2 : -1;
  if (headerEnd === -1) return null;
  return { headers: part.slice(0, headerEnd), body: part.slice(headerEnd) };
}

/**
 * Extract readable text from a raw RFC822 message. Recurses through nested
 * multipart containers (multipart/mixed wrapping multipart/alternative is
 * the normal shape for replies with inline signature images), prefers the
 * first text/plain leaf, decodes base64/quoted-printable in single-part
 * messages too, and falls back to a tag-stripped read. Conservative — an
 * unparseable body simply yields no decision.
 */
function extractReplyText(source, depth = 0) {
  const raw = String(source || '');
  if (depth > 4) return '';
  const boundaryMatch = raw.match(/boundary="?([^";\r\n]+)"?/i);
  if (boundaryMatch) {
    const parts = raw.split(`--${boundaryMatch[1]}`).slice(1);
    // First pass: direct text/plain leaves. Second pass: recurse into
    // nested multipart parts.
    for (const part of parts) {
      const split = splitHeadersBody(part);
      if (!split) continue;
      if (/content-type:\s*text\/plain/i.test(split.headers)) {
        return decodePartBody(split.headers, split.body);
      }
    }
    for (const part of parts) {
      const split = splitHeadersBody(part);
      if (!split) continue;
      if (/content-type:\s*multipart\//i.test(split.headers)) {
        const nested = extractReplyText(part, depth + 1);
        if (nested && parseDecision(nested) !== null) return nested;
        if (nested) return nested;
      }
    }
  }
  const split = splitHeadersBody(raw);
  if (!split) return raw;
  const body = decodePartBody(split.headers, split.body);
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
  const senders = allowedSenders();
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
    isCompetitor ? '<p>approved → the post publishes through the normal pipeline; not approved → the draft is dismissed and the topic is closed.</p>'
      : '<p>approved → the draft earns trust-build credit toward auto-publish; not approved → the item is dismissed.</p>',
    senders.length
      ? `<p style="color:#666;font-size:13px;">Replies are accepted only from: ${senders.map(escapeHtml).join(', ')}.</p>`
      : '<p style="color:#b00;font-size:13px;">No approver addresses are configured (APPROVAL_ALLOWED_SENDERS) — replies cannot be processed until one is set.</p>',
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

/**
 * Runner hook (fast path): fetch the freshly-parked run and email it.
 * Fire-and-forget — the sweep in pollReplies() guarantees delivery even if
 * the process dies before this runs.
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

/**
 * Crash-safe discovery: approvable parked runs whose opportunity is still
 * pending_review but that have NO approval row — covers a process exit
 * before the runner hook fired AND lanes that park outside the generic
 * hook (e.g. the GBP trust-build branch).
 */
async function sweepUnnotifiedRuns() {
  const cutoff = new Date(Date.now() - SWEEP_WINDOW_DAYS * 86400_000);
  const orphans = await db('autonomous_runs as r')
    .join('opportunity_queue as o', 'o.id', 'r.opportunity_id')
    .leftJoin('content_email_approvals as a', 'a.run_id', 'r.id')
    .whereNull('a.id')
    .where('r.outcome', 'completed_pending_review')
    .where('r.shadow_mode', false)
    .where('o.status', 'pending_review')
    .where('r.created_at', '>', cutoff)
    .select('r.id', 'r.skip_reason');
  let sent = 0;
  for (const run of orphans) {
    if (!isApprovableKind(run.skip_reason)) continue;
    const result = await notifyParkedRun(run.id).catch((err) => {
      logger.warn(`[email-approvals] sweep notify for run ${run.id} failed: ${err.message}`);
      return null;
    });
    if (result?.sent) sent++;
  }
  return { swept: orphans.length, sent };
}

async function executeDecision(row, decision, sender) {
  // Claim into a RECOVERABLE 'executing' state first (decision + sender
  // persisted), so a crash mid-execution is retried by the recovery sweep
  // instead of losing the owner's decision.
  const claimed = await db('content_email_approvals')
    .where({ id: row.id, status: 'awaiting_reply' })
    .update({ status: 'executing', decision, decided_by: `email:${sender}`, decided_at: new Date(), updated_at: new Date() });
  if (!claimed) return { skipped: 'already_decided' };
  return finishExecution({ ...row, decision, decided_by: `email:${sender}` }, decision, sender);
}

async function finishExecution(row, decision, sender) {
  // Delegate to the SAME decision engine the admin review queue uses —
  // approve/dismiss semantics, opportunity transitions (trust-build →
  // done/trust_build_approved; dismiss → skipped), and the stale-run
  // binding (expectedRunId → 409 when a newer run replaced the emailed
  // one) stay single-sourced. Re-execution after a crash is safe: the
  // run-state assertions there reject an already-transitioned item.
  const reviewQueue = require('./autonomous-review-queue');
  const reviewDecision = decision === 'rejected' ? 'dismiss'
    : row.kind === 'named_competitor_review' ? 'approve_named_competitor'
    : 'approve_trust_build';
  try {
    await reviewQueue.decideReviewItem(row.opportunity_id, {
      decision: reviewDecision,
      reviewer: `email:${sender}`,
      note: 'decided via owner email reply',
      expectedRunId: row.run_id,
    });
    await db('content_email_approvals').where({ id: row.id })
      .update({ status: decision, last_error: null, updated_at: new Date() });
    return { executed: reviewDecision };
  } catch (err) {
    const message = String(err.message || '').slice(0, 500);
    const stale = err.statusCode === 409 && /changed since|newer run/i.test(message);
    if (stale) {
      // The emailed draft was replaced — never apply the reply to a draft
      // the owner didn't see. Supersede and email the current one instead.
      await db('content_email_approvals').where({ id: row.id })
        .update({ status: 'superseded', last_error: message, updated_at: new Date() });
      await notifyAdmin('Approval reply matched an outdated draft', `${row.token}: a newer draft replaced the one you were emailed — nothing was applied. A fresh approval email is on its way.`);
      const latest = await db('autonomous_runs')
        .where({ opportunity_id: row.opportunity_id, outcome: 'completed_pending_review', shadow_mode: false })
        .orderBy('created_at', 'desc').first();
      if (latest && isApprovableKind(latest.skip_reason)) {
        await sendApprovalRequest(latest).catch(() => {});
      }
      return { skipped: 'superseded' };
    }
    if (TRANSIENT_ERROR_RE.test(message)) {
      // Pre-side-effect transient failure: release the claim so the reply
      // (still in the mailbox; the cursor only advances past handled
      // messages) retries next poll.
      await db('content_email_approvals').where({ id: row.id })
        .update({ status: 'awaiting_reply', decision: null, decided_by: null, decided_at: null, last_error: message, updated_at: new Date() });
      const retryErr = new Error(`transient execution failure, will retry: ${message}`);
      retryErr.transient = true;
      throw retryErr;
    }
    // Hard failure AFTER the claim: record + surface loudly — the decision
    // is not silently lost, and the row never re-executes.
    await db('content_email_approvals').where({ id: row.id })
      .update({ status: 'failed', last_error: message, updated_at: new Date() });
    await notifyAdmin('Approval decision failed to execute', `${row.token}: your "${decision}" reply was received but execution failed (${message.slice(0, 200)}). The item is still parked — check /admin/seo.`);
    throw err;
  }
}

/** Recover 'executing' rows orphaned by a crash mid-execution. */
async function recoverExecutingRows() {
  const staleBefore = new Date(Date.now() - EXECUTING_RECOVERY_MINUTES * 60_000);
  const stuck = await db('content_email_approvals')
    .where({ status: 'executing' })
    .where('updated_at', '<', staleBefore);
  for (const row of stuck) {
    const sender = String(row.decided_by || '').replace(/^email:/, '');
    if (!row.decision || !sender) {
      await db('content_email_approvals').where({ id: row.id })
        .update({ status: 'failed', last_error: 'executing row missing decision/sender', updated_at: new Date() });
      continue;
    }
    logger.info(`[email-approvals] recovering executing row ${row.token}`);
    await finishExecution(row, row.decision, sender).catch((err) => {
      if (!err.transient) logger.warn(`[email-approvals] recovery of ${row.token} failed: ${err.message}`);
    });
  }
  return { recovered: stuck.length };
}

async function notifyAdmin(title, body) {
  try {
    const NotificationService = require('../notification-service');
    await NotificationService.create({ recipientType: 'admin', recipientId: null, category: 'content', title, body, link: '/admin/seo' });
  } catch (err) {
    logger.warn(`[email-approvals] admin notification failed: ${err.message}`);
  }
}

async function getCursor() {
  const row = await db('content_email_approval_state').where({ id: 1 }).first();
  return row ? Number(row.last_uid) : null;
}

async function setCursor(uid) {
  await db('content_email_approval_state')
    .insert({ id: 1, last_uid: uid, updated_at: new Date() })
    .onConflict('id')
    .merge({ last_uid: uid, updated_at: new Date() });
}

/**
 * Cron entrypoint (advisory-locked by the scheduler): sweep unnotified
 * runs, retry unsent emails, recover crashed executions, then read the
 * reply mailbox and execute decisions. A persisted UID cursor advances
 * past every HANDLED message (including ambiguous/unauthorized ones, so
 * they notify exactly once); messages are fetched envelope-first and the
 * raw source is downloaded only for token-matching subjects.
 */
async function pollReplies() {
  if (!emailApprovalsEnabled()) return { skipped: 'gate_off' };

  await recoverExecutingRows();
  await sweepUnnotifiedRuns();

  const awaiting = await db('content_email_approvals').where({ status: 'awaiting_reply' });
  if (!awaiting.length) return { checked: 0, decided: 0 };

  // Retry unsent approval emails (first send failed) before polling.
  for (const row of awaiting.filter((r) => !r.email_sent_at)) {
    const run = await db('autonomous_runs').where({ id: row.run_id }).first();
    if (run) await sendApprovalRequest(run).catch((err) => logger.warn(`[email-approvals] resend ${row.token} failed: ${err.message}`));
  }

  const senders = allowedSenders();
  if (!senders.length) {
    logger.warn('[email-approvals] APPROVAL_ALLOWED_SENDERS is not set — replies cannot be processed (fail closed)');
    return { skipped: 'no_approvers_configured' };
  }
  const mailbox = imapMailbox();
  if (!mailbox.password) return { skipped: 'imap_not_configured' };
  const byToken = new Map(awaiting.filter((r) => r.email_sent_at).map((r) => [r.token.toLowerCase(), r]));
  if (!byToken.size) return { checked: 0, decided: 0 };

  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: mailbox.host,
    port: 993,
    secure: true,
    auth: { user: mailbox.user, pass: mailbox.password },
    logger: false,
  });

  let checked = 0; let decided = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const cursor = await getCursor();
      let range;
      if (cursor === null) {
        // First run: seed from the oldest outstanding email's send time.
        const oldest = awaiting.reduce((min, r) => (r.email_sent_at && (!min || r.email_sent_at < min) ? r.email_sent_at : min), null);
        range = { since: new Date((oldest ? new Date(oldest).getTime() : Date.now()) - 3600_000) };
      } else {
        range = `${cursor + 1}:*`;
      }
      let maxUid = cursor || 0;
      for await (const msg of client.fetch(range, { uid: true, envelope: true }, { uid: typeof range === 'string' })) {
        if (msg.uid <= maxUid && typeof range === 'string') continue; // `${n}:*` includes n when mailbox has nothing newer
        maxUid = Math.max(maxUid, msg.uid);
        const subject = msg.envelope?.subject || '';
        const tokenMatch = subject.match(TOKEN_RE);
        if (!tokenMatch) continue;
        const row = byToken.get(tokenMatch[0].toLowerCase());
        if (!row) continue;
        const sender = String(msg.envelope?.from?.[0]?.address || '').toLowerCase();
        // Skip our own outbound approval email (no Re:, no In-Reply-To).
        if (!/^re:/i.test(subject) && !msg.envelope?.inReplyTo) continue;
        checked++;
        if (!senders.includes(sender)) {
          logger.warn(`[email-approvals] reply for ${row.token} from unauthorized sender ${maskEmail(sender)} — ignored`);
          await notifyAdmin('Approval reply from unauthorized sender ignored', `${row.token}: a reply from ${maskEmail(sender)} was ignored. Only the configured approver address(es) may decide.`);
          continue;
        }
        const full = await client.fetchOne(msg.uid, { source: true }, { uid: true });
        const decision = parseDecision(extractReplyText(full?.source));
        if (!decision) {
          logger.info(`[email-approvals] ambiguous reply for ${row.token} from ${maskEmail(sender)} — ignored`);
          await notifyAdmin('Approval reply was ambiguous', `${row.token}: your reply didn't start with "approved" or "not approved" — nothing was done. Reply again with one of those exact words first.`);
          continue;
        }
        try {
          const outcome = await executeDecision(row, decision, sender);
          if (!outcome.skipped) {
            decided++;
            byToken.delete(row.token.toLowerCase());
            logger.info(`[email-approvals] ${row.token} ${decision} by ${maskEmail(sender)} → ${outcome.executed}`);
            await notifyAdmin(`Draft ${decision} via email`, `${row.token} (${row.kind}) ${decision} by ${maskEmail(sender)}.`);
          }
        } catch (err) {
          if (err.transient) {
            // Do NOT advance the cursor past this reply — rewind so the
            // retry re-reads it next poll.
            maxUid = Math.min(maxUid, msg.uid - 1);
            logger.warn(`[email-approvals] ${row.token}: ${err.message}`);
            break; // stop processing; cursor stays before this message
          }
          throw err;
        }
      }
      if (maxUid > (cursor || 0)) await setCursor(maxUid);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { checked, decided };
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
    imapMailbox,
    executeDecision,
    finishExecution,
    recoverExecutingRows,
    sweepUnnotifiedRuns,
    draftPreview,
    TOKEN_RE,
    TRANSIENT_ERROR_RE,
  },
};
