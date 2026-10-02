// GATE_TS_TECH_FINDINGS_COPY (T&S <-> lawn parity PR Q1). The technician's
// keep / confirm / hide / edit decisions on the photo-read findings are frozen
// on the service record and obeyed by customer copy; the photo read stays for
// the office. Palm-crown rule: photos are ground level, so no customer copy may
// vouch for a palm's crown, spear leaf or newest fronds. Synthetic data only.

const fs = require('fs');
const path = require('path');

const {
  freezeTechFindings, normalizeTechFindings, stripCrownHealthClaims, applyTechFindingsToAssessment,
  techFindingsPromptLines, hasTechFindingLines,
} = require('../services/service-report/tree-shrub-tech-findings');
const { buildTreeShrubReportV2 } = require('../services/service-report/tree-shrub-report-v2');
const { buildTreeShrubVisualCategories } = require('../services/service-report/tree-shrub-visual-categories');
const { validateTreeShrubReviewForReport, treeShrubPhotosHash, treeShrubReviewSignature } = require('../services/tree-shrub-assessment');
const { buildReportCopyContext } = require('../services/service-report/report-copy-context');

jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: async () => null }));

const GATE = 'GATE_TS_TECH_FINDINGS_COPY';
const priorGate = process.env[GATE];
const gateOn = () => { process.env[GATE] = 'true'; };
const gateOff = () => { delete process.env[GATE]; };
afterEach(() => { if (priorGate === undefined) delete process.env[GATE]; else process.env[GATE] = priorGate; });

const SCORES = {
  foliageFullness: 60, leafColorVigor: 90, pestActivity: 40, diseaseLeafSpot: 90, waterHeatStress: 90, overallScore: 74,
};
const assessment = (over = {}) => ({
  scores: { ...SCORES },
  observations: 'Light stippling on some shrubs. The palm crown looks healthy. Older fronds show yellowing.',
  aiSummary: null,
  photos: [{ url: 'https://example.test/p1.jpg', zone: 'Front bed', isBest: true, qualityScore: 80, caption: null }],
  trend: [
    { date: '2026-08-01', overallScore: 70, foliageFullness: 70, leafColorVigor: 80, pestActivity: 60, waterHeatStress: 70 },
    { date: '2026-09-01', overallScore: 74, foliageFullness: 60, leafColorVigor: 90, pestActivity: 40, waterHeatStress: 90 },
  ],
  plantGroups: [],
  ...over,
});
const build = (assess, techFindings) => buildTreeShrubReportV2({
  treeShrubAssessment: assess, applications: [], actions: [], customerConcern: '',
  ...(techFindings === undefined ? {} : { techFindings }),
});
const decide = (key, action, detail = null) => ({ key, action, detail, label: key });
const insightOf = (report, category) => report.insights.find((i) => i.category === category);
const diagOf = (report, key) => report.diagnosis.find((d) => d.key === key);

describe('freeze: the decisions are stored whether or not the signed preview is accepted', () => {
  // A review whose signature is wrong: the completion re-scores and drops the
  // decisions, but the freeze reads the body, not the accepted preview.
  const staleReview = {
    scores: SCORES, scoredCount: 2, signature: 'not-a-valid-signature', observations: 'x',
    decisions: [
      { key: 'pest_activity', action: 'hidden', detail: 'Possible pest-pressure signals on foliage.' },
      { key: 'leaf_color_vigor', action: 'edit', detail: '  Mild   iron chlorosis on the ixora.  ' },
      { key: 'bogus_key', action: 'hidden' },
      { key: 'foliage_fullness', action: 'nope' },
      { key: 'pest_activity', action: 'confirmed' },
    ],
  };

  test('gate on: structured_notes fields are produced even for a review that fails signature checks', () => {
    gateOn();
    const now = new Date('2026-10-02T15:00:00Z');
    const frozen = freezeTechFindings(staleReview, { now });
    expect(frozen).toEqual({
      treeShrubTechFindings: [
        { key: 'pest_activity', action: 'hidden', detail: 'Possible pest-pressure signals on foliage.', label: 'Pest-pressure signals' },
        { key: 'leaf_color_vigor', action: 'edit', detail: 'Mild iron chlorosis on the ixora.', label: 'Leaf color & vigor' },
      ],
      treeShrubTechFindingsDecidedAt: now.toISOString(),
    });
    // Signature validation (the report-writer contract) rejects the same review.
    expect(validateTreeShrubReviewForReport({ ...staleReview, confirmed: true, photoCount: 2, photosHash: 'x' }, { serviceId: 's1' }).ok).toBe(false);
  });

  test('gate off: nothing is written; no decisions: nothing is written', () => {
    gateOff();
    expect(freezeTechFindings(staleReview)).toBeNull();
    gateOn();
    expect(freezeTechFindings({ decisions: [] })).toBeNull();
    expect(freezeTechFindings(null)).toBeNull();
    expect(freezeTechFindings({ decisions: [{ key: 'x', action: 'hidden' }] })).toBeNull();
  });

  test('the completion freezes outside the signature branch and merges into the service_records structured_notes write', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    // Computed from the request body alone (no signature / preview inputs).
    expect(src).toContain("? freezeTechFindings(completionInput.body?.treeShrubReview)");
    const freezeIdx = src.indexOf('const treeShrubTechFindingsFreeze');
    const signatureIdx = src.indexOf('const reviewSigned');
    expect(freezeIdx).toBeGreaterThan(-1);
    expect(freezeIdx).toBeLessThan(signatureIdx);
    // One chokepoint: spread into the structuredNotes object the insert writes.
    const notesStart = src.indexOf('const structuredNotes = {');
    expect(src.indexOf('...(treeShrubTechFindingsFreeze || {}),')).toBeGreaterThan(notesStart);
    expect(src.indexOf('structured_notes: serializeJsonb(structuredNotes)')).toBeGreaterThan(notesStart);
  });
});

