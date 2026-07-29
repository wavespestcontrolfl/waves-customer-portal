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
const SEND_CLAIM_STALE_MINUTES = 10;
// PROVABLY pre-side-effect failures (lock/busy contention happens before
// any work starts; a deadlock rolls the transaction back) — safe to release
// the claim and replay the reply next poll.
const SAFE_RETRY_ERROR_RE = /engine[\s_-]*lock|another (?:run|publish) is in progress|publisher is busy|retry in a moment|deadlock/i;
// AMBIGUOUS failures (timeouts, connection drops): the side effect may have
// completed before the error surfaced — a publish must NOT be blindly
// replayed. The row stays 'executing' and the recovery sweep reconciles
// from the persisted run/opportunity state instead.
const AMBIGUOUS_ERROR_RE = /timeout|timed out|ECONN|EAI_AGAIN|too many connections|temporar/i;

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
// An "approved" prefix is only an approval when the REST of the line is
// recognizably benign — punctuation plus plain acclamation. A blacklist of
// negation words cannot enumerate every conditional ("approved, but fix
// the price first", "approved with one change", "approved — don’t publish
// yet"), so anything outside this whitelist is AMBIGUOUS and nothing
// executes (Codex #3024 r5). Curly apostrophes/dashes included.
const APPROVAL_TRAILER_RE = /^[\s,.!:;()✓👍—–-]*(?:(?:thanks?|thank you|ty|looks good(?: to me)?|lgtm|ship it|go ahead|yes|please|proceed|sounds good|perfect|great|good)[\s,.!]*)*$/i;

function parseDecision(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) continue; // quoted reply trail
    if (/^On .{0,120}wrote:$/.test(line)) break; // start of quoted original
    if (/^not[\s-]+approved\b/i.test(line)) return 'rejected';
    if (/^approved\b/i.test(line)) {
      const rest = line.replace(/^approved\b/i, '');
      return APPROVAL_TRAILER_RE.test(rest) ? 'approved' : null;
    }
    return null; // first substantive line says something else — fail closed
  }
  return null;
}

function decodePartBody(headers, body) {
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return body; }
  }
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    // Decode to BYTES first, then UTF-8 — per-char fromCharCode would
    // mojibake multibyte sequences (=E2=80=94 is one em dash, not three
    // Latin-1 characters), and mojibake in an approval trailer would
    // force ambiguity on a clean reply.
    const joined = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    try { return Buffer.from(joined, 'latin1').toString('utf8'); } catch { return joined; }
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
    // Attachments never decide — a text/plain ATTACHMENT beginning with
    // "approved" must not override the actual reply body (and a harmless
    // attachment must not shadow it either).
    // name= on the Content-Type also marks a named attachment even with an
    // inline/omitted disposition (Codex r5).
    const isAttachment = (headers) => /content-disposition:\s*attachment/i.test(headers) || /\b(?:file)?name\s*=/i.test(headers);
    // Pass 1: direct text/plain BODY leaves. Pass 2: recurse into nested
    // multipart containers (the reply body in a multipart/mixed message is
    // usually a nested multipart/alternative). Attachments are skipped in
    // both passes.
    for (const part of parts) {
      const split = splitHeadersBody(part);
      if (!split || isAttachment(split.headers)) continue;
      if (/content-type:\s*text\/plain/i.test(split.headers)) {
        return decodePartBody(split.headers, split.body);
      }
    }
    for (const part of parts) {
      const split = splitHeadersBody(part);
      if (!split || isAttachment(split.headers)) continue;
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
  return htmlToText(body);
}

/**
 * HTML → line-structured text for decision parsing. Quoted threads
 * (<blockquote>, gmail_quote containers) are REMOVED — flattening them
 * into the typed text would merge the owner's "approved" with the quoted
 * instructions (which contain "not approved") and force ambiguity on every
 * HTML-only reply (Codex r5). Block-level closers become newlines so the
 * first-line rule still means the first thing the owner typed.
 */
function htmlToText(html) {
  let s = String(html || '');
  for (let i = 0; i < 5 && /<blockquote\b/i.test(s); i++) {
    s = s.replace(/<blockquote\b[\s\S]*?<\/blockquote>/gi, ' ');
  }
  // Gmail wraps the quoted thread in <div class="gmail_quote">…; everything
  // from that marker on is quoted history.
  const gq = s.search(/<div[^>]*class="[^"]*gmail_quote/i);
  if (gq !== -1) s = s.slice(0, gq);
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'");
}

