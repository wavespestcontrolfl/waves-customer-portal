/**
 * Messaging policy — types, enums, and per-(audience, purpose) policy profiles.
 *
 * Loaded by send-customer-message.js. Validators consume the resolved policy
 * to decide whether to allow a send, what to enforce, and what to log.
 *
 * Design note: this module is pure data + helpers — no DB access, no I/O.
 * Validator modules (validators/*.js) are where DB lookups happen.
 *
 * @typedef {'customer' | 'lead' | 'internal' | 'tech' | 'admin'} MessageAudience
 *
 * @typedef {'sms' | 'email' | 'portal_chat' | 'website_chat'} MessageChannel
 *
 * @typedef {(
 *   'conversational'      |   // inbound-reply / chat continuation
 *   'appointment'         |   // confirm, reminder, en-route, reschedule
 *   'appointment_confirmation' | // booked/scheduled confirmation
 *   'billing'             |   // overdue, statement, dunning
 *   'payment_receipt'     |   // paid receipt / payment confirmation
 *   'payment_failure'     |   // failed charge / retry / bank-verification action required
 *   'autopay'             |   // autopay pre-charge / card state notices
 *   'payment_link'        |   // tap-to-pay link
 *   'estimate_followup'   |   // estimate sent / viewed / nudge
 *   'review_request'      |   // post-service review ask
 *   'referral'            |   // referral enrollment/reward/invite
 *   'retention'           |   // win-back, churn-save, check-in
 *   'marketing'           |   // promo, deal, seasonal pitch
 *   'internal_briefing'   |   // BI SMS to operator/owner
 *   'support_resolution'      // resolving an open complaint/ticket
 * )} MessagePurpose
 *
 * @typedef {(
 *   'anonymous'                  |
 *   'phone_provided_unverified'  |
 *   'phone_matches_customer'     |
 *   'authenticated_portal'       |
 *   'estimate_token_verified'    |
 *   'admin_operator'
 * )} IdentityTrustLevel
 *
 * @typedef {Object} ConsentBasis
 * @property {'opted_in' | 'transactional_allowed' | 'unknown' | 'opted_out'} status
 * @property {string} [source]      - e.g. 'lead_form_2026-04-29', 'admin_manual'
 * @property {string} [campaign]    - e.g. 'A2P_CAMPAIGN_SID_xxx'
 * @property {string} [capturedAt]  - ISO-8601
 *
 * @typedef {Object} SendCustomerMessageInput
 * @property {string}              to               - E.164 or any format normalize_recipient accepts
 * @property {string}              body             - message body (final, post-prompt)
 * @property {MessageChannel}      channel
 * @property {MessageAudience}     audience
 * @property {MessagePurpose}      purpose
 * @property {string}              [customerId]
 * @property {string}              [leadId]
 * @property {string}              [invoiceId]
 * @property {string}              [estimateId]
 * @property {string}              [appointmentId]
 * @property {string}              [entryPoint]
 * @property {IdentityTrustLevel}  [identityTrustLevel]
 * @property {ConsentBasis}        [consentBasis]
 * @property {Object}              [metadata]
 */

const MESSAGE_AUDIENCES = ['customer', 'lead', 'internal', 'tech', 'admin'];
const MESSAGE_CHANNELS = ['sms', 'email', 'portal_chat', 'website_chat'];
const MESSAGE_PURPOSES = [
  'conversational',
  'appointment',
  'appointment_confirmation',
  'billing',
  'payment_receipt',
  'payment_failure',
  'autopay',
  'payment_link',
  'estimate_followup',
  'review_request',
  'referral',
  'retention',
  'marketing',
  'internal_briefing',
  'support_resolution',
];
const IDENTITY_TRUST_LEVELS = [
  'anonymous',
  'phone_provided_unverified',
  'phone_matches_customer',
  'authenticated_portal',
  'estimate_token_verified',
  'admin_operator',
];

const TRUST_RANK = {
  anonymous: 0,
  phone_provided_unverified: 1,
  phone_matches_customer: 2,
  estimate_token_verified: 2,
  authenticated_portal: 3,
  admin_operator: 3,
};

