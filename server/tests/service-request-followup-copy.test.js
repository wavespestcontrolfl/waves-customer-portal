const migration = require('../models/migrations/20260715220000_service_request_followup_copy');

describe('service request confirmation copy', () => {
  test('promises direct follow-up without claiming an assignment SMS is sent', () => {
    expect(migration.NEW_BODY).toContain('follow up directly');
    expect(migration.NEW_BODY).not.toMatch(/text you when|assigned to a technician/i);
    expect(migration.NEW_BODY).toContain('{first_name}');
    expect(migration.NEW_BODY).toContain('{category}');
    expect(migration.NEW_BODY).toContain('{response_time}');
  });
});
