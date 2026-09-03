const { hasServiceRecordSql, legacyServiceRecordExistsSql } = require('../services/service-record-presence');

describe('service-record-presence', () => {
  test('FK match OR legacy tuple match, against the caller\'s alias', () => {
    const sql = hasServiceRecordSql('ss');
    expect(sql).toContain('fsr.scheduled_service_id = ss.id');
    expect(sql).toContain('lsr.scheduled_service_id IS NULL');
    expect(sql).toContain('lsr.customer_id = ss.customer_id');
    expect(sql).toContain('lsr.service_date = ss.scheduled_date');
    expect(sql).toContain('lsr.service_type = ss.service_type');
    expect(sql).not.toContain('scheduled_services.');
  });
  test('defaults to the unaliased table and the legacy half stands alone', () => {
    expect(hasServiceRecordSql()).toContain('fsr.scheduled_service_id = scheduled_services.id');
    expect(legacyServiceRecordExistsSql('ss')).not.toContain('fsr.');
  });
});
