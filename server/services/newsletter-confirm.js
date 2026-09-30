/**
 * Newsletter double-opt-in confirmation email.
 *
 * Consumed by the public-newsletter route's POST /subscribe handler.
 * Admin-add and quote-wizard signups skip this — they auto-confirm
 * (audit §9.4: "new only + 24h grace" applies to anonymous public
 * signups; admin-trusted and transactional contexts don't need it).
 *
 * The confirmation URL points at GET /api/public/newsletter/confirm/:token
 * — the route flips status to 'active' and renders a confirmation page.
 * Same env var (PUBLIC_PORTAL_URL) the unsubscribe URL uses.
 */

const sendgrid = require('./sendgrid-mail');
const db = require('../models/db');
const { wrapEmail } = require('./email-template');
const logger = require('./logger');
const { publicPortalUrl } = require('../utils/portal-url');

// Local HTML escape — wrapEmail() interpolates intro/heading/lines as
// raw HTML, so any caller that includes user-controlled data (here:
// subscriber.first_name from the public signup form) MUST escape it
// first. Mirrors the implementation in routes/public-newsletter.js.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function confirmationUrl(token) {
  return `${publicPortalUrl()}/api/public/newsletter/confirm/${token}`;
}

// The customers columns that can hold a sendable address. CUSTOMER_EMAIL_COLUMNS
// also lists billing_email, which lives on notification_prefs (migration
// 20260927000150), NOT on customers — querying it there is a 42703 that would
// veto every confirmation. Same split as email-bounce-recovery's
// CUSTOMER_EMAIL_FIELDS + its separate notification_prefs read.
// Resolved at call time, not module load: callers that mock
// customer-comms-lock without the constant must still be able to load this
// module (voice-relay-booking's real-surface check).
function customerEmailFields() {
  return require('../utils/customer-comms-lock').CUSTOMER_EMAIL_COLUMNS
    .filter((column) => column !== 'billing_email');
}

// A provider failure AFTER the request was dispatched is delivery-AMBIGUOUS:
// the provider may have accepted the message before the answer was lost.
// sendgrid-mail's convention (isDefiniteRejection): only a conclusive 4xx
// rejection is definite; a timeout-style 408, any other 4xx, every 5xx and
// every network/timeout failure is ambiguous for a POST. Errors that never
// reached the request (not configured, annual-offer guard, boundary refusal)
// are definite and are not tagged.
function isDeliveryAmbiguous(err) {
  if (!err || err.code === 'SENDGRID_NOT_CONFIGURED' || err.annualOfferWithheld || err.annualOfferGuardFailed
      || err.providerBoundaryBlocked) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  if (Number.isFinite(Number(err.status))) {
    return typeof sendgrid.isDefiniteRejection === 'function' ? !sendgrid.isDefiniteRejection(err) : true;
  }
  // fetch's network failure only: undici throws TypeError('fetch failed') with a
  // network-level cause. Any other TypeError is a code bug inside sendOne BEFORE
  // the request was dispatched (payload build, link rewrite) — definite, so the
  // retry still sends.
  return err.name === 'TypeError' && (err.message === 'fetch failed' || !!(err.cause && err.cause.code));
}

class ConfirmationVetoedError extends Error {
  constructor(reason) {
    super(`confirmation email vetoed: ${reason}`);
    this.name = 'ConfirmationVetoedError';
    this.code = 'confirmation_vetoed';
    this.reason = reason;
  }
}

// How long a send waits for a concurrent ownership writer before refusing.
// Writers hold the shared ownership lock only for the length of their own
// assignment, so a wait normally just delays the send by a moment.
const OWNERSHIP_WAIT_MS = 3000;

// The provider request runs while this send holds a pooled connection and the
// per-address advisory lock (webhooks and ownership writers for the address
// queue behind it). The 120 s default is sized for newsletter chunks; a single
// confirmation email gets a short bound so a SendGrid slowdown or a burst of
// anonymous subscribes cannot drain the pool. A timeout is a failed send, like
// any provider failure (callers already swallow/handle it; a repeat subscribe
// re-sends).
const CONFIRMATION_SEND_TIMEOUT_MS = 10_000;

