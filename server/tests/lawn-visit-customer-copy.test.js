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

  test.each(['Chinch bugs or drought stress', 'Chinch bugs vs. drought stress', 'Chinch bugs versus drought stress', 'Chinch bug / drought stress', 'Either chinch bugs or drought stress', 'Chinch bugs?', 'Chinch bugs and drought stress', 'Chinch bugs plus drought stress', 'Chinch bugs along with drought stress', 'Chinch bugs with drought stress', 'Neither chinch bugs nor drought stress observed', 'Chinch bugs & drought stress', 'Chinch bugs + drought stress', 'Chinch bugs, drought stress', 'Chinch bug drought stress', 'Large patch and dollar spot', 'Chinch bugs and disease', 'Chinch bugs plus disease', 'Drought stress and insects', 'Weeds and disease', 'Large patch and mildew', 'Dollar spot and mold', 'Large patch and disease', 'Large patch plus fungal activity'])(
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
    ['Funguses', 'Funguses are spreading in the shade.', /funguses/i],
    ['Crabgrasses', 'Crabgrasses along the walk.', /crabgrasses/i],
    ['Rhizoctonia', 'Rhizoctonial damage in the shade.', /rhizoctonial/i],
    ['Wilt', 'Wilts are visible near the curb.', /wilts/i],
  ])('a single cause spelled %s still authorizes its prose', (name, text, expected) => {
    const evidence = { name, label: 'general lawn stress', confidence: 'moderate' };
    expect(copy.customerObservations(text, [evidence])).toMatch(expected);
    expect(copy.customerObservations(text, [])).toBe(copy.NO_OBSERVATIONS);
  });

  test.each(['Underwatered turf', 'Molds are spreading', 'Iron deficiencies', 'Wilting turf', 'Mildews', 'Droughts', 'Wilts are visible', 'Funguses are spreading', 'Crabgrasses are spreading', 'Rhizoctonial damage', 'Droughty turf'])(
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
      expect(copy.customerObservations(text, [evidence])).toMatch(/chinch bugs may (?:be|have been) active/i);
      expect(copy.safeConfirmationStep(text, evidence)).not.toMatch(/\b(?:is|are|was|were)\b[^.]*\bactive\b/i);
    },
  );

  test.each([
    ['have remained active', 'may be active'], ['has stayed active', 'may be active'], ['have just remained active', 'may be active'],
    ['remain active', 'may be active'], ['stays active', 'may be active'], ['continue to be active', 'may be active'],
    // A past-tense linker keeps past possibility.
    ['had kept active', 'may have been active'], ['had stayed very active', 'may have been active'], ['were active', 'may have been active'],
  ])(
    'qualifies the aspectual activity claim %s on both customer surfaces', (claim, downgraded) => {
      const text = `Chinch bugs ${claim} along the edge.`;
      const evidence = { label: 'chinch bug activity', confidence: 'moderate' };
      const expected = `Chinch bugs ${downgraded} along the edge.`;
      expect(copy.customerObservations(text, [evidence])).toBe(expected);
      expect(copy.safeConfirmationStep(text, evidence)).toBe(expected);
      expect(copy.customerObservations(text, [{ ...evidence, confidence: 'low' }])).toBe(copy.NO_OBSERVATIONS);
      expect(copy.safeConfirmationStep(text, { ...evidence, confidence: 'low' })).toBe('');
    },
  );

  test.each(['Large patch is not improving', 'Large patch has not recovered', 'Large patch hasn\u2019t responded to treatment'])(
    'a negated recovery in the finding name %s is positive evidence for its cause', (name) => {
      const text = 'Large patch is spreading in the shade.';
      const evidence = { name, label: 'large patch (fungal) activity', confidence: 'moderate' };
      expect(copy.customerObservations(text, [evidence])).toBe(text);
      expect(copy.customerObservations(text, [{ ...evidence, name: 'Large patch ruled out' }])).toBe(copy.NO_OBSERVATIONS);
    },
  );

  test.each(['Confirmed: chinch bugs along the edge.', 'Confirmed \u2014 chinch bugs along the edge.', 'Confirmed - chinch bugs along the edge.'])(
    'a heading-style confirmed claim %s is downgraded before publication', (text) => {
      const evidence = { label: 'chinch bug activity', confidence: 'moderate' };
      expect(copy.customerObservations(text, [evidence])).toMatch(/^suspected chinch bugs along the edge\.$/i);
      expect(copy.safeConfirmationStep(text, evidence)).not.toMatch(/\bconfirmed\b/i);
    },
  );

  test.each([
    'The irrigation schedule was confirmed, the controller was adjusted, and large patch remains only a possibility.',
    'The irrigation schedule was confirmed and large patch remains only a possibility.',
  ])('a coordinated clause with an unrelated confirmation is not a residual definitive claim: %s', (text) => {
    expect(copy.residualDefinitiveClaim(text)).toBe(false);
    expect(copy.customerObservations(text, [{ label: 'large patch (fungal) activity', confidence: 'moderate' }])).toBe(text);
  });

  test.each(['Chinch bugs may have been active along the edge.', 'Chinch bugs may have been previously active.', 'Chinch bugs may be active along the edge.', 'Chinch bugs may still remain active.', 'Chinch bugs might have stayed active.'])(
    'the downgraded hedged form is not itself a residual definitive claim: %s', (text) => {
      expect(copy.residualDefinitiveClaim(text)).toBe(false);
      expect(copy.customerObservations(text, [{ label: 'chinch bug activity', confidence: 'moderate' }])).toBe(text);
    },
  );

  test.each(['Chinch bug colonies are confirmed along the edge.', 'Chinch bug hotspots were definitely present.', 'The chinch bug zone is certainly established.', 'Chinch bug colonies are active along the edge.', 'Large patch, in the shaded area, is confirmed.', 'Large patch, which is confirmed in the shaded area, is spreading.', 'Large patch: confirmed.', 'Chinch bugs: active.', 'Chinch bugs \u2014 clearly active along the edge.', 'Large patch and dollar spot are confirmed.'])(
    'a residual definitive cause claim the grammar did not downgrade is rejected whole: %s', (text) => {
      const evidence = { label: 'chinch bug activity', confidence: 'high' };
      expect(copy.residualDefinitiveClaim(text)).toBe(true);
      expect(copy.customerObservations(text, [evidence])).toBe(copy.NO_OBSERVATIONS);
      expect(copy.safeConfirmationStep(text, evidence)).toBe('');
    },
  );

  test.each([['Moldy growth is spreading in the shade.', 'Mold activity'], ['Mildewed turf near the fence.', 'Mildew activity'], ['Diseased turf near the fence.', 'Fungal activity']])(
    'an adjectival cause form %s is governed and folds to its label %s', (text, label) => {
      expect(copy.governedTerms(text).size).toBe(1);
      expect(copy.customerObservations(text, [])).toBe(copy.NO_OBSERVATIONS);
      const published = copy.customerObservations(text, [{ label, confidence: 'moderate' }]);
      if (label === 'Fungal activity') expect(published).toBe(copy.NO_OBSERVATIONS); // "diseased" is a class word, never authorized by prose
      else expect(published).toMatch(/mold|mildew/i);
    },
  );

  test.each([
    ['Largepatches are spreading in the shade.', 'Large patch', 'large patch (fungal) activity'],
    ['Large-patches are spreading in the shade.', 'Largepatch', 'large patch (fungal) activity'],
    ['Irondeficiencies are visible near the walk.', 'Iron deficiency', 'color and nutrient stress'],
    ['Iron deficiency is visible near the walk.', 'Irondeficiencies', 'color and nutrient stress'],
    ['Grayleafspot lesions are spreading.', 'Gray leaf spot', 'gray leaf spot'],
    ['Gray-leaf-spot lesions are spreading.', 'Grayleafspot', 'gray leaf spot'],
  ])('joined and plural spellings compare equal to the reviewed evidence: %s vs %s', (text, name, label) => {
    const evidence = { name, label, confidence: 'moderate' };
    expect(copy.customerObservations(text, [evidence])).toBe(text);
    expect(copy.customerObservations(text, [])).toBe(copy.NO_OBSERVATIONS);
  });

  test('a finding marked keep: false is never evidence on any publication path', () => {
    const removed = { name: 'Nutsedge', label: 'weed pressure', confidence: 'moderate', keep: false };
    expect(copy.customerObservations('Nutsedge is spreading along the walk.', [removed])).toBe(copy.NO_OBSERVATIONS);
    expect(copy.safeConfirmationStep('Nutsedge is spreading along the walk.', removed)).toBe('');
    expect(copy.customerObservations('Nutsedge is spreading along the walk.', [{ ...removed, keep: true }])).toMatch(/nutsedge/i);
  });

  describe('display limits never manufacture prohibited copy', () => {
    const filler = 'The turf along the front walk is thin in two spots and should be watched. '.repeat(8); // 592 chars
    const idiom = 'The treated area is safe once dry; your technician confirms the timing.';

    test('the whole idiom passes the screens but its cut tail would not', () => {
      expect(copy.unpublishableCustomerCopy(idiom)).toBe(false);
      expect(copy.unpublishableCustomerCopy(idiom.slice(0, 40))).toBe(true);
    });

    test('customerObservations cuts at a sentence boundary and re-screens the slice', () => {
      const out = copy.customerObservations(`${filler}${idiom}`, []);
      expect(out.length).toBeLessThanOrEqual(600);
      expect(out.endsWith('.')).toBe(true);
      expect(copy.unpublishableCustomerCopy(out)).toBe(false);
      expect(out).not.toMatch(/safe once dry/);
    });

    test('customerObservations falls back whole when no publishable slice exists', () => {
      // A single 700-char sentence whose only safe form is the whole sentence.
      const long = `${'Watch the shaded strip near the fence for slow recovery and keep to the normal schedule, '.repeat(6)}and the treated area is safe once dry; your technician confirms the timing.`;
      expect(long.length).toBeGreaterThan(600);
      expect(copy.unpublishableCustomerCopy(long)).toBe(false);
      expect(copy.customerObservations(long, [])).toBe(copy.NO_OBSERVATIONS);
    });

    test('safeConfirmationStep applies the same rule at 200 characters', () => {
      const step = `${'Re-check the margin after the next mowing and note any spread. '.repeat(3)}${idiom}`;
      expect(step.length).toBeGreaterThan(200);
      const out = copy.safeConfirmationStep(step, { label: 'chinch bug activity', confidence: 'moderate' });
      expect(out.length).toBeLessThanOrEqual(200);
      expect(out === '' || (out.endsWith('.') && !copy.unpublishableCustomerCopy(out))).toBe(true);
      expect(out).not.toMatch(/safe once dry/);
    });
  });

  test.each(['were previously active', 'had formerly been active', 'were historically active'])(
    'preserves the historical qualifier and tense of %s on both customer surfaces', (claim) => {
      const text = `Chinch bugs ${claim}, but none are present now.`;
      const evidence = { label: 'chinch bug activity', confidence: 'moderate' };
      const qualifier = claim.match(/previously|formerly|historically/)[0];
      const expected = `Chinch bugs may have been ${qualifier} active, but none are present now.`;
      expect(copy.customerObservations(text, [evidence])).toBe(expected);
      expect(copy.safeConfirmationStep(text, evidence)).toBe(expected);
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

  test.each([
    ['Chinch bug activity — unconfirmed', 'Chinch bug activity is spreading.'],
    ['Non-fungal stress', 'Fungal activity is spreading.'],
    ['Non‑fungal stress', 'Fungal activity is spreading.'],
    ['Non fungal stress', 'Fungal activity is spreading.'],
    ['Nonfungal stress', 'Fungal activity is spreading.'],
    ['Chinch bugs never observed', 'Chinch bug activity is damaging the edge.'],
    ['Never observed chinch bugs', 'Chinch bug activity is damaging the edge.'],
    ['Absence of chinch bugs', 'Chinch bug activity is damaging the edge.'],
    ['Chinch bug absence', 'Chinch bug activity is damaging the edge.'],
    ['Lack of chinch bugs', 'Chinch bug activity is damaging the edge.'],
  ])('negative-prefix finding %s cannot authorize customer prose', (name, text) => {
    for (const confidence of ['moderate', 'high']) {
      const evidence = { name, label: 'general lawn stress', confidence };
      expect(copy.customerObservations(text, [evidence])).toBe(copy.NO_OBSERVATIONS);
      expect(copy.safeConfirmationStep(text, evidence)).toBe('');
      expect(copy.reviewedObservations({ current: text, lastPublished: text, observations: text, findings: [evidence] })).toBe(copy.NO_OBSERVATIONS);
    }
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

  test.each(['Call 555-0100 if the patch spreads.', 'Call +44 20 7946 0958 if the patch spreads.', 'Call 0044 20 7946 0958 if the patch spreads.'])('observations never publish the contact number in %s', (text) => {
    expect(copy.customerObservations(text, [])).not.toMatch(/0100|7946|0958/);
    expect(copy.customerObservations(text, [])).toMatch(/if the patch spreads/);
  });

  test.each([
    ['Chinch bug infestation', 'Chinch bug activity along the edge.'],
    ['Fungal disease', 'Fungal activity in the shade.'],
    ['Large patch disease', 'Large patch in the shade.'],
    ['Large patch, a fungal disease', 'Large patch in the shade.'],
    ['Fungal large patch', 'Large patch in the shade.'],
    ['Mold and mildew', 'Fungal activity in the shade.'],
    ['Large patch is not only visible but spreading', 'Large patch is spreading in the shade.'],
  ])('a generic class word beside its own cause in %s still counts as one cause', (name, text) => {
    const evidence = { name, label: 'general lawn stress', confidence: 'moderate' };
    expect(copy.customerObservations(text, [evidence])).toBe(text);
    expect(copy.customerObservations(text, [])).toBe(copy.NO_OBSERVATIONS);
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
