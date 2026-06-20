/**
 * NET-terms statement delivery (Phase 2 — deliver). Emails a finalized
 * consolidated statement (PDF attached) to the payer's AP inbox and stamps
 * `finalized → sent` + `sent_at` on success.
 *
 * Invariant carried from P1: a statement bills the PAYER, never the homeowner.
 * The recipient is resolved ONLY from the frozen `payer_snapshot` (falling back
 * to the live payer's AP email) — there is no homeowner fallback. No AP email ⇒
 * the send fails loudly rather than mis-billing a resident.
 */

const logger = require('./logger');
const db = require('./../models/db');
const { isEnabled } = require('../config/feature-gates');
const { buildPayerStatementPDFBuffer } = require('./pdf/payer-statement-pdf');
const { loadStatementLines } = require('./payer-statements');
const PayerService = require('./payer');
const EmailTemplateLibrary = require('./email-template-library');
const sendgrid = require('./sendgrid-mail');
const { smtpFallbackAllowed } = require('./email-fallback-gate');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { formatDateOnly } = require('../utils/date-only');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmailLike = (v) => typeof v === 'string' && EMAIL_RE.test(v.trim());
const TERM_LABEL = { net15: 'Net 15', net30: 'Net 30', due_on_receipt: 'Due on receipt' };

// A statement is deliverable only in a billed, owed state. `open` is still
// accruing; `void`/`paid`/anything else must NOT be mailed as an amount due
// (the PDF renders any non-paid/non-overdue status as "Due", so a voided
// statement would otherwise reach AP looking collectible).
const SENDABLE_STATUSES = new Set(['finalized', 'sent', 'viewed']);

// Terminal delivery states that permanently dedupe an idempotency key WITHOUT
// delivering (the blocked/suppressed subset of the email library's
// DEDUPE_STATUSES). 'failed'/'error' auto-retry under the same key, 'queued' is
// in-flight, and 'sent'/'delivered' would have stamped the statement out of the
// first-delivery branch — so a `forceResend` only earns its keyless bypass when
// the first delivery actually landed in one of these.
const BLOCKED_DELIVERY_STATUSES = ['blocked', 'bounced', 'bounce', 'dropped', 'spam_report', 'spamreport', 'unsubscribed', 'complained'];

// True if a delivery recorded under EXACTLY this key terminally blocked.
async function deliveryBlocked(idempotencyKey, database) {
  const row = await database('email_messages')
    .where({ idempotency_key: idempotencyKey })
    .whereIn('status', BLOCKED_DELIVERY_STATUSES)
    .first('id');
  return !!row;
}

/**
 * The idempotency key a `forceResend` should send under: walk past each
 * generation whose attempt terminally blocked (base → `<base>:r1` → `:r2` …) to
 * the first generation that has NOT blocked. The result is a FRESH key for a new
 * generation (so a genuinely blocked statement can be retried) yet STABLE within
 * that generation — so a double-click or two concurrent forced requests dedupe
 * on it (the `email_messages` unique key resolves the race) instead of each
 * inserting a keyless row and double-sending. A stray force with no prior block
 * returns the base key unchanged. Fails safe to the base key (never keyless) so a
 * lookup error can't drop dedupe.
 */
async function forcedRetryKey(baseKey, database) {
  try {
    let gen = 0;
    let key = baseKey;
    while (await deliveryBlocked(key, database)) {
      gen += 1;
      key = `${baseKey}:r${gen}`;
      if (gen > 50) break; // sanity bound — never loop unbounded
    }
    return key;
  } catch (err) {
    logger.warn(`[payer-statement-email] forced-retry key lookup failed for ${baseKey}: ${err.message}`);
    return baseKey;
  }
}

function currency(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseSnapshot(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function pdfAttachment(filename, buffer) {
  return { filename, content: buffer.toString('base64'), type: 'application/pdf', disposition: 'attachment' };
}

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  if (!process.env.GOOGLE_SMTP_PASSWORD) return null;
  const nodemailer = require('nodemailer');
  cachedTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: 'contact@wavespestcontrol.com', pass: process.env.GOOGLE_SMTP_PASSWORD },
  });
  return cachedTransporter;
}

