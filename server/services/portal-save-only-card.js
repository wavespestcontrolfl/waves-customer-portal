/**
 * Save-only add-card form (owner 2026-11-24, GATE_CARD_ON_FILE_REMINDER). The link in the "add a card" reminder email
 * opens the billing tab's Add card form with ?add_card=1. That form mints its SetupIntent with enrollAutopay:false
 * (POST /billing/cards/setup-intent), which stamps this metadata key on it. Every portal add-method completion, the
 * POST /billing/cards save and the portal_add_method webhook, then saves the method and records its consent but never
 * calls enrollConsentedMethod: adding a card from that email never turns Auto Pay on. The stamp rides the SetupIntent
 * itself (like the consent text version), so a redirect return from a fresh bundle and the webhook read the same
 * answer. The customer turns Auto Pay on from the Auto Pay card if they want it.
 */

const SAVE_ONLY_METADATA_KEY = 'enroll_autopay';

function setupIntentSavesOnly(setupIntent) {
  return setupIntent?.metadata?.[SAVE_ONLY_METADATA_KEY] === 'false';
}

module.exports = { SAVE_ONLY_METADATA_KEY, setupIntentSavesOnly };
