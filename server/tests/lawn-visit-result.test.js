jest.mock('../models/db', () => jest.fn());
const visit = require('../services/lawn-visit-result');
const { answer, finding, sev, sig } = require('./helpers/lawn-visit-fixtures');

test('normalizes server IDs, evidence, zones, quality, grass and bounded scores', () => {
  const result = visit.normalizeAssessment(answer({ findings: [finding({ finding_id: 'T1' }), finding({ finding_id: 'T1', name: 'Chinch bug damage', confidence: 'low', photo_refs: [2], zone: 'back' })] }), 3, ['front', null, null]);
  expect(result.findings.map((f) => f.finding_id)).toEqual(['F1', 'F2']);
  expect(result.findings[0]).toMatchObject({ model_finding_id: 'T1', photo_refs: [1, 2], zone: 'front', source: 'model', can_determine: true });
  expect(result.findings[1]).toMatchObject({ confidence: 'unknown', label: 'general lawn stress', zone: 'unknown' });
  expect(result.severities.insect_damage).toEqual({ level: 'unknown', evidence: '', confidence: 'unknown' });
  expect(result.scores).toEqual({ turf_density: 72, weed_coverage: 15, color_health: null });
  expect(result.photoQuality).toEqual([
    { photo: 1, quality: 'adequate', issue: '' }, { photo: 2, quality: 'poor', issue: 'blurred' },
    { photo: 3, quality: 'unrated', issue: 'not rated by the model' },
  ]);
  expect(result.grassType).toBe('st_augustine');
});

test('finding zones follow the cited photos\' technician labels only', () => {
    expect(visit.zoneFromRefs([1, 2], ['front', 'front'])).toBe('front');
    expect(visit.zoneFromRefs([1, 2], ['front', null])).toBe('front');
    expect(visit.zoneFromRefs([1, 2], ['front', 'back'])).toBe('unknown');
    expect(visit.zoneFromRefs([2], [null, null])).toBe('unknown');
    expect(visit.zoneFromRefs([], ['front'])).toBe('unknown');
  });

test('the chain validator rejects a malformed, finding-less or partly-rated answer so the fallback leg runs', () => {
    expect(visit.validateAssessmentJson({ json: answer() }, 2)).toBeNull();
    expect(visit.validateAssessmentJson({ json: answer({ findings: [] }) }, 2)).toBe('empty_findings');
    expect(visit.validateAssessmentJson({ json: { findings: 'x', severities: {}, scores: {} } }, 2)).toBe('malformed_assessment');
    expect(visit.validateAssessmentJson({ json: { findings: [], scores: {} } }, 2)).toBe('malformed_assessment');
    expect(visit.validateAssessmentJson({ json: null }, 2)).toBe('malformed_assessment');
    // Nested containers are checked before the leg is accepted (Ajv, the
    // schema's own nesting): a null / scalar finding, photo rating or score
    // object fails the leg instead of throwing from normalization after the
    // chain has settled. Scalar leaves stay lenient — the normalizers coerce them.
    expect(visit.validateAssessmentJson({ json: answer({ findings: [null] }) }, 2)).toBe('malformed_assessment');
    expect(visit.validateAssessmentJson({ json: answer({ findings: ['thinning turf'] }) }, 2)).toBe('malformed_assessment');
    expect(visit.validateAssessmentJson({ json: answer({ photo_quality: [null, ...answer().photo_quality] }) }, 2)).toBe('malformed_assessment');
    expect(visit.validateAssessmentJson({ json: answer({ scores: { ...answer().scores, turf_density: 72 } }) }, 2)).toBe('malformed_assessment');
    expect(visit.validateAssessmentJson({ json: answer({ findings: [{ ...answer().findings[0], photo_refs: ['1'], severity: 'high' }] }) }, 2)).toBeNull();
    // Every photo needs a valid quality read: none, a missing photo, an out-of-range or invalid entry all fail.
    expect(visit.validateAssessmentJson({ json: answer({ photo_quality: [] }) }, 2)).toBe('incomplete_photo_quality');
    expect(visit.validateAssessmentJson({ json: answer() }, 3)).toBe('incomplete_photo_quality'); // photo 3 unrated
    expect(visit.validateAssessmentJson({ json: answer({ photo_quality: [{ photo: 1, quality: 'adequate' }, { photo: 2, quality: 'great' }] }) }, 2)).toBe('incomplete_photo_quality');
    expect(visit.validateAssessmentJson({ json: answer({ photo_quality: [{ photo: 1, quality: 'adequate' }, { photo: 1, quality: 'poor' }] }) }, 2)).toBe('incomplete_photo_quality');
    expect(visit.validateAssessmentJson({ json: answer({ photo_quality: [{ photo: 2, quality: 'limited' }, { photo: 1, quality: 'poor' }] }) }, 2)).toBeNull();
  });

