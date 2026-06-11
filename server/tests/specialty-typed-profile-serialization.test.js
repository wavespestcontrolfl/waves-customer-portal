const {
  serializeProfile,
  DEFAULT_SERVICE_REPORT_PROFILE,
} = require('../services/service-completion-profiles');

describe('typed specialty profile serialization', () => {
  test('service_report profile exposes findingsType and nulls projectType (stale-client fail-safe)', () => {
    const profile = serializeProfile({
      service_key: 'cockroach_control',
      completion_mode: 'service_report',
      project_type: 'cockroach',
      followup_policy: 'alert',
      default_followup_days: 14,
      delivery_mode: 'internal_only',
      active: true,
    });
    expect(profile.findingsType).toBe('cockroach');
    // Stale clients route to the Projects flow on projectType truthiness —
    // it must be null whenever the mode is service_report.
    expect(profile.projectType).toBeNull();
    expect(profile.projectBacked).toBe(false);
    expect(profile.requiresProject).toBe(false);
    expect(profile.specialProject).toBe(false);
    expect(profile.deliveryMode).toBe('internal_only');
  });

  test('project_required profile keeps projectType and never exposes findingsType', () => {
    const profile = serializeProfile({
      service_key: 'wdo_inspection',
      completion_mode: 'special_project',
      project_type: 'wdo_inspection',
      active: true,
    });
    expect(profile.projectType).toBe('wdo_inspection');
    expect(profile.findingsType).toBeNull();
    expect(profile.projectBacked).toBe(true);
    expect(profile.deliveryMode).toBe('auto_send');
  });

  test('recurring profile with no project_type is byte-identical in routing fields', () => {
    const profile = serializeProfile({
      service_key: 'pest_general_quarterly',
      completion_mode: 'service_report',
      project_type: null,
      active: true,
    });
    expect(profile.findingsType).toBeNull();
    expect(profile.projectType).toBeNull();
    expect(profile.projectBacked).toBe(false);
    expect(profile.deliveryMode).toBe('auto_send');
  });

  test('default fallback profile carries the new fields with safe values', () => {
    expect(DEFAULT_SERVICE_REPORT_PROFILE.findingsType).toBeNull();
    expect(DEFAULT_SERVICE_REPORT_PROFILE.deliveryMode).toBe('auto_send');
    const profile = serializeProfile(null);
    expect(profile.findingsType).toBeNull();
    expect(profile.deliveryMode).toBe('auto_send');
  });
});
