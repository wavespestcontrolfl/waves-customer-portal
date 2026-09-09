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

  test.each([200, 600])('screens complete private text before the %i-character display limit', (limit) => {
    const text = `${'Thin turf. '.repeat(60).slice(0, limit - 8)}Use 4471 at the side gate keypad.`;
    expect(copy.customerObservations(text)).toBe(copy.NO_OBSERVATIONS);
    expect(copy.safeConfirmationStep(text)).toBe('');
  });

  test.each(['Chinch  bugs', 'Chinch\n  bugs', 'Drought stress', 'Gray leaf spot', 'Grayleaf spot', 'Take-all root rot', 'Large patch (Rhizoctonia)'])('cannot publish a confirmed claim for %s', (cause) => {
    const text = `${cause} is confirmed along the edge.`;
    const evidence = { name: cause, label: 'general lawn stress', confidence: 'moderate' };
    expect(copy.customerObservations(text, [evidence])).not.toMatch(/confirmed/i);
    expect(copy.safeConfirmationStep(text, evidence)).not.toMatch(/confirmed/i);
  });

  test.each(['has been confirmed', 'have been confirmed', 'is now confirmed', 'was clearly confirmed', 'has now been confirmed', 'has just been confirmed', 'is currently confirmed', 'was recently confirmed', 'has only just been confirmed'])(
    'cannot publish a compound passive claim that chinch bug activity %s', (claim) => {
      const text = `Chinch bug activity ${claim} along the edge.`;
      const evidence = { label: 'chinch bug activity', confidence: 'moderate' };
      expect(copy.customerObservations(text, [evidence])).not.toMatch(/confirmed/i);
      expect(copy.customerObservations(text, [evidence])).toMatch(/most consistent with the visible pattern/);
      expect(copy.safeConfirmationStep(text, evidence)).not.toMatch(/confirmed/i);
    },
  );

  test.each(['Chinch bugs or drought stress', 'Chinch bugs vs. drought stress', 'Chinch bugs versus drought stress', 'Chinch bug / drought stress', 'Either chinch bugs or drought stress', 'Chinch bugs?', 'Chinch bugs and drought stress', 'Chinch bugs plus drought stress', 'Chinch bugs along with drought stress', 'Chinch bugs with drought stress', 'Neither chinch bugs nor drought stress observed', 'Chinch bugs & drought stress', 'Chinch bugs + drought stress', 'Chinch bugs, drought stress', 'Chinch bug drought stress', 'Large patch and dollar spot'])(
    'an unresolved differential named %s cannot authorize either cause', (name) => {
      const evidence = { name, label: 'general lawn stress', confidence: 'high' };
      expect(copy.customerObservations('Chinch bug activity is damaging the edge.', [evidence])).toBe(copy.NO_OBSERVATIONS);
      expect(copy.customerObservations('Drought stress is spreading along the edge.', [evidence])).toBe(copy.NO_OBSERVATIONS);
      expect(copy.safeConfirmationStep('Check for chinch bugs at the edge.', evidence)).toBe('');
      const resolved = { name: 'Chinch bug activity', label: 'chinch bug activity', confidence: 'moderate' };
      expect(copy.customerObservations('Chinch bug activity is damaging the edge.', [resolved])).toMatch(/chinch/i);
    },
  );

  test.each([
    ['Large patch (fungal) activity', 'Large patch is spreading in the shade.', /large patch/i],
    ['Large patch (Rhizoctonia)', 'Large patch is spreading in the shade.', /large patch/i],
    ['Take-all root rot', 'Take-all is thinning the roots along the edge.', /take-all/i],
    ['Armyworm caterpillars', 'Armyworm feeding is visible along the edge.', /armyworm/i],
    ['Chlorosis (iron deficiency)', 'Iron deficiency is showing in the front.', /iron deficiency/i],
    ['Drought stress (water stress)', 'Drought stress is spreading along the edge.', /drought/i],
    ['Underwatered turf', 'Underwatered turf along the edge.', /underwatered/i],
    ['Iron deficiencies', 'Iron deficiencies across the front.', /deficiencies/i],
  ])('a single cause spelled %s still authorizes its prose', (name, text, expected) => {
    const evidence = { name, label: 'general lawn stress', confidence: 'moderate' };
    expect(copy.customerObservations(text, [evidence])).toMatch(expected);
    expect(copy.customerObservations(text, [])).toBe(copy.NO_OBSERVATIONS);
  });

  test.each(['Underwatered turf', 'Molds are spreading', 'Iron deficiencies', 'Wilting turf', 'Mildews', 'Droughts'])(
    'allowlisted spelling %s never publishes without evidence', (text) => {
      expect(copy.customerObservations(`${text} along the edge.`, [])).toBe(copy.NO_OBSERVATIONS);
      expect(copy.safeConfirmationStep(`${text} along the edge.`)).toBe('');
    },
  );

  test.each(['are active', 'is active', 'are clearly active', 'were still active', 'are now very active', 'have been active', 'has been active', 'have just been active', 'had been very active'])(
    'cannot publish a cause-first active claim that chinch bugs %s', (claim) => {
      const text = `Chinch bugs ${claim} along the edge.`;
      const evidence = { label: 'chinch bug activity', confidence: 'moderate' };
      expect(copy.customerObservations(text, [evidence])).not.toMatch(/\b(?:is|are|was|were)\b[^.]*\bactive\b/i);
      expect(copy.customerObservations(text, [evidence])).toMatch(/chinch bugs may be active/i);
      expect(copy.safeConfirmationStep(text, evidence)).not.toMatch(/\b(?:is|are|was|were)\b[^.]*\bactive\b/i);
    },
  );

  test.each(['have remained active', 'has stayed active', 'had kept active', 'have just remained active', 'had stayed very active'])(
    'qualifies the aspectual activity claim %s on both customer surfaces', (claim) => {
      const text = `Chinch bugs ${claim} along the edge.`;
      const evidence = { label: 'chinch bug activity', confidence: 'moderate' };
      const expected = 'Chinch bugs may be active along the edge.';
      expect(copy.customerObservations(text, [evidence])).toBe(expected);
      expect(copy.safeConfirmationStep(text, evidence)).toBe(expected);
      expect(copy.customerObservations(text, [{ ...evidence, confidence: 'low' }])).toBe(copy.NO_OBSERVATIONS);
      expect(copy.safeConfirmationStep(text, { ...evidence, confidence: 'low' })).toBe('');
    },
  );

  test.each([['Molds are spreading in the shade.', 'Mold activity'], ['Mildews are spreading in the shade.', 'Mildew activity'], ['Molds are spreading in the shade.', 'Fungal activity']])(
    'plural %s publishes with matching fungal evidence named %s', (text, name) => {
      const evidence = { name, label: 'fungal activity', confidence: 'moderate' };
      expect(copy.customerObservations(text, [evidence])).toBe(text);
      expect(copy.customerObservations(text, [])).toBe(copy.NO_OBSERVATIONS);
    },
  );

  test('a single cause paired with a symptom still authorizes that cause', () => {
    const evidence = { name: 'Chinch bug damage and thinning', label: 'chinch bug activity', confidence: 'moderate' };
    expect(copy.customerObservations('Chinch bug activity is damaging the edge.', [evidence])).toMatch(/chinch/i);
    expect(copy.customerObservations('Drought stress is spreading along the edge.', [evidence])).toBe(copy.NO_OBSERVATIONS);
  });

  test('requires the named cause at moderate confidence or better in a published finding', () => {
    const text = 'The browning along the driveway is consistent with chinch bug activity.';
    const chinch = { label: 'chinch bug activity', confidence: 'high' };
    expect(copy.customerObservations(text, [chinch])).toBe(text);
    for (const findings of [[], [{ ...chinch, confidence: 'low' }], [{ ...chinch, confidence: 'unknown' }], [{ ...chinch, negated: true }], [{ label: 'drought stress', confidence: 'high' }]]) {
      expect(copy.customerObservations(text, findings)).toBe(copy.NO_OBSERVATIONS);
    }
    expect(copy.customerObservations('Some insect pressure is likely.', [chinch])).toBe(copy.NO_OBSERVATIONS);
    for (const cause of ['Insect damage', 'Pest pressure', 'Disease', 'Infestation']) {
      expect(copy.customerObservations(`${cause} is spreading.`, [{ name: cause, label: 'general lawn stress', confidence: 'high' }])).toBe(copy.NO_OBSERVATIONS);
    }
    expect(copy.customerObservations('Fungi are spreading.', [])).toBe(copy.NO_OBSERVATIONS);
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

  test.each(['Sod-webworm', 'Sod‑webworm', 'Large-patch', 'Leaf-spot', 'Gray-leaf-spot', 'Grayleaf spot', 'Greyleaf spot', 'Leafspot', 'Largepatch', 'Iron-deficiency'])(
    'hyphenated or joined %s prose requires matching evidence', (cause) => {
      const text = `${cause} activity along the edge.`;
      const evidence = { name: cause.replace(/[-‑]/g, ' '), label: 'general lawn stress', confidence: 'moderate' };
      expect(copy.customerObservations(text, [])).toBe(copy.NO_OBSERVATIONS);
      expect(copy.customerObservations(text, [{ ...evidence, confidence: 'low' }])).toBe(copy.NO_OBSERVATIONS);
      expect(copy.customerObservations(text, [evidence])).toBe(text);
      expect(copy.safeConfirmationStep(text)).toBe('');
    },
  );

  test.each(["weren't observed", "aren't present", 'wasn’t observed', "can't be found", 'cannot be confirmed', 'were ruled-out', 'were ruled‑out'])(
    'a normalized finding that says chinch bugs %s cannot authorize cause prose', (polarity) => {
      const analysis = normalizeAssessment(answer({ findings: [finding({ name: `Chinch bugs ${polarity}`, confidence: 'high' })] }), 2);
      expect(analysis.findings).toHaveLength(1);
      expect(copy.customerObservations('Chinchbugs are damaging the turf.', analysis.findings)).toBe(copy.NO_OBSERVATIONS);
      expect(copy.safeConfirmationStep('Check the chinch bug activity', analysis.findings[0])).toBe('');
    },
  );

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
