/**
 * validateContent must flag the compliance-language class (AGENTS.md): no
 * pesticide copy is ever blanket-"safe" (pet-safe / safe for families / …)
 * and it's "EPA-registered", never "EPA-approved". Regression anchor for the
 * GBP card-headline gate (autonomous-runner) and every social publish path.
 */
const { validateContent } = require('../services/social-media');

const FLAGGED = [
  'pet-safe pest control in Sarasota',
  'kid safe treatments',
  'family-safe barrier spray',
  'kid and pet safe applications',
  'products safe for pets and kids',
  'safe for families year-round',
  'safe for family gatherings',
  'safe around pets',
  'safe for your pet',
  'EPA-approved products only',
  'EPA approved and effective',
  'guaranteed elimination',
  '100% effective against roaches',
  'completely safe once applied',
  // Bare safe + product-noun claims are the same banned class.
  'safe pesticide treatments',
  'safe products for your lawn',
  'a safe treatment plan for summer',
  'targeted, safe application practices',
];

const CLEAN = [
  'EPA-registered products applied by licensed technicians',
  'a failsafe scheduling process',
  'Petsmart is next door',
  'keep pets off treated areas until completely dry',
  'Safe once dry — technician confirms timing', // the approved idiom
  'review the safety data sheet before mixing',
];

describe('SAFETY_OVERCLAIMS compliance class', () => {
  it.each(FLAGGED)('flags: %s', (text) => {
    const result = validateContent(text, 'gbp');
    expect(result.valid).toBe(false);
    expect(result.issues.join(' ')).toMatch(/safety overclaim/i);
  });

  it.each(CLEAN)('passes: %s', (text) => {
    expect(validateContent(text, 'gbp').valid).toBe(true);
  });
});