describe('customer report obeys the frozen decisions', () => {
  test('a hidden finding never appears: no score, no insight, no photo prose written from the read that included it', () => {
    gateOn();
    const out = build(assessment(), [decide('pest_activity', 'hidden')]);
    expect(insightOf(out, 'pest_pressure')).toBeUndefined();
    const pest = diagOf(out, 'pest_activity');
    expect(pest.score).toBeNull();
    expect(pest.status).toBe('tracking');
    expect(pest.customerExplanation).toBe('');
    // The overall that included the hidden read and the prose written from it go too.
    expect(out.snapshot.overallScore).toBeNull();
    expect(out.photoSummary).toBeNull();
    // This visit's trend point is nulled; the earlier visit keeps its own read.
    expect(out.trends.pest).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/stippling|pest-pressure signals|Light pest/i);
  });

  test('a hidden finding with no matching card still removes the card the signals would build', () => {
    gateOn();
    // Pest score 40 would build a card with the gate off.
    expect(insightOf(build(assessment()), 'pest_pressure')).toBeDefined();
    expect(insightOf(build(assessment(), [decide('pest_activity', 'hidden')]), 'pest_pressure')).toBeUndefined();
  });

  test('a confirmed finding is the technician\'s finding', () => {
    gateOn();
    const out = build(assessment(), [decide('pest_activity', 'confirmed')]);
    const card = insightOf(out, 'pest_pressure');
    expect(card.whatWeSaw).toBe('Your technician confirmed visible pest activity on some foliage during the visit.');
    expect(card.confidence).toBe('tech_confirmed');
    expect(diagOf(out, 'pest_activity').customerExplanation).toMatch(/^Confirmed by your technician during the visit\. /);
    // Signals language is kept: no infestation / diagnosis claim.
    expect(JSON.stringify(out)).not.toMatch(/infest|diseased/i);
  });

  test('an edit uses the technician\'s text and drops the photo prose it replaces; the score stays', () => {
    gateOn();
    const out = build(assessment(), [decide('pest_activity', 'edit', 'Scale crawlers on the ixora, treated today.')]);
    expect(insightOf(out, 'pest_pressure').whatWeSaw).toBe('Scale crawlers on the ixora, treated today.');
    expect(diagOf(out, 'pest_activity').customerExplanation).toBe('Scale crawlers on the ixora, treated today.');
    expect(diagOf(out, 'pest_activity').score).toBe(40);
    expect(out.photoSummary).toBeNull();
  });

  test('an edit with no text, and monitor, keep today\'s signals-only language', () => {
    gateOn();
    const baseline = build(assessment(), []);
    expect(build(assessment(), [decide('pest_activity', 'monitor', 'Possible pest-pressure signals on foliage.')])).toEqual(baseline);
    expect(build(assessment(), [decide('pest_activity', 'edit', '   ')])).toEqual(baseline);
    expect(insightOf(baseline, 'pest_pressure').whatWeSaw).toBe('Visible pest-pressure signals on some foliage (chewing, stippling, or residue).');
  });

  test('the photo read is not mutated: the input assessment keeps its scores and prose for the office', () => {
    gateOn();
    const input = assessment();
    const before = JSON.stringify(input);
    applyTechFindingsToAssessment(input, [decide('pest_activity', 'hidden')]);
    build(input, [decide('pest_activity', 'hidden'), decide('foliage_fullness', 'edit', 'Hedge gap from a trimming.')]);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('palm-crown rule', () => {
  test('stripCrownHealthClaims removes crown / spear / newest-frond health sentences only', () => {
    expect(stripCrownHealthClaims('The palm crown looks healthy. Older fronds show yellowing.')).toBe('Older fronds show yellowing.');
    expect(stripCrownHealthClaims('Spear leaf and newest fronds are normal.')).toBe('');
    expect(stripCrownHealthClaims('New growth on the palm looks green and strong.')).toBe('');
    expect(stripCrownHealthClaims('Crownshaft is clean with no issues.')).toBe('');
    // Not a palm-crown claim: kept.
    expect(stripCrownHealthClaims('New growth on the hedge looks great.')).toBe('New growth on the hedge looks great.');
    expect(stripCrownHealthClaims('Older fronds show potassium deficiency.')).toBe('Older fronds show potassium deficiency.');
    // The honest disclaimer is kept.
    const disclaimer = 'We could not check the crown from the ground.';
    expect(stripCrownHealthClaims(disclaimer)).toBe(disclaimer);
    // Section layout survives: only the offending line goes.
    expect(stripCrownHealthClaims('WHAT WE FOUND\nThe spear leaf looks healthy.\nOlder fronds are yellowing.'))
      .toBe('WHAT WE FOUND\nOlder fronds are yellowing.');
    expect(stripCrownHealthClaims(null)).toBeNull();
  });

  test('positive claims go even behind a ground-level phrase; adverse and can\'t-assess statements stay', () => {
    // Prohibited reassurance, ground-level prefix or not.
    expect(stripCrownHealthClaims('From the ground, the palm crown looks healthy.')).toBe('');
    expect(stripCrownHealthClaims('Ground-level photos show the spear leaf is normal.')).toBe('');
    expect(stripCrownHealthClaims("We couldn't see the palm crown well, but it looks healthy.")).toBe("We couldn't see the palm crown well.");
    // Codex #5587 r2: "crown" with no palm context is any tree's crown.
    expect(stripCrownHealthClaims('The oak crown looks healthy.')).toBe('The oak crown looks healthy.');
    expect(stripCrownHealthClaims('The crown looks healthy.')).toBe('The crown looks healthy.');
    expect(stripCrownHealthClaims('The crown is fine and the newest fronds are green.')).toBe('');
    // Adverse findings are kept.
    expect(stripCrownHealthClaims('The palm crown is not healthy.')).toBe('The palm crown is not healthy.');
    expect(stripCrownHealthClaims("The spear leaf isn't normal.")).toBe("The spear leaf isn't normal.");
    expect(stripCrownHealthClaims('The palm crown looks weak.')).toBe('The palm crown looks weak.');
    expect(stripCrownHealthClaims('The crown is declining.')).toBe('The crown is declining.');
    expect(stripCrownHealthClaims('The newest fronds show poor health.')).toBe('The newest fronds show poor health.');
    // A bare "no" right before the health word is adverse, not reassurance.
    expect(stripCrownHealthClaims('No healthy spear leaf was visible.')).toBe('No healthy spear leaf was visible.');
    expect(stripCrownHealthClaims('The crown has no healthy fronds.')).toBe('The crown has no healthy fronds.');
    // ...but a "no" further back, or "no visible damage", still reads as a claim.
    expect(stripCrownHealthClaims('No problems, palm crown looks healthy.')).toBe('');
    expect(stripCrownHealthClaims('The palm crown shows no visible damage.')).toBe('');
    // Pure can't-assess disclaimers are kept.
    expect(stripCrownHealthClaims("We couldn't check the crown from the ground.")).toBe("We couldn't check the crown from the ground.");
    expect(stripCrownHealthClaims('Crown health is not visible from the ground.')).toBe('Crown health is not visible from the ground.');
    // Mixed paragraph: only the reassurance goes.
    expect(stripCrownHealthClaims("From the ground, the palm crown looks healthy. The palm crown is not healthy near the base. We couldn't check the spear leaf."))
      .toBe("The palm crown is not healthy near the base. We couldn't check the spear leaf.");
  });

  test('gate on: the photo summary and captions never carry a crown-health sentence; gate off they are untouched', () => {
    const withCrown = assessment({
      observations: 'Light stippling on some shrubs. The palm crown looks healthy. Older fronds show yellowing.',
      photos: [{ url: 'https://example.test/p1.jpg', zone: 'Palms', isBest: true, qualityScore: 80, caption: 'Spear leaf looks fine' }],
    });
    gateOn();
    const on = build(withCrown, []);
    expect(on.photoSummary).toBe('Light stippling on some shrubs. Older fronds show yellowing.');
    expect(on.photos[0].caption).toBeNull();
    expect(JSON.stringify(on)).not.toMatch(/crown|spear/i);
    const off = build(withCrown);
    expect(off.photoSummary).toContain('The palm crown looks healthy.');
    expect(off.photos[0].caption).toBe('Spear leaf looks fine');
  });

  test('an edit that vouches for the crown loses that sentence', () => {
    gateOn();
    const out = build(assessment(), [decide('leaf_color_vigor', 'edit', 'Iron chlorosis on the oldest fronds. The palm crown is healthy.')]);
    expect(diagOf(out, 'leaf_color_vigor').customerExplanation).toBe('Iron chlorosis on the oldest fronds.');
  });

  test('a strong color row no longer vouches for new growth (a palm\'s newest fronds) when the gate is on', () => {
    const strong = { leafColorVigor: 92 };
    const off = buildTreeShrubVisualCategories({ scores: strong }).find((c) => c.key === 'leaf_color_vigor');
    const on = buildTreeShrubVisualCategories({ scores: strong, palmCrownRule: true }).find((c) => c.key === 'leaf_color_vigor');
    expect(off.customerExplanation).toBe('Vibrant, even leaf color with healthy new growth.');
    expect(on.customerExplanation).toBe('Vibrant, even leaf color across the plants.');
    expect(on.customerExplanation).not.toMatch(/new growth/i);
  });

  test('no gate-on report string vouches for a crown, spear or new fronds, whatever the scores', () => {
    gateOn();
    for (const level of [95, 80, 60, 30]) {
      const scores = {
        foliageFullness: level, leafColorVigor: level, pestActivity: level, diseaseLeafSpot: level, waterHeatStress: level, overallScore: level,
      };
      const out = build(assessment({ scores, observations: 'The crown and spear leaf look healthy and the new fronds are fine.' }), []);
      expect(JSON.stringify(out)).not.toMatch(/crown|spear|new growth|new fronds/i);
    }
  });
});

describe('gate off: customer output is byte-identical to before', () => {
  test('omitting the tech findings, or passing null, is the same report; the gate-off copy is unchanged', () => {
    gateOff();
    for (const scores of [SCORES, { ...SCORES, pestActivity: null, overallScore: null }, { ...SCORES, leafColorVigor: 95 }]) {
      const a = assessment({ scores });
      expect(build(a)).toEqual(build(a, null));
      expect(JSON.stringify(build(a))).toBe(JSON.stringify(build(a, undefined)));
    }
    const out = build(assessment({ scores: { ...SCORES, leafColorVigor: 95 } }));
    expect(diagOf(out, 'leaf_color_vigor').customerExplanation).toBe('Vibrant, even leaf color with healthy new growth.');
    expect(out.photoSummary).toContain('The palm crown looks healthy.');
  });

  test('the review grounding and the vision prompt carry nothing new', () => {
    gateOff();
    const scores = { foliageFullness: 50, leafColorVigor: 70, pestActivity: 80, diseaseLeafSpot: 90, waterHeatStress: 80, overallScore: 74 };
    const photosHash = treeShrubPhotosHash(['data:image/jpeg;base64,YQ==']);
    const review = {
      scores, photosHash, observations: 'Sparse foliage.', photoCount: 1, scoredCount: 1, confirmed: true,
      decisions: [{ key: 'pest_activity', action: 'edit', detail: 'Scale on the ixora.' }],
    };
    review.signature = treeShrubReviewSignature(scores, 1, 's1', photosHash, review.observations);
    const off = validateTreeShrubReviewForReport(review, { serviceId: 's1' });
    expect(off.ok).toBe(true);
    expect(off.grounding.techFindings).toBeUndefined();
    expect(off.grounding.scores.pestActivity).toBe(80);
    gateOn();
    const on = validateTreeShrubReviewForReport(review, { serviceId: 's1' });
    expect(on.grounding.techFindings).toEqual([
      { key: 'pest_activity', action: 'edit', detail: 'Scale on the ixora.', label: 'Pest-pressure signals' },
    ]);
    // The edited category's photo read and the prose written from it are withheld from the writer.
    expect(on.grounding.scores.pestActivity).toBeUndefined();
    expect(on.grounding.scores.overallScore).toBeUndefined();
    expect(on.grounding.observations).toBe('');
  });
});

describe('report-writer prompt', () => {
  const grounding = (techFindings) => ({
    source: 'reviewed_photo_signals',
    scores: { foliageFullness: 50 },
    scoredCount: 1,
    photoCount: 1,
    observations: 'Sparse foliage is visible.',
    ...(techFindings ? { techFindings } : {}),
  });
  const ctx = (g) => buildReportCopyContext({
    customerId: null, treeShrubReviewGrounding: g, serviceType: 'Tree and Shrub Care', serviceLine: 'tree_shrub',
  });

  test('gate on: technician-confirmed / edited findings and the ground-level rule reach the prompt', async () => {
    gateOn();
    const result = await ctx(grounding([
      { key: 'pest_activity', action: 'confirmed', detail: null },
      { key: 'leaf_color_vigor', action: 'edit', detail: 'Iron chlorosis on the oldest fronds.' },
      { key: 'foliage_fullness', action: 'hidden', detail: 'x' },
    ]));
    expect(result.contextText).toContain('TECHNICIAN FINDINGS FOR THIS VISIT');
    expect(result.contextText).toContain('Pest-pressure signals: the technician confirmed it during the visit');
    expect(result.contextText).toContain('Leaf color & vigor: the technician wrote: Iron chlorosis on the oldest fronds.');
    expect(result.contextText).toContain("never state or imply that a palm's crown, spear leaf or newest fronds look healthy");
    // A hidden finding is never described to the writer.
    expect(result.contextText).not.toContain('Foliage fullness: the technician');
  });

  test('gate off: the grounding block is exactly the pre-gate block', async () => {
    const result = await ctx(grounding(null));
    expect(result.contextText).toContain('TREE & SHRUB REVIEWED PHOTO SIGNALS');
    expect(result.contextText).not.toContain('TECHNICIAN FINDINGS FOR THIS VISIT');
    expect(result.contextText).not.toContain('PHOTO REACH');
  });

  test('techFindingsPromptLines is empty when the technician only monitored or hid', () => {
    expect(techFindingsPromptLines(normalizeTechFindings([
      { key: 'pest_activity', action: 'monitor' }, { key: 'foliage_fullness', action: 'hidden' },
    ]))).toBe('');
  });

  test('the route strips a crown-health sentence from the generated report before it is cached or returned', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    // The strip runs inside the generator (before the shape check) and ONLY on tree_shrub copy.
    expect(src).toContain("const crownBackstopOn = techFindingsCopyLive() && detectServiceLine(groundingServiceType) === 'tree_shrub';");
    expect(src).toContain('...(crownBackstopOn ? { postProcess: stripCrownHealthClaims } : {}),');
    expect(src).toContain('let safeFallback = crownBackstopOn ? stripCrownHealthClaims(report) : report;');
    expect(src).not.toContain('stripCrownHealthClaims(generated.report)');
  });
});

describe('access codes never reach customer copy through the technician\'s edit', () => {
  const CODE_TEXT = 'Checked shrubs beside gate code 1234.';

  test('the diagnosis row, insight card and writer prompt carry the edit without the code', () => {
    gateOn();
    const findings = [decide('pest_activity', 'edit', CODE_TEXT)];
    const out = build(assessment(), findings);
    expect(JSON.stringify(out)).not.toContain('1234');
    expect(diagOf(out, 'pest_activity').customerExplanation).toBe('Checked shrubs beside gate code [redacted].');
    expect(insightOf(out, 'pest_pressure').whatWeSaw).toBe('Checked shrubs beside gate code [redacted].');
    expect(techFindingsPromptLines(findings)).not.toContain('1234');
    expect(techFindingsPromptLines(findings)).toContain('[redacted]');
  });

  test('the code is not stored in the frozen decision either', () => {
    gateOn();
    const frozen = freezeTechFindings({ decisions: [{ key: 'pest_activity', action: 'edit', detail: CODE_TEXT }] });
    expect(JSON.stringify(frozen)).not.toContain('1234');
  });
});

describe('a hidden or replaced finding does not survive in photo captions', () => {
  const withCaptions = (captions) => assessment({
    photos: captions.map((caption, i) => ({
      url: `https://example.test/p${i}.jpg`, zone: `Zone ${i}`, isBest: i === 0, qualityScore: 80, caption,
    })),
  });

  test('hiding any finding withholds every photo-read caption (no vocabulary guess); the photos and slot labels stay', () => {
    gateOn();
    const out = build(withCaptions([
      'Visible pest-pressure signals on foliage.',
      'Scale on the hibiscus',
      'Possible concern near the entry',
      'Front bed, east side',
    ]), [decide('pest_activity', 'hidden')]);
    expect(out.photos.map((p) => p.caption)).toEqual([null, null, null, null]);
    expect(out.photos).toHaveLength(4);
    expect(JSON.stringify(out)).not.toMatch(/pest-pressure|scale on/i);
    // Codex #5587 r2: an unlisted synonym is withheld too.
    const beetle = build(withCaptions(['Beetle holes in the leaves']), [decide('pest_activity', 'hidden')]);
    expect(beetle.photos[0].caption).toBeNull();
  });

  test('an edited finding\'s captions are replaced by the technician\'s text; the photos stay', () => {
    gateOn();
    const out = build(withCaptions(['Yellowing on the ixora', 'Back fence line']), [decide('leaf_color_vigor', 'edit', 'Iron chlorosis, treated today.')]);
    expect(out.photos).toHaveLength(2);
    expect(out.photos.map((p) => p.caption)).toEqual([null, null]);
  });

  test('monitor / confirmed leave captions alone; gate off leaves them alone', () => {
    gateOn();
    const caps = ['Visible pest-pressure signals on foliage.'];
    expect(build(withCaptions(caps), [decide('pest_activity', 'monitor')]).photos[0].caption).toBe(caps[0]);
    expect(build(withCaptions(caps), [decide('pest_activity', 'confirmed')]).photos[0].caption).toBe(caps[0]);
    gateOff();
    expect(build(withCaptions(caps)).photos[0].caption).toBe(caps[0]);
  });
});

describe('every category edited or hidden: the writer grounding stays valid', () => {
  const ALL = ['foliage_fullness', 'leaf_color_vigor', 'pest_activity', 'disease_leaf_spot', 'water_heat_mechanical_stress'];
  const reviewWith = (decisions) => {
    const scores = { foliageFullness: 50, leafColorVigor: 70, pestActivity: 80, diseaseLeafSpot: 90, waterHeatStress: 80, overallScore: 74 };
    const photosHash = treeShrubPhotosHash(['data:image/jpeg;base64,YQ==']);
    const review = { scores, photosHash, observations: 'Sparse foliage.', photoCount: 1, scoredCount: 1, confirmed: true, decisions };
    review.signature = treeShrubReviewSignature(scores, 1, 's1', photosHash, review.observations);
    return review;
  };
  const ctx = (g) => buildReportCopyContext({
    customerId: null, treeShrubReviewGrounding: g, serviceType: 'Tree and Shrub Care', serviceLine: 'tree_shrub',
  });

  test('all edited: no scores, an explicit no-photo-scores marker, and the technician\'s text still grounds the writer', async () => {
    gateOn();
    const v = validateTreeShrubReviewForReport(reviewWith(ALL.map((key) => ({ key, action: 'edit', detail: `Tech note for ${key}.` }))), { serviceId: 's1' });
    expect(v.ok).toBe(true);
    expect(v.grounding.scores).toEqual({});
    expect(hasTechFindingLines(v.grounding.techFindings)).toBe(true);
    const result = await ctx(v.grounding);
    expect(result.contextText).toContain('TECHNICIAN-REVIEWED PHOTOS (source: reviewed_photo_signals; no photo scores)');
    expect(result.contextText).toContain('Tech note for pest_activity.');
    expect(result.contextText).not.toMatch(/\/100/);
    expect(result.signals.hasTreeShrubReviewedPhotoSignals).toBe(true);
  });

  test('all hidden: nothing to say, so nothing is claimed grounded (the route keeps its existing not-enough-detail path)', async () => {
    gateOn();
    const v = validateTreeShrubReviewForReport(reviewWith(ALL.map((key) => ({ key, action: 'hidden' }))), { serviceId: 's1' });
    expect(v.grounding.scores).toEqual({});
    expect(hasTechFindingLines(v.grounding.techFindings)).toBe(false);
    const result = await ctx(v.grounding);
    expect(result.contextText).not.toContain('no photo scores');
    expect(result.signals.hasTreeShrubReviewedPhotoSignals).toBe(false);
  });

  test('the route treats the technician\'s findings as report input and 503s if their grounding fails to load', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(src).toContain('const treeShrubTechFindingsGrounded = hasTechFindingLines(treeShrubReviewGrounding?.techFindings);');
    expect(src).toContain('|| treeShrubTechFindingsGrounded\n      || Object.keys(treeShrubReviewGrounding?.scores || {}).length > 0');
    expect(src).toContain('if (treeShrubTechFindingsGrounded && !contextSignals.hasTreeShrubReviewedPhotoSignals)');
  });
});

describe('later reports\' history honors an earlier visit\'s frozen hides', () => {
  const { buildTreeShrubAssessmentReportData } = require('../services/tree-shrub-assessment');
  const row = (id, recordId, date, pest) => ({
    id, customer_id: 'c1', service_record_id: recordId, service_date: date, confirmed_by_tech: true,
    foliage_fullness: 80, leaf_color_vigor: 80, pest_activity: pest, disease_leaf_spot: 80, water_heat_stress: 80, overall_score: 78,
    observations: '', plant_groups: [], composite_scores: null, tech_confirmed_pest: false, tech_confirmed_disease: false,
  });
  // Visit 1: preview rejected and re-scored, so composite_scores carries no
  // reviewed decisions; its hide lives only in the service record's notes.
  const rows = [row('a1', 'r1', '2026-08-01', 30), row('a2', 'r2', '2026-09-01', 70)];
  const notes = {
    r1: { treeShrubTechFindings: [{ key: 'pest_activity', action: 'hidden', detail: null, label: 'x' }] },
    r2: {},
  };
  const reads = [];
  const knex = (table) => {
    reads.push(table);
    const data = table === 'tree_shrub_assessments' ? rows
      : table === 'service_records' ? Object.entries(notes).map(([id, n]) => ({ id, structured_notes: id === 'r1' ? JSON.stringify(n) : n }))
        : [];
    const q = {
      where: () => q, whereIn: () => q, select: () => q, orderBy: () => q, limit: () => q,
      first: async () => rows[1], then: (res) => Promise.resolve(data).then(res), catch: async () => data,
    };
    return q;
  };
  const service = { id: 'r2', customer_id: 'c1', service_date: '2026-09-01' };

  test('gate on: the earlier visit\'s hidden metric and overall are omitted from the later report\'s trend', async () => {
    gateOn();
    const out = await buildTreeShrubAssessmentReportData(service, 'tree_shrub', knex);
    expect(out.trend).toHaveLength(2);
    expect(out.trend[0]).toMatchObject({ pestActivity: null, overallScore: null, foliageFullness: 80 });
    expect(out.trend[1]).toMatchObject({ pestActivity: 70, overallScore: 78 });
    // And through the report builder, the pest trend has no hidden point left to chart.
    const report = buildTreeShrubReportV2({ treeShrubAssessment: out, techFindings: [] });
    expect(report.trends.pest).toBeUndefined();
  });

  test('gate off: history is read exactly as before and the notes are never fetched', async () => {
    gateOff();
    reads.length = 0;
    const out = await buildTreeShrubAssessmentReportData(service, 'tree_shrub', knex);
    expect(out.trend[0]).toMatchObject({ pestActivity: 30, overallScore: 78 });
    expect(reads).not.toContain('service_records');
  });
});

describe('crown backstop works one clause at a time', () => {
  test('an adverse clause earlier in the sentence does not excuse a later positive crown claim', () => {
    expect(stripCrownHealthClaims('Older fronds show decline, but the palm crown looks good.')).toBe('Older fronds show decline.');
    expect(stripCrownHealthClaims('Older fronds show decline; the spear leaf is fine.')).toBe('Older fronds show decline.');
  });

  test('an unrelated health word in another clause does not drop an adverse crown clause', () => {
    const s = 'The spear leaf collapsed and is declining, while the hedges look healthy.';
    expect(stripCrownHealthClaims(s)).toBe(s);
    const t = 'The hedges look healthy, but the palm crown is not healthy.';
    expect(stripCrownHealthClaims(t)).toBe(t);
  });

  test('a hedged claim is still dropped, with its orphaned remainder', () => {
    expect(stripCrownHealthClaims('The palm crown appears healthy but is not clearly visible.')).toBe('');
    expect(stripCrownHealthClaims('The crown appears healthy, though it is not clearly visible from the ground. Older fronds are yellowing.'))
      .toBe('Older fronds are yellowing.');
  });

  test('wider health words and crown synonyms', () => {
    for (const claim of [
      'The palm crown looks excellent.', 'The spear leaf is firm and upright.', 'The newest fronds look vibrant.',
      'The upper fronds are lush and full.', 'The top of the palm looks robust.', 'The head of the palm looks strong.',
      'The palm canopy looks thriving.',
    ]) expect(stripCrownHealthClaims(claim)).toBe('');
    // A shrub canopy / new growth is not a palm crown.
    expect(stripCrownHealthClaims('The hedge canopy looks lush.')).toBe('The hedge canopy looks lush.');
    expect(stripCrownHealthClaims('New growth on the hedge looks great.')).toBe('New growth on the hedge looks great.');
  });

  test('the splitter never drops fragments: decimals, abbreviations and closing punctuation', () => {
    const keep = 'The palm is 3.5 m tall, e.g. about 12 ft, measured at 9 a.m. today vs. last visit. Older fronds are yellowing.';
    expect(stripCrownHealthClaims(keep)).toBe(keep);
    expect(stripCrownHealthClaims('The ixora is 3.5 m wide. The palm crown looks healthy.) Older fronds are yellowing.'))
      .toBe('The ixora is 3.5 m wide. Older fronds are yellowing.');
    expect(stripCrownHealthClaims('The crown looks healthy!! Older fronds are yellowing.')).toBe('Older fronds are yellowing.');
    expect(stripCrownHealthClaims('The palm crown looks healthy.** Done.')).toBe('Done.');
    // Round trip: with nothing to strip every line comes back byte-identical.
    const plain = 'Treated 3.5 m hedge (see photo). e.g. ok.\n\nNext line vs. last.';
    expect(stripCrownHealthClaims(plain)).toBe(plain);
  });
});

describe('the crown instruction is the primary guard', () => {
  const ctx = (over = {}) => buildReportCopyContext({
    customerId: null, serviceType: 'Tree and Shrub Care', serviceLine: 'tree_shrub', ...over,
  });

  test('gate on: reaches every tree_shrub generation, with no signed review attached', async () => {
    gateOn();
    const result = await ctx();
    expect(result.contextText).toContain("never state or imply that a palm's crown, spear leaf or newest fronds look healthy");
  });

  test('exactly once when a review is attached, absent for other lines and with the gate off', async () => {
    gateOn();
    const withReview = await ctx({
      treeShrubReviewGrounding: {
        source: 'reviewed_photo_signals', scores: { foliageFullness: 50 }, scoredCount: 1, photoCount: 1, observations: '', techFindings: [],
      },
    });
    expect(withReview.contextText.split('PHOTO REACH').length - 1).toBe(1);
    expect((await ctx({ serviceType: 'Lawn Care', serviceLine: 'lawn' })).contextText).not.toContain('PHOTO REACH');
    expect((await ctx({ serviceType: 'Pest Control', serviceLine: 'pest' })).contextText).not.toContain('PHOTO REACH');
    gateOff();
    expect((await ctx()).contextText).not.toContain('PHOTO REACH');
  });
});

describe('PDF and gallery surfaces', () => {
  test('captions: any hide / edit withholds them all; the crown strip applies otherwise', () => {
    const { filterCaptionsForCustomer, summaryForCustomer } = require('../services/service-report/tree-shrub-tech-findings');
    const hidden = [decide('pest_activity', 'hidden')];
    expect(filterCaptionsForCustomer(
      ['Visible pest-pressure signals on foliage.', 'Sticky residue on the hibiscus', 'Black film on leaves', 'Crawlers on the stems', 'The palm crown looks healthy', 'Front bed'],
      hidden,
    )).toEqual([]);
    expect(filterCaptionsForCustomer(['The palm crown looks healthy', 'Back fence'], [])).toEqual(['Back fence']);
    // The summary: withdrawn by a hide / edit, crown-stripped otherwise.
    expect(summaryForCustomer('Stippling on shrubs.', hidden)).toBeNull();
    expect(summaryForCustomer('Hedges look full. The palm crown looks healthy.', [])).toBe('Hedges look full.');
    expect(summaryForCustomer('', [])).toBeNull();
  });

  test('report-data feeds gallery captions and the typed photoSummary through the overlay for tree_shrub only', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
    expect(src).toContain("const tsCopyFindings = (serviceLine === 'tree_shrub' && techFindingsCopyLive())");
    expect(src).toContain('? (filterCaptionsForCustomer([photo.caption || \'\'], tsCopyFindings)[0] || \'\')');
    expect(src).toContain('? summaryForCustomer(typedSnapshot.photoSummary, tsCopyFindings)');
  });
});

