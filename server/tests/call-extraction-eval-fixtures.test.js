const fs = require('fs');
const path = require('path');

const fixturePath = path.join(__dirname, '../fixtures/call-extraction-eval/reviewed-calls.json');

describe('call extraction eval fixtures', () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  test('reviewed call fixture has the expected shape without PII fields', () => {
    expect(fixture.schemaVersion).toBe('call-extraction-reviewed-calls.v1');
    expect(fixture.cases.length).toBeGreaterThanOrEqual(5);

    const ids = new Set();
    for (const item of fixture.cases) {
      expect(item.id).toMatch(/^[a-z0-9-]+$/);
      expect(item.call_log_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(item.reviewed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.reviewed_outcome).toEqual(expect.any(String));
      expect(item.expect).toEqual(expect.any(Object));
      expect(item).not.toHaveProperty('transcript');
      expect(item).not.toHaveProperty('customer_name');
      expect(item).not.toHaveProperty('phone');
      expect(item).not.toHaveProperty('address');
      ids.add(item.id);
    }

    expect(ids.size).toBe(fixture.cases.length);
  });

  test('locks reviewed June 2026 call ids into the replay set', () => {
    const byId = Object.fromEntries(fixture.cases.map((item) => [item.id, item]));

    expect(byId['ronni-name-email-address-ground-truth'].expect.current_flags_exclude)
      .toContain('name_email_mismatch');
    expect(byId['historical-schedule-date-time-was-wrong'].expect.legacy_schedule_variance_fields)
      .toEqual(['scheduled_date', 'window_start']);
    expect(byId['missed-booking-recovery-monday-11'].expect.current_would_auto_route)
      .toBe(true);
    expect(byId['name-email-mismatch-guard-useful'].expect.current_flags_include)
      .toContain('name_email_mismatch');
    expect(byId['short-call-missing-address-correct-triage'].expect.current_flags_include)
      .toEqual(expect.arrayContaining(['address_unverifiable', 'missing_service_address']));
  });
});
