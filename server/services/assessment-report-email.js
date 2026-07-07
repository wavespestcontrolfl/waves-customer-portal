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

const EmailTemplateLibrary = require('./email-template-library');
const sendgrid = require('./sendgrid-mail');

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

  const result = await EmailTemplateLibrary.sendTemplate({
    templateKey: 'assessment.report_link',
    to,
    payload: {
      first_name: firstName || 'there',
      report_type_label: TYPE_LABELS[type] || 'Assessment Report',
      report_url: reportUrl,
      expires_note: expiresNote,
    },
    recipientType: recipientType || null,
    recipientId: recipientId || null,
    triggerEventId: `assessment_report:${type}:${assessmentId}`,
    // Minute-bucketed key: a double-click / double-submit dedupes, while a
    // deliberate later resend (same assessment, same address) still goes out.
    idempotencyKey: `assessment_report:${type}:${assessmentId}:${String(to).toLowerCase()}:${Math.floor(Date.now() / 60000)}`,
    categories: ['assessment_report'],
  });

  if (result.blocked) {
    return { ok: false, blocked: true, error: result.reason || 'Email suppressed for this recipient' };
  }
  return { ok: !!result.sent, messageId: result.message?.provider_message_id || null };
}

module.exports = { sendAssessmentReportEmail, TYPE_LABELS };
