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

/**
 * Trash quarantined mail older than the undo window. The undo contract is
 * label-based: an operator who drags the message back to the inbox (or off
 * the Quarantine label) has vetoed the classification, so the sweep
 * re-reads the message's LIVE Gmail labels before touching it — the DB
 * row's auto_action alone is stale the moment a human acts in Gmail. Each
 * row is also claimed atomically in the DB before the destructive call so
 * a concurrent sweep/rescue can't double-fire.
 */
async function sweepQuarantine(now = new Date()) {
  const cutoff = new Date(now.getTime() - QUARANTINE_HOURS * 3600000);
  const quarantineLabelId = await gmailClient.ensureLabel(QUARANTINE_LABEL);
  const rows = await db('emails')
    .where('auto_action', 'spam_quarantined')
    .where('quarantined_at', '<', cutoff)
    .select('id', 'gmail_id', 'from_address');
  let trashed = 0;
  let restored = 0;
  for (const row of rows) {
    try {
      // Live-label veto check: back in INBOX or off the Quarantine label
      // means the operator rescued it — clear the quarantine state.
      const labels = await gmailClient.getMessageLabels(row.gmail_id);
      const rescuedByOperator = labels.includes('INBOX') || !labels.includes(quarantineLabelId);
      if (rescuedByOperator) {
        restored += await db('emails')
          .where({ id: row.id, auto_action: 'spam_quarantined' })
          .update({ auto_action: 'quarantine_restored', quarantined_at: null, is_archived: false, updated_at: new Date() });
        continue;
      }
      // Atomic claim BEFORE the destructive call.
      const claimed = await db('emails')
        .where({ id: row.id, auto_action: 'spam_quarantined' })
        .update({ auto_action: 'spam_trashing', updated_at: new Date() });
      if (!claimed) continue;
      try {
        await gmailClient.trashMessage(row.gmail_id);
        trashed += await db('emails')
          .where({ id: row.id, auto_action: 'spam_trashing' })
          .update({ auto_action: 'spam_trashed_after_quarantine', updated_at: new Date() });
        // The persistent sender block lands only NOW — after the undo window
        // elapsed with no operator veto. Blocking at quarantine time would
        // keep trash-routing a sender whose message the operator restored.
        try {
          const { blockSpamSender } = require('./spam-blocker');
          await blockSpamSender(row);
        } catch (blockErr) {
          logger.warn(`[inbox-hygiene] deferred sender block failed (email ${row.id}): ${blockErr.message}`);
        }
      } catch (trashErr) {
        // Release the claim so tomorrow's sweep retries.
        await db('emails')
          .where({ id: row.id, auto_action: 'spam_trashing' })
          .update({ auto_action: 'spam_quarantined', updated_at: new Date() });
        throw trashErr;
      }
    } catch (e) {
      logger.warn(`[inbox-hygiene] quarantine sweep failed for email ${row.id}: ${e.message}`);
    }
  }
  if (trashed || restored) logger.info(`[inbox-hygiene] quarantine sweep: ${trashed} trashed, ${restored} operator-restored`);
  return { trashed, restored };
}

/**
 * True when Gmail's own Authentication-Results header shows the message
 * actually authenticated as the domain it claims: DKIM pass whose d= aligns
 * with the From domain, or SPF pass whose validated domain aligns. A From
 * header is attacker-typed text — without aligned authentication, "rescuing"
 * a spam-foldered message would let anyone spoof a customer or Stripe and
 * have Gmail's phishing verdict reversed automatically.
 */
function hasAlignedAuth(authResults, fromDomain) {
  const auth = String(authResults || '').toLowerCase();
  const domain = String(fromDomain || '').toLowerCase();
  if (!auth || !domain) return false;
  const aligned = (value) => value === domain || value.endsWith(`.${domain}`) || domain.endsWith(`.${value}`);
  const dkim = auth.match(/dkim=pass[^;]*/g) || [];
  for (const clause of dkim) {
    const d = clause.match(/header\.[di]=@?([a-z0-9.-]+)/);
    if (d && aligned(d[1])) return true;
  }
  const spf = auth.match(/spf=pass[^;]*/g) || [];
  for (const clause of spf) {
    const d = clause.match(/(?:smtp\.mailfrom|smtp\.helo)=(?:[^@\s;]*@)?([a-z0-9.-]+)/);
    if (d && aligned(d[1])) return true;
  }
  return false;
}

/**
 * Rescue known senders out of Gmail's spam folder. Recent window only —
 * Gmail purges spam at 30 days and yesterday's sweep covered yesterday.
 * Rescue REQUIRES aligned SPF/DKIM evidence; a known-looking sender without
 * it gets a review notification instead of a move (spoof containment).
 */
async function rescueSpamFolder() {
  const messages = await gmailClient.listMessages('in:spam newer_than:2d', 50);
  const counts = { scanned: 0, rescued: 0, customers: 0, unauthenticated: 0 };
  for (const m of messages || []) {
    counts.scanned += 1;
    try {
      const full = await gmailClient.getMessage(m.id);
      const fromAddress = full?.from_address;
      const verdict = await isKnownSender(fromAddress);
      if (!verdict.known) continue;
      if (!hasAlignedAuth(full?.authentication_results, domainFromAddress(fromAddress))) {
        // Looks like someone we know but did not authenticate as them —
        // exactly what a phish looks like. Never auto-reverse Gmail's
        // verdict; park a review notification instead.
        counts.unauthenticated += 1;
        await db('notifications').insert({
          recipient_type: 'admin',
          category: 'email_rescue_review',
          title: 'Spam-foldered mail claims a known sender (unverified)',
          body: `A message claiming to be ${full.from_name || fromAddress} ("${(full.subject || '(no subject)').slice(0, 60)}") is in Gmail Spam but failed sender authentication — left in Spam. Review it in Gmail if expected.`,
          icon: '⚠️',
          link: '/admin/email',
          created_at: new Date(),
        }).catch(() => {});
        continue;
      }
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

  // One nudge per Gmail thread (its LATEST inbound message) — several
  // messages in one unanswered thread must not crowd other customers out of
  // the capped digest list.
  const latestPerThread = new Map();
  for (const email of candidates) {
    const prev = latestPerThread.get(email.gmail_thread_id);
    if (!prev || new Date(email.received_at) > new Date(prev.received_at)) {
      latestPerThread.set(email.gmail_thread_id, email);
    }
  }
  const deduped = [...latestPerThread.values()]
    .sort((a, b) => new Date(a.received_at) - new Date(b.received_at));

  const nudges = [];
  for (const email of deduped) {
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
  hasAlignedAuth,
  quarantineMessage,
  sweepQuarantine,
  rescueSpamFolder,
  collectUnansweredNudges,
};
