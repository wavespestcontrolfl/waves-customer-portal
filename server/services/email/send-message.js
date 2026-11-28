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

// In-process idempotency fence for native sends (H01): a retry carrying the
// same attempt idempotencyKey while a send is in-flight or after Gmail
// accepted (200) / returned an ambiguous outcome (202) returns the original
// outcome without calling Gmail a second time. Definite pre-send failures
// (502, status: 'failed') clear their entry so the operator can safely retry.
const SEND_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const SEND_IDEMPOTENCY_MAX_ENTRIES = 500;
const sendIdempotencyCache = new Map();

function pruneIdempotencyCache(now = Date.now()) {
  for (const [key, entry] of sendIdempotencyCache.entries()) {
    if (entry.state === 'settled' && now - entry.createdAt > SEND_IDEMPOTENCY_TTL_MS) {
      sendIdempotencyCache.delete(key);
    }
  }
  if (sendIdempotencyCache.size <= SEND_IDEMPOTENCY_MAX_ENTRIES) return;
  for (const [key, entry] of sendIdempotencyCache.entries()) {
    if (sendIdempotencyCache.size <= SEND_IDEMPOTENCY_MAX_ENTRIES) break;
    // Never evict an active in-flight send — doing so would let a concurrent
    // retry bypass the fence and double-send via Gmail.
    if (entry.state === 'settled') sendIdempotencyCache.delete(key);
  }
}

async function performGmailSend({ to, subject, body, threadId, inReplyTo }) {
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

async function sendEmailMessage({ to, subject, body, threadId, inReplyTo, idempotencyKey } = {}) {
  const key = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;
  if (!key) return performGmailSend({ to, subject, body, threadId, inReplyTo });

  const now = Date.now();
  pruneIdempotencyCache(now);

  const existing = sendIdempotencyCache.get(key);
  if (existing) {
    if (existing.state === 'in_flight') return existing.promise;
    if (now - existing.createdAt <= SEND_IDEMPOTENCY_TTL_MS) return existing.result;
    sendIdempotencyCache.delete(key);
  }

  const promise = performGmailSend({ to, subject, body, threadId, inReplyTo }).then((outcome) => {
    if (outcome.json?.status === 'failed') {
      // Definite refusal: Gmail never accepted it, so release the key for retry.
      sendIdempotencyCache.delete(key);
    } else {
      sendIdempotencyCache.set(key, { state: 'settled', result: outcome, createdAt: Date.now() });
    }
    return outcome;
  });
  sendIdempotencyCache.set(key, { state: 'in_flight', promise, createdAt: now });
  return promise;
}

function __resetIdempotencyCache() {
  sendIdempotencyCache.clear();
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

module.exports = { sendEmailMessage, encodeEmailBody, __resetIdempotencyCache };
