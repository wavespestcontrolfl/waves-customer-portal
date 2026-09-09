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
      // The run's photo ids stay aligned with the prompt positions its findings cite: a failed insert leaves a null gap.
      expect(assess).toMatch(/const photoRowsByIndex = photos\.map\(\(\) => null\);/);
      expect(assess).toMatch(/photoRecords\.push\(photoRecord\);\s*photoRowsByIndex\[i\] = photoRecord;/);
      expect(assess).toMatch(/visitAssessment\.attachRunPhotos\(visitRun\.id, photoRowsByIndex\.map\(\(row\) => row\?\.id \|\| null\), db\)/);
      expect(assess).not.toMatch(/attachRunPhotos\(visitRun\.id, photoRecords/);
      // Perception never sees the planned products under the gate.
      expect(assess).toMatch(/const track = visitAssessmentEnabled \? null : grassCtx\.trackKey;/);
      // The provider-miss early return is legacy-only: an unavailable run still stores the row.
      expect(assess).toMatch(/if \(!visitAssessmentEnabled && !validResults\.length\)/);
      // An answer that rates every photo poor takes the same retake hold as the legacy quality gate — before any row is written.
      expect(assess).toMatch(/\(\{ qualityResults, resultByPhotoIndex, allPoor \} = visitAssessment\.photoRowInputs\(visitAnalysis\)\);\s*(?:\/\/[^\n]*\n\s*)*if \(allPoor\) return allPhotosFailed\(qualityResults\);/);
      expect(assess.indexOf('if (allPoor) return allPhotosFailed(')).toBeLessThan(assess.indexOf('visitAssessment.recordRun('));
      expect(assess.match(/All photos failed quality check/g)).toHaveLength(1);
      // The run keeps the seasonally adjusted scores the technician was shown; a gated row is inserted without the legacy baseline flag.
      expect(assess).toMatch(/visitAssessment\.recordRun\(\{ assessment: rows\[0\], analysis: visitAnalysis, adjustedScores \}, trx\)/);
      expect(assess).toMatch(/is_baseline: propertyHistoryEnabled \|\| visitAssessmentEnabled \? false : isBaseline,/);
      // The legacy baseline count ignores a pending run-backed row, so a legacy replacement after the kill switch still becomes the baseline.
      // …through the module's count, which falls back to the plain count on a database without the run table (the dark gate stays a usable kill switch mid-rollout).
      expect(assess).toMatch(/isBaseline = \(await visitAssessment\.priorAssessmentCount\(customerId, db\)\) === 0;/);
      expect(assess).not.toMatch(/withoutPendingRuns\(/);
    });

    test('/confirm validates the review before any write, preserves NULL scores for a run-backed row, records a review only when one was sent, and confirms only a complete row', () => {
      expect(confirm.indexOf('visitAssessment.validateReview(')).toBeLessThan(confirm.indexOf('installConfirmedBaseline('));
      // One branch: the run-backed row's scores, overall and confirmed verdict come from the module; the legacy block is untouched.
      // The derivation is a function of (row, run): it runs once from the pre-lock snapshot and AGAIN from the
      // locked row inside the write transaction, so two partial confirms that raced merge instead of the later
      // one overwriting the earlier one's saved scores with its stale snapshot.
      expect(confirm).toMatch(/const deriveConfirmUpdate = \(assessmentRow, runRow\) => \{/);
      expect(confirm).toMatch(/if \(reviewedRun\) \{\s*\(\{ finalScores, overallScore, confirmed, missing: missingScores, calibrationEligible, aiScores: runAiScores \} = visitAssessment\.confirmScores\(assessmentRow, runRow, adjustedScores, \{ scoreValue, calculateOverallScore \}\)\);/);
      const derive = confirm.slice(confirm.indexOf('const deriveConfirmUpdate = '), confirm.indexOf('let { finalScores, confirmed, missingScores, calibrationEligible, runAiScores, updateData } = deriveConfirmUpdate(assessment, visitRun);'));
      expect(derive).toMatch(/return \{ finalScores, confirmed, missingScores, calibrationEligible, runAiScores, updateData \};\s*\};\s*$/);
      // Inside the derivation every read is of the row it was handed, never the pre-lock snapshot.
      expect(derive).not.toMatch(/\bassessment\./);
      expect(derive).not.toMatch(/\bvisitRun\b/);
      // A run-backed row calibrates against the run's own scores, a legacy row against its stored JSON.
      expect(confirm).toMatch(/const calibrationBaseline = runAiScores \|\| assessment\.adjusted_scores \|\| assessment\.composite_scores;/);
      expect(confirm).toMatch(/parseJsonObject\(assessmentRow\.adjusted_scores\)/);
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
      const write = confirm.slice(confirm.indexOf('const writeConfirm = async (trx) => {'), confirm.indexOf('const { updated, reviewedVisitRun, alreadyConfirmed } ='));
      // A run-backed row: the customer's baseline advisory lock FIRST (the order every other baseline writer
      // uses — linkAssessmentServiceRecord and installConfirmedBaseline take the advisory lock, then the row —
      // so a completion back-link racing a confirm waits instead of deadlocking), then the row claim; a confirm
      // arriving after the completing one rewrites nothing and runs no pipeline. The update is re-derived from
      // the LOCKED row and its run, never from the pre-lock snapshot.
      expect(write).toMatch(/^const writeConfirm = async \(trx\) => \{\s*if \(reviewedRun\) \{\s*await lawnAssessment\.lockCustomerBaseline\(assessment\.customer_id, trx\);\s*const locked = await visitAssessment\.claimConfirm\(assessmentId, trx\);\s*if \(!locked\) return \{ alreadyConfirmed: true \};\s*currentRun = await visitAssessment\.loadRun\(assessmentId, trx\);\s*\(\{ finalScores, confirmed, missingScores, calibrationEligible, runAiScores, updateData \} = deriveConfirmUpdate\(locked, currentRun\)\);\s*\}\s*Object\.assign\(updateData, await visitAssessment\.legacyBaselineFields\(\{ assessment, run: currentRun, confirmed, propertyHistoryEnabled \}, trx\)\);\s*const installBaseline = propertyHistoryEnabled && confirmed;/);
      expect(write).toMatch(/installBaseline\s*\? await lawnAssessment\.installConfirmedBaseline\(\{ assessmentId, updateData \}, \{ knex: trx \}\)\s*: \(await trx\('lawn_assessments'\)\.where\(\{ id: assessmentId \}\)\.update\(updateData\)\.returning\('\*'\)\)\[0\];/);
      expect(write).toMatch(/const run = reviewedRun && visitReview\.provided\s*\? await visitAssessment\.reviewRun\(\{ run: currentRun, review: visitReview, technicianId: req\.technicianId \}, trx\)\s*: null;/);
      expect(write.indexOf('lockCustomerBaseline(')).toBeLessThan(write.indexOf('claimConfirm('));
      expect(write.indexOf('claimConfirm(')).toBeLessThan(write.indexOf('legacyBaselineFields('));
      expect(write.indexOf('legacyBaselineFields(')).toBeLessThan(write.indexOf('installConfirmedBaseline('));
      // The technician's protocol field checks write INSIDE the confirm transaction (same trx), after the row
      // and the review: a failed write rolls the confirm back, so a retry redoes it instead of taking the
      // already-confirmed return past a write that never happened.
      expect(write).toMatch(/if \(protocolFieldChecksProvided\) await persistProtocolFieldChecks\(\{ assessment: row, checks: protocolFieldChecks, trx \}\);\s*return \{ updated: row, reviewedVisitRun: run \};/);
      // The observation column follows the review, in the same transaction, right after the review is stored:
      // a rejected or renamed finding withdraws the cause the prose named; technician text (null) is left alone.
      expect(write).toMatch(/const observations = run \? visitAssessment\.reviewedObservations\(\{ assessment: row, run \}\) : null;\s*if \(observations != null && observations !== row\.observations\) \{\s*await trx\('lawn_assessments'\)\.where\(\{ id: assessmentId \}\)\.update\(\{ observations, updated_at: new Date\(\) \}\);\s*row\.observations = observations;\s*\}/);
      expect(write.indexOf('reviewRun(')).toBeLessThan(write.indexOf('reviewedObservations('));
      expect(write.indexOf('reviewedObservations(')).toBeLessThan(write.indexOf('persistProtocolFieldChecks('));
      expect(confirm.match(/persistProtocolFieldChecks\(/g)).toHaveLength(1);
      expect(write.indexOf('reviewRun(')).toBeLessThan(write.indexOf('persistProtocolFieldChecks('));
      // The already-confirmed response reads the row AND the run as the completing confirm left them — never the
      // run this request loaded before it waited on the lock.
      expect(confirm).toMatch(/const \{ updated, reviewedVisitRun, alreadyConfirmed \} = reviewedRun \? await db\.transaction\(writeConfirm\) : await writeConfirm\(db\);\s*if \(alreadyConfirmed\) \{[\s\S]{0,400}const \[current, confirmedRun\] = await Promise\.all\(\[db\('lawn_assessments'\)\.where\(\{ id: assessmentId \}\)\.first\(\), visitAssessment\.loadRun\(assessmentId, db\)\]\);\s*return res\.json\(\{ success: true, confirmed: true, alreadyConfirmed: true, assessment: current, visitAssessment: visitAssessment\.responseForRun\(confirmedRun \|\| visitRun\) \}\);/);
      expect(confirm).toMatch(/if \(protocolFieldChecksProvided\) Object\.assign\(updated, protocolFieldChecks, \{ protocol_field_checks: protocolFieldChecks \}\);/);
      // The response reads the run the transaction reviewed (or loaded under the lock), not the pre-lock snapshot.
      expect(confirm).toMatch(/visitAssessment\.responseForRun\(reviewedVisitRun \|\| currentRun\)/);
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
