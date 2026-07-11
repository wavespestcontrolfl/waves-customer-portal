jest.mock('../models/db', () => ({
  destroy: jest.fn(),
  transaction: jest.fn(),
}));

const {
  checks,
  runCheck,
  runDataCheck,
} = require('../scripts/audit-staff-rollout-readiness');

describe('Staff time schema rollout audit contract', () => {
  test('checks schema, writer fencing, active timers, and legacy weekly rows', () => {
    const byKey = Object.fromEntries(checks.map((check) => [check.key, check]));

    expect(byKey.staff_time_schema_columns.schema).toBe(true);
    expect(byKey.staff_time_schema_columns.sql).toMatch(/staff_write_generation/);
    expect(byKey.staff_time_schema_indexes.sql).toMatch(/indisvalid/);
    expect(byKey.staff_time_schema_value_constraints.sql).toMatch(
      /time_entries_staff_active_write_generation_check/,
    );
    expect(byKey.active_staff_timers.sql).toMatch(/WHERE status = 'active'/);
    expect(byKey.active_staff_timers.sql).not.toMatch(/entry_type IN/);
    expect(byKey.approved_week_total_mismatch.sql).toMatch(/to_jsonb\(summary\)/);
    expect(byKey.approved_week_total_mismatch.sql).not.toMatch(/w\.total_job_minutes/);
    expect(byKey.duplicate_daily_summaries.sql).toMatch(/HAVING COUNT\(\*\) > 1/);
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
