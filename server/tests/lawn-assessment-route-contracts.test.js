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
      // One gate branch derives composite, display, adjusted and overall scores together.
      expect(assess).toMatch(/visitAssessment\.scoreVisit\(visitAnalysis, \{ seasonAdjust, calculateOverallScore \}\)/);
      expect(assess).toMatch(/\? \(i\) => visitAssessment\.photoFieldsFor\(visitPhotos\.zones\[i\]\)/);
      // The run is written in the assessment's transaction — both or neither.
      expect(assess).toMatch(/db\.transaction\(async \(trx\) => \{[\s\S]{0,400}visitAssessment\.recordRun\(\{ assessment: rows\[0\], analysis: visitAnalysis, adjustedScores \}, trx\)/);
      expect(assess).toMatch(/visitAssessment\.attachRunPhotos\(/);
      // Perception never sees the planned products under the gate.
      expect(assess).toMatch(/const track = visitAssessmentEnabled \? null : grassCtx\.trackKey;/);
      // The provider-miss early return is legacy-only: an unavailable run still stores the row.
      expect(assess).toMatch(/if \(!visitAssessmentEnabled && !validResults\.length\)/);
      // Irrigation context comes from the one loader the eval exporter replays (lawn-grass-context.loadIrrigationContext).
      expect(assess).toMatch(/const irrigation = await loadIrrigationContext\(customerId, grassCtx, db\);/);
      // The prior summary too: one loader carries both gate branches, so the exporter replays the branch the route took.
      expect(assess).toMatch(/const priorSummary = await loadPriorSummary\(\{ customerId, serviceId, scheduledService, visitDate: visitServiceDateStr, propertyHistoryEnabled \}, db\);/);
      expect(assess).not.toMatch(/historyBeforeVisit\(/);
      expect(assess).not.toMatch(/whereNotNull\('la\.ai_summary'\)/);
      expect(assess).not.toMatch(/first\('irrigation_type', 'irrigation_inches_per_week'\)/);
      // An answer that rates every photo poor takes the same retake hold as the legacy quality gate — before any row is written.
      expect(assess).toMatch(/\(\{ qualityResults, resultByPhotoIndex, allPoor \} = visitAssessment\.photoRowInputs\(visitAnalysis\)\);\s*(?:\/\/[^\n]*\n\s*)*if \(allPoor\) return allPhotosFailed\(qualityResults\);/);
      expect(assess.indexOf('if (allPoor) return allPhotosFailed(')).toBeLessThan(assess.indexOf('visitAssessment.recordRun('));
      expect(assess.match(/All photos failed quality check/g)).toHaveLength(1);
      // The run keeps the seasonally adjusted scores the technician was shown; a gated row is inserted without the legacy baseline flag.
      expect(assess).toMatch(/visitAssessment\.recordRun\(\{ assessment: rows\[0\], analysis: visitAnalysis, adjustedScores \}, trx\)/);
      expect(assess).toMatch(/is_baseline: propertyHistoryEnabled \|\| visitAssessmentEnabled \? false : isBaseline,/);
      // The legacy baseline count ignores a pending run-backed row, so a legacy replacement after the kill switch still becomes the baseline.
      expect(assess).toMatch(/const existingCount = await visitAssessment\.withoutPendingRuns\(db\('lawn_assessments'\)\.where\(\{ customer_id: customerId \}\)\)/);
    });

    test('/confirm validates the review before any write, preserves NULL scores for a run-backed row, records a review only when one was sent, and confirms only a complete row', () => {
      expect(confirm.indexOf('visitAssessment.validateReview(')).toBeLessThan(confirm.indexOf('installConfirmedBaseline('));
      // One branch: the run-backed row's scores, overall and confirmed verdict come from the module; the legacy block is untouched.
      expect(confirm).toMatch(/if \(reviewedRun\) \{\s*\(\{ finalScores, overallScore, confirmed, missing: missingScores, calibrationEligible, aiScores: runAiScores \} = visitAssessment\.confirmScores\(assessment, visitRun, adjustedScores, \{ scoreValue, calculateOverallScore \}\)\);/);
      // A run-backed row calibrates against the run's own scores, a legacy row against its stored JSON.
      expect(confirm).toMatch(/const calibrationBaseline = runAiScores \|\| assessment\.adjusted_scores \|\| assessment\.composite_scores;/);
      expect(confirm).toMatch(/overall_score: overallScore,/);
      // confirmed_by_tech / confirmed_at are stamped only on a confirmed row; a pending row never becomes the property baseline.
      expect(confirm).toMatch(/\.\.\.\(confirmed \? \{ confirmed_by_tech: true, confirmed_at: new Date\(\) \} : \{\}\),\s*updated_at: new Date\(\),/);
      expect(confirm.match(/confirmed_by_tech: true/g)).toHaveLength(1);
      expect(confirm.match(/installConfirmedBaseline\(/g)).toHaveLength(1);
      expect(confirm).toMatch(/const installBaseline = propertyHistoryEnabled && confirmed;/);
      // One write path: the legacy baseline check runs in the SAME transaction as the update (under the
      // customer's baseline lock — legacyBaselineFields takes it), then the review when one was sent, so
      // a lost review can never ride a successful confirm and two first confirms cannot both become the
      // baseline. A run-backed row always writes in a transaction; a pre-gate row writes as before.
      const write = confirm.slice(confirm.indexOf('const writeConfirm = async (trx) => {'), confirm.indexOf('const { updated, reviewedVisitRun } ='));
      expect(write).toMatch(/^const writeConfirm = async \(trx\) => \{\s*Object\.assign\(updateData, await visitAssessment\.legacyBaselineFields\(\{ assessment, run: visitRun, confirmed, propertyHistoryEnabled \}, trx\)\);/);
      expect(write).toMatch(/installBaseline\s*\? await lawnAssessment\.installConfirmedBaseline\(\{ assessmentId, updateData \}, \{ knex: trx \}\)\s*: \(await trx\('lawn_assessments'\)\.where\(\{ id: assessmentId \}\)\.update\(updateData\)\.returning\('\*'\)\)\[0\];/);
      expect(write).toMatch(/const run = reviewedRun && visitReview\.provided\s*\? await visitAssessment\.reviewRun\(\{ run: visitRun, review: visitReview, technicianId: req\.technicianId \}, trx\)\s*: null;/);
      expect(write.indexOf('legacyBaselineFields(')).toBeLessThan(write.indexOf('installConfirmedBaseline('));
      expect(confirm).toMatch(/const \{ updated, reviewedVisitRun \} = reviewedRun \? await db\.transaction\(writeConfirm\) : await writeConfirm\(db\);/);
      expect(confirm).not.toMatch(/reviewRun\([\s\S]{0,120}, db\)/);
      expect(confirm).not.toMatch(/legacyBaselineFields\([\s\S]{0,120}, db\)/);
      // Calibration compares the run's scores with the RESOLVED confirmation — every score the row confirmed
      // with, not this request's payload (a follow-up confirm may carry only the last missing field).
      expect(confirm).toMatch(/LawnIntel\.recordTechCalibration\(assessmentId, aiScores, finalScores\)/);
      expect(confirm).not.toMatch(/recordTechCalibration\(assessmentId, aiScores, adjustedScores\)/);
      // A pending row returns right after the write with the missing scores — before the wiki link and the intelligence pipeline.
      const pending = confirm.indexOf('if (!confirmed) {');
      expect(pending).toBeGreaterThan(confirm.indexOf('persistProtocolFieldChecks('));
      expect(pending).toBeLessThan(confirm.indexOf('wiki.linkTreatmentOutcome('));
      expect(pending).toBeLessThan(confirm.indexOf('setImmediate('));
      expect(confirm.slice(pending, pending + 200)).toMatch(/success: true, confirmed: false, missingScores, assessment: updated, \.\.\.runPayload/);
      expect(confirm).toMatch(/if \(adjustedScores && calibrationEligible\)/);
      // Every customer-facing step runs once, inside the pipeline only a confirmed row reaches.
      const pipeline = confirm.slice(confirm.indexOf('setImmediate('), confirm.indexOf('// 7. Track assessment completion'));
      for (const call of ['KnowledgeBridge.generateAssessmentRecommendations(assessmentId)', 'LawnIntel.emitHealthSignal(updated.customer_id)', 'LawnIntel.sendAssessmentNotification(assessmentId)', 'LawnIntel.generateServiceReport(assessmentId)']) {
        expect(pipeline).toContain(call);
        expect(confirm.split(call)).toHaveLength(2);
      }
    });
  });
});
