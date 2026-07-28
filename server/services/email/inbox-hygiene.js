/**
 * Inbox hygiene — the hands-off half of the email agent (owner directive
 * 2026-07-28: "green auto-applies, exceptions park in one digest, no triage
 * queues"). Three jobs, all idempotent, all called from the scheduler:
 *
 *   - sweepQuarantine(): spam classifications no longer trash instantly —
 *     handleSpam parks them under the Quarantine label with quarantined_at
 *     stamped. This sweep trashes rows older than the 24h undo window. A
 *     misfire costs one label-click inside a day instead of a hunt through
 *     932 trash items.
 *   - rescueSpamFolder(): Gmail's own spam folder swallows real mail
 *     silently. The sweep scans recent SPAM for senders we KNOW — customers,
 *     live leads, vendor domains, operational/partner domains — and moves
 *     them back to the inbox marked important. Customers additionally ring
 *     an admin bell (a buried customer email is an exception, not a stat).
 *   - collectUnansweredNudges(): inbound customer/lead conversation mail
 *     with no outbound reply after NUDGE_AFTER_DAYS surfaces in the morning
 *     digest — the follow-up-when-we-haven't lane. Reply detection reads
 *     the live Gmail thread for a SENT message dated after the inbound one
 *     (the emails table only mirrors the inbox, so a DB-only check would
 *     nudge on threads the operator already answered).
 *
 * Errors in one item never abort the sweep (log-and-continue) — but errors
 * in AUTH propagate so the scheduler logs a real failure instead of a
 * silently empty run.
 */

const db = require('../../models/db');
const logger = require('../logger');
const gmailClient = require('./gmail-client');
const { isOperationalDomain, domainFromAddress, normalizeAddress } = require('./spam-blocker');

const QUARANTINE_LABEL = 'Quarantine';
const QUARANTINE_HOURS = 24;
const NUDGE_AFTER_DAYS = 3;
const NUDGE_WINDOW_DAYS = 10;
const NUDGE_CATEGORIES = ['customer_request', 'scheduling', 'complaint', 'lead_inquiry'];

/** True when we know this sender: customer, live lead, vendor, or partner. */
async function isKnownSender(fromAddress) {
  const normalized = normalizeAddress(fromAddress);
  if (!normalized) return { known: false };
  if (isOperationalDomain(domainFromAddress(normalized))) return { known: true, kind: 'operational' };
  const customer = await db('customers').where('email', normalized).whereNull('deleted_at').first();
  if (customer) return { known: true, kind: 'customer', customer };
  const lead = await db('leads').where('email', normalized).whereNull('deleted_at').first();
  if (lead) return { known: true, kind: 'lead', lead };
  const domain = domainFromAddress(normalized);
  if (domain) {
    const vendor = await db('vendor_email_domains').where('domain', domain).first();
    if (vendor) return { known: true, kind: 'vendor' };
  }
  return { known: false };
}

/** Park a message in quarantine: label swap in Gmail + stamp in the DB. */
async function quarantineMessage(email) {
  const labelId = await gmailClient.ensureLabel(QUARANTINE_LABEL);
  await gmailClient.modifyLabels(email.gmail_id, [labelId], ['INBOX']);
  await db('emails').where({ id: email.id }).update({
    is_archived: true,
    quarantined_at: new Date(),
    auto_action: 'spam_quarantined',
    updated_at: new Date(),
  });
}

/** Trash quarantined mail older than the undo window. */
async function sweepQuarantine(now = new Date()) {
  const cutoff = new Date(now.getTime() - QUARANTINE_HOURS * 3600000);
  const rows = await db('emails')
    .where('auto_action', 'spam_quarantined')
    .where('quarantined_at', '<', cutoff)
    .select('id', 'gmail_id');
  let trashed = 0;
  for (const row of rows) {
    try {
      await gmailClient.trashMessage(row.gmail_id);
      // Re-assert the quarantined state so a concurrent operator rescue
      // (auto_action moved off 'spam_quarantined') is never overwritten.
      trashed += await db('emails')
        .where({ id: row.id, auto_action: 'spam_quarantined' })
        .update({ auto_action: 'spam_trashed_after_quarantine', updated_at: new Date() });
    } catch (e) {
      logger.warn(`[inbox-hygiene] quarantine trash failed for email ${row.id}: ${e.message}`);
    }
  }
  if (trashed) logger.info(`[inbox-hygiene] quarantine sweep trashed ${trashed} message(s)`);
  return { trashed };
}

/**
 * Rescue known senders out of Gmail's spam folder. Recent window only —
 * Gmail purges spam at 30 days and yesterday's sweep covered yesterday.
 */
async function rescueSpamFolder() {
  const messages = await gmailClient.listMessages('in:spam newer_than:2d', 50);
  const counts = { scanned: 0, rescued: 0, customers: 0 };
  for (const m of messages || []) {
    counts.scanned += 1;
    try {
      const full = await gmailClient.getMessage(m.id);
      const fromAddress = full?.from_address;
      const verdict = await isKnownSender(fromAddress);
      if (!verdict.known) continue;
      await gmailClient.modifyLabels(m.id, ['INBOX', 'IMPORTANT'], ['SPAM']);
      counts.rescued += 1;
      if (verdict.kind === 'customer') {
        counts.customers += 1;
        await db('notifications').insert({
          recipient_type: 'admin',
          category: 'email_rescue',
          title: 'Customer email rescued from Spam',
          body: `${full.from_name || fromAddress}: "${(full.subject || '(no subject)').slice(0, 80)}" was in Gmail Spam — moved back to the inbox and marked important.`,
          icon: '\u{1F6DF}',
          link: '/admin/email',
          created_at: new Date(),
        }).catch(() => {});
      }
      logger.info(`[inbox-hygiene] rescued ${verdict.kind} email from spam (${m.id})`);
    } catch (e) {
      logger.warn(`[inbox-hygiene] spam rescue failed for message ${m.id}: ${e.message}`);
    }
  }
  return counts;
}

/**
 * Inbound conversation mail with no outbound reply — digest fodder, capped
 * so one noisy day can't turn the digest into a triage queue.
 */
async function collectUnansweredNudges(now = new Date(), limit = 5) {
  const newest = new Date(now.getTime() - NUDGE_AFTER_DAYS * 86400000);
  const oldest = new Date(now.getTime() - NUDGE_WINDOW_DAYS * 86400000);
  const candidates = await db('emails')
    .whereIn('classification', NUDGE_CATEGORIES)
    .where('is_archived', false)
    .whereBetween('received_at', [oldest, newest])
    .orderBy('received_at', 'asc')
    .limit(25)
    .select('id', 'gmail_id', 'gmail_thread_id', 'from_address', 'from_name', 'subject', 'received_at');

  const nudges = [];
  for (const email of candidates) {
    if (nudges.length >= limit) break;
    try {
      const thread = await gmailClient.getThread(email.gmail_thread_id);
      const receivedAt = new Date(email.received_at).getTime();
      const answered = (thread?.messages || []).some((msg) => {
        const isSent = (msg.labelIds || []).includes('SENT');
        const at = Number(msg.internalDate || 0);
        return isSent && at > receivedAt;
      });
      if (!answered) nudges.push(email);
    } catch (e) {
      logger.warn(`[inbox-hygiene] nudge thread check failed for email ${email.id}: ${e.message}`);
    }
  }
  return nudges;
}

module.exports = {
  QUARANTINE_LABEL,
  QUARANTINE_HOURS,
  isKnownSender,
  quarantineMessage,
  sweepQuarantine,
  rescueSpamFolder,
  collectUnansweredNudges,
};
