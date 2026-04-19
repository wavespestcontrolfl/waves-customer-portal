/**
 * Onboarding Follow-Up Service
 *
 * Auto-sends SMS to customers who accepted an estimate but haven't finished
 * their 4-step onboarding (payment → service confirmation → property details
 * → complete).
 *
 * Stages (each fires at most once per onboarding session):
 *   1. 24h reminder     — started, not complete, 24-36h window
 *   2. 72h reminder     — still not complete, 72-96h window
 *   3. Expiring in 2d   — expires_at is 1-2 days away (last chance before
 *                         the link dies at the 7-day cliff)
 *
 * Runs on the same 2h cron as estimate-follow-up.
 */

const db = require('../models/db');
const TwilioService = require('./twilio');
const EmailService = require('./email');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { shortenOrPassthrough } = require('./short-url');
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

// Join with customers so we have phone + email + first_name in one query.
// Require at least one contact channel (phone OR email) — email-only customers
// get onboarding nudges too.
function baseQuery() {
  return db('onboarding_sessions')
    .leftJoin('customers', 'onboarding_sessions.customer_id', 'customers.id')
    .whereNot('onboarding_sessions.status', 'complete')
    .where(q => q.whereNotNull('customers.phone').orWhereNotNull('customers.email'))
    .select(
      'onboarding_sessions.id',
      'onboarding_sessions.token',
      'onboarding_sessions.customer_id',
      'onboarding_sessions.status',
      'onboarding_sessions.started_at',
      'onboarding_sessions.expires_at',
      'onboarding_sessions.waveguard_tier',
      'customers.first_name',
      'customers.phone',
      'customers.email'
    );
}

// Build + shorten the onboarding URL in one step — keeps every follow-up stage
// consistently using short links and records the click-attribution metadata.
async function onboardUrl(ob) {
  const long = `https://portal.wavespestcontrol.com/onboard/${ob.token}`;
  return shortenOrPassthrough(long, {
    kind: 'onboarding',
    entityType: 'onboarding_sessions',
    entityId: ob.id,
    customerId: ob.customer_id,
  });
}

// Fire SMS (if phone) + email (if email). Returns true if at least one
// attempt succeeded, so the caller knows whether to flip the stage flag.
async function sendDualChannel(ob, { sms, email }) {
  let attempted = false;
  if (ob.phone) {
    try {
      await TwilioService.sendSMS(ob.phone, sms);
      attempted = true;
    } catch (e) {
      logger.error(`[onboard-followup] SMS failed for session ${ob.id}: ${e.message}`);
    }
  }
  if (ob.email) {
    try {
      const r = await EmailService.send({
        to: ob.email,
        subject: email.subject,
        heading: email.heading,
        body: email.body,
        ctaUrl: email.ctaUrl,
        ctaLabel: email.ctaLabel || 'Finish Setup',
      });
      if (r.ok) attempted = true;
    } catch (e) {
      logger.error(`[onboard-followup] Email failed for session ${ob.id}: ${e.message}`);
    }
  }
  return attempted;
}

