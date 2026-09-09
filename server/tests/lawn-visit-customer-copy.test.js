const copy = require('../services/lawn-visit-customer-copy');
const { normalizeAssessment } = require('../services/lawn-visit-result');
const { answer, finding } = require('./helpers/lawn-visit-fixtures');

describe('technician note boundary', () => {
  test.each([
    'Li reports damage',
    'Smith-Jones says the dog digs',
    "brown's dog digs",
    'customer is verbally abusive',
    'Ordinary lawn notes with no private detail',
  ])('keeps model prose internal whenever notes informed the answer: %s', (notes) => {
    const analysis = normalizeAssessment(answer({
      observations: notes,
      findings: [finding({ confirmation_step: notes }), finding({ name: 'Dollar spot', confirmation_step: 'Check the shaded strip at dawn' })],
    }), 2);
    const bounded = copy.withoutNoteInfluencedProse(analysis, notes);
    expect(bounded.observations).toBe('');
    expect(bounded.findings.map((f) => f.confirmation_step)).toEqual(['', '']);
    expect(copy.customerObservations(bounded.observations, bounded.findings)).toBe(copy.NO_OBSERVATIONS);
    expect(analysis.observations).toBe(notes);
    expect(analysis.findings[0].confirmation_step).toBe(notes);
    expect(copy.withoutNoteInfluencedProse(analysis, null)).toBe(analysis);
  });
});

describe('customer publication', () => {
  test.each([
    'The application is pet-safe, so the dog can go right back out.',
    "Today's product is EPA-approved for turf.",
    'Keep pets off the lawn for 30 minutes after treatment.',
    'The chinch bug problem has been eliminated.',
    'We guarantee the fungus will not return.',
    'The lawn is clear of weeds now.',
    'Use gate code 4471 at the side gate.',
    '',
  ])('withholds unsupported or private copy: %s', (text) => {
    expect(copy.customerObservations(text)).toBe(copy.NO_OBSERVATIONS);
  });

  test('scrubs contact, product and address details while retaining permissible observations', () => {
    const text = copy.customerObservations('Dense turf; call 941-555-0100 or see https://x.test — Celsius applied at 123 Main Street.');
    expect(text).toMatch(/Dense turf/);
    expect(text).not.toMatch(/941|https|Celsius|123 Main/);
    expect(copy.customerObservations('The treated area is safe once dry; your technician confirms the timing.')).toMatch(/safe once dry/);
  });

  test('requires the named cause at moderate confidence or better in a published finding', () => {
    const text = 'The browning along the driveway is consistent with chinch bug activity.';
    const chinch = { label: 'chinch bug activity', confidence: 'high' };
    expect(copy.customerObservations(text, [chinch])).toBe(text);
    for (const findings of [[], [{ ...chinch, confidence: 'low' }], [{ ...chinch, confidence: 'unknown' }], [{ ...chinch, negated: true }], [{ label: 'drought stress', confidence: 'high' }]]) {
      expect(copy.customerObservations(text, findings)).toBe(copy.NO_OBSERVATIONS);
    }
    expect(copy.customerObservations('Some insect pressure is likely.', [chinch])).toBe(copy.NO_OBSERVATIONS);
    expect(copy.customerObservations('Chinchbugs are damaging the turf.', [])).toBe(copy.NO_OBSERVATIONS);
    expect(copy.customerObservations('Chinchbugs are damaging the turf.', [chinch])).toBe('Chinchbugs are damaging the turf.');
    expect(copy.customerObservations('Thin turf along the driveway edge.', [])).toBe('Thin turf along the driveway edge.');
    expect(copy.customerObservations('Fungal activity in the shaded strip.', [{ label: 'fungal activity', confidence: 'moderate' }])).toMatch(/^Fungal activity/);
  });

  test.each(['Clover', 'Clovers', 'Spurge', 'Spurges', 'Sedge', 'Sedges', 'Crabgrass', 'Dollarweed', 'Nutsedge'])('gates species %s at its own specificity', (species) => {
    const text = `${species} is spreading along the walk.`;
    expect(copy.customerObservations(text, [{ label: 'weed pressure', confidence: 'low' }])).toBe(copy.NO_OBSERVATIONS);
    expect(copy.customerObservations(text, [{ name: 'Weeds along the walk', label: 'weed pressure', confidence: 'moderate' }])).toBe(copy.NO_OBSERVATIONS);
    expect(copy.customerObservations(text, [{ name: `${species} along the walk`, label: 'weed pressure', confidence: 'moderate' }])).toBe(text);
    expect(copy.customerObservations(`${species} is confirmed along the walk.`, [{ name: species, label: 'weed pressure', confidence: 'moderate' }])).not.toMatch(/confirmed/);
  });

  test('does not exchange species or deficiency evidence through a shared generic label', () => {
    expect(copy.customerObservations('Clover along the walk.', [{ name: 'Nutsedge along the walk', label: 'weed pressure', confidence: 'moderate' }])).toBe(copy.NO_OBSERVATIONS);
    expect(copy.customerObservations('Iron deficiency in shade.', [{ name: 'Yellow turf', label: 'color and nutrient stress', confidence: 'high' }])).toBe(copy.NO_OBSERVATIONS);
    expect(copy.customerObservations('Iron deficiency in shade.', [{ name: 'Iron deficiency', label: 'color and nutrient stress', confidence: 'high' }])).toBe('Iron deficiency in shade.');
    expect(copy.customerObservations('Weed pressure along the walk.', [{ label: 'weed pressure', confidence: 'low' }])).toMatch(/^Weed pressure/);
    expect([...copy.governedTerms('Nutsedges, grey leaf spot and Gray leaf spots; iron deficiency')]).toEqual(['nutsedge', 'gray leaf', 'iron deficiency']);
  });

  test('plural aliases match their evidence and negated names do not establish positive causes', () => {
    expect(copy.customerObservations('Large patches are spreading in the shade.', [{ name: 'Large patch', label: 'large patch (fungal) activity', confidence: 'moderate' }])).toBe('Large patches are spreading in the shade.');
    expect(copy.customerObservations('Sodwebworms are damaging the turf.', [{ name: 'Sod webworm activity', label: 'caterpillar activity', confidence: 'moderate' }])).toBe('Sodwebworms are damaging the turf.');
    expect(copy.customerObservations('Nutsedge is spreading along the walk.', [{ name: 'Clover; no nutsedge observed', label: 'weed pressure', confidence: 'moderate' }])).toBe(copy.NO_OBSERVATIONS);
    expect(copy.customerObservations('Chinch bug activity along the driveway.', [{ name: 'Fungal activity; no chinch bugs observed', label: 'chinch bug activity', confidence: 'moderate' }])).toBe(copy.NO_OBSERVATIONS);
  });

  test('confirmation steps obey the same privacy and cause rules', () => {
    const chinch = { label: 'chinch bug activity', confidence: 'high' };
    expect(copy.safeConfirmationStep('Float test near the driveway; call 941-555-0100 if it fails', chinch)).not.toMatch(/941/);
    expect(copy.safeConfirmationStep('Float test by the side gate, code 4471', chinch)).toBe('');
    expect(copy.safeConfirmationStep('The lockbox is 2288')).toBe('');
    expect(copy.safeConfirmationStep('Confirm suspected chinch pressure', { label: 'general lawn stress', confidence: 'low' })).toBe('');
    expect(copy.safeConfirmationStep('Confirm suspected chinch pressure', chinch)).toBe('Confirm suspected chinch pressure');
    expect(copy.safeConfirmationStep('Check the shaded strip for fungus', chinch)).toBe('');
    expect(copy.safeConfirmationStep('Pull a nutsedge sample by the walk', { name: 'Nutsedge by the walk', label: 'weed pressure', confidence: 'moderate' })).toBe('Pull a nutsedge sample by the walk');
    expect(copy.safeConfirmationStep('Float test at the driveway edge')).toBe('Float test at the driveway edge');
  });
});

