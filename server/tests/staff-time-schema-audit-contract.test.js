const { spawnSync } = require('child_process');
const path = require('path');

jest.mock('../models/db', () => ({
  destroy: jest.fn(),
  transaction: jest.fn(),
}));

const {
  ACTIVE_WRITE_GENERATION,
  MAX_STAFF_EMAIL_LENGTH,
  RESET_LINK_TTL_MINUTES,
  WEEKLY_OVERTIME_THRESHOLD_MINUTES,
  checks,
  expectedDailyOvertimeMinutes,
  runCheck,
  runDataCheck,
} = require('../scripts/audit-staff-rollout-readiness');

describe('Staff time schema rollout audit contract', () => {
  test('check SQL contains no raw Knex binding markers', () => {
    for (const check of checks) expect(check.sql).not.toContain('?');
  });

  test('keeps Railway database URL resolution diagnostics off stdout', () => {
    const serverDir = path.join(__dirname, '..');
    const result = spawnSync(
      process.execPath,
      ['-e', "require('./knexfile')"],
      {
        cwd: serverDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: '',
          DATABASE_PRIVATE_URL: 'postgresql://staff-audit.invalid/railway',
          DATABASE_PUBLIC_URL: '',
          POSTGRES_URL: '',
          POSTGRES_PRIVATE_URL: '',
          PGDATABASE: '',
          PGUSER: '',
          PGHOST: '',
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[knexfile] Resolved DATABASE_URL from Railway Postgres vars');
  });

  test('supported silent npm JSON command emits one parseable document on stdout', () => {
    const repositoryDir = path.join(__dirname, '../..');
    const preload = path.join(
      __dirname,
      'fixtures/staff-rollout-audit-db-preload.js',
    );
    const result = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', '--silent', 'audit:staff-rollout', '--', '--json'],
      {
        cwd: repositoryDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--require=${preload}`,
          ].filter(Boolean).join(' '),
        },
      },
    );

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      blockers: 0,
      incomplete: 0,
      target: {
        database_name: 'staff_audit_test',
        server_address: 'mock-db',
      },
    });
    expect(result.stdout).not.toMatch(/>\s+waves-customer-portal@|>\s+audit:staff-rollout/);
  });

  test.each([
    [0, 2400, 0],
    [2399.99, 0.01, 0],
    [2399.99, 0.02, 0.01],
    [2400, 60, 60],
    [2460, 30, 30],
  ])(
    'allocates later-day overtime after the 40-hour boundary (%s prior + %s day)',
    (priorMinutes, dayMinutes, expectedMinutes) => {
      expect(WEEKLY_OVERTIME_THRESHOLD_MINUTES).toBe(2400);
      expect(expectedDailyOvertimeMinutes(priorMinutes, dayMinutes)).toBe(expectedMinutes);
    },
  );

  test('checks schema, writer fencing, active timers, and legacy weekly rows', () => {
    const byKey = Object.fromEntries(checks.map((check) => [check.key, check]));

    expect(ACTIVE_WRITE_GENERATION).toBe(2);

    expect(byKey.staff_time_schema_columns.schema).toBe(true);
    expect(byKey.staff_time_schema_columns.sql).toMatch(/staff_write_generation/);
    expect(byKey.staff_time_schema_column_shapes.schema).toBe(true);
    expect(byKey.staff_time_schema_column_shapes.sql).toMatch(
      /duration_minutes[\s\S]*numeric[\s\S]*10::integer[\s\S]*2::integer/,
    );
    expect(byKey.staff_time_schema_column_shapes.sql).toMatch(
      /approval_status[\s\S]*pending/,
    );
    expect(byKey.staff_time_schema_column_shapes.sql).toMatch(
      /character_maximum_length[\s\S]*numeric_precision[\s\S]*numeric_scale[\s\S]*column_default/,
    );
    expect(byKey.staff_time_schema_indexes.sql).toMatch(/indisvalid/);
    expect(byKey.staff_time_schema_value_constraints.sql).toMatch(
      /time_entries_staff_active_write_generation_check/,
    );
    expect(byKey.staff_time_schema_value_constraints.sql).toMatch(
      /pg_get_constraintdef\(c\.oid, true\)/,
    );
    expect(byKey.staff_time_schema_value_constraints.sql).toMatch(
      new RegExp(`staff_write_generationisnotdistinctfrom${ACTIVE_WRITE_GENERATION}`),
    );
    expect(byKey.staff_time_schema_value_constraints.sql).toMatch(
      /entry_type=anyarray\[/,
    );
    expect(byKey.staff_time_schema_value_constraints.sql).not.toMatch(
      /entry_type=any\(array/,
    );
    expect(byKey.active_staff_timers.sql).toMatch(/WHERE status = 'active'/);
    expect(byKey.active_staff_timers.sql).not.toMatch(/entry_type IN/);
    expect(byKey.approved_week_total_mismatch.sql).toMatch(/to_jsonb\(summary\)/);
    expect(byKey.approved_week_total_mismatch.sql).not.toMatch(/w\.total_job_minutes/);
    expect(byKey.duplicate_daily_summaries.sql).toMatch(/HAVING COUNT\(\*\) > 1/);
    expect(byKey.unresolvable_timesheet_review_states.sql).toMatch(
      /d\.status NOT IN \('pending', 'approved', 'disputed'\)/,
    );
    expect(byKey.unresolvable_timesheet_review_states.sql).toMatch(
      /w\.status NOT IN \('pending', 'approved'\)/,
    );
    expect(byKey.unresolvable_timesheet_review_states.sql).toMatch(
      /to_jsonb\(entry\)[\s\S]*approval_status[\s\S]*= 'disputed'/,
    );
    expect(byKey.approved_incomplete_staff_weeks.sql).toMatch(
      /w\.status = 'approved'[\s\S]*CURRENT_TIMESTAMP AT TIME ZONE 'America\/New_York'/,
    );
    expect(byKey.daily_summary_total_mismatch.sql).toMatch(
      /AT TIME ZONE 'America\/New_York'/,
    );
    expect(byKey.daily_summary_total_mismatch.sql).toMatch(
      /shift_minutes[\s\S]*job_minutes[\s\S]*drive_minutes[\s\S]*break_minutes[\s\S]*admin_minutes/,
    );
    expect(byKey.daily_summary_total_mismatch.sql).toMatch(
      /job_count[\s\S]*first_clock_in[\s\S]*last_clock_out/,
    );
    expect(byKey.daily_summary_total_mismatch.sql).toMatch(
      /status IN \('completed', 'edited'\)[\s\S]*LEFT JOIN[\s\S]*utilization_pct/,
    );
    expect(byKey.daily_summary_total_mismatch.sql).toMatch(
      /SUM\(services\.estimated_price\)/,
    );
    expect(byKey.daily_summary_total_mismatch.sql).not.toMatch(/services\.price/);
    expect(byKey.daily_summary_total_mismatch.sql).toMatch(
      /DATE_TRUNC\('week', summary\.work_date::timestamp\)::date/,
    );
    expect(byKey.daily_summary_total_mismatch.sql).toMatch(
      /ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING/,
    );
    expect(byKey.daily_summary_total_mismatch.sql).toMatch(
      /LEAST\([\s\S]*total_shift_minutes[\s\S]*prior_week_shift_minutes[\s\S]*- 2400/,
    );
    expect(byKey.daily_summary_total_mismatch.sql).toMatch(
      /d\.overtime_minutes[\s\S]*IS DISTINCT FROM d\.expected_overtime_minutes/,
    );
    expect(byKey.weekly_overtime_payroll_mismatch.sql).toMatch(
      /GROUP BY technician_id, week_start/,
    );
    expect(byKey.weekly_overtime_payroll_mismatch.sql).toMatch(
      /weekly_overtime_minutes[\s\S]*stored_daily_overtime_minutes[\s\S]*expected_overtime_minutes/,
    );
    expect(byKey.weekly_overtime_payroll_mismatch.sql).toMatch(
      /w\.overtime_minutes[\s\S]*IS DISTINCT FROM COALESCE\(a\.expected_overtime_minutes/,
    );
    expect(byKey.weekly_overtime_payroll_mismatch.sql).toMatch(
      /w\.total_shift_minutes[\s\S]*IS DISTINCT FROM a\.expected_shift_minutes/,
    );
    expect(byKey.approved_week_total_mismatch.sql).toMatch(
      /w\.total_shift_minutes[\s\S]*IS DISTINCT FROM COALESCE\(e\.shift_minutes/,
    );
    expect(byKey.weekly_overtime_payroll_mismatch.sql).not.toMatch(/> 0\.02/);
    expect(byKey.approved_week_total_mismatch.sql).not.toMatch(/> 0\.02/);
    expect(byKey.approved_week_nonapproved_daily_summaries.sql).toMatch(
      /w\.status = 'approved'[\s\S]*d\.status IS DISTINCT FROM 'approved'/,
    );
    expect(byKey.staff_auth_schema_columns.schema).toBe(true);
    expect(byKey.staff_auth_schema_columns.sql).toMatch(/auth_token_version/);
    expect(byKey.staff_auth_schema_columns.sql).toMatch(/staff_token_version/);
    expect(byKey.staff_auth_schema_column_shapes.sql).toMatch(
      /password_reset_token_hash[\s\S]*character varying[\s\S]*64/,
    );
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(
      /technicians_staff_email_canonical_uidx/,
    );
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(/indisvalid/);
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(/indisready/);
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(/access_method/);
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(
      /ARRAY\['password_reset_token_hash'\]::text\[\]/,
    );
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(
      /ARRAY\['admin_user_id', 'staff_token_version'\]::text\[\]/,
    );
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(
      /existing\.key_columns IS DISTINCT FROM required\.key_columns/,
    );
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(/existing\.index_expression IS NOT NULL/);
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(
      /email is not null[\s\S]*POSITION\('btrim'/,
    );
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(/PG_GET_INDEXDEF/);
    expect(byKey.staff_auth_schema_indexes.sql).toMatch(/index_predicate/);
    expect(byKey.invalid_staff_auth_versions.sql).toMatch(/auth_token_version < 1/);
    expect(byKey.inconsistent_staff_password_reset_state.sql).toMatch(
      /\^\[a-f0-9\]\{64\}\$/,
    );
    expect(byKey.inconsistent_staff_password_reset_state.sql).toContain(
      `INTERVAL '${RESET_LINK_TTL_MINUTES} minutes'`,
    );
    expect(byKey.stale_staff_push_session_versions.sql).toMatch(
      /p\.staff_token_version IS DISTINCT FROM t\.auth_token_version/,
    );
    expect(byKey.missing_active_admin.sql).toMatch(
      /NOT EXISTS[\s\S]*role = 'admin'[\s\S]*active = true/,
    );
    expect(byKey.invalid_active_staff_identity.sql).toContain(
      `LENGTH(BTRIM(email)) > ${MAX_STAFF_EMAIL_LENGTH}`,
    );
    expect(byKey.invalid_active_staff_identity.sql).toMatch(/noncanonical_email/);
  });

  test('counts findings in PostgreSQL and strips the internal count field', async () => {
    const trx = {
      raw: jest.fn(async () => ({
        rows: [{ invariant: 'missing', __total_count: 32 }],
      })),
    };

    const result = await runCheck(trx, {
      key: 'example',
      description: 'Example',
      sql: 'SELECT 1 AS invariant',
    });

    expect(result.count).toBe(32);
    expect(result.rows).toEqual([{ invariant: 'missing' }]);
    expect(trx.raw).toHaveBeenCalledWith(expect.stringMatching(/LIMIT \?/), [25]);
  });

  test.each(['42P01', '42703'])(
    'reports unavailable data checks after PostgreSQL schema error %s',
    async (code) => {
      const schemaError = Object.assign(new Error('legacy schema'), { code });
      const trx = {
        transaction: jest.fn(async (callback) => callback({
          raw: jest.fn(async () => { throw schemaError; }),
        })),
      };

      await expect(runDataCheck(trx, {
        key: 'example',
        description: 'Example data invariant',
        sql: 'SELECT missing_column FROM missing_table',
      })).resolves.toEqual({
        key: 'example',
        description: 'Example data invariant (not evaluated because required schema is missing)',
        blocking: true,
        count: 1,
        rows: [],
        incomplete: true,
        errorCode: code,
      });
    },
  );

  test('does not hide non-schema audit failures', async () => {
    const queryError = Object.assign(new Error('connection lost'), { code: '08006' });
    const trx = {
      transaction: jest.fn(async () => { throw queryError; }),
    };

    await expect(runDataCheck(trx, {
      key: 'example',
      description: 'Example data invariant',
      sql: 'SELECT 1',
    })).rejects.toBe(queryError);
  });

  test('continues with the next data check after a schema-dependent check fails', async () => {
    const schemaError = Object.assign(new Error('missing relation'), { code: '42P01' });
    let savepointNumber = 0;
    const trx = {
      transaction: jest.fn(async (callback) => {
        savepointNumber += 1;
        return callback({
          raw: jest.fn(async () => {
            if (savepointNumber === 1) throw schemaError;
            return { rows: [] };
          }),
        });
      }),
    };

    const first = await runDataCheck(trx, {
      key: 'missing_dependency',
      description: 'Missing dependency',
      sql: 'SELECT * FROM absent_table',
    });
    const second = await runDataCheck(trx, {
      key: 'compatible_check',
      description: 'Compatible check',
      sql: 'SELECT 1 WHERE false',
    });

    expect(first.incomplete).toBe(true);
    expect(second).toMatchObject({ key: 'compatible_check', count: 0 });
    expect(trx.transaction).toHaveBeenCalledTimes(2);
  });
});
