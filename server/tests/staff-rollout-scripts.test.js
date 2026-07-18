const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => ({
  destroy: jest.fn(),
  transaction: jest.fn(),
}));

const {
  checks,
  runCheck,
} = require('../scripts/audit-staff-rollout-readiness');
const {
  candidateFingerprint,
  preflight,
  targetFingerprint,
} = require('../scripts/rotate-legacy-staff-passwords');

describe('staff rollout operational safeguards', () => {
  test('audit counts in SQL, returns only its bounded sample, and strips internal count fields', async () => {
    const trx = {
      raw: jest.fn(async (_sql, bindings) => ({
        rows: [
          { technician_id: 'tech-1', __total_count: 40 },
          { technician_id: 'tech-2', __total_count: 40 },
        ],
        bindings,
      })),
    };

    const result = await runCheck(trx, {
      key: 'example',
      description: 'Example check',
      sql: 'SELECT technician_id FROM technicians',
    });

    expect(trx.raw.mock.calls[0][0]).toMatch(/COUNT\(\*\) OVER\(\)/);
    expect(trx.raw.mock.calls[0][1]).toEqual([25]);
    expect(result.count).toBe(40);
    expect(result.rows).toEqual([
      { technician_id: 'tech-1' },
      { technician_id: 'tech-2' },
    ]);
  });

  test('audit includes recovery, approved-entry, and overtime blockers', () => {
    const byKey = Object.fromEntries(checks.map((check) => [check.key, check.sql]));
    expect(byKey.staff_time_schema_columns).toMatch(/information_schema\.columns/);
    expect(byKey.staff_auth_schema_indexes).toMatch(/indisready/);
    expect(byKey.staff_auth_schema_indexes).toMatch(
      /ARRAY\['admin_user_id', 'staff_token_version'\]::text\[\]/,
    );
    expect(byKey.staff_time_schema_indexes).toMatch(/indisvalid/);
    expect(byKey.staff_time_schema_value_constraints).toMatch(/c\.convalidated/);
    expect(byKey.active_staff_timers).toMatch(/status = 'active'/);
    expect(byKey.invalid_active_staff_identity).toMatch(/invalid_email_format/);
    expect(byKey.approved_week_pending_entries).toMatch(/completed.*edited/s);
    expect(byKey.approved_week_total_mismatch).toMatch(/overtime_minutes/);
    expect(byKey.approved_week_total_mismatch).toMatch(/to_jsonb\(summary\)/);
    expect(byKey.approved_week_total_mismatch).not.toMatch(/w\.total_job_minutes/);
    expect(byKey.overlapping_same_type_entries).toMatch(/MAX\(clock_out\) OVER/);
    expect(byKey.missing_daily_summaries).toMatch(/completed.*edited/s);
    expect(byKey.missing_daily_summaries).not.toMatch(/status <> 'voided'/);
    expect(byKey.duplicate_daily_summaries).toMatch(/HAVING COUNT\(\*\) > 1/);
  });

  test('admin time tracking never performs runtime schema DDL', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../routes/admin-timetracking.js'),
      'utf8',
    );
    expect(source).not.toMatch(/ensureTables/);
    expect(source).not.toMatch(/schema\.createTable\(['"]time_/);
  });

  test('candidate fingerprints are order-independent and change with the candidate set', () => {
    const first = candidateFingerprint([{ id: 'b' }, { id: 'a' }]);
    expect(first).toBe(candidateFingerprint([{ id: 'a' }, { id: 'b' }]));
    expect(first).not.toBe(candidateFingerprint([{ id: 'a' }]));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rotation target fingerprint binds the database and Railway environment', () => {
    const target = {
      database_name: 'railway',
      database_user: 'postgres',
      server_address: '10.0.0.8',
      server_port: 5432,
    };
    const production = targetFingerprint(target, {
      NODE_ENV: 'production',
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_ENVIRONMENT_ID: 'production-1',
      RAILWAY_SERVICE_ID: 'service-1',
    });
    expect(production).toMatch(/^[a-f0-9]{64}$/);
    expect(production).not.toBe(targetFingerprint(target, {
      NODE_ENV: 'production',
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_ENVIRONMENT_ID: 'staging-1',
      RAILWAY_SERVICE_ID: 'service-1',
    }));
    expect(production).not.toBe(targetFingerprint({
      ...target,
      server_address: '10.0.0.9',
    }, {
      NODE_ENV: 'production',
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_ENVIRONMENT_ID: 'production-1',
      RAILWAY_SERVICE_ID: 'service-1',
    }));
  });

  test.each([null, undefined, '', 0, -1, 1.5, 2147483647])(
    'rotation preflight rejects invalid auth token version %p',
    (authTokenVersion) => {
      const row = {
        id: 'tech-1',
        email: 'tech@example.com',
        auth_token_version: authTokenVersion,
      };
      expect(preflight([row], [row])).toContainEqual({
        technicianId: 'tech-1',
        reason: 'invalid_auth_token_version',
      });
    },
  );

  test('requires a recoverable email only for active legacy-credential candidates', () => {
    const inactive = {
      id: 'tech-inactive',
      active: false,
      email: null,
      auth_token_version: 2,
    };
    const active = {
      id: 'tech-active',
      active: true,
      email: null,
      auth_token_version: 2,
    };

    expect(preflight([inactive], [inactive])).toEqual([]);
    expect(preflight([active], [active])).toContainEqual({
      technicianId: 'tech-active',
      reason: 'missing_or_invalid_email',
    });
  });
});