/**
 * Ownership fence for the send: the shared helper's bounded wait
 * (customer-comms-lock.lockEmailOwnershipForSend, waitMs) owns key
 * construction, order and hashing. We already hold the address key(s), so the
 * wait cannot cycle with a normal ownership writer (see the helper). A writer
 * that outlasts the wait refuses the send; any other failure fails closed.
 */
async function fenceOwnership(trx, emailLc, waitMs) {
  try {
    await require('../utils/customer-comms-lock').lockEmailOwnershipForSend(trx, emailLc, { waitMs });
  } catch (err) {
    if (err && err.code === 'EMAIL_OWNERSHIP_CHECK_BUSY') throw new ConfirmationVetoedError('ownership_busy');
    throw err;
  }
}

/**
 * The one outbound veto for a newsletter confirmation email. The send
 * deliberately bypasses SendGrid's suppression group (asmGroupId: 0 — a
 * prior newsletter unsubscribe must not stop a fresh, deliberate re-signup
 * confirmation), so the app-level vetoes have to run here, before the
 * provider call, for EVERY caller (public form, quote wizard, admin import,
 * call pipeline, email fanout).
 *
 * MUST run on a transaction that stays open through the provider handoff
 * (sendConfirmationEmail arranges this): the two locks below are
 * transaction-scoped and fence nothing once it ends. Same final-send-boundary
 * recipe as billing-channel-email-authority / email-bounce-recovery:
 *   1. lockCustomerEmail — the per-address lock every suppression writer
 *      (SendGrid webhook, admin do_not_email) takes, so a bounce / complaint /
 *      do-not-email is either committed before this read or lands after the
 *      send. Blocking; taken first (caller-held row locks are always taken
 *      AFTER the address key by the writers, never before).
 *   2. lockEmailOwnershipForSend — non-blocking try, AFTER the blocking locks,
 *      fencing assignment of this address to a customer between the profile
 *      read and the send. Busy = a writer is mid-assignment: wait a bounded
 *      few seconds (fenceOwnership), then refuse.
 *
 *  - email_suppressions: an active bounce / spam_complaint / do_not_email row
 *    (any stream) or an ungrouped row, on this mailbox under ANY Gmail
 *    spelling — the same rule newsletter-sender's excludeGloballySuppressed
 *    applies. A group-scoped newsletter unsubscribe does NOT veto: the
 *    subscriber is asking back in.
 *  - do-not-contact: a call_log consent.do_not_contact_request on the linked
 *    customer OR on any customer that owns this mailbox: the four customers
 *    email columns and notification_prefs.billing_email (which is NOT a
 *    customers column).
 *
 * Fail closed: a lookup that throws means the address could not be cleared,
 * so nothing is sent. Vetoes are not surfaced to anonymous callers — every
 * caller already swallows a send error and answers uniformly.
 */