describe('confirmed finding on a clean photo read', () => {
  test('does not append the contradicting "No visible … today" line; a flagged row keeps its sentence', () => {
    gateOn();
    const clean = build(assessment({ scores: { ...SCORES, pestActivity: 95, overallScore: 90 } }), [decide('pest_activity', 'confirmed')]);
    expect(diagOf(clean, 'pest_activity').customerExplanation).toBe('Your technician confirmed visible pest activity on some foliage during the visit.');
    expect(diagOf(clean, 'pest_activity').customerExplanation).not.toMatch(/No visible/);
    const flagged = build(assessment(), [decide('pest_activity', 'confirmed')]);
    expect(diagOf(flagged, 'pest_activity').customerExplanation).toMatch(/^Confirmed by your technician during the visit\. Light pest-pressure|^Confirmed by your technician during the visit\. /);
  });
});

describe('shared color / fullness card', () => {
  test('hiding one finding keeps the card for the other\'s confirmation or edit; a bare hide drops it', () => {
    gateOn();
    const weak = assessment({ scores: { ...SCORES, leafColorVigor: 40, foliageFullness: 40, overallScore: 50 } });
    const edited = build(weak, [decide('leaf_color_vigor', 'hidden'), decide('foliage_fullness', 'edit', 'Hedge gap from a trimming.')]);
    expect(insightOf(edited, 'color_vigor').whatWeSaw).toBe('Hedge gap from a trimming.');
    const confirmed = build(weak, [decide('foliage_fullness', 'hidden'), decide('leaf_color_vigor', 'confirmed')]);
    expect(insightOf(confirmed, 'color_vigor').whatWeSaw).toBe('Your technician confirmed off-color foliage in places during the visit.');
    expect(insightOf(build(weak, [decide('leaf_color_vigor', 'hidden'), decide('foliage_fullness', 'hidden')]), 'color_vigor')).toBeUndefined();
  });
});

