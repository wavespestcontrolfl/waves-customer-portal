/**
 * Estimate Follow-Up Service
 *
 * Auto-sends follow-up SMS + email to customers who:
 *   - Received an estimate but haven't viewed it (24h)
 *   - Viewed an estimate but haven't accepted (48h, 5d)
 *   - Estimate is about to expire (1-3 days before)
 *
 * Runs via cron every 2 hours. SMS is primary, email is a second channel —
 * each stage's flag flips once either channel attempts so we don't re-nudge.
 */

const db = require('../models/db');
const TwilioService = require('./twilio');
const EmailService = require('./email');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const logger = require('./logger');

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body && !body.includes('{first_name}')) return body;
    }
  } catch { /* fall through */ }
  return fallback;
}

// Shared sender — fires SMS if phone exists, email if email exists. Returns
// true if at least one channel attempted (callers use this to decide whether
// to flip the stage flag).
async function sendDualChannel(est, { sms, email }) {
  let attempted = false;
  if (est.customer_phone) {
    try {
      await TwilioService.sendSMS(est.customer_phone, sms);
      attempted = true;
    } catch (e) {
      logger.error(`[est-followup] SMS failed for estimate ${est.id}: ${e.message}`);
    }
  }
  if (est.customer_email) {
    try {
      const r = await EmailService.send({
        to: est.customer_email,
        subject: email.subject,
        heading: email.heading,
        body: email.body,
        ctaUrl: email.ctaUrl,
        ctaLabel: email.ctaLabel || 'View Your Estimate',
      });
      if (r.ok) attempted = true;
    } catch (e) {
      logger.error(`[est-followup] Email failed for estimate ${est.id}: ${e.message}`);
    }
  }
  return attempted;
}