async function assertConfirmationAllowed(subscriber, dbh = db, { ownershipWaitMs = OWNERSHIP_WAIT_MS } = {}) {
  const emailLc = String(subscriber.email || '').trim().toLowerCase();
  try {
    const locks = require('../utils/customer-comms-lock');
    if (!dbh || !dbh.isTransaction) throw Object.assign(new Error('transaction required'), { code: 'NO_TRANSACTION' });
    await locks.lockCustomerEmail(dbh, emailLc);
    await fenceOwnership(dbh, emailLc, ownershipWaitMs);
    // Reads run in a savepoint so a failing statement cannot poison a
    // caller's transaction; the locks above (taken outside it) survive.
    await dbh.transaction(async (sp) => {
      const { suppressionCoversEmail } = require('../utils/email-equivalence');
      // The canonical list (email-template-library), required lazily: that
      // module pulls in most of the mail stack and some callers mock pieces of it.
      const globalTypes = [...require('./email-template-library').GLOBAL_SUPPRESSION_TYPES];
      const suppression = await sp('email_suppressions')
        .where(suppressionCoversEmail(emailLc))
        .where({ status: 'active' })
        .where(function globalOrUngrouped() {
          this.whereRaw(`LOWER(suppression_type) IN (${globalTypes.map(() => '?').join(', ')})`, globalTypes)
            .orWhereNull('group_key')
            .orWhere('group_key', '');
        })
        .first('id');
      if (suppression) throw new ConfirmationVetoedError('address_suppressed');

      const customerIds = new Set();
      if (subscriber.customer_id) customerIds.add(subscriber.customer_id);
      const mailbox = locks.googleMailboxIdentity(emailLc);
      const mailboxName = mailbox ? mailbox.split('@')[0] : null;
      const CANON = (col) => locks.GOOGLE_MAILBOX_SQL.mailbox(`BTRIM(${col})`);
      const GOOGLE = (col) => locks.GOOGLE_MAILBOX_SQL.isGoogle(`BTRIM(${col})`);
      const sameMailbox = (columns) => function match() {
        for (const col of columns) {
          this.orWhereRaw(`LOWER(BTRIM(${col})) = ?`, [emailLc]);
          if (mailboxName) this.orWhereRaw(`(${GOOGLE(col)} AND ${CANON(col)} = ?)`, [mailboxName]);
        }
      };
      const profiles = await sp('customers').where(sameMailbox(customerEmailFields())).select('id');
      for (const row of profiles || []) customerIds.add(row.id);
      const prefs = await sp('notification_prefs').where(sameMailbox(['billing_email'])).select('customer_id');
      for (const row of prefs || []) if (row.customer_id) customerIds.add(row.customer_id);
      // Linked leads and estimates are ownership sources too (the same set
      // correctedAddressOwnedByOther and the billing_email ownership guard
      // consult): a customer_id on a lead's email / an estimate's
      // customer_email owns the mailbox for do-not-contact purposes.
      const leads = await sp('leads').whereNotNull('customer_id').where(sameMailbox(['email'])).select('customer_id');
      for (const row of leads || []) if (row.customer_id) customerIds.add(row.customer_id);
      const estimates = await sp('estimates').whereNotNull('customer_id').where(sameMailbox(['customer_email'])).select('customer_id');
      for (const row of estimates || []) if (row.customer_id) customerIds.add(row.customer_id);

      if (customerIds.size) {
        const { customerCallDoNotContact } = require('./lead-first-touch-resume');
        for (const id of customerIds) {
          if (await customerCallDoNotContact(id, sp)) throw new ConfirmationVetoedError('do_not_contact');
        }
      }
    });
  } catch (err) {
    if (err instanceof ConfirmationVetoedError) throw err;
    // ID-only, no address, per AGENTS.md.
    logger.warn(`[newsletter-confirm] veto check failed for subscriber id=${subscriber.id}: ${err.code || err.name || 'error'} — not sending`);
    throw new ConfirmationVetoedError('veto_unverifiable');
  }
}

/**
 * Send (or re-send) a confirmation email. Idempotent at the SendGrid
 * level — re-firing it just lands a duplicate in the recipient's inbox,
 * which is the standard behavior for "didn't get my confirmation"
 * retries.
 *
 * Returns { messageId } on success; throws on SendGrid error so the
 * caller can decide whether to surface a 500 or swallow.
 *
 * Callers that already hold a transaction (row locks on the subscriber, the
 * fanout's hold gates) pass it as `{ dbh }` so the vetoes and the send share
 * that connection — a second pooled connection would deadlock a small pool
 * against the caller's own held connection. The caller should also take
 * lockCustomerEmail on the address BEFORE its own row locks (writers take the
 * address key first, then rows). Without `dbh` a transaction is opened here
 * and held through the provider call — the same discipline the billing and
 * bounce-recovery final-send boundaries use. Throws a
 * ConfirmationVetoedError (code 'confirmation_vetoed') — never sending — when
 * the address is suppressed / do-not-contact / unverifiable (see
 * assertConfirmationAllowed); callers treat it like any failed send.
 */
