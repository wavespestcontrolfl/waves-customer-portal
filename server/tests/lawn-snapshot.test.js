const LawnSnapshot = require('../services/lawn-snapshot');

describe('lawn snapshot customer-safe builder helpers', () => {
  test('does not invent a location when photo zone/type is unknown', () => {
    expect(LawnSnapshot._test.locationLabelFromPhoto(null)).toBeNull();
    expect(LawnSnapshot._test.locationLabelFromPhoto({ photo_type: 'general' })).toBeNull();

    const findings = LawnSnapshot.deriveFindings({
      assessment: {
        id: 'assessment-1',
        confirmed_by_tech: true,
        turf_density: 82,
        weed_suppression: 58,
        color_health: 80,
        fungus_control: 95,
        thatch_level: 85,
      },
      photos: [{ photo_type: 'general', customer_visible: true, quality_gate_passed: true }],
    });

    expect(findings[0].location_label).toBeNull();
    expect(findings[0].customer_copy).toContain('one area of the lawn');
    expect(findings[0].customer_copy).not.toMatch(/north|south|east|west|front yard|back yard/i);
  });

  test('uses explicit zones when present', () => {
    expect(LawnSnapshot._test.locationLabelFromPhoto({ zone: 'Front Yard Trouble Area' }))
      .toBe('front yard trouble area');
    expect(LawnSnapshot._test.locationLabelFromPhoto({ photo_type: 'trouble_spot' }))
      .toBe('trouble area');
  });

  test('uses cautious wording for possible disease indicators', () => {
    const findings = LawnSnapshot.deriveFindings({
      assessment: {
        id: 'assessment-1',
        confirmed_by_tech: true,
        turf_density: 82,
        weed_suppression: 90,
        color_health: 80,
        fungus_control: 45,
        thatch_level: 85,
      },
      photos: [{ photo_type: 'front_yard', customer_visible: true, quality_gate_passed: true }],
    });

    expect(findings[0].key).toBe('possible_disease_pressure');
    expect(findings[0].customer_copy).toMatch(/signs consistent with/i);
    expect(findings[0].customer_copy).not.toMatch(/\bdiagnosed\b|\bconfirmed fungus\b/i);
  });

  test('customer summary uses recovery windows without guarantee language', () => {
    const summary = LawnSnapshot.buildCustomerSummary({
      findings: [{
        customer_copy: 'We saw moderate weed pressure in one area of the lawn.',
      }],
      treatment_context: { completed_today: true },
      expected_window: { min_days: 14, max_days: 21 },
    });

    expect(summary).toContain('14-21 days');
    expect(summary).not.toMatch(/\bguarantee|\bwill recover|\bpromise/i);
  });

  test('quality-failed photos are ignored for evidence location', () => {
    const photo = LawnSnapshot._test.chooseEvidencePhoto([
      { photo_type: 'front_yard', customer_visible: false, quality_gate_passed: false, is_best_photo: true },
      { photo_type: 'side_yard', customer_visible: true, quality_gate_passed: true },
    ]);

    expect(photo.photo_type).toBe('side_yard');
  });
});