describe('observation ownership across reviews', () => {
  const observations = 'Nutsedge is coming up along the walk.';
  const generic = { finding_id: 'F1', name: 'Weeds along the walk', label: 'weed pressure', confidence: 'moderate' };
  const added = { finding_id: 'T1', name: 'Nutsedge along the walk', label: 'weed pressure', confidence: 'moderate' };

  test('adding then removing the supporting detail withdraws previously published species prose', () => {
    let current = copy.customerObservations(observations, [generic]);
    let lastPublished = current; // persist alongside the initial assessment
    expect(current).toBe(copy.NO_OBSERVATIONS);
    const first = copy.reviewedObservations({ current, lastPublished, observations, findings: [generic, added] });
    expect(first).toBe(observations);
    current = first;
    lastPublished = first; // persist the review's publication with its assessment update
    const second = copy.reviewedObservations({ current, lastPublished, observations, findings: [generic] });
    expect(second).toBe(copy.NO_OBSERVATIONS);
    expect(copy.reviewedObservations({ current: second, lastPublished: second, observations, findings: [generic, added] })).toBe(observations);
  });

  test('rejecting, renaming or negating the supporting finding withdraws its prose', () => {
    for (const revised of [{ ...added, keep: false }, { ...added, name: 'Weeds', label: 'weed pressure' }, { ...added, negated: true }]) {
      expect(copy.reviewedObservations({ current: observations, lastPublished: observations, observations, findings: [generic, revised] })).toBe(copy.NO_OBSERVATIONS);
    }
  });

  test('does not infer ownership from identical initial model text or the neutral fallback', () => {
    for (const current of [observations, copy.NO_OBSERVATIONS, null]) {
      expect(copy.reviewedObservations({ current, observations, findings: [generic, added] })).toBeNull();
    }
    expect(copy.reviewedObservations({ current: 'The technician wrote this.', lastPublished: observations, observations, findings: [generic, added] })).toBeNull();
  });
});
