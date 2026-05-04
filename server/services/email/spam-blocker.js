const { google } = require('googleapis');
const db = require('../../models/db');
const logger = require('../logger');

const SHARED_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

function redactEmail(value) {
  const normalized = value ? String(value).trim().toLowerCase() : '';
  const [local, domain] = normalized.split('@');
  if (!local || !domain) return 'unknown';
  return `${local.slice(0, 1)}***@${domain}`;
}

async function blockSpamSender(email) {
  const fromAddress = email.from_address?.trim().toLowerCase();
  const domain = fromAddress?.split('@')[1];
  if (!domain) return;
  const redactedFrom = redactEmail(fromAddress);

  // Don't block known good domains
  const isVendor = await db('vendor_email_domains').where('domain', domain).first();
  if (isVendor) return;

  // Don't block customer emails
  const isCustomer = await db('customers').where('email', fromAddress).first();
  if (isCustomer) return;

  // Check if already blocked
  const existingQuery = db('blocked_email_senders').where('email_address', fromAddress);
  if (!SHARED_EMAIL_DOMAINS.has(domain)) existingQuery.orWhere('domain', domain);
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
  const normalized = fromAddress.trim().toLowerCase();
  const domain = normalized.split('@')[1];
  const blocked = await db('blocked_email_senders')
    .where('domain', domain)
    .orWhere('email_address', normalized)
    .first();

  if (blocked) {
    await db('blocked_email_senders').where({ id: blocked.id }).increment('blocked_count', 1);
    return true;
  }
  return false;
}

module.exports = { blockSpamSender, unblockSender, isBlocked };