const OnboardingFollowUp = {
  async checkAll() {
    let sent = 0;

    // 1. Started but not complete, 24-36h window
    try {
      const stalled = await baseQuery()
        .where('onboarding_sessions.started_at', '<', new Date(Date.now() - 24 * 3600000))
        .where('onboarding_sessions.started_at', '>', new Date(Date.now() - 36 * 3600000))
        .where(q => q.where('onboarding_sessions.followup_24h_sent', false).orWhereNull('onboarding_sessions.followup_24h_sent'));

      for (const ob of stalled) {
        try {
          const firstName = ob.first_name || 'there';
          const url = await onboardUrl(ob);
          const smsBody = await renderTemplate('onboarding_followup_24h',
            { first_name: firstName, onboarding_url: url, waveguard_tier: ob.waveguard_tier || 'Bronze' },
            `Hey ${firstName}! Thanks again for choosing Waves 🌊 Just need a few quick details to get you on the schedule — takes ~2 minutes:\n\n${url}\n\nQuestions? Reply here or call (941) 318-7612.`
          );
          const ok = await sendDualChannel(ob, {
            sms: smsBody,
            email: {
              subject: 'Finish setting up your Waves service',
              heading: `Welcome aboard, ${firstName}!`,
              body: `<p>Thanks for choosing Waves Pest Control! We just need a few quick details to get you on the schedule — it takes about 2 minutes.</p><p>Tap the button below to finish.</p>`,
              ctaUrl: url,
            },
          });
          if (ok) {
            await db('onboarding_sessions').where({ id: ob.id }).update({ followup_24h_sent: true });
            sent++;
          }
        } catch (e) { logger.error(`[onboard-followup] 24h send failed: ${e.message}`); }
      }
    } catch (e) { logger.error(`[onboard-followup] 24h query failed: ${e.message}`); }

    // 2. Still not complete, 72-96h window
    try {
      const stillStalled = await baseQuery()
        .where('onboarding_sessions.started_at', '<', new Date(Date.now() - 72 * 3600000))
        .where('onboarding_sessions.started_at', '>', new Date(Date.now() - 96 * 3600000))
        .where(q => q.where('onboarding_sessions.followup_72h_sent', false).orWhereNull('onboarding_sessions.followup_72h_sent'));

      for (const ob of stillStalled) {
        try {
          const firstName = ob.first_name || 'there';
          const url = await onboardUrl(ob);
          const smsBody = await renderTemplate('onboarding_followup_72h',
            { first_name: firstName, onboarding_url: url, waveguard_tier: ob.waveguard_tier || 'Bronze' },
            `Hi ${firstName}! Still here whenever you're ready — wrap up your Waves setup here and we'll confirm your first service:\n\n${url}\n\n— Adam, Waves Pest Control 🌊`
          );
          const ok = await sendDualChannel(ob, {
            sms: smsBody,
            email: {
              subject: 'Still here whenever you are',
              heading: `Hi ${firstName}`,
              body: `<p>Just a friendly nudge — whenever you're ready, finish up your Waves setup and we'll confirm your first service.</p><p>No rush. If anything is holding you up, just reply to this email.</p><p>— Adam, Waves Pest Control</p>`,
              ctaUrl: url,
            },
          });
          if (ok) {
            await db('onboarding_sessions').where({ id: ob.id }).update({ followup_72h_sent: true });
            sent++;
          }
        } catch (e) { logger.error(`[onboard-followup] 72h send failed: ${e.message}`); }
      }
    } catch (e) { logger.error(`[onboard-followup] 72h query failed: ${e.message}`); }

    // 3. Expiring in 1-2 days (last chance)
    try {
      const expiring = await baseQuery()
        .whereNotNull('onboarding_sessions.expires_at')
        .whereBetween('onboarding_sessions.expires_at', [
          new Date(Date.now() + 1 * 86400000),
          new Date(Date.now() + 2 * 86400000),
        ])
        .where(q => q.where('onboarding_sessions.followup_expiring_sent', false).orWhereNull('onboarding_sessions.followup_expiring_sent'));

      for (const ob of expiring) {
        try {
          const firstName = ob.first_name || 'there';
          const url = await onboardUrl(ob);
          const expDate = new Date(ob.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
          const tier = ob.waveguard_tier || 'Bronze';
          const smsBody = await renderTemplate('onboarding_followup_expiring',
            { first_name: firstName, onboarding_url: url, expires_at: expDate, waveguard_tier: tier },
            `Hey ${firstName} — heads up, your Waves onboarding link expires on ${expDate}. Lock in your ${tier} WaveGuard plan and first service here:\n\n${url}\n\nQuestions? (941) 318-7612 🌊`
          );
          const ok = await sendDualChannel(ob, {
            sms: smsBody,
            email: {
              subject: `Your Waves onboarding link expires ${expDate}`,
              heading: `Heads up — your link expires ${expDate}`,
              body: `<p>Your Waves onboarding link is set to expire on <strong>${expDate}</strong>. Finish up to lock in your ${tier} WaveGuard plan and get scheduled for your first service.</p><p>Questions? Reply to this email or call (941) 318-7612.</p>`,
              ctaUrl: url,
            },
          });
          if (ok) {
            await db('onboarding_sessions').where({ id: ob.id }).update({ followup_expiring_sent: true });
            sent++;
          }
        } catch (e) { logger.error(`[onboard-followup] Expiring send failed: ${e.message}`); }
      }
    } catch (e) { logger.error(`[onboard-followup] Expiring query failed: ${e.message}`); }

    if (sent > 0) logger.info(`[onboard-followup] Sent ${sent} onboarding nudges (SMS+email)`);
    return { sent };
  },
};

module.exports = OnboardingFollowUp;
