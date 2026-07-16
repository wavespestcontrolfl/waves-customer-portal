/**
 * Newsletter proof-approval flow.
 *
 * When the weekly autopilot drafts the flagship newsletter and the draft
 * passes the same validation gate the manual Send button enforces, a proof
 * copy is emailed to the owner (contact@) with a [PROOF-<token>] subject.
 * Replying "approved" to that email — from an allowlisted owner address —
 * releases the real list send through the existing sendCampaign path. Any
 * other reply (or no reply) leaves the draft untouched: the flow fails
 * closed, and the list send still ultimately happens through the same
 * atomic draft→sending claim as a manual send.
 *
 * Everything is gated behind GATE_NEWSLETTER_PROOF_APPROVAL (default OFF).
 * Kill switch: unset the gate — no proofs go out and approval replies are
 * ignored.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const NewsletterSender = require('./newsletter-sender');
const { wrapNewsletter } = require('./email-template');
const { validateNewsletterDraft } = require('./newsletter-validator');
const { requiresClaimValidation } = require('../config/newsletter-types');
const { assertInternalEmailRecipient, normalizeEmail } = require('../utils/internal-email-recipients');

const PROOF_SUBJECT_RE = /\[PROOF-([0-9a-f]{8})\]/i;
const DEFAULT_PROOF_RECIPIENT = 'contact@wavespestcontrol.com';

function isProofApprovalEnabled() {
  return process.env.GATE_NEWSLETTER_PROOF_APPROVAL === 'true';
}

function proofRecipient() {
  return normalizeEmail(process.env.NEWSLETTER_PROOF_EMAIL || DEFAULT_PROOF_RECIPIENT);
}

/**
 * The mailbox the Gmail sync actually watches — approval replies MUST land
 * there or maybeHandleProofApproval never sees them. Reply-To on the proof
 * is forced to this address so a proof recipient reading from a personal
 * address still routes the approval back into the synced inbox.
 */
function syncedApprovalMailbox() {
  return normalizeEmail(process.env.GMAIL_USER_EMAIL || DEFAULT_PROOF_RECIPIENT);
}

/**
 * Addresses whose "approved" reply is allowed to release the list send.
 * FAIL CLOSED: no default. The obvious default (contact@) is the shared
 * inbox non-owner staff work from, and approval is From-address-based —
 * so the operator must explicitly name the approver address(es) via
 * NEWSLETTER_PROOF_APPROVERS before any reply can release a broadcast.
 */
