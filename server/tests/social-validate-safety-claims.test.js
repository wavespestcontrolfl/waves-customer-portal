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

const FLAGGED_TIMING = [
  'safe after 30 minutes',
  '30-minute drying time',
  're-enter after 45 minutes',
  'dries in 30-45 min',
  'usually 30-60 minutes to dry',
  'about an hour to dry',
  'safe within an hour',
  'dry within 20 minutes',
  // Wait-before word orders (codex round-5).
  'wait 30 minutes before re-entering',
  'allow 30 minutes before re-entry',
  'wait an hour before letting pets back outside',
  'give it 45 minutes before walking on treated areas',
];

const CLEAN = [
  'EPA-registered products applied by licensed technicians',
  'a failsafe scheduling process',
  'Petsmart is next door',
  'keep pets off treated areas until completely dry',
  'Safe once dry — technician confirms timing', // the approved idiom
  'review the safety data sheet before mixing',
  // Durations OUTSIDE the drying/re-entry context stay legal copy.
  'visits typically take about 45 minutes',
  'we respond within 24 hours',
  'mosquito barrier lasts 21-30 days',
  // Agronomic aftercare timing is not a safety re-entry claim.
  'avoid mowing for 48 hours',
  'wait 24 hours before mowing',
  'wait 48 hours before watering the treated zone',
];

describe('SAFETY_OVERCLAIMS compliance class', () => {
  it.each(FLAGGED)('flags: %s', (text) => {
    const result = validateContent(text, 'gbp');
    expect(result.valid).toBe(false);
    expect(result.issues.join(' ')).toMatch(/safety overclaim/i);
  });

  it.each(FLAGGED_TIMING)('flags fixed timing: %s', (text) => {
    const result = validateContent(text, 'gbp');
    expect(result.valid).toBe(false);
    expect(result.issues.join(' ')).toMatch(/drying\/re-entry time/i);
  });

  it.each(CLEAN)('passes: %s', (text) => {
    expect(validateContent(text, 'gbp').valid).toBe(true);
  });
});
