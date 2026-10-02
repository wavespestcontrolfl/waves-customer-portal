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
    expect(stripCrownHealthClaims("We couldn't see the crown well, but it looks healthy.")).toBe('');
    expect(stripCrownHealthClaims('The crown is fine and the newest fronds are green.')).toBe('');
    // Adverse findings are kept.
    expect(stripCrownHealthClaims('The palm crown is not healthy.')).toBe('The palm crown is not healthy.');
    expect(stripCrownHealthClaims("The spear leaf isn't normal.")).toBe("The spear leaf isn't normal.");
    expect(stripCrownHealthClaims('The palm crown looks weak.')).toBe('The palm crown looks weak.');
    expect(stripCrownHealthClaims('The crown is declining.')).toBe('The crown is declining.');
    expect(stripCrownHealthClaims('The newest fronds show poor health.')).toBe('The newest fronds show poor health.');
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
    expect(src).toContain('const report = techFindingsCopyLive() ? stripCrownHealthClaims(generated.report) : generated.report;');
    expect(src.indexOf('stripCrownHealthClaims(generated.report)')).toBeLessThan(src.indexOf('reportCopyCacheSet(cacheKey, report);'));
    expect(src).toContain('const safeFallback = techFindingsCopyLive() ? stripCrownHealthClaims(report) : report;');
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

  test('hiding pest_activity drops pest and generic-assessment captions and keeps plain location labels', () => {
    gateOn();
    const out = build(withCaptions([
      'Visible pest-pressure signals on foliage.',
      'Scale on the hibiscus',
      'Possible concern near the entry',
      'Front bed, east side',
    ]), [decide('pest_activity', 'hidden')]);
    expect(out.photos.map((p) => p.caption)).toEqual([null, null, null, 'Front bed, east side']);
    expect(JSON.stringify(out)).not.toMatch(/pest-pressure|scale on/i);
  });

  test('an edited finding\'s captions are replaced by the technician\'s text; the photos stay', () => {
    gateOn();
    const out = build(withCaptions(['Yellowing on the ixora', 'Back fence line']), [decide('leaf_color_vigor', 'edit', 'Iron chlorosis, treated today.')]);
    expect(out.photos).toHaveLength(2);
    expect(out.photos.map((p) => p.caption)).toEqual([null, 'Back fence line']);
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
