/**
 * Estimate Auto-Renew
 *
 * Runs daily. For any estimate that:
 *   - is sent or viewed (customer engaged but hasn't accepted/declined)
 *   - has expires_at in the past
 *   - hasn't already been auto-renewed (renewal_count < 1)
 *
 * extend expires_at by 7 days, bump renewal_count, and notify the customer
 * via SMS + email so they know it's still good. We only auto-renew once —
 * if the customer still hasn't moved after the second 7-day window, the
 * estimate dies naturally and lead-follow-up picks up the relationship.
 */

const db = require('../models/db');
const TwilioService = require('./twilio');
const EmailService = require('./email');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const logger = require('./logger');

const RENEWAL_DAYS = 7;

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body && !body.includes('{first_name}')) return body;
    }
  } catch { /* fall through */ }
  return fallback;
}

const EstimateAutoRenew = {
  async checkAll() {
    let renewed = 0;
    try {
      const stale = await db('estimates')
        .whereIn('status', ['sent', 'viewed'])
        .whereNotNull('expires_at')
        .where('expires_at', '<', new Date())
        .where(q => q.where('renewal_count', '<', 1).orWhereNull('renewal_count'))
        .where(q => q.whereNotNull('customer_phone').orWhereNotNull('customer_email'));

      for (const est of stale) {
        try {
          const newExpiry = new Date(Date.now() + RENEWAL_DAYS * 86400000);
          await db('estimates').where({ id: est.id }).update({
            expires_at: newExpiry,
            renewal_count: db.raw('COALESCE(renewal_count, 0) + 1'),
          });

          const firstName = (est.customer_name || '').split(' ')[0] || 'there';
          const url = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          const smsBody = await renderTemplate('estimate_auto_renewed',
            { first_name: firstName, estimate_url: url },
            `Hey ${firstName}! Your Waves estimate was about to expire so we extended it a few more days. Still good — take another look whenever you're ready:\n\n${url}\n\nQuestions? (941) 318-7612 🌊`
          );

          if (est.customer_phone) {
            try { await TwilioService.sendSMS(est.customer_phone, smsBody); }
            catch (e) { logger.error(`[est-auto-renew] SMS failed: ${e.message}`); }
          }
          if (est.customer_email) {
            try {
              await EmailService.send({
                to: est.customer_email,
                subject: 'Your Waves estimate was extended',
                heading: `Hey ${firstName} — we extended your estimate`,
                body: `<p>Your Waves Pest Control estimate was about to expire, so we went ahead and extended it by another few days. It's still good — take another look whenever you're ready.</p><p>Questions? Reply to this email or call (941) 318-7612.</p>`,
                ctaUrl: url,
                ctaLabel: 'View Your Estimate',
              });
            } catch (e) { logger.error(`[est-auto-renew] Email failed: ${e.message}`); }
          }

          renewed++;
        } catch (e) { logger.error(`[est-auto-renew] Failed to renew estimate ${est.id}: ${e.message}`); }
      }
    } catch (e) { logger.error(`[est-auto-renew] Query failed: ${e.message}`); }

    if (renewed > 0) logger.info(`[est-auto-renew] Renewed ${renewed} expired estimates`);
    return { renewed };
  },
};

module.exports = EstimateAutoRenew;