function canFallbackFromTemplateEmailError(err) {
  return /relation .*email_templates.* does not exist|active template not found|template version not found|template not found/i.test(err?.message || '');
}

/**
 * Resolve the AP recipient for a statement. Frozen snapshot first; refresh from
 * the live payer ONLY to recover a missing/blank AP email. Never the homeowner.
 */
async function resolveApRecipient(statement, database) {
  const snap = parseSnapshot(statement.payer_snapshot) || {};
  let apEmail = isEmailLike(snap.ap_email) ? snap.ap_email.trim() : null;
  let company = snap.company_name || snap.display_name || null;
  if (!apEmail && statement.payer_id) {
    try {
      const live = await PayerService.getPayer(statement.payer_id, database);
      if (live && live.active !== false && isEmailLike(live.ap_email)) apEmail = live.ap_email.trim();
      if (live && !company) company = live.company_name || live.display_name || null;
    } catch (err) {
      logger.warn(`[payer-statement-email] live AP lookup failed for statement ${statement.id}: ${err.message}`);
    }
  }
  return { apEmail, company, snapshot: snap };
}

/**
 * Build + send the statement email. Gated — `payerStatements` off ⇒ no-op.
 * Pass `dryRun: true` to build the PDF + resolve the recipient WITHOUT sending
 * or stamping (used by the cron's dry-run-first rollout and the admin preview).
 * Pass `forceResend: true` ONLY to retry a known blocked/suppressed attempt — it
 * makes a FRESH delivery attempt (no first-delivery dedupe key) so the terminal
 * blocked row can't dedupe it forever. A normal first send (default) stays under
 * the stable key so a double-click / client retry can't email AP two copies.
 */