/**
 * Per-(audience, purpose) policy resolver. Centralizes which validators run
 * and what their thresholds are. Adding a new purpose? Add a row here.
 *
 * Field meanings:
 *   - allowEmoji              Customer/lead audiences are NEVER allowed emoji,
 *                             regardless of purpose. Internal BI is the only
 *                             audience where emoji is permitted (see internal_briefing).
 *   - allowExactPrice         Customer/lead audiences are NEVER allowed exact dollar
 *                             amounts in outbound SMS. Internal/admin can quote.
 *   - maxSegments             Hard cap on SMS segment count.
 *   - requireConsent          Which consent shape the validator must see.
 *                               'transactional' — sms_enabled true is enough
 *                               'marketing'     — sms_enabled true AND
 *                                                 a consent capture record
 *                               'none'          — purpose bypasses consent
 *   - prefsColumn             Optional notification_prefs column that must be
 *                             true (in addition to sms_enabled) for a send to fire.
 *   - minIdentityTrust        Minimum identityTrustLevel required to send.
 *   - requireIds              Field names on the input that must be present.
 *
 * NOTE: review_request is intentionally treated like a normal customer SMS
 * (no eligibility-result gate). Per-customer cooldowns and complaint-state
 * filtering live in the upstream candidate-finder, not in the wrapper.
 */
const PURPOSE_POLICY = {
  conversational: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: null,
    minIdentityTrust: 'phone_provided_unverified',
    requireIds: [],
  },
  appointment: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: 'service_reminder_24h',
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId'],
  },
  appointment_confirmation: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: null,
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId'],
  },
  billing: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: 'billing_reminder',
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId'],
  },
  payment_receipt: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: 'payment_receipt',
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId'],
  },
  payment_failure: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: null,
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId'],
  },
  autopay: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: 'payment_receipt',
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId'],
  },
  payment_link: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: null,
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId', 'invoiceId'],
  },
  estimate_followup: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: null,
    minIdentityTrust: 'phone_provided_unverified',
    requireIds: [],
  },
  review_request: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: null,
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId'],
  },
  referral: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'transactional',
    prefsColumn: null,
    minIdentityTrust: 'phone_provided_unverified',
    requireIds: [],
  },
  retention: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'marketing',
    prefsColumn: 'seasonal_tips',
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId'],
  },
  marketing: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 2,
    requireConsent: 'marketing',
    prefsColumn: 'seasonal_tips',
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId'],
  },
  internal_briefing: {
    allowEmoji: true,
    allowExactPrice: true,
    maxSegments: 3,
    requireConsent: 'none',
    prefsColumn: null,
    minIdentityTrust: 'admin_operator',
    requireIds: [],
  },
  support_resolution: {
    allowEmoji: false,
    allowExactPrice: false,
    maxSegments: 3,
    requireConsent: 'transactional',
    prefsColumn: null,
    minIdentityTrust: 'phone_matches_customer',
    requireIds: ['customerId'],
  },
};

/**
 * Resolve the effective policy for a (audience, purpose) pair, applying
 * audience-level overrides on top of the per-purpose row.
 *
 * Audience overrides:
 *   - audience 'customer' or 'lead' force allowEmoji=false and
 *     allowExactPrice=false regardless of purpose default.
 *   - audience 'internal' allows emoji + exact prices.
 *   - audience 'admin' allows exact prices but not emoji to a customer-
 *     facing channel; for sms/email to an admin operator we treat the
 *     admin as audience 'internal' upstream — keep this rule defensive.
 */
function resolvePolicy(audience, purpose) {
  const base = PURPOSE_POLICY[purpose];
  if (!base) {
    throw new Error(`messaging/policy: unknown purpose "${purpose}"`);
  }
  const policy = { ...base };
  if (audience === 'customer' || audience === 'lead') {
    policy.allowEmoji = false;
    policy.allowExactPrice = false;
  } else if (audience === 'internal') {
    // BI / operator surfaces — keep purpose default.
  } else if (audience === 'admin') {
    // Admin-to-admin staffing notes can quote prices but should never emoji
    // a customer-facing message — only relevant if the route uses 'admin' on
    // a non-internal purpose.
    policy.allowEmoji = base.allowEmoji && purpose === 'internal_briefing';
  }
  return policy;
}

/**
 * Compare two trust levels. Returns true when actual >= required.
 */
function trustAtLeast(actual, required) {
  const a = TRUST_RANK[actual];
  const r = TRUST_RANK[required];
  if (a == null || r == null) return false;
  return a >= r;
}

module.exports = {
  MESSAGE_AUDIENCES,
  MESSAGE_CHANNELS,
  MESSAGE_PURPOSES,
  IDENTITY_TRUST_LEVELS,
  TRUST_RANK,
  PURPOSE_POLICY,
  resolvePolicy,
  trustAtLeast,
};
