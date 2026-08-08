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
  // #3278: a confirmation about APPOINTMENT logistics is not a drying
  // confirmation — it must not exempt the dry idiom.
  'Our treatment is safe once dry. Your technician confirms arrival timing.',
  'Treatments are safe once dry — your tech will confirm the appointment time',
  // #3278 r9: nor is a confirmation about anything else — the exemption
  // requires the confirmation's OBJECT to be drying/re-entry timing.
  'Treatment is safe once dry. Your technician confirms the gate code.',
  // #3278 r11: "ready"/"will let you know" can't carry an unrelated object.
  'Treatment is safe once dry. Your technician confirms the gate code is ready.',
  'Treatment is safe once dry. Your technician will let you know the gate code.',
  // r6: "safe UNTIL dry" claims wet-safety — the opposite of the idiom.
  'Our treatments are safe until dry; your technician confirms timing',
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
  // The agronomic carve-out must not rescue a re-entry restriction that
  // merely MENTIONS an agronomic action (codex P1 #3176 r23) — the figure
  // belongs to the restriction, not to the watering.
  'keep pets off treated areas for 30 minutes before watering',
  'keep off the lawn for 2 hours after watering',
  // A clock time asserts the same fixed re-entry moment a duration does
  // (codex P1 #3176 r20).
  'safe to return after 7 PM',
  'you can re-enter the treated area after 7:30 pm',
  // Spelled-out numbers carry the same banned figure as digits
  // (codex P1 #3176 r18): the vocabulary was a/an/one/two only.
  'avoid the treated area for five hours',
  'keep pets off the treated area for thirty minutes',
  'stay off the lawn for twenty-four hours',
  'safe to re-enter after three hours',
  'keep children away from treated surfaces for a couple of hours',
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
  // ...but a figure that genuinely belongs to the agronomic action still
  // survives — the carve-out narrowed, it did not disappear.
  'avoid watering the treated lawn for 24 hours',
  'irrigate the treated areas within 14 days',
  // Clock times without a re-entry claim stay legal — business hours and
  // scheduling copy are not fixed re-entry figures.
  'call before 5 PM to reschedule',
  'we are open until 5 PM on weekdays',
  // Spelled-number agronomic windows stay legitimate — the exemption is
  // clause-scoped, not defeated by the widened vocabulary.
  'avoid watering for twenty-four hours',
  'do not mow for three days after seeding',
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
  // r4: the confirmation may live in the adjacent sentence.
  'Our treatments are safe once dry. Your technician confirms timing.',
  // #3278 r8: a DRYING confirmation whose location is the appointment is
  // still a drying confirmation — the appointment noun alone must not
  // reclassify it as logistics.
  'Treatment is safe once dry. Your technician confirms drying time at the appointment.',
  'Enter within 24 hours for a chance to win',
  'Technicians wear protective equipment to stay safe while applying pesticides',
];

describe('sanitizeProductTargets — target chips are free text (codex P1 #3176 r24)', () => {
  const { sanitizeProductTargets } = require('../services/social-media');

  it('drops chips that carry a compliance claim instead of naming a target', () => {
    const { targets, changed } = sanitizeProductTargets([
      'German cockroaches', 'pet-safe', 'EPA-approved', 'dries in 1 hour', 'non-toxic',
    ]);
    expect(targets).toEqual(['German cockroaches']);
    expect(changed).toBe(true);
  });

  it('keeps every real target, including the "green" ones a blunt rule would eat', () => {
    // Verified against the 92 shipped picker suggestions — "Green kyllinga",
    // "Nitrogen green-up" and "Deep green color" are real targets, so the
    // claim vocabulary deliberately omits "green".
    const real = ['German cockroaches', 'Palmetto bugs', 'Green kyllinga', 'Nitrogen green-up', 'Deep green color', 'subterranean termites'];
    const { targets, changed } = sanitizeProductTargets(real);
    expect(targets).toEqual(real);
    expect(changed).toBe(false);
  });

  it('is inert on empty/absent target lists', () => {
    expect(sanitizeProductTargets([]).changed).toBe(false);
    expect(sanitizeProductTargets(undefined).targets).toEqual([]);
  });
});

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