async function sendStatementEmail(statementId, { dryRun = false, forceResend = false, database = db } = {}) {
  if (!isEnabled('payerStatements')) return { ok: false, skipped: 'gate_off' };

  const statement = await database('payer_statements').where({ id: statementId }).first();
  if (!statement) return { ok: false, error: 'statement_not_found' };
  if (!SENDABLE_STATUSES.has(statement.status)) {
    if (statement.status === 'open') return { ok: false, error: 'statement_not_finalized' };
    logger.warn(`[payer-statement-email] statement ${statementId}: status '${statement.status}' is not sendable — NOT mailing`);
    return { ok: false, error: 'statement_not_sendable', status: statement.status };
  }

  const { apEmail, company, snapshot } = await resolveApRecipient(statement, database);
  if (!apEmail) {
    logger.warn(`[payer-statement-email] statement ${statementId}: no AP email — NOT sending (never bills the homeowner)`);
    return { ok: false, error: 'no_ap_email', payerId: statement.payer_id };
  }

  const lines = await loadStatementLines(statementId, database);
  const pdfBuffer = await buildPayerStatementPDFBuffer({ statement, payer: snapshot, lines });
  const fileName = `waves-statement-S${statement.id}.pdf`;
  const recipient = { email: apEmail, company, count: lines.length };

  if (dryRun) {
    logger.info(`[payer-statement-email] DRY-RUN statement ${statementId} (payer ${statement.payer_id}, ${lines.length} visits, ${pdfBuffer.length}B PDF) — AP recipient resolved`);
    return { ok: true, dryRun: true, recipient, total: statement.total };
  }

  const dueLabel = statement.due_date ? formatDateOnly(statement.due_date) : '';
  const termsLabel = TERM_LABEL[statement.terms_snapshot] || statement.terms_snapshot || '';
  const subject = `Waves statement S-${statement.id} — ${currency(statement.total)} due ${dueLabel}`.trim();

  // First delivery (finalized, never sent) sends under a stable idempotency key
  // so a double-click / client retry / concurrent close-and-send can't email AP
  // two copies — sendTemplate only dedupes on idempotencyKey (triggerEventId is
  // metadata). This holds for BOTH /close's chained send and a normal /send.
  // `forceResend` advances to the next retry generation's key (still stable, so
  // its own double-clicks dedupe) only past a genuinely blocked attempt — never
  // keyless. Re-delivering an already-sent/viewed statement is keyless
  // (intentional re-send).
  const isFirstDelivery = statement.status === 'finalized' && !statement.sent_at;
  let idempotencyKey;
  if (isFirstDelivery) {
    const baseKey = `payer_statement_sent:${statement.id}`;
    idempotencyKey = forceResend ? await forcedRetryKey(baseKey, database) : baseKey;
  }

  let sent = false;
  if (sendgrid.isConfigured()) {
    try {
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: 'payer.statement.sent',
        to: apEmail,
        payload: {
          company_name: company || 'Accounts Payable',
          statement_number: `S-${statement.id}`,
          period_start: formatDateOnly(statement.period_start),
          period_end: formatDateOnly(statement.period_end),
          visit_count: String(statement.invoice_count || lines.length),
          amount_due: currency(statement.total),
          due_date: dueLabel,
          terms: termsLabel,
        },
        recipientType: 'payer',
        recipientId: statement.payer_id || null,
        triggerEventId: `payer_statement_sent:${statement.id}`,
        idempotencyKey,
        categories: ['payer_statement'],
        attachments: [pdfAttachment(fileName, pdfBuffer)],
      });
      if (result?.sent === false) {
        logger.warn(`[payer-statement-email] statement ${statementId} NOT delivered (${result.reason || 'blocked/suppressed'})`);
        return { ok: false, blocked: !!result.blocked, error: result.reason || 'suppressed', recipient };
      }
      sent = true;
    } catch (err) {
      if (!canFallbackFromTemplateEmailError(err)) {
        logger.error(`[payer-statement-email] template send failed for statement ${statementId}: ${err.message}`);
        return { ok: false, error: err.message, recipient };
      }
      logger.warn(`[payer-statement-email] template unavailable for statement ${statementId}; trying SMTP: ${err.message}`);
    }
  }

  if (!sent) {
    if (!smtpFallbackAllowed()) {
      logger.error(`[payer-statement-email] statement ${statementId}: SendGrid template path failed and SMTP fallback disabled in prod`);
      return { ok: false, error: 'email_unavailable', recipient };
    }
    const transporter = getTransporter();
    if (!transporter) return { ok: false, error: 'email_not_configured', recipient };
    const text = [
      `${company || 'Accounts Payable'},`,
      '',
      `Your Waves Pest Control statement S-${statement.id} is attached.`,
      `Period: ${formatDateOnly(statement.period_start)} – ${formatDateOnly(statement.period_end)} (${statement.invoice_count || lines.length} visits)`,
      `Amount due: ${currency(statement.total)}${dueLabel ? ` by ${dueLabel}` : ''}${termsLabel ? ` (${termsLabel})` : ''}`,
      '',
      `Questions? Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`,
      '— Waves Pest Control',
    ].join('\n');
    try {
      await transporter.sendMail({
        from: '"Waves Pest Control, LLC" <contact@wavespestcontrol.com>',
        to: apEmail,
        subject,
        text,
        attachments: [{ filename: fileName, content: pdfBuffer, contentType: 'application/pdf' }],
      });
      sent = true;
    } catch (err) {
      logger.error(`[payer-statement-email] SMTP send failed for statement ${statementId}: ${err.message}`);
      return { ok: false, error: err.message, recipient };
    }
  }

  // Stamp finalized → sent atomically; never downgrade a viewed/paid statement
  // and never re-stamp sent_at on a resend.
  await database('payer_statements')
    .where({ id: statementId, status: 'finalized' })
    .update({ status: 'sent', sent_at: database.fn.now(), updated_at: database.fn.now() });

  logger.info(`[payer-statement-email] statement ${statementId} sent to payer ${statement.payer_id} AP inbox (${lines.length} visits)`);
  return { ok: true, recipient, total: statement.total };
}

module.exports = { sendStatementEmail, resolveApRecipient };