describe('strong foliage row and whitespace-split codes', () => {
  test('the strong fullness row stops saying "healthy growth" with the palm rule on', () => {
    const on = buildTreeShrubVisualCategories({ scores: { foliageFullness: 92 }, palmCrownRule: true }).find((c) => c.key === 'foliage_fullness');
    const off = buildTreeShrubVisualCategories({ scores: { foliageFullness: 92 } }).find((c) => c.key === 'foliage_fullness');
    expect(off.customerExplanation).toMatch(/healthy growth/);
    expect(on.customerExplanation).not.toMatch(/healthy|growth|canopy/i);
  });

  test('a code split across a line break is redacted before it is frozen', () => {
    gateOn();
    const frozen = freezeTechFindings({ decisions: [{ key: 'pest_activity', action: 'edit', detail: 'Beside the gate.\nGate:\n4521' }] });
    expect(JSON.stringify(frozen)).not.toContain('4521');
  });
});

describe('property score honors a visit\'s frozen hides', () => {
  const { _test } = require('../services/property-score');
  const rows = [
    { id: 'a2', customer_id: 'c1', service_record_id: 'r2', service_date: '2026-09-01', foliage_fullness: 80, leaf_color_vigor: 80, pest_activity: 30, disease_leaf_spot: 80, water_heat_stress: 80, overall_score: 78, composite_scores: null },
    { id: 'a1', customer_id: 'c1', service_record_id: 'r1', service_date: '2026-08-01', foliage_fullness: 70, leaf_color_vigor: 70, pest_activity: 70, disease_leaf_spot: 70, water_heat_stress: 70, overall_score: 70, composite_scores: null },
  ];
  const notes = { id: 'r2', structured_notes: { treeShrubTechFindings: [{ key: 'pest_activity', action: 'hidden', detail: null, label: 'x' }] } };
  const knex = (table) => {
    const data = table === 'service_records' ? [notes] : rows;
    const q = { where: () => q, whereIn: () => q, select: () => q, orderBy: () => q, limit: () => q, then: (r) => Promise.resolve(data).then(r), catch: async () => data };
    return q;
  };

  test('gate on: the hidden visit\'s overall is withheld, so the previous visit is the current score', async () => {
    gateOn();
    const out = await _test.treeShrubComponent('c1', knex, new Set(['tree_shrub']));
    expect(out).toMatchObject({ status: 'scored', score: 70, previousScore: null });
  });

  test('gate off: the score is read exactly as before', async () => {
    gateOff();
    const out = await _test.treeShrubComponent('c1', knex, new Set(['tree_shrub']));
    expect(out).toMatchObject({ status: 'scored', score: 78, previousScore: 70 });
  });
});