const EstimateFollowUp = {
  async checkAll() {
    let sent = 0;

    // 1. Sent but NOT viewed after 24 hours
    try {
      const unviewed = await db('estimates')
        .where({ status: 'sent' })
        .whereNull('viewed_at')
        .where('sent_at', '<', new Date(Date.now() - 24 * 3600000))
        .where('sent_at', '>', new Date(Date.now() - 48 * 3600000))
        .where(q => q.whereNotNull('customer_phone').orWhereNotNull('customer_email'))
        .where(q => q.where('followup_unviewed_sent', false).orWhereNull('followup_unviewed_sent'));

      for (const est of unviewed) {
        try {
          const firstName = (est.customer_name || '').split(' ')[0] || 'there';
          const url = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          const smsBody = await renderTemplate('estimate_followup_unviewed',
            { first_name: firstName, estimate_url: url },
            `Hey ${firstName}! Just wanted to make sure you saw your Waves Pest Control estimate 🌊\n\n${url}\n\nTake a look when you get a chance — we're here if you have any questions! (941) 318-7612`
          );
          const ok = await sendDualChannel(est, {
            sms: smsBody,
            email: {
              subject: 'Your Waves estimate is ready to review',
              heading: `Hi ${firstName} — did you see your estimate?`,
              body: `<p>We sent your Waves Pest Control estimate yesterday and wanted to make sure it didn't get lost in your inbox.</p><p>Take a quick look whenever you get a chance — no pressure, we're here to answer any questions.</p>`,
              ctaUrl: url,
            },
          });
          if (ok) {
            await db('estimates').where({ id: est.id }).update({
              followup_unviewed_sent: true,
              follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
              last_follow_up_at: db.fn.now(),
            });
            sent++;
          }
        } catch (e) { logger.error(`[est-followup] Unviewed send failed: ${e.message}`); }
      }
    } catch { /* columns may not exist */ }

    // 2. Viewed but NOT accepted after 48 hours
    try {
      const viewedNotAccepted = await db('estimates')
        .where({ status: 'viewed' })
        .whereNotNull('viewed_at')
        .where('viewed_at', '<', new Date(Date.now() - 48 * 3600000))
        .where('viewed_at', '>', new Date(Date.now() - 72 * 3600000))
        .where(q => q.whereNotNull('customer_phone').orWhereNotNull('customer_email'))
        .where(q => q.where('followup_viewed_sent', false).orWhereNull('followup_viewed_sent'));

      for (const est of viewedNotAccepted) {
        try {
          const firstName = (est.customer_name || '').split(' ')[0] || 'there';
          const url = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          const smsBody = await renderTemplate('estimate_followup_viewed',
            { first_name: firstName, estimate_url: url },
            `Hi ${firstName}! I noticed you checked out your Waves estimate — any questions I can answer? 🌊\n\n${url}\n\nI'm happy to walk through it with you. Just reply here or call (941) 318-7612.\n\n— Adam, Waves Pest Control`
          );
          const ok = await sendDualChannel(est, {
            sms: smsBody,
            email: {
              subject: 'Any questions about your Waves estimate?',
              heading: `Hi ${firstName} — any questions?`,
              body: `<p>Thanks for taking a look at your Waves estimate! If anything isn't clear or you'd like to talk through what's included, I'm happy to help.</p><p>Just reply to this email or call me directly at (941) 318-7612.</p><p>— Adam, Waves Pest Control</p>`,
              ctaUrl: url,
            },
          });
          if (ok) {
            await db('estimates').where({ id: est.id }).update({
              followup_viewed_sent: true,
              follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
              last_follow_up_at: db.fn.now(),
            });
            sent++;
          }
        } catch (e) { logger.error(`[est-followup] Viewed-not-accepted send failed: ${e.message}`); }
      }
    } catch { /* columns may not exist */ }

    // 3. Viewed but NOT accepted after 5 days (final nudge)
    try {
      const finalNudge = await db('estimates')
        .where({ status: 'viewed' })
        .whereNotNull('viewed_at')
        .where('viewed_at', '<', new Date(Date.now() - 5 * 86400000))
        .where('viewed_at', '>', new Date(Date.now() - 6 * 86400000))
        .where(q => q.whereNotNull('customer_phone').orWhereNotNull('customer_email'))
        .where(q => q.where('followup_final_sent', false).orWhereNull('followup_final_sent'));

      for (const est of finalNudge) {
        try {
          const firstName = (est.customer_name || '').split(' ')[0] || 'there';
          const url = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          const smsBody = await renderTemplate('estimate_followup_final',
            { first_name: firstName, estimate_url: url },
            `Hey ${firstName} — last check-in from me! Your Waves estimate is still available:\n\n${url}\n\nWe'd love to earn your business. No pressure at all — just reply if you'd like to move forward or have any questions.\n\n— Adam 🌊`
          );
          const ok = await sendDualChannel(est, {
            sms: smsBody,
            email: {
              subject: 'Last check-in on your Waves estimate',
              heading: `Last check-in, ${firstName}`,
              body: `<p>Wanted to send one last friendly reminder that your Waves estimate is still available. No pressure at all — if we're not the right fit, that's OK.</p><p>But if you'd like to move forward or you have questions I can answer, just reply here.</p><p>— Adam, Waves Pest Control</p>`,
              ctaUrl: url,
            },
          });
          if (ok) {
            await db('estimates').where({ id: est.id }).update({
              followup_final_sent: true,
              follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
              last_follow_up_at: db.fn.now(),
            });
            sent++;
          }
        } catch (e) { logger.error(`[est-followup] Final nudge send failed: ${e.message}`); }
      }
    } catch { /* columns may not exist */ }

    // 4. Expiring in 1-3 days
    try {
      const expiring = await db('estimates')
        .whereIn('status', ['sent', 'viewed'])
        .whereNotNull('expires_at')
        .where(q => q.whereNotNull('customer_phone').orWhereNotNull('customer_email'))
        .whereBetween('expires_at', [
          new Date(Date.now() + 1 * 86400000),
          new Date(Date.now() + 3 * 86400000),
        ])
        .where(q => q.where('followup_expiring_sent', false).orWhereNull('followup_expiring_sent'));

      for (const est of expiring) {
        try {
          const firstName = (est.customer_name || '').split(' ')[0] || 'there';
          const url = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          const expDate = new Date(est.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
          const smsBody = await renderTemplate('estimate_followup_expiring',
            { first_name: firstName, estimate_url: url, expires_at: expDate },
            `Hi ${firstName}! Just a heads up — your Waves Pest Control estimate expires on ${expDate}.\n\n${url}\n\nLet us know if you'd like to move forward! (941) 318-7612 🌊`
          );
          const ok = await sendDualChannel(est, {
            sms: smsBody,
            email: {
              subject: `Your Waves estimate expires ${expDate}`,
              heading: `Heads up, ${firstName} — your estimate expires ${expDate}`,
              body: `<p>Your Waves Pest Control estimate is set to expire on <strong>${expDate}</strong>. If you'd like to move forward, just accept it from the link below.</p><p>Questions? Reply to this email or call (941) 318-7612.</p>`,
              ctaUrl: url,
            },
          });
          if (ok) {
            await db('estimates').where({ id: est.id }).update({
              followup_expiring_sent: true,
              follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
              last_follow_up_at: db.fn.now(),
            });
            sent++;
          }
        } catch (e) { logger.error(`[est-followup] Expiry reminder failed: ${e.message}`); }
      }
    } catch { /* columns may not exist */ }

    if (sent > 0) logger.info(`[est-followup] Sent ${sent} follow-ups (SMS+email)`);
    return { sent };
  },
};

module.exports = EstimateFollowUp;
