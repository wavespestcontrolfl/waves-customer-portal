const fs = require('fs');
const path = require('path');
const lawnHealthRouter = require('../routes/lawn-health');
const adminLawnAssessmentRouter = require('../routes/admin-lawn-assessment');

describe('lawn assessment route contracts', () => {
  test('normalizes LawnIntel benchmark arrays to the customer portal contract', () => {
    const result = lawnHealthRouter._test.normalizeNeighborBenchmark([
      {
        segment: 'Bradenton',
        segmentType: 'city',
        yourScore: 82,
        avgScore: 74.4,
        percentile: 'top 25%',
        customerCount: 12,
        avgImprovement: 6.2,
      },
    ]);

    expect(result).toMatchObject({
      customerScore: 82,
      neighborhoodAvg: 74.4,
      percentile: 'top 25%',
      customerCount: 12,
      avgImprovement: 6.2,
      segmentName: 'Bradenton',
      segmentType: 'city',
    });
  });

  test('preserves analytics benchmark objects that already match the portal contract', () => {
    const result = lawnHealthRouter._test.normalizeNeighborBenchmark({
      customerScore: 78,
      neighborhoodAvg: 71,
      percentile: 'top 50%',
      customerCount: 8,
      segmentName: '34209 St. Augustine',
    });

    expect(result).toMatchObject({
      customerScore: 78,
      neighborhoodAvg: 71,
      percentile: 'top 50%',
      customerCount: 8,
      segmentName: '34209 St. Augustine',
    });
  });

  test('drops incomplete benchmark payloads instead of sending unusable portal data', () => {
    expect(lawnHealthRouter._test.normalizeNeighborBenchmark([])).toBeNull();
    expect(lawnHealthRouter._test.normalizeNeighborBenchmark({ percentile: 'top 25%' })).toBeNull();
    expect(lawnHealthRouter._test.normalizeNeighborBenchmark(null)).toBeNull();
  });

  test('customer photo lookups require confirmed assessments', () => {
    expect(lawnHealthRouter._test.photoAssessmentLookupCriteria('cust-1', 'assessment-1')).toEqual({
      id: 'assessment-1',
      customer_id: 'cust-1',
      confirmed_by_tech: true,
    });
  });

  test('accepts the follow_up_needed stress flag', () => {
    const { errors, normalized } = adminLawnAssessmentRouter._test.normalizeStressFlags({ follow_up_needed: true });
    expect(errors).toEqual([]);
    expect(normalized).toEqual({ follow_up_needed: true });
  });

  test('still rejects unrecognized stress flags', () => {
    const { errors } = adminLawnAssessmentRouter._test.normalizeStressFlags({ not_a_real_flag: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  test('failed-quality photos stay auditable but are hidden from customer surfaces', () => {
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck({ passed: false })).toBe(false);
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck({ passed: true })).toBe(true);
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck({})).toBe(true);
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck(null)).toBe(true);
  });

  test('service assessment lookup prefers the latest captured row', () => {
    const calls = [];
    const query = {
      orderBy: jest.fn((column, direction) => {
        calls.push([column, direction]);
        return query;
      }),
    };

    expect(adminLawnAssessmentRouter._test.applyServiceAssessmentOrder(query)).toBe(query);
    expect(calls).toEqual([
      ['created_at', 'desc'],
      ['updated_at', 'desc'],
    ]);
  });

  // GATE_LAWN_VISIT_ASSESSMENT (services/lawn-visit-assessment.js): the gate is
  // read once per handler and every legacy statement it bypasses is still in
  // place — gate off is the byte-identical per-photo quality gate + parallel
  // scorer, gate on is the one call, NULL-preserving scores and the run row.
  describe('visit assessment gate wiring', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-lawn-assessment.js'), 'utf8');
    const assess = source.slice(source.indexOf("router.post('/assess'"), source.indexOf("router.post('/confirm'"));
    const confirm = source.slice(source.indexOf("router.post('/confirm'"), source.indexOf("router.get('/service/:serviceId'"));

    test('/assess reads the gate once; /confirm never reads it — the run row decides', () => {
      expect(assess.match(/gateEnvValue\('GATE_LAWN_VISIT_ASSESSMENT'\)/g)).toHaveLength(1);
      expect(confirm).not.toMatch(/GATE_LAWN_VISIT_ASSESSMENT/);
      expect(confirm).toMatch(/const visitRun = await visitAssessment\.loadRun\(assessmentId, db\);/);
    });

    test('/assess keeps the legacy scorer and adds the one call behind the gate', () => {
      expect(assess).toMatch(/visitAssessmentEnabled\s*\?\s*visitAssessment\.validateVisitPhotos\(photos\)/);
      expect(assess).toMatch(/LawnIntel\.assessPhotoQuality\(/);
      expect(assess).toMatch(/lawnAssessment\.analyzePhoto\(/);
      expect(assess).toMatch(/mergePhotoComposites\(validResults\)/);
      expect(assess).toMatch(/lawnAssessment\.mapToDisplayScores\(mergedComposite\)/);
      expect(assess).toMatch(/visitAssessment\.analyzeVisit\(\{ photos, photoZones: visitPhotos\.zones, visionContext \}\)/);
      expect(assess).toMatch(/visitAssessment\.deriveLegacyScores\(visitAnalysis\)/);
      expect(assess).toMatch(/visitAssessment\.adjustAvailableScores\(displayScores, seasonAdjust\)/);
      // The run is written in the assessment's transaction — both or neither.
      expect(assess).toMatch(/db\.transaction\(async \(trx\) => \{[\s\S]{0,400}visitAssessment\.recordRun\(\{ assessment: rows\[0\], analysis: visitAnalysis \}, trx\)/);
      expect(assess).toMatch(/visitAssessment\.attachRunPhotos\(/);
      // Perception never sees the planned products under the gate.
      expect(assess).toMatch(/const track = visitAssessmentEnabled \? null : grassCtx\.trackKey;/);
      // The provider-miss early return is legacy-only: an unavailable run still stores the row.
      expect(assess).toMatch(/if \(!visitAssessmentEnabled && !validResults\.length\)/);
    });

    test('/confirm validates the review before any write, preserves NULL scores for a run-backed row, records a review only when one was sent, and holds customer output on an unavailable run', () => {
      expect(confirm.indexOf('visitAssessment.validateReview(')).toBeLessThan(confirm.indexOf('installConfirmedBaseline('));
      expect(confirm).toMatch(/reviewedRun \? visitAssessment\.resolveConfirmScores\(assessment, adjustedScores, scoreValue\)/);
      expect(confirm).toMatch(/reviewedRun && !visitAssessment\.scoresComplete\(finalScores\) \? null : calculateOverallScore\(finalScores\)/);
      expect(confirm).toMatch(/if \(reviewedRun && visitReview\.provided\)/);
      expect(confirm).toMatch(/if \(adjustedScores && calibrationEligible\)/);
      expect(confirm).toMatch(/const customerOutputEligible = calibrationEligible \|\| visitAssessment\.scoresComplete\(finalScores\);/);
      for (const call of ['KnowledgeBridge.generateAssessmentRecommendations(assessmentId)', 'LawnIntel.emitHealthSignal(updated.customer_id)', 'LawnIntel.generateServiceReport(assessmentId)']) {
        expect(confirm).toContain(`if (customerOutputEligible) await ${call}`);
      }
      expect(confirm).toMatch(/if \(!updated\.service_id && customerOutputEligible\) \{/);
      expect(confirm).toMatch(/visitAssessment\.reviewRun\(/);
    });
  });
});
