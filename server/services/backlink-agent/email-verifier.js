const { ImapFlow } = require('imapflow');
const { chromium } = require('playwright');
const db = require('../../models/db');
const logger = require('../logger');

async function checkVerificationEmails() {
  const { isEnabled } = require('../../config/feature-gates');
  if (!isEnabled('backlinkAgent')) return { checked: 0, verified: 0 };

  const email = process.env.BACKLINK_AGENT_EMAIL;
  const password = process.env.BACKLINK_EMAIL_PASSWORD;
  const host = process.env.BACKLINK_EMAIL_IMAP_HOST || 'imap.gmail.com';

  if (!email || !password) {
    logger.info('[backlink-agent] Email credentials not set — skipping verification check');
    return { checked: 0, verified: 0 };
  }

  const client = new ImapFlow({ host, port: 993, secure: true, auth: { user: email, pass: password }, logger: false });

  let checked = 0, verified = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Search for unread emails from the last 7 days
      const since = new Date(Date.now() - 7 * 86400000);
      const messages = client.fetch({ seen: false, since }, { source: true, envelope: true });

      for await (const msg of messages) {
        checked++;
        const body = msg.source.toString();

        // Look for verification/confirm URLs
        const urlPattern = /https?:\/\/[^\s"'<>\])+]+(?:verify|confirm|activate|validation|email-confirm|registration)[^\s"'<>\])]+/gi;
        const verifyUrls = body.match(urlPattern);

        if (!verifyUrls || verifyUrls.length === 0) continue;

        // Try to match to a pending signup by sender domain
        const fromDomain = msg.envelope?.from?.[0]?.address?.split('@')[1]?.replace('mail.', '').replace('noreply.', '');

        const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();

        for (const url of verifyUrls.slice(0, 3)) { // Max 3 URLs per email
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            logger.info(`[backlink-agent] Clicked verify link: ${url.substring(0, 80)}...`);

            // Try to update the matching queue item
            if (fromDomain) {
              const updated = await db('backlink_agent_queue')
                .where('domain', 'like', `%${fromDomain}%`)
                .where('status', 'signup_complete')
                .update({ status: 'verified', updated_at: new Date() });
              if (updated > 0) verified++;
            }
          } catch (e) {
            logger.warn(`[backlink-agent] Verify click failed: ${e.message}`);
          }
        }

        await browser.close();

        // Mark email as read
        try {
          await client.messageFlagsAdd(msg.seq, ['\\Seen'], { uid: false });
        } catch { /* non-critical */ }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    logger.error(`[backlink-agent] Email check failed: ${err.message}`);
  }

  return { checked, verified };
}

module.exports = { checkVerificationEmails };
