const {
  buildDiagnosticReportContract,
  buildWateringPlan,
  fertilizerBlackoutConflicts,
  classifyReleaseMode,
  applyAutoReleaseRepair,
  buildMinimalSafeReport,
  scrubCustomerText,
  safeConditionLabel,
  safeCustomerSummary,
  residualDefinitiveClaim,
  lowerConfidence,
  MINIMAL_SAFE_SUMMARY,
} = require('../services/lawn-diagnostic-report');

describe('lawn diagnostic report contract', () => {
  test('requires human review for limited photos and missing product-label irrigation', () => {
    const report = buildDiagnosticReportContract({
      photos: [{ quality: 'limited', limitations: ['No close-up blade image', 'No view of patch margin'] }],
      findings: [{
        finding_id: 'F1',
        name: 'Chinch bug pressure',
        confidence: 'moderate',
        severity: 'moderate',
        observed_evidence: ['sunny driveway edge browning'],
        negative_evidence: ['No visible insect activity in photos'],
      }],
      products: [{
        product_id: 'P1',
        product_name: 'Talstar P',
        category: 'insecticide',
        addresses_findings: ['F1'],
      }],
      compliance: {
        irrigation_compliance: {
          max_days_per_week: 2,
          assigned_days: ['Wednesday', 'Saturday'],
          allowed_time_windows: ['before 10am', 'after 4pm'],
        },
      },
    });

    expect(report.input_assessment).toMatchObject({
      photo_quality: 'limited',
      human_review_required: false,
    });
    expect(classifyReleaseMode(report)).toBe('conservative');
    expect(report.input_assessment.photo_limitations).toEqual([
      'No close-up blade image',
      'No view of patch margin',
    ]);
    expect(report.input_assessment.missing_inputs).toContain('product post-application irrigation directive missing for P1');
    expect(report.internal_quality_flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'product_label_review_required', severity: 'high' }),
      expect.objectContaining({ type: 'photo_confirmation_honesty' }),
    ]));
    expect(report.customer_summary).toContain('most consistent with chinch pressure');
    expect(report.customer_summary).toContain('can look very similar to drought stress');
    expect(report.customer_summary).not.toMatch(/\bconfirmed\b/i);
  });

  test('uses DB-authoritative post-application hold before assigned irrigation schedule', () => {
    const watering = buildWateringPlan({
      products: [{
        product_id: 'P1',
        product_name: 'Foliar herbicide',
        product_label_constraints: {
          source: 'product_db',
          source_version: '2026-06-14',
          post_app_irrigation: 'hold 48h',
          rainfast_hours: 4,
          confidence: 'db_authoritative',
          requires_label_review: false,
        },
      }],
      compliance: {
        irrigation_compliance: {
          max_days_per_week: 2,
          assigned_days: ['Wednesday', 'Saturday'],
          allowed_time_windows: ['before 10am', 'after 4pm'],
        },
      },
    });

    expect(watering.post_application).toMatchObject({
      directive: 'Hold irrigation for 48 hours after application unless a reviewed label or technician correction says otherwise.',
      confidence: 'db_authoritative',
      requires_label_review: false,
    });
    expect(watering.customer_sequence).toBe('After the 48-hour hold, water only in the assigned Wednesday and Saturday windows, and skip a cycle when rainfall covers the lawn.');
    expect(watering.ongoing_irrigation).toMatchObject({
      max_days_per_week: 2,
      assigned_days: ['Wednesday', 'Saturday'],
      restriction_is_ceiling_not_target: true,
    });
  });

  test('inferred product-label holds do not drive exact customer watering instructions', () => {
    const watering = buildWateringPlan({
      products: [{
        product_id: 'P1',
        product_name: 'Request-supplied product',
        product_label_constraints: {
          source: 'request',
          post_app_irrigation: 'hold 48h',
          confidence: 'inferred',
          requires_label_review: true,
        },
      }],
      compliance: {
        irrigation_compliance: {
          assigned_days: ['Wednesday', 'Saturday'],
          allowed_time_windows: ['before 10am', 'after 4pm'],
        },
      },
    });

    expect(watering.post_application).toMatchObject({
      directive: 'Use only general low-risk watering guidance until product label constraints are reviewed.',
      confidence: 'needs_label_review',
      requires_label_review: true,
    });
    expect(watering.customer_sequence).toBe('Return to normal irrigation only after product-specific label directions are reviewed.');
    expect(watering.customer_sequence).not.toContain('48-hour hold');
  });

  test('one missing product label suppresses exact watering instructions for all products', () => {
    const watering = buildWateringPlan({
      products: [
        {
          product_id: 'P1',
          product_name: 'Reviewed foliar product',
          product_label_constraints: {
            source: 'product_db',
            post_app_irrigation: 'hold 48h',
            confidence: 'db_authoritative',
            requires_label_review: false,
          },
        },
        {
          product_id: 'P2',
          product_name: 'Unreviewed granular product',
        },
      ],
      compliance: {
        irrigation_compliance: {
          assigned_days: ['Wednesday', 'Saturday'],
        },
      },
    });

    expect(watering.post_application).toMatchObject({
      directive: 'Use only general low-risk watering guidance until product label constraints are reviewed.',
      confidence: 'needs_label_review',
      requires_label_review: true,
    });
    expect(watering.customer_sequence).toBe('Return to normal irrigation only after product-specific label directions are reviewed.');
    expect(watering.customer_sequence).not.toContain('48-hour hold');
  });

  test('db-authoritative water-in label is stated before the assigned schedule', () => {
    const watering = buildWateringPlan({
      products: [{
        product_id: 'P1',
        product_name: 'Reviewed water-in product',
        product_label_constraints: {
          source: 'product_db',
          post_app_irrigation: 'water in according to reviewed product label',
          confidence: 'db_authoritative',
          requires_label_review: false,
        },
      }],
      compliance: { irrigation_compliance: { assigned_days: ['Wednesday', 'Saturday'] } },
    });

    expect(watering.post_application.requires_label_review).toBe(false);
    expect(watering.customer_sequence).toMatch(/water in/i);
    expect(watering.customer_sequence).toContain('Wednesday and Saturday');
  });

  test('adequate photos with missing-view limitations auto-release conservative, never blocked', () => {
    const report = buildDiagnosticReportContract({
      photos: [{ quality: 'adequate', limitations: ['No close-up blade image'] }],
      findings: [{
        finding_id: 'F1',
        name: 'Thin turf density',
        confidence: 'moderate',
        severity: 'mild',
      }],
      products: [{
        product_id: 'P1',
        product_name: 'Reviewed product',
        product_label_constraints: {
          source: 'product_db',
          post_app_irrigation: 'hold 12h',
          confidence: 'db_authoritative',
          requires_label_review: false,
        },
      }],
      compliance: {
        irrigation_compliance: { assigned_days: ['Monday', 'Thursday'] },
      },
    });

    expect(report.input_assessment.photo_quality).toBe('adequate');
    expect(report.input_assessment.human_review_required).toBe(false);
    expect(report.input_assessment.human_review_reason).toBe('');
    expect(report.input_assessment.photo_limitations).toContain('No close-up blade image');
    expect(classifyReleaseMode(report)).toBe('conservative');
  });

  test('fertilizer blackout flags N/P products but not fungicide or allowed iron', () => {
    const conflicts = fertilizerBlackoutConflicts([
      {
        product_id: 'P1',
        product_name: 'Fungicide',
        category: 'fungicide',
      },
      {
        product_id: 'P2',
        product_name: '16-4-8 Fertilizer',
        category: 'fertilizer',
        analysis_n: 16,
        analysis_p: 4,
      },
      {
        product_id: 'P3',
        product_name: 'Iron micronutrient',
        category: 'iron',
        analysis_n: 0,
        analysis_p: 0,
      },
    ], {
      fertilizer_blackout: {
        active: true,
        applies_to: ['nitrogen', 'phosphorus'],
        allowed_exceptions: ['iron', 'micronutrients'],
      },
    });

    expect(conflicts).toEqual([
      expect.objectContaining({ product_id: 'P2' }),
    ]);
  });

  test('fertilizer blackout still flags N/P fertilizer that includes allowed iron', () => {
    const conflicts = fertilizerBlackoutConflicts([
      {
        product_id: 'P1',
        product_name: '16-4-8 Fertilizer with Iron',
        category: 'fertilizer',
        analysis_n: 16,
        analysis_p: 4,
      },
    ], {
      fertilizer_blackout: {
        active: true,
        applies_to: ['nitrogen', 'phosphorus'],
        allowed_exceptions: ['iron', 'micronutrients'],
      },
    });

    expect(conflicts).toEqual([
      expect.objectContaining({ product_id: 'P1' }),
    ]);
  });

  test('maps product IDs to finding IDs and structures untreated-condition flags', () => {
    const report = buildDiagnosticReportContract({
      photos: [{ quality: 'adequate' }],
      findings: [
        {
          finding_id: 'F1',
          name: 'Chinch bug pressure',
          confidence: 'moderate',
          severity: 'moderate',
          urgency: 'follow_up',
        },
        {
          finding_id: 'F2',
          name: 'Possible fungal margin',
          confidence: 'low',
          severity: 'moderate',
          urgency: 'follow_up',
          observed_evidence: ['orange-brown patch margin'],
          negative_evidence: ['No close-up lesions visible'],
        },
      ],
      products: [{
        product_id: 'P1',
        product_name: 'Insecticide',
        category: 'insecticide',
        addresses_findings: ['F1'],
        product_label_constraints: {
          source: 'product_db',
          post_app_irrigation: 'hold 24h',
          confidence: 'db_authoritative',
          requires_label_review: false,
        },
      }],
      compliance: {
        irrigation_compliance: { assigned_days: ['Tuesday', 'Saturday'] },
      },
    });

    expect(report.treatment_rationale[0]).toMatchObject({
      product_id: 'P1',
      addresses_findings: ['F1'],
    });
    expect(report.reconciliation_flags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'untreated_condition',
        severity: 'medium',
        finding_id: 'F2',
        customer_visible: true,
      }),
      expect.objectContaining({
        type: 'follow_up_needed',
        finding_id: 'F1',
      }),
    ]));
    expect(report.diagnosis.negative_evidence).toContain('No close-up lesions visible');
    expect(report.human_review_required).toBe(false);
    expect(classifyReleaseMode(report)).toBe('conservative');
  });

  test('flags preventive applications without implying a visible confirmed condition', () => {
    const report = buildDiagnosticReportContract({
      photos: [{ quality: 'adequate' }],
      findings: [{
        finding_id: 'F1',
        name: 'Drought geometry',
        confidence: 'moderate',
        severity: 'mild',
      }],
      products: [{
        product_id: 'P1',
        product_name: 'Preventive insect control',
        role: 'preventive',
        product_label_constraints: {
          source: 'product_db',
          post_app_irrigation: 'hold 12h',
          confidence: 'db_authoritative',
          requires_label_review: false,
        },
      }],
      compliance: {
        irrigation_compliance: { assigned_days: ['Monday', 'Thursday'] },
      },
    });

    expect(report.reconciliation_flags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'preventive_application',
        severity: 'low',
        customer_wording: 'Today also included preventive protection as part of the lawn program.',
      }),
    ]));
    expect(report.reconciliation_flags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'untreated_condition',
        finding_id: 'F1',
      }),
    ]));
    expect(report.customer_summary).toContain('We did not map a treatment to that finding today');
  });
});