describe('photo observations block in the report prompt', () => {
  test('routes the captions and summary through the overlay for tree_shrub with the gate on', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(src).toContain("if (techFindingsCopyLive() && detectServiceLine(groundingServiceType) === 'tree_shrub') {");
    expect(src).toContain('promptPhotoCaptions = filterCaptionsForCustomer(cappedPhotoCaptions, techDecisions);');
    expect(src).toContain('const photoObservationsBlock = buildPhotoObservationsBlock(promptPhotoCaptions, promptPhotoSummary);');
  });
});

describe('a confirmed or edited finding on a clean photo read gets its own card', () => {
  const CLEAN = { foliageFullness: 95, leafColorVigor: 95, pestActivity: 95, diseaseLeafSpot: 95, waterHeatStress: 95, overallScore: 95 };
  const cleanAssessment = () => assessment({ scores: { ...CLEAN }, observations: '', trend: [] });

  test('all scores 95 + pest confirmed: a technician card, no "all look healthy" reassurance, and a matching headline', () => {
    gateOn();
    const out = build(cleanAssessment(), [decide('pest_activity', 'confirmed')]);
    const card = insightOf(out, 'pest_pressure');
    expect(card.whatWeSaw).toBe('Your technician confirmed visible pest activity on some foliage during the visit.');
    expect(card.confidence).toBe('tech_confirmed');
    expect(card.wavesAction).toBeTruthy();
    expect(card.nextVisitPlan).toBeTruthy();
    expect(insightOf(out, 'overall')).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/all look healthy|in good shape/i);
    expect(out.snapshot.statusHeadline).toMatch(/monitoring pest pressure/i);
    expect(out.snapshot.statusHeadline).not.toMatch(/looking great/i);
  });

  test('an edit gets a card in the technician\'s words; monitor / no decision keeps the reassurance', () => {
    gateOn();
    const out = build(cleanAssessment(), [decide('disease_leaf_spot', 'edit', 'Early leaf spot on the viburnum.')]);
    expect(insightOf(out, 'disease_leaf_spot').whatWeSaw).toBe('Early leaf spot on the viburnum.');
    expect(insightOf(out, 'overall')).toBeUndefined();
    const quiet = build(cleanAssessment(), [decide('pest_activity', 'monitor')]);
    expect(insightOf(quiet, 'overall')).toBeDefined();
    expect(insightOf(build(cleanAssessment(), []), 'overall')).toBeDefined();
  });

  test('a hidden finding builds no card; gate off (no techFindings) is unchanged', () => {
    gateOn();
    expect(insightOf(build(cleanAssessment(), [decide('pest_activity', 'hidden')]), 'pest_pressure')).toBeUndefined();
    expect(build(cleanAssessment())).toEqual(build(cleanAssessment(), null));
  });
});

