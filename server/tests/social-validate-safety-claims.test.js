/**
 * validateContent must flag the compliance-language classes (AGENTS.md): no
 * pesticide copy is ever blanket-"safe", it's "EPA-registered" never
 * "EPA-approved", and no fixed re-entry/drying minute figure appears — the
 * idiom is "safe once completely dry" + technician confirms timing.
 *
 * Word-order enumeration proved unbounded (#3059 rounds 2-9), so the timing
 * and product-safety classes use clause-level co-occurrence; this suite is
 * the contract, including every phrasing those review rounds surfaced.
 */
const { validateContent } = require('../services/social-media');

// Audience/compound forms + EPA-approved (SAFETY_OVERCLAIMS regex).
const FLAGGED_OVERCLAIM = [
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
  'Our products are approved by the EPA', // passive form (r1)
  'guaranteed elimination',
  '100% effective against roaches',
  'completely safe once applied',
];

// Product-safety co-occurrence: safe + product word, any order.
const FLAGGED_PRODUCT_SAFETY = [
  // The dry idiom WITHOUT technician-confirms framing is still a claim.
  'our treatments are safe once completely dry',
  'Our treatments are safe—once dry',
  'Our treatments are safe, once dry',
  // r3: a technician MENTION without a confirmation verb is not framing.
  'Our technician applied treatments that are safe once dry',
  'safe pesticide treatments',
  'safe products for your lawn',
  'a safe treatment plan for summer',
  'targeted, safe application practices',
  'safe pest control',
  'safe pest control services in Sarasota',
  'our pesticides are safe when professionally applied',
  'our treatments are safe when used as directed',
  'the spray is safely applied and our products are gentle',
  // #3066 r1: protective carve-out must not eat a separate product claim.
  'Keep your home safe from ants with safe products',
];

// Fixed drying/re-entry timing co-occurrence.
const FLAGGED_TIMING = [
  'safe after 30 minutes',
  '30-minute drying time',
  're-enter after 45 minutes',
  'dries in 30-45 min',
  'usually 30-60 minutes to dry',
  'about an hour to dry',
  'safe within an hour',
  'dry within 20 minutes',
  'wait 30 minutes before re-entering',
  'allow 30 minutes before re-entry',
  'wait an hour before letting pets back outside',
  'give it 45 minutes before walking on treated areas',
  'keep pets off treated areas for 30 minutes',
  'stay off the lawn for 30 minutes',
  'you can return after 30 minutes',
  'kids should stay off the grass for an hour',
  'do not enter treated areas for 30 minutes',
  'keep pets inside for 30 minutes after treatment',
  'avoid the treated area for one hour',
  // Round-9 P1: agronomic clause must not mask the re-entry clause.
  'Keep pets off treated areas for 30 minutes, and avoid watering for 24 hours.',
  // #3066 r1: conjunction-joined clauses, word-form durations, bare returns.
  'Keep pets off treated areas for 30 minutes and avoid watering for 24 hours',
  'Allow a one-hour drying time',
  'Allow a half-hour drying time',
  'Return after 30 minutes',
  'Residents may return after 30 minutes',
];

const CLEAN = [
  'EPA-registered products applied by licensed technicians',
  'a failsafe scheduling process',
  'Petsmart is next door',
  'keep pets off treated areas until completely dry',
  'Safe once dry — technician confirms timing', // the approved idiom
  'our treatments are safe once completely dry, and your technician confirms timing',
  'review the safety data sheet before mixing',
  // Durations OUTSIDE the drying/re-entry context stay legal copy.
  'visits typically take about 45 minutes',
  'we respond within 24 hours',
  'mosquito barrier lasts 21-30 days',
  // Agronomic aftercare timing is not a safety re-entry claim.
  'avoid mowing for 48 hours',
  'wait 24 hours before mowing',
  'wait 48 hours before watering the treated zone',
  'avoid mowing the lawn for 48 hours',
  // Cadence copy in DAYS is legal.
  'our technicians return after 30 days for the follow-up',
  // Round-9 P2: protective framing — safety FROM the pest, not the product.
  'keep your home safe from termites',
  'Keep your home safe from termites with professional pest control.',
  'our products keep your home safe from ants',
  // #3066 r1+r2: punctuated idiom stays exempt WITH technician framing.
  'Our treatments are safe—once dry; your technician confirms timing',
  'Our treatments are safe, once dry — tech confirms when',
  'Enter within 24 hours for a chance to win',
  'Technicians wear protective equipment to stay safe while applying pesticides',
];

describe('compliance-language classes in validateContent', () => {
  it.each(FLAGGED_OVERCLAIM)('flags overclaim: %s', (text) => {
    const result = validateContent(text, 'gbp');
    expect(result.valid).toBe(false);
    expect(result.issues.join(' ')).toMatch(/safety overclaim/i);
  });

  it.each(FLAGGED_PRODUCT_SAFETY)('flags product-safety claim: %s', (text) => {
    const result = validateContent(text, 'gbp');
    expect(result.valid).toBe(false);
    expect(result.issues.join(' ')).toMatch(/product-safety claim/i);
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
