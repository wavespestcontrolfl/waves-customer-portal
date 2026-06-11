/**
 * Newsletter Type Registry
 *
 * Every newsletter send can be typed. The type drives:
 *   - which voice profile the AI drafter uses
 *   - which email chrome wrapNewsletter() renders
 *   - which sections are required (enforced in Phase 4 validation gate)
 *   - cadence and send-day defaults for scheduling
 *
 * The flagship type is `local-weekly-fresh-events` — a punchy,
 * FOMO-driven local events guide from North Port to Tampa.
 * Everything else is secondary.
 *
 * Legacy newsletters (pre-engine) have newsletter_type = null in the DB.
 * The TEMPLATE_GUIDANCE keys in admin-newsletter.js map to these types
 * via TEMPLATE_TO_TYPE for backward compatibility.
 */

const NEWSLETTER_TYPES = {
  'local-weekly-fresh-events': {
    key: 'local-weekly-fresh-events',
    label: 'Local Weekly Fresh Events',
    flagship: true,
    cadence: 'weekly',
    defaultSendDay: 'Thursday',
    voiceProfile: 'waves_phase_3_local',
    coverage: {
      southernBoundary: 'North Port',
      northernBoundary: 'Tampa',
      zones: [
        'south_sarasota',
        'sarasota',
        'manatee',
        'pinellas',
        'tampa',
      ],
    },
    requiredSections: [
      'local_intro',
      'fresh_this_week',
      'just_starting',
      'weekend_picks',
      'family_or_low_key_pick',
      'road_trip_pick',
      'homeowner_minute',
      'waves_cta',
    ],
    sourceRequirements: {
      minVerifiedFreshEvents: 5,
      minSourceDiversity: 2,
      // Soft-warning thresholds — the autopilot preflight surfaces these on
      // the draft/skip notification but does NOT hard-block on them yet.
      minCityDiversity: 2,
      minImageCoverage: 0.5,
      maxStaleRecurringEvents: 0,
      requiresEventSourceUrl: true,
      requiresDateTime: true,
      requiresFactsBankForHomeownerMinute: true,
    },
    autonomy: {
      aiDraftAllowed: true,
      autoScheduleAllowed: true,
      autoSendAllowed: false,
      humanApprovalRequired: true,
    },
  },

  'pest-insider-monthly': {
    key: 'pest-insider-monthly',
    label: 'Pest Insider (Monthly)',
    flagship: false,
    cadence: 'monthly',
    // Auto-drafts the first Tuesday of the month at 7am ET (scheduler.js)
    // — Thursdays stay owned by the weekly events guide.
    defaultSendDay: 'Tuesday',
    voiceProfile: 'waves_phase_3_local',
    coverage: null,
    // The humor-sandwich structure from the shipped Beehiiv "Pest Watch"
    // issues (see docs/design/newsletter-fresh-this-week-style-guide.md):
    // ~60% edutainment facts → ONE sincere pitch section → voice-y close.
    requiredSections: ['seasonal_hook', 'pest_facts', 'featured_service', 'cta_close'],
    sourceRequirements: null,
    autonomy: {
      aiDraftAllowed: true,
      autoScheduleAllowed: true,
      autoSendAllowed: false,
      humanApprovalRequired: true,
    },
  },

  'pest-education': {
    key: 'pest-education',
    label: 'Pest / Lawn Education',
    flagship: false,
    cadence: 'as-needed',
    defaultSendDay: null,
    voiceProfile: 'waves_phase_3_local',
    coverage: null,
    requiredSections: ['why_now', 'signs_to_watch', 'what_to_do', 'waves_cta'],
    sourceRequirements: null,
    autonomy: {
      aiDraftAllowed: true,
      autoScheduleAllowed: false,
      autoSendAllowed: false,
      humanApprovalRequired: true,
    },
  },

  'local-spotlight': {
    key: 'local-spotlight',
    label: 'Local Spotlight',
    flagship: false,
    cadence: 'as-needed',
    defaultSendDay: null,
    voiceProfile: 'waves_phase_3_local',
    coverage: null,
    requiredSections: ['intro', 'spots', 'waves_cta'],
    sourceRequirements: null,
    autonomy: {
      aiDraftAllowed: true,
      autoScheduleAllowed: false,
      autoSendAllowed: false,
      humanApprovalRequired: true,
    },
  },

  'service-promo': {
    key: 'service-promo',
    label: 'Service Promo',
    flagship: false,
    cadence: 'as-needed',
    defaultSendDay: null,
    voiceProfile: 'waves_phase_3_local',
    coverage: null,
    requiredSections: ['the_deal', 'whats_included', 'how_to_claim'],
    sourceRequirements: null,
    autonomy: {
      aiDraftAllowed: true,
      autoScheduleAllowed: false,
      autoSendAllowed: false,
      humanApprovalRequired: true,
    },
  },

  'free-form': {
    key: 'free-form',
    label: 'Free-form',
    flagship: false,
    cadence: 'as-needed',
    defaultSendDay: null,
    voiceProfile: null,
    coverage: null,
    requiredSections: [],
    sourceRequirements: null,
    autonomy: {
      aiDraftAllowed: true,
      autoScheduleAllowed: false,
      autoSendAllowed: false,
      humanApprovalRequired: true,
    },
  },
};

/**
 * Maps the legacy client-side template keys (from TEMPLATES array in
 * NewsletterTabs.jsx) to newsletter type slugs. Used when persisting
 * the type on draft creation.
 */
const TEMPLATE_TO_TYPE = {
  weekend: 'local-weekly-fresh-events',
  pest_insider: 'pest-insider-monthly',
  pest_concern: 'pest-education',
  local_spotlight: 'local-spotlight',
  service_promo: 'service-promo',
  blank: 'free-form',
};

const FLAGSHIP_TYPE_KEY = 'local-weekly-fresh-events';

function getNewsletterType(key) {
  return NEWSLETTER_TYPES[key] || null;
}

function getFlagshipType() {
  return NEWSLETTER_TYPES[FLAGSHIP_TYPE_KEY];
}

function isFlagshipType(key) {
  return key === FLAGSHIP_TYPE_KEY;
}

module.exports = {
  NEWSLETTER_TYPES,
  TEMPLATE_TO_TYPE,
  FLAGSHIP_TYPE_KEY,
  getNewsletterType,
  getFlagshipType,
  isFlagshipType,
};
