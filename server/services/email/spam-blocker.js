const { google } = require('googleapis');
const db = require('../../models/db');
const logger = require('../logger');

const SHARED_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'gmail',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'bellsouth.net',
  'tampabay.rr.com',
  'sbcglobal.net',
  'cox.net',
  'frontier.com',
  'netzero.net',
  'duck.com',
  'pm.me',
  'passmail.net',
  'proton.me',
  'protonmail.com',
]);

const OPERATIONAL_EMAIL_DOMAINS = new Set([
  'google.com',
  'googleapis.com',
  'googleusercontent.com',
  'gserviceaccount.com',
  'wavespestcontrol.com',
  'www.wavespestcontrol.com',
  'portal.wavespestcontrol.com',
  'waveslawncare.com',
  'wavespestcontrolbradenton.com',
  'wavespestcontrolparrish.com',
  'wavespestcontrolsarasota.com',
  'wavespestcontrolvenice.com',
  'bradentonflexterminator.com',
  'bradentonflpestcontrol.com',
  'palmettoexterminator.com',
  'palmettoflpestcontrol.com',
  'parrishexterminator.com',
  'parrishpestcontrol.com',
  'sarasotaflexterminator.com',
  'sarasotaflpestcontrol.com',
  'veniceexterminator.com',
  'veniceflpestcontrol.com',
  'northportflpestcontrol.com',
  'bradentonfllawncare.com',
  'sarasotafllawncare.com',
  'venicelawncare.com',
  'facebook.com',
  'business.facebook.com',
  'meta.com',
  'stripe.com',
  'sendgrid.net',
  'sendgrid.com',
  'cloudflare.com',
  'railway.app',
  'twilio.com',
  'namecheap.com',
  'anthropic.com',
  // Business-critical partners: the liability insurance broker and the
  // marina whose COI requirement gates on-site work (2026-07-28 — the
  // renewal thread was buried in a 1,900-item inbox while the policy
  // lapsed; these can never be classified into a destructive action).
  'flhins.com',
  'rdmarina.com',
]);

// Mirrors inbox-hygiene / email-actions (which mirror CLOSED_STATUSES in
// intelligence-bar/leads-tools.js). Local copy — inbox-hygiene requires this
// module, so importing from it would be circular.
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate', 'unresponsive'];

function normalizeAddress(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function domainFromAddress(value) {
  const normalized = normalizeAddress(value);
  const at = normalized.lastIndexOf('@');
  return at > -1 ? normalized.slice(at + 1) : '';
}

function domainMatches(domain, roots) {
  const normalized = String(domain || '').trim().toLowerCase();
  if (!normalized) return false;
  for (const root of roots) {
    if (normalized === root || normalized.endsWith(`.${root}`)) return true;
  }
  return false;
}

function isProtectedDomain(domain) {
  return domainMatches(domain, SHARED_EMAIL_DOMAINS) || domainMatches(domain, OPERATIONAL_EMAIL_DOMAINS);
}

function isOperationalDomain(domain) {
  return domainMatches(domain, OPERATIONAL_EMAIL_DOMAINS);
}

function redactEmail(value) {
  const normalized = normalizeAddress(value);
  const [local, domain] = normalized.split('@');
  if (!local || !domain) return 'unknown';
  return `${local.slice(0, 1)}***@${domain}`;
}

async function blockSpamSender(email) {
  const fromAddress = normalizeAddress(email.from_address);
  const domain = domainFromAddress(fromAddress);
  if (!domain) return;
  const redactedFrom = redactEmail(fromAddress);

  // Never let an automatic classifier decision suppress Waves-owned or
  // critical platform mail. These senders carry customer replies, account
  // security notices, GBP, GSC, calendar, and infrastructure alerts.
  if (isOperationalDomain(domain)) return;

  // Don't block known good domains
  const isVendor = await db('vendor_email_domains').where('domain', domain).first();
  if (isVendor) return;

  // Don't block customer emails (stored casing may differ)
  const isCustomer = await db('customers').whereRaw('LOWER(email) = ?', [fromAddress]).first();
  if (isCustomer) return;

  // Don't block live leads either — a prospect whose first email tripped
  // the classifier must stay reachable while the lead is OPEN. Closed leads
  // (lost/disqualified/duplicate/unresponsive) get no exemption.
  const isLead = await db('leads')
    .whereRaw('LOWER(email) = ?', [fromAddress])
    .whereNull('deleted_at')
    .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
    .first();
  if (isLead) return;

  // Check if already blocked
  const existingQuery = db('blocked_email_senders').where('email_address', fromAddress);
  if (!isProtectedDomain(domain)) existingQuery.orWhere('domain', domain);
  const existing = await existingQuery.first();

  if (existing) {
    await db('blocked_email_senders').where({ id: existing.id }).increment('blocked_count', 1);
    return;
  }

  // Auto-spam decisions block the exact sender. Domain-wide blocks stay manual
  // because one bad shared-domain sender should not trash unrelated customers.
  let filterId = null;
  try {
    const gmailClient = require('./gmail-client');
    const auth = await gmailClient.getAuthClient();
    if (auth) {
      const gmail = google.gmail({ version: 'v1', auth });
      const filter = await gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria: { from: fromAddress },
          action: { removeLabelIds: ['INBOX'], addLabelIds: ['TRASH'] },
        },
      });
      filterId = filter.data.id;
      logger.info(`[spam-blocker] Gmail filter created for ${redactedFrom}: ${filterId}`);
    }
  } catch (err) {
    logger.warn(`[spam-blocker] Gmail filter creation failed for ${redactedFrom}: ${err.message}`);
  }

  try {
    await db('blocked_email_senders').insert({
      domain: null,
      email_address: fromAddress,
      gmail_filter_id: filterId,
      reason: 'spam_auto',
    });
  } catch (insertErr) {
    // The Gmail filter already exists but we failed to record it — roll the
    // filter back (best effort) so a retry recreates BOTH atomically enough,
    // instead of stacking orphaned filters no unblock can ever find.
    if (filterId) {
      try {
        const gmailClient = require('./gmail-client');
        const auth = await gmailClient.getAuthClient();
        if (auth) {
          const gmail = google.gmail({ version: 'v1', auth });
          await gmail.users.settings.filters.delete({ userId: 'me', id: filterId });
          logger.info(`[spam-blocker] rolled back unrecorded Gmail filter ${filterId}`);
        }
      } catch (rollbackErr) {
        logger.warn(`[spam-blocker] filter rollback failed (${filterId}) — orphaned filter: ${rollbackErr.message}`);
      }
    }
    throw insertErr;
  }

  logger.info(`[spam-blocker] Blocked sender: ${redactedFrom}`);
}

