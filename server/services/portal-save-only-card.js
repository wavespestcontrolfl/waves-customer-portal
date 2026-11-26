/**
 * Save-only add-card form (owner 2026-11-24, GATE_CARD_ON_FILE_REMINDER). The link in the "add a card" reminder email
 * opens the billing tab's Add card form with ?add_card=1. That form mints its SetupIntent with enrollAutopay:false
 * (POST /billing/cards/setup-intent), which stamps this metadata key on it. Both portal add-method completions, the
 * POST /billing/cards save and the portal_add_method webhook, then call finishSaveOnlyAdd and stop: the card is saved,
 * enrollConsentedMethod is never called, and NO payment_methods consent row is written. A consent row is what every
 * enrollment, Auto Pay opt-out and charge gate in the portal reads, so a row from this form would have to be filtered
 * out of each of them; without one, turning Auto Pay on later asks the customer for the Auto Pay checkbox (the
 * consent_required answer) exactly like a card that never had one. What the customer saw is kept as an audit_log
 * event (text, version, address and agent) instead.
 *
 * The stamp rides the SetupIntent itself (like the consent text version), so a redirect return from a fresh bundle and
 * the webhook read the same answer.
 */

const db = require('../models/db');
const logger = require('./logger');
const { recordAuditEvent } = require('./audit-log');
const { isUsableSavedMethod } = require('./autopay-eligibility');
const { SAVE_ONLY_CONSENT_TEXT, CONSENT_VERSION_METADATA_KEY, saveOnlyConsentVersionIsCurrent } = require('./payment-method-consent-text');

const SAVE_ONLY_METADATA_KEY = 'enroll_autopay';
const SAVE_ONLY_AUDIT_ACTION = 'customer.payment_method.saved_card_only';

function setupIntentSavesOnly(setupIntent) {
  return setupIntent?.metadata?.[SAVE_ONLY_METADATA_KEY] === 'false';
}

// The SetupIntent metadata the mint stamps: the save-only mark, and the address and agent of the request that showed
// the form, so whichever completion lands first (the browser save or the webhook) records the same evidence.
function saveOnlyMetadata({ ip, userAgent } = {}) {
  const metadata = { [SAVE_ONLY_METADATA_KEY]: 'false' };
  if (ip) metadata.save_only_ip = String(ip).slice(0, 64);
  if (userAgent) metadata.save_only_ua = String(userAgent).slice(0, 200);
  return metadata;
}

// The save-only form attests its own text version (SAVE_ONLY_CONSENT_VERSION), not the Auto Pay authorization's: a stamp
// from any other text, or none, is refused like a stale one.
function saveOnlyStampIsCurrent(setupIntent) {
  return saveOnlyConsentVersionIsCurrent(setupIntent?.metadata?.[CONSENT_VERSION_METADATA_KEY]);
}

// What finishSaveOnlyAdd records from a stamped SetupIntent.
function saveOnlyEvidence(setupIntent) {
  const metadata = setupIntent?.metadata || {};
  return {
    ip: metadata.save_only_ip || null,
    userAgent: metadata.save_only_ua || null,
    consentTextVersion: metadata[CONSENT_VERSION_METADATA_KEY] || null,
  };
}

// The browser save and the webhook both complete this form and either can insert the row first (the browser's
// makeDefault is "no autopay default", the webhook's is false), and no enrollment follows to settle it. One rule
// settles it either way, under the customer row lock: a card is the default when the customer has no other usable
// default. Resolves the method row as it now stands.
async function settleDefault(trx, customer, rows, method) {
  const customerId = customer.id;
  const self = rows.find((row) => String(row.id) === String(method.id));
  const otherUsableDefault = rows.some((row) => String(row.id) !== String(method.id)
    && row.is_default === true && isUsableSavedMethod(row, customer));
  const shouldBeDefault = !otherUsableDefault;
  if (self.is_default === shouldBeDefault) return self;
  if (shouldBeDefault) await trx('payment_methods').where({ customer_id: customerId, is_default: true }).whereNot({ id: method.id }).update({ is_default: false });
  await trx('payment_methods').where({ id: method.id }).update({ is_default: shouldBeDefault });
  return { ...self, is_default: shouldBeDefault };
}

// What the form showed the customer, kept once per method as an audit_log event.
async function recordSaveOnlyEvent(trx, customerId, method, { consentTextVersion, ip, userAgent, via }) {
  const known = await trx('audit_log').where({ action: SAVE_ONLY_AUDIT_ACTION, resource_id: method.id }).first('id');
  if (known) return;
  await recordAuditEvent({
    actor_type: 'customer',
    actor_id: customerId,
    action: SAVE_ONLY_AUDIT_ACTION,
    resource_type: 'payment_method',
    resource_id: method.id,
    metadata: {
      via,
      consentTextVersion: consentTextVersion || null,
      consentText: SAVE_ONLY_CONSENT_TEXT,
      stripePaymentMethodId: method.stripe_payment_method_id || null,
    },
    ip_address: ip,
    user_agent: userAgent,
    critical: true,
    trx,
  });
}

/**
 * Complete a save-only add: the audit record of what the customer saw, and the default role. Never enrolls Auto Pay and
 * never writes a consent row. `method` is the payment_methods row just saved. Resolves the row as it now stands, or
 * null when the method was removed in the meantime (nothing is recorded).
 */
async function finishSaveOnlyAdd({ customerId, method, consentTextVersion = null, ip = null, userAgent = null, via }) {
  const settled = await db.transaction(async (trx) => {
    // The customer row lock comes first: the browser save and the webhook finish at about the same time, and the audit
    // check and the default role must each be decided by whichever of them holds it.
    const customer = await trx('customers').where({ id: customerId }).forUpdate().first('id', 'ach_status');
    // A removal that committed after the caller read the method leaves nothing to record or promote.
    const rows = await trx('payment_methods').where({ customer_id: customerId });
    if (!rows.some((row) => String(row.id) === String(method.id))) return null;
    await recordSaveOnlyEvent(trx, customerId, method, { consentTextVersion, ip, userAgent, via });
    return settleDefault(trx, customer, rows, method);
  });
  if (!settled) {
    logger.warn(`[portal-save-only-card] pm ${method.id} was removed before the save-only add finished for customer ${customerId}`);
    return null;
  }
  logger.info(`[portal-save-only-card] save-only add completed for customer ${customerId}: pm ${method.id} via ${via}, Auto Pay untouched`);
  return settled;
}

module.exports = {
  SAVE_ONLY_METADATA_KEY, SAVE_ONLY_AUDIT_ACTION, setupIntentSavesOnly, saveOnlyStampIsCurrent, saveOnlyMetadata, saveOnlyEvidence, finishSaveOnlyAdd,
};