// The COMPLETE draft body — a named-competitor approval publishes the whole
// stored draft, so the owner must be able to read every claim before
// replying "approved" (legal/brand surface). Bounded only by a generous
// safety cap far above any real post.
// Gmail clips HTML messages around ~102KB — beyond that the owner sees a
// "[Message clipped]" view and could approve content they never scrolled
// to. Caps keep draft + metadata + template chrome + HTML-escape expansion
// comfortably under the clip line; anything larger routes to the portal
// via the truncation path (Codex r6).
const DRAFT_EMAIL_MAX_CHARS = 60_000;
const METADATA_EMAIL_MAX_CHARS = 12_000;
/**
 * Verify the reply actually authenticated as the claimed sender. The From
 * header is attacker-controlled RFC822 data — authorization additionally
 * requires the RECEIVING server's Authentication-Results header to show
 * DMARC pass (or aligned DKIM pass) for the sender's domain. Only the
 * FIRST Authentication-Results header whose authserv-id matches the
 * trusted receiver (Gmail prepends its own at the top; RFC 8601 receivers
 * strip/displace foreign ones) is consulted, so an attacker-embedded fake
 * header buried in the message cannot vouch for itself. Fail closed.
 */
function verifySenderAuthentication(rawSource, senderAddress) {
  const raw = String(rawSource || '');
  const senderDomain = String(senderAddress || '').split('@')[1]?.toLowerCase();
  if (!senderDomain) return false;
  const headerEndIdx = (() => {
    const a = raw.indexOf('\r\n\r\n'); const b = raw.indexOf('\n\n');
    if (a !== -1 && (b === -1 || a < b)) return a;
    return b !== -1 ? b : raw.length;
  })();
  // Unfold header continuation lines, then take the FIRST
  // Authentication-Results header stamped by the trusted receiver.
  const headers = raw.slice(0, headerEndIdx).replace(/\r?\n[ \t]+/g, ' ');
  const authserv = String(process.env.APPROVAL_AUTHSERV_ID || 'mx.google.com').toLowerCase();
  const authLine = headers.split(/\r?\n/).find((l) => {
    const m = l.match(/^authentication-results:\s*([^\s;]+)/i);
    return m && m[1].toLowerCase() === authserv;
  });
  if (!authLine) return false;
  const line = authLine.toLowerCase();
  // An EXPLICIT DMARC failure is authoritative — the aligned-DKIM fallback
  // exists only for receivers that report no DMARC verdict at all; letting
  // a delegated-subdomain DKIM pass override the domain's own strict DMARC
  // policy would defeat it (Codex r5).
  if (/\bdmarc=fail\b/.test(line)) return false;
  const domRe = senderDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`dmarc=pass[^;]*header\\.from=${domRe}(?:[;\\s]|$)`).test(line)) return true;
  if (new RegExp(`dkim=pass[^;]*header\\.i=@?(?:[a-z0-9.-]+\\.)?${domRe}(?:[;\\s]|$)`).test(line)) return true;
  if (new RegExp(`dkim=pass[^;]*header\\.d=(?:[a-z0-9.-]+\\.)?${domRe}(?:[;\\s]|$)`).test(line)) return true;
  return false;
}

/**
 * Recognizer for email-sync: an approval-token subject is a CONTROL
 * message — it must never reach the classifier or its auto-actions (the
 * IMAP poller owns decisions). Same posture as newsletter-proof traffic.
 */
function isApprovalControlMessage(email = {}) {
  return TOKEN_RE.test(String(email.subject || ''));
}

