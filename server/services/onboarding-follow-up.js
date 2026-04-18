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

// Join with customers so we have phone + first_name in one query
function baseQuery() {
  return db('onboarding_sessions')
    .leftJoin('customers', 'onboarding_sessions.customer_id', 'customers.id')
    .whereNot('onboarding_sessions.status', 'complete')
    .whereNotNull('customers.phone')
    .select(
      'onboarding_sessions.id',
      'onboarding_sessions.token',
      'onboarding_sessions.status',
      'onboarding_sessions.started_at',
      'onboarding_sessions.expires_at',
      'onboarding_sessions.waveguard_tier',
      'customers.first_name',
      'customers.phone'
    );
}

const ONBOARD_URL = (token) => `https://portal.wavespestcontrol.com/onboard/${token}`;

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
          const url = ONBOARD_URL(ob.token);
          const body = await renderTemplate('onboarding_followup_24h',
            { first_name: firstName, onboarding_url: url, waveguard_tier: ob.waveguard_tier || 'Bronze' },
            `Hey ${firstName}! Thanks again for choosing Waves 🌊 Just need a few quick details to get you on the schedule — takes ~2 minutes:\n\n${url}\n\nQuestions? Reply here or call (941) 318-7612.`
          );
          await TwilioService.sendSMS(ob.phone, body);
          await db('onboarding_sessions').where({ id: ob.id }).update({ followup_24h_sent: true });
          sent++;
        } catch (e) { logger.error(`[onboard-followup] 24h SMS failed: ${e.message}`); }
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
          const url = ONBOARD_URL(ob.token);
          const body = await renderTemplate('onboarding_followup_72h',
            { first_name: firstName, onboarding_url: url, waveguard_tier: ob.waveguard_tier || 'Bronze' },
            `Hi ${firstName}! Still here whenever you're ready — wrap up your Waves setup here and we'll confirm your first service:\n\n${url}\n\n— Adam, Waves Pest Control 🌊`
          );
          await TwilioService.sendSMS(ob.phone, body);
          await db('onboarding_sessions').where({ id: ob.id }).update({ followup_72h_sent: true });
          sent++;
        } catch (e) { logger.error(`[onboard-followup] 72h SMS failed: ${e.message}`); }
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
          const url = ONBOARD_URL(ob.token);
          const expDate = new Date(ob.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
          const body = await renderTemplate('onboarding_followup_expiring',
            { first_name: firstName, onboarding_url: url, expires_at: expDate, waveguard_tier: ob.waveguard_tier || 'Bronze' },
            `Hey ${firstName} — heads up, your Waves onboarding link expires on ${expDate}. Lock in your ${ob.waveguard_tier || 'Bronze'} WaveGuard plan and first service here:\n\n${url}\n\nQuestions? (941) 318-7612 🌊`
          );
          await TwilioService.sendSMS(ob.phone, body);
          await db('onboarding_sessions').where({ id: ob.id }).update({ followup_expiring_sent: true });
          sent++;
        } catch (e) { logger.error(`[onboard-followup] Expiring SMS failed: ${e.message}`); }
      }
    } catch (e) { logger.error(`[onboard-followup] Expiring query failed: ${e.message}`); }

    if (sent > 0) logger.info(`[onboard-followup] Sent ${sent} onboarding nudge SMS`);
    return { sent };
  },
};

module.exports = OnboardingFollowUp;
