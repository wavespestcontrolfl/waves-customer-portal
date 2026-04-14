const { google } = require('googleapis');
const db = require('../../models/db');
const logger = require('../logger');

async function blockSpamSender(email) {
  const domain = email.from_address?.split('@')[1];
  if (!domain) return;

  // Don't block known good domains
  const isVendor = await db('vendor_email_domains').where('domain', domain).first();
  if (isVendor) return;

  // Don't block customer emails
  const isCustomer = await db('customers').where('email', email.from_address).first();
  if (isCustomer) return;

  // Check if already blocked
  const existing = await db('blocked_email_senders')
    .where('domain', domain)
    .orWhere('email_address', email.from_address)
    .first();

  if (existing) {
    await db('blocked_email_senders').where({ id: existing.id }).increment('blocked_count', 1);
    return;
  }

  // Create Gmail filter to auto-delete future emails from this domain
  let filterId = null;
  try {
    const gmailClient = require('./gmail-client');
    const auth = await gmailClient.getAuthClient();
    if (auth) {
      const gmail = google.gmail({ version: 'v1', auth });
      const filter = await gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria: { from: `@${domain}` },
          action: { removeLabelIds: ['INBOX'], addLabelIds: ['TRASH'] },
        },
      });
      filterId = filter.data.id;
      logger.info(`[spam-blocker] Gmail filter created for @${domain}: ${filterId}`);
    }
  } catch (err) {
    logger.warn(`[spam-blocker] Gmail filter creation failed for @${domain}: ${err.message}`);
  }

  await db('blocked_email_senders').insert({
    domain,
    email_address: email.from_address,
    gmail_filter_id: filterId,
    reason: 'spam_auto',
  });

  logger.info(`[spam-blocker] Blocked: @${domain} (${email.from_address})`);
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
  const domain = fromAddress.split('@')[1];
  const blocked = await db('blocked_email_senders')
    .where('domain', domain)
    .orWhere('email_address', fromAddress)
    .first();

  if (blocked) {
    await db('blocked_email_senders').where({ id: blocked.id }).increment('blocked_count', 1);
    return true;
  }
  return false;
}

module.exports = { blockSpamSender, unblockSender, isBlocked };