function draftPreview(run) {
  let payload = run.draft_payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
  const title = payload?.title || payload?.frontmatter?.title || '(untitled draft)';
  const full = String(payload?.body || payload?.content || '');
  const truncated = full.length > DRAFT_EMAIL_MAX_CHARS;
  // Everything else the publisher ships (frontmatter: meta description,
  // hero alt, schema, …) can carry competitor claims too — the owner must
  // see ALL of it before approving, not just the body.
  let metadata = null;
  if (payload && typeof payload === 'object') {
    const meta = { ...(typeof payload.frontmatter === 'object' && payload.frontmatter ? payload.frontmatter : {}) };
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'body' || k === 'content' || k === 'frontmatter') continue;
      meta[k] = v;
    }
    delete meta.title; // shown separately
    if (Object.keys(meta).length) {
      try { metadata = JSON.stringify(meta, null, 1); } catch { metadata = null; }
    }
  }
  const metadataTruncated = !!metadata && metadata.length > METADATA_EMAIL_MAX_CHARS;
  return {
    title,
    body: full.slice(0, DRAFT_EMAIL_MAX_CHARS),
    metadata: metadata ? metadata.slice(0, METADATA_EMAIL_MAX_CHARS) : null,
    // Approval-by-email is only valid when the owner could read EVERYTHING
    // that publishes — any truncation routes the decision to the portal.
    truncated: truncated || metadataTruncated,
  };
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

  // Atomic RECOVERABLE send claim: the runner hook and the ten-minute sweep
  // race on the same unsent row — whoever stamps email_sending_at first
  // sends. email_sent_at is set only AFTER SMTP confirms, so a crash
  // mid-send leaves a stale sending claim that becomes reclaimable after
  // the staleness window instead of stranding the row forever.
  const claimStaleBefore = new Date(Date.now() - SEND_CLAIM_STALE_MINUTES * 60_000);
  const sendClaimed = await db('content_email_approvals')
    .where({ id: row.id })
    .whereNull('email_sent_at')
    .where((q) => q.whereNull('email_sending_at').orWhere('email_sending_at', '<', claimStaleBefore))
    .update({ email_sending_at: new Date(), updated_at: new Date() });
  if (!sendClaimed) return { row, skipped: 'send_claimed_elsewhere' };

  const email = require('../email');
  const { title, body: draftBody, truncated, metadata } = draftPreview(run);
  const isCompetitor = row.kind === 'named_competitor_review';
  const senders = allowedSenders();
  const subject = `[${row.token}] Approve? ${title}`;
  const bodyHtml = [
    `<p><strong>${isCompetitor ? 'Named-competitor draft' : 'Trust-build draft'}</strong> is parked for your decision.</p>`,
    `<p><strong>Title:</strong> ${escapeHtml(title)}<br/>`,
    `<strong>Target:</strong> ${escapeHtml(opportunity?.query || run.action_type || '')}<br/>`,
    `<strong>Parked as:</strong> ${escapeHtml(row.kind)}</p>`,
    run.reviewer_notes ? `<p><strong>Reviewer notes:</strong> ${escapeHtml(String(run.reviewer_notes).slice(0, 600))}</p>` : '',
    // The COMPLETE draft. For named-competitor runs approval PUBLISHES this
    // content; a trust-build approval only grants ramp credit — the label
    // must never promise a publication that doesn't happen (Codex r5).
    draftBody ? `<p><strong>${isCompetitor ? 'Full draft (this exact content publishes on approval):' : 'Full draft (approval grants trust-build credit — this draft does NOT publish now):'}</strong></p><blockquote style="border-left:3px solid #ccc;padding-left:10px;color:#444;white-space:pre-wrap;">${escapeHtml(draftBody)}</blockquote>` : '',
    metadata ? `<p><strong>Metadata (${isCompetitor ? 'also publishes — ' : ''}meta description, alt text, schema):</strong></p><blockquote style="border-left:3px solid #ccc;padding-left:10px;color:#666;white-space:pre-wrap;font-size:12px;">${escapeHtml(metadata)}</blockquote>` : '',
    truncated
      ? '<p style="color:#b00;"><strong>This draft exceeds email size limits, so it cannot be fully shown here. Replying "approved" will NOT execute — review and decide in /admin/seo instead. ("not approved" still works.)</strong></p>'
      : '<p><strong>Reply to this email</strong> (keep the subject) with exactly one of:</p>\n<p style="font-size:18px;"><strong>approved</strong> &nbsp;—or—&nbsp; <strong>not approved</strong></p>',
    isCompetitor ? '<p>approved → the post publishes through the normal pipeline; not approved → the draft is dismissed and the topic is closed.</p>'
      : '<p>approved → the draft earns trust-build credit toward auto-publish (it does not publish now); not approved → the item is dismissed.</p>',
    senders.length
      ? `<p style="color:#666;font-size:13px;">Replies are accepted only from: ${senders.map(escapeHtml).join(', ')}.</p>`
      : '<p style="color:#b00;font-size:13px;">No approver addresses are configured (APPROVAL_ALLOWED_SENDERS) — replies cannot be processed until one is set.</p>',
  ].join('\n');

  const result = await email.send({
    to: approvalRecipient(),
    subject,
    heading: 'Content approval needed',
    body: bodyHtml,
    // Replies must land in the mailbox the poller actually reads —
    // email.js sends FROM the fixed contact@ account, so without this an
    // APPROVAL_IMAP_USER override would poll a mailbox replies never reach.
    replyTo: imapMailbox().user,
  });
  if (result?.ok === false) {
    await db('content_email_approvals').where({ id: row.id }).update({ email_sending_at: null, last_error: String(result.error || 'send failed').slice(0, 500), updated_at: new Date() });
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
  // An oversized draft was never fully shown in the email, so an emailed
  // "approved" must not publish it — the email itself says so and directs
  // the decision to the portal. Rejection is still honored (dismissing
  // unseen content is safe). Checked at DECISION time, not just send time,
  // so a payload edited after the email went out can't slip through.
  if (decision === 'approved') {
    const run = await db('autonomous_runs').where({ id: row.run_id }).first();
    if (run && draftPreview(run).truncated) {
      const marker = 'oversized_approve_ignored';
      if (row.last_error !== marker) {
        await db('content_email_approvals').where({ id: row.id }).update({ last_error: marker, updated_at: new Date() });
        await notifyAdmin('Approval requires the portal', `${row.token}: this draft exceeds email size limits, so your emailed "approved" was NOT executed. Review and approve it in /admin/seo.`);
      }
      return { skipped: 'requires_portal_review' };
    }
  }
  // Claim into a RECOVERABLE 'executing' state first (decision + sender
  // persisted), so a crash mid-execution is retried by the recovery sweep
  // instead of losing the owner's decision.
  const claimed = await db('content_email_approvals')
    .where({ id: row.id, status: 'awaiting_reply' })
    .update({ status: 'executing', decision, decided_by: `email:${sender}`, decided_at: new Date(), updated_at: new Date() });
  if (!claimed) return { skipped: 'already_decided' };
  return finishExecution({ ...row, decision, decided_by: `email:${sender}` }, decision, sender);
}

