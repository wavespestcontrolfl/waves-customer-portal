const {
  auditRecurringScheduleAnomalies,
  buildRecurringScheduleAnomalySql,
  formatAnomaly,
  normalizeLimit,
} = require('../services/recurring-schedule-audit');

describe('recurring schedule anomaly audit', () => {
  test('builds a read-only audit query for active recurring rows by default', () => {
    const { sql, bindings } = buildRecurringScheduleAnomalySql();
    const normalizedSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    expect(normalizedSql).toContain('from scheduled_services s');
    expect(normalizedSql).toContain('where s.is_recurring = true');
    expect(normalizedSql).toContain('s.status not in (?, ?, ?)');
    expect(bindings).toContain('monthly_nth_weekday');
    expect(bindings).toEqual(expect.arrayContaining(['cancelled', 'rescheduled', 'completed']));
    expect(normalizedSql).not.toMatch(/\b(update|insert|delete|truncate|alter|drop)\b/);
  });

  test('can include completed rows for historical audit mode', () => {
    const { sql, bindings } = buildRecurringScheduleAnomalySql({ includeCompleted: true, limit: 25 });
    const normalizedSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    expect(normalizedSql).toContain('s.status not in (?, ?)');
    expect(bindings).toEqual(expect.arrayContaining(['cancelled', 'rescheduled']));
    expect(bindings).not.toContain('completed');
    expect(bindings[bindings.length - 1]).toBe(25);
  });

  test('normalizes limits to a bounded range', () => {
    expect(normalizeLimit(undefined)).toBe(100);
    expect(normalizeLimit('0')).toBe(1);
    expect(normalizeLimit('25')).toBe(25);
    expect(normalizeLimit('9999')).toBe(500);
  });

  test('formats anomaly rows for the admin API', () => {
    expect(formatAnomaly({
      check_type: 'child_anchor',
      issue: 'child_too_close_to_parent',
      customer_id: 'customer-1',
      customer_name: 'Test Customer',
      appointment_id: 'appt-1',
      recurring_parent_id: 'parent-1',
      service_type: 'Pest Control',
      status: 'pending',
      pattern: 'quarterly',
      reference_date: new Date('2026-05-31T00:00:00.000Z'),
      scheduled_date: '2026-06-01',
      diff_days: '1',
      skip_weekends: true,
      weekend_shift: 'forward',
    })).toEqual({
      checkType: 'child_anchor',
      issue: 'child_too_close_to_parent',
      customerId: 'customer-1',
      customerName: 'Test Customer',
      appointmentId: 'appt-1',
      recurringParentId: 'parent-1',
      serviceType: 'Pest Control',
      status: 'pending',
      pattern: 'quarterly',
      referenceDate: '2026-05-31',
      scheduledDate: '2026-06-01',
      diffDays: 1,
      skipWeekends: true,
      weekendShift: 'forward',
    });
  });

  test('executes with injected db connection and returns status summary', async () => {
    const conn = {
      raw: jest.fn().mockResolvedValue({
        rows: [{
          check_type: 'consecutive',
          issue: 'consecutive_too_close',
          customer_id: 'customer-1',
          customer_name: 'Test Customer',
          appointment_id: 'appt-1',
          recurring_parent_id: null,
          service_type: 'Pest Control',
          status: 'pending',
          pattern: 'monthly',
          reference_date: '2026-05-31',
          scheduled_date: '2026-06-01',
          diff_days: 1,
          skip_weekends: false,
          weekend_shift: 'forward',
        }],
      }),
    };

    const result = await auditRecurringScheduleAnomalies({ limit: 10 }, conn);

    expect(conn.raw).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('attention');
    expect(result.anomalyCount).toBe(1);
    expect(result.anomalies[0]).toMatchObject({
      checkType: 'consecutive',
      issue: 'consecutive_too_close',
      scheduledDate: '2026-06-01',
    });
  });
});
