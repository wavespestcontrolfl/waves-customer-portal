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
]);

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

  // Don't block customer emails
  const isCustomer = await db('customers').where('email', fromAddress).first();
  if (isCustomer) return;

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

  await db('blocked_email_senders').insert({
    domain: null,
    email_address: fromAddress,
    gmail_filter_id: filterId,
    reason: 'spam_auto',
  });

  logger.info(`[spam-blocker] Blocked sender: ${redactedFrom}`);
}

async function unblockSender(id) {
  const blocked = await db('blocked_email_senders').where({ id }).first();
  if (!blocked) return { error: 'Not found' };

  if (blocked.gmail_filter_id) {
    try {
      const gmailClient = require('./gmail-client');
      const auth = await gmailClient.getAuthClient();
      if (auth) {
        const gmail = google.gmail({ version: 'v1', auth });
        await gmail.users.settings.filters.delete({ userId: 'me', id: blocked.gmail_filter_id });
        logger.info(`[spam-blocker] Gmail filter removed: ${blocked.gmail_filter_id}`);
      }
    } catch (err) {
      logger.warn(`[spam-blocker] Gmail filter removal failed: ${err.message}`);
    }
  }

  await db('blocked_email_senders').where({ id }).del();
  return { success: true, unblocked: blocked.domain || blocked.email_address };
}

async function isBlocked(fromAddress) {
  if (!fromAddress) return false;
  const normalized = normalizeAddress(fromAddress);
  const domain = domainFromAddress(normalized);
  if (!domain) return false;

  const exactBlocked = await db('blocked_email_senders')
    .where('email_address', normalized)
    .first();

  if (exactBlocked) {
    await db('blocked_email_senders').where({ id: exactBlocked.id }).increment('blocked_count', 1);
    return true;
  }

  // Known customers, vendors, and protected roots must fail open for broad
  // domain blocks. Exact sender blocks were already honored above.
  const isCustomer = await db('customers').where('email', normalized).first();
  if (isCustomer) return false;

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