/**
 * Post-failure reconciliation from PERSISTED state: did the decision's side
 * effect actually happen? Returns an outcome when the persisted run/
 * opportunity state is conclusive, null when genuinely inconclusive.
 * Used by crash recovery AND by unknown execution errors — an exception
 * from decideReviewItem does not prove nothing happened (publication
 * precedes its final bookkeeping reads/writes).
 */
async function reconcileFromPersistedState(row, decision) {
  if (!row.opportunity_id) return null;
  const run = row.run_id ? await db('autonomous_runs').where({ id: row.run_id }).first() : null;
  const prOpened = run?.skip_reason === 'astro_pr_pending_merge';
  const publishedLive = /^(completed_published|done)$/.test(String(run?.outcome || ''));
  if (decision === 'approved' && (prOpened || publishedLive)) {
    await db('content_email_approvals').where({ id: row.id }).update({
      status: 'approved',
      last_error: `reconciled: run ${prOpened ? 'astro_pr_pending_merge' : run.outcome}`,
      updated_at: new Date(),
    });
    return { executed: 'reconciled' };
  }
  const opp = await db('opportunity_queue').where({ id: row.opportunity_id }).first();
  const st = opp?.status;
  if (st === 'claimed' && decision === 'approved') {
    // Publish in flight (the runner's own janitor owns this transient
    // state) — stay 'executing' and let a later sweep re-check.
    return { skipped: 'in_flight' };
  }
  if (st && st !== 'pending_review') {
    const matches = decision === 'approved' ? st === 'done' : st === 'skipped';
    await db('content_email_approvals').where({ id: row.id }).update({
      status: matches ? decision : 'superseded',
      last_error: `reconciled: opportunity ${st}`,
      updated_at: new Date(),
    });
    return matches ? { executed: 'reconciled' } : { skipped: 'superseded' };
  }
  return null; // still pending_review — the decision demonstrably did not land
}