describe('unavailable frozen decisions are explicit, never "no hides"', () => {
  const { loadFrozenTechFindingsByRecord, withholdScores } = require('../services/service-report/tree-shrub-tech-findings');
  const { buildTreeShrubAssessmentReportData } = require('../services/tree-shrub-assessment');
  const { _test } = require('../services/property-score');
  const failingRead = () => ({ whereIn: () => ({ select: () => Promise.reject(new Error('db down')) }) });

  test('the loader returns null on a failed read, a Map when read, an empty Map for no ids', async () => {
    expect(await loadFrozenTechFindingsByRecord([{ service_record_id: 'r1' }], () => failingRead())).toBeNull();
    const ok = await loadFrozenTechFindingsByRecord([{ service_record_id: 'r1' }], () => ({
      whereIn: () => ({ select: async () => [{ id: 'r1', structured_notes: { treeShrubTechFindings: [{ key: 'pest_activity', action: 'hidden' }] } }] }),
    }));
    expect(ok.get('r1')).toEqual([expect.objectContaining({ key: 'pest_activity', action: 'hidden' })]);
    expect((await loadFrozenTechFindingsByRecord([], () => { throw new Error('no read'); })).size).toBe(0);
    expect(withholdScores({ overallScore: 70, pestActivity: 60, foliageFullness: 50, other: 'x' }))
      .toMatchObject({ overallScore: null, pestActivity: null, foliageFullness: null, other: 'x' });
  });

  const rows = [
    { id: 'a1', customer_id: 'c1', service_record_id: 'r1', service_date: '2026-08-01', confirmed_by_tech: true, foliage_fullness: 80, leaf_color_vigor: 80, pest_activity: 30, disease_leaf_spot: 80, water_heat_stress: 80, overall_score: 78, observations: '', plant_groups: [], composite_scores: null },
    { id: 'a2', customer_id: 'c1', service_record_id: 'r2', service_date: '2026-09-01', confirmed_by_tech: true, foliage_fullness: 80, leaf_color_vigor: 80, pest_activity: 70, disease_leaf_spot: 80, water_heat_stress: 80, overall_score: 78, observations: '', plant_groups: [], composite_scores: null },
  ];
  const knexWithFailingRecords = (table) => {
    if (table === 'service_records') return failingRead();
    const data = table === 'tree_shrub_assessments' ? rows : [];
    const q = { where: () => q, whereIn: () => q, select: () => q, orderBy: () => q, limit: () => q, first: async () => rows[1], then: (r) => Promise.resolve(data).then(r), catch: async () => data };
    return q;
  };

  test('report history: earlier visits\' scores are withheld, the current visit is kept, and the payload is flagged', async () => {
    gateOn();
    const out = await buildTreeShrubAssessmentReportData({ id: 'r2', customer_id: 'c1', service_date: '2026-09-01' }, 'tree_shrub', knexWithFailingRecords);
    expect(out.techFindingsUnavailable).toBe(true);
    expect(out.trend[0]).toMatchObject({ overallScore: null, pestActivity: null, foliageFullness: null });
    expect(out.trend[1]).toMatchObject({ pestActivity: 70, overallScore: 78 });
    expect(out.scores).toMatchObject({ pestActivity: 70 });
  });

  test('gate off: no read, no flag, history as before', async () => {
    gateOff();
    const out = await buildTreeShrubAssessmentReportData({ id: 'r2', customer_id: 'c1', service_date: '2026-09-01' }, 'tree_shrub', knexWithFailingRecords);
    expect(out.techFindingsUnavailable).toBeUndefined();
    expect(out.trend[0]).toMatchObject({ pestActivity: 30, overallScore: 78 });
  });

  test('the payload flag counts as an uncacheable artifact (the image-failure signal the PDF stores already honor)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
    expect(src).toContain('if (treeShrubAssessment.techFindingsUnavailable) imageResolutionFailures += 1;');
    const store = fs.readFileSync(path.join(__dirname, '../routes/reports-public.js'), 'utf8');
    expect(store).toContain('renderedData?.imageResolutionFailures');
  });

  test('property score: no T&S score is trusted when the decisions could not be read; gate off reads as before', async () => {
    gateOn();
    const out = await _test.treeShrubComponent('c1', knexWithFailingRecords, new Set(['tree_shrub']));
    expect(out.status).not.toBe('scored');
    gateOff();
    const off = await _test.treeShrubComponent('c1', knexWithFailingRecords, new Set(['tree_shrub']));
    expect(off.status).toBe('scored');
  });
});

