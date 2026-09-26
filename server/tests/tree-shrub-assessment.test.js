// Unit tests for the Tree & Shrub assessment service: severity→health score
// mapping, the dual-vision merge, null-safe formatting, and the report loader's
// visit-linking + shaping (via a mock knex). Synthetic data only (no PII, no
// network — the vision API calls are not exercised here).

const {
  toCategoryScores,
  calculateOverall,
  averageScores,
  mergePhotoComposites,
  scoreAndStoreTreeShrubAssessment,
  buildTreeShrubTechFindings,
  treeShrubReviewSignature,
  treeShrubPhotosHash,
  applyReviewDecisions,
  storeTreeShrubAssessmentFromReview,
  previewTreeShrubAssessment,
  formatAssessmentScores,
  buildTreeShrubAssessmentReportData,
  isCompleteVisionResult,
  isValidTreeShrubScores,
  VISION_RESULT_SCHEMA,
  SCHEMA_PROMPT_SHAPES,
  SCHEMA_VALIDATORS,
  OBSERVATIONS_MIN_LENGTH,
  NUMERIC_SCORE_FIELDS,
  SEVERITY_SCORE_FIELDS,
  VISION_PROMPT,
} = require('../services/tree-shrub-assessment');

describe('toCategoryScores — severity → 0-100 health', () => {
  it('maps signal severity to the shared health ramp (none95/minor75/moderate50/severe20)', () => {
    const s = toCategoryScores({
      foliage_fullness: 84, leaf_color_vigor: 76,
      pest_signals: 'minor', disease_signals: 'none',
      water_heat_stress: 'moderate', pruning_mechanical: 'none',
    });
    expect(s.foliageFullness).toBe(84);
    expect(s.leafColorVigor).toBe(76);
    expect(s.pestActivity).toBe(75);       // minor
    expect(s.diseaseLeafSpot).toBe(95);    // none
    expect(s.waterHeatStress).toBe(50);    // worst of moderate(50) vs none(95)
  });

  it('takes the worst of water/heat vs pruning/mechanical so one severe stressor is not diluted', () => {
    const s = toCategoryScores({ water_heat_stress: 'none', pruning_mechanical: 'severe' });
    expect(s.waterHeatStress).toBe(20);    // severe pruning dominates
  });

  it('unknown/garbage severity defaults to none (health 95), and blank 0-100 → null', () => {
    const s = toCategoryScores({ foliage_fullness: '', pest_signals: 'bogus' });
    expect(s.foliageFullness).toBeNull();
    expect(s.pestActivity).toBe(95);
  });
});

describe('calculateOverall', () => {
  it('averages the available categories', () => {
    expect(calculateOverall({ foliageFullness: 80, leafColorVigor: 80, pestActivity: 60, diseaseLeafSpot: 100, waterHeatStress: 80 })).toBe(80);
  });
  it('null when nothing is scored', () => {
    expect(calculateOverall({})).toBeNull();
  });
});