async function sendConfirmationEmail(subscriber, { dbh = null } = {}) {
  if (!subscriber || !subscriber.email || !subscriber.confirmation_token) {
    throw new Error('subscriber missing email or confirmation_token');
  }
  if (!sendgrid.isConfigured()) {
    throw new Error('SendGrid not configured (SENDGRID_API_KEY missing)');
  }
  const url = confirmationUrl(subscriber.confirmation_token);
  const firstName = (subscriber.first_name || '').trim();
  // Plain-text greeting is safe inline; HTML greeting must escape so a
  // crafted first_name (e.g. `<img src=x onerror=…>`) can't inject
  // markup into the trusted-sender confirmation email body.
  const greetingText = firstName ? `Hey ${firstName} —` : 'Hey there —';
  const greetingHtml = firstName ? `Hey ${escapeHtml(firstName)} —` : 'Hey there —';

  const html = wrapEmail({
    preheader: "One click and you're on the list.",
    heading: 'Confirm your subscription',
    intro: `${greetingHtml} thanks for signing up for the Waves Newsletter. Click the button below to confirm your email — no other steps, you're done after this.`,
    ctaHref: url,
    ctaLabel: 'Confirm subscription',
    footerNote: `If you didn't sign up, ignore this email and we'll never message you again. The link expires after a single use.`,
  });

  const text = [
    greetingText,
    '',
    `Thanks for signing up for the Waves Newsletter. Confirm your email by visiting the link below:`,
    '',
    url,
    '',
    "If you didn't sign up, ignore this email and we'll never message you again.",
    '',
    '— The Waves crew',
  ].join('\n');

  const handoff = async (trx) => {
    await assertConfirmationAllowed(subscriber, trx);
    // ACCEPTED LIMIT, same as the other outbound vetoes (auto-text holds,
    // first-touch resume): the address, suppression and ownership races are
    // fenced by the locks above, but a call-log do-not-contact request
    // committed by ANOTHER call between the read in assertConfirmationAllowed
    // and the provider request is not. Nothing fences call_log extraction
    // writes (call-recording-processor persists them at ~7 standalone sites
    // before the call has a customer link). The read is the last await before
    // sendOne, so the window is that gap only.
    // Confirmation emails are transactional — they must arrive even for
    // recipients who've previously unsubscribed from newsletter broadcasts.
    // Pass asmGroupId: 0 to bypass the SendGrid suppression group entirely.
    try {
      return await sendgrid.sendOne({
        to: subscriber.email,
        // Newsletter confirmation is the legitimate use of the `newsletter@`
        // identity — name it explicitly so the intent is durable rather than
        // depending on sendgrid-mail's default (other callers should declare
        // their own identity; defaults are not policy).
        fromEmail: 'newsletter@wavespestcontrol.com',
        fromName: 'Waves Newsletter',
        subject: 'Confirm your Waves Newsletter signup',
        html,
        text,
        categories: ['newsletter_confirm'],
        asmGroupId: 0,
        timeoutMs: CONFIRMATION_SEND_TIMEOUT_MS,
        // sendOne's annual-offer guard and link rewrite read the DB; hand them
        // THIS connection or they take a second pooled one while we hold ours.
        database: trx,
      });
    } catch (sendErr) {
      if (isDeliveryAmbiguous(sendErr)) sendErr.deliveryAmbiguous = true;
      throw sendErr;
    }
  };
  const result = dbh && dbh.isTransaction ? await handoff(dbh) : await (dbh || db).transaction(handoff);
  // ID-only logging per AGENTS.md (no PII in logs).
  logger.info(`[newsletter-confirm] Confirmation email queued for subscriber id=${subscriber.id} (msgId=${result.messageId || 'n/a'})`);
  return result;
}

module.exports = {
  CONFIRMATION_SEND_TIMEOUT_MS, isDeliveryAmbiguous, sendConfirmationEmail, confirmationUrl, assertConfirmationAllowed, ConfirmationVetoedError,
};