test.each([
  [{ photo: 1, quality: 'poor' }, { photo: 1, quality: 'adequate' }, { photo: 2, quality: 'adequate' }],
  [{ photo: 1, quality: 'adequate' }, { photo: 2, quality: 'adequate' }, { photo: 7, quality: 'adequate' }],
])('rejects duplicate or extra ratings instead of letting a later entry replace poor evidence: %j', (...photo_quality) => {
  expect(visit.validateAssessmentJson({ json: answer({ photo_quality }) }, 2)).toBe('incomplete_photo_quality');
});

test.each([false, undefined, 'true'])('an indeterminate clean-lawn finding does not assert health: %s', (can_determine) => {
  const result = visit.normalizeAssessment(answer({ findings: [finding({ name: 'No major visible stress', photo_refs: [], can_determine })] }), 2);
  expect(result.findings[0]).toMatchObject({ can_determine: false, confidence: 'unknown', label: 'general lawn stress' });
});

test('a clean-lawn finding still needs a usable photo even when it has no numbered references', () => {
  const result = visit.normalizeAssessment(answer({ findings: [finding({ name: 'No major visible stress', photo_refs: [] })], photo_quality: [{ photo: 1, quality: 'poor' }, { photo: 2, quality: 'poor' }] }), 2);
  expect(result.findings[0]).toMatchObject({ can_determine: false, confidence: 'unknown', label: 'general lawn stress' });
});

test('a determinable finding that cites no photo of this visit is undeterminable; the clean-lawn finding is exempt', () => {
    const json = answer({ findings: [
      finding({ name: 'Chinch bug damage', confidence: 'high', photo_refs: [] }),
      finding({ finding_id: 'F2', name: 'Gray leaf spot', confidence: 'high', photo_refs: [7, 0, -1] }),
      finding({ finding_id: 'F3', name: 'No major visible stress', confidence: 'moderate', photo_refs: [] }),
      finding({ finding_id: 'F4', name: 'Dollar spot', confidence: 'high', photo_refs: [1] }),
      // Photo 2 is rated poor in this answer: a finding resting on it alone is unsupported; one usable photo among the refs is enough.
      finding({ finding_id: 'F5', name: 'Brown patch', confidence: 'high', photo_refs: [2] }),
      finding({ finding_id: 'F6', name: 'Gray leaf spot', confidence: 'high', photo_refs: [2, 1] }),
    ] });
    const [none, outOfRange, clean, cited, poorOnly, mixed] = visit.normalizeAssessment(json, 2, [null, null]).findings;
    expect(none).toMatchObject({ can_determine: false, confidence: 'unknown', label: 'general lawn stress', cannot_determine_reason: 'no photo of this visit cited', photo_refs: [] });
    expect(outOfRange).toMatchObject({ can_determine: false, confidence: 'unknown', photo_refs: [] });
    expect(clean).toMatchObject({ can_determine: true, confidence: 'moderate', label: 'no major visible stress' });
    expect(cited).toMatchObject({ can_determine: true, confidence: 'high', label: 'dollar spot', photo_refs: [1] });
    expect(poorOnly).toMatchObject({ can_determine: false, confidence: 'unknown', label: 'general lawn stress', cannot_determine_reason: 'every cited photo rated poor', photo_refs: [2] });
    expect(mixed).toMatchObject({ can_determine: true, confidence: 'high', photo_refs: [1, 2] });
    // The model's own reason wins when it gave one.
    const own = visit.normalizeAssessment(answer({ findings: [finding({ photo_refs: [], can_determine: false, cannot_determine_reason: 'too far' })] }), 2).findings[0];
    expect(own.cannot_determine_reason).toBe('too far');
  });

test('a score is known only as the schema states it: determinable literally true and a finite number — never a coerced 0', () => {
    const scoresOf = (turf_density) => visit.normalizeAssessment(answer({ scores: { ...answer().scores, turf_density } }), 2).scores.turf_density;
    expect(scoresOf({ determinable: true, value: 72 })).toBe(72);
    expect(scoresOf({ determinable: true, value: 140 })).toBe(100); // clamped, not rejected
    for (const malformed of [{ determinable: true, value: null }, { determinable: 'false', value: 0 }, { determinable: true, value: '72' }, { determinable: true, value: NaN }, { determinable: 1, value: 50 }, { value: 50 }]) {
      expect(scoresOf(malformed)).toBeNull();
    }
  });

test('the photo-storage inputs: poor and unrated photos fail the customer gate; only rated usable photos can be the best photo', () => {
    const { qualityResults, resultByPhotoIndex } = visit.photoRowInputs({ photoQuality: [
      { photo: 1, quality: 'adequate', issue: '' }, { photo: 2, quality: 'poor', issue: 'blurred' }, { photo: 3, quality: 'limited', issue: 'glare' }, { photo: 4, quality: 'unrated', issue: 'not rated by the model' },
    ] });
    expect(qualityResults).toEqual([{ passed: true, issues: [] }, { passed: false, issues: ['blurred'] }, { passed: true, issues: ['glare'] }, { passed: false, issues: ['not rated by the model'] }]);
    expect(resultByPhotoIndex).toEqual({ 0: { qualityScore: 80 }, 1: { qualityScore: 20 }, 2: { qualityScore: 55 }, 3: { qualityScore: 0 } });
  });