describe('averageScores — dual-vision merge', () => {
  it('averages 0-100 fields and severity indices, flags large divergence', () => {
    const { composite, divergenceFlags } = averageScores(
      { foliage_fullness: 60, leaf_color_vigor: 70, pest_signals: 'none', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none' },
      { foliage_fullness: 90, leaf_color_vigor: 72, pest_signals: 'severe', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none' },
    );
    expect(composite.foliage_fullness).toBe(75);     // (60+90)/2
    expect(composite.pest_signals).toBe('moderate'); // (none0 + severe3)/2 → 2
    // foliage gap 30 (>20) and pest gap 3 (>=2) both flagged
    expect(divergenceFlags.map((f) => f.metric).sort()).toEqual(['foliage_fullness', 'pest_signals']);
  });
  it('returns the single available model when the other is null', () => {
    const only = { foliage_fullness: 80 };
    expect(averageScores(only, null).composite).toBe(only);
    expect(averageScores(null, only).composite).toBe(only);
  });
  it('uses the available severity when the OTHER model omits that field (not averaged to clean)', () => {
    const { composite } = averageScores(
      { foliage_fullness: 80, leaf_color_vigor: 80, pest_signals: 'moderate', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none' },
      { foliage_fullness: 80, leaf_color_vigor: 80, disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none' }, // pest_signals omitted
    );
    expect(composite.pest_signals).toBe('moderate'); // NOT averaged down to 'minor'
  });
  it('an explicit "none" still counts as a real read (averages normally)', () => {
    const { composite } = averageScores(
      { foliage_fullness: 80, leaf_color_vigor: 80, pest_signals: 'moderate', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none' },
      { foliage_fullness: 80, leaf_color_vigor: 80, pest_signals: 'none', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none' },
    );
    expect(composite.pest_signals).toBe('minor'); // (moderate2 + none0)/2 = 1 = minor
  });
});

describe('formatAssessmentScores — null-safe + overall fallback', () => {
  it('reads DB columns and falls back to a computed overall when null', () => {
    const s = formatAssessmentScores({
      foliage_fullness: 84, leaf_color_vigor: 76, pest_activity: 58, disease_leaf_spot: 88, water_heat_stress: 72, overall_score: null,
    });
    expect(s.pestActivity).toBe(58);
    expect(s.overallScore).toBe(76); // avg(84,76,58,88,72)
  });
  it('keeps a stored overall when present, and null stays null (not 0)', () => {
    const s = formatAssessmentScores({ foliage_fullness: null, overall_score: 90 });
    expect(s.foliageFullness).toBeNull();
    expect(s.overallScore).toBe(90);
  });
  it.each([false, true])('masks historical hidden scores and their aggregate (JSON string=%s)', (asString) => {
    const review = { ai: { pestActivity: 42 }, reviewed: [{ key: 'pest_activity', action: 'hidden' }] };
    const s = formatAssessmentScores({
      foliage_fullness: 82, pest_activity: 78, overall_score: 80,
      composite_scores: asString ? JSON.stringify(review) : review,
    });
    expect(s).toMatchObject({ foliageFullness: 82, pestActivity: null, overallScore: null });
    expect(review.ai.pestActivity).toBe(42);
  });
  it('does not recalculate an overall from remaining scores after a hide', () => {
    expect(formatAssessmentScores({
      foliage_fullness: 82, pest_activity: null, overall_score: null,
      composite_scores: { reviewed: [{ key: 'pest_activity', action: 'hidden' }] },
    }).overallScore).toBeNull();
  });
});

describe('buildTreeShrubTechFindings — exception-based closeout', () => {
  it('clean visit → no findings, no-action copy', () => {
    const out = buildTreeShrubTechFindings({ scores: { foliageFullness: 92, leafColorVigor: 90, pestActivity: 95, diseaseLeafSpot: 95, waterHeatStress: 90 } });
    expect(out.findings).toHaveLength(0);
    expect(out.aiSummary).toMatch(/No urgent visible plant issues/);
    expect(out.suggestedCustomerAction).toBe('No action needed');
  });

  it('flags watch/attention categories as monitor-by-default, in signals language', () => {
    const out = buildTreeShrubTechFindings({ scores: { foliageFullness: 84, leafColorVigor: 76, pestActivity: 58, diseaseLeafSpot: 88, waterHeatStress: 72 } });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].key).toBe('pest_activity');
    expect(out.findings[0].defaultAction).toBe('monitor');
    const text = JSON.stringify(out).toLowerCase();
    expect(text).toMatch(/pest-pressure signals/);
    expect(text).not.toMatch(/infestation|diseased|confirmed/);
  });

  // codex GH r2 (cloud) P1 on PR #4752: a 'tracking' (null-score, never
  // assessed) category is not a "finding" — it's neither watch nor
  // needs_attention — so it never reached `findings`, and the summary fell
  // through to the same "No urgent visible plant issues found" a genuinely
  // clean, fully-assessed visit gets. That reassures the customer about
  // dimensions (pest/disease/water-heat) that were never actually checked.
  it('a tracking-only category (never assessed) is NOT a clean read — neutral copy, not "no urgent issues"', () => {
    const out = buildTreeShrubTechFindings({ scores: { foliageFullness: 92, leafColorVigor: 90, pestActivity: null, diseaseLeafSpot: null, waterHeatStress: null } });
    expect(out.findings).toHaveLength(0); // tracking is not a finding either
    expect(out.trackingCount).toBe(3);
    expect(out.aiSummary).not.toMatch(/No urgent visible plant issues/);
    expect(out.aiSummary).toMatch(/couldn't get a clear enough read/i);
    expect(out.suggestedCustomerAction).not.toBe('No action needed');
  });

  it('a genuinely clean visit (every category assessed and healthy) still gets the "no urgent issues" copy — the tracking fix does not regress the real clean case', () => {
    const out = buildTreeShrubTechFindings({ scores: { foliageFullness: 92, leafColorVigor: 90, pestActivity: 95, diseaseLeafSpot: 95, waterHeatStress: 90 } });
    expect(out.trackingCount).toBe(0);
    expect(out.aiSummary).toMatch(/No urgent visible plant issues/);
    expect(out.suggestedCustomerAction).toBe('No action needed');
  });
});

describe('treeShrubReviewSignature — anti-tamper binding', () => {
  const scores = { foliageFullness: 84, leafColorVigor: 76, pestActivity: 58, diseaseLeafSpot: 88, waterHeatStress: 72, overallScore: 76 };
  const ph = treeShrubPhotosHash(['data:a', 'data:b']);
  it('is stable for the same inputs (order-independent of score object keys)', () => {
    const a = treeShrubReviewSignature(scores, 2, 'svc1', ph, 'obs');
    const reordered = { overallScore: 76, waterHeatStress: 72, diseaseLeafSpot: 88, pestActivity: 58, leafColorVigor: 76, foliageFullness: 84 };
    expect(treeShrubReviewSignature(reordered, 2, 'svc1', ph, 'obs')).toBe(a);
  });
  it('changes when ANY bound field is tampered (score / count / service / photos / observation)', () => {
    const base = treeShrubReviewSignature(scores, 2, 'svc1', ph, 'obs');
    expect(treeShrubReviewSignature({ ...scores, pestActivity: 95 }, 2, 'svc1', ph, 'obs')).not.toBe(base);
    expect(treeShrubReviewSignature(scores, 3, 'svc1', ph, 'obs')).not.toBe(base);
    expect(treeShrubReviewSignature(scores, 2, 'svc2', ph, 'obs')).not.toBe(base);
    expect(treeShrubReviewSignature(scores, 2, 'svc1', treeShrubPhotosHash(['data:a', 'data:c']), 'obs')).not.toBe(base); // photo swap
    expect(treeShrubReviewSignature(scores, 2, 'svc1', ph, 'tampered observation')).not.toBe(base);
  });
  it('photo hash is order-sensitive and content-bound', () => {
    expect(treeShrubPhotosHash(['a', 'b'])).not.toBe(treeShrubPhotosHash(['b', 'a']));
    expect(treeShrubPhotosHash(['a', 'b'])).toBe(treeShrubPhotosHash(['a', 'b']));
  });
});

describe('applyReviewDecisions — tech confirm/hide (signal-only)', () => {
  const scores = { foliageFullness: 84, leafColorVigor: 76, pestActivity: 45, diseaseLeafSpot: 50, waterHeatStress: 72 };
  it('hide leaves a category unassessed and suppresses its influenced overall', () => {
    const out = applyReviewDecisions(scores, [{ key: 'pest_activity', action: 'hidden' }]);
    expect(out.scores.pestActivity).toBeNull();
    expect(out.scores.overallScore).toBeNull();
    expect(out.scores.foliageFullness).toBe(84);
    expect(scores.pestActivity).toBe(45);
  });
  it('hiding every metric produces tracking categories without healthy claims', () => {
    const decisions = ['foliage_fullness', 'leaf_color_vigor', 'pest_activity', 'disease_leaf_spot', 'water_heat_mechanical_stress']
      .map(key => ({ key, action: 'hidden' }));
    const reviewed = applyReviewDecisions(scores, decisions).scores;
    const report = require('../services/service-report/tree-shrub-report-v2').buildTreeShrubReportV2({
      treeShrubAssessment: { scores: reviewed },
    });
    expect(report.snapshot).toMatchObject({ overallScore: null, status: 'tracking' });
    expect(report.diagnosis).toHaveLength(5);
    for (const category of report.diagnosis) {
      expect(category).toMatchObject({ score: null, status: 'tracking', customerExplanation: '' });
    }
    expect(report.snapshot.peaceOfMind).not.toMatch(/healthy|no.*signals|did not flag/i);
  });
  it('confirm keeps the finding as a monitored signal — NO confirmed-diagnosis escalation', () => {
    const out = applyReviewDecisions(scores, [{ key: 'disease_leaf_spot', action: 'confirmed' }]);
    expect(out.scores.diseaseLeafSpot).toBe(50); // unchanged
    expect(out.techConfirmedDisease).toBeUndefined(); // closeout never sets confirmed flags
    expect(out.techConfirmedPest).toBeUndefined();
  });
  it('monitor (default) changes nothing', () => {
    const out = applyReviewDecisions(scores, [{ key: 'pest_activity', action: 'monitor' }]);
    expect(out.scores.pestActivity).toBe(45);
  });
});

describe('storeTreeShrubAssessmentFromReview — persist reviewed (no re-score)', () => {
  function captureKnex() {
    const inserts = { tree_shrub_assessments: [], tree_shrub_assessment_photos: [] };
    const knex = (table) => ({
      where() { return { first: () => Promise.resolve(null), catch: () => Promise.resolve(null) }; },
      insert(row) { inserts[table].push(row); return { returning: () => Promise.resolve([{ id: 'rev-1' }]), catch: () => Promise.resolve([{ id: 'rev-1' }]) }; },
    });
    return { knex, inserts };
  }
  it('persists hidden scores as unknown while retaining the original review for audit', async () => {
    const { knex, inserts } = captureKnex();
    const out = await storeTreeShrubAssessmentFromReview({
      service: { id: 'sr1', customer_id: 'c1', service_date: '2026-06-24' },
      scores: { foliageFullness: 84, leafColorVigor: 76, pestActivity: 45, diseaseLeafSpot: 88, waterHeatStress: 72 },
      decisions: [{ key: 'pest_activity', action: 'hidden' }, { key: 'disease_leaf_spot', action: 'confirmed' }],
      photos: [{ s3_key: 'k1', caption: 'Front shrubs', zone: 'Front' }],
      observations: 'Reviewed at closeout.', knex,
    });
    expect(out.assessmentId).toBe('rev-1');
    const row = inserts.tree_shrub_assessments[0];
    expect(row.pest_activity).toBeNull();
    expect(row.overall_score).toBeNull();
    expect(row.foliage_fullness).toBe(84);
    expect(JSON.parse(row.composite_scores)).toMatchObject({
      ai: { pestActivity: 45 },
      reviewed: [{ key: 'pest_activity', action: 'hidden' }, { key: 'disease_leaf_spot', action: 'confirmed' }],
    });
    expect(row.tech_confirmed_disease).toBe(false); // confirm never escalates to confirmed diagnosis
    expect(row.tech_confirmed_pest).toBe(false);
    expect(row.confirmed_by_tech).toBe(true);
    expect(inserts.tree_shrub_assessment_photos).toHaveLength(1);
  });

  it('clears the AI observation when a finding is hidden (no contradiction in the summary)', async () => {
    const { knex, inserts } = captureKnex();
    await storeTreeShrubAssessmentFromReview({
      service: { id: 'sr2', customer_id: 'c1' },
      scores: { pestActivity: 45 },
      decisions: [{ key: 'pest_activity', action: 'hidden' }],
      observations: 'Light pest-pressure signals on the front shrubs.',
      photos: [], knex,
    });
    const row = inserts.tree_shrub_assessments[0];
    expect(row.observations).toBe('');
    expect(row.ai_summary).toBe('');
  });

  it('is idempotent — skips the insert when the visit already has an assessment (resume safety)', async () => {
    const inserts = { tree_shrub_assessments: [], tree_shrub_assessment_photos: [] };
    const knex = (table) => ({
      where() { return { first: () => Promise.resolve({ id: 'existing-1' }), catch: () => Promise.resolve({ id: 'existing-1' }) }; },
      insert(row) { inserts[table].push(row); return { returning: () => Promise.resolve([{ id: 'x' }]) }; },
    });
    const out = await storeTreeShrubAssessmentFromReview({ service: { id: 'sr1', customer_id: 'c1' }, scores: { pestActivity: 50 }, photos: [], knex });
    expect(out.alreadyExists).toBe(true);
    expect(out.assessmentId).toBe('existing-1');
    expect(inserts.tree_shrub_assessments).toHaveLength(0);
  });
});

describe('previewTreeShrubAssessment — score + findings, no persist', () => {
  const analyze = (b) => Promise.resolve({ composite: { foliage_fullness: 84, leaf_color_vigor: 76, pest_signals: 'moderate', disease_signals: 'none', water_heat_stress: 'minor', pruning_mechanical: 'none', observations: 'Light stippling on front shrubs.' } });
  it('returns scores + findings', async () => {
    const out = await previewTreeShrubAssessment({ photos: [{ tag: 'x' }], loadImage: () => ({ base64: 'x', mimeType: 'image/jpeg' }), analyze });
    expect(out.scores.pestActivity).toBe(50); // moderate
    expect(out.findings.some((f) => f.key === 'pest_activity')).toBe(true);
    expect(out.aiSummary).toMatch(/flagged/i);
  });
  it('null when nothing scores', async () => {
    expect(await previewTreeShrubAssessment({ photos: [{}], loadImage: () => ({ base64: 'x' }), analyze: () => Promise.resolve(null) })).toBeNull();
  });
});

describe('buildTreeShrubAssessmentReportData — loader', () => {
  const assessment = {
    id: 'a1', customer_id: 'c1', service_date: '2026-06-24', confirmed_by_tech: true,
    foliage_fullness: 84, leaf_color_vigor: 76, pest_activity: 58, disease_leaf_spot: 88, water_heat_stress: 72, overall_score: 76,
    observations: 'Front entry shrubs show light pest-pressure signals.',
    plant_groups: [{ label: 'Front Entry Shrubs', status: 'watch', finding: 'Light signals.' }],
    tech_confirmed_pest: false, tech_confirmed_disease: false,
  };
  const photos = [{ id: 'p1', assessment_id: 'a1', url: 'https://x/a.jpg', zone: 'Front entry shrubs', caption: 'Light signals.', is_best_photo: true, quality_score: 92, customer_visible: true }];
  function mockKnex(table) {
    const rows = table === 'tree_shrub_assessment_photos' ? photos : [assessment];
    const b = {
      where: () => b, andWhere: () => b, whereIn: () => b, whereRaw: () => b, orWhereRaw: () => b, orderBy: () => b, limit: () => b,
      first: () => Promise.resolve(rows[0] || null),
      then: (res) => Promise.resolve(rows).then(res),
      catch: () => Promise.resolve(rows),
    };
    return b;
  }

  it('returns null for a non-tree_shrub service line', async () => {
    expect(await buildTreeShrubAssessmentReportData({ customer_id: 'c1' }, 'lawn', mockKnex)).toBeNull();
  });

  it('shapes a confirmed assessment into the aggregator payload', async () => {
    const out = await buildTreeShrubAssessmentReportData({ id: 'sr1', customer_id: 'c1', service_date: '2026-06-24' }, 'tree_shrub', mockKnex);
    expect(out).toBeTruthy();
    expect(out.scores.pestActivity).toBe(58);
    expect(out.photos).toHaveLength(1);
    expect(out.photos[0].url).toBe('https://x/a.jpg');
    expect(out.plantGroups).toHaveLength(1);
    expect(out.assessmentDate).toBe('2026-06-24');
  });
  it('keeps hidden scores and aggregates out of current and historical trend readings', async () => {
    const hidden = { ...assessment, pest_activity: 78,
      composite_scores: { reviewed: [{ key: 'pest_activity', action: 'hidden' }] } };
    const knex = (table) => {
      const rows = table === 'tree_shrub_assessment_photos' ? [] : [hidden];
      const query = { where: () => query, orderBy: () => query, limit: () => query,
        first: async () => rows[0], catch: async () => rows };
      return query;
    };
    const out = await buildTreeShrubAssessmentReportData({ id: 'sr1', customer_id: 'c1' }, 'tree_shrub', knex);
    expect(out.scores).toMatchObject({ pestActivity: null, overallScore: null, foliageFullness: 84 });
    expect(out.trend).toEqual([expect.objectContaining({ pestActivity: null, overallScore: null })]);
  });
});

describe('mergePhotoComposites — multi-photo roll-up', () => {
  it('averages numeric fields and takes the WORST severity (trouble spot wins)', () => {
    const merged = mergePhotoComposites([
      { foliage_fullness: 90, leaf_color_vigor: 80, pest_signals: 'none', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none', observations: 'Overview looks full.' },
      { foliage_fullness: 70, leaf_color_vigor: 70, pest_signals: 'moderate', disease_signals: 'minor', water_heat_stress: 'none', pruning_mechanical: 'none', observations: 'Stippling on one shrub.' },
    ]);
    expect(merged.foliage_fullness).toBe(80);    // (90+70)/2
    expect(merged.pest_signals).toBe('moderate'); // worst of none/moderate
    expect(merged.disease_signals).toBe('minor');
    expect(merged.observations).toBe('Overview looks full.'); // first non-empty
  });
});

describe('scoreAndStoreTreeShrubAssessment — auto-score + persist', () => {
  function captureKnex() {
    const inserts = { tree_shrub_assessments: [], tree_shrub_assessment_photos: [] };
    const knex = (table) => ({
      where() { return { first: () => Promise.resolve(null), catch: () => Promise.resolve(null) }; },
      insert(row) {
        inserts[table].push(row);
        return { returning: () => Promise.resolve([{ id: 'new-assess-1' }]), catch: () => Promise.resolve([{ id: 'new-assess-1' }]) };
      },
    });
    return { knex, inserts };
  }
  // Fake analyzer: returns a raw composite by photo tag so we control the scores.
  const fakeAnalyze = (base64) => Promise.resolve({
    composite: base64 === 'TROUBLE'
      ? { foliage_fullness: 70, leaf_color_vigor: 68, pest_signals: 'moderate', disease_signals: 'none', water_heat_stress: 'minor', pruning_mechanical: 'none', observations: 'Light stippling noted.' }
      : { foliage_fullness: 90, leaf_color_vigor: 85, pest_signals: 'none', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none', observations: 'Full and healthy.' },
  });
  const loadImage = (photo) => Promise.resolve({ base64: photo.tag, mimeType: 'image/jpeg' });

  it('scores photos, persists an assessment + photo rows, auto-confirmed', async () => {
    const { knex, inserts } = captureKnex();
    const out = await scoreAndStoreTreeShrubAssessment({
      service: { id: 'sr1', customer_id: 'c1', service_date: '2026-06-24', technician_id: 't1' },
      photos: [{ tag: 'GOOD', url: 'https://x/1.jpg', zone: 'Palms' }, { tag: 'TROUBLE', url: 'https://x/2.jpg', zone: 'Front shrubs' }],
      loadImage, analyze: fakeAnalyze, knex,
    });
    expect(out).toBeTruthy();
    expect(out.assessmentId).toBe('new-assess-1');
    // pest_signals worst = moderate → health 50
    expect(out.scores.pestActivity).toBe(50);
    const row = inserts.tree_shrub_assessments[0];
    expect(row.confirmed_by_tech).toBe(true);
    expect(row.confirmed_at).toBeTruthy();
    expect(row.pest_activity).toBe(50);
    expect(inserts.tree_shrub_assessment_photos).toHaveLength(2);
    // exactly one best photo, and it is the higher-overall (GOOD) one
    const best = inserts.tree_shrub_assessment_photos.filter((p) => p.is_best_photo);
    expect(best).toHaveLength(1);
    expect(best[0].url).toBe('https://x/1.jpg');
  });

  it('returns null (no row) when nothing scores', async () => {
    const { knex, inserts } = captureKnex();
    const out = await scoreAndStoreTreeShrubAssessment({
      service: { id: 'sr1', customer_id: 'c1' },
      photos: [{ tag: 'x' }],
      loadImage, analyze: () => Promise.resolve(null), knex,
    });
    expect(out).toBeNull();
    expect(inserts.tree_shrub_assessments).toHaveLength(0);
  });

  it('returns null with no photos or no loader (never throws)', async () => {
    expect(await scoreAndStoreTreeShrubAssessment({ service: { customer_id: 'c1' }, photos: [] })).toBeNull();
    expect(await scoreAndStoreTreeShrubAssessment({ service: {}, photos: [{ tag: 'x' }], loadImage })).toBeNull();
  });
});

describe('VISION_RESULT_SCHEMA — one declared shape for the prompt, the merge lists, and validation', () => {
  it('every schema kind has a prompt renderer and a validator (nothing can be prompted but unvalidated)', () => {
    const kinds = [...new Set(Object.values(VISION_RESULT_SCHEMA).map((spec) => spec.kind))].sort();
    expect(Object.keys(SCHEMA_PROMPT_SHAPES).sort()).toEqual(kinds);
    expect(Object.keys(SCHEMA_VALIDATORS).sort()).toEqual(kinds);
  });

  it('the prompt\'s JSON block is exactly the schema, field by field, in order', () => {
    const block = VISION_PROMPT.slice(VISION_PROMPT.lastIndexOf('{'));
    const lines = block.split('\n').slice(1, -1).map((line) => line.trim().replace(/,$/, ''));
    expect(lines).toEqual(Object.entries(VISION_RESULT_SCHEMA)
      .map(([field, spec]) => `"${field}": ${SCHEMA_PROMPT_SHAPES[spec.kind](spec)}`));
    expect(VISION_PROMPT).toContain('"foliage_fullness": <number 0-100>');
    expect(VISION_PROMPT).toContain('"pest_signals": <"none" | "minor" | "moderate" | "severe">');
    expect(VISION_PROMPT).toContain('"observations": "<one concise paragraph>"');
  });

  it('the merge field lists are derived from the schema', () => {
    expect(NUMERIC_SCORE_FIELDS).toEqual(['foliage_fullness', 'leaf_color_vigor']);
    expect(SEVERITY_SCORE_FIELDS).toEqual(['pest_signals', 'disease_signals', 'water_heat_stress', 'pruning_mechanical']);
    expect(VISION_RESULT_SCHEMA.observations).toEqual({ kind: 'text', minLength: OBSERVATIONS_MIN_LENGTH });
    expect(OBSERVATIONS_MIN_LENGTH).toBe(20);
  });
});

describe('isCompleteVisionResult — generic walk over VISION_RESULT_SCHEMA', () => {
  // A valid value for every field, built from the schema itself.
  const VALID_BY_KIND = {
    score: (spec) => Math.round((spec.min + spec.max) / 2),
    severity: (spec) => spec.values[1],
    text: (spec) => 'Canopy looks full with even color. '.padEnd(spec.minLength + 5, '.'),
  };
  // Invalid values per kind, parameterized by the field's own spec.
  const INVALID_BY_KIND = {
    score: (spec) => [
      ['a numeric string', String(spec.min + 1)],
      ['a boolean (num(false) → 0)', false],
      ['above range', spec.max + 1],
      ['below range', spec.min - 1],
      ['NaN', NaN],
      ['Infinity', Infinity],
    ],
    severity: (spec) => [
      ['a number', 1],
      ['a boolean', false],
      ['an unknown word', 'high'],
      ['blank', ''],
    ],
    text: (spec) => [
      ['a number', 42],
      ['empty', ''],
      ['whitespace only', ' '.repeat(spec.minLength + 5)],
      ['one char too short', 'x'.repeat(spec.minLength - 1)],
    ],
  };
  const fullRead = () => Object.fromEntries(Object.entries(VISION_RESULT_SCHEMA)
    .map(([field, spec]) => [field, VALID_BY_KIND[spec.kind](spec)]));
  // analyzePhoto's shape. averageScores itself throws on a non-string
  // observation (.trim()) — analyzePhoto would reject and the admin lane
  // treats that as unscored — so the helper falls back to a bare composite
  // to let the validator judge the raw reads directly.
  const result = (claude, gemini) => {
    let composite;
    try { ({ composite } = averageScores(claude, gemini)); } catch { composite = {}; }
    return { claude, gemini, composite };
  };
  const cases = Object.entries(VISION_RESULT_SCHEMA).flatMap(([field, spec]) => [
    [field, 'missing from both providers', undefined],
    ...INVALID_BY_KIND[spec.kind](spec).map(([label, value]) => [field, label, value]),
  ]);

  it('the valid-value and invalid-value tables cover every schema kind', () => {
    const kinds = Object.keys(SCHEMA_VALIDATORS).sort();
    expect(Object.keys(VALID_BY_KIND).sort()).toEqual(kinds);
    expect(Object.keys(INVALID_BY_KIND).sort()).toEqual(kinds);
  });

  it('a full valid read (from one or both providers) is complete', () => {
    expect(isCompleteVisionResult(result(fullRead(), fullRead()))).toBe(true);
    expect(isCompleteVisionResult(result(fullRead(), null))).toBe(true);
    expect(isCompleteVisionResult(result(null, { ...fullRead(), pest_signals: ' Severe ' }))).toBe(true);
  });

  it.each(cases)('%s %s → incomplete', (field, _label, value) => {
    if (value === undefined) {
      const { [field]: _omitted, ...partial } = fullRead();
      expect(isCompleteVisionResult(result(partial, partial))).toBe(false);
      return;
    }
    // Bad from ONE provider while the other is valid still fails: every
    // provider that sent a field must have sent a valid value.
    expect(isCompleteVisionResult(result({ ...fullRead(), [field]: value }, fullRead()))).toBe(false);
    expect(isCompleteVisionResult(result(fullRead(), { ...fullRead(), [field]: value }))).toBe(false);
  });

  it('the per-provider gate (isValidTreeShrubScores, which decides the Claude fallback) walks the SAME schema', () => {
    expect(isValidTreeShrubScores(fullRead())).toBe(true);
    for (const [field, _label, value] of cases) {
      const bad = { ...fullRead(), [field]: value };
      if (value === undefined) delete bad[field];
      expect({ field, value, valid: isValidTreeShrubScores(bad) }).toEqual({ field, value, valid: false });
    }
  });

  it.each(Object.entries(VISION_RESULT_SCHEMA))('%s: one provider omitting it while the other read it validly is complete', (field) => {
    const { [field]: _omitted, ...partial } = fullRead();
    expect(isCompleteVisionResult(result(fullRead(), partial))).toBe(true);
  });

  it('boundary values are accepted: score min/max, observations at exactly the minimum length', () => {
    for (const field of NUMERIC_SCORE_FIELDS) {
      const { min, max } = VISION_RESULT_SCHEMA[field];
      expect(isCompleteVisionResult(result({ ...fullRead(), [field]: min }, null))).toBe(true);
      expect(isCompleteVisionResult(result({ ...fullRead(), [field]: max }, null))).toBe(true);
    }
    expect(isCompleteVisionResult(result({ ...fullRead(), observations: 'y'.repeat(OBSERVATIONS_MIN_LENGTH) }, null))).toBe(true);
  });

  it('the guarded silent defaults are real: an omitted severity averages to "none", a blank dilutes a signal', () => {
    const { disease_signals: _d, ...partial } = fullRead();
    expect(result(partial, partial).composite.disease_signals).toBe('none');
    expect(result({ ...fullRead(), pest_signals: 'severe' }, { ...fullRead(), pest_signals: '' }).composite.pest_signals).toBe('moderate');
  });

  it('rejects null / composite-less results', () => {
    expect(isCompleteVisionResult(null)).toBe(false);
    expect(isCompleteVisionResult({ claude: fullRead(), gemini: null, composite: null })).toBe(false);
  });
});
