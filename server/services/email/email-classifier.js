const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');

// Mirrors the category vocabulary in the classification prompt below. Used
// to sanitize LOG lines: category/confidence are model output and must never
// be echoed off-vocabulary (PII could ride in either field).
const EMAIL_CATEGORIES = [
  'lead_inquiry', 'customer_request', 'complaint', 'vendor_invoice',
  'vendor_communication', 'scheduling', 'review_notification', 'regulatory',
  'marketing_newsletter', 'internal', 'spam', 'other',
];

function parseClaudeJson(text) {
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    // No raw excerpt: the model output is derived from a customer email and
    // can carry their name/address/contact details (AGENTS.md PII-in-logs).
    logger.warn(`[email-classifier] Failed to parse Claude JSON (${String(text || '').length} chars)`);
    return null;
  }
}

/**
 * Pure classification: vendor-context lookup + Claude call + parse. NO DB
 * writes, NO auto-actions — safe to call on a fixture email that has no
 * `emails` row (the weekly incident-regression eval replays historical
 * incident emails through this). Returns the parsed classification, null on
 * unparseable model output, and THROWS on API errors so callers can tell
 * "model unavailable" apart from "model answered garbage".
 */
async function classifyEmailContent(email) {
  // Get known vendor domains for context
  const vendors = await db('vendor_email_domains').select('domain', 'vendor_name');
  const vendorList = vendors.map(v => `${v.domain} (${v.vendor_name})`).join(', ');
  const senderDomain = email.from_address?.split('@')[1] || '';

  const bodyPreview = (email.body_text || email.snippet || '').substring(0, 2000);

  const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
    maxTokens: 512,
    jsonMode: true,
    text: `You are an email classifier for Waves Pest Control & Lawn Care, a family-owned pest control company in Southwest Florida.

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
  });
  if (!response.ok) throw new Error(`classification providers unavailable: ${response.reason}`);
  const result = response.json || parseClaudeJson(response.text);
  if (!result) {
    logger.warn(`[email-classifier] Unparseable response for email ${email.id}`);
    return null;
  }
  return result;
}

async function classifyEmail(email) {
  try {
    const result = await classifyEmailContent(email);
    if (!result) return null;

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

    // Category + confidence only, and only from the fixed vocabulary — both
    // fields are model output, so an off-vocabulary value is logged as a
    // sentinel rather than echoed (a malformed-but-valid JSON response could
    // otherwise put the customer's name/email into either field). The model
    // summary stays out entirely: it restates the customer's email and
    // belongs in the DB row, not the logs.
    const loggedCategory = EMAIL_CATEGORIES.includes(result.category) ? result.category : 'invalid_category';
    const numericConfidence = Number(result.confidence);
    const loggedConfidence = Number.isFinite(numericConfidence) && numericConfidence >= 0 && numericConfidence <= 1
      ? numericConfidence
      : 'invalid';
    logger.info(`[email-classifier] ${email.id}: ${loggedCategory} (${loggedConfidence})`);
    return result;
  } catch (err) {
    logger.error(`[email-classifier] Failed for ${email.id}: ${err.message}`);
    return null;
  }
}

module.exports = { classifyEmail, classifyEmailContent, parseClaudeJson };
