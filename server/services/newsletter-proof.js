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
 * Addresses whose "approved" reply is allowed to release the list send.
 * Deliberately NOT the whole internal domain — Virginia works the shared
 * inbox; only the owner address(es) may approve a broadcast.
 */
function approvalSenders() {
  const configured = String(process.env.NEWSLETTER_PROOF_APPROVERS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
  return configured.length ? configured : [DEFAULT_PROOF_RECIPIENT];
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

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fail-closed approval matcher: the un-quoted reply text must contain
 * "approve"/"approved" and must not negate it.
 */
function isApprovalReply(text) {
  const t = String(text || '').toLowerCase();
  if (!/\bapproved?\b/.test(t)) return false;
  // Negation guard: a negating word within the same sentence before
  // "approv…" ("not approved", "don't approve", "hold off on approving",
  // "wait to approve") blocks the send. Ambiguity fails closed — the owner
  // can always reply a clean "approved".
  if (/\b(not|don'?t|do\s+not|isn'?t|never|hold|wait|no)\b[^.!?\n]{0,40}approv/.test(t)) return false;
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

  const token = crypto.randomBytes(4).toString('hex');
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
    // The reply must land back in the synced shared inbox for the approval
    // handler to see it — force reply-to at the proof recipient.
    replyTo: to,
    categories: ['newsletter_proof', `send_${send.id}`],
    asmGroupId: sendgrid.newsletterGroupId(),
  });

  await db('newsletter_sends')
    .where({ id: send.id })
    .update({ proof_token: token, proof_sent_at: new Date(), updated_at: new Date() });

  await notifyProof('newsletter_proof_sent', {
    subject: send.subject,
    recipient: to,
    recipientCount,
  });

  logger.info(`[newsletter-proof] proof sent for ${send.id} (token ${token}, messageId ${result?.messageId || 'n/a'})`);
  return { sent: true, token };
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
  // but the sender allowlist is the real boundary.
  if (!approvalSenders().includes(from)) {
    logger.info(`[newsletter-proof] ignoring [PROOF-${token}] email from non-approver ${from || 'unknown'}`);
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

  const replyText = extractTopReplyText(email.body_text || stripHtmlToText(email.body_html));
  if (!isApprovalReply(replyText)) {
    logger.info(`[newsletter-proof] reply for send ${send.id} did not say "approved" — leaving draft untouched`);
    return true;
  }

  if (!['draft', 'scheduled'].includes(send.status)) {
    logger.info(`[newsletter-proof] send ${send.id} is ${send.status} — approval reply is a no-op`);
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
  // with a manual Send click) can't both dispatch.
  const claimed = await db('newsletter_sends')
    .where({ id: send.id })
    .whereNull('proof_approved_at')
    .update({
      proof_approved_at: new Date(),
      proof_approval_email_id: email.id || null,
      updated_at: new Date(),
    });
  if (!claimed) return true;

  logger.info(`[newsletter-proof] send ${send.id} approved by ${from} — dispatching campaign to ${recipientCount} subscribers`);

  // Same fire-and-forget contract as the manual /send route: sendCampaign's
  // atomic draft/scheduled→sending claim is the double-dispatch guard.
  NewsletterSender.sendCampaign(send.id).catch(async (err) => {
    if (err.code === 'ALREADY_CLAIMED') {
      logger.info(`[newsletter-proof] campaign ${send.id} already claimed by another worker — no-op`);
      return;
    }
    logger.error(`[newsletter-proof] approved campaign ${send.id} failed: ${err.message}`, { stack: err.stack });
    try {
      await db('newsletter_sends').where({ id: send.id }).update({ status: 'failed' });
    } catch { /* swallow */ }
  });

  await notifyProof('newsletter_proof_approved', {
    subject: send.subject,
    approvedBy: from,
    recipientCount,
  });

  return true;
}

module.exports = {
  isProofApprovalEnabled,
  proofRecipient,
  approvalSenders,
  parseProofToken,
  extractTopReplyText,
  isApprovalReply,
  renderSendPreview,
  sendNewsletterProof,
  maybeHandleProofApproval,
};