async function finishExecution(row, decision, sender, { recovery = false } = {}) {
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
    // Crash recovery replaying a decision that ALREADY committed before the
    // process died: reconcile from persisted state instead of reporting a
    // false failure to the owner.
    if (recovery) {
      const reconciled = await reconcileFromPersistedState(row, decision);
      if (reconciled) return reconciled;
    }
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
    if (SAFE_RETRY_ERROR_RE.test(message)) {
      // Provably pre-side-effect: release the claim so the reply (still in
      // the mailbox; the cursor only advances past handled messages)
      // retries next poll.
      await db('content_email_approvals').where({ id: row.id })
        .update({ status: 'awaiting_reply', decision: null, decided_by: null, decided_at: null, last_error: message, updated_at: new Date() });
      const retryErr = new Error(`transient execution failure, will retry: ${message}`);
      retryErr.transient = true;
      throw retryErr;
    }
    if (AMBIGUOUS_ERROR_RE.test(message)) {
      // The side effect may already have happened (e.g. a publish that
      // timed out after opening the PR) — never blind-replay. The row stays
      // 'executing' with the decision persisted; the recovery sweep
      // reconciles from the actual run/opportunity state.
      await db('content_email_approvals').where({ id: row.id })
        .update({ last_error: `ambiguous failure, pending recovery: ${message}`.slice(0, 500), updated_at: new Date() });
      logger.warn(`[email-approvals] ${row.token}: ambiguous execution failure — left for recovery reconcile (${message.slice(0, 120)})`);
      return { skipped: 'ambiguous_failure_pending_recovery' };
    }
    // Unknown error: it may have surfaced AFTER the side effect
    // (publication precedes decideReviewItem's final bookkeeping), so
    // check persisted state before declaring failure (Codex r5).
    const reconciled = await reconcileFromPersistedState(row, decision).catch(() => null);
    if (reconciled) return reconciled;
    // Conclusively did not land: record + surface loudly — the decision is
    // not silently lost, and the row never re-executes.
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
    // A named-competitor APPROVE that failed ambiguously must never be
    // blind-retried: the astro publisher may have created its branch/PR
    // before the timeout while the runner reverted the DB claims — a
    // retry would open a SECOND PR (Codex r6). Reconcile from persisted
    // state; if inconclusive, hand to a human with the dangling-PR
    // warning. Trust-build/dismiss are pure DB transactions and keep
    // auto-retrying.
    const ambiguousApprove = row.kind === 'named_competitor_review'
      && row.decision === 'approved'
      && /^ambiguous failure/.test(String(row.last_error || ''));
    if (ambiguousApprove) {
      const reconciled = await reconcileFromPersistedState(row, row.decision).catch(() => null);
      if (!reconciled) {
        await db('content_email_approvals').where({ id: row.id })
          .update({ status: 'failed', last_error: `${row.last_error} | not auto-retried: possible dangling publish`, updated_at: new Date() });
        await notifyAdmin('Approval needs a manual check', `${row.token}: your approval hit an ambiguous failure mid-publish. Before re-approving in /admin/seo, check the astro repo for a dangling draft PR from this run.`);
      }
      continue;
    }
    logger.info(`[email-approvals] recovering executing row ${row.token}`);
    await finishExecution(row, row.decision, sender, { recovery: true }).catch((err) => {
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

/**
 * IMAP UIDs are only meaningful within one (mailbox user, UIDVALIDITY)
 * scope. A cursor recorded against a different mailbox or a regenerated
 * INBOX is discarded (returns null → date-based reseed) rather than
 * silently skipping every new reply.
 */
async function getCursor({ uidValidity, mailboxUser }) {
  const row = await db('content_email_approval_state').where({ id: 1 }).first();
  if (!row) return null;
  if (String(row.mailbox_user || '') !== String(mailboxUser)
    || String(row.uid_validity || '') !== String(uidValidity)) {
    logger.info('[email-approvals] IMAP cursor scope changed (mailbox/UIDVALIDITY) — resetting cursor');
    return null;
  }
  return Number(row.last_uid);
}

async function setCursor(uid, { uidValidity, mailboxUser }) {
  await db('content_email_approval_state')
    .insert({ id: 1, last_uid: uid, uid_validity: String(uidValidity), mailbox_user: mailboxUser, updated_at: new Date() })
    .onConflict('id')
    .merge({ last_uid: uid, uid_validity: String(uidValidity), mailbox_user: mailboxUser, updated_at: new Date() });
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
  if (!awaiting.some((r) => r.email_sent_at)) return { checked: 0, decided: 0 };

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
      const scope = { uidValidity: client.mailbox?.uidValidity, mailboxUser: mailbox.user };
      const cursor = await getCursor(scope);
      let range;
      if (cursor === null) {
        // First run (or cursor scope reset): seed from the oldest
        // outstanding email's send time.
        const oldest = awaiting.reduce((min, r) => (r.email_sent_at && (!min || r.email_sent_at < min) ? r.email_sent_at : min), null);
        range = { since: new Date((oldest ? new Date(oldest).getTime() : Date.now()) - 3600_000) };
      } else {
        range = `${cursor + 1}:*`;
      }
      // PHASE 1 — drain the fetch generator completely, collecting only
      // envelope-level candidates. ImapFlow forbids issuing another IMAP
      // command while the fetch generator is being consumed (the outer
      // FETCH pauses under backpressure and the nested command deadlocks),
      // so message sources are downloaded in phase 2, after this loop ends.
      const candidates = [];
      let maxUid = cursor || 0;
      for await (const msg of client.fetch(range, { uid: true, envelope: true }, { uid: typeof range === 'string' })) {
        if (msg.uid <= maxUid && typeof range === 'string') continue; // `${n}:*` includes n when mailbox has nothing newer
        maxUid = Math.max(maxUid, msg.uid);
        const subject = msg.envelope?.subject || '';
        const tokenMatch = subject.match(TOKEN_RE);
        if (!tokenMatch) continue;
        // Skip our own outbound approval email (no Re:, no In-Reply-To).
        if (!/^re:/i.test(subject) && !msg.envelope?.inReplyTo) continue;
        // Row resolution is deferred to phase 2 with a FRESH db read — an
        // approval created after this poll's snapshot (runner hook racing
        // the sweep) must not have its reply discarded while the cursor
        // advances past it.
        candidates.push({
          uid: msg.uid,
          token: tokenMatch[0].toLowerCase(),
          sender: String(msg.envelope?.from?.[0]?.address || '').toLowerCase(),
        });
      }
      // PHASE 2 — process candidates in mailbox order, fetching each source
      // individually now that the generator is fully drained.
      candidates.sort((a, b) => a.uid - b.uid);
      for (const cand of candidates) {
        const { sender } = cand;
        // Fresh row read (see phase-1 note): tokens without any row are
        // stale/junk and the cursor may pass them; an already-decided row
        // is a duplicate reply.
        const row = await db('content_email_approvals').whereRaw('LOWER(token) = ?', [cand.token]).first();
        if (!row || row.status !== 'awaiting_reply' || !row.email_sent_at) continue;
        checked++;
        if (!senders.includes(sender)) {
          logger.warn(`[email-approvals] reply for ${row.token} from unauthorized sender ${maskEmail(sender)} — ignored`);
          await notifyAdmin('Approval reply from unauthorized sender ignored', `${row.token}: a reply from ${maskEmail(sender)} was ignored. Only the configured approver address(es) may decide.`);
          continue;
        }
        const full = await client.fetchOne(cand.uid, { source: true }, { uid: true });
        // Allowlist alone is spoofable (From is sender-asserted): the
        // receiving server's DMARC/DKIM verdict must vouch for the domain.
        if (!verifySenderAuthentication(full?.source, sender)) {
          logger.warn(`[email-approvals] reply for ${row.token} from ${maskEmail(sender)} FAILED sender authentication (DMARC/DKIM) — ignored`);
          await notifyAdmin('Approval reply failed authentication', `${row.token}: a reply claiming to be from ${maskEmail(sender)} did not pass DMARC/DKIM at the mail server and was ignored. If this was really you, reply again from your normal mail app (not a relay that breaks DKIM).`);
          continue;
        }
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
            logger.info(`[email-approvals] ${row.token} ${decision} by ${maskEmail(sender)} → ${outcome.executed}`);
            await notifyAdmin(`Draft ${decision} via email`, `${row.token} (${row.kind}) ${decision} by ${maskEmail(sender)}.`);
          }
        } catch (err) {
          if (err.transient) {
            // Do NOT advance the cursor past this reply — rewind so the
            // retry re-reads it next poll.
            maxUid = Math.min(maxUid, cand.uid - 1);
            logger.warn(`[email-approvals] ${row.token}: ${err.message}`);
            break; // stop processing; cursor stays before this message
          }
          throw err;
        }
      }
      if (maxUid > (cursor || 0)) await setCursor(maxUid, scope);
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
  isApprovalControlMessage,
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
    verifySenderAuthentication,
    reconcileFromPersistedState,
    htmlToText,
    draftPreview,
    TOKEN_RE,
    SAFE_RETRY_ERROR_RE,
    AMBIGUOUS_ERROR_RE,
  },
};
