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
        'one leading thematic emoji',
        'never corporate',
      ],
      // Two proven shapes from the shipped Beehiiv era:
      //   1. Noun-triple + kicker: "X, Y & Z — hype interjection"
      //   2. Full declarative sentence with a curiosity gap
      examples: [
        'Twisters, Tail Wags & Pirates? Unleash The Weekend',
        'Swifty Beats, Glitter Trolls & Gold Medals — Let\'s GOOOO!!!',
        'This Weekend\'s a Whole Circus (Literally)',
        'Someone\'s Going to Win $500 for Baking a Pie',
        'Your No-Fail Guide to a Firework-Filled Fourth',
        'Your Social Life Called — It Wants You to Read This!',
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

    // Preview text = the second punchline, not a summary. Sassy roast or
    // three-fragment cadence, riffing on the subject.
    previewTextRules: {
      style: 'direct-address roast or three-fragment cadence; never a content summary',
      examples: [
        'Could be you. Could be Grandma. Will be chaos.',
        'If you\'re bored this weekend, that\'s a you problem!',
        'Because nothing says independence like Laser Beams & Lambos.',
        'From high-flying stunts to lawn games with dads in capes, here\'s your weekend cheat sheet.',
      ],
    },

    // GIF captions are their own comedic genre: short punchlines, NEVER a
    // description of the image or the event.
    gifCaptionRules: {
      maxWords: 12,
      shapes: [
        'equation joke: "Planetarium + \'Laaaasers\' + legendary tracks = yes"',
        'three-fragment cadence: "Tiny anglers. Big catches. Major bragging rights."',
        'GIF-source riff: "Came for the rum. Stayed for the scandal."',
        'meme grammar: "When the funnel cake slaps harder than the fireworks."',
        '"X, but make it Y": "Photosynthesis but make it fun."',
        '"Mood:" format: "Mood: Baroque and unhinged."',
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

    // Owner decision 2026-06-11: match what actually shipped in the mature
    // Beehiiv era ("most recent newsletters are the template"), not the
    // earlier "— The Waves crew" draft convention.
    signoff: '— The Waves Pest Control Team',

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