function approvalSenders() {
  return String(process.env.NEWSLETTER_PROOF_APPROVERS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
}

/** PII-safe form of an email address for log lines: "co***@domain.com". */
function maskEmail(email) {
  const n = normalizeEmail(email);
  const at = n.indexOf('@');
  if (at <= 0) return '(invalid)';
  return `${n.slice(0, Math.min(2, at))}***@${n.slice(at + 1)}`;
}

/** Extract the proof token from an email subject ("Re: [PROOF-ab12cd34] …"). */
function parseProofToken(subject) {
  const m = PROOF_SUBJECT_RE.exec(String(subject || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Keep only the freshly-typed part of a reply: drop quoted lines and
 * everything below the first reply-quote separator so an "approved" that
 * merely appears inside the quoted proof banner can't trigger a send.
 */
function extractTopReplyText(bodyText) {
  const lines = String(bodyText || '').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) continue;
    if (/^On .{0,200}wrote:\s*$/i.test(trimmed)) break;
    if (/^-{2,}\s*(Original|Forwarded) Message/i.test(trimmed)) break;
    if (/^From:\s/i.test(trimmed)) break;
    if (/^_{5,}\s*$/.test(trimmed)) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * Convert an HTML-only reply into text WITHOUT destroying the quote
 * structure. A naive strip-tags pass flattens the quoted proof banner
 * ("Reply APPROVED…") into the same line as the typed reply, letting a
 * non-approval reply match. So: drop quoted containers entirely
 * (blockquote / gmail_quote / yahoo_quoted), keep block boundaries as
 * newlines, THEN strip tags — extractTopReplyText still runs after this
 * as the text-path defense.
 */
function htmlReplyToText(html) {
  let s = String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // innermost-first so nested quote blocks all disappear; bounded loop
  for (let i = 0; i < 10 && /<blockquote/i.test(s); i++) {
    s = s.replace(/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote>/gi, '\n');
  }
  // Gmail/Yahoo wrap the whole quoted thread in a marker div — drop from
  // the marker to the end (the typed reply always precedes it). Class
  // attributes may be double-quoted, single-quoted, or bare.
  s = s.replace(/<div[^>]*class\s*=\s*(?:"[^"]*(?:gmail_quote|yahoo_quoted)[^"]*"|'[^']*(?:gmail_quote|yahoo_quoted)[^']*'|[^\s>]*(?:gmail_quote|yahoo_quoted)[^\s>]*)[\s\S]*$/i, '\n');
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    // Decode entities BEFORE the approval matcher runs: "don&rsquo;t" /
    // "can&#8217;t" must become don't/can't or the negation guard never
    // sees them (numeric first, then named; &amp; strictly last).
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
    .replace(/&(rsquo|lsquo|apos);/gi, "'")
    .replace(/&(rdquo|ldquo|quot);/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim();
}

/**
 * Fail-closed approval matcher: the un-quoted reply text must contain
 * "approve"/"approved" and must not negate it.
 */
function isApprovalReply(text) {
  // Normalize smart apostrophes first — iOS/macOS type "don’t"/"can’t"
  // with U+2019, which would sail past ASCII-only negation alternatives.
  const t = String(text || '').toLowerCase().replace(/[‘’ʼ]/g, "'");
  if (!/\bapproved?\b/.test(t)) return false;
  // Negation guard: a negating/hold word ANYWHERE in the typed reply fails
  // closed — "not approved", "can't approve yet", and equally "approved?
  // no" / "approved — wait, don't send" must all leave the draft alone.
  // Ambiguity always loses; the owner can reply a clean "approved".
  if (/\b(not|no|nope|don'?t|do\s+not|can'?t|cannot|can\s+not|won'?t|isn'?t|never|nevermind|never\s+mind|hold|wait|stop|reject|cancel|abort|disregard|revoke)\b/.test(t)) return false;
  return true;
}

/**
 * Render a send the way the live broadcast will look for one internal
 * recipient: same wrapper, all merge tags ({{greeting-name}}, {{city}},
 * {{grass-type}}) resolved from the recipient's subscriber row, quiz tokens
 * neutralized (no per-recipient delivery row exists to build live quiz
 * links from). Shared by the operator test-send route and the proof email
 * so the two previews can never drift apart.
 */
async function renderSendPreview(send, toEmail) {
  const {
    GREETING_NAME_TOKEN, greetingNameValueFor,
    CITY_TOKEN, GRASS_TYPE_TOKEN, DEFAULT_CITY_LABEL, DEFAULT_GRASS_LABEL,
  } = require('./newsletter-draft');
  const { neutralizeQuizTokens } = require('./newsletter-quiz');

  // Demo unsubscribe URL — won't resolve to a real subscriber but the link
  // renders correctly and Gmail/Apple Mail will show the native unsub UI.
  const demoUrl = sendgrid.unsubscribeUrl('test-' + send.id);
  let html = wrapNewsletter({
    body: send.html_body || '',
    unsubscribeUrl: demoUrl,
    preheader: send.preview_text || undefined,
    newsletterType: send.newsletter_type || undefined,
    preferredSourcesCta: true,
  });

  const testSub = await db('newsletter_subscribers')
    .whereRaw('LOWER(email) = ?', [String(toEmail).toLowerCase()])
    .first();
  const greetingValue = greetingNameValueFor(testSub?.first_name);
  let cityValue = DEFAULT_CITY_LABEL;
  let grassValue = DEFAULT_GRASS_LABEL;
  if (testSub?.customer_id) {
    const pctx = (await NewsletterSender.loadPersonalizationContext([testSub])).get(testSub.customer_id);
    if (pctx) {
      cityValue = pctx.city || DEFAULT_CITY_LABEL;
      grassValue = pctx.grassLabel || DEFAULT_GRASS_LABEL;
    }
  }
  const applyTokens = (s) => neutralizeQuizTokens(
    String(s)
      .split(GREETING_NAME_TOKEN).join(greetingValue)
      .split(CITY_TOKEN).join(cityValue)
      .split(GRASS_TYPE_TOKEN).join(grassValue),
  );
  html = applyTokens(html);
  const text = send.text_body ? applyTokens(send.text_body) : undefined;
  return { html, text, unsubscribeUrl: demoUrl };
}

function proofBannerHtml(recipientCount) {
  return `<div style="border:2px solid #04395E;border-radius:8px;padding:14px 16px;margin:0 0 20px;background:#f4f8fb;font-family:Arial,Helvetica,sans-serif;">
<p style="margin:0 0 6px;font-size:15px;font-weight:bold;color:#04395E;">Proof — not yet sent to the list</p>
<p style="margin:0;font-size:14px;color:#1f2937;">Reply <strong>APPROVED</strong> to this email and it goes out to <strong>${recipientCount}</strong> active subscribers. Any other reply — or no reply — and it stays a draft in the composer.</p>
</div>\n`;
}

function proofBannerText(recipientCount) {
  return `PROOF — NOT YET SENT TO THE LIST\nReply APPROVED to this email and it goes out to ${recipientCount} active subscribers. Any other reply (or no reply) and it stays a draft.\n\n----------------------------------------\n\n`;
}

async function countRecipients(send) {
  const customerIds = await NewsletterSender.resolveSegmentCustomerIds(send.segment_filter);
  const row = await NewsletterSender.buildSubscriberQuery(send.segment_filter, customerIds)
    .count('* as c')
    .first();
  return Number(row?.c || 0);
}

async function notifyProof(type, payload) {
  try {
    const { triggerNotification } = require('./notification-triggers');
    await triggerNotification(type, payload);
  } catch (e) {
    logger.warn(`[newsletter-proof] ${type} notification failed: ${e.message}`);
  }
}

/**
 * Send the proof email for a draft. Idempotent: a send that already has
 * proof_sent_at (or isn't a draft anymore) is skipped, so the Thu–Sun
 * catch-up cron re-running the autopilot can call this safely every tick.
 *
 * @returns {{ sent?: boolean, skipped?: boolean, reason?: string }}
 */
async function sendNewsletterProof(sendId) {
  if (!isProofApprovalEnabled()) return { skipped: true, reason: 'gate_off' };
  // Fail closed when no explicit approver is configured: a proof whose
  // approval reply can never be honored would just mislead the owner.
  if (approvalSenders().length === 0) {
    logger.warn('[newsletter-proof] gate is on but NEWSLETTER_PROOF_APPROVERS is unset — no proof sent (fail closed)');
    return { skipped: true, reason: 'no_approvers_configured' };
  }
  if (!sendgrid.isConfigured()) return { skipped: true, reason: 'sendgrid_not_configured' };

  const send = await db('newsletter_sends').where({ id: sendId }).first();
  if (!send) return { skipped: true, reason: 'not_found' };
  if (send.status !== 'draft') return { skipped: true, reason: `status_${send.status}` };
  if (send.proof_sent_at) return { skipped: true, reason: 'proof_already_sent' };
  if (!send.html_body && !send.text_body) return { skipped: true, reason: 'empty_body' };

  const to = assertInternalEmailRecipient(proofRecipient());

  // Same gate the manual Send button enforces — a draft that would be
  // blocked from sending gets no proof, it gets a "fix me" notification.
  const recipientCount = await countRecipients(send);
  if (recipientCount === 0) {
    await notifyProof('newsletter_proof_blocked', {
      subject: send.subject,
      errors: ['Segment matches 0 active subscribers'],
    });
    return { skipped: true, reason: 'zero_recipients' };
  }
  if (requiresClaimValidation(send.newsletter_type)) {
    const { errors } = validateNewsletterDraft(send, { recipientCount });
    if (errors.length > 0) {
      await notifyProof('newsletter_proof_blocked', { subject: send.subject, errors });
      return { skipped: true, reason: 'validation_failed', errors };
    }
  }

  // Atomic proof claim BEFORE the external SendGrid call: overlapping
  // autopilot/catch-up workers must not both email proofs (the second
  // token would overwrite the first, making its reply a dead letter).
  // One `now` for both stamps so the approval-time staleness check
  // (updated_at > proof_sent_at) has an exact baseline. The claim is also
  // version-guarded on the fetched row's updated_at: an admin edit between
  // our read and this write would otherwise be silently overwritten with
  // updated_at === proof_sent_at — masking the edit from the staleness
  // gate while we email a proof rendered from the pre-edit body.
  const token = crypto.randomBytes(4).toString('hex');
  const now = new Date();
  const claimQuery = db('newsletter_sends')
    .where({ id: send.id })
    .whereNull('proof_sent_at');
  // Millisecond-truncated comparison: DB-defaulted rows carry microsecond
  // updated_at while node-pg hands back millisecond Dates — an exact
  // equality guard would spuriously fail the very first proof of a fresh
  // draft.
  if (send.updated_at) {
    claimQuery.whereRaw(
      "date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ?::timestamptz)",
      [send.updated_at],
    );
  }
  const claimed = await claimQuery.update({ proof_token: token, proof_sent_at: now, updated_at: now });
  if (!claimed) return { skipped: true, reason: 'proof_claimed_elsewhere' };

  try {
    const { html, text } = await renderSendPreview({
      ...send,
      html_body: proofBannerHtml(recipientCount) + (send.html_body || ''),
      text_body: send.text_body ? proofBannerText(recipientCount) + send.text_body : send.text_body,
    }, to);

    const result = await sendgrid.sendOne({
      to,
      fromEmail: send.from_email,
      fromName: send.from_name,
      subject: `[PROOF-${token}] ${send.subject}`,
      html,
      text,
      // The reply must land in the mailbox the Gmail sync watches or the
      // approval handler never sees it — Reply-To is always the synced
      // inbox, even when the proof recipient is a different address.
      replyTo: syncedApprovalMailbox(),
      categories: ['newsletter_proof', `send_${send.id}`],
      // Deliberately NO ASM group: the proof is an internal control
      // message; newsletter unsub/suppression state must never be able to
      // silently swallow it.
    });

    await notifyProof('newsletter_proof_sent', {
      subject: send.subject,
      recipient: maskEmail(to),
      recipientCount,
    });

    logger.info(`[newsletter-proof] proof sent for ${send.id} (token ${token}, messageId ${result?.messageId || 'n/a'})`);
    return { sent: true, token };
  } catch (sendErr) {
    // Release OUR claim (token-scoped) so the catch-up tick can retry a
    // transient SendGrid failure instead of the week silently losing its
    // proof.
    try {
      await db('newsletter_sends')
        .where({ id: send.id, proof_token: token })
        .update({ proof_token: null, proof_sent_at: null, updated_at: new Date() });
    } catch (clearErr) {
      logger.error(`[newsletter-proof] failed to release proof claim for ${send.id}: ${clearErr.message}`);
    }
    logger.error(`[newsletter-proof] proof send failed for ${send.id}: ${sendErr.message}`);
    return { skipped: true, reason: 'proof_send_failed' };
  }
}

/**
 * Inbound-email hook (called from the Gmail sync on every newly stored
 * email). Detects a reply to a proof email and, when it is an allowlisted
 * owner saying "approved", releases the list send.
 *
 * Returns true when the email was recognized as proof-approval traffic
 * (whether or not it resulted in a send); false = not ours, continue the
 * normal pipeline.
 */
async function maybeHandleProofApproval(email) {
  if (!isProofApprovalEnabled()) return false;

  const token = parseProofToken(email?.subject);
  if (!token) return false;

  const from = normalizeEmail(email?.from_address);
  // Ignore our own outbound proof (SendGrid copies can sync back in):
  // a proof has no "Re:" and comes FROM the newsletter address — the
  // send-side guard below (approved-text required) already makes it inert,
  // but the sender allowlist is the real boundary. Sender is logged
  // masked — full addresses in logs are PII.
  if (!approvalSenders().includes(from)) {
    logger.info(`[newsletter-proof] ignoring [PROOF-${token}] email from non-approver ${maskEmail(from)}`);
    return false;
  }

  const send = await db('newsletter_sends').where({ proof_token: token }).first();
  if (!send) {
    logger.warn(`[newsletter-proof] approval reply with unknown token ${token}`);
    return false;
  }
  if (send.proof_approved_at) {
    logger.info(`[newsletter-proof] send ${send.id} already approved — ignoring duplicate reply`);
    return true;
  }

  // HTML-only replies go through the quote-aware converter — a naive tag
  // strip would flatten the quoted proof banner ("Reply APPROVED…") into
  // the checked text and let a non-approval reply match.
  const replyText = extractTopReplyText(email.body_text || htmlReplyToText(email.body_html));
  if (!isApprovalReply(replyText)) {
    logger.info(`[newsletter-proof] reply for send ${send.id} did not say "approved" — leaving draft untouched`);
    return true;
  }

  // Drafts ONLY. A 'scheduled' row means the operator already picked a
  // future send time — an approval reply must not overwrite that schedule
  // and broadcast immediately.
  if (send.status !== 'draft') {
    logger.info(`[newsletter-proof] send ${send.id} is ${send.status} — approval reply is a no-op`);
    return true;
  }

  // Staleness gate: the proof stamps proof_sent_at === updated_at in one
  // write, so ANY later edit (composer PATCH bumps updated_at) means the
  // owner approved content that was never proofed. Refuse, invalidate the
  // stale proof, and immediately issue a fresh one for the edited draft.
  if (send.proof_sent_at && send.updated_at
      && new Date(send.updated_at).getTime() > new Date(send.proof_sent_at).getTime()) {
    logger.info(`[newsletter-proof] send ${send.id} was edited after its proof — refusing stale approval, re-proofing`);
    await notifyProof('newsletter_proof_blocked', {
      subject: send.subject,
      errors: ['Draft was edited after the proof went out — approval refused. A fresh proof of the edited draft is on its way; reply APPROVED to that one.'],
    });
    try {
      await db('newsletter_sends')
        .where({ id: send.id, proof_token: token })
        .update({ proof_token: null, proof_sent_at: null, updated_at: new Date() });
      await sendNewsletterProof(send.id);
    } catch (reproofErr) {
      logger.error(`[newsletter-proof] re-proof after stale approval failed for ${send.id}: ${reproofErr.message}`);
    }
    return true;
  }

  // Re-run the manual Send button's gates at approval time — the draft may
  // have been edited between proof and approval.
  const recipientCount = await countRecipients(send);
  if (recipientCount === 0) {
    await notifyProof('newsletter_proof_blocked', {
      subject: send.subject,
      errors: ['Approved, but segment matches 0 active subscribers — nothing sent'],
    });
    return true;
  }
  if (requiresClaimValidation(send.newsletter_type)) {
    const { errors } = validateNewsletterDraft(send, { recipientCount });
    if (errors.length > 0) {
      await notifyProof('newsletter_proof_blocked', {
        subject: send.subject,
        errors: ['Approved, but validation now fails — nothing sent', ...errors],
      });
      return true;
    }
  }

  // Atomic approval claim: two synced copies of the same reply (or a race
  // with a manual Send click) can't both dispatch. Version-guarded on the
  // exact row this approval was checked against — token, status, AND
  // updated_at — so an edit or re-proof landing between the staleness
  // check above and this write turns the claim into a 0-row no-op instead
  // of broadcasting content the owner never proofed.
  // The claim also flips the row to 'scheduled' with scheduled_for = now:
  // the scheduler's processScheduledSends tick is the DURABLE executor, so
  // a process crash between this commit and the dispatch below can't
  // strand an approved campaign as an unsendable draft. The immediate
  // dispatch below is just the fast path — sendCampaign's atomic
  // scheduled→sending claim keeps the two from double-sending.
  const approvalClaim = db('newsletter_sends')
    .where({ id: send.id, proof_token: token, status: send.status })
    .whereNull('proof_approved_at');
  // ms-truncated for the same node-pg precision reason as the proof claim
  if (send.updated_at) {
    approvalClaim.whereRaw(
      "date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ?::timestamptz)",
      [send.updated_at],
    );
  }
  const claimed = await approvalClaim.update({
    proof_approved_at: new Date(),
    proof_approval_email_id: email.id || null,
    status: 'scheduled',
    scheduled_for: new Date(),
    updated_at: new Date(),
  });
  if (!claimed) {
    logger.info(`[newsletter-proof] approval claim for send ${send.id} lost a race (edit/re-proof/duplicate) — no dispatch`);
    return true;
  }

  logger.info(`[newsletter-proof] send ${send.id} approved by ${maskEmail(from)} — dispatching campaign to ${recipientCount} subscribers`);

  // Same fire-and-forget contract as the manual /send route: sendCampaign's
  // atomic draft/scheduled→sending claim is the double-dispatch guard.
  NewsletterSender.sendCampaign(send.id).catch(async (err) => {
    if (err.code === 'ALREADY_CLAIMED') {
      logger.info(`[newsletter-proof] campaign ${send.id} already claimed by another worker — no-op`);
      return;
    }
    logger.error(`[newsletter-proof] approved campaign ${send.id} failed: ${err.message}`, { stack: err.stack });
    try {
      await db('newsletter_sends').where({ id: send.id, status: 'sending' }).update({ status: 'failed' });
    } catch { /* swallow */ }
  });

  await notifyProof('newsletter_proof_approved', {
    subject: send.subject,
    approvedBy: maskEmail(from),
    recipientCount,
  });

  return true;
}

module.exports = {
  isProofApprovalEnabled,
  proofRecipient,
  syncedApprovalMailbox,
  approvalSenders,
  maskEmail,
  parseProofToken,
  extractTopReplyText,
  htmlReplyToText,
  isApprovalReply,
  renderSendPreview,
  sendNewsletterProof,
  maybeHandleProofApproval,
};
