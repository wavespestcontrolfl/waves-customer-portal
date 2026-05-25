/**
 * Newsletter Voice Profiles
 *
 * A voice profile encodes how a newsletter should sound — subject line
 * rules, intro style, sign-off, and banned corporate phrases. The AI
 * draft system prompt is built from the active profile, and
 * validateVoice() runs advisory checks against the final draft.
 *
 * The flagship profile (`waves_phase_3_local`) captures the Phase 3
 * energy that emerged Feb–Jul 2025: irreverent, FOMO-driven, local
 * events first, Waves second.
 */

const VOICE_PROFILES = {
  waves_phase_3_local: {
    key: 'waves_phase_3_local',
    label: 'Waves Phase 3 Local',
    description:
      'Irreverent, FOMO-driven, specific, weekend-text-message energy. Local events first, Waves second.',

    subjectLineRules: {
      maxLength: 80,
      style: [
        'punchy',
        'specific to this week\'s events',
        'FOMO-driven',
        'playful',
        'occasionally emoji-led',
        'never corporate',
      ],
      examples: [
        'Funnel Cakes, Live Music & One Very Chaotic Weekend',
        'Your Social Life Called — It Wants This Lineup',
        'Markets, Margaritas & Mayhem from North Port to Tampa',
        'The Official "You Down?" Weekend Lineup',
        'Swifty Beats, Glitter Trolls & Gold Medals — Let\'s GOOOO!!!',
        'This Weekend\'s a Whole Circus (Literally)',
      ],
      bannedPatterns: [
        'Monthly Newsletter',
        'Weekly Newsletter',
        'Weekly Update',
        'Tips for homeowners',
        'Important update from Waves',
        'Pest Control Newsletter',
      ],
    },

    introRules: {
      maxSentences: 2,
      style:
        'Write like a local friend texting the plan. No greetings. No throat-clearing.',
      bannedPhrases: [
        'Hello subscribers',
        'We hope this finds you well',
        'In this edition',
        'Welcome to our newsletter',
        'Greetings from Waves',
      ],
    },

    eventBlurbRules: {
      maxSentences: 2,
      requiredDetails: ['city', 'day_or_date', 'venue_or_location'],
      style:
        'Tight, fun, useful. Say why someone would actually go. Do not over-explain.',
    },

    homeownerMinuteRules: {
      maxWords: 90,
      style:
        'Useful, seasonal, local, and non-salesy. One practical thing to notice or do.',
      salesLimit:
        'Do not pitch until the final CTA. The tip should stand on its own.',
    },

    signoff: '— The Waves crew',

    bannedCorporatePhrases: [
      'Dear valued customer',
      'We hope this finds you well',
      'Our valued clients',
      'At Waves, we are committed to',
      'Your trusted pest control provider',
      'Contact us today for all your pest control needs',
      'We are pleased to announce',
      'It is our pleasure to',
      'In this edition',
    ],
  },
};

/**
 * Validate a draft against a voice profile. Returns advisory warnings
 * (not blockers) in Phase 1. Phase 4 validation gate may promote some
 * of these to hard errors.
 *
 * @param {{ subject?: string, htmlBody?: string, textBody?: string }} draft
 * @param {string} profileKey
 * @returns {{ warnings: string[] }}
 */
function validateVoice(draft, profileKey) {
  const profile = VOICE_PROFILES[profileKey];
  if (!profile) return { warnings: [] };

  const warnings = [];
  const fullText = [draft.subject, draft.htmlBody, draft.textBody]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  for (const phrase of profile.bannedCorporatePhrases) {
    if (fullText.includes(phrase.toLowerCase())) {
      warnings.push(`Corporate phrase detected: "${phrase}"`);
    }
  }

  if (draft.subject) {
    if (draft.subject.length > profile.subjectLineRules.maxLength) {
      warnings.push(
        `Subject line is ${draft.subject.length} chars (max ${profile.subjectLineRules.maxLength})`
      );
    }
    for (const banned of profile.subjectLineRules.bannedPatterns) {
      if (draft.subject.toLowerCase().includes(banned.toLowerCase())) {
        warnings.push(`Subject contains banned pattern: "${banned}"`);
      }
    }
  }

  if (profile.signoff && draft.htmlBody) {
    const bodyText = draft.htmlBody.replace(/<[^>]+>/g, '');
    if (!bodyText.includes(profile.signoff)) {
      warnings.push(`Missing required sign-off: ${profile.signoff}`);
    }
  }

  if (draft.htmlBody && profile.introRules) {
    const stripped = draft.htmlBody.replace(/<[^>]+>/g, '');
    for (const phrase of profile.introRules.bannedPhrases || []) {
      if (stripped.toLowerCase().startsWith(phrase.toLowerCase())) {
        warnings.push(`Intro starts with banned phrase: "${phrase}"`);
      }
    }
  }

  return { warnings };
}

function getVoiceProfile(key) {
  return VOICE_PROFILES[key] || null;
}

module.exports = {
  VOICE_PROFILES,
  validateVoice,
  getVoiceProfile,
};
