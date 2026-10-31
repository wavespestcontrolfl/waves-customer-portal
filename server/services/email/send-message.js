/**
 * The ONE native email send, shared by POST /api/admin/email/send (the Email page's Send) and the Intelligence Bar's
 * compose_email card (services/intelligence-bar/compose-email-tools.js), so the two can never drift.
 *
 * It does exactly what the route always did and nothing more: one Gmail message from the connected mailbox
 * (gmail-client.sendMessage: From "Waves Pest Control <GMAIL_USER_EMAIL>", the recipient, a UTF-8 subject, an HTML body,
 * In-Reply-To / References and a thread id when it answers a message). No signature is added, no copy is logged or linked
 * to a customer, and there is no suppression or opt-out check: the page's own composer is the only gate. Only the Gmail
 * message id is logged, never the recipient.
 *
 * Returns { status, json } so the route can answer with it unchanged:
 *   200 { success, status: 'provider_accepted', messageId }   Gmail accepted it
 *   202 { status: 'outcome_unknown' }                          Gmail may have accepted it (no id, or a timeout): check Sent
 *   502 { status: 'failed' }                                   Gmail definitely did not accept it
 */
const logger = require('../logger');

async function sendEmailMessage({ to, subject, body, threadId, inReplyTo } = {}) {
  try {
    const gmailClient = require('./gmail-client');
    const result = await gmailClient.sendMessage(to, subject || '(no subject)', body, threadId, inReplyTo);
    // Log only the provider message id — no recipient address, even masked.
    if (!result?.id) return { status: 202, json: { status: 'outcome_unknown', error: 'Check the Sent folder before retrying.' } };
    logger.info(`[email] Sent email: ${result.id}`);
    return { status: 200, json: { success: true, status: 'provider_accepted', messageId: result.id } };
  } catch (err) {
    const unknown = err.providerOutcome?.outcomeUnknown === true;
    logger.error(`[email] Send outcome: ${unknown ? 'unknown' : 'failed'}`);
    return {
      status: unknown ? 202 : 502,
      json: { status: unknown ? 'outcome_unknown' : 'failed', error: unknown ? 'Check the Sent folder before retrying.' : 'The email was not accepted. Try again.' },
    };
  }
}

// The Email page's composer sends plain text as HTML (client/src/pages/admin/email/useEmailEditor.js encodeEmailBody):
// the four HTML-significant characters escaped, then newlines as <br>, so what an operator reads is what arrives.
// The bar's compose_email sends its carded plain text through the same encoding.
function encodeEmailBody(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

module.exports = { sendEmailMessage, encodeEmailBody };