describe('saved report text gets the crown backstop at render', () => {
  const { crownSafeTodaysResult } = require('../services/service-report/report-data');
  const { technicianReportCustomerCopy } = require('../services/service-report/technician-report-copy');

  test('a frozen result card loses its crown claims and keeps everything else', () => {
    const out = crownSafeTodaysResult({
      headline: 'Shrubs treated',
      body: 'The palm crown looks healthy. Older fronds show some yellowing.',
      nextStep: 'We will recheck the oldest fronds next visit.',
      bodySource: 'technician_report',
    });
    expect(out).toEqual({
      headline: 'Shrubs treated',
      body: 'Older fronds show some yellowing.',
      nextStep: 'We will recheck the oldest fronds next visit.',
      bodySource: 'technician_report',
    });
    expect(crownSafeTodaysResult(null)).toBeNull();
  });

  test('saved technician notes are stripped before the section parse, which still parses', () => {
    const notes = 'WHAT WE DID:\nTreated the hedge.\n\nWHAT WE FOUND:\nThe palm crown looks healthy. Scale on the ixora.';
    const copy = technicianReportCustomerCopy(stripCrownHealthClaims(notes));
    expect(copy).not.toBeNull();
    expect(JSON.stringify(copy)).not.toMatch(/crown/i);
    expect(JSON.stringify(copy)).toMatch(/Scale on the ixora/);
  });

  test('report-data applies it only on the gated T&S path', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
    expect(src).toContain('const technicianReport = technicianReportCustomerCopy(tsCopyFindings\n      ? stripCrownHealthClaims(service.technician_notes)\n      : service.technician_notes);');
    expect(src).toContain('todaysResult: tsCopyFindings\n          ? crownSafeTodaysResult(typedSnapshot.todaysResult)\n          : (typedSnapshot.todaysResult || null),');
  });
});

