const db = require('../models/db');
const adminScheduleRouter = require('../routes/admin-schedule');

describe('admin schedule assigned-tech ETA helpers', () => {
  const {
    buildAssignedScheduleEtaQuery,
    buildTechStatusQuery,
    formatAssignedVehicleLocation,
    recurringTemplateTechnicianId,
    shouldPreserveParentTemplateForThisOnlyAssignment,
  } = adminScheduleRouter._test;

  test('ETA lookup joins the assigned tech status and canonical customer geocode', () => {
    const { sql, bindings } = buildAssignedScheduleEtaQuery(db, 'svc-1').toSQL();

    expect(sql).toContain('left join "customers" as "c"');
    expect(sql).toContain('left join "tech_status" as "ts"');
    expect(sql).toContain('"s"."technician_id" = "ts"."tech_id"');
    expect(sql).toContain('"c"."latitude" as "customer_latitude"');
    expect(sql).toContain('"c"."longitude" as "customer_longitude"');
    expect(sql).toContain('"ts"."location_updated_at" as "tech_updated_at"');
    expect(sql).not.toContain('"ts"."updated_at" as "tech_updated_at"');
    expect(sql).not.toContain('"s"."lat" as "service_lat"');
    expect(sql).not.toContain('"s"."lng" as "service_lng"');
    expect(sql).not.toContain('"customers"."lat"');
    expect(sql).not.toContain('"customers"."lng"');
    expect(bindings).toEqual(['svc-1', 1]);
  });

  test('tech status lookup is scoped to one technician', () => {
    const { sql, bindings } = buildTechStatusQuery(db, 'tech-1').toSQL();

    expect(sql).toContain('from "tech_status"');
    expect(sql).toContain('"tech_id" = ?');
    expect(sql).toContain('"location_updated_at"');
    expect(sql).not.toContain('"updated_at"');
    expect(bindings).toEqual(['tech-1', 1]);
  });

  test('recurring template technician preserves explicit unassigned override', () => {
    expect(recurringTemplateTechnicianId({
      technician_id: 'old-tech',
      recurring_technician_id: 'new-tech',
      recurring_technician_override: true,
    })).toBe('new-tech');

    expect(recurringTemplateTechnicianId({
      technician_id: 'old-tech',
      recurring_technician_id: null,
      recurring_technician_override: true,
    })).toBeNull();

    expect(recurringTemplateTechnicianId({
      technician_id: 'old-tech',
      recurring_technician_id: null,
      recurring_technician_override: false,
    })).toBe('old-tech');
  });

  test('parent-only recurring reassignment snapshots the prior template', () => {
    expect(shouldPreserveParentTemplateForThisOnlyAssignment({
      is_recurring: true,
      recurring_parent_id: null,
      technician_id: 'old-tech',
      recurring_technician_override: false,
    }, 'new-tech')).toBe(true);

    expect(shouldPreserveParentTemplateForThisOnlyAssignment({
      is_recurring: true,
      recurring_parent_id: null,
      technician_id: 'old-tech',
      recurring_technician_override: true,
    }, 'new-tech')).toBe(false);

    expect(shouldPreserveParentTemplateForThisOnlyAssignment({
      is_recurring: true,
      recurring_parent_id: 'parent-id',
      technician_id: 'old-tech',
      recurring_technician_override: false,
    }, 'new-tech')).toBe(false);
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('vehicle formatter never fabricates a location without fresh assigned tech status', () => {
    expect(formatAssignedVehicleLocation(null)).toMatchObject({
      available: false,
      reason: 'not_found',
    });

    expect(formatAssignedVehicleLocation({ service_id: 'svc-1' })).toMatchObject({
      available: false,
      reason: 'no_assigned_tech',
    });

    expect(formatAssignedVehicleLocation({ technician_id: 'tech-1', tech_lat: null, tech_lng: null })).toMatchObject({
      available: false,
      reason: 'no_tech_status',
    });
    expect(formatAssignedVehicleLocation({ technician_id: 'tech-1', tech_lat: '', tech_lng: '-82.2' })).toMatchObject({
      available: false,
      reason: 'no_tech_status',
    });

    expect(formatAssignedVehicleLocation({
      technician_id: 'tech-1',
      tech_lat: '27.1',
      tech_lng: '-82.2',
      updated_at: '2026-05-05T11:59:00.000Z',
    })).toMatchObject({
      available: false,
      stale: true,
      reason: 'stale_tech_status',
    });

    expect(formatAssignedVehicleLocation({
      technician_id: 'tech-1',
      tech_lat: '27.1',
      tech_lng: '-82.2',
      tech_updated_at: '2026-05-05T11:54:59.000Z',
    })).toMatchObject({
      available: false,
      stale: true,
      reason: 'stale_tech_status',
    });
  });

  test('vehicle formatter returns fresh assigned tech_status coordinates', () => {
    expect(formatAssignedVehicleLocation({
      technician_id: 'tech-1',
      tech_lat: '27.1',
      tech_lng: '-82.2',
      updated_at: '2026-05-05T11:54:00.000Z',
      tech_updated_at: '2026-05-05T11:58:00.000Z',
    })).toEqual({
      found: true,
      available: true,
      source: 'tech_status',
      techId: 'tech-1',
      lat: 27.1,
      lng: -82.2,
      updatedAt: '2026-05-05T11:58:00.000Z',
    });
  });
});