async function unblockSender(id) {
  const blocked = await db('blocked_email_senders').where({ id }).first();
  if (!blocked) return { error: 'Not found' };

  if (blocked.gmail_filter_id) {
    try {
      const gmailClient = require('./gmail-client');
      const auth = await gmailClient.getAuthClient();
      if (!auth) {
        // A stored filter id with no Gmail connection means the filter is
        // STILL routing this sender to Trash — deleting our record would
        // report an unblock that never happened.
        return { error: 'Gmail not connected — filter cannot be removed; retry after reconnecting' };
      }
      {
        const gmail = google.gmail({ version: 'v1', auth });
        await gmail.users.settings.filters.delete({ userId: 'me', id: blocked.gmail_filter_id });
        logger.info(`[spam-blocker] Gmail filter removed: ${blocked.gmail_filter_id}`);
      }
    } catch (err) {
      // 404 = the filter is already gone (idempotent success); anything else
      // means Gmail is STILL trash-routing this sender — deleting our record
      // would report an unblock that never happened and lose the filter id.
      const gone = err.code === 404 || err.response?.status === 404;
      if (!gone) {
        logger.warn(`[spam-blocker] Gmail filter removal failed — block record retained for retry: ${err.message}`);
        return { error: 'Gmail filter removal failed — sender is still blocked; retry the unblock' };
      }
      logger.info(`[spam-blocker] Gmail filter already gone: ${blocked.gmail_filter_id}`);
    }
  }

  await db('blocked_email_senders').where({ id }).del();
  return { success: true, unblocked: blocked.domain || blocked.email_address };
}

/**
 * Remove a stale spam_auto block (row + Gmail filter) for a sender who has
 * since become an identity we protect. Best-effort: unblockSender keeps the
 * row when the Gmail filter can't be deleted, so the next message retries.
 */
async function removeStaleAutoBlock(normalizedAddress) {
  try {
    const row = await db('blocked_email_senders')
      .whereRaw('LOWER(email_address) = ?', [normalizedAddress])
      .where({ reason: 'spam_auto' })
      .first();
    if (!row) return;
    const result = await unblockSender(row.id);
    if (result?.success) {
      logger.info(`[spam-blocker] removed stale auto-block for now-protected sender ${redactEmail(normalizedAddress)}`);
    }
  } catch (e) {
    logger.warn(`[spam-blocker] stale auto-block removal failed for ${redactEmail(normalizedAddress)}: ${e.message}`);
  }
}

async function isBlocked(fromAddress) {
  if (!fromAddress) return false;
  const normalized = normalizeAddress(fromAddress);
  const domain = domainFromAddress(normalized);
  if (!domain) return false;

  // Identity checks come FIRST — a stale exact block recorded before a
  // sender became a customer/open lead, or before their domain joined the
  // operational set, must not keep auto-trashing their mail. (Shared
  // mailbox providers like gmail.com are NOT identity — exact blocks on
  // those still apply below.) The DB fail-open alone is not enough: a
  // stored gmail_filter_id keeps trash-routing at GMAIL level, so the stale
  // auto-block (row + filter) is actively removed; a failed removal keeps
  // the row for the next message's retry.
  if (isOperationalDomain(domain)) {
    await removeStaleAutoBlock(normalized);
    return false;
  }
  const isCustomer = await db('customers').whereRaw('LOWER(email) = ?', [normalized]).first();
  if (isCustomer) {
    await removeStaleAutoBlock(normalized);
    return false;
  }
  const isOpenLead = await db('leads')
    .whereRaw('LOWER(email) = ?', [normalized])
    .whereNull('deleted_at')
    .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
    .first();
  if (isOpenLead) {
    await removeStaleAutoBlock(normalized);
    return false;
  }

  // Exact sender blocks still outrank the vendor-DOMAIN fail-open (a domain
  // is not an identity — one bad sender at a vendor domain stays blocked).
  const exactBlocked = await db('blocked_email_senders')
    .where('email_address', normalized)
    .first();

  if (exactBlocked) {
    await db('blocked_email_senders').where({ id: exactBlocked.id }).increment('blocked_count', 1);
    return true;
  }

  const isVendor = await db('vendor_email_domains').where('domain', domain).first();
  if (isVendor) return false;

  if (isProtectedDomain(domain)) return false;

  const blocked = await db('blocked_email_senders').where('domain', domain).first();

  if (blocked) {
    await db('blocked_email_senders').where({ id: blocked.id }).increment('blocked_count', 1);
    return true;
  }
  return false;
}

module.exports = {
  blockSpamSender,
  unblockSender,
  isBlocked,
  domainFromAddress,
  domainMatches,
  isProtectedDomain,
  isOperationalDomain,
  normalizeAddress,
};
