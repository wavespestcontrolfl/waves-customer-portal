/**
 * Newsletter validation gate — pre-send checks for the content engine.
 */

const { getNewsletterType, isFlagshipType } = require('../config/newsletter-types');
const { validateVoice } = require('../config/voice-profiles');

function validateNewsletterDraft(send, opts = {}) {
  const errors = [];
  const warnings = [];

  if (!send.subject || !send.subject.trim()) errors.push('Subject line is required');
  if ((!send.html_body || !send.html_body.trim()) && (!send.text_body || !send.text_body.trim())) {
    errors.push('Body is required (HTML or plain text)');
  }
  if (opts.recipientCount === 0) errors.push('Segment matches 0 active subscribers');

  const typeConfig = getNewsletterType(send.newsletter_type);

  if (typeConfig?.voiceProfile) {
    const voiceResult = validateVoice(
      { subject: send.subject, htmlBody: send.html_body, textBody: send.text_body },
      typeConfig.voiceProfile,
    );
    warnings.push(...voiceResult.warnings);
  }

  if (send.subject && send.subject.length > 80) {
    warnings.push(`Subject line is ${send.subject.length} chars (recommended max 80)`);
  }
  if (!send.preview_text || !send.preview_text.trim()) {
    warnings.push('Preview text is empty');
  }

  if (isFlagshipType(send.newsletter_type) && send.html_body) {
    const bodyText = send.html_body.replace(/<[^>]+>/g, '').toLowerCase();
    if (!['homeowner minute', 'homeowner tip', 'quick tip', 'before heading out'].some((s) => bodyText.includes(s))) {
      warnings.push('No Homeowner Minute section detected');
    }
    if (!['schedule service', 'book', 'call us', 'reply to this email', 'wavespestcontrol.com'].some((s) => bodyText.includes(s))) {
      warnings.push('No Waves CTA detected');
    }
    if (!send.html_body.includes('<h2>') && !send.html_body.includes('<strong>')) {
      warnings.push('No event structure detected');
    }
  }

  return { errors, warnings };
}

module.exports = { validateNewsletterDraft };
