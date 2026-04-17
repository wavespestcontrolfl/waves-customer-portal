const Anthropic = require('@anthropic-ai/sdk');
const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');

const anthropic = new Anthropic();

function parseClaudeJson(text) {
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    logger.warn(`[email-classifier] Failed to parse Claude JSON: ${text.substring(0, 200)}`);
    return null;
  }
}

async function classifyEmail(email) {
  try {
    // Get known vendor domains for context
    const vendors = await db('vendor_email_domains').select('domain', 'vendor_name');
    const vendorList = vendors.map(v => `${v.domain} (${v.vendor_name})`).join(', ');
    const senderDomain = email.from_address?.split('@')[1] || '';

    const bodyPreview = (email.body_text || email.snippet || '').substring(0, 2000);

    const response = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You are an email classifier for Waves Pest Control & Lawn Care, a family-owned pest control company in Southwest Florida.

Classify this email into exactly ONE category and extract relevant entities.

FROM: ${email.from_name || ''} <${email.from_address}>
SUBJECT: ${email.subject || '(no subject)'}
BODY (first 2000 chars):
${bodyPreview}

KNOWN VENDOR DOMAINS: ${vendorList || 'none configured'}
SENDER DOMAIN: ${senderDomain}

Categories:
- lead_inquiry: Someone asking about pest control, lawn care, mosquito, termite, or other services. They want a quote, estimate, or to schedule service.
- customer_request: An existing customer asking about their account, scheduling, billing, rescheduling, or service questions.
- complaint: A customer expressing dissatisfaction, frustration, or reporting a problem with service.
- vendor_invoice: An invoice, statement, receipt, or billing document from a known vendor/supplier.
- vendor_communication: Non-invoice email from a vendor (sales rep correspondence, product updates, promotions, order confirmations).
- scheduling: Email specifically about appointment scheduling, confirmations, or calendar-related.
- review_notification: Google review alert, Yelp notification, or any review platform email.
- regulatory: FDACS, EPA, DEP, or any government/regulatory body communication.
- marketing_newsletter: Marketing emails, newsletters, promotional offers FROM other companies (not customer inquiries about our services).
- internal: Email from team members, internal communications.
- spam: Unsolicited commercial email, phishing, irrelevant solicitations, SEO services pitches, link building outreach, "business opportunity" spam.
- other: Doesn't fit any category above.

Respond ONLY in JSON, no markdown:
{
  "category": "one of the categories above",
  "confidence": 0.0-1.0,
  "is_urgent": true/false,
  "summary": "one sentence summary of what this email is about",
  "extracted": {
    "person_name": "if identifiable",
    "phone": "if mentioned",
    "email": "sender email",
    "address": "if a property address is mentioned",
    "service_interest": "pest control, lawn care, mosquito, termite, etc. if relevant",
    "invoice_number": "if this is an invoice",
    "invoice_amount": "dollar amount if this is an invoice",
    "invoice_date": "date if this is an invoice",
    "urgency_reason": "why this is urgent, if applicable"
  }
}`,
      }],
    });

    const result = parseClaudeJson(response.content[0].text);
    if (!result) {
      logger.warn(`[email-classifier] Unparseable response for email ${email.id}`);
      return null;
    }

    // Update email record
    await db('emails').where({ id: email.id }).update({
      classification: result.category,
      classification_confidence: result.confidence,
      extracted_data: JSON.stringify(result),
      updated_at: new Date(),
    });

    // Execute auto-actions
    const { executeAutoAction } = require('./email-actions');
    await executeAutoAction(email, result);

    logger.info(`[email-classifier] ${email.id}: ${result.category} (${result.confidence}) — ${result.summary}`);
    return result;
  } catch (err) {
    logger.error(`[email-classifier] Failed for ${email.id}: ${err.message}`);
    return null;
  }
}

module.exports = { classifyEmail, parseClaudeJson };
