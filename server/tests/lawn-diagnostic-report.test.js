const {
  buildDiagnosticReportContract,
  buildWateringPlan,
  fertilizerBlackoutConflicts,
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
      human_review_required: true,
    });
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

  test('adequate photos with missing-view limitations still require review', () => {
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
    expect(report.input_assessment.human_review_required).toBe(true);
    expect(report.input_assessment.human_review_reason).toContain('No close-up blade image');
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
    expect(report.human_review_required).toBe(true);
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