describe('Codex r1 on #5587', () => {
  const { rejectedTechFindingEdits, editText } = require('../services/service-report/tree-shrub-tech-findings');

  test('a non-palm subject keeps its own clause even when a palm is named earlier', () => {
    expect(stripCrownHealthClaims('Older palm fronds are yellowing, but the hedge canopy looks healthy.'))
      .toBe('Older palm fronds are yellowing, but the hedge canopy looks healthy.');
    expect(stripCrownHealthClaims('Older palm fronds are yellowing, but the canopy looks healthy.'))
      .toBe('Older palm fronds are yellowing.');
    expect(stripCrownHealthClaims('The palm fronds are yellowing, but the new growth looks healthy.'))
      .toBe('The palm fronds are yellowing.');
  });

  test('an edit the customer-copy screen rejects is refused at completion and never prints', () => {
    gateOn();
    const review = { decisions: [
      { key: 'pest_activity', action: 'edit', detail: 'Applied a pet-safe, EPA-approved treatment.' },
      { key: 'disease_leaf_spot', action: 'edit', detail: 'Early leaf spot on the viburnum.' },
    ] };
    const rejected = rejectedTechFindingEdits(review);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ key: 'pest_activity', label: 'Pest-pressure signals' });
    expect(rejected[0].violations.length).toBeGreaterThan(0);
    expect(editText({ action: 'edit', detail: 'After 4 PM you can re-enter the yard.' })).toBeNull();
    expect(editText({ action: 'edit', detail: 'Early leaf spot on the viburnum.' })).toBe('Early leaf spot on the viburnum.');
    gateOff();
    expect(rejectedTechFindingEdits(review)).toEqual([]);
  });

  test('completion refuses a rejected edit before anything is written', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(src).toContain("code: 'TS_FINDING_EDIT_COPY_REJECTED'");
    expect(src.indexOf("code: 'TS_FINDING_EDIT_COPY_REJECTED'")).toBeLessThan(src.indexOf('const internalOnlyProductsBlock = internalOnlyProductsBlockPayload({'));
  });

  test('the report summary gets the crown backstop whatever wrote it (saved recap included)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
    expect(src).toContain('summary: tsCopyFindings ? stripCrownHealthClaims(visitSummary) : visitSummary,');
  });
});

describe('Codex r2 on #5587', () => {
  const { rejectedTechFindingEdits, normalizeTechFindings: norm } = require('../services/service-report/tree-shrub-tech-findings');

  test('an edit with nothing printable left reads as a hide everywhere, and completion refuses it', () => {
    gateOn();
    const decisions = [{ key: 'leaf_color_vigor', action: 'edit', detail: 'The palm crown looks healthy.' }];
    expect(norm(decisions)[0].action).toBe('hidden');
    expect(rejectedTechFindingEdits({ decisions })[0].violations).toEqual(['palm_crown_claim']);
    const out = build(assessment(), decisions.map((d) => decide(d.key, d.action, d.detail)));
    expect(out.snapshot ? JSON.stringify(out) : '').not.toMatch(/crown looks healthy/i);
  });

  test('a tech-only card documents; it never claims a program change or treatment', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/tree-shrub-report-insights.js'), 'utf8');
    const block = src.slice(src.indexOf('const TECH_CARD_COPY'), src.indexOf('};', src.indexOf('const TECH_CARD_COPY')));
    expect(block).not.toMatch(/adjusted|built .*into the plan|treated|will monitor/i);
  });

  test('the writer filters captions before its input gate', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(src.indexOf('promptPhotoCaptions = filterCaptionsForCustomer(cappedPhotoCaptions, techDecisions);'))
      .toBeLessThan(src.indexOf('const baseHasReportInput ='));
    expect(src).toContain('|| promptPhotoCaptions.length > 0;');
    expect(src).toContain('photoGroundingUsed = promptPhotoCaptions.length > 0;');
  });
});

describe('property score looks past visits with hidden findings (Codex r2 on #5587)', () => {
  const { _test } = require('../services/property-score');
  const row = (id, rec, date, overall) => ({
    id, customer_id: 'c1', service_record_id: rec, service_date: date, confirmed_by_tech: true,
    foliage_fullness: overall, leaf_color_vigor: overall, pest_activity: overall, disease_leaf_spot: overall,
    water_heat_stress: overall, overall_score: overall, observations: '', plant_groups: [], composite_scores: null,
  });
  const all = [row('a3', 'r3', '2026-09-20', 70), row('a2', 'r2', '2026-08-20', 72), row('a1', 'r1', '2026-07-20', 64)];
  const makeKnex = (limits) => (table) => {
    if (table === 'service_records') {
      return { whereIn: () => ({ select: async () => ['r3', 'r2'].map((id) => ({ id, structured_notes: { treeShrubTechFindings: [{ key: 'pest_activity', action: 'hidden' }] } })) }) };
    }
    let n = all.length;
    const q = { where: () => q, orderBy: () => q, limit: (k) => { limits.push(k); n = k; return q; }, then: (r) => Promise.resolve(all.slice(0, n)).then(r), catch: async () => all.slice(0, n) };
    return q;
  };

  test('gate on: the two newest hide a finding, the older scored visit still gives the score', async () => {
    gateOn();
    const limits = [];
    const out = await _test.treeShrubComponent('c1', makeKnex(limits), new Set(['tree_shrub']));
    expect(limits[0]).toBeGreaterThan(2);
    expect(out).toMatchObject({ status: 'scored', score: 64 });
  });

  test('gate off: the two newest, as before', async () => {
    gateOff();
    const limits = [];
    await _test.treeShrubComponent('c1', makeKnex(limits), new Set(['tree_shrub']));
    expect(limits[0]).toBe(2);
  });
});

describe('writer grounding applies normalized hides (pre-push P1 on cfd376f364)', () => {
  test('an edit with nothing printable left withholds its score, the overall and the prose', () => {
    gateOn();
    const scores = { foliageFullness: 50, leafColorVigor: 70, pestActivity: 80, diseaseLeafSpot: 90, waterHeatStress: 80, overallScore: 74 };
    const photosHash = treeShrubPhotosHash(['data:image/jpeg;base64,YQ==']);
    const review = {
      scores, photosHash, observations: 'Sparse foliage.', photoCount: 1, scoredCount: 1, confirmed: true,
      decisions: [{ key: 'leaf_color_vigor', action: 'edit', detail: 'The palm crown looks healthy.' }],
    };
    review.signature = treeShrubReviewSignature(scores, 1, 's1', photosHash, review.observations);
    const on = validateTreeShrubReviewForReport(review, { serviceId: 's1' });
    expect(on.grounding.techFindings[0].action).toBe('hidden');
    expect(on.grounding.scores.leafColorVigor).toBeUndefined();
    expect(on.grounding.scores.overallScore).toBeUndefined();
    expect(on.grounding.observations).toBe('');
    expect(on.grounding.hasHidden).toBe(true);
    expect(on.grounding.scores.pestActivity).toBe(80);
  });
});