describe('lawn diagnostic auto-release ladder', () => {
  function reportWith({ findings, products = [], photos = [{ quality: 'adequate' }], compliance = { irrigation_compliance: { assigned_days: ['Tuesday', 'Friday'] } } }) {
    return buildDiagnosticReportContract({ photos, findings, products, compliance });
  }

  test('confident, cleanly reconciled report classifies standard', () => {
    const report = reportWith({
      findings: [{ finding_id: 'F1', name: 'Visible weed pressure', confidence: 'high', severity: 'moderate', urgency: 'monitor', observed_evidence: ['broadleaf weeds across the front lawn'] }],
      products: [{
        product_id: 'P1',
        product_name: 'Reviewed herbicide',
        addresses_findings: ['F1'],
        product_label_constraints: { source: 'product_db', post_app_irrigation: 'hold 24h', confidence: 'db_authoritative', requires_label_review: false },
      }],
    });
    expect(classifyReleaseMode(report)).toBe('standard');
  });

  test('weak / low-confidence diagnosis classifies conservative', () => {
    const report = reportWith({
      findings: [{ finding_id: 'F1', name: 'Turf color stress', confidence: 'moderate', severity: 'mild', urgency: 'monitor' }],
      products: [{
        product_id: 'P1',
        product_name: 'Reviewed product',
        addresses_findings: ['F1'],
        product_label_constraints: { source: 'product_db', post_app_irrigation: 'hold 12h', confidence: 'db_authoritative', requires_label_review: false },
      }],
    });
    expect(classifyReleaseMode(report)).toBe('conservative');
  });

  test('sound diagnosis with non-authoritative label data classifies label_limited', () => {
    const report = reportWith({
      findings: [{ finding_id: 'F1', name: 'Visible weed pressure', confidence: 'high', severity: 'moderate', urgency: 'monitor', observed_evidence: ['broadleaf weeds'] }],
      products: [{ product_id: 'P1', product_name: 'Unreviewed product', addresses_findings: ['F1'] }],
    });
    expect(classifyReleaseMode(report)).toBe('label_limited');
  });

  test('poor photos classify minimal', () => {
    const report = reportWith({
      photos: [{ quality: 'poor' }],
      findings: [{ finding_id: 'F1', name: 'Turf color stress', confidence: 'low', severity: 'mild' }],
    });
    expect(classifyReleaseMode(report)).toBe('minimal');
  });

  test('no defensible finding classifies minimal', () => {
    const report = reportWith({
      findings: [{ finding_id: 'F1', name: 'No major visible lawn stress signal', confidence: 'moderate', severity: 'mild' }],
    });
    expect(classifyReleaseMode(report)).toBe('minimal');
  });

  test('repair downgrades confirmed photo-only language to suspected', () => {
    const base = reportWith({
      findings: [{ finding_id: 'F1', name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate', urgency: 'monitor' }],
    });
    expect(base.internal_quality_flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'photo_confirmation_honesty' }),
    ]));
    const tampered = { ...base, customer_summary: 'We confirmed active chinch in the front lawn.' };
    const repaired = applyAutoReleaseRepair(tampered, 'conservative');
    expect(repaired.customer_summary).not.toMatch(/\bconfirmed\b/i);
    expect(repaired.customer_summary.toLowerCase()).toContain('suspected');
    expect(repaired.repairs_applied).toContain('confirmed_language_downgraded');
  });

  test('repair strips unauthoritative watering timing from customer copy', () => {
    const base = reportWith({
      findings: [{ finding_id: 'F1', name: 'Visible weed pressure', confidence: 'moderate', severity: 'mild', urgency: 'monitor' }],
      products: [{ product_id: 'P1', product_name: 'Unreviewed', addresses_findings: ['F1'] }],
      compliance: { irrigation_compliance: { assigned_days: ['Tuesday'] } },
    });
    const tampered = { ...base, customer_summary: 'Hold watering for 48 hours after treatment. We saw weed pressure across the lawn.' };
    const repaired = applyAutoReleaseRepair(tampered, 'conservative');
    expect(repaired.customer_summary).not.toMatch(/48\s*hours?/i);
    expect(repaired.customer_summary).toContain('post-service watering guidance');
    expect(repaired.repairs_applied).toContain('unauthoritative_timing_stripped');
  });

  test('minimal repair replaces the summary with a no-diagnosis service note', () => {
    const base = reportWith({
      photos: [{ quality: 'poor' }],
      findings: [{ finding_id: 'F1', name: 'Turf color stress', confidence: 'low', severity: 'mild' }],
    });
    const repaired = applyAutoReleaseRepair(base, 'minimal');
    expect(repaired.customer_summary).toBe(MINIMAL_SAFE_SUMMARY);
    expect(repaired.repairs_applied).toEqual(['minimal_safe_summary']);
  });

  test('minimal repair clears the diagnosis so no pest or disease is named', () => {
    const base = reportWith({
      photos: [{ quality: 'poor' }],
      findings: [{ finding_id: 'F1', name: 'Chinch bug pressure', confidence: 'low', severity: 'moderate' }],
    });
    expect(base.diagnosis.primary_finding).toBe('Chinch bug pressure');
    const repaired = applyAutoReleaseRepair(base, 'minimal');
    expect(repaired.diagnosis.primary_finding).toBeNull();
    expect(repaired.diagnosis.findings).toEqual([]);
    expect(repaired.expectations).toEqual({});
  });

  test('buildMinimalSafeReport never names a pest or disease', () => {
    const report = buildMinimalSafeReport({ photos: [], products: [], compliance: {} });
    expect(report.customer_summary).toBe(MINIMAL_SAFE_SUMMARY);
    expect(report.diagnosis.primary_finding).toBeNull();
    expect(report.human_review_required).toBe(false);
  });

  test('every classification path leaves human_review_required false', () => {
    const report = reportWith({
      findings: [{ finding_id: 'F1', name: 'Chinch bug pressure', confidence: 'low', severity: 'severe', urgency: 'immediate_callback' }],
      products: [{ product_id: 'P1', product_name: 'Unreviewed' }],
    });
    expect(report.human_review_required).toBe(false);
    expect(report.input_assessment.human_review_required).toBe(false);
    expect(report.input_assessment.human_review_reason).toBe('');
  });

  test('scrubCustomerText downgrades predicate-form confirmed claims (fungus/drought/large patch)', () => {
    expect(scrubCustomerText('The fungus is confirmed across the lawn.')).not.toMatch(/\bconfirmed\b/i);
    expect(scrubCustomerText('Drought is confirmed in the back yard.')).not.toMatch(/\bconfirmed\b/i);
    expect(scrubCustomerText('Large patch is confirmed here.')).toMatch(/most consistent with/i);
  });

  test('confirmed-language scrubber stays in lockstep with the cause labels (caterpillar/worm/mold/mildew/leaf spot)', () => {
    // These name governed causes too, so a moderate+ "<cause> is confirmed" claim must
    // also be downgraded — the noun list can't lag the condition labels. Phrasings put
    // the cause noun directly before "is/are confirmed" (the predicate-form pattern).
    for (const claim of ['Powdery mildew is confirmed', 'Mold is confirmed', 'Caterpillars are confirmed', 'Sod webworm is confirmed', 'Leaf spot is confirmed',
      // plural predicate forms must downgrade too
      'Leaf spots are confirmed', 'Dollar spots are confirmed', 'Grubs are confirmed', 'Large patches are confirmed']) {
      expect(scrubCustomerText(`${claim} in the photographed area.`)).not.toMatch(/\bconfirmed\b/i);
    }
    // adjective form too
    expect(scrubCustomerText('We saw active caterpillar damage.')).toMatch(/suspected caterpillar/i);
  });

  test.each([
    ['Chinch bugs were previously active, but none are present now.', 'Chinch bugs may have been previously active, but none are present now.'],
    ['Large patch was formerly active in the shade.', 'Large patch may have been formerly active in the shade.'],
    ['Grubs had historically been active here.', 'Grubs may have been historically active here.'],
  ])('scrubCustomerText keeps the historical qualifier and tense when downgrading %s', (text, expected) => {
    expect(scrubCustomerText(text)).toBe(expected);
  });

  test.each([
    ['Chinch bugs remain active here.', 'Chinch bugs may be active here.'],
    ['Large patch stays active.', 'Large patch may be active.'],
    ['Grubs continue to be active.', 'Grubs may be active.'],
    ['Chinch bugs remained active last visit.', 'Chinch bugs may have been active last visit.'],
    ['Chinch bugs were active yesterday, but none are present now.', 'Chinch bugs may have been active yesterday, but none are present now.'],
    ['Drought was confirmed last month.', 'Drought appeared most consistent with the visible pattern last month.'],
    ['Chinch bugs continue being active.', 'Chinch bugs may be active.'],
    ['Grubs keep being active.', 'Grubs may be active.'],
    ['Grubs kept being active.', 'Grubs may have been active.'],
  ])('scrubCustomerText downgrades aspectual and past-tense claims in %s without changing tense', (text, expected) => {
    expect(scrubCustomerText(text)).toBe(expected);
  });

  test.each([
    ['Fungal activity is confirmed in the shade.', 'Fungal activity appears most consistent with the visible pattern in the shade.'],
    ['Chinch bug pressure is confirmed.', 'Chinch bug pressure appears most consistent with the visible pattern.'],
    ['Chinch bugs are confirmed.', 'Chinch bugs appear most consistent with the visible pattern.'],
    ['Large patch (Rhizoctonia) is confirmed.', 'Large patch (Rhizoctonia) appears most consistent with the visible pattern.'],
    ['Chinch bug activity has been confirmed.', 'Chinch bug activity appears most consistent with the visible pattern.'],
    ['Chinch bug presence is confirmed.', 'Chinch bug presence appears most consistent with the visible pattern.'],
    ['Chinch bug signs are confirmed along the edge.', 'Chinch bug signs appear most consistent with the visible pattern along the edge.'],
    ['Grub feeding is confirmed.', 'Grub feeding appears most consistent with the visible pattern.'],
    ['Chinch bugs have only just recently been confirmed.', 'Chinch bugs appear most consistent with the visible pattern.'],
    ['Large patch has now also already just again been confirmed.', 'Large patch appears most consistent with the visible pattern.'],
  ])('scrubCustomerText keeps the subject noun phrase and a copula when downgrading %s', (text, expected) => {
    expect(scrubCustomerText(text)).toBe(expected);
  });

  test('safeCustomerSummary never publishes a residual definitive cause claim at any confidence', () => {
    for (const confidence of ['moderate', 'high']) {
      const out = safeCustomerSummary('Chinch bug colonies are confirmed along the edge.', confidence);
      expect(out).not.toMatch(/\bconfirmed\b/i);
      expect(out).not.toMatch(/chinch/i);
    }
    expect(residualDefinitiveClaim('Chinch bug colonies are confirmed along the edge.')).toBe(true);
    expect(residualDefinitiveClaim('Chinch bugs appear most consistent with the visible pattern.')).toBe(false);
    // No governed term in the sentence: not a cause claim.
    expect(residualDefinitiveClaim('The watering schedule is confirmed for Tuesday.')).toBe(false);
    // A modal clause is a finite clause, so the unrelated "confirmed" stays on its own side.
    expect(residualDefinitiveClaim('The watering schedule was confirmed and large patch may be present.')).toBe(false);
    expect(residualDefinitiveClaim('The controller was adjusted and chinch bugs could be active along the edge.')).toBe(false);
    expect(residualDefinitiveClaim('Large patch and dollar spot are confirmed.')).toBe(true);
    // Adjectival "active" modifies a recovery noun; it is not an activity claim.
    expect(residualDefinitiveClaim('Large patch has active recovery in the shade.')).toBe(false);
    expect(residualDefinitiveClaim('Chinch bug damage has active regrowth.')).toBe(false);
    expect(residualDefinitiveClaim('Chinch bug colonies are active along the edge.')).toBe(true);
    // Finite confirmation verbs and adjective-first activity claims.
    expect(residualDefinitiveClaim('The photos confirm chinch bug activity along the edge.')).toBe(true);
    expect(residualDefinitiveClaim('The photo confirms chinch bug activity.')).toBe(true);
    expect(residualDefinitiveClaim('Active colonies of chinch bugs remain along the edge.')).toBe(true);
    expect(residualDefinitiveClaim('We should confirm chinch bug activity if it spreads.')).toBe(false);
    expect(residualDefinitiveClaim('A closer look is needed to confirm chinch bug activity.')).toBe(false);
    expect(residualDefinitiveClaim('Chinch bugs may be active and large patch is a possibility.')).toBe(false);
    expect(residualDefinitiveClaim('Active recovery of large patch continues.')).toBe(false);
    expect(residualDefinitiveClaim('Confirm chinch bug activity with a float test.')).toBe(false);
    expect(residualDefinitiveClaim('The photos confirm possible chinch bug activity.')).toBe(false);
    // verified / proven are definitive synonyms.
    expect(residualDefinitiveClaim('Chinch bug activity has been verified along the edge.')).toBe(true);
    expect(residualDefinitiveClaim('Chinch bug activity was proven by the float test.')).toBe(true);
    expect(residualDefinitiveClaim('The float test verified chinch bug activity.')).toBe(true);
    expect(residualDefinitiveClaim('The lawn definitely has chinch bugs.')).toBe(true);
    // The definitive word must share the cause's clause, not merely its sentence.
    const unrelated = 'The watering schedule was confirmed with the customer, while large patch remains only a possibility.';
    expect(residualDefinitiveClaim(unrelated)).toBe(false);
    expect(safeCustomerSummary(unrelated, 'high')).toMatch(/large patch remains only a possibility/);
    // A comma pair is a parenthetical, not a clause break.
    expect(residualDefinitiveClaim('Large patch, in the shaded area, is confirmed.')).toBe(true);
    expect(safeCustomerSummary('Large patch, in the shaded area, is confirmed.', 'high')).not.toMatch(/confirmed|large patch/i);
    // An activity claim with a subject noun the grammar does not know is still caught.
    expect(residualDefinitiveClaim('Chinch bug colonies are active along the edge.')).toBe(true);
    expect(safeCustomerSummary('Chinch bug colonies are active along the edge.', 'moderate')).not.toMatch(/active|chinch/i);
    // Downgraded forms and non-cause subjects are not residual claims.
    expect(residualDefinitiveClaim('Chinch bugs may be active along the edge.')).toBe(false);
    expect(residualDefinitiveClaim('The sprinkler zone is active on Tuesdays.')).toBe(false);
  });

  test('scrubCustomerText keeps a historical qualifier when downgrading a confirmed claim', () => {
    const out = scrubCustomerText('Chinch bugs were previously confirmed, but none are present now.');
    expect(out).not.toMatch(/\bconfirmed\b/i);
    expect(out).toBe('Chinch bugs previously appeared most consistent with the visible pattern, but none are present now.');
  });

  test('scrubCustomerText strips emails, phone numbers, and links from egress copy', () => {
    const out = scrubCustomerText('Reach me at tech@waves.com or 941-555-1234, see https://x.co/abc.');
    expect(out).not.toMatch(/@waves\.com/);
    expect(out).not.toMatch(/941.?555.?1234/);
    expect(out).not.toMatch(/https?:\/\//);
  });

  test.each([
    ['Call 555-0100 if the patch spreads.', /0100/],
    ['Call 555 0100 if the patch spreads.', /0100/],
    ['Call +44 20 7946 0958 if the patch spreads.', /7946|0958/],
    ['Call +44 (0)20-7946-0958 if the patch spreads.', /7946|0958/],
    ['Call +1 941 555 0100 if the patch spreads.', /0100/],
    ['Call 9415550100 if the patch spreads.', /0100/],
    ['Call 0044 20 7946 0958 if the patch spreads.', /7946|0958/],
    ['Call 00 44 20 7946 0958 if the patch spreads.', /7946|0958/],
  ])('scrubCustomerText removes local and international phone forms from %s', (text, digits) => {
    const out = scrubCustomerText(text);
    expect(out).not.toMatch(digits);
    expect(out).toMatch(/if the patch spreads\./);
  });

  test.each(['Large patch has active recovery in the shade.', 'Chinch bug damage has active regrowth.', 'Dollar spot is showing active fill-in.'])('scrubCustomerText leaves the adjectival active phrase in %s alone', (text) => {
    expect(scrubCustomerText(text)).toBe(text);
  });

  test('scrubCustomerText still downgrades a predicative active claim beside a recovery noun', () => {
    expect(scrubCustomerText('Chinch bugs are active and recovery is slow.')).toMatch(/chinch bugs may be active and recovery is slow/i);
  });

  test('scrubCustomerText downgrades finite confirmation verbs and adjective-first activity claims', () => {
    expect(scrubCustomerText('The photos confirm chinch bug activity along the edge.')).toBe('The photos suggest chinch bug activity along the edge.');
    expect(scrubCustomerText('The photo confirms chinch bug activity.')).toBe('The photo suggests chinch bug activity.');
    const colonies = scrubCustomerText('Active colonies of chinch bugs remain along the edge.');
    expect(colonies).not.toMatch(/\bactive\b/i);
    expect(colonies).toMatch(/^suspected colonies of chinch bugs remain along the edge\.$/i);
    expect(scrubCustomerText('Float test required to confirm active chinch pressure.')).toBe('Float test required to confirm suspected chinch pressure.');
    expect(safeCustomerSummary('The photos confirm chinch bug activity.', 'moderate')).not.toMatch(/confirm/i);
  });

  test('scrubCustomerText downgrades verified / proven like confirmed', () => {
    expect(scrubCustomerText('Chinch bug activity has been verified along the edge.')).toBe('Chinch bug activity appears most consistent with the visible pattern along the edge.');
    expect(scrubCustomerText('Chinch bug activity was proven by the float test.')).toBe('Chinch bug activity appeared most consistent with the visible pattern by the float test.');
    expect(scrubCustomerText('The float test verified chinch bug activity.')).toBe('The float test suggested chinch bug activity.');
    expect(scrubCustomerText('The photos prove chinch bug activity.')).toBe('The photos suggest chinch bug activity.');
    expect(safeCustomerSummary('Chinch bug activity has been verified.', 'moderate')).not.toMatch(/verified/i);
  });

  test('an auxiliary never joins an adjective-first cause rewrite', () => {
    const out = scrubCustomerText('The lawn definitely has chinch bugs.');
    expect(out).not.toMatch(/suspected has/);
    expect(residualDefinitiveClaim(out)).toBe(true);
    expect(safeCustomerSummary('The lawn definitely has chinch bugs.', 'high')).not.toMatch(/definitely|suspected has/);
  });

  test('scrubCustomerText keeps ordinary short figures', () => {
    expect(scrubCustomerText('Reapply in 10-14 days across 2,000 sq ft; mow at 3.5 in.')).toBe('Reapply in 10-14 days across 2,000 sq ft; mow at 3.5 in.');
  });

  test('customer_summary reduces a raw/injected finding name to an allowlisted label', () => {
    // A stale/compromised client can store an arbitrary finding.name. The deterministic
    // summary must publish only the allowlisted condition label, never the raw text.
    const chinch = buildDiagnosticReportContract({
      findings: [{ finding_id: 'F1', name: 'Chinch — call me at evil@x.com 941-555-1234', confidence: 'moderate', severity: 'moderate', urgency: 'monitor' }],
    });
    expect(chinch.customer_summary).not.toMatch(/evil@x\.com|941.?555.?1234/);
    expect(chinch.customer_summary.toLowerCase()).toContain('chinch');

    const weed = buildDiagnosticReportContract({
      findings: [{ finding_id: 'F1', name: 'Visible weed pressure', confidence: 'moderate', severity: 'mild', urgency: 'monitor' }],
    });
    expect(weed.customer_summary).toMatch(/weed pressure/);
  });

  test('low/unknown-confidence findings stay symptom-only in customer_summary (naming gate)', () => {
    const low = buildDiagnosticReportContract({
      findings: [{ finding_id: 'F1', name: 'Chinch bug pressure', confidence: 'low', severity: 'moderate', urgency: 'monitor' }],
    });
    expect(low.customer_summary.toLowerCase()).not.toContain('chinch');
    expect(low.customer_summary.toLowerCase()).toMatch(/keeping an eye|closer look/);

    // moderate+ may name the cause
    const moderate = buildDiagnosticReportContract({
      findings: [{ finding_id: 'F1', name: 'Chinch bug pressure', confidence: 'moderate', severity: 'moderate', urgency: 'monitor' }],
    });
    expect(moderate.customer_summary.toLowerCase()).toContain('chinch');
  });

  test('safeConditionLabel resolves negated/clean findings and never mismatches "unhealthy"', () => {
    expect(safeConditionLabel('No visible disease pressure')).toBe('no major visible stress');
    expect(safeConditionLabel('No major visible lawn stress signal')).toBe('no major visible stress');
    expect(safeConditionLabel('Unhealthy turf — severe decline')).not.toBe('no major visible stress');
    expect(safeConditionLabel('Chinch bug pressure')).toBe('chinch bug activity');
    // A positive finding with a negated differential is NOT clean.
    expect(safeConditionLabel('Possible fungal disease; no weed pressure')).toBe('fungal activity');
  });

  test.each([
    'Rhizoctonia ruled out', 'Take-all was not observed', 'Sod-webworm not present', 'Large patch ruled-out',
    'Chinch bugs weren\u2019t observed', 'Non-fungal stress', 'Gray leaf spot absent', 'Dollar spot unlikely', 'Disease-free turf',
    'Chinch bugs never observed', 'Never observed chinch bugs',
    // One negation keeps its scope across an enumerated list.
    'No weeds, disease, or pests observed', 'No chinch bugs: drought stress ruled out', 'Not drought, chinch bugs, or grubs',
    // A subject-describing negation negates the whole clause.
    'Chinch bugs not a factor', 'Chinch bugs were never seen', 'Large patch with no weed pressure ruled out',
    'Weed-free, disease-free turf', 'Free of chinch bugs',
    // The whole governed cause is consumed with "free".
    'Chinch bug-free turf', 'Gray leaf spot-free turf', 'Iron deficiency-free turf', 'Free of gray leaf spot',
    // "nothing" must not match the thinning alias inside it.
    'Healthy overall, nothing concerning', 'Nothing concerning',
    // A non prefix joined directly to the cause.
    'Nonfungal stress', 'Nonchinch damage',
    // "no" + a generic symptom noun negates the cause before it.
    'Chinch bugs \u2014 no evidence observed', 'Dollar spot with no lesions visible', 'Large patch: no signs present',
    // A conjunct without its own predicate shares the negated one after it.
    'Chinch bugs and weeds absent', 'Large patch and dollar spot ruled out',
    // "free of" keeps its scope across a coordinated list.
    'Free of chinch bugs and weeds', 'Free of chinch bugs, weeds, or grubs',
    // The nominal absence form.
    'Absence of chinch bugs', 'Chinch bug absence', 'Absence of any large patch or dollar spot',
    // A conjunct sharing the negated predicate; symbolic conjunctions in a free-of list.
    'No chinch bugs and weeds observed', 'Free of chinch bugs & weeds', 'Free of chinch bugs, weeds & grubs', 'Free of chinch bugs / weeds',
    'Lack of chinch bugs', 'Lacking any chinch bugs',
  ])('safeConditionLabel never maps the negated alias %s to a positive cause label', (name) => {
    expect(safeConditionLabel(name, 'high')).toBe('no major visible stress');
  });

  test('the "free of" list matcher stays linear when a state word ends the list', () => {
    const inputs = [
      'Free of significant discoloration present',
      `Free of ${'a'.repeat(40)} present`,
      `Free of ${Array(60).fill('word').join(' ')} present`,
    ];
    const started = Date.now();
    for (const input of inputs) safeConditionLabel(input, 'high');
    expect(Date.now() - started).toBeLessThan(200);
  });

  test.each([
    'Large patch is not getting better', 'Chinch bug damage has not started to recover',
    'Dollar spot not spreading much', 'Large patch is not getting better; weeds absent',
    'Large patch cannot be ruled out', 'Chinch bugs have not been ruled out', 'Dollar spot not excluded', 'Chinch bugs aren\u2019t unlikely',
    'Fungal activity is not confirmed', 'Chinch bugs are unconfirmed', 'Chinch bugs cannot be confirmed',
    'Not free of chinch bugs', 'Turf is not pest-free', 'Cannot be disease-free',
    // A conjunct with no predicate of its own shares the uncertain predicate.
    'Chinch bugs and large patch cannot be ruled out',
  ])('an unrecognized negation %s never earns the clean label and never maps a cause', (name) => {
    expect(safeConditionLabel(name, 'high')).toBe('a lawn condition we are monitoring');
    expect(safeConditionLabel(name, 'low')).toBe('a lawn condition we are monitoring');
  });

  test.each([
    ['Chinch bugs not present, but drought stress visible', 'drought stress'],
    ['Rhizoctonia ruled out; dollar spot lesions', 'dollar spot'],
    ['Sod-webworm not present. Grub damage at the edge', 'grub activity'],
    ['No weeds; large patch is visible', 'large patch (fungal) activity'],
    ['Not drought; chinch bug damage along the edge', 'chinch bug activity'],
    // A determiner-style negation scopes forward, so the positive head survives.
    ['Large patch with no weed pressure', 'large patch (fungal) activity'],
    ['Large patch without dollar spot', 'large patch (fungal) activity'],
    ['Drought stress, not chinch bugs', 'drought stress'],
    ['Chinch bugs, no drought', 'chinch bug activity'],
    // A "-free" differential negates only its own compound.
    ['Large patch in otherwise weed-free turf', 'large patch (fungal) activity'],
    ['Chinch bug damage, disease free', 'chinch bug activity'],
    ['Grub damage free of fungal signs', 'grub activity'],
    // A negated recovery negates the recovery, not the condition.
    ['Large patch is not improving', 'large patch (fungal) activity'],
    ['Chinch bug damage has not recovered', 'chinch bug activity'],
    ['Chinch bug damage hasn\u2019t responded to treatment', 'chinch bug activity'],
    ['Dollar spot still not clearing up', 'dollar spot'],
    // A "free of" list ends at its conjunction item or at a new statement.
    ['Free of chinch bugs and weeds, large patch present', 'large patch (fungal) activity'],
    ['Free of chinch bugs, weeds, large patch is spreading', 'large patch (fungal) activity'],
    // A later segment with its own predicate is a new positive statement.
    ['No weeds, large patch present', 'large patch (fungal) activity'],
    ['No weeds: chinch bugs observed', 'chinch bug activity'],
    // Every sentence terminator splits clauses.
    ['No weeds! Large patch is visible', 'large patch (fungal) activity'],
    ['No weeds? Large patch is visible', 'large patch (fungal) activity'],
    // A postpositive marker negates only its own segment, comma- or and-joined.
    ['Large patch present and weeds absent', 'large patch (fungal) activity'],
    ['Chinch bug damage at the edge, weeds absent', 'chinch bug activity'],
    ['Chinch bug damage at the edge and weeds absent', 'chinch bug activity'],
    ['Large patch absent and drought stress visible', 'drought stress'],
    ['Weeds absent and large patch present', 'large patch (fungal) activity'],
    ['Large patch present, weeds absent', 'large patch (fungal) activity'],
    ['Chinch bugs not present, drought stress visible', 'drought stress'],
    ['Chinch bugs not a factor, drought stress visible', 'drought stress'],
    ['Nonirrigated strip, chinch bug damage', 'chinch bug activity'],
    ['Healthy overall, some yellowing', 'color and nutrient stress'],
    // An uncertain differential is scoped to its own predicate segment.
    ['Large patch present, chinch bugs not confirmed', 'large patch (fungal) activity'],
    ['Large patch visible and chinch bugs cannot be ruled out', 'large patch (fungal) activity'],
    ['Chinch bugs not confirmed, large patch present', 'large patch (fungal) activity'],
    ['Drought stress unconfirmed; chinch bug damage along the edge', 'chinch bug activity'],
    // The nominal absence form negates its own segment.
    ['Large patch present, chinch bug absence', 'large patch (fungal) activity'],
    // "not only" / "not just" intensify rather than negate.
    ['Large patch is not only visible but spreading', 'large patch (fungal) activity'],
    ['Chinch bug damage is not just visible, it is spreading', 'chinch bug activity'],
    ['Dollar spot not merely present but spreading', 'dollar spot'],
    // An "and"-led segment with its own finite verb is a new positive statement.
    ['No weeds and large patch is present', 'large patch (fungal) activity'],
    ['No weeds, and large patch is present', 'large patch (fungal) activity'],
    ['No chinch bugs and drought stress is visible', 'drought stress'],
    ['Large patch present, lack of weeds', 'large patch (fungal) activity'],
  ])('safeConditionLabel maps only the positive clause of %s', (name, label) => {
    expect(safeConditionLabel(name, 'high')).toBe(label);
  });

  test('safeConditionLabel aliases are word-bounded so ordinary words never map to a condition', () => {
    expect(safeConditionLabel('Thin turf', 'high')).toBe('thinning turf');
    expect(safeConditionLabel('Thinning along the edge', 'high')).toBe('thinning turf');
    expect(safeConditionLabel('Environmental stress', 'high')).not.toBe('color and nutrient stress');
    expect(safeConditionLabel('Iron deficiency', 'high')).toBe('color and nutrient stress');
  });

  test('safeConditionLabel keeps a health-led name clean when no positive clause follows', () => {
    expect(safeConditionLabel('Healthy, dense turf', 'high')).toBe('no major visible stress');
    expect(safeConditionLabel('Looks good overall', 'high')).toBe('no major visible stress');
  });

  test('safeCustomerSummary governs the fully joined gray-leaf-spot spelling', () => {
    expect(safeCustomerSummary('Grayleafspot lesions are visible.', 'low')).not.toMatch(/leaf/i);
    expect(safeConditionLabel('Grayleafspot lesions', 'moderate')).toBe('gray leaf spot');
  });

  test.each(['Wilts are visible', 'Funguses are spreading', 'Crabgrasses are spreading', 'Rhizoctonial damage', 'Droughty turf'])('safeCustomerSummary governs the inflected spelling %s', (cause) => {
    expect(safeCustomerSummary(`${cause} across the shaded strip.`, 'low')).not.toMatch(/wilt|fungus|crabgrass|rhizoctonia|drought/i);
  });

  test.each(['Moldy growth', 'Mildewed turf', 'Diseased turf', 'Mildewy patches'])('safeCustomerSummary replaces a low-confidence summary using the adjectival form %s with the generic line', (cause) => {
    expect(safeCustomerSummary(`${cause} across the shaded strip.`, 'low')).not.toMatch(/moldy|mildew|diseased/i);
  });

  test.each(['Sod--webworm damage', 'Sod - webworm damage', 'Chinch  bug damage', 'Army--worm feeding'])('safeCustomerSummary replaces a low-confidence summary naming %s with the generic line', (cause) => {
    expect(safeCustomerSummary(`Most consistent with ${cause}.`, 'low')).not.toMatch(/webworm|chinch|worm/i);
  });

  test.each([
    ['Sod-webworm damage', 'caterpillar activity'], ['Sod‑webworm damage', 'caterpillar activity'], ['Armyworm feeding', 'caterpillar activity'],
    ['Large-patch activity', 'large patch (fungal) activity'], ['Brownpatch rings', 'large patch (fungal) activity'],
    ['Gray-leaf-spot lesions', 'gray leaf spot'], ['Greyleaf spot', 'gray leaf spot'], ['Dollar-spot lesions', 'dollar spot'],
    ['Leaf-spot activity', 'fungal activity'], ['Water-stress pattern', 'drought stress'], ['Underwatered turf', 'drought stress'],
    ['Fungi spreading', 'fungal activity'], ['Molds spreading', 'fungal activity'], ['Rhizoctonia rings', 'large patch (fungal) activity'], ['Take-all root rot', 'fungal activity'],
    ['Take-all patch', 'fungal activity'], ['Take all root rot', 'fungal activity'],
  ])('safeConditionLabel maps the separator spelling %s to %s at moderate confidence', (name, label) => {
    expect(safeConditionLabel(name, 'moderate')).toBe(label);
  });

  test.each(['Recovery may take all season', 'Thin turf may take all summer to recover', 'This will take all of the fall', 'Preventive fungicide application', 'Fungicide-treated area'])('safeConditionLabel never reads the ordinary phrase in %s as a fungal disease', (name) => {
    expect(safeConditionLabel(name, 'high')).not.toBe('fungal activity');
  });

  test('safeConditionLabel downgrades a named cause to a generic symptom below moderate confidence', () => {
    expect(safeConditionLabel('Chinch bug pressure', 'low')).toBe('general lawn stress');
    expect(safeConditionLabel('Large patch disease', 'unknown')).toBe('general lawn stress');
    // moderate+ may name the cause
    expect(safeConditionLabel('Chinch bug pressure', 'moderate')).toBe('chinch bug activity');
    // a generic symptom label is not a "cause", so it is never downgraded
    expect(safeConditionLabel('Visible weed pressure', 'low')).toBe('weed pressure');
  });

  test('safeCustomerSummary replaces a cause-naming summary below moderate confidence', () => {
    const named = 'The pattern is most consistent with chinch pressure, which can look like drought.';
    expect(safeCustomerSummary(named, 'low').toLowerCase()).not.toContain('chinch');
    expect(safeCustomerSummary(named, 'unknown').toLowerCase()).not.toContain('chinch');
    // moderate+ may name the cause; a symptom-only low summary is left alone
    expect(safeCustomerSummary(named, 'moderate')).toContain('chinch');
    expect(safeCustomerSummary('An area is worth keeping an eye on.', 'low')).toMatch(/keeping an eye/);
  });

  test('safeCustomerSummary replaces GENERIC cause terms (insect/pest/disease), not just named species', () => {
    const insect = safeCustomerSummary('The pattern is most consistent with insect pressure.', 'low');
    expect(insect.toLowerCase()).not.toContain('insect');
    expect(insect).toMatch(/closer look/i); // = the generic low-confidence summary
    const disease = safeCustomerSummary('Active disease pressure is spreading across the lawn.', 'low');
    expect(disease).not.toMatch(/spreading across the lawn/i); // original cause claim gone
    expect(disease).toMatch(/closer look/i);
    // moderate+ may still name the cause
    expect(safeCustomerSummary('Most consistent with insect pressure.', 'moderate')).toContain('insect');
  });

  test('safeCustomerSummary gate stays in lockstep with the cause-mapped condition labels', () => {
    // caterpillar/worm + leaf spot/mold/mildew map to governed cause labels too, so a
    // low-confidence summary naming them must also degrade to symptom-only.
    for (const phrase of ['caterpillar activity', 'army worm damage', 'sod webworm', 'powdery mildew', 'mold growth', 'leaf spot',
      // plural forms must gate too
      'grubs', 'leaf spots', 'dollar spots', 'large patches', 'caterpillars']) {
      const out = safeCustomerSummary(`Most consistent with ${phrase} in the photographed area.`, 'low');
      expect(out).toMatch(/closer look/i);
    }
  });

  test('drought is gated as a named cause below moderate confidence (label + summary)', () => {
    // drought is a governed, photo-unconfirmable cause — low/unknown must not name it.
    expect(safeConditionLabel('Drought stress along the south edge', 'low')).toBe('general lawn stress');
    expect(safeConditionLabel('Water stress / drought', 'unknown')).toBe('general lawn stress');
    // moderate+ may name it.
    expect(safeConditionLabel('Drought stress', 'moderate')).toBe('drought stress');
    // the hero summary scrub now covers drought/water-stress wording too.
    expect(safeCustomerSummary('Signs are most consistent with drought stress.', 'low').toLowerCase()).not.toContain('drought');
    expect(safeCustomerSummary('The lawn shows water stress at the margins.', 'low').toLowerCase()).not.toContain('water stress');
  });

  test('buildExpectations only emits cause-specific guidance for moderate+ findings', () => {
    const lowFungus = buildDiagnosticReportContract({
      findings: [{ name: 'Possible fungal activity', confidence: 'low', severity: 'moderate' }],
    });
    expect(lowFungus.expectations.fungus).toBeNull();
    expect(lowFungus.expectations.turf_recovery).toBeTruthy();

    const modFungus = buildDiagnosticReportContract({
      findings: [{ name: 'Large patch fungal disease', confidence: 'moderate', severity: 'moderate' }],
    });
    expect(modFungus.expectations.fungus).toMatch(/disease treatments/i);
  });

  test('lowerConfidence returns the more conservative value', () => {
    expect(lowerConfidence('high', 'low')).toBe('low');
    expect(lowerConfidence('low', 'high')).toBe('low');
    expect(lowerConfidence('moderate', null)).toBe('moderate');
    expect(lowerConfidence(null, 'high')).toBe('high');
    expect(lowerConfidence(null, null)).toBeNull();
  });

  test('watering restriction copy is built from structured days, never the raw client string', () => {
    const plan = buildWateringPlan({
      products: [],
      compliance: { irrigation_compliance: {
        assigned_days: ['Wednesday', 'Saturday', 'TECH ONLY use gate code BLUE'],
        allowed_time_windows: ['before 10am', 'rm -rf /'],
        restriction_summary_customer: 'TECH ONLY: gate code BLUE 1234',
      } },
    });
    expect(plan.ongoing_irrigation.restriction_summary_customer).not.toMatch(/gate code|BLUE|TECH ONLY/i);
    expect(plan.ongoing_irrigation.restriction_summary_customer).toMatch(/Wednesday and Saturday/);
    expect(plan.ongoing_irrigation.assigned_days).toEqual(['Wednesday', 'Saturday']);
    expect(plan.ongoing_irrigation.allowed_time_windows).toEqual(['before 10am']);
  });

  test('confirmed-language repair covers non-chinch photo-only disease/drought, not just chinch', () => {
    const base = reportWith({
      findings: [{ finding_id: 'F1', name: 'Possible large patch disease', confidence: 'low', severity: 'moderate', urgency: 'monitor' }],
    });
    expect(base.internal_quality_flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'photo_confirmation_honesty' }),
    ]));
    const tampered = { ...base, customer_summary: 'We confirmed active disease across the back lawn.' };
    const repaired = applyAutoReleaseRepair(tampered, 'conservative');
    expect(repaired.customer_summary).not.toMatch(/\bconfirmed\b/i);
    expect(repaired.repairs_applied).toContain('confirmed_language_downgraded');
  });

  test('catalog-authoritative 0 N/P is not overridden by a stale request value', () => {
    const conflicts = fertilizerBlackoutConflicts([{
      product_id: 'P1',
      product_name: 'Catalog says zero N/P',
      analysis_n: 0,
      analysis_p: 0,
      nitrogen_pct: 16,
      phosphorus_pct: 4,
    }], {
      fertilizer_blackout: { active: true, applies_to: ['nitrogen', 'phosphorus'] },
    });
    expect(conflicts).toEqual([]);
  });
});