test('a complete answer that rates every photo poor is all-poor — the legacy retake hold — one usable photo is not', () => {
    const poor = (n) => Array.from({ length: n }, (_, i) => ({ photo: i + 1, quality: 'poor', issue: 'blurred' }));
    const normalized = visit.normalizeAssessment(answer({ photo_quality: poor(2) }), 2);
    expect(normalized.status).toBe('complete');
    expect(visit.photoRowInputs(normalized).allPoor).toBe(true);
    expect(visit.photoRowInputs({ status: 'complete', photoQuality: poor(3) }).allPoor).toBe(true);
    expect(visit.photoRowInputs({ status: 'complete', photoQuality: [...poor(2), { photo: 3, quality: 'limited', issue: '' }] }).allPoor).toBe(false);
    expect(visit.photoRowInputs({ status: 'complete', photoQuality: [] }).allPoor).toBe(false);
    expect(visit.photoRowInputs({ status: 'unavailable', photoQuality: [{ photo: 1, quality: 'unrated', issue: 'not rated by the model' }] }).allPoor).toBe(false);
  });

test('the composite the route reads carries the grass read and the signal levels', () => {
    const composite = visit.compositeFor({ grassType: 'zoysia', scores: { turf_density: 70, weed_coverage: 10, color_health: 7 }, severities: sev({ fungal_activity: 'minor', overwatering_signal: 'no' }), observations: 'o' });
    expect(composite).toMatchObject({ grass_type: 'zoysia', turf_density: 70, fungal_activity: 'minor', overwatering_signal: false, insect_damage: null });
    expect(visit.compositeFor(null)).toEqual({ grass_type: null });
  });

test('only can_determine === true keeps the confidence: an omitted key or a non-boolean reads as undeterminable', () => {
    const named = (extra) => visit.normalizeAssessment(answer({ findings: [finding({ name: 'Chinch bug damage', confidence: 'high', photo_refs: [1], ...extra })] }), 2).findings[0];
    expect(named({ can_determine: true })).toMatchObject({ can_determine: true, confidence: 'high', label: 'chinch bug activity' });
    const omitted = { ...finding({ name: 'Chinch bug damage', confidence: 'high', photo_refs: [1] }) };
    delete omitted.can_determine;
    expect(visit.normalizeAssessment(answer({ findings: [omitted] }), 2).findings[0]).toMatchObject({ can_determine: false, confidence: 'unknown', label: 'general lawn stress', cannot_determine_reason: 'determinability not stated' });
    expect(named({ can_determine: 'false' })).toMatchObject({ can_determine: false, confidence: 'unknown', cannot_determine_reason: 'determinability not stated' });
    expect(named({ can_determine: 'true' })).toMatchObject({ can_determine: false, confidence: 'unknown' });
    expect(named({ can_determine: 1 })).toMatchObject({ can_determine: false, confidence: 'unknown' });
    // A stated false keeps the model's own reason.
    expect(named({ can_determine: false, cannot_determine_reason: 'no blade close-up' })).toMatchObject({ can_determine: false, confidence: 'unknown', cannot_determine_reason: 'no blade close-up' });
    expect(named({ can_determine: false, cannot_determine_reason: '' })).toMatchObject({ can_determine: false, cannot_determine_reason: '' });
  });

test('unknown confidence cannot turn a signal into a known severity', () => {
  const result = visit.normalizeAssessment(answer({ severities: { ...answer().severities,
    fungal_activity: sig('severe', 'unknown', 'maybe'), thatch_visibility: sig('high', 'bogus', ''),
  } }), 2);
  expect(result.severities.fungal_activity).toEqual({ level: 'unknown', evidence: 'maybe', confidence: 'unknown' });
  expect(result.severities.thatch_visibility.level).toBe('unknown');
  expect(result.severities.drought_stress).toMatchObject({ level: 'moderate', confidence: 'moderate' });
});

test('an unavailable answer has only unknown scores and unrated photos', () => {
  const result = visit.emptyAnalysis(2);
  expect(result.findings).toEqual([]);
  expect(result.severities).toBeNull();
  expect(result.scores).toEqual({ turf_density: null, weed_coverage: null, color_health: null });
  expect(result.observations).toBe('Visual analysis unavailable');
  expect(result.photoQuality.map((q) => q.quality)).toEqual(['unrated', 'unrated']);
  expect(visit.photoRowInputs(result).qualityResults.map((q) => q.passed)).toEqual([false, false]);
});
