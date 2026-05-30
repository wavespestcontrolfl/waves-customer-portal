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
const EmailService = require('./email');
const EmailTemplateLibrary = require('./email-template-library');
const EmailTemplateAutomationExecutor = require('./email-template-automation-executor');
const sendgrid = require('./sendgrid-mail');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const logger = require('./logger');
const { shortenOrPassthrough } = require('./short-url');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { isEnabled } = require('../config/feature-gates');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { smtpFallbackAllowed } = require('./email-fallback-gate');

const RENEWAL_DAYS = 7;

async function renderTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body && !body.includes('{first_name}')) return body;
    }
  } catch (err) {
    throw new Error(`SMS template ${templateKey} could not be rendered: ${err.message}`);
  }
  throw new Error(`SMS template ${templateKey} is missing or inactive`);
}

function canFallbackFromTemplateEmailError(err) {
  return /relation .*email_templates.* does not exist|active template not found|template version not found|template not found/i.test(err?.message || '');
}

function canFallbackFromAutomationEmailError(err) {
  return /relation .*email_template_automation|automation .*not found|does not define an idempotency key|active template not found|template version not found|template not found/i.test(err?.message || '');
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
          const longUrl = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          const url = await shortenOrPassthrough(longUrl, { kind: 'estimate', entityType: 'estimates', entityId: est.id, customerId: est.customer_id });
          let smsBody = null;
          if (est.customer_phone) {
            try {
              smsBody = await renderTemplate('estimate_auto_renewed',
                { first_name: firstName, estimate_url: url },
                { workflow: 'estimate_auto_renew', entity_type: 'estimate', entity_id: est.id },
              );
            } catch (e) {
              logger.warn(`[est-auto-renew] SMS template unavailable for estimate ${est.id}: ${e.message}`);
            }
          }

          if (est.customer_phone && smsBody) {
            try {
              const smsResult = await sendCustomerMessage({
                to: est.customer_phone,
                body: smsBody,
                channel: 'sms',
                audience: est.customer_id ? 'customer' : 'lead',
                purpose: 'estimate_followup',
                customerId: est.customer_id || undefined,
                estimateId: est.id,
                identityTrustLevel: est.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
                consentBasis: est.customer_id ? undefined : {
                  status: 'transactional_allowed',
                  source: 'estimate_auto_renew',
                  capturedAt: est.created_at || new Date().toISOString(),
                },
                entryPoint: 'estimate_auto_renew',
                metadata: { original_message_type: 'estimate_auto_renewed' },
              });
              if (!smsResult.sent) {
                logger.warn(`[est-auto-renew] SMS blocked/failed for estimate ${est.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
              }
            } catch (e) { logger.error(`[est-auto-renew] SMS failed: ${e.message}`); }
          }
          if (est.customer_email) {
            try {
              let sentWithTemplateLibrary = false;
              const formattedExpiry = newExpiry.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
              const extensionPayload = {
                estimate_id: est.id,
                customer_id: est.customer_id || '',
                customer_email: est.customer_email,
                first_name: firstName,
                estimate_url: url,
                new_expires_at: formattedExpiry,
                estimate_status: est.status,
                status: est.status,
                renewal_count: Number(est.renewal_count || 0) + 1,
              };
              if (sendgrid.isConfigured()) {
                try {
                  if (isEnabled('emailTemplateAutomations')) {
                    const result = await EmailTemplateAutomationExecutor.processTrigger({
                      triggerEventKey: 'estimate.auto_renewed',
                      triggerEventId: `estimate_auto_renew:${est.id}`,
                      entityType: 'estimate',
                      entityId: est.id,
                      recipient: {
                        email: est.customer_email,
                        type: est.customer_id ? 'customer' : 'lead',
                        id: est.customer_id || '',
                      },
                      payload: extensionPayload,
                      executeImmediately: true,
                    });
                    if (result.automation_count > 0) {
                      const statuses = result.results.map((r) => r.run?.status).filter(Boolean).join(', ') || 'queued';
                      logger.info(`[est-auto-renew] Email automation handled estimate ${est.id}: ${statuses}`);
                      sentWithTemplateLibrary = true;
                    }
                  }

                  if (!sentWithTemplateLibrary) {
                    const result = await EmailTemplateLibrary.sendTemplate({
                      templateKey: 'estimate.extension_notice',
                      to: est.customer_email,
                      payload: extensionPayload,
                      recipientType: est.customer_id ? 'customer' : 'lead',
                      recipientId: est.customer_id || null,
                      triggerEventId: `estimate_auto_renew:${est.id}`,
                      categories: ['estimate_auto_renew'],
                    });
                    if (result.blocked) {
                      logger.warn(`[est-auto-renew] Email suppressed for estimate ${est.id}: ${result.reason || 'suppressed'}`);
                    }
                    sentWithTemplateLibrary = true;
                  }
                } catch (e) {
                  if (!canFallbackFromTemplateEmailError(e) && !canFallbackFromAutomationEmailError(e)) throw e;
                  logger.warn(`[est-auto-renew] Template unavailable for estimate ${est.id}; falling back to SMTP: ${e.message}`);
                }
              }
              if (!sentWithTemplateLibrary) {
                if (!smtpFallbackAllowed()) {
                  logger.error(`[est-auto-renew] SMTP fallback disabled in production for estimate ${est.id} — SendGrid template send required`);
                } else {
                  await EmailService.send({
                    to: est.customer_email,
                    subject: 'Your Waves estimate was extended',
                    heading: `Hey ${firstName} — we extended your estimate`,
                    body: `<p>Your Waves Pest Control estimate was about to expire, so we went ahead and extended it by another few days. It's still good — take another look whenever you're ready.</p><p>Questions? Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.</p>`,
                    ctaUrl: url,
                    ctaLabel: 'View Your Estimate',
                  });
                }
              }
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
