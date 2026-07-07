/**
 * Photo-assessment report email (lawn assessment + pest identification).
 *
 * ONE caller: the manual "Send report" button in /admin/lawn-assessments
 * (routes/admin-photo-assessments.js). Never wired to a cron, webhook, or
 * funnel event — the owner sends all customer comms, and this send IS the
 * owner's click.
 *
 * Template-library only, no SMTP fallback: if SendGrid / the template row is
 * unavailable the send fails honestly and the admin copies the report link
 * instead (the UI always offers copy-link). Kill switch = pausing the
 * assessment.report_link email_templates row.
 */

const crypto = require('crypto');
const EmailTemplateLibrary = require('./email-template-library');
const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');

const TYPE_LABELS = {
  lawn: 'Lawn Assessment',
  pest: 'Pest Identification Report',
};

/**
 * @param {object} opts
 * @param {'lawn'|'pest'} opts.type
 * @param {string} opts.assessmentId  row id (idempotency + trigger event scoping)
 * @param {string} opts.to            recipient email (validated by the route)
 * @param {string} opts.firstName
 * @param {string} opts.reportUrl     absolute tokenized report URL
 * @param {Date|string|null} opts.expiresAt
 * @param {string|null} opts.recipientType 'lead' | 'customer' | null
 * @param {string|null} opts.recipientId
 * @returns {{ok: boolean, blocked?: boolean, error?: string, messageId?: string|null}}
 */
async function sendAssessmentReportEmail({ type, assessmentId, to, firstName, reportUrl, expiresAt, recipientType, recipientId }) {
  if (!sendgrid.isConfigured()) {
    return { ok: false, error: 'Email is not configured — copy the report link instead.' };
  }

  const expiresNote = expiresAt
    ? `This private link is just for you and expires on ${new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' })}.`
    : 'This private link is just for you.';

  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'assessment.report_link',
      to,
      payload: {
        first_name: firstName || 'there',
        report_type_label: TYPE_LABELS[type] || 'Assessment Report',
        report_url: reportUrl,
        expires_note: expiresNote,
        // Shared template variables — the seeded copy renders
        // "call {{company_phone}}"; omitting them would ship a broken line.
        company_phone: '(941) 297-5749',
        company_email: 'contact@wavespestcontrol.com',
      },
      recipientType: recipientType || null,
      recipientId: recipientId || null,
      triggerEventId: `assessment_report:${type}:${assessmentId}`,
      // Minute-bucketed key: a double-click / double-submit dedupes, while a
      // deliberate later resend (same assessment, same address) still goes
      // out. The address is hashed so a long-but-valid email can't push the
      // key past email_messages.idempotency_key's varchar(260).
      idempotencyKey: `assessment_report:${type}:${assessmentId}:${crypto.createHash('sha256').update(String(to).toLowerCase()).digest('hex').slice(0, 16)}:${Math.floor(Date.now() / 60000)}`,
      categories: ['assessment_report'],
      // Admin-entered lead/customer addresses: keep raw provider error bodies
      // (which can echo the recipient email) out of the logs.
      suppressProviderErrorLog: true,
    });

    if (result.blocked) {
      return { ok: false, blocked: true, error: result.reason || 'Email suppressed for this recipient' };
    }
    return { ok: !!result.sent, messageId: result.message?.provider_message_id || null };
  } catch (err) {
    // A paused/archived template (the documented kill switch) or a provider
    // throw must degrade to a sanitized sent:false — the route still returns
    // the minted link so the admin can copy/share it manually.
    logger.warn(`[assessment-report-email] send failed for ${type} ${assessmentId}: ${err.code || err.name || 'error'}`);
    return {
      ok: false,
      error: err.code === 'EMAIL_TEMPLATE_DISABLED'
        ? 'The assessment report email template is paused — copy the link instead.'
        : 'Email send failed — copy the link instead.',
    };
  }
}

module.exports = { sendAssessmentReportEmail, TYPE_LABELS };
