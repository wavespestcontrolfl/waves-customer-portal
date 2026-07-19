const { normalizeRequirements } = require('../services/service-closeout-requirements');

describe('service closeout requirements', () => {
  test('uses explicit service catalog closeout flags when present', () => {
    const result = normalizeRequirements({
      id: 'svc_1',
      name: 'Termite Treatment Service',
      category: 'termite',
      requires_service_report: true,
      requires_application_log: true,
      required_photo_count: 2,
      requires_customer_signature: false,
      requires_customer_notice: true,
      requires_license: true,
      license_category: 'GHP',
      closeout_requirements_source: 'manual',
    });

    expect(result).toMatchObject({
      serviceId: 'svc_1',
      requiresServiceReport: true,
      requiresApplicationLog: true,
      requiredPhotoCount: 2,
      requiresCustomerNotice: true,
      requiresLicense: true,
      licenseCategory: 'GHP',
      source: 'manual',
    });
  });

  test('does not require an application log for inspection-only services', () => {
    const result = normalizeRequirements({}, 'WDO Inspection Service');
    expect(result.requiresServiceReport).toBe(true);
    expect(result.requiresApplicationLog).toBe(false);
    expect(result.requiredPhotoCount).toBe(2);
    expect(result.source).toBe('fallback_inference');
  });

  test('falls back to application-log requirements for treatment labels', () => {
    const result = normalizeRequirements({}, 'Monthly Mosquito Treatment');
    expect(result.requiresApplicationLog).toBe(true);
    expect(result.requiresCustomerNotice).toBe(true);
  });

  test('infers requirements for catalog rows with default inferred source', () => {
    const result = normalizeRequirements({
      id: 'svc_2',
      name: 'Mosquito Event Treatment',
      category: 'mosquito',
      requires_service_report: true,
      requires_application_log: false,
      required_photo_count: 0,
      requires_customer_notice: false,
      closeout_requirements_source: 'inferred_v1',
    });

    expect(result.requiresApplicationLog).toBe(true);
    expect(result.requiresCustomerNotice).toBe(true);
    expect(result.source).toBe('inferred_v1');
  });

  test('respects manual catalog overrides for application services', () => {
    const result = normalizeRequirements({
      id: 'svc_3',
      name: 'Mosquito Customer Education',
      category: 'mosquito',
      requires_application_log: false,
      requires_customer_notice: false,
      closeout_requirements_source: 'manual',
    });

    expect(result.requiresApplicationLog).toBe(false);
    expect(result.requiresCustomerNotice).toBe(false);
    expect(result.source).toBe('manual');
  });

  test('lawn + tree & shrub combo resolves identically under inference and the migrated columns (audit 2026-07-18)', () => {
    // The combo row shipped with bare column defaults (source inferred_v1),
    // so the feed inferred at read time; migration 20260719100000 writes the
    // inference-correct values column-authoritatively (combined_lane_v1).
    // Both regimes must agree — the migration changes provenance, never
    // requirements.
    const comboRow = { id: 'svc_combo', name: 'Lawn + Tree & Shrub', category: 'lawn_care' };
    const inferred = normalizeRequirements({
      ...comboRow,
      requires_application_log: false,
      required_photo_count: 0,
      requires_customer_notice: false,
      closeout_requirements_source: 'inferred_v1',
    });
    const migrated = normalizeRequirements({
      ...comboRow,
      requires_application_log: true,
      required_photo_count: 2,
      requires_customer_notice: true,
      closeout_requirements_source: 'combined_lane_v1',
    });
    for (const shape of [inferred, migrated]) {
      expect(shape.requiresApplicationLog).toBe(true);
      expect(shape.requiredPhotoCount).toBe(2);
      expect(shape.requiresCustomerNotice).toBe(true);
    }
  });
});
